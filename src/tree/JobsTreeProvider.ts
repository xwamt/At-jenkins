import * as vscode from 'vscode';
import type { JenkinsInstanceConfigManager } from '../config/JenkinsInstanceConfigManager';
import { t } from '../i18n/t';
import type { JenkinsClientPool } from '../jenkins/JenkinsClientPool';
import type { BuildSummary, JobSummary } from '../jenkins/types';
import { formatError } from '../utils/errors';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import { buildId, buildsMoreId, folderId, jobId } from './treeIds';

export const DEFAULT_BUILD_PAGE_SIZE = 10;

export class JenkinsNoActiveInstanceTreeItem extends vscode.TreeItem {
  constructor() {
    super(t('No active controller selected'), vscode.TreeItemCollapsibleState.None);
    this.id = 'atJenkins.noActiveInstance';
    this.contextValue = 'jenkinsNoActiveInstance';
    this.iconPath = new vscode.ThemeIcon('info');
    this.tooltip = t('Select a Jenkins controller to view its jobs and builds.');
    this.command = {
      command: 'atJenkins.setActiveInstance',
      title: t('Select Active Controller')
    };
  }
}

export class JenkinsErrorTreeItem extends vscode.TreeItem {
  constructor(public readonly errorMessage: string) {
    super(errorMessage, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'jenkinsError';
    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    this.tooltip = errorMessage;
  }
}

export class JenkinsFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly folder: JobSummary,
    public readonly instanceId: string
  ) {
    super(folder.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = folderId(folder.fullName);
    this.contextValue = 'jenkinsFolder';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = buildFolderTooltip(folder);
  }
}

export class JenkinsJobTreeItem extends vscode.TreeItem {
  constructor(
    public readonly job: JobSummary,
    public readonly instanceId: string
  ) {
    super(job.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = jobId(job.fullName);
    this.contextValue = resolveJobContextValue(job);
    this.iconPath = getJobIcon(job.color);
    this.tooltip = buildJobTooltip(job);
  }
}

export class JenkinsBuildTreeItem extends vscode.TreeItem {
  constructor(
    public readonly build: BuildSummary,
    public readonly jobFullName: string,
    public readonly instanceId: string
  ) {
    const label = build.displayName || `#${build.number}`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = buildId(jobFullName, build.number);
    this.contextValue = build.building ? 'jenkinsBuild.building' : 'jenkinsBuild';
    this.iconPath = getBuildIcon(build);
    this.description = formatBuildDescription(build);
    this.tooltip = buildBuildTooltip(build, jobFullName);
    this.command = {
      command: 'atJenkins.openBuildLog',
      title: t('Open Build Log'),
      arguments: [this]
    };
  }
}

export class JenkinsBuildsMoreTreeItem extends vscode.TreeItem {
  constructor(
    public readonly jobFullName: string,
    public readonly instanceId: string,
    public readonly currentOffset: number,
    public readonly parentJobItem?: JenkinsJobTreeItem
  ) {
    super(t('Load more builds...'), vscode.TreeItemCollapsibleState.None);
    this.id = buildsMoreId(jobFullName, currentOffset);
    this.contextValue = 'jenkinsBuildsMore';
    this.iconPath = new vscode.ThemeIcon('ellipsis');
    this.tooltip = t('Click to load more builds');
    this.command = {
      command: 'atJenkins.loadMoreBuilds',
      title: t('Load More Builds'),
      arguments: [this]
    };
  }
}

export type JobsTreeItem =
  | JenkinsNoActiveInstanceTreeItem
  | JenkinsErrorTreeItem
  | JenkinsFolderTreeItem
  | JenkinsJobTreeItem
  | JenkinsBuildTreeItem
  | JenkinsBuildsMoreTreeItem;

export interface JobsTreeProviderOptions {
  pageSize?: number;
  log?: AtJenkinsLog;
}

export class JobsTreeProvider implements vscode.TreeDataProvider<JobsTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<JobsTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<JobsTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private readonly jobBuildLimits = new Map<string, number>();
  private readonly pageSize: number;
  private readonly log: AtJenkinsLog;

