import * as vscode from 'vscode';
import type { JenkinsInstanceConfigManager } from '../config/JenkinsInstanceConfigManager';
import { t } from '../i18n/t';
import { Unsupported } from '../jenkins/errors';
import type { JenkinsClientPool } from '../jenkins/JenkinsClientPool';
import { formatError } from '../utils/errors';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import { JENKINS_DRAFT_SCHEME, parsePipelineDraftUri } from './draftUri';
import type { JenkinsPipelineDraftFileSystemProvider } from './JenkinsPipelineDraftFileSystemProvider';
import {
  buildPipelineScriptUri,
  JENKINS_DOCUMENT_SCHEME,
  parseJenkinsDocumentUri
} from './uri';

export interface PipelineScriptDocumentProviderOptions {
  log?: AtJenkinsLog;
  draftProvider?: JenkinsPipelineDraftFileSystemProvider;
}

export class PipelineScriptDocumentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange: vscode.Event<vscode.Uri> = this.onDidChangeEmitter.event;

  private readonly log: AtJenkinsLog;
  private readonly draftProvider?: JenkinsPipelineDraftFileSystemProvider;

  constructor(
    private readonly clientPool: JenkinsClientPool,
    private readonly configManager?: JenkinsInstanceConfigManager,
    options?: PipelineScriptDocumentProviderOptions
  ) {
    this.log = asRedactedLog(options?.log ?? noopLog);
    this.draftProvider = options?.draftProvider;
  }

  /**
   * Read-only fallback content (Unsupported / error). Editable scripts use the draft FS.
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = parseJenkinsDocumentUri(uri);
    if (!target || target.type !== 'script') {
      return `// ${t('Invalid Jenkins pipeline script URI.')}\n`;
    }

    try {
      const client = await this.clientPool.get(target.instanceId);
      const res = await client.getPipelineScript(target.jobFullName);
      return res.script;
    } catch (error) {
      if (error instanceof Unsupported) {
        return `// ${error.message}\n`;
      }
      this.log.error(
        `Failed to load pipeline script for ${target.instanceId}/${target.jobFullName}: ${formatError(error)}`
      );
      return `// ${t('Failed to load pipeline script for "{job}": {error}', {
        job: target.jobFullName,
        error: formatError(error)
      })}\n`;
    }
  }

  /**
   * Handles saving a pipeline script draft back to Jenkins (confirm + readOnly + writability).
   */
  async savePipelineScript(document: vscode.TextDocument): Promise<boolean> {
    const isDraft = document.uri.scheme === JENKINS_DRAFT_SCHEME;
    const isContent = document.uri.scheme === JENKINS_DOCUMENT_SCHEME;
    if (!isDraft && !isContent) {
      return false;
    }

    const draftTarget = isDraft ? parsePipelineDraftUri(document.uri) : undefined;
    const contentTarget =
      isContent && !draftTarget ? parseJenkinsDocumentUri(document.uri) : undefined;
    const target =
      draftTarget ??
      (contentTarget?.type === 'script'
        ? { instanceId: contentTarget.instanceId, jobFullName: contentTarget.jobFullName }
        : undefined);

    if (!target) {
      return false;
    }

    if (isDraft && this.draftProvider) {
      const draft = this.draftProvider.getDraft(document.uri);
      if (draft && !draft.writable) {
        vscode.window.showErrorMessage(
          t('Cannot save: this pipeline script is read-only (SCM-backed or non-editable).')
        );
        return false;
      }
    }

    if (isContent) {
      vscode.window.showErrorMessage(
        t('Cannot save: open a controller-stored Pipeline job as an editable draft first.')
      );
      return false;
    }

    try {
      const client = await this.clientPool.get(target.instanceId);
      const instance =
        client.config ?? (await this.configManager?.getInstance(target.instanceId));

      if (!instance) {
        vscode.window.showErrorMessage(t('Jenkins controller not found.'));
        return false;
      }

      if (instance.readOnly) {
        vscode.window.showErrorMessage(
          t('Cannot save pipeline script: controller "{label}" is read-only.', {
            label: instance.label || target.instanceId
          })
        );
        return false;
      }

      // Refuse before confirm when Jenkins would reject (SCM / Freestyle).
      try {
        await client.getPipelineScript(target.jobFullName);
      } catch (error) {
        if (error instanceof Unsupported) {
          vscode.window.showErrorMessage(error.message);
          return false;
        }
        throw error;
      }

      const confirm = await vscode.window.showWarningMessage(
        t('Save changes to Jenkins pipeline script for "{job}" on controller "{label}"?', {
          job: target.jobFullName,
          label: instance.label || target.instanceId
        }),
        { modal: true },
        t('Save to Jenkins'),
        t('Cancel')
      );

      if (confirm !== t('Save to Jenkins')) {
        return false;
      }

      const content = typeof document.getText === 'function' ? document.getText() : '';
      await client.updatePipelineScript(target.jobFullName, content);
      this.draftProvider?.markClean(document.uri, content);

      vscode.window.showInformationMessage(
        t('Pipeline script saved for "{job}".', {
          job: target.jobFullName
        })
      );
      return true;
    } catch (error) {
      this.log.error(
        `Failed to save pipeline script for ${target.instanceId}/${target.jobFullName}: ${formatError(error)}`
      );
      // Log a longer diagnostic line for Stapler HTML 500 bodies (Output: AT Jenkins).
      if (error instanceof Error && error.message.includes('HTTP 500')) {
        this.log.error(`Save diagnostic (HTTP 500 detail): ${error.message.slice(0, 1500)}`);
      }
      vscode.window.showErrorMessage(
        t('Failed to save pipeline script: {error}', {
          error: formatError(error)
        })
      );
      return false;
    }
  }

  refresh(instanceId: string, jobFullName: string): void {
    this.onDidChangeEmitter.fire(buildPipelineScriptUri(instanceId, jobFullName));
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
