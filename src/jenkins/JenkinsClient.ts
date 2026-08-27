import type { JenkinsInstanceConfig } from '../config/schema';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import { NotFound, ReadOnly, Unsupported } from './errors';
import type { JenkinsAuthenticator } from './JenkinsAuthenticator';
import type { JenkinsHttpClient } from './JenkinsHttpClient';
import { truncateBuildLog } from './logTruncate';
import type {
  BuildDetail,
  BuildSummary,
  JobDetail,
  JobParameterDefinition,
  JobSummary,
  ListBuildsOptions,
  LogTruncateOptions,
  LogTruncateResult,
  PipelineScript,
  QueueItem,
  TriggerBuildResult
} from './types';
import { BUILD_SUMMARY_TREE_FIELDS, DEFAULT_LOG_TAIL_BYTES, GET_JOB_TREE, LIST_JOBS_TREE } from './types';

/** Past any 32-bit log; Jenkins returns an empty body and `X-Text-Size` = current length. */
export const PROGRESSIVE_TEXT_SIZE_PROBE = 2_147_483_647;

export interface JenkinsClientOptions {
  httpClient: JenkinsHttpClient;
  authenticator: JenkinsAuthenticator;
  instanceConfig?: JenkinsInstanceConfig;
  log?: AtJenkinsLog;
}

interface RawHealthReport {
  score?: number;
  description?: string;
}

interface RawJobItem {
  _class?: string;
  name: string;
  url: string;
  color?: string;
  buildable?: boolean;
  inQueue?: boolean;
  jobs?: RawJobItem[];
  healthReport?: RawHealthReport[];
  lastBuild?: BuildSummary;
}

interface RawParameterDefinition {
  _class?: string;
  name: string;
  type?: string;
  description?: string;
  defaultParameterValue?: { value?: string | number | boolean };
  choices?: string[];
}

interface RawJobProperty {
  _class?: string;
  parameterDefinitions?: RawParameterDefinition[];
}

interface RawJobDetail {
  _class?: string;
  name: string;
  url: string;
  description?: string;
  color?: string;
  buildable?: boolean;
  inQueue?: boolean;
  nextBuildNumber?: number;
  property?: RawJobProperty[];
  actions?: Array<{ parameterDefinitions?: RawParameterDefinition[] }>;
  lastBuild?: BuildSummary;
  lastSuccessfulBuild?: BuildSummary;
  lastFailedBuild?: BuildSummary;
  lastCompletedBuild?: BuildSummary;
}

/**
 * Builds the canonical Jenkins URL path for a hierarchical job name.
 * e.g. 'folder1/job2' -> '/job/folder1/job/job2'
 */
export function buildJobPath(fullName: string): string {
  if (!fullName) {
    return '';
  }
  const segments = fullName
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length === 0) {
    return '';
  }

  return segments.map((seg) => `/job/${encodeURIComponent(seg)}`).join('');
}

/**
 * Maps a Jenkins queue item URL (`…/queue/item/123/` or a relative path)
 * to the JSON API path used to poll whether the item has left the queue.
 */
export function parseQueueItemPath(queueUrl: string): string | undefined {
  const trimmed = queueUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/\/queue\/item\/(\d+)\/?/);
  if (!match?.[1]) {
    return undefined;
  }
  return `/queue/item/${match[1]}/api/json`;
}

export class JenkinsClient {
  private readonly httpClient: JenkinsHttpClient;
  private readonly authenticator: JenkinsAuthenticator;
  private readonly instanceConfig?: JenkinsInstanceConfig;
  private readonly log: AtJenkinsLog;

  constructor(options: JenkinsClientOptions) {
    this.httpClient = options.httpClient;
    this.authenticator = options.authenticator;
    this.instanceConfig = options.instanceConfig;
    this.log = asRedactedLog(options.log ?? noopLog);
  }

  get config(): JenkinsInstanceConfig | undefined {
    return this.instanceConfig;
  }