  constructor(
    private readonly configManager: JenkinsInstanceConfigManager,
    private readonly clientPool: JenkinsClientPool,
    options?: JobsTreeProviderOptions
  ) {
    this.pageSize = options?.pageSize ?? DEFAULT_BUILD_PAGE_SIZE;
    this.log = asRedactedLog(options?.log ?? noopLog);
  }

  refresh(element?: JobsTreeItem): void {
    if (!element) {
      this.jobBuildLimits.clear();
    }
    this._onDidChangeTreeData.fire(element);
  }

  getTreeItem(element: JobsTreeItem): vscode.TreeItem {
    return element;
  }

  getJobBuildLimit(jobFullName: string): number {
    return this.jobBuildLimits.get(jobFullName) ?? this.pageSize;
  }

  setJobBuildLimit(jobFullName: string, limit: number): void {
    this.jobBuildLimits.set(jobFullName, limit);
  }

  loadMoreBuilds(target: JenkinsJobTreeItem | JenkinsBuildsMoreTreeItem | string): void {
    let jobFullName: string;
    let jobItem: JenkinsJobTreeItem | undefined;

    if (target instanceof JenkinsBuildsMoreTreeItem) {
      jobFullName = target.jobFullName;
      jobItem = target.parentJobItem;
    } else if (target instanceof JenkinsJobTreeItem) {
      jobFullName = target.job.fullName;
      jobItem = target;
    } else if (typeof target === 'string') {
      jobFullName = target;
    } else {
      return;
    }

    const current = this.getJobBuildLimit(jobFullName);
    this.setJobBuildLimit(jobFullName, current + this.pageSize);
    this._onDidChangeTreeData.fire(jobItem);
  }

  async getChildren(element?: JobsTreeItem): Promise<JobsTreeItem[]> {
    if (!element) {
      return this.getRootChildren();
    }

    if (element instanceof JenkinsFolderTreeItem) {
      return this.getFolderChildren(element);
    }

    if (element instanceof JenkinsJobTreeItem) {
      return this.getJobChildren(element);
    }

    return [];
  }

  private async getRootChildren(): Promise<JobsTreeItem[]> {
    const activeInstance = await this.configManager.getActiveInstance();
    if (!activeInstance) {
      return [new JenkinsNoActiveInstanceTreeItem()];
    }

    try {
      const client = await this.clientPool.get(activeInstance.id);
      const jobs = await client.listJobs();
      return jobs.map((job) =>
        job.isFolder
          ? new JenkinsFolderTreeItem(job, activeInstance.id)
          : new JenkinsJobTreeItem(job, activeInstance.id)
      );
    } catch (err) {
      this.log.error(`Failed to list root jobs: ${formatError(err)}`);
      return [new JenkinsErrorTreeItem(formatError(err))];
    }
  }

  private async getFolderChildren(element: JenkinsFolderTreeItem): Promise<JobsTreeItem[]> {
    try {
      const client = await this.clientPool.get(element.instanceId);
      const jobs = await client.listJobs(element.folder.fullName);
      return jobs.map((job) =>
        job.isFolder
          ? new JenkinsFolderTreeItem(job, element.instanceId)
          : new JenkinsJobTreeItem(job, element.instanceId)
      );
    } catch (err) {
      this.log.error(`Failed to list jobs in folder '${element.folder.fullName}': ${formatError(err)}`);
      return [new JenkinsErrorTreeItem(formatError(err))];
    }
  }

  private async getJobChildren(element: JenkinsJobTreeItem): Promise<JobsTreeItem[]> {
    try {
      const client = await this.clientPool.get(element.instanceId);
      const limit = this.getJobBuildLimit(element.job.fullName);
      const builds = await client.listBuilds(element.job.fullName, {
        limit: limit + 1,
        offset: 0
      });

      const items: JobsTreeItem[] = [];
      const hasMore = builds.length > limit;
      const displayBuilds = hasMore ? builds.slice(0, limit) : builds;

      for (const build of displayBuilds) {
        items.push(new JenkinsBuildTreeItem(build, element.job.fullName, element.instanceId));
      }

      if (hasMore) {
        items.push(
          new JenkinsBuildsMoreTreeItem(element.job.fullName, element.instanceId, limit, element)
        );
      }

      return items;
    } catch (err) {
      this.log.error(`Failed to list builds for job '${element.job.fullName}': ${formatError(err)}`);
      return [new JenkinsErrorTreeItem(formatError(err))];
    }
  }
}

