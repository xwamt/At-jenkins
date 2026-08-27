import type { JenkinsInstanceConfig } from '../config/schema';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import { ReadOnly, Unsupported } from './errors';
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
  TriggerBuildResult
} from './types';

export interface JenkinsClientOptions {
  httpClient: JenkinsHttpClient;
  authenticator: JenkinsAuthenticator;
  instanceConfig?: JenkinsInstanceConfig;
  log?: AtJenkinsLog;
}

interface RawJobItem {
  _class?: string;
  name: string;
  url: string;
  color?: string;
  buildable?: boolean;
  jobs?: RawJobItem[];
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
        query: { tree: 'jobs[name,_class,url,color,buildable,jobs[name]]' },
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

      return {
        name: item.name,
        fullName,
        url: item.url,
        color: item.color,
        _class: item._class,
        isFolder,
        isBuildable,
        isMultibranch
      };
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
      lastBuild: raw.lastBuild,
      lastSuccessfulBuild: raw.lastSuccessfulBuild,
      lastFailedBuild: raw.lastFailedBuild,
      lastCompletedBuild: raw.lastCompletedBuild
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

    const res = await this.authenticator.withAuthRetry(async (headers) => {
      return this.httpClient.requestJson<{ builds?: BuildSummary[] }>({
        method: 'GET',
        path,
        query: {
          tree: 'builds[number,result,building,timestamp,duration,estimatedDuration,url,displayName,fullDisplayName]'
        },
        headers
      });
    }, 'GET');

    const builds = res?.builds ?? [];
    if (opts?.offset !== undefined || opts?.limit !== undefined) {
      const offset = Math.max(0, opts.offset ?? 0);
      const limit = opts.limit !== undefined ? Math.max(0, opts.limit) : builds.length;
      return builds.slice(offset, offset + limit);
    }
    return builds;
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
   */
  async getBuildLog(
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

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
