import * as vscode from 'vscode';
import { t } from '../i18n/t';
import type { JenkinsClientPool } from '../jenkins/JenkinsClientPool';
import { formatError } from '../utils/errors';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import {
  buildBuildLogUri,
  JENKINS_DOCUMENT_SCHEME,
  parseJenkinsDocumentUri
} from './uri';

export interface BuildLogDocumentProviderOptions {
  pollIntervalMs?: number;
  log?: AtJenkinsLog;
}

export class BuildLogDocumentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange: vscode.Event<vscode.Uri> = this.onDidChangeEmitter.event;

  private readonly activePollers = new Map<string, NodeJS.Timeout>();
  private readonly pollIntervalMs: number;
  private readonly log: AtJenkinsLog;

  constructor(
    private readonly clientPool: JenkinsClientPool,
    options?: BuildLogDocumentProviderOptions
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 3000;
    this.log = asRedactedLog(options?.log ?? noopLog);
  }

  /**
   * Loads console text for a build and initiates progressive auto-refresh if the build is running.
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = parseJenkinsDocumentUri(uri);
    if (!target || target.type !== 'log') {
      return `// ${t('Invalid Jenkins build log URI.')}\n`;
    }

    try {
      const client = await this.clientPool.get(target.instanceId);
      const logResult = await client.getBuildLog(target.jobFullName, target.buildNumber);

      try {
        const build = await client.getBuild(target.jobFullName, target.buildNumber);
        if (build.building) {
          this.startAutoRefresh(uri, target.instanceId, target.jobFullName, target.buildNumber);
        } else {
          this.stopAutoRefresh(uri);
        }
      } catch (err) {
        this.log.debug(
          `Could not inspect build status for ${target.jobFullName} #${target.buildNumber}: ${formatError(err)}`
        );
      }

      return logResult.text;
    } catch (error) {
      this.log.error(
        `Failed to load build log for ${target.instanceId}/${target.jobFullName} #${target.buildNumber}: ${formatError(error)}`
      );
      return `// ${t('Failed to load build log for "{job} #{build}": {error}', {
        job: target.jobFullName,
        build: target.buildNumber,
        error: formatError(error)
      })}\n`;
    }
  }

  /**
   * Starts periodic polling for an active running build log.
   */
  startAutoRefresh(
    uri: vscode.Uri,
    instanceId: string,
    jobFullName: string,
    buildNumber: number
  ): void {
    const key = uri.toString();
    if (this.activePollers.has(key)) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const client = await this.clientPool.get(instanceId);
        const build = await client.getBuild(jobFullName, buildNumber);
        this.onDidChangeEmitter.fire(uri);

        if (!build.building) {
          this.stopAutoRefresh(uri);
        }
      } catch (err) {
        this.log.debug(`Error during auto-refresh of build log ${key}: ${formatError(err)}`);
      }
    }, this.pollIntervalMs);

    this.activePollers.set(key, timer);
  }

  /**
   * Stops active polling for the given URI.
   */
  stopAutoRefresh(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.activePollers.get(key);
    if (timer) {
      clearInterval(timer);
      this.activePollers.delete(key);
    }
  }

  /**
   * Cancels polling when the document is closed in VS Code.
   */
  handleDidCloseTextDocument(document: vscode.TextDocument): void {
    if (document.uri.scheme === JENKINS_DOCUMENT_SCHEME) {
      this.stopAutoRefresh(document.uri);
    }
  }

  /**
   * Manually refreshes a build log document.
   */
  refresh(instanceId: string, jobFullName: string, buildNumber: number): void {
    this.onDidChangeEmitter.fire(buildBuildLogUri(instanceId, jobFullName, buildNumber));
  }

  /**
   * Streams build log output incrementally into VS Code OutputChannel until the build completes.
   */
  async followBuildLogInOutput(
    instanceId: string,
    jobFullName: string,
    buildNumber: number,
    outputChannel?: vscode.OutputChannel,
    options?: { pollIntervalMs?: number; signal?: AbortSignal }
  ): Promise<vscode.Disposable> {
    const channel =
      outputChannel ?? vscode.window.createOutputChannel('AT Jenkins', { log: true });
    channel.show(true);

    channel.appendLine(
      `=== [${instanceId}] ${jobFullName} #${buildNumber} Console Log ===`
    );

    const client = await this.clientPool.get(instanceId);
    let startOffset = 0;
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;

    const disposable = new vscode.Disposable(() => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    });

    if (options?.signal) {
      options.signal.addEventListener('abort', () => disposable.dispose());
    }

    try {
      const initialLog = await client.getBuildLog(jobFullName, buildNumber, { start: 0 });
      channel.append(initialLog.text);
      startOffset = initialLog.totalBytes;

      const build = await client.getBuild(jobFullName, buildNumber);
      if (!build.building) {
        channel.appendLine(
          `=== Build finished with result: ${build.result ?? 'UNKNOWN'} ===`
        );
        return disposable;
      }

      const pollMs = options?.pollIntervalMs ?? this.pollIntervalMs;
      timer = setInterval(async () => {
        if (cancelled) {
          return;
        }
        try {
          const chunk = await client.getBuildLog(jobFullName, buildNumber, {
            start: startOffset
          });
          if (chunk.text) {
            channel.append(chunk.text);
          }
          startOffset = chunk.totalBytes;

          const currentBuild = await client.getBuild(jobFullName, buildNumber);
          if (!currentBuild.building) {
            channel.appendLine(
              `=== Build finished with result: ${currentBuild.result ?? 'UNKNOWN'} ===`
            );
            disposable.dispose();
          }
        } catch (err) {
          this.log.error(
            `Error following build log for ${instanceId}/${jobFullName} #${buildNumber}: ${formatError(err)}`
          );
        }
      }, pollMs);
    } catch (err) {
      channel.appendLine(`Failed to fetch build log: ${formatError(err)}`);
    }

    return disposable;
  }

  dispose(): void {
    for (const timer of this.activePollers.values()) {
      clearInterval(timer);
    }
    this.activePollers.clear();
    this.onDidChangeEmitter.dispose();
  }
}
