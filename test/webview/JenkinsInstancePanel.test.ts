import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  JenkinsInstanceConfigManager,
  type ExtensionMemento,
  type SecretStore
} from '../../src/config/JenkinsInstanceConfigManager';
import type { JenkinsInstanceConfig } from '../../src/config/schema';
import {
  handleInstanceFormMessage,
  JenkinsInstancePanel,
  renderInstanceForm
} from '../../src/webview/JenkinsInstancePanel';
import { disposeOpenPanels } from '../../src/webview/openPanels';

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

interface TestPanel {
  postedMessages: Array<{ type?: string; payload?: unknown }>;
  disposed: boolean;
  dispose(): void;
  webview: { postMessage(message: unknown): Promise<boolean> };
}

function createMockPanel(): TestPanel {
  const postedMessages: Array<{ type?: string; payload?: unknown }> = [];
  const panel: TestPanel = {
    postedMessages,
    disposed: false,
    dispose() {
      panel.disposed = true;
    },
    webview: {
      postMessage: vi.fn(async (message: unknown) => {
        postedMessages.push(message as { type?: string; payload?: unknown });
        return true;
      })
    }
  };
  return panel;
}

function asPanel(panel: TestPanel): Parameters<typeof handleInstanceFormMessage>[4] {
  return panel as unknown as Parameters<typeof handleInstanceFormMessage>[4];
}