export function resolveJobContextValue(job: JobSummary): string {
  if (job._class?.includes('WorkflowJob') || job._class?.includes('CpsFlowDefinition')) {
    return 'jenkinsJob.pipeline';
  }
  if (job._class?.includes('FreeStyleProject')) {
    return 'jenkinsJob.freestyle';
  }
  if (job._class && /pipeline/i.test(job._class)) {
    return 'jenkinsJob.pipeline';
  }
  return 'jenkinsJob';
}

export function getJobIcon(color?: string): vscode.ThemeIcon {
  if (!color) {
    return new vscode.ThemeIcon('circle-outline');
  }

  if (color.endsWith('_anime')) {
    return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
  }

  switch (color) {
    case 'blue':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    case 'red':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'yellow':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    case 'aborted':
    case 'grey':
    case 'disabled':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.purple'));
    case 'notbuilt':
      return new vscode.ThemeIcon('circle-outline');
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

export function getBuildIcon(build: BuildSummary): vscode.ThemeIcon {
  if (build.building) {
    return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
  }

  switch (build.result?.toUpperCase()) {
    case 'SUCCESS':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    case 'FAILURE':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'UNSTABLE':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    case 'ABORTED':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.purple'));
    case 'NOT_BUILT':
      return new vscode.ThemeIcon('circle-outline');
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

export function formatDuration(durationMs?: number): string {
  if (durationMs === undefined || durationMs === null || durationMs < 0) {
    return '';
  }
  if (durationMs === 0) {
    return '0s';
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatTimestamp(timestampMs?: number): string {
  if (!timestampMs || timestampMs <= 0) {
    return '';
  }
  return new Date(timestampMs).toLocaleString();
}

function formatBuildDescription(build: BuildSummary): string {
  if (build.building) {
    return t('Building...');
  }
  const parts: string[] = [];
  if (build.duration !== undefined && build.duration > 0) {
    parts.push(formatDuration(build.duration));
  }
  if (build.timestamp) {
    parts.push(formatTimestamp(build.timestamp));
  }
  return parts.join(' • ');
}

function buildFolderTooltip(folder: JobSummary): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown(`**${folder.name}**\n\n`);
  md.appendMarkdown(`- **${t('Full Name')}:** \`${folder.fullName}\`\n`);
  if (folder.url) {
    md.appendMarkdown(`- **URL:** ${folder.url}\n`);
  }
  return md;
}

function buildJobTooltip(job: JobSummary): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown(`**${job.name}**\n\n`);
  md.appendMarkdown(`- **${t('Full Name')}:** \`${job.fullName}\`\n`);
  if (job.color) {
    md.appendMarkdown(`- **${t('Status')}:** ${job.color}\n`);
  }
  if (job._class) {
    md.appendMarkdown(`- **${t('Class')}:** \`${job._class}\`\n`);
  }
  if (job.url) {
    md.appendMarkdown(`- **URL:** ${job.url}\n`);
  }
  return md;
}

function buildBuildTooltip(build: BuildSummary, jobFullName: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  const title = build.displayName || `#${build.number}`;
  md.appendMarkdown(`**${title}** (${jobFullName})\n\n`);
  md.appendMarkdown(
    `- **${t('Status')}:** ${build.building ? t('Building') : build.result || t('Unknown')}\n`
  );
  if (build.timestamp) {
    md.appendMarkdown(`- **${t('Started')}:** ${new Date(build.timestamp).toISOString()}\n`);
  }
  if (build.duration !== undefined && build.duration > 0) {
    md.appendMarkdown(`- **${t('Duration')}:** ${formatDuration(build.duration)}\n`);
  }
  if (build.url) {
    md.appendMarkdown(`- **URL:** ${build.url}\n`);
  }
  return md;
}
