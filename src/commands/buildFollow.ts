import * as vscode from 'vscode';
import { t } from '../i18n/t';
import type { JenkinsClient } from '../jenkins/JenkinsClient';
import type { BuildDetail } from '../jenkins/types';
import { formatDuration, type JobsTreeProvider } from '../tree/JobsTreeProvider';
import { formatError } from '../utils/errors';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import type { JenkinsStatusBarManager } from '../utils/statusBar';

export interface FollowTriggeredBuildOptions {
  client: JenkinsClient;
  jobFullName: string;
  queueUrl?: string;
  statusBar?: JenkinsStatusBarManager;
  jobsTreeProvider?: JobsTreeProvider;
  log?: AtJenkinsLog;
}

export interface JenkinsBuildFollowServiceOptions {
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function notifyBuildCompletion(
  jobFullName: string,
  build: Pick<BuildDetail, 'number' | 'result' | 'duration' | 'url' | 'building'>
): Promise<void> {
  const duration = formatDuration(build.duration);
  const result = (build.result ?? t('Unknown')).toUpperCase();
  let message: string;
  if (result === 'SUCCESS') {
    message = t('Build #{number} of "{job}" succeeded ({duration}).', {
      number: build.number,
      job: jobFullName,
      duration
    });
  } else if (result === 'FAILURE') {
    message = t('Build #{number} of "{job}" failed ({duration}).', {
      number: build.number,
      job: jobFullName,
      duration
    });
  } else if (result === 'ABORTED') {
    message = t('Build #{number} of "{job}" was aborted ({duration}).', {
      number: build.number,
      job: jobFullName,
      duration
    });
  } else {
    message = t('Build #{number} of "{job}" finished: {result} ({duration}).', {
      number: build.number,
      job: jobFullName,
      result,
      duration
    });
  }

  const viewLog = t('View Log');
  const openJenkins = t('Open in Jenkins');
  const show =
    result === 'FAILURE' || result === 'UNSTABLE'
      ? vscode.window.showErrorMessage
      : vscode.window.showInformationMessage;
  const action = await show(message, viewLog, openJenkins);
  if (action === viewLog) {
    await vscode.commands.executeCommand('atJenkins.openBuildLog', {
      jobFullName,
      buildNumber: build.number
    });
  } else if (action === openJenkins && build.url) {
    await vscode.commands.executeCommand('atJenkins.openInJenkins', { url: build.url });
  }
}

export class JenkinsBuildFollowService implements vscode.Disposable {
  private disposed = false;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options?: JenkinsBuildFollowServiceOptions) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 2000;
    this.maxPolls = options?.maxPolls ?? 150;
    this.sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  dispose(): void {
    this.disposed = true;
  }

  async follow(options: FollowTriggeredBuildOptions): Promise<void> {
    const log = asRedactedLog(options.log ?? noopLog);
    try {
      const buildNumber = await this.resolveBuildNumber(options);
      if (this.disposed || buildNumber === undefined) {
        return;
      }

      const startedAt = Date.now();
      options.statusBar?.setBuildingStatus(options.jobFullName, buildNumber);

      for (let i = 0; i < this.maxPolls && !this.disposed; i++) {
        const build = await options.client.getBuild(options.jobFullName, buildNumber);
        if (!build.building) {
          options.statusBar?.clearBuildingStatus();
          options.jobsTreeProvider?.refresh();
          await notifyBuildCompletion(options.jobFullName, build);
          return;
        }
        const elapsedMs = build.timestamp ? Math.max(0, Date.now() - build.timestamp) : Date.now() - startedAt;
        options.statusBar?.setBuildingStatus(
          options.jobFullName,
          buildNumber,
          formatDuration(elapsedMs)
        );
        await this.sleep(this.pollIntervalMs);
      }
    } catch (error) {
      log.debug(`Build follow ended for ${options.jobFullName}: ${formatError(error)}`);
      options.statusBar?.clearBuildingStatus();
    }
  }

  private async resolveBuildNumber(options: FollowTriggeredBuildOptions): Promise<number | undefined> {
    if (options.queueUrl) {
      for (let i = 0; i < this.maxPolls && !this.disposed; i++) {
        try {
          const item = await options.client.getQueueItem(options.queueUrl);
          if (item.cancelled) {
            return undefined;
          }
          if (typeof item.executable?.number === 'number') {
            return item.executable.number;
          }
        } catch {
          // Queue item 404s after it leaves the queue; fall through to lastBuild.
          break;
        }
        await this.sleep(this.pollIntervalMs);
      }
    }

    const job = await options.client.getJob(options.jobFullName);
    if (job.lastBuild?.building) {
      return job.lastBuild.number;
    }
    if (job.lastBuild && !job.lastBuild.building) {
      await notifyBuildCompletion(options.jobFullName, job.lastBuild);
    }
    return undefined;
  }
}