describe('JenkinsInstancePanel', () => {
  let memento: ExtensionMemento;
  let secrets: SecretStore;
  let configManager: JenkinsInstanceConfigManager;

  beforeEach(() => {
    disposeOpenPanels();
    memento = createMemento();
    secrets = createSecrets();
    configManager = new JenkinsInstanceConfigManager(memento, secrets);
  });

  describe('renderInstanceForm', () => {
    it('renders empty form for new instance creation', () => {
      const view = renderInstanceForm();
      expect(view.body).toContain('<h1>Add Jenkins Controller</h1>');
      expect(view.body).toContain('<span id="submitLabel">Add Controller</span>');
      expect(view.body).toContain('name="baseUrl"');
      expect(view.body).toContain('name="authMode"');
      expect(view.body).toContain('name="verifyTls" type="checkbox" checked');
      expect(view.body).toContain('class="switch-slider"');
      expect(view.body).toContain('class="password-toggle-btn"');
      expect(view.data).toHaveProperty('atJenkinsStrings');
    });

    it('renders prefilled form for existing instance editing', () => {
      const existing: JenkinsInstanceConfig = {
        id: 'inst-1',
        label: 'Production CI',
        baseUrl: 'https://jenkins.example.com',
        authMode: 'apiToken',
        username: 'deployer',
        verifyTls: false,
        readOnly: true,
        allowBackgroundAccess: true,
        createdAt: 1000,
        updatedAt: 2000
      };

      const view = renderInstanceForm({
        existing,
        hasStoredApiToken: true,
        hasStoredPassword: false
      });

      expect(view.body).toContain('<h1>Edit Jenkins Controller: Production CI</h1>');
      expect(view.body).toContain('<span id="submitLabel">Save Controller</span>');
      expect(view.body).toContain('value="Production CI"');
      expect(view.body).toContain('value="https://jenkins.example.com"');
      expect(view.body).toContain('value="deployer"');
      expect(view.body).toContain('Leave blank to keep the saved API token.');
      expect(view.body).toContain('id="readOnly" name="readOnly" type="checkbox" checked');
      expect(view.body).toContain('id="allowBackgroundAccess" name="allowBackgroundAccess" type="checkbox" checked');
      expect(view.body).toContain('class="switch-slider"');
    });
  });

  describe('handleInstanceFormMessage', () => {
    it('ignores unknown message types and returns false', async () => {
      const panel = createMockPanel();
      const onSaved = vi.fn();
      const handled = await handleInstanceFormMessage(
        { type: 'unknown', payload: {} },
        undefined,
        configManager,
        onSaved,
        asPanel(panel)
      );
      expect(handled).toBe(false);
      expect(panel.postedMessages).toHaveLength(0);
    });

    it('returns error when payload schema is invalid', async () => {
      const panel = createMockPanel();
      const onSaved = vi.fn();
      const handled = await handleInstanceFormMessage(
        { type: 'submit', payload: { notAValidPayload: 123 } },
        undefined,
        configManager,
        onSaved,
        asPanel(panel)
      );
      expect(handled).toBe(true);
      expect(panel.postedMessages).toHaveLength(1);
      expect(panel.postedMessages[0].type).toBe('error');
      expect(panel.postedMessages[0].payload).toContain('This form sent a value AT Jenkins could not read');
    });

    it('validates baseUrl is a valid http or https URL', async () => {
      const panel = createMockPanel();
      const onSaved = vi.fn();
      await handleInstanceFormMessage(
        {
          type: 'submit',
          payload: {
            label: 'Test',
            baseUrl: 'invalid-url',
            authMode: 'none',
            username: '',
            apiToken: '',
            password: '',
            verifyTls: true,
            readOnly: false,
            allowBackgroundAccess: false
          }
        },
        undefined,
        configManager,
        onSaved,
        asPanel(panel)
      );

      expect(panel.postedMessages).toHaveLength(1);
      expect(panel.postedMessages[0].type).toBe('error');
      expect(panel.postedMessages[0].payload).toContain('A valid Jenkins controller URL');
      expect(onSaved).not.toHaveBeenCalled();
    });

    it('validates apiToken mode requires username and apiToken for new instance', async () => {
      const panel = createMockPanel();
      const onSaved = vi.fn();

      // Missing username
      await handleInstanceFormMessage(
        {
          type: 'submit',
          payload: {
            label: 'Test',
            baseUrl: 'https://ci.example.com',
            authMode: 'apiToken',
            username: '',
            apiToken: 'tok123',
            password: '',
            verifyTls: true,
            readOnly: false,
            allowBackgroundAccess: false
          }
        },
        undefined,
        configManager,
        onSaved,
        asPanel(panel)
      );

      expect(panel.postedMessages[0].payload).toContain('A username is required for API Token authentication');

      // Missing token
      await handleInstanceFormMessage(
        {
          type: 'submit',
          payload: {
            label: 'Test',
            baseUrl: 'https://ci.example.com',
            authMode: 'apiToken',
            username: 'admin',
            apiToken: '',
            password: '',
            verifyTls: true,
            readOnly: false,
            allowBackgroundAccess: false
          }
        },
        undefined,
        configManager,
        onSaved,
        asPanel(panel)
      );

      expect(panel.postedMessages[1].payload).toContain('An API Token is required for API Token authentication');
      expect(onSaved).not.toHaveBeenCalled();
    });

    it('validates password mode requires username and password for new instance', async () => {
      const panel = createMockPanel();
      const onSaved = vi.fn();

      // Missing username
      await handleInstanceFormMessage(
        {
          type: 'submit',
          payload: {
            label: 'Test',
            baseUrl: 'https://ci.example.com',
            authMode: 'password',
            username: '',
            apiToken: '',
            password: 'pwd',
            verifyTls: true,
            readOnly: false,
            allowBackgroundAccess: false
          }
        },
        undefined,
        configManager,
        onSaved,
        asPanel(panel)
      );

      expect(panel.postedMessages[0].payload).toContain('A username is required for password authentication');

      // Missing password
      await handleInstanceFormMessage(
        {
          type: 'submit',
          payload: {
            label: 'Test',
            baseUrl: 'https://ci.example.com',
            authMode: 'password',
            username: 'admin',
            apiToken: '',
            password: '',
            verifyTls: true,
            readOnly: false,
            allowBackgroundAccess: false
          }
        },
        undefined,
        configManager,
        onSaved,
        asPanel(panel)
      );

      expect(panel.postedMessages[1].payload).toContain('A password is required for password authentication');
      expect(onSaved).not.toHaveBeenCalled();
    });

    it('creates new instance, disposes panel, and calls onSaved', async () => {
      const panel = createMockPanel();
      const onSaved = vi.fn();

      const handled = await handleInstanceFormMessage(
        {
          type: 'submit',
          payload: {
            label: 'My Controller',
            baseUrl: 'https://ci.example.com/jenkins',
            authMode: 'apiToken',
            username: 'ci-bot',
            apiToken: 'secret_token_123',
            password: '',
            verifyTls: true,
            readOnly: true,
            allowBackgroundAccess: true
          }
        },
        undefined,
        configManager,
        onSaved,
        asPanel(panel)
      );

      expect(handled).toBe(true);
      expect(panel.disposed).toBe(true);
      expect(onSaved).toHaveBeenCalled();

      const instances = await configManager.listInstances();
      expect(instances).toHaveLength(1);
      expect(instances[0].label).toBe('My Controller');
      expect(instances[0].baseUrl).toBe('https://ci.example.com/jenkins');
      expect(instances[0].authMode).toBe('apiToken');
      expect(instances[0].username).toBe('ci-bot');
      expect(instances[0].readOnly).toBe(true);
      expect(instances[0].allowBackgroundAccess).toBe(true);
      expect(await configManager.getApiToken(instances[0].id)).toBe('secret_token_123');
    });

    it('updates existing instance and preserves secret when secret is empty', async () => {
      const created = await configManager.createInstance({
        label: 'Old Label',
        baseUrl: 'https://old.example.com',
        authMode: 'apiToken',
        username: 'admin',
        apiToken: 'original-token'
      });

      const panel = createMockPanel();
      const onSaved = vi.fn();

      await handleInstanceFormMessage(
        {
          type: 'submit',
          payload: {
            label: 'Updated Label',
            baseUrl: 'https://updated.example.com',
            authMode: 'apiToken',
            username: 'admin',
            apiToken: '', // Empty means preserve
            password: '',
            verifyTls: false,
            readOnly: false,
            allowBackgroundAccess: true
          }
        },
        created,
        configManager,
        onSaved,
        asPanel(panel)
      );

      expect(panel.disposed).toBe(true);
      expect(onSaved).toHaveBeenCalled();

      const updated = await configManager.getInstance(created.id);
      expect(updated?.label).toBe('Updated Label');
      expect(updated?.baseUrl).toBe('https://updated.example.com');
      expect(await configManager.getApiToken(created.id)).toBe('original-token');
    });

    it('tests connection and reports success', async () => {
      const panel = createMockPanel();
      const onSaved = vi.fn();

      const testConnection = vi.fn(async () => ({
        ok: true,
        message: 'Connected to Jenkins controller.',
        nodeName: 'built-in'
      }));

      await handleInstanceFormMessage(
        {
          type: 'testConnection',
          payload: {
            label: 'Test',
            baseUrl: 'https://ci.example.com',
            authMode: 'none',
            username: '',
            apiToken: '',
            password: '',
            verifyTls: true,
            readOnly: false,
            allowBackgroundAccess: false
          }
        },
        undefined,
        configManager,
        onSaved,
        asPanel(panel),
        { testConnection }
      );

      expect(testConnection).toHaveBeenCalledWith({
        baseUrl: 'https://ci.example.com',
        authMode: 'none',
        username: undefined,
        secret: undefined,
        verifyTls: true
      });

      expect(panel.postedMessages).toHaveLength(1);
      expect(panel.postedMessages[0].type).toBe('connectionTestResult');
      expect(panel.postedMessages[0].payload).toMatchObject({
        ok: true,
        message: 'Connected to Jenkins controller.'
      });
      expect(panel.disposed).toBe(false);
    });

    it('tests connection and reports failure', async () => {
      const panel = createMockPanel();
      const onSaved = vi.fn();

      const testConnection = vi.fn(async () => ({
        ok: false,
        message: 'HTTP 401 Unauthorized'
      }));

      await handleInstanceFormMessage(
        {
          type: 'testConnection',
          payload: {
            label: 'Test',
            baseUrl: 'https://ci.example.com',
            authMode: 'password',
            username: 'baduser',
            apiToken: '',
            password: 'wrongpassword',
            verifyTls: true,
            readOnly: false,
            allowBackgroundAccess: false
          }
        },
        undefined,
        configManager,
        onSaved,
        asPanel(panel),
        { testConnection }
      );

      expect(panel.postedMessages).toHaveLength(1);
      expect(panel.postedMessages[0].type).toBe('connectionTestResult');
      expect(panel.postedMessages[0].payload).toEqual({
        ok: false,
        message: 'HTTP 401 Unauthorized'
      });
    });
  });

  describe('JenkinsInstancePanel.open', () => {
    it('opens webview panel and registers message handler', async () => {
      const context = {
        extensionUri: vscode.Uri.file('/fake/path')
      } as vscode.ExtensionContext;

      const onSaved = vi.fn();
      await JenkinsInstancePanel.open(context, configManager, onSaved);

      // Open again with same key -> should reveal without creating new
      await JenkinsInstancePanel.open(context, configManager, onSaved);
    });
  });
});
