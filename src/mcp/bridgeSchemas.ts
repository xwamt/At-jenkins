import { z } from 'zod';
import type { JsonSchemaObject } from '@at-series/mcp-hub';

/**
 * Server-side input validation for AT Jenkins MCP tools.
 * Every tool except `jenkins_list_instances` requires `instanceId`.
 *
 * `.strict()` rejects unknown properties outright.
 */
export const jenkinsListInstancesSchema = z.object({}).strict();

export const jenkinsListJobsSchema = z
  .object({
    instanceId: z.string().min(1),
    folderFullName: z.string().optional()
  })
  .strict();

export const jenkinsGetJobSchema = z
  .object({
    instanceId: z.string().min(1),
    jobFullName: z.string().min(1)
  })
  .strict();

export const jenkinsGetPipelineScriptSchema = z
  .object({
    instanceId: z.string().min(1),
    jobFullName: z.string().min(1)
  })
  .strict();

export const jenkinsListBuildsSchema = z
  .object({
    instanceId: z.string().min(1),
    jobFullName: z.string().min(1),
    limit: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional()
  })
  .strict();

export const jenkinsGetBuildSchema = z
  .object({
    instanceId: z.string().min(1),
    jobFullName: z.string().min(1),
    buildNumber: z.number().int().positive()
  })
  .strict();

export const jenkinsGetBuildLogSchema = z
  .object({
    instanceId: z.string().min(1),
    jobFullName: z.string().min(1),
    buildNumber: z.number().int().positive(),
    tailBytes: z.number().int().nonnegative().optional(),
    start: z.number().int().nonnegative().optional()
  })
  .strict();

export type JenkinsListInstancesInput = z.infer<typeof jenkinsListInstancesSchema>;
export type JenkinsListJobsInput = z.infer<typeof jenkinsListJobsSchema>;
export type JenkinsGetJobInput = z.infer<typeof jenkinsGetJobSchema>;
export type JenkinsGetPipelineScriptInput = z.infer<typeof jenkinsGetPipelineScriptSchema>;
export type JenkinsListBuildsInput = z.infer<typeof jenkinsListBuildsSchema>;
export type JenkinsGetBuildInput = z.infer<typeof jenkinsGetBuildSchema>;
export type JenkinsGetBuildLogInput = z.infer<typeof jenkinsGetBuildLogSchema>;

export const JENKINS_LIST_INSTANCES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {},
  additionalProperties: false
};

export const JENKINS_LIST_JOBS_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Jenkins instance ID discovered via jenkins_list_instances.'
    },
    folderFullName: {
      type: 'string',
      description: 'Optional parent folder full name (e.g. "folder1" or "folder1/job2") to list jobs within.'
    }
  },
  required: ['instanceId'],
  additionalProperties: false
};

export const JENKINS_GET_JOB_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Jenkins instance ID.'
    },
    jobFullName: {
      type: 'string',
      description: 'Full name/path of the job (e.g. "build-app" or "folder1/job2").'
    }
  },
  required: ['instanceId', 'jobFullName'],
  additionalProperties: false
};

export const JENKINS_GET_PIPELINE_SCRIPT_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Jenkins instance ID.'
    },
    jobFullName: {
      type: 'string',
      description: 'Full name/path of the controller-stored Pipeline job.'
    }
  },
  required: ['instanceId', 'jobFullName'],
  additionalProperties: false
};

export const JENKINS_LIST_BUILDS_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Jenkins instance ID.'
    },
    jobFullName: {
      type: 'string',
      description: 'Full name/path of the job.'
    },
    limit: {
      type: 'integer',
      minimum: 0,
      description: 'Maximum number of builds to return.'
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'Number of recent builds to skip (0-based offset).'
    }
  },
  required: ['instanceId', 'jobFullName'],
  additionalProperties: false
};

export const JENKINS_GET_BUILD_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Jenkins instance ID.'
    },
    jobFullName: {
      type: 'string',
      description: 'Full name/path of the job.'
    },
    buildNumber: {
      type: 'integer',
      minimum: 1,
      description: 'Build number (e.g. 42).'
    }
  },
  required: ['instanceId', 'jobFullName', 'buildNumber'],
  additionalProperties: false
};

export const JENKINS_GET_BUILD_LOG_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Jenkins instance ID.'
    },
    jobFullName: {
      type: 'string',
      description: 'Full name/path of the job.'
    },
    buildNumber: {
      type: 'integer',
      minimum: 1,
      description: 'Build number (e.g. 42).'
    },
    tailBytes: {
      type: 'integer',
      minimum: 0,
      description: 'Number of bytes to read from the end of the log (default 65536 / 64KiB).'
    },
    start: {
      type: 'integer',
      minimum: 0,
      description: 'Starting byte offset for progressive log loading (0-based).'
    }
  },
  required: ['instanceId', 'jobFullName', 'buildNumber'],
  additionalProperties: false
};

export const BRIDGE_SCHEMAS_BY_TOOL_NAME: Record<string, z.ZodTypeAny> = {
  jenkins_list_instances: jenkinsListInstancesSchema,
  jenkins_list_jobs: jenkinsListJobsSchema,
  jenkins_get_job: jenkinsGetJobSchema,
  jenkins_get_pipeline_script: jenkinsGetPipelineScriptSchema,
  jenkins_list_builds: jenkinsListBuildsSchema,
  jenkins_get_build: jenkinsGetBuildSchema,
  jenkins_get_build_log: jenkinsGetBuildLogSchema
};

export function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
