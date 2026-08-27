import type { z } from 'zod';
import type { JenkinsInstanceConfigManager } from '../config/JenkinsInstanceConfigManager';
import type { JenkinsInstanceConfig } from '../config/schema';
import { DeniedBackground, NotFound, Unsupported, AuthError, TlsError } from '../jenkins/errors';
import type { JenkinsClient } from '../jenkins/JenkinsClient';
import type { JenkinsClientPool } from '../jenkins/JenkinsClientPool';
import { DEFAULT_LOG_TAIL_BYTES } from '../jenkins/types';
import {
  describeZodError,
  jenkinsGetBuildLogSchema,
  jenkinsGetBuildSchema,
  jenkinsGetJobSchema,
  jenkinsGetPipelineScriptSchema,
  jenkinsListBuildsSchema,
  jenkinsListInstancesSchema,
  jenkinsListJobsSchema,
  type JenkinsGetBuildInput,
  type JenkinsGetBuildLogInput,
  type JenkinsGetJobInput,
  type JenkinsGetPipelineScriptInput,
  type JenkinsListBuildsInput,
  type JenkinsListInstancesInput,
  type JenkinsListJobsInput
} from '../mcp/bridgeSchemas';
import { formatError } from '../utils/errors';
import type { AtJenkinsLog } from '../utils/logger';

export type JenkinsApiClientLike = Pick<
  JenkinsClient,
  | 'listJobs'
  | 'getJob'
  | 'getPipelineScript'
  | 'listBuilds'
  | 'getBuild'
  | 'getBuildLog'
>;

export type ToolInvokeErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTERNAL_ERROR' | 'UNAVAILABLE';

export interface ToolInvokeSuccess {
  ok: true;
  result: unknown;
}

export interface ToolInvokeFailure {
  ok: false;
  code: ToolInvokeErrorCode;
  message: string;
}

export type ToolInvokeResult = ToolInvokeSuccess | ToolInvokeFailure;

export interface JenkinsAgentToolServiceDependencies {
  configManager: Pick<JenkinsInstanceConfigManager, 'listInstances' | 'getInstance'>;
  clientPool: Pick<JenkinsClientPool, 'get'> | { get(instanceId: string): Promise<JenkinsApiClientLike> };
  log?: AtJenkinsLog;
}

export class JenkinsAgentToolService {
  private readonly configManager: Pick<JenkinsInstanceConfigManager, 'listInstances' | 'getInstance'>;
  private readonly clientPool: { get(instanceId: string): Promise<JenkinsApiClientLike> };
  private readonly log?: AtJenkinsLog;

  constructor(deps: JenkinsAgentToolServiceDependencies) {
    this.configManager = deps.configManager;
    this.clientPool = deps.clientPool;
    this.log = deps.log;
  }

  async invoke(name: string, args: unknown): Promise<ToolInvokeResult> {
    switch (name) {
      case 'jenkins_list_instances':
        return this.handleParsed(jenkinsListInstancesSchema, args, (input) => this.listInstances(input));
      case 'jenkins_list_jobs':
        return this.handleParsed(jenkinsListJobsSchema, args, (input) => this.listJobs(input));
      case 'jenkins_get_job':
        return this.handleParsed(jenkinsGetJobSchema, args, (input) => this.getJob(input));
      case 'jenkins_get_pipeline_script':
        return this.handleParsed(jenkinsGetPipelineScriptSchema, args, (input) =>
          this.getPipelineScript(input)
        );
      case 'jenkins_list_builds':
        return this.handleParsed(jenkinsListBuildsSchema, args, (input) => this.listBuilds(input));
      case 'jenkins_get_build':
        return this.handleParsed(jenkinsGetBuildSchema, args, (input) => this.getBuild(input));
      case 'jenkins_get_build_log':
        return this.handleParsed(jenkinsGetBuildLogSchema, args, (input) => this.getBuildLog(input));
      default:
        return {
          ok: false,
          code: 'NOT_FOUND',
          message: `Unknown MCP tool: ${name}`
        };
    }
  }

