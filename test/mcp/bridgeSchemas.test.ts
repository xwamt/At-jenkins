import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SCHEMAS_BY_TOOL_NAME,
  describeZodError,
  JENKINS_GET_BUILD_INPUT_SCHEMA,
  JENKINS_GET_BUILD_LOG_INPUT_SCHEMA,
  JENKINS_GET_JOB_INPUT_SCHEMA,
  JENKINS_GET_PIPELINE_SCRIPT_INPUT_SCHEMA,
  JENKINS_LIST_BUILDS_INPUT_SCHEMA,
  JENKINS_LIST_INSTANCES_INPUT_SCHEMA,
  JENKINS_LIST_JOBS_INPUT_SCHEMA,
  jenkinsGetBuildLogSchema,
  jenkinsGetBuildSchema,
  jenkinsGetJobSchema,
  jenkinsGetPipelineScriptSchema,
  jenkinsListBuildsSchema,
  jenkinsListInstancesSchema,
  jenkinsListJobsSchema
} from '../../src/mcp/bridgeSchemas';

describe('bridgeSchemas', () => {
  it('jenkinsListInstancesSchema accepts empty object and rejects extra keys', () => {
    expect(jenkinsListInstancesSchema.safeParse({}).success).toBe(true);
    expect(jenkinsListInstancesSchema.safeParse({ extra: 'value' }).success).toBe(false);
  });

  it('jenkinsListJobsSchema requires instanceId and accepts optional folderFullName', () => {
    expect(jenkinsListJobsSchema.safeParse({ instanceId: 'inst-1' }).success).toBe(true);
    expect(jenkinsListJobsSchema.safeParse({ instanceId: 'inst-1', folderFullName: 'folder1' }).success).toBe(true);
    expect(jenkinsListJobsSchema.safeParse({}).success).toBe(false);
    expect(jenkinsListJobsSchema.safeParse({ instanceId: '' }).success).toBe(false);
    expect(jenkinsListJobsSchema.safeParse({ instanceId: 'inst-1', extra: 123 }).success).toBe(false);
  });

  it('jenkinsGetJobSchema requires instanceId and jobFullName', () => {
    expect(jenkinsGetJobSchema.safeParse({ instanceId: 'inst-1', jobFullName: 'job-1' }).success).toBe(true);
    expect(jenkinsGetJobSchema.safeParse({ instanceId: 'inst-1' }).success).toBe(false);
    expect(jenkinsGetJobSchema.safeParse({ jobFullName: 'job-1' }).success).toBe(false);
    expect(jenkinsGetJobSchema.safeParse({ instanceId: '', jobFullName: 'job-1' }).success).toBe(false);
  });

  it('jenkinsGetPipelineScriptSchema requires instanceId and jobFullName', () => {
    expect(jenkinsGetPipelineScriptSchema.safeParse({ instanceId: 'inst-1', jobFullName: 'folder/pipeline' }).success).toBe(true);
    expect(jenkinsGetPipelineScriptSchema.safeParse({ instanceId: 'inst-1' }).success).toBe(false);
    expect(jenkinsGetPipelineScriptSchema.safeParse({ instanceId: 'inst-1', jobFullName: '' }).success).toBe(false);
  });

  it('jenkinsListBuildsSchema requires instanceId and jobFullName with optional limit and offset', () => {
    expect(jenkinsListBuildsSchema.safeParse({ instanceId: 'inst-1', jobFullName: 'job-1' }).success).toBe(true);
    expect(
      jenkinsListBuildsSchema.safeParse({
        instanceId: 'inst-1',
        jobFullName: 'job-1',
        limit: 10,
        offset: 5
      }).success
    ).toBe(true);
    expect(jenkinsListBuildsSchema.safeParse({ instanceId: 'inst-1', jobFullName: 'job-1', limit: -1 }).success).toBe(false);
    expect(jenkinsListBuildsSchema.safeParse({ instanceId: 'inst-1', jobFullName: 'job-1', offset: -5 }).success).toBe(false);
  });

  it('jenkinsGetBuildSchema requires instanceId, jobFullName and positive integer buildNumber', () => {
    expect(
      jenkinsGetBuildSchema.safeParse({
        instanceId: 'inst-1',
        jobFullName: 'job-1',
        buildNumber: 42
      }).success
    ).toBe(true);
    expect(
      jenkinsGetBuildSchema.safeParse({
        instanceId: 'inst-1',
        jobFullName: 'job-1',
        buildNumber: 0
      }).success
    ).toBe(false);
    expect(
      jenkinsGetBuildSchema.safeParse({
        instanceId: 'inst-1',
        jobFullName: 'job-1',
        buildNumber: 3.14
      }).success
    ).toBe(false);
    expect(jenkinsGetBuildSchema.safeParse({ instanceId: 'inst-1', jobFullName: 'job-1' }).success).toBe(false);
  });

  it('jenkinsGetBuildLogSchema requires instanceId, jobFullName, buildNumber and accepts start/tailBytes', () => {
    expect(
      jenkinsGetBuildLogSchema.safeParse({
        instanceId: 'inst-1',
        jobFullName: 'job-1',
        buildNumber: 1
      }).success
    ).toBe(true);
    expect(
      jenkinsGetBuildLogSchema.safeParse({
        instanceId: 'inst-1',
        jobFullName: 'job-1',
        buildNumber: 1,
        tailBytes: 1024,
        start: 0
      }).success
    ).toBe(true);
    expect(
      jenkinsGetBuildLogSchema.safeParse({
        instanceId: 'inst-1',
        jobFullName: 'job-1',
        buildNumber: 1,
        tailBytes: -1
      }).success
    ).toBe(false);
  });

  it('contains schema for all 7 catalog tools in BRIDGE_SCHEMAS_BY_TOOL_NAME', () => {
    expect(Object.keys(BRIDGE_SCHEMAS_BY_TOOL_NAME).sort()).toEqual([
      'jenkins_get_build',
      'jenkins_get_build_log',
      'jenkins_get_job',
      'jenkins_get_pipeline_script',
      'jenkins_list_builds',
      'jenkins_list_instances',
      'jenkins_list_jobs'
    ]);
  });

  it('JSON schemas validate required fields and additionalProperties false', () => {
    expect(JENKINS_LIST_INSTANCES_INPUT_SCHEMA.additionalProperties).toBe(false);
    expect(JENKINS_LIST_JOBS_INPUT_SCHEMA.required).toEqual(['instanceId']);
    expect(JENKINS_GET_JOB_INPUT_SCHEMA.required).toEqual(['instanceId', 'jobFullName']);
    expect(JENKINS_GET_PIPELINE_SCRIPT_INPUT_SCHEMA.required).toEqual(['instanceId', 'jobFullName']);
    expect(JENKINS_LIST_BUILDS_INPUT_SCHEMA.required).toEqual(['instanceId', 'jobFullName']);
    expect(JENKINS_GET_BUILD_INPUT_SCHEMA.required).toEqual(['instanceId', 'jobFullName', 'buildNumber']);
    expect(JENKINS_GET_BUILD_LOG_INPUT_SCHEMA.required).toEqual(['instanceId', 'jobFullName', 'buildNumber']);
  });

  it('describeZodError formats issues clearly', () => {
    const res = jenkinsGetJobSchema.safeParse({});
    expect(res.success).toBe(false);
    if (!res.success) {
      const msg = describeZodError(res.error);
      expect(msg).toContain('instanceId');
      expect(msg).toContain('jobFullName');
    }
  });
});
