import * as vscode from 'vscode';
import type { JenkinsInstanceConfigManager } from '../config/JenkinsInstanceConfigManager';
import { t } from '../i18n/t';
import { Unsupported } from '../jenkins/errors';
import type { JenkinsClientPool } from '../jenkins/JenkinsClientPool';
import { formatError } from '../utils/errors';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import {
  buildPipelineScriptUri,
  JENKINS_DOCUMENT_SCHEME,
  parseJenkinsDocumentUri
} from './uri';

export interface PipelineScriptDocumentProviderOptions {
  log?: AtJenkinsLog;
}

export class PipelineScriptDocumentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange: vscode.Event<vscode.Uri> = this.onDidChangeEmitter.event;

  private readonly log: AtJenkinsLog;

  constructor(
    private readonly clientPool: JenkinsClientPool,
    private readonly configManager?: JenkinsInstanceConfigManager,
    options?: PipelineScriptDocumentProviderOptions
  ) {
    this.log = asRedactedLog(options?.log ?? noopLog);
  }

  /**
   * Loads the pipeline script for a controller-stored pipeline job.
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
   * Handles saving a pipeline script virtual document back to Jenkins.
   * Checks read-only status and confirms before updating.
   */
  async savePipelineScript(document: vscode.TextDocument): Promise<boolean> {
    if (document.uri.scheme !== JENKINS_DOCUMENT_SCHEME) {
      return false;
    }

    const target = parseJenkinsDocumentUri(document.uri);
    if (!target || target.type !== 'script') {
      return false;
    }

    try {
      const client = await this.clientPool.get(target.instanceId);
      const instance =
        client.config ?? (await this.configManager?.getInstance(target.instanceId));

      if (instance?.readOnly) {
        vscode.window.showErrorMessage(
          t('Cannot save pipeline script: controller "{label}" is read-only.', {
            label: instance.label || target.instanceId
          })
        );
        return false;
      }

      const confirm = await vscode.window.showWarningMessage(
        t('Save changes to Jenkins pipeline script for "{job}" on controller "{label}"?', {
          job: target.jobFullName,
          label: instance?.label || target.instanceId
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
      vscode.window.showErrorMessage(
        t('Failed to save pipeline script: {error}', {
          error: formatError(error)
        })
      );
      return false;
    }
  }

  /**
   * Refreshes the given pipeline script document.
   */
  refresh(instanceId: string, jobFullName: string): void {
    this.onDidChangeEmitter.fire(buildPipelineScriptUri(instanceId, jobFullName));
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