  private async handleParsed<T>(
    schema: z.ZodType<T>,
    args: unknown,
    handler: (input: T) => Promise<ToolInvokeResult>
  ): Promise<ToolInvokeResult> {
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: describeZodError(parsed.error)
      };
    }
    try {
      return await handler(parsed.data);
    } catch (error) {
      if (error instanceof DeniedBackground) {
        return {
          ok: false,
          code: 'UNAVAILABLE',
          message: error.message
        };
      }
      if (error instanceof NotFound) {
        return {
          ok: false,
          code: 'NOT_FOUND',
          message: error.message
        };
      }
      if (
        error instanceof Unsupported ||
        error instanceof AuthError ||
        error instanceof TlsError
      ) {
        return {
          ok: false,
          code: 'UNAVAILABLE',
          message: error.message
        };
      }
      const message = formatError(error);
      this.log?.error(`Tool invocation failed: ${message}`);
      return {
        ok: false,
        code: 'INTERNAL_ERROR',
        message
      };
    }
  }

  private async requireBackgroundAccess(instanceId: string): Promise<{
    instance: JenkinsInstanceConfig;
    client: JenkinsApiClientLike;
  }> {
    const instance = await this.configManager.getInstance(instanceId);
    if (!instance) {
      throw new NotFound(`Jenkins instance '${instanceId}' not found.`, instanceId, 404);
    }
    if (!instance.allowBackgroundAccess) {
      throw new DeniedBackground(
        `Background access is not enabled for Jenkins instance "${instance.label}" (${instanceId}). Please enable "Allow Agent background access" in the AT Jenkins extension instance settings.`,
        instanceId
      );
    }

    const client = await this.clientPool.get(instanceId);
    return { instance, client };
  }

  private async listInstances(_input: JenkinsListInstancesInput): Promise<ToolInvokeResult> {
    const all = await this.configManager.listInstances();
    return {
      ok: true,
      result: {
        instances: all.map((inst) => ({
          id: inst.id,
          label: inst.label,
          baseUrl: inst.baseUrl,
          readOnly: inst.readOnly,
          allowBackgroundAccess: inst.allowBackgroundAccess
        }))
      }
    };
  }

  private async listJobs(input: JenkinsListJobsInput): Promise<ToolInvokeResult> {
    const { client } = await this.requireBackgroundAccess(input.instanceId);
    const jobs = await client.listJobs(input.folderFullName);
    return {
      ok: true,
      result: { jobs }
    };
  }

  private async getJob(input: JenkinsGetJobInput): Promise<ToolInvokeResult> {
    const { client } = await this.requireBackgroundAccess(input.instanceId);
    const job = await client.getJob(input.jobFullName);
    return {
      ok: true,
      result: scrubJobSecrets(job)
    };
  }

  private async getPipelineScript(input: JenkinsGetPipelineScriptInput): Promise<ToolInvokeResult> {
    const { client } = await this.requireBackgroundAccess(input.instanceId);
    const pipeline = await client.getPipelineScript(input.jobFullName);
    return {
      ok: true,
      result: pipeline
    };
  }

  private async listBuilds(input: JenkinsListBuildsInput): Promise<ToolInvokeResult> {
    const { client } = await this.requireBackgroundAccess(input.instanceId);
    const builds = await client.listBuilds(input.jobFullName, {
      limit: input.limit,
      offset: input.offset
    });
    return {
      ok: true,
      result: { builds }
    };
  }

  private async getBuild(input: JenkinsGetBuildInput): Promise<ToolInvokeResult> {
    const { client } = await this.requireBackgroundAccess(input.instanceId);
    const build = await client.getBuild(input.jobFullName, input.buildNumber);
    return {
      ok: true,
      result: build
    };
  }

  private async getBuildLog(input: JenkinsGetBuildLogInput): Promise<ToolInvokeResult> {
    const { client } = await this.requireBackgroundAccess(input.instanceId);
    const cappedTail = Math.min(input.tailBytes ?? DEFAULT_LOG_TAIL_BYTES, MAX_MCP_LOG_TAIL_BYTES);
    const logResult = await client.getBuildLog(input.jobFullName, input.buildNumber, {
      start: input.start,
      tailBytes: cappedTail
    });
    return {
      ok: true,
      result: logResult
    };
  }
}

/** Hard cap for MCP log responses (agent context / memory). */
export const MAX_MCP_LOG_TAIL_BYTES = 256 * 1024;

function scrubJobSecrets<T extends { parameters?: Array<{ type?: string; defaultValue?: unknown }> }>(
  job: T
): T {
  if (!job.parameters?.length) {
    return job;
  }
  return {
    ...job,
    parameters: job.parameters.map((p) => {
      const type = (p.type ?? '').toLowerCase();
      if (type.includes('password') || type.includes('credential')) {
        const { defaultValue: _omit, ...rest } = p;
        return { ...rest, defaultValue: undefined };
      }
      return p;
    })
  };
}
