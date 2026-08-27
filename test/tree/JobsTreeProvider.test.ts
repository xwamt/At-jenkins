import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  JenkinsInstanceConfigManager,
  type ExtensionMemento,
  type SecretStore
} from '../../src/config/JenkinsInstanceConfigManager';
import { JenkinsClient } from '../../src/jenkins/JenkinsClient';
import { JenkinsClientPool } from '../../src/jenkins/JenkinsClientPool';
import type { BuildSummary, JobSummary } from '../../src/jenkins/types';
import {
  calculateWeatherScore,
  formatDuration,
  formatJobTypeBadge,
  formatTimestamp,
  getBuildIcon,
  getJobIcon,
  JenkinsBuildsMoreTreeItem,
  JenkinsBuildTreeItem,
  JenkinsErrorTreeItem,
  JenkinsFolderTreeItem,
  JenkinsJobTreeItem,
  JenkinsNoActiveInstanceTreeItem,
  JobsTreeProvider,
  resolveJobContextValue
} from '../../src/tree/JobsTreeProvider';
import { buildId, buildsMoreId, folderId, jobId } from '../../src/tree/treeIds';

function createMemento(): ExtensionMemento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    }
  };
}

function createSecrets(): SecretStore {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key);
    },
    async store(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    }
  };
}

