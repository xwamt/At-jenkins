import * as vscode from 'vscode';

export const JENKINS_DOCUMENT_SCHEME = 'at-jenkins';

export type JenkinsDocumentTarget =
  | {
      type: 'script';
      instanceId: string;
      jobFullName: string;
    }
  | {
      type: 'log';
      instanceId: string;
      jobFullName: string;
      buildNumber: number;
    }
  | {
      type: 'summary';
      instanceId: string;
      jobFullName: string;
    };

/**
 * Read-only content URI for unsupported / error script views.
 * Format: at-jenkins://{instanceId}/Jenkinsfile?job={encodedJobFullName}
 */
export function buildPipelineScriptUri(instanceId: string, jobFullName: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: JENKINS_DOCUMENT_SCHEME,
    authority: encodeURIComponent(instanceId),
    path: '/Jenkinsfile',
    query: `job=${encodeURIComponent(jobFullName)}`
  });
}

/**
 * Format: at-jenkins://{instanceId}/{buildNumber}/consoleText?job={encodedJobFullName}
 */
export function buildBuildLogUri(
  instanceId: string,
  jobFullName: string,
  buildNumber: number
): vscode.Uri {
  return vscode.Uri.from({
    scheme: JENKINS_DOCUMENT_SCHEME,
    authority: encodeURIComponent(instanceId),
    path: `/${buildNumber}/consoleText`,
    query: `job=${encodeURIComponent(jobFullName)}`
  });
}

/**
 * Read-only job summary (Freestyle / any job metadata).
 * Format: at-jenkins://{instanceId}/summary.md?job={encodedJobFullName}
 */
export function buildJobSummaryUri(instanceId: string, jobFullName: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: JENKINS_DOCUMENT_SCHEME,
    authority: encodeURIComponent(instanceId),
    path: '/summary.md',
    query: `job=${encodeURIComponent(jobFullName)}`
  });
}

export function parseJenkinsDocumentUri(uri: vscode.Uri): JenkinsDocumentTarget | undefined {
  if (uri.scheme !== JENKINS_DOCUMENT_SCHEME) {
    return undefined;
  }

  let instanceId: string;
  try {
    instanceId = decodeURIComponent(uri.authority || '');
  } catch {
    return undefined;
  }
  if (!instanceId) {
    return undefined;
  }

  const params = new URLSearchParams(uri.query ?? '');
  const jobParam = params.get('job');
  if (!jobParam) {
    return undefined;
  }
  let jobFullName: string;
  try {
    jobFullName = decodeURIComponent(jobParam);
  } catch {
    return undefined;
  }
  if (!jobFullName) {
    return undefined;
  }

  const path = (uri.path ?? '').replace(/\/+$/g, '') || '/';

  if (path === '/Jenkinsfile') {
    return { type: 'script', instanceId, jobFullName };
  }

  if (path === '/summary.md') {
    return { type: 'summary', instanceId, jobFullName };
  }

  const logMatch = /^\/(\d+)\/consoleText$/.exec(path);
  if (logMatch) {
    const buildNumber = Number.parseInt(logMatch[1], 10);
    if (!Number.isFinite(buildNumber)) {
      return undefined;
    }
    return { type: 'log', instanceId, jobFullName, buildNumber };
  }

  return undefined;
}
