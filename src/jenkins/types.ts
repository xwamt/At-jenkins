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
