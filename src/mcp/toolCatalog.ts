import type { ToolCatalogEntry } from '@at-series/mcp-hub';
import {
  JENKINS_GET_BUILD_INPUT_SCHEMA,
  JENKINS_GET_BUILD_LOG_INPUT_SCHEMA,
  JENKINS_GET_JOB_INPUT_SCHEMA,
  JENKINS_GET_PIPELINE_SCRIPT_INPUT_SCHEMA,
  JENKINS_LIST_BUILDS_INPUT_SCHEMA,
  JENKINS_LIST_INSTANCES_INPUT_SCHEMA,
  JENKINS_LIST_JOBS_INPUT_SCHEMA
} from './bridgeSchemas';
import { AT_JENKINS_PLUGIN_DISPLAY_NAME } from './BridgeProtocol';

export { AT_JENKINS_PLUGIN_DISPLAY_NAME };

/**
 * Stable reverse-domain plugin ID (AT Series Hub Protocol v1 §4.2).
 */
export const AT_JENKINS_PLUGIN_ID = 'at.jenkins' as const;

export const AT_JENKINS_TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: 'jenkins_list_instances',
    title: 'List Jenkins instances',
    description:
      'List configured plugin instances (Jenkins controllers), as [{id, label, baseUrl, readOnly, allowBackgroundAccess}], not remote worker nodes. ' +
      'Credentials are never returned. Call this first to discover valid instanceId values for other jenkins_* tools.',
    risk: 'read',
    inputSchema: JENKINS_LIST_INSTANCES_INPUT_SCHEMA
  },
  {
    name: 'jenkins_list_jobs',
    title: 'List Jenkins jobs',
    description:
      'List jobs at the root or within a specific folder/multibranch project. ' +
      'Optional folderFullName specifies a parent folder path (e.g. "folder1" or "folder1/job2").',
    risk: 'read',
    inputSchema: JENKINS_LIST_JOBS_INPUT_SCHEMA
  },
  {
    name: 'jenkins_get_job',
    title: 'Get Jenkins job detail',
    description:
      'Get detailed metadata and parameter definitions for a job by jobFullName.',
    risk: 'read',
    inputSchema: JENKINS_GET_JOB_INPUT_SCHEMA
  },
  {
    name: 'jenkins_get_pipeline_script',
    title: 'Get Jenkins pipeline script',
    description:
      'Get the stored pipeline script (Jenkinsfile/script) for a controller-stored Pipeline job. ' +
      'Throws if the job is SCM-backed or Freestyle.',
    risk: 'read',
    inputSchema: JENKINS_GET_PIPELINE_SCRIPT_INPUT_SCHEMA
  },
  {
    name: 'jenkins_list_builds',
    title: 'List Jenkins builds',
    description:
      'List recent builds for a job. Optional limit and offset for pagination.',
    risk: 'read',
    inputSchema: JENKINS_LIST_BUILDS_INPUT_SCHEMA
  },
  {
    name: 'jenkins_get_build',
    title: 'Get Jenkins build detail',
    description:
      'Get build detail status, result, duration, and metadata by jobFullName and buildNumber.',
    risk: 'read',
    inputSchema: JENKINS_GET_BUILD_INPUT_SCHEMA
  },
  {
    name: 'jenkins_get_build_log',
    title: 'Get Jenkins build log',
    description:
      'Get console text log for a build. By default returns the last 64KiB (65536 bytes) tail of the log. ' +
      'Optional start and tailBytes parameters can be used for offset-based retrieval or custom tail size.',
    risk: 'read',
    inputSchema: JENKINS_GET_BUILD_LOG_INPUT_SCHEMA
  }
];