describe('JobsTreeProvider', () => {
  let memento: ExtensionMemento;
  let secrets: SecretStore;
  let configManager: JenkinsInstanceConfigManager;
  let clientPool: JenkinsClientPool;
  let provider: JobsTreeProvider;
  let mockClient: JenkinsClient;

  beforeEach(() => {
    memento = createMemento();
    secrets = createSecrets();
    configManager = new JenkinsInstanceConfigManager(memento, secrets);
    clientPool = new JenkinsClientPool(configManager);

    mockClient = {
      listJobs: vi.fn(),
      listBuilds: vi.fn(),
      getJob: vi.fn(),
      getBuild: vi.fn(),
      getPipelineScript: vi.fn(),
      updatePipelineScript: vi.fn(),
      triggerBuild: vi.fn(),
      stopBuild: vi.fn(),
      getBuildLog: vi.fn(),
      testConnection: vi.fn()
    } as unknown as JenkinsClient;

    vi.spyOn(clientPool, 'get').mockResolvedValue(mockClient);
    provider = new JobsTreeProvider(configManager, clientPool);
  });

  describe('no active instance', () => {
    it('returns a single JenkinsNoActiveInstanceTreeItem when no active instance is configured', async () => {
      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      const item = children[0] as JenkinsNoActiveInstanceTreeItem;
      expect(item).toBeInstanceOf(JenkinsNoActiveInstanceTreeItem);
      expect(item.label).toBe('No active controller selected');
      expect(item.contextValue).toBe('jenkinsNoActiveInstance');
      expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
      expect((item.iconPath as vscode.ThemeIcon).id).toBe('info');
      expect(item.command).toEqual({
        command: 'atJenkins.setActiveInstance',
        title: 'Select Active Controller'
      });
    });
  });

  describe('with active instance', () => {
    let instanceId: string;

    beforeEach(async () => {
      const inst = await configManager.createInstance({
        label: 'Production Jenkins',
        baseUrl: 'https://ci.example.com',
        authMode: 'none'
      });
      instanceId = inst.id;
      await configManager.setActiveInstanceId(instanceId);
    });

    it('returns root jobs and folders from active client', async () => {
      const mockJobs: JobSummary[] = [
        {
          name: 'backend',
          fullName: 'backend',
          url: 'https://ci.example.com/job/backend',
          isFolder: true
        },
        {
          name: 'frontend-build',
          fullName: 'frontend-build',
          url: 'https://ci.example.com/job/frontend-build',
          color: 'blue',
          _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
          isBuildable: true
        },
        {
          name: 'legacy-freestyle',
          fullName: 'legacy-freestyle',
          url: 'https://ci.example.com/job/legacy-freestyle',
          color: 'red',
          _class: 'hudson.model.FreeStyleProject',
          isBuildable: true
        }
      ];

      (mockClient.listJobs as ReturnType<typeof vi.fn>).mockResolvedValue(mockJobs);

      const children = await provider.getChildren();
      expect(clientPool.get).toHaveBeenCalledWith(instanceId);
      expect(mockClient.listJobs).toHaveBeenCalled();
      expect(children).toHaveLength(3);

      // Folder item
      const folderItem = children[0] as JenkinsFolderTreeItem;
      expect(folderItem).toBeInstanceOf(JenkinsFolderTreeItem);
      expect(folderItem.id).toBe(folderId('backend'));
      expect(folderItem.label).toBe('backend');
      expect(folderItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
      expect(folderItem.contextValue).toBe('jenkinsFolder');
      expect((folderItem.iconPath as vscode.ThemeIcon).id).toBe('folder');
      expect((folderItem.tooltip as vscode.MarkdownString).value).toContain('backend');

      // Pipeline job item
      const pipelineItem = children[1] as JenkinsJobTreeItem;
      expect(pipelineItem).toBeInstanceOf(JenkinsJobTreeItem);
      expect(pipelineItem.id).toBe(jobId('frontend-build'));
      expect(pipelineItem.label).toBe('frontend-build');
      expect(pipelineItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
      expect(pipelineItem.contextValue).toBe('jenkinsJob.pipeline');
      expect((pipelineItem.iconPath as vscode.ThemeIcon).id).toBe('pass-filled');

      // Freestyle job item
      const freestyleItem = children[2] as JenkinsJobTreeItem;
      expect(freestyleItem).toBeInstanceOf(JenkinsJobTreeItem);
      expect(freestyleItem.id).toBe(jobId('legacy-freestyle'));
      expect(freestyleItem.label).toBe('legacy-freestyle');
      expect(freestyleItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
      expect(freestyleItem.contextValue).toBe('jenkinsJob.freestyle');
      expect((freestyleItem.iconPath as vscode.ThemeIcon).id).toBe('error');
    });

    it('expands folder to return child jobs', async () => {
      const folderSummary: JobSummary = {
        name: 'backend',
        fullName: 'backend',
        url: 'https://ci.example.com/job/backend',
        isFolder: true
      };
      const folderItem = new JenkinsFolderTreeItem(folderSummary, instanceId);

      const mockChildren: JobSummary[] = [
        {
          name: 'api-service',
          fullName: 'backend/api-service',
          url: 'https://ci.example.com/job/backend/job/api-service',
          color: 'blue_anime',
          _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
          isBuildable: true
        }
      ];

      (mockClient.listJobs as ReturnType<typeof vi.fn>).mockResolvedValue(mockChildren);

      const children = await provider.getChildren(folderItem);
      expect(mockClient.listJobs).toHaveBeenCalledWith('backend');
      expect(children).toHaveLength(1);
      const child = children[0] as JenkinsJobTreeItem;
      expect(child.id).toBe(jobId('backend/api-service'));
      expect(child.label).toBe('api-service');
      expect(child.contextValue).toBe('jenkinsJob.pipeline');
      expect((child.iconPath as vscode.ThemeIcon).id).toBe('sync~spin');
    });

    it('expands job to return first page of builds without sentinel if builds <= limit', async () => {
      const jobSummary: JobSummary = {
        name: 'api-service',
        fullName: 'backend/api-service',
        url: 'https://ci.example.com/job/backend/job/api-service',
        color: 'blue',
        _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
        isBuildable: true
      };
      const jobItem = new JenkinsJobTreeItem(jobSummary, instanceId);

      const mockBuilds: BuildSummary[] = [
        {
          number: 102,
          url: 'https://ci.example.com/job/backend/job/api-service/102',
          result: 'SUCCESS',
          building: false,
          timestamp: 1700000000000,
          duration: 45000,
          displayName: '#102'
        },
        {
          number: 101,
          url: 'https://ci.example.com/job/backend/job/api-service/101',
          result: 'FAILURE',
          building: false,
          timestamp: 1699990000000,
          duration: 120000,
          displayName: '#101'
        },
        {
          number: 100,
          url: 'https://ci.example.com/job/backend/job/api-service/100',
          result: null,
          building: true,
          timestamp: 1699980000000,
          duration: 0,
          displayName: '#100'
        }
      ];

      (mockClient.listBuilds as ReturnType<typeof vi.fn>).mockResolvedValue(mockBuilds);

      const children = await provider.getChildren(jobItem);
      expect(mockClient.listBuilds).toHaveBeenCalledWith('backend/api-service', {
        limit: 11,
        offset: 0
      });
      expect(children).toHaveLength(3);

      const b102 = children[0] as JenkinsBuildTreeItem;
      expect(b102).toBeInstanceOf(JenkinsBuildTreeItem);
      expect(b102.id).toBe(buildId('backend/api-service', 102));
      expect(b102.label).toBe('#102');
      expect(b102.contextValue).toBe('jenkinsBuild');
      expect((b102.iconPath as vscode.ThemeIcon).id).toBe('pass-filled');
      expect(b102.command).toEqual({
        command: 'atJenkins.openBuildLog',
        title: 'Open Build Log',
        arguments: [b102]
      });

      const b101 = children[1] as JenkinsBuildTreeItem;
      expect(b101.id).toBe(buildId('backend/api-service', 101));
      expect(b101.contextValue).toBe('jenkinsBuild');
      expect((b101.iconPath as vscode.ThemeIcon).id).toBe('error');

      const b100 = children[2] as JenkinsBuildTreeItem;
      expect(b100.id).toBe(buildId('backend/api-service', 100));
      expect(b100.contextValue).toBe('jenkinsBuild.building');
      expect((b100.iconPath as vscode.ThemeIcon).id).toBe('sync~spin');
    });

    it('expands job to return first page + sentinel item when more builds exist', async () => {
      const jobSummary: JobSummary = {
        name: 'api-service',
        fullName: 'api-service',
        url: 'https://ci.example.com/job/api-service'
      };
      const jobItem = new JenkinsJobTreeItem(jobSummary, instanceId);

      // Create 11 builds (limit is 10, limit + 1 = 11)
      const mockBuilds: BuildSummary[] = Array.from({ length: 11 }, (_, i) => ({
        number: 100 - i,
        url: `https://ci.example.com/job/api-service/${100 - i}`,
        result: 'SUCCESS',
        building: false,
        timestamp: 1700000000000 - i * 1000,
        duration: 30000,
        displayName: `#${100 - i}`
      }));

      (mockClient.listBuilds as ReturnType<typeof vi.fn>).mockResolvedValue(mockBuilds);

      const children = await provider.getChildren(jobItem);
      expect(children).toHaveLength(11); // 10 builds + 1 sentinel

      const lastItem = children[10] as JenkinsBuildsMoreTreeItem;
      expect(lastItem).toBeInstanceOf(JenkinsBuildsMoreTreeItem);
      expect(lastItem.id).toBe(buildsMoreId('api-service', 10));
      expect(lastItem.label).toBe('Load more builds...');
      expect(lastItem.contextValue).toBe('jenkinsBuildsMore');
      expect((lastItem.iconPath as vscode.ThemeIcon).id).toBe('ellipsis');
      expect(lastItem.command).toEqual({
        command: 'atJenkins.loadMoreBuilds',
        title: 'Load More Builds',
        arguments: [lastItem]
      });
    });

    it('loadMoreBuilds expands page limit and refreshes tree', async () => {
      const jobSummary: JobSummary = {
        name: 'api-service',
        fullName: 'api-service',
        url: 'https://ci.example.com/job/api-service'
      };
      const jobItem = new JenkinsJobTreeItem(jobSummary, instanceId);

      const moreItem = new JenkinsBuildsMoreTreeItem('api-service', instanceId, 10, jobItem);

      let refreshTarget: unknown;
      provider.onDidChangeTreeData((target) => {
        refreshTarget = target;
      });

      // Call loadMoreBuilds with sentinel item
      provider.loadMoreBuilds(moreItem);
      expect(refreshTarget).toBe(jobItem);

      // Next fetch should request limit 20 + 1 = 21
      const mockBuilds: BuildSummary[] = Array.from({ length: 15 }, (_, i) => ({
        number: 100 - i,
        url: `https://ci.example.com/job/api-service/${100 - i}`,
        result: 'SUCCESS',
        building: false,
        timestamp: 1700000000000 - i * 1000,
        duration: 30000,
        displayName: `#${100 - i}`
      }));

      (mockClient.listBuilds as ReturnType<typeof vi.fn>).mockResolvedValue(mockBuilds);

      const children = await provider.getChildren(jobItem);
      expect(mockClient.listBuilds).toHaveBeenCalledWith('api-service', {
        limit: 21,
        offset: 0
      });
      // 15 builds returned, <= 20 limit -> no sentinel
      expect(children).toHaveLength(15);
      expect(children.every((c) => c instanceof JenkinsBuildTreeItem)).toBe(true);
    });

    it('loadMoreBuilds supports passing JenkinsJobTreeItem or string', async () => {
      const jobSummary: JobSummary = {
        name: 'web-app',
        fullName: 'web-app',
        url: 'https://ci.example.com/job/web-app'
      };
      const jobItem = new JenkinsJobTreeItem(jobSummary, instanceId);

      let fired = false;
      provider.onDidChangeTreeData(() => {
        fired = true;
      });

      provider.loadMoreBuilds(jobItem);
      expect(fired).toBe(true);
      expect(provider.getJobBuildLimit('web-app')).toBe(20);

      provider.loadMoreBuilds('web-app');
      expect(provider.getJobBuildLimit('web-app')).toBe(30);
    });

    it('returns JenkinsErrorTreeItem when client call throws', async () => {
      (mockClient.listJobs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network timeout'));

      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      const errorItem = children[0] as JenkinsErrorTreeItem;
      expect(errorItem).toBeInstanceOf(JenkinsErrorTreeItem);
      expect(errorItem.label).toContain('Network timeout');
      expect(errorItem.contextValue).toBe('jenkinsError');
      expect((errorItem.iconPath as vscode.ThemeIcon).id).toBe('error');
    });

    it('leaf items return empty children', async () => {
      const buildSummary: BuildSummary = {
        number: 1,
        url: 'https://ci.example.com/1',
        building: false,
        timestamp: 1000,
        duration: 1000
      };
      const buildItem = new JenkinsBuildTreeItem(buildSummary, 'job1', instanceId);
      expect(await provider.getChildren(buildItem)).toEqual([]);

      const moreItem = new JenkinsBuildsMoreTreeItem('job1', instanceId, 10);
      expect(await provider.getChildren(moreItem)).toEqual([]);

      const noActiveItem = new JenkinsNoActiveInstanceTreeItem();
      expect(await provider.getChildren(noActiveItem)).toEqual([]);
    });

    it('getTreeItem returns the item passed to it', () => {
      const item = new JenkinsNoActiveInstanceTreeItem();
      expect(provider.getTreeItem(item)).toBe(item);
    });
  });

  describe('helper functions', () => {
    it('resolveJobContextValue determines correct contextValue', () => {
      expect(
        resolveJobContextValue({
          name: 'p1',
          fullName: 'p1',
          url: '',
          _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob'
        })
      ).toBe('jenkinsJob.pipeline');

      expect(
        resolveJobContextValue({
          name: 'f1',
          fullName: 'f1',
          url: '',
          _class: 'hudson.model.FreeStyleProject'
        })
      ).toBe('jenkinsJob.freestyle');

      expect(
        resolveJobContextValue({
          name: 'm1',
          fullName: 'm1',
          url: '',
          _class: 'hudson.maven.MavenModuleSet'
        })
      ).toBe('jenkinsJob');

      expect(
        resolveJobContextValue({
          name: 'u1',
          fullName: 'u1',
          url: ''
        })
      ).toBe('jenkinsJob');
    });

    it('formatJobTypeBadge returns correct badge tag based on job class', () => {
      expect(
        formatJobTypeBadge({
          name: 'p1',
          fullName: 'p1',
          url: '',
          _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob'
        })
      ).toBe('[Pipeline]');

      expect(
        formatJobTypeBadge({
          name: 'f1',
          fullName: 'f1',
          url: '',
          _class: 'hudson.model.FreeStyleProject'
        })
      ).toBe('[Freestyle]');

      expect(
        formatJobTypeBadge({
          name: 'mb1',
          fullName: 'mb1',
          url: '',
          isMultibranch: true
        })
      ).toBe('[Multibranch]');

      expect(
        formatJobTypeBadge({
          name: 'other',
          fullName: 'other',
          url: ''
        })
      ).toBeUndefined();
    });

    it('getJobIcon maps job color to ThemeIcon', () => {
      expect(getJobIcon('blue').id).toBe('pass-filled');
      expect(getJobIcon('red').id).toBe('error');
      expect(getJobIcon('yellow').id).toBe('warning');
      expect(getJobIcon('aborted').id).toBe('circle-slash');
      expect(getJobIcon('disabled').id).toBe('circle-slash');
      expect(getJobIcon('blue_anime').id).toBe('sync~spin');
      expect(getJobIcon('notbuilt').id).toBe('circle-outline');
      expect(getJobIcon(undefined).id).toBe('circle-outline');
    });

    it('getBuildIcon maps build status to ThemeIcon', () => {
      expect(getBuildIcon({ number: 1, url: '', building: true, timestamp: 0, duration: 0 }).id).toBe(
        'sync~spin'
      );
      expect(
        getBuildIcon({
          number: 1,
          url: '',
          building: false,
          result: 'SUCCESS',
          timestamp: 0,
          duration: 0
        }).id
      ).toBe('pass-filled');
      expect(
        getBuildIcon({
          number: 1,
          url: '',
          building: false,
          result: 'FAILURE',
          timestamp: 0,
          duration: 0
        }).id
      ).toBe('error');
      expect(
        getBuildIcon({
          number: 1,
          url: '',
          building: false,
          result: 'UNSTABLE',
          timestamp: 0,
          duration: 0
        }).id
      ).toBe('warning');
      expect(
        getBuildIcon({
          number: 1,
          url: '',
          building: false,
          result: 'ABORTED',
          timestamp: 0,
          duration: 0
        }).id
      ).toBe('circle-slash');
      expect(
        getBuildIcon({
          number: 1,
          url: '',
          building: false,
          result: 'NOT_BUILT',
          timestamp: 0,
          duration: 0
        }).id
      ).toBe('circle-outline');
    });

    it('calculateWeatherScore computes weather icon and stability based on recent builds', () => {
      // 100% success -> ☀️
      const allSuccess: BuildSummary[] = Array.from({ length: 5 }, (_, i) => ({
        number: i + 1,
        url: '',
        result: 'SUCCESS',
        building: false,
        timestamp: 0,
        duration: 1000
      }));
      const weather1 = calculateWeatherScore(allSuccess);
      expect(weather1?.icon).toBe('☀️');
      expect(weather1?.score).toBe(100);

      // 80% success -> ⛅
      const fourOfFive: BuildSummary[] = [
        ...allSuccess.slice(0, 4),
        { number: 5, url: '', result: 'FAILURE', building: false, timestamp: 0, duration: 1000 }
      ];
      const weather2 = calculateWeatherScore(fourOfFive);
      expect(weather2?.icon).toBe('⛅');
      expect(weather2?.score).toBe(80);

      // 40% success -> 🌧️
      const twoOfFive: BuildSummary[] = [
        ...allSuccess.slice(0, 2),
        { number: 3, url: '', result: 'FAILURE', building: false, timestamp: 0, duration: 1000 },
        { number: 4, url: '', result: 'FAILURE', building: false, timestamp: 0, duration: 1000 },
        { number: 5, url: '', result: 'FAILURE', building: false, timestamp: 0, duration: 1000 }
      ];
      const weather3 = calculateWeatherScore(twoOfFive);
      expect(weather3?.icon).toBe('🌧️');
      expect(weather3?.score).toBe(40);

      // 0% success -> ⛈️
      const allFailure: BuildSummary[] = Array.from({ length: 5 }, (_, i) => ({
        number: i + 1,
        url: '',
        result: 'FAILURE',
        building: false,
        timestamp: 0,
        duration: 1000
      }));
      const weather4 = calculateWeatherScore(allFailure);
      expect(weather4?.icon).toBe('⛈️');
      expect(weather4?.score).toBe(0);

      // Empty builds -> undefined
      expect(calculateWeatherScore([])).toBeUndefined();
    });

    it('formatDuration formats milliseconds into human-readable strings', () => {
      expect(formatDuration(undefined)).toBe('');
      expect(formatDuration(0)).toBe('0s');
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(45000)).toBe('45s');
      expect(formatDuration(125000)).toBe('2m 5s');
      expect(formatDuration(3600000)).toBe('1h');
      expect(formatDuration(3660000)).toBe('1h 1m');
    });

    it('formatTimestamp formats timestamps nicely', () => {
      expect(formatTimestamp(undefined)).toBe('');
      expect(formatTimestamp(0)).toBe('');
      expect(formatTimestamp(1700000000000)).toBeTruthy();
    });
  });
});
