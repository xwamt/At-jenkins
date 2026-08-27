import * as vscode from 'vscode';

export const JENKINS_DRAFT_SCHEME = 'at-jenkins-draft';

export interface JenkinsPipelineDraftTarget {
  instanceId: string;
  jobFullName: string;
}

/**
 * Builds an editable draft URI for a controller-stored Pipeline script.
 *
 * Path-based (no authority), aligned with nacos-draft:
 * `at-jenkins-draft:/{instanceId}/Jenkinsfile?job={encodedJobFullName}`
 *
 * Job full name stays in the query so nested `/` paths survive Uri round-trips.
 */
export function buildPipelineDraftUri(instanceId: string, jobFullName: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: JENKINS_DRAFT_SCHEME,
    path: `/${encodeURIComponent(instanceId)}/Jenkinsfile`,
    query: `job=${encodeURIComponent(jobFullName)}`
  });
}

export function parsePipelineDraftUri(uri: vscode.Uri): JenkinsPipelineDraftTarget | undefined {
  if (uri.scheme !== JENKINS_DRAFT_SCHEME) {
    return undefined;
  }

  const params = new URLSearchParams(uri.query ?? '');
  const jobParam = params.get('job');
  if (!jobParam) {
    return undefined;
  }

  const segments = (uri.path ?? '').split('/').filter(Boolean);
  if (segments.length !== 2 || segments[1] !== 'Jenkinsfile') {
    return undefined;
  }

  try {
    const instanceId = decodeURIComponent(segments[0] ?? '');
    const jobFullName = decodeURIComponent(jobParam);
    if (!instanceId || !jobFullName) {
      return undefined;
    }
    return { instanceId, jobFullName };
  } catch {
    return undefined;
  }
}

/** Stable map key independent of Uri.toString() encoding differences. */
export function pipelineDraftKey(instanceId: string, jobFullName: string): string {
  return `${instanceId}\0${jobFullName}`;
}

export function pipelineDraftKeyFromUri(uri: vscode.Uri): string | undefined {
  const target = parsePipelineDraftUri(uri);
  return target ? pipelineDraftKey(target.instanceId, target.jobFullName) : undefined;
}
