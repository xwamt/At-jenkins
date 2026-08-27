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

/** UI virtual docs show a larger tail than MCP and always annotate truncation. */
export const UI_LOG_TAIL_BYTES = 2 * 1024 * 1024;
/** Per-poll chunk size for Output follow (advance via endByte, never skip). */
export const OUTPUT_FOLLOW_CHUNK_BYTES = 256 * 1024;

export interface BuildLogDocumentProviderOptions {
  pollIntervalMs?: number;
  log?: AtJenkinsLog;
  uiLogTailBytes?: number;
}

export class BuildLogDocumentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange: vscode.Event<vscode.Uri> = this.onDidChangeEmitter.event;

  private readonly activePollers = new Map<string, NodeJS.Timeout>();
  private readonly pollFailures = new Map<string, number>();
  private readonly pollIntervalMs: number;
  private readonly uiLogTailBytes: number;
  private readonly log: AtJenkinsLog;
  private readonly maxConsecutiveFailures = 3;

  constructor(
    private readonly clientPool: JenkinsClientPool,
    options?: BuildLogDocumentProviderOptions
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 3000;
    this.uiLogTailBytes = options?.uiLogTailBytes ?? UI_LOG_TAIL_BYTES;
    this.log = asRedactedLog(options?.log ?? noopLog);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const target = parseJenkinsDocumentUri(uri);
    if (!target || target.type !== 'log') {
      return `// ${t('Invalid Jenkins build log URI.')}\n`;
    }

    try {
      const client = await this.clientPool.get(target.instanceId);
      const logResult = await client.getBuildLog(target.jobFullName, target.buildNumber, {
        tailBytes: this.uiLogTailBytes
      });

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

      if (logResult.truncated) {
        const notice = t(
          'Log truncated: showing last {shown} of {total} bytes (increase limit or use Output follow for streaming).',
          {
            shown: String(logResult.endByte - logResult.startByte),
            total: String(logResult.totalBytes)
          }
        );
        return `// ${notice}\n\n${logResult.text}`;
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

    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        const client = await this.clientPool.get(instanceId);
        const build = await client.getBuild(jobFullName, buildNumber);
        this.pollFailures.set(key, 0);
        this.onDidChangeEmitter.fire(uri);

        if (!build.building) {
          this.stopAutoRefresh(uri);
        }
      } catch (err) {
        const failures = (this.pollFailures.get(key) ?? 0) + 1;
        this.pollFailures.set(key, failures);
        this.log.debug(`Error during auto-refresh of build log ${key}: ${formatError(err)}`);
        if (failures >= this.maxConsecutiveFailures) {
          this.log.error(
            `Stopping build log auto-refresh for ${key} after ${failures} consecutive failures`
          );
          this.stopAutoRefresh(uri);
        }
      } finally {
        inFlight = false;
      }
    }, this.pollIntervalMs);

    this.activePollers.set(key, timer);
  }

  stopAutoRefresh(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.activePollers.get(key);
    if (timer) {
      clearInterval(timer);
      this.activePollers.delete(key);
    }
    this.pollFailures.delete(key);
  }

  handleDidCloseTextDocument(document: vscode.TextDocument): void {
    if (document.uri.scheme === JENKINS_DOCUMENT_SCHEME) {
      this.stopAutoRefresh(document.uri);
    }
  }

  refresh(instanceId: string, jobFullName: string, buildNumber: number): void {
    this.onDidChangeEmitter.fire(buildBuildLogUri(instanceId, jobFullName, buildNumber));
  }

  /**
   * Streams build log into OutputChannel. Advances with `endByte` and drains
   * `hasMore` chunks so growth larger than one chunk never skips bytes.
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
      t('=== [{instance}] {job} #{build} Console Log ===', {
        instance: instanceId,
        job: jobFullName,
        build: buildNumber
      })
    );

    const client = await this.clientPool.get(instanceId);
    let startOffset = 0;
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    let inFlight = false;

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

    const appendFromOffset = async (): Promise<boolean> => {
      while (!cancelled) {
        const chunk = await client.getBuildLog(jobFullName, buildNumber, {
          start: startOffset,
          maxBytes: OUTPUT_FOLLOW_CHUNK_BYTES
        });
        if (chunk.text) {
          channel.append(chunk.text);
        }
        startOffset = chunk.endByte;
        if (!chunk.hasMore) {
          break;
        }
      }
      if (cancelled) {
        return false;
      }
      const currentBuild = await client.getBuild(jobFullName, buildNumber);
      if (!currentBuild.building) {
        channel.appendLine(
          t('=== Build finished with result: {result} ===', {
            result: currentBuild.result ?? t('Unknown')
          })
        );
        return false;
      }
      return true;
    };

    try {
      const stillBuilding = await appendFromOffset();
      if (!stillBuilding) {
        return disposable;
      }

      const pollMs = options?.pollIntervalMs ?? this.pollIntervalMs;
      let consecutiveFailures = 0;
      timer = setInterval(async () => {
        if (cancelled || inFlight) {
          return;
        }
        inFlight = true;
        try {
          const stillRunning = await appendFromOffset();
          consecutiveFailures = 0;
          if (!stillRunning) {
            disposable.dispose();
          }
        } catch (err) {
          consecutiveFailures += 1;
          this.log.error(
            `Error following build log for ${instanceId}/${jobFullName} #${buildNumber}: ${formatError(err)}`
          );
          if (consecutiveFailures >= 3) {
            channel.appendLine(t('=== Stopped following after repeated errors ==='));
            disposable.dispose();
          }
        } finally {
          inFlight = false;
        }
      }, pollMs);
    } catch (err) {
      channel.appendLine(
        t('Failed to fetch build log: {error}', { error: formatError(err) })
      );
    }

    return disposable;
  }

  dispose(): void {
    for (const timer of this.activePollers.values()) {
      clearInterval(timer);
    }
    this.activePollers.clear();
    this.pollFailures.clear();
    this.onDidChangeEmitter.dispose();
  }
}