  /**
   * Tests the connection to the Jenkins controller.
   */
  async testConnection(): Promise<{ nodeName?: string; mode?: string; [key: string]: unknown }> {
    return this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.requestJson<{ nodeName?: string; mode?: string }>({
        method: 'GET',
        path: '/api/json',
        query: { tree: 'nodeName,mode' },
        headers
      });
    }, 'GET');
  }

  /**
   * Lists jobs at the root or within a specific folder/multibranch job.
   */
  async listJobs(folderFullName?: string): Promise<JobSummary[]> {
    const basePath = folderFullName ? buildJobPath(folderFullName) : '';
    const path = `${basePath}/api/json`;

    const res = await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.requestJson<{ jobs?: RawJobItem[] }>({
        method: 'GET',
        path,
        query: { tree: LIST_JOBS_TREE },
        headers
      });
    }, 'GET');

    const rawJobs = res?.jobs ?? [];
    return rawJobs.map((item) => {
      const isFolder =
        Array.isArray(item.jobs) ||
        Boolean(item._class?.includes('Folder')) ||
        Boolean(item._class?.includes('WorkflowMultiBranchProject')) ||
        Boolean(item._class?.includes('OrganizationFolder'));

      const isMultibranch =
        Boolean(item._class?.includes('WorkflowMultiBranchProject')) ||
        Boolean(item._class?.includes('OrganizationFolder'));

      const isBuildable =
        item.buildable ?? (!isFolder && item.color !== undefined && item.color !== 'disabled');

      const fullName = folderFullName ? `${folderFullName}/${item.name}` : item.name;
      const health = item.healthReport?.[0];
      const lastBuild = normalizeBuildSummary(item.lastBuild);

      const summary: JobSummary = {
        name: item.name,
        fullName,
        url: item.url,
        color: item.color,
        _class: item._class,
        isFolder,
        isBuildable,
        isMultibranch
      };
      if (item.inQueue !== undefined) {
        summary.inQueue = item.inQueue;
      }
      if (typeof health?.score === 'number') {
        summary.healthScore = health.score;
        if (health.description) {
          summary.healthDescription = health.description;
        }
      }
      if (lastBuild) {
        summary.lastBuild = lastBuild;
      }
      return summary;
    });
  }

  /**
   * Retrieves detailed metadata and parameter definitions for a job.
   */
  async getJob(fullName: string): Promise<JobDetail> {
    const jobPath = buildJobPath(fullName);
    const path = `${jobPath}/api/json`;

    const raw = await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.requestJson<RawJobDetail>({
        method: 'GET',
        path,
        query: { tree: GET_JOB_TREE },
        headers
      });
    }, 'GET');

    const parameterDefinitions: JobParameterDefinition[] = [];

    const properties = raw.property ?? [];
    for (const prop of properties) {
      if (Array.isArray(prop.parameterDefinitions)) {
        for (const p of prop.parameterDefinitions) {
          parameterDefinitions.push({
            name: p.name,
            type: p.type || p._class || 'StringParameterDefinition',
            description: p.description,
            defaultValue: p.defaultParameterValue?.value,
            choices: p.choices
          });
        }
      }
    }

    if (parameterDefinitions.length === 0 && Array.isArray(raw.actions)) {
      for (const act of raw.actions) {
        if (Array.isArray(act.parameterDefinitions)) {
          for (const p of act.parameterDefinitions) {
            parameterDefinitions.push({
              name: p.name,
              type: p.type || p._class || 'StringParameterDefinition',
              description: p.description,
              defaultValue: p.defaultParameterValue?.value,
              choices: p.choices
            });
          }
        }
      }
    }

    return {
      name: raw.name,
      fullName,
      url: raw.url,
      description: raw.description,
      color: raw.color,
      _class: raw._class,
      buildable: raw.buildable,
      inQueue: raw.inQueue,
      nextBuildNumber: raw.nextBuildNumber,
      parameters: parameterDefinitions.length > 0 ? parameterDefinitions : undefined,
      lastBuild: normalizeBuildSummary(raw.lastBuild),
      lastSuccessfulBuild: normalizeBuildSummary(raw.lastSuccessfulBuild),
      lastFailedBuild: normalizeBuildSummary(raw.lastFailedBuild),
      lastCompletedBuild: normalizeBuildSummary(raw.lastCompletedBuild)
    };
  }

  /**
   * Retrieves the stored pipeline script for a controller-stored Pipeline job.
   * Throws Unsupported if the job is SCM-backed or Freestyle.
   */
  async getPipelineScript(fullName: string): Promise<PipelineScript> {
    const jobPath = buildJobPath(fullName);
    const path = `${jobPath}/config.xml`;

    const res = await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.request({
        method: 'GET',
        path,
        headers: { accept: 'application/xml, text/xml, */*', ...headers }
      });
    }, 'GET');

    const xml = res.text;

    // Check SCM before CpsFlowDefinition — "CpsScmFlowDefinition" contains the
    // substring "CpsFlowDefinition" and must not be treated as controller-stored.
    if (xml.includes('CpsScmFlowDefinition')) {
      throw new Unsupported(
        `Job '${fullName}' uses SCM-stored pipeline script (CpsScmFlowDefinition). Only controller-stored Pipeline jobs support pipeline script viewing and editing.`,
        { jobType: 'CpsScmFlowDefinition', operation: 'getPipelineScript' }
      );
    }

    if (!isCpsFlowDefinitionXml(xml)) {
      if (xml.includes('<project>') || xml.includes('<matrix-project>') || xml.includes('<maven2-moduleset>')) {
        throw new Unsupported(
          `Job '${fullName}' is a Freestyle or non-Pipeline project. Only controller-stored Pipeline jobs support pipeline script viewing and editing.`,
          { jobType: 'FreeStyleProject', operation: 'getPipelineScript' }
        );
      }
      throw new Unsupported(
        `Job '${fullName}' does not contain a controller-stored pipeline definition.`,
        { operation: 'getPipelineScript' }
      );
    }

    const script = extractScriptFromXml(xml);
    const sandbox = extractSandboxFromXml(xml);

    return {
      script,
      sandbox,
      scriptSource: 'stored'
    };
  }

  /**
   * Updates the pipeline script for a controller-stored Pipeline job.
   * Throws ReadOnly if the instance is read-only, or Unsupported if not CpsFlowDefinition.
   */
  async updatePipelineScript(fullName: string, script: string): Promise<void> {
    if (this.instanceConfig?.readOnly) {
      throw new ReadOnly(
        `Cannot update pipeline script on read-only instance '${this.instanceConfig.id}'.`,
        { instanceId: this.instanceConfig.id, action: 'updatePipelineScript' }
      );
    }

    const jobPath = buildJobPath(fullName);
    const path = `${jobPath}/config.xml`;

    const res = await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.request({
        method: 'GET',
        path,
        headers: { accept: 'application/xml, text/xml, */*', ...headers }
      });
    }, 'GET');

    const xml = res.text;

    if (xml.includes('CpsScmFlowDefinition') || !isCpsFlowDefinitionXml(xml)) {
      throw new Unsupported(
        `Job '${fullName}' is not a controller-stored Pipeline job.`,
        { operation: 'updatePipelineScript' }
      );
    }

    const updatedXml = replaceScriptInXml(xml, script);

    await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.request({
        method: 'POST',
        path,
        headers: {
          // charset matters: without it some Jenkins/Stapler stacks mis-decode UTF-8
          // pipeline text and fail XStream parse with HTTP 500 HTML.
          'content-type': 'text/xml; charset=UTF-8',
          ...headers
        },
        body: updatedXml
      });
    }, 'POST');
  }

  /**
   * Lists recent builds for a job, optionally with pagination limits.
   */
  async listBuilds(fullName: string, opts?: ListBuildsOptions): Promise<BuildSummary[]> {
    const jobPath = buildJobPath(fullName);
    const path = `${jobPath}/api/json`;

    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = opts?.limit;
    const end = limit !== undefined ? offset + Math.max(0, limit) : undefined;
    const range = end !== undefined ? `{0,${end}}` : '';

    const collection = end !== undefined && end > 100 ? 'allBuilds' : 'builds';

    const res = await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.requestJson<{ builds?: BuildSummary[]; allBuilds?: BuildSummary[] }>({
        method: 'GET',
        path,
        query: {
          tree: `${collection}[${BUILD_SUMMARY_TREE_FIELDS}]${range}`
        },
        headers
      });
    }, 'GET');

    const builds = (res?.[collection] ?? []).map((build) => normalizeBuildSummary(build)).filter(
      (build): build is BuildSummary => Boolean(build)
    );
    if (end !== undefined) {
      return builds.slice(offset, end);
    }
    return builds;
  }

  /**
   * Polls a queue item until Jenkins assigns an executable build number
   * (or the item is cancelled / evaporates).
   */
  async getQueueItem(queueUrl: string): Promise<QueueItem> {
    const path = parseQueueItemPath(queueUrl);
    if (!path) {
      throw new NotFound(`Jenkins queue item URL is invalid: ${queueUrl}`, queueUrl, 404);
    }

    return this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.requestJson<QueueItem>({
        method: 'GET',
        path,
        query: { tree: 'cancelled,why,executable[number,url]' },
        headers
      });
    }, 'GET');
  }

  /**
   * Retrieves build detail status by build number.
   */
  async getBuild(fullName: string, buildNumber: number): Promise<BuildDetail> {
    const jobPath = buildJobPath(fullName);
    const path = `${jobPath}/${buildNumber}/api/json`;

    return this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.requestJson<BuildDetail>({
        method: 'GET',
        path,
        headers
      });
    }, 'GET');
  }

  /**
   * Retrieves and optionally truncates the console text log for a build.
   * Prefers Jenkins' incremental `logText/progressiveText` so follow/tail
   * paths do not re-download the entire console on every poll, and falls
   * back to `/consoleText` when that endpoint is missing.
   */
  async getBuildLog(
    fullName: string,
    buildNumber: number,
    opts?: LogTruncateOptions
  ): Promise<LogTruncateResult> {
    try {
      return await this.getBuildLogProgressive(fullName, buildNumber, opts);
    } catch (error) {
      if (error instanceof NotFound) {
        this.log.debug(
          `progressiveText unavailable for ${fullName} #${buildNumber}; falling back to consoleText`
        );
        return this.getBuildLogConsoleText(fullName, buildNumber, opts);
      }
      throw error;
    }
  }

  private async getBuildLogProgressive(
    fullName: string,
    buildNumber: number,
    opts?: LogTruncateOptions
  ): Promise<LogTruncateResult> {
    if (opts?.start !== undefined) {
      const chunk = await this.fetchProgressiveText(fullName, buildNumber, opts.start);
      const sliced = truncateBuildLog(chunk.body, {
        start: 0,
        maxBytes: opts.maxBytes,
        tailBytes: opts.maxBytes === undefined ? opts.tailBytes : undefined
      });
      const startByte = opts.start;
      const endByte = startByte + sliced.endByte;
      const totalBytes = Math.max(chunk.nextStart, endByte);
      return {
        text: sliced.text,
        startByte,
        endByte,
        totalBytes,
        truncated: sliced.truncated || startByte > 0 || endByte < totalBytes,
        hasMore: Boolean(sliced.hasMore) || endByte < totalBytes
      };
    }

    const tailBytes = opts?.tailBytes ?? DEFAULT_LOG_TAIL_BYTES;
    const probe = await this.fetchProgressiveText(fullName, buildNumber, PROGRESSIVE_TEXT_SIZE_PROBE);
    const totalBytes = probe.nextStart;
    if (tailBytes <= 0) {
      return {
        text: '',
        startByte: totalBytes,
        endByte: totalBytes,
        totalBytes,
        truncated: totalBytes > 0,
        hasMore: false
      };
    }
    if (totalBytes <= tailBytes) {
      const chunk =
        totalBytes === 0
          ? probe
          : await this.fetchProgressiveText(fullName, buildNumber, 0);
      return {
        text: chunk.body.toString('utf8'),
        startByte: 0,
        endByte: totalBytes,
        totalBytes,
        truncated: false,
        hasMore: false
      };
    }

    const from = totalBytes - tailBytes;
    const chunk = await this.fetchProgressiveText(fullName, buildNumber, from);
    return {
      text: chunk.body.toString('utf8'),
      startByte: from,
      endByte: Math.max(chunk.nextStart, from),
      totalBytes,
      truncated: true,
      hasMore: false
    };
  }

  private async getBuildLogConsoleText(
    fullName: string,
    buildNumber: number,
    opts?: LogTruncateOptions
  ): Promise<LogTruncateResult> {
    const jobPath = buildJobPath(fullName);
    const path = `${jobPath}/${buildNumber}/consoleText`;

    // Use request() (not requestRaw) so 401/404 map to AuthError/NotFound and
    // password+crumb auth retry can observe AuthError.
    const res = await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.request({
        method: 'GET',
        path,
        headers
      });
    }, 'GET');

    return truncateBuildLog(res.body, opts);
  }

  private async fetchProgressiveText(
    fullName: string,
    buildNumber: number,
    start: number
  ): Promise<{ body: Buffer; nextStart: number }> {
    const jobPath = buildJobPath(fullName);
    const path = `${jobPath}/${buildNumber}/logText/progressiveText`;
    const res = await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.request({
        method: 'GET',
        path,
        query: { start },
        headers
      });
    }, 'GET');

    const sizeHeader = res.headers['x-text-size'];
    const parsed = sizeHeader !== undefined ? Number.parseInt(sizeHeader, 10) : Number.NaN;
    const nextStart = Number.isFinite(parsed) && parsed >= 0 ? parsed : start + res.body.length;
    return { body: res.body, nextStart };
  }

  /**
   * Triggers a new build for the given job.
   * If parameters are provided, calls /buildWithParameters; otherwise calls /build.
   */
  async triggerBuild(
    fullName: string,
    params?: Record<string, string | number | boolean>
  ): Promise<TriggerBuildResult> {
    if (this.instanceConfig?.readOnly) {
      throw new ReadOnly(
        `Cannot trigger build on read-only instance '${this.instanceConfig.id}'.`,
        { instanceId: this.instanceConfig.id, action: 'triggerBuild' }
      );
    }

    const jobPath = buildJobPath(fullName);
    const hasParams = params && Object.keys(params).length > 0;

    const path = hasParams ? `${jobPath}/buildWithParameters` : `${jobPath}/build`;

    const form: Record<string, string> | undefined = hasParams
      ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
      : undefined;

    const res = await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.request({
        method: 'POST',
        path,
        form,
        headers
      });
    }, 'POST');

    return {
      queueUrl: res.headers['location']
    };
  }

  /**
   * Requests stopping / aborting a running build.
   */
  async stopBuild(fullName: string, buildNumber: number): Promise<void> {
    if (this.instanceConfig?.readOnly) {
      throw new ReadOnly(
        `Cannot stop build on read-only instance '${this.instanceConfig.id}'.`,
        { instanceId: this.instanceConfig.id, action: 'stopBuild' }
      );
    }

    const jobPath = buildJobPath(fullName);
    const path = `${jobPath}/${buildNumber}/stop`;

    await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.request({
        method: 'POST',
        path,
        headers
      });
    }, 'POST');
  }
}

