import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { JenkinsBuildFollowService, notifyBuildCompletion } from '../../src/commands/buildFollow';
import type { JenkinsClient } from '../../src/jenkins/JenkinsClient';
import type { JenkinsStatusBarManager } from '../../src/utils/statusBar';

describe('notifyBuildCompletion', () => {
  it('offers log and Jenkins actions after a successful build', async () => {
    const infoSpy = vi
      .spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValue('View Log' as never);
    const execSpy = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    await notifyBuildCompletion('app', {
      number: 7,
      result: 'SUCCESS',
      duration: 45000,
      url: 'https://ci.example.com/job/app/7/',
      building: false
    });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('succeeded'),
      'View Log',
      'Open in Jenkins'
    );
    expect(execSpy).toHaveBeenCalledWith('atJenkins.openBuildLog', {
      jobFullName: 'app',
      buildNumber: 7
    });
  });

  it('uses an error toast for failed builds', async () => {
    const errorSpy = vi
      .spyOn(vscode.window, 'showErrorMessage')
      .mockResolvedValue(undefined as never);

    await notifyBuildCompletion('app', {
      number: 8,
      result: 'FAILURE',
      duration: 12000,
      url: '',
      building: false
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      'View Log',
      'Open in Jenkins'
    );
  });
});

describe('JenkinsBuildFollowService', () => {
  it('follows a queue item until the build finishes and updates the status bar', async () => {
    const client = {
      getQueueItem: vi
        .fn()
        .mockResolvedValueOnce({ cancelled: false })
        .mockResolvedValueOnce({ executable: { number: 11 } }),
      getBuild: vi
        .fn()
        .mockResolvedValueOnce({ number: 11, building: true, timestamp: Date.now() - 5000, duration: 0 })
        .mockResolvedValueOnce({
          number: 11,
          building: false,
          result: 'SUCCESS',
          duration: 8000,
          url: 'https://ci.example.com/job/app/11/'
        }),
      getJob: vi.fn()
    };
    const statusBar = {
      setBuildingStatus: vi.fn(),
      clearBuildingStatus: vi.fn()
    };
    const jobsTreeProvider = { refresh: vi.fn() };
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

    const service = new JenkinsBuildFollowService({
      pollIntervalMs: 1,
      maxPolls: 10,
      sleep: async () => undefined
    });

    await service.follow({
      client: client as unknown as JenkinsClient,
      jobFullName: 'app',
      queueUrl: 'https://ci.example.com/queue/item/3/',
      statusBar: statusBar as unknown as JenkinsStatusBarManager,
      jobsTreeProvider: jobsTreeProvider as never
    });

    expect(client.getQueueItem).toHaveBeenCalled();
    expect(statusBar.setBuildingStatus).toHaveBeenCalled();
    expect(statusBar.clearBuildingStatus).toHaveBeenCalled();
    expect(jobsTreeProvider.refresh).toHaveBeenCalled();
  });
});
