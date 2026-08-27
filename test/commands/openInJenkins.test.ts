import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  isSafeJenkinsWebUrl,
  joinJenkinsWebUrl,
  openInJenkinsHandler,
  resolveJenkinsWebUrl
} from '../../src/commands/openInJenkins';
import type { JenkinsInstanceConfig } from '../../src/config/schema';
import { buildBuildLogUri, buildJobSummaryUri } from '../../src/document/uri';
import { JenkinsInstanceTreeItem } from '../../src/tree/InstancesTreeProvider';
import { JenkinsBuildTreeItem, JenkinsJobTreeItem } from '../../src/tree/JobsTreeProvider';

const instance: JenkinsInstanceConfig = {
  id: 'inst-1',
  label: 'Prod',
  baseUrl: 'https://ci.example.com/jenkins',
  authMode: 'none',
  verifyTls: true,
  readOnly: false,
  allowBackgroundAccess: false,
  createdAt: 1,
  updatedAt: 1
};

describe('openInJenkins', () => {
  it('joins controller base URLs without duplicating slashes', () => {
    expect(joinJenkinsWebUrl('https://ci.example.com/jenkins/', '/job/app/')).toBe(
      'https://ci.example.com/jenkins/job/app/'
    );
  });

  it('resolves URLs from tree items', async () => {
    const instanceItem = new JenkinsInstanceTreeItem(instance, true);
    expect(await resolveJenkinsWebUrl(instanceItem)).toBe('https://ci.example.com/jenkins');

    const jobItem = new JenkinsJobTreeItem(
      {
        name: 'app',
        fullName: 'app',
        url: 'https://ci.example.com/jenkins/job/app/'
      },
      'inst-1'
    );
    expect(await resolveJenkinsWebUrl(jobItem)).toBe('https://ci.example.com/jenkins/job/app/');

    const buildItem = new JenkinsBuildTreeItem(
      {
        number: 8,
        url: 'https://ci.example.com/jenkins/job/app/8/',
        building: false,
        timestamp: 1,
        duration: 1,
        result: 'SUCCESS'
      },
      'app',
      'inst-1'
    );
    expect(await resolveJenkinsWebUrl(buildItem)).toBe('https://ci.example.com/jenkins/job/app/8/');
  });

  it('resolves virtual document URIs through the instance base URL', async () => {
    const configManager = {
      getInstance: vi.fn().mockResolvedValue(instance)
    };
    const logUri = buildBuildLogUri('inst-1', 'folder/app', 4);
    expect(await resolveJenkinsWebUrl(logUri, configManager as never)).toBe(
      'https://ci.example.com/jenkins/job/folder/job/app/4/console'
    );
    const summaryUri = buildJobSummaryUri('inst-1', 'folder/app');
    expect(await resolveJenkinsWebUrl(summaryUri, configManager as never)).toBe(
      'https://ci.example.com/jenkins/job/folder/job/app/'
    );
  });

  it('opens the resolved URL externally', async () => {
    const openSpy = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true as never);
    const ok = await openInJenkinsHandler({ url: 'https://ci.example.com/job/app/' });
    expect(ok).toBe(true);
    expect(openSpy).toHaveBeenCalled();
  });

  it('refuses non-http(s) schemes from server-supplied URLs', async () => {
    expect(isSafeJenkinsWebUrl('https://ci.example.com/job/app/')).toBe(true);
    expect(isSafeJenkinsWebUrl('http://127.0.0.1:8080/job/app/')).toBe(true);
    expect(isSafeJenkinsWebUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeJenkinsWebUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeJenkinsWebUrl('vscode://vscode.github-authentication/did-authenticate')).toBe(
      false
    );

    const openSpy = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true as never);
    openSpy.mockClear();
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const ok = await openInJenkinsHandler({ url: 'file:///tmp/evil' });
    expect(ok).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('reports when no URL can be resolved', async () => {
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const ok = await openInJenkinsHandler({ jobFullName: 'missing' });
    expect(ok).toBe(false);
    expect(infoSpy).toHaveBeenCalled();
  });
});