function normalizeBuildSummary(raw?: Partial<BuildSummary> | null): BuildSummary | undefined {
  if (!raw || typeof raw.number !== 'number') {
    return undefined;
  }
  return {
    number: raw.number,
    url: raw.url ?? '',
    result: raw.result,
    building: Boolean(raw.building),
    timestamp: raw.timestamp ?? 0,
    duration: raw.duration ?? 0,
    estimatedDuration: raw.estimatedDuration,
    displayName: raw.displayName,
    fullDisplayName: raw.fullDisplayName
  };
}

function isCpsFlowDefinitionXml(xml: string): boolean {
  // Prefer FQCN. Do not match bare "CpsFlowDefinition" alone — that substring
  // also appears inside CpsScmFlowDefinition (handled before this check).
  return xml.includes('org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition');
}

function extractScriptFromXml(xml: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(xml);
  if (!match || match[1] === undefined) {
    return '';
  }
  const content = match[1];
  const cdataMatch = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(content);
  if (cdataMatch && cdataMatch[1] !== undefined) {
    return cdataMatch[1];
  }
  return unescapeXml(content);
}

function extractSandboxFromXml(xml: string): boolean {
  const match = /<sandbox>\s*(true|false)\s*<\/sandbox>/i.exec(xml);
  return match?.[1]?.toLowerCase() === 'true';
}

function replaceScriptInXml(xml: string, newScript: string): string {
  // Prefer CDATA so Groovy `$1` / `${env…}` / `$class` / raw `<` stay intact without
  // entity-escaping pitfalls. Use a replacer function so String.replace does not
  // treat `$&` / `$1` in the script as substitution patterns (that corruption
  // yields invalid XML and Jenkins HTTP 500).
  const cdataSafe = newScript.replaceAll(']]>', ']]]]><![CDATA[>');
  const replacement = `<script><![CDATA[${cdataSafe}]]></script>`;
  const scriptTag = /<script(?:\s[^>]*)?>[\s\S]*?<\/script>/;
  if (!scriptTag.test(xml)) {
    throw new Unsupported(
      'config.xml does not contain a <script> element to update.',
      { operation: 'updatePipelineScript' }
    );
  }
  return xml.replace(scriptTag, () => replacement);
}

function unescapeXml(escaped: string): string {
  return escaped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
