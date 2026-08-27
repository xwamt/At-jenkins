import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  registerBuildCommands,
  stopBuildHandler,
  triggerBuildHandler,
  type BuildCommandsContext
} from '../../src/commands/buildCommands';
import { clearRecentParamsCache } from '../../src/commands/recentParams';
import type { JenkinsInstanceConfigManager } from '../../src/config/JenkinsInstanceConfigManager';
import type { JenkinsInstanceConfig } from '../../src/config/schema';
import { t } from '../../src/i18n/t';
import type { JenkinsClient } from '../../src/jenkins/JenkinsClient';
import type { JenkinsClientPool } from '../../src/jenkins/JenkinsClientPool';
import type { BuildSummary, JobDetail, JobSummary } from '../../src/jenkins/types';
import {
  JenkinsBuildTreeItem,
  JenkinsJobTreeItem,
  type JobsTreeProvider
} from '../../src/tree/JobsTreeProvider';

describe('buildCommands', () => {
  let mockClient: {
    config: JenkinsInstanceConfig;
    getJob: ReturnType<typeof vi.fn>;
    getBuild: ReturnType<typeof vi.fn>;
    triggerBuild: ReturnType<typeof vi.fn>;
    stopBuild: ReturnType<typeof vi.fn>;
  };
  let mockClientPool: {
    get: ReturnType<typeof vi.fn>;
  };
  let mockConfigManager: {
    getInstance: ReturnType<typeof vi.fn>;
    getActiveInstanceId: ReturnType<typeof vi.fn>;
    getActiveInstance: ReturnType<typeof vi.fn>;
  };
  let mockJobsTreeProvider: {
    refresh: ReturnType<typeof vi.fn>;
  };
  let context: BuildCommandsContext;

  const instanceConfig: JenkinsInstanceConfig = {
    id: 'inst-1',
    label: 'Main Controller',
    baseUrl: 'https://jenkins.example.com',
    authMode: 'none',
    verifyTls: true,
    readOnly: false,
    allowBackgroundAccess: true,
    createdAt: 100,
    updatedAt: 100
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearRecentParamsCache();
    mockClient = {
      config: { ...instanceConfig },
      getJob: vi.fn(),
      getBuild: vi.fn().mockResolvedValue({
        number: 42,
        building: true,
        result: null,
        url: 'https://jenkins.example.com/job/x/42/',
        timestamp: Date.now(),
        duration: 0
      }),
      triggerBuild: vi.fn(),
      stopBuild: vi.fn()
    };

    mockClientPool = {
      get: vi.fn().mockResolvedValue(mockClient as unknown as JenkinsClient)
    };

    mockConfigManager = {
      getInstance: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'inst-1') {
          return mockClient.config;
        }
        return undefined;
      }),
      getActiveInstanceId: vi.fn().mockResolvedValue('inst-1'),
      getActiveInstance: vi.fn().mockImplementation(async () => mockClient.config)
    };

    mockJobsTreeProvider = {
      refresh: vi.fn()
    };

    context = {
      configManager: mockConfigManager as unknown as JenkinsInstanceConfigManager,
      clientPool: mockClientPool as unknown as JenkinsClientPool,
      jobsTreeProvider: mockJobsTreeProvider as unknown as JobsTreeProvider
    };

    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined as never);
  });

  describe('triggerBuildHandler', () => {
    const simpleJobDetail: JobDetail = {
      name: 'deploy-app',
      fullName: 'deploy-app',
      url: 'https://jenkins.example.com/job/deploy-app',
      buildable: true
    };

    it('refuses trigger when instance is readOnly', async () => {
      mockClient.config = { ...instanceConfig, readOnly: true };

      const result = await triggerBuildHandler(context, 'deploy-app');

      expect(result).toBe(false);
      expect(mockClient.triggerBuild).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('is read-only')
      );
    });

    it('confirms before triggerBuild with no parameters', async () => {
      mockClient.getJob.mockResolvedValue(simpleJobDetail);
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Trigger Build') as never);
      mockClient.triggerBuild.mockResolvedValue({ queueUrl: 'https://jenkins.example.com/queue/item/1' });

      const result = await triggerBuildHandler(context, 'deploy-app');

      expect(result).toBe(true);
      expect(mockClientPool.get).toHaveBeenCalledWith('inst-1');
      expect(mockClient.getJob).toHaveBeenCalledWith('deploy-app');
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('deploy-app'),
        { modal: true },
        t('Trigger Build'),
        t('Cancel')
      );
      expect(mockClient.triggerBuild).toHaveBeenCalledWith('deploy-app', undefined);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('deploy-app'),
        t('Open Job Summary'),
        t('Open in Jenkins')
      );
      expect(mockJobsTreeProvider.refresh).toHaveBeenCalledWith();
    });

    it('aborts trigger if user declines confirmation', async () => {
      mockClient.getJob.mockResolvedValue(simpleJobDetail);
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Cancel') as never);

      const result = await triggerBuildHandler(context, 'deploy-app');

      expect(result).toBe(false);
      expect(mockClient.triggerBuild).not.toHaveBeenCalled();
      expect(mockJobsTreeProvider.refresh).not.toHaveBeenCalled();
    });

    it('prompts parameters and calls triggerBuild with parameters', async () => {
      const parameterizedJobDetail: JobDetail = {
        name: 'release-job',
        fullName: 'release-job',
        url: 'https://jenkins.example.com/job/release-job',
        parameters: [
          {
            name: 'ENVIRONMENT',
            type: 'ChoiceParameterDefinition',
            choices: ['staging', 'production'],
            defaultValue: 'staging',
            description: 'Target environment'
          },
          {
            name: 'DRY_RUN',
            type: 'BooleanParameterDefinition',
            defaultValue: true,
            description: 'Perform dry run only'
          },
          {
            name: 'VERSION',
            type: 'StringParameterDefinition',
            defaultValue: 'v1.0.0',
            description: 'Release version tag'
          },
          {
            name: 'AUTH_SECRET',
            type: 'PasswordParameterDefinition',
            defaultValue: '',
            description: 'Secret token'
          }
        ]
      };

      mockClient.getJob.mockResolvedValue(parameterizedJobDetail);

      // Mock sequential prompt answers
      const quickPickSpy = vi.spyOn(vscode.window, 'showQuickPick')
        .mockResolvedValueOnce({ label: 'production' } as never) // ENVIRONMENT choice
        .mockResolvedValueOnce({ label: 'false' } as never);     // DRY_RUN boolean

      const inputBoxSpy = vi.spyOn(vscode.window, 'showInputBox')
        .mockResolvedValueOnce('v2.5.0' as never)               // VERSION string
        .mockResolvedValueOnce('my-secret-pw' as never);        // AUTH_SECRET password

      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Trigger Build') as never);
      mockClient.triggerBuild.mockResolvedValue({ queueUrl: 'https://jenkins.example.com/queue/item/2' });

      const result = await triggerBuildHandler(context, 'release-job');

      expect(result).toBe(true);
      expect(quickPickSpy).toHaveBeenCalledTimes(2);
      expect(inputBoxSpy).toHaveBeenCalledTimes(2);

      // Verify password option passed to inputBox
      expect(inputBoxSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          password: true
        })
      );

      expect(mockClient.triggerBuild).toHaveBeenCalledWith('release-job', {
        ENVIRONMENT: 'production',
        DRY_RUN: false,
        VERSION: 'v2.5.0',
        AUTH_SECRET: 'my-secret-pw'
      });
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('release-job'),
        t('Open Job Summary'),
        t('Open in Jenkins')
      );
    });

    it('uses previous parameters as default values on subsequent trigger for the same job', async () => {
      const paramJobDetail: JobDetail = {
        name: 'param-memory-job',
        fullName: 'param-memory-job',
        url: 'https://jenkins.example.com/job/param-memory-job',
        parameters: [
          {
            name: 'BRANCH',
            type: 'StringParameterDefinition',
            defaultValue: 'main',
            description: 'Git branch'
          }
        ]
      };

      mockClient.getJob.mockResolvedValue(paramJobDetail);
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Trigger Build') as never);

      const inputSpy = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('feature/login' as never);
      await triggerBuildHandler(context, 'param-memory-job');

      vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValueOnce({
        label: t('Use recent parameters')
      } as never);
      mockClient.triggerBuild.mockClear();
      await triggerBuildHandler(context, 'param-memory-job');

      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(mockClient.triggerBuild).toHaveBeenCalledWith('param-memory-job', {
        BRANCH: 'feature/login'
      });
    });

    it('aborts cleanly if user cancels parameter prompt (Choice)', async () => {
      mockClient.getJob.mockResolvedValue({
        name: 'param-job',
        fullName: 'param-job',
        url: '',
        parameters: [
          {
            name: 'ENV',
            type: 'ChoiceParameterDefinition',
            choices: ['dev', 'prod']
          }
        ]
      });

      vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);

      const result = await triggerBuildHandler(context, 'param-job');

      expect(result).toBe(false);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockClient.triggerBuild).not.toHaveBeenCalled();
    });

    it('aborts cleanly if user cancels parameter prompt (InputBox)', async () => {
      mockClient.getJob.mockResolvedValue({
        name: 'param-job',
        fullName: 'param-job',
        url: '',
        parameters: [
          {
            name: 'BRANCH',
            type: 'StringParameterDefinition',
            defaultValue: 'main'
          }
        ]
      });

      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined as never);

      const result = await triggerBuildHandler(context, 'param-job');

      expect(result).toBe(false);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockClient.triggerBuild).not.toHaveBeenCalled();
    });

    it('handles tree item target and refreshes the tree item', async () => {
      const jobSummary: JobSummary = {
        name: 'folder/frontend',
        fullName: 'folder/frontend',
        url: '',
        isBuildable: true
      };
      const treeItem = new JenkinsJobTreeItem(jobSummary, 'inst-1');

      mockClient.getJob.mockResolvedValue({
        name: 'frontend',
        fullName: 'folder/frontend',
        url: ''
      });
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Trigger Build') as never);
      mockClient.triggerBuild.mockResolvedValue({});

      const result = await triggerBuildHandler(context, treeItem);

      expect(result).toBe(true);
      expect(mockClientPool.get).toHaveBeenCalledWith('inst-1');
      expect(mockClient.getJob).toHaveBeenCalledWith('folder/frontend');
      expect(mockClient.triggerBuild).toHaveBeenCalledWith('folder/frontend', undefined);
      expect(mockJobsTreeProvider.refresh).toHaveBeenCalledWith(treeItem);
    });

    it('returns false and shows message when no active instance is selected', async () => {
      mockConfigManager.getActiveInstanceId.mockResolvedValue(undefined);

      const result = await triggerBuildHandler(context, 'some-job');

      expect(result).toBe(false);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('No active Jenkins controller selected.')
      );
      expect(mockClientPool.get).not.toHaveBeenCalled();
    });

    it('shows error notification when client throws', async () => {
      mockClient.getJob.mockRejectedValue(new Error('Jenkins 503 Service Unavailable'));

      const result = await triggerBuildHandler(context, 'deploy-app');

      expect(result).toBe(false);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Jenkins 503 Service Unavailable')
      );
    });
  });

  describe('stopBuildHandler', () => {
    const buildSummary: BuildSummary = {
      number: 42,
      url: 'https://jenkins.example.com/job/deploy-app/42',
      building: true,
      timestamp: 1000,
      duration: 5000
    };

    it('refuses stop when instance is readOnly', async () => {
      mockClient.config = { ...instanceConfig, readOnly: true };

      const treeItem = new JenkinsBuildTreeItem(buildSummary, 'deploy-app', 'inst-1');
      const result = await stopBuildHandler(context, treeItem);

      expect(result).toBe(false);
      expect(mockClient.stopBuild).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('is read-only')
      );
    });

    it('confirms before stopBuild and triggers stop', async () => {
      const treeItem = new JenkinsBuildTreeItem(buildSummary, 'deploy-app', 'inst-1');
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Stop Build') as never);
      mockClient.stopBuild.mockResolvedValue(undefined);

      const result = await stopBuildHandler(context, treeItem);

      expect(result).toBe(true);
      expect(mockClientPool.get).toHaveBeenCalledWith('inst-1');
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('#42'),
        { modal: true },
        t('Stop Build'),
        t('Cancel')
      );
      expect(mockClient.stopBuild).toHaveBeenCalledWith('deploy-app', 42);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('42')
      );
      expect(mockJobsTreeProvider.refresh).toHaveBeenCalled();
    });

    it('aborts stop if user declines confirmation', async () => {
      const treeItem = new JenkinsBuildTreeItem(buildSummary, 'deploy-app', 'inst-1');
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Cancel') as never);

      const result = await stopBuildHandler(context, treeItem);

      expect(result).toBe(false);
      expect(mockClient.stopBuild).not.toHaveBeenCalled();
      expect(mockJobsTreeProvider.refresh).not.toHaveBeenCalled();
    });

    it('refuses or ignores stop if tree item is not building', async () => {
      const completedBuild: BuildSummary = {
        ...buildSummary,
        building: false,
        result: 'SUCCESS'
      };
      const treeItem = new JenkinsBuildTreeItem(completedBuild, 'deploy-app', 'inst-1');

      const result = await stopBuildHandler(context, treeItem);

      expect(result).toBe(false);
      expect(mockClient.stopBuild).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('supports object argument target and resolves active instance', async () => {
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Stop Build') as never);
      mockClient.stopBuild.mockResolvedValue(undefined);

      const result = await stopBuildHandler(context, {
        jobFullName: 'test-job',
        buildNumber: 15
      });

      expect(result).toBe(true);
      expect(mockConfigManager.getActiveInstanceId).toHaveBeenCalled();
      expect(mockClient.stopBuild).toHaveBeenCalledWith('test-job', 15);
      expect(mockJobsTreeProvider.refresh).toHaveBeenCalled();
    });

    it('returns false and shows message when no active instance is available', async () => {
      mockConfigManager.getActiveInstanceId.mockResolvedValue(undefined);

      const result = await stopBuildHandler(context, {
        jobFullName: 'test-job',
        buildNumber: 15
      });

      expect(result).toBe(false);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('No active Jenkins controller selected.')
      );
      expect(mockClientPool.get).not.toHaveBeenCalled();
    });

    it('shows error notification when client stopBuild throws', async () => {
      const treeItem = new JenkinsBuildTreeItem(buildSummary, 'deploy-app', 'inst-1');
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Stop Build') as never);
      mockClient.stopBuild.mockRejectedValue(new Error('Jenkins 403 Forbidden to abort'));

      const result = await stopBuildHandler(context, treeItem);

      expect(result).toBe(false);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Jenkins 403 Forbidden to abort')
      );
    });
  });

  describe('registerBuildCommands', () => {
    it('registers triggerBuild and stopBuild commands', () => {
      const subscriptions: vscode.Disposable[] = [];
      const extensionContext = {
        subscriptions
      } as unknown as vscode.ExtensionContext;

      const registerSpy = vi.spyOn(vscode.commands, 'registerCommand');

      const disposables = registerBuildCommands(extensionContext, context);

      expect(disposables).toHaveLength(2);
      expect(registerSpy).toHaveBeenCalledWith('atJenkins.triggerBuild', expect.any(Function));
      expect(registerSpy).toHaveBeenCalledWith('atJenkins.stopBuild', expect.any(Function));
    });
  });
});
