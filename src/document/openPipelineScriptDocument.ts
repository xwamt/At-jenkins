import * as vscode from 'vscode';
import type { JenkinsClientPool } from '../jenkins/JenkinsClientPool';
import { Unsupported } from '../jenkins/errors';
import { formatError } from '../utils/errors';
import { t } from '../i18n/t';
import type { JenkinsPipelineDraftFileSystemProvider } from './JenkinsPipelineDraftFileSystemProvider';

/**
 * Opens a Pipeline script as an editable `at-jenkins-draft:` document when the
 * job uses a controller-stored CPS definition.
 *
 * SCM / Freestyle / other unsupported definitions do **not** open a fake
 * read-only `at-jenkins:` editor tab (TextDocumentContentProvider is always
 * non-editable and looks broken). Instead we surface a clear error.
 */
export async function openPipelineScriptDocument(options: {
  instanceId: string;
  jobFullName: string;
  clientPool: JenkinsClientPool;
  draftProvider: JenkinsPipelineDraftFileSystemProvider;
}): Promise<vscode.TextDocument | undefined> {
  const { instanceId, jobFullName, clientPool, draftProvider } = options;
  const client = await clientPool.get(instanceId);

  try {
    const pipeline = await client.getPipelineScript(jobFullName);
    // Controller-stored scripts are always editable drafts; save still checks readOnly.
    const uri = draftProvider.initDraft(instanceId, jobFullName, pipeline.script, true);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    try {
      await vscode.languages.setTextDocumentLanguage(doc, 'groovy');
    } catch {
      // language pack may be absent
    }
    vscode.window.showInformationMessage(
      t('Editing "{job}". Save (Cmd/Ctrl+S) writes the script back to Jenkins after confirm.', {
        job: jobFullName
      })
    );
    return doc;
  } catch (error) {
    if (error instanceof Unsupported) {
      vscode.window.showErrorMessage(
        t(
          'Cannot edit "{job}": {error} Only jobs with "Pipeline script" stored on the Jenkins controller can be edited here. "Pipeline script from SCM" (Git) must be changed in source control.',
          { job: jobFullName, error: error.message }
        )
      );
      return undefined;
    }
    throw new Error(formatError(error));
  }
}
