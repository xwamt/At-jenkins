import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';

function createMockContext(): vscode.ExtensionContext & {
  globalStateStore: Map<string, unknown>;
  secretStore: Map<string, string>;
} {
  const globalStateStore = new Map<string, unknown>();
  const secretStore = new Map<string, string>();

  return {
    subscriptions: [],
    globalStateStore,
    secretStore,
    extensionUri: vscode.Uri.file('/fake/path'),
    globalState: {
      get<T>(key: string, defaultValue?: T): T {
        return (globalStateStore.has(key) ? globalStateStore.get(key) : defaultValue) as T;
      },
      async update(key: string, value: unknown): Promise<void> {
        globalStateStore.set(key, value);
      }
    } as any,
    secrets: {
      async get(key: string) {
        return secretStore.get(key);
      },
      async store(key: string, value: string) {
        secretStore.set(key, value);
      },
      async delete(key: string) {
        secretStore.delete(key);
      }
    } as any
  } as any;
}

describe('extension activation and commands', () => {
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    (vscode.commands as any).__clearRegisteredCommands();
    (vscode.window as any).__clearTreeViews();
    (vscode.window as any).__clearLogChannels();
    (vscode.window as any).__resetDialogs();
    deactivate();
    context = createMockContext();
  });

  it('activates extension, creates tree view, and registers all commands', () => {
    activate(context);

    // Tree views registered
    const treeViews = (vscode.window as any).__getTreeViews();
    expect(treeViews.some((v: any) => v.viewId === 'atJenkins.instances')).toBe(true);
    expect(treeViews.some((v: any) => v.viewId === 'atJenkins.jobs')).toBe(true);

    // Commands registered
    const registered = (vscode.commands as any).__getRegisteredCommands();
    expect(registered.has('atJenkins.addInstance')).toBe(true);
    expect(registered.has('atJenkins.editInstance')).toBe(true);
    expect(registered.has('atJenkins.deleteInstance')).toBe(true);
    expect(registered.has('atJenkins.testConnection')).toBe(true);
    expect(registered.has('atJenkins.refreshInstances')).toBe(true);
    expect(registered.has('atJenkins.setActiveInstance')).toBe(true);
    expect(registered.has('atJenkins.refreshJobs')).toBe(true);
    expect(registered.has('atJenkins.loadMoreBuilds')).toBe(true);
    expect(registered.has('atJenkins.openPipelineScript')).toBe(true);
    expect(registered.has('atJenkins.openBuildLog')).toBe(true);
    expect(registered.has('atJenkins.triggerBuild')).toBe(true);
    expect(registered.has('atJenkins.stopBuild')).toBe(true);
  });

  it('executes setActiveInstance command', async () => {
    activate(context);

    // Seed instances
    context.globalStateStore.set('atJenkins.instances', [
      {
        id: 'inst-1',
        label: 'Prod Jenkins',
        baseUrl: 'https://ci.example.com',
        authMode: 'none',
        verifyTls: true,
        readOnly: false,
        allowBackgroundAccess: false,
        createdAt: 100,
        updatedAt: 100
      }
    ]);

    const setActive = (vscode.commands as any).__getRegisteredCommands().get('atJenkins.setActiveInstance')!;
    await setActive('inst-1');

    expect(context.globalStateStore.get('atJenkins.activeInstanceId')).toBe('inst-1');
  });

  it('executes deleteInstance command with confirmation', async () => {
    activate(context);

    context.globalStateStore.set('atJenkins.instances', [
      {
        id: 'inst-to-del',
        label: 'Delete Me',
        baseUrl: 'https://del.example.com',
        authMode: 'none',
        verifyTls: true,
        readOnly: false,
        allowBackgroundAccess: false,
        createdAt: 100,
        updatedAt: 100
      }
    ]);
    context.secretStore.set('atJenkins.secret.apiToken.inst-to-del', 'secret');

    // Simulate clicking 'Delete' in warning dialog
    (vscode.window as any).showWarningMessage = async () => 'Delete' as any;

    const deleteCmd = (vscode.commands as any).__getRegisteredCommands().get('atJenkins.deleteInstance')!;
    await deleteCmd('inst-to-del');

    const instances = context.globalStateStore.get('atJenkins.instances') as unknown[];
    expect(instances).toHaveLength(0);
    expect(context.secretStore.has('atJenkins.secret.apiToken.inst-to-del')).toBe(false);
  });

  it('executes jobs tree commands safely', async () => {
    activate(context);

    let infoMsg: string | undefined;
    (vscode.window as any).showInformationMessage = async (msg: string) => {
      infoMsg = msg;
      return undefined;
    };

    const refreshJobs = (vscode.commands as any).__getRegisteredCommands().get('atJenkins.refreshJobs')!;
    refreshJobs();

    const loadMore = (vscode.commands as any).__getRegisteredCommands().get('atJenkins.loadMoreBuilds')!;
    loadMore();

    const openPipeline = (vscode.commands as any).__getRegisteredCommands().get('atJenkins.openPipelineScript')!;
    await openPipeline('backend/api');
    expect(infoMsg).toContain('backend/api');

    const openLog = (vscode.commands as any).__getRegisteredCommands().get('atJenkins.openBuildLog')!;
    await openLog({ jobFullName: 'backend/api', buildNumber: 42 });
    expect(infoMsg).toContain('backend/api #42');

    const triggerBuild = (vscode.commands as any).__getRegisteredCommands().get('atJenkins.triggerBuild')!;
    await triggerBuild('backend/api');
    expect(infoMsg).toContain('backend/api');

    const stopBuild = (vscode.commands as any).__getRegisteredCommands().get('atJenkins.stopBuild')!;
    await stopBuild({ jobFullName: 'backend/api', buildNumber: 42 });
    expect(infoMsg).toContain('backend/api #42');
  });
});
