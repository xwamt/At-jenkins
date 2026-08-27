import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  JenkinsInstanceConfigManager,
  type ExtensionMemento,
  type SecretStore
} from '../../src/config/JenkinsInstanceConfigManager';
import {
  InstancesTreeProvider,
  JenkinsInstanceTreeItem
} from '../../src/tree/InstancesTreeProvider';

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

describe('InstancesTreeProvider', () => {
  let memento: ExtensionMemento;
  let secrets: SecretStore;
  let configManager: JenkinsInstanceConfigManager;
  let provider: InstancesTreeProvider;

  beforeEach(() => {
    memento = createMemento();
    secrets = createSecrets();
    configManager = new JenkinsInstanceConfigManager(memento, secrets);
    provider = new InstancesTreeProvider(configManager);
  });

  it('returns empty array when no instances are configured', async () => {
    const children = await provider.getChildren();
    expect(children).toEqual([]);
  });

  it('returns tree items for configured instances and marks active instance', async () => {
    const inst1 = await configManager.createInstance({
      label: 'Alpha Controller',
      baseUrl: 'https://alpha.example.com',
      authMode: 'apiToken',
      username: 'admin',
      apiToken: 'tok1',
      readOnly: false,
      allowBackgroundAccess: true,
      verifyTls: true
    });

    const inst2 = await configManager.createInstance({
      label: 'Beta Controller',
      baseUrl: 'https://beta.example.com',
      authMode: 'password',
      username: 'viewer',
      password: 'pwd',
      readOnly: true,
      allowBackgroundAccess: false,
      verifyTls: false
    });

    await configManager.setActiveInstanceId(inst1.id);

    const children = await provider.getChildren();
    expect(children).toHaveLength(2);

    const alphaItem = children.find((c) => c.instance.id === inst1.id)!;
    expect(alphaItem).toBeDefined();
    expect(alphaItem.label).toBe('Alpha Controller');
    expect(alphaItem.description).toBe('https://alpha.example.com [Agent]');
    expect(alphaItem.isActive).toBe(true);
    expect(alphaItem.contextValue).toBe('atJenkins.instance.active');
    expect((alphaItem.iconPath as vscode.ThemeIcon).id).toBe('radio-tower');
    expect(alphaItem.command).toEqual({
      command: 'atJenkins.setActiveInstance',
      title: 'Set as Active Controller',
      arguments: [inst1]
    });

    const betaItem = children.find((c) => c.instance.id === inst2.id)!;
    expect(betaItem).toBeDefined();
    expect(betaItem.label).toBe('Beta Controller');
    expect(betaItem.description).toBe('https://beta.example.com [RO]');
    expect(betaItem.isActive).toBe(false);
    expect(betaItem.contextValue).toBe('atJenkins.instance.inactive');
    expect((betaItem.iconPath as vscode.ThemeIcon).id).toBe('server');

    // Tooltip validation
    const tooltipAlpha = alphaItem.tooltip as vscode.MarkdownString;
    expect(tooltipAlpha.value).toContain('Alpha Controller');
    expect(tooltipAlpha.value).toContain('https://alpha.example.com');
    expect(tooltipAlpha.value).toContain('apiToken');
    expect(tooltipAlpha.value).toContain('admin');
    expect(tooltipAlpha.value).toContain('**Active:** Yes');
    expect(tooltipAlpha.value).toContain('**Read-only:** No');
    expect(tooltipAlpha.value).toContain('**Background Access:** Yes');
    expect(tooltipAlpha.value).toContain('**TLS Verification:** Enabled');

    const tooltipBeta = betaItem.tooltip as vscode.MarkdownString;
    expect(tooltipBeta.value).toContain('Beta Controller');
    expect(tooltipBeta.value).toContain('https://beta.example.com');
    expect(tooltipBeta.value).toContain('password');
    expect(tooltipBeta.value).toContain('viewer');
    expect(tooltipBeta.value).toContain('**Active:** No');
    expect(tooltipBeta.value).toContain('**Read-only:** Yes');
    expect(tooltipBeta.value).toContain('**Background Access:** No');
    expect(tooltipBeta.value).toContain('**TLS Verification:** Disabled');
  });

  it('getChildren on an element returns empty array', async () => {
    const inst = await configManager.createInstance({
      label: 'Jenkins 1',
      baseUrl: 'https://ci.example.com',
      authMode: 'none'
    });
    const item = new JenkinsInstanceTreeItem(inst, false);
    const children = await provider.getChildren(item);
    expect(children).toEqual([]);
  });

  it('getTreeItem returns the passed item', async () => {
    const inst = await configManager.createInstance({
      label: 'Jenkins 1',
      baseUrl: 'https://ci.example.com',
      authMode: 'none'
    });
    const item = new JenkinsInstanceTreeItem(inst, false);
    expect(provider.getTreeItem(item)).toBe(item);
  });

  it('refresh fires onDidChangeTreeData event', () => {
    let fired = false;
    provider.onDidChangeTreeData(() => {
      fired = true;
    });
    provider.refresh();
    expect(fired).toBe(true);
  });
});
