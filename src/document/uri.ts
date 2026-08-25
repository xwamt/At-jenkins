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
    };

/**
 * Builds a virtual document URI for a Jenkins pipeline script.
 * Format: at-jenkins:/{instanceId}/{jobFullName}/Jenkinsfile
 */
export function buildPipelineScriptUri(instanceId: string, jobFullName: string): vscode.Uri {
  const encInstanceId = encodeURIComponent(instanceId);
  const encJobFullName = encodeURIComponent(jobFullName);
  return vscode.Uri.from({
    scheme: JENKINS_DOCUMENT_SCHEME,
    path: `/${encInstanceId}/${encJobFullName}/Jenkinsfile`
  });
}

/**
 * Builds a virtual document URI for a Jenkins build console log.
 * Format: at-jenkins:/{instanceId}/{jobFullName}/{buildNumber}/consoleText
 */
export function buildBuildLogUri(
  instanceId: string,
  jobFullName: string,
  buildNumber: number
): vscode.Uri {
  const encInstanceId = encodeURIComponent(instanceId);
  const encJobFullName = encodeURIComponent(jobFullName);
  return vscode.Uri.from({
    scheme: JENKINS_DOCUMENT_SCHEME,
    path: `/${encInstanceId}/${encJobFullName}/${buildNumber}/consoleText`
  });
}

/**
 * Parses an at-jenkins virtual document URI into its component parts.
 * Returns undefined if the URI does not belong to the at-jenkins scheme or cannot be parsed.
 */
export function parseJenkinsDocumentUri(uri: vscode.Uri): JenkinsDocumentTarget | undefined {
  if (uri.scheme !== JENKINS_DOCUMENT_SCHEME) {
    return undefined;
  }

  const rawPath = uri.path ?? '';
  const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    return undefined;
  }

  const segments = trimmed.split('/');

  if (segments.length === 3 && segments[2] === 'Jenkinsfile') {
    const instanceId = decodeURIComponent(segments[0]);
    const jobFullName = decodeURIComponent(segments[1]);
    if (!instanceId || !jobFullName) {
      return undefined;
    }
    return {
      type: 'script',
      instanceId,
      jobFullName
    };
  }

  if (segments.length === 4 && segments[3] === 'consoleText') {
    const instanceId = decodeURIComponent(segments[0]);
    const jobFullName = decodeURIComponent(segments[1]);
    const buildNumber = Number.parseInt(segments[2], 10);

    if (!instanceId || !jobFullName || Number.isNaN(buildNumber) || !Number.isFinite(buildNumber)) {
      return undefined;
    }

    return {
      type: 'log',
      instanceId,
      jobFullName,
      buildNumber
    };
  }

  return undefined;
}
