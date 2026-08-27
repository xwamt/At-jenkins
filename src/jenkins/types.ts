export const DEFAULT_LOG_TAIL_BYTES = 64 * 1024; // 64 KiB

export interface LogTruncateOptions {
  start?: number;
  tailBytes?: number;
  maxBytes?: number;
}

export interface LogTruncateResult {
  text: string;
  startByte: number;
  endByte: number;
  totalBytes: number;
  truncated: boolean;
  hasMore?: boolean;
}

export interface JobSummary {
  name: string;
  fullName: string;
  url: string;
  color?: string;
  _class?: string;
  isFolder?: boolean;
  isBuildable?: boolean;
  isMultibranch?: boolean;
  inQueue?: boolean;
  healthScore?: number;
  healthDescription?: string;
  lastBuild?: BuildSummary;
}

export interface JobParameterDefinition {
  name: string;
  type: string;
  description?: string;
  defaultValue?: string | number | boolean;
  choices?: string[];
}

export interface BuildSummary {
  number: number;
  url: string;
  result?: string | null;
  building: boolean;
  timestamp: number;
  duration: number;
  estimatedDuration?: number;
  displayName?: string;
  fullDisplayName?: string;
}

export interface JobDetail {
  name: string;
  fullName: string;
  url: string;
  description?: string;
  color?: string;
  _class?: string;
  buildable?: boolean;
  inQueue?: boolean;
  nextBuildNumber?: number;
  parameters?: JobParameterDefinition[];
  lastBuild?: BuildSummary;
  lastSuccessfulBuild?: BuildSummary;
  lastFailedBuild?: BuildSummary;
  lastCompletedBuild?: BuildSummary;
}

export interface BuildArtifact {
  displayPath?: string;
  fileName: string;
  relativePath: string;
  size?: number;
}

export interface BuildDetail extends BuildSummary {
  description?: string;
  actions?: unknown[];
  artifacts?: BuildArtifact[];
  queueId?: number;
  executor?: unknown;
}

export type PipelineScriptSource = 'stored' | 'scm';

export interface PipelineScript {
  script: string;
  sandbox: boolean;
  scriptSource: PipelineScriptSource;
}

export interface ListBuildsOptions {
  limit?: number;
  offset?: number;
}

export interface TriggerBuildResult {
  queueUrl?: string;
}

export interface QueueExecutable {
  number: number;
  url?: string;
}

export interface QueueItem {
  cancelled?: boolean;
  why?: string;
  executable?: QueueExecutable;
}

/** Compact `tree=` selector used when listing jobs (avoids huge unfiltered graphs). */
export const LIST_JOBS_TREE =
  'jobs[name,_class,url,color,buildable,inQueue,jobs[name]{0,1},healthReport[score,description],lastBuild[number,result,building,timestamp,duration,url,displayName]]';

export const BUILD_SUMMARY_TREE_FIELDS =
  'number,result,building,timestamp,duration,estimatedDuration,url,displayName,fullDisplayName';

/** Compact `tree=` selector used when fetching job detail (avoids downloading every build). */
export const GET_JOB_TREE = [
  'name,url,description,color,_class,buildable,inQueue,nextBuildNumber',
  'property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]',
  'actions[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]',
  `lastBuild[${BUILD_SUMMARY_TREE_FIELDS}]`,
  `lastSuccessfulBuild[${BUILD_SUMMARY_TREE_FIELDS}]`,
  `lastFailedBuild[${BUILD_SUMMARY_TREE_FIELDS}]`,
  `lastCompletedBuild[${BUILD_SUMMARY_TREE_FIELDS}]`
].join(',');
