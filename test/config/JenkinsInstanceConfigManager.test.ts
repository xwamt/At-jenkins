import { beforeEach, describe, expect, it } from 'vitest';
import {
  JenkinsInstanceConfigManager,
  type ExtensionMemento,
  type JenkinsInstanceSecrets,
  type SecretStore
} from '../../src/config/JenkinsInstanceConfigManager';
import type { LogLevelName, LogSink } from '../../src/utils/logger';

const INSTANCES_KEY = 'atJenkins.instances';
const ACTIVE_INSTANCE_KEY = 'atJenkins.activeInstanceId';

interface TestMemento extends ExtensionMemento {
  seed(key: string, value: unknown): void;
  peek(key: string): unknown;
}

function createMemento(): TestMemento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    seed(key: string, value: unknown): void {
      store.set(key, value);
    },
    peek(key: string): unknown {
      return store.get(key);
    }
  };
}

function createSecrets(): SecretStore & { snapshot(): Map<string, string> } {
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
    },
    snapshot: () => store
  };
}

function createLog(): LogSink & { entries: string[] } {
  const entries: string[] = [];
  const at = (level: LogLevelName) => (message: string) => {
    entries.push(`${level}: ${message}`);
  };
  return {
    entries,
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace')
  };
}

describe('JenkinsInstanceConfigManager', () => {
  let memento: TestMemento;
  let secrets: ReturnType<typeof createSecrets>;
  let log: ReturnType<typeof createLog>;
  let manager: JenkinsInstanceConfigManager;

  beforeEach(() => {
    memento = createMemento();
    secrets = createSecrets();
    log = createLog();
    manager = new JenkinsInstanceConfigManager(memento, secrets, log);
  });

  describe('listInstances', () => {
    it('returns empty array when nothing is stored', async () => {
      const list = await manager.listInstances();
      expect(list).toEqual([]);
    });

    it('returns instances sorted alphabetically by label', async () => {
      await manager.createInstance({
        label: 'Zebra Jenkins',
        baseUrl: 'https://z.example.com',
        authMode: 'none'
      });
      await manager.createInstance({
        label: 'Alpha Jenkins',
        baseUrl: 'https://a.example.com',
        authMode: 'none'
      });
      await manager.createInstance({
        label: 'Beta Jenkins',
        baseUrl: 'https://b.example.com',
        authMode: 'none'
      });

      const list = await manager.listInstances();
      expect(list.map((i) => i.label)).toEqual(['Alpha Jenkins', 'Beta Jenkins', 'Zebra Jenkins']);
    });

    it('ignores corrupted non-array globalState, logs warning, and returns empty array', async () => {
      memento.seed(INSTANCES_KEY, 'not-an-array');
      const list = await manager.listInstances();
      expect(list).toEqual([]);
      expect(log.entries.some((e) => e.startsWith('warn:') && e.includes(INSTANCES_KEY))).toBe(true);
    });

    it('throws when array contains malformed record', async () => {
      memento.seed(INSTANCES_KEY, [{ id: 'bad-1', missingFields: true }]);
      await expect(manager.listInstances()).rejects.toThrow();
    });
  });

  describe('getInstance', () => {
    it('returns instance by id', async () => {
      const created = await manager.createInstance({
        label: 'main',
        baseUrl: 'https://ci.example.com',
        authMode: 'none'
      });
      const found = await manager.getInstance(created.id);
      expect(found).toEqual(created);
    });

    it('returns undefined if instance not found', async () => {
      const found = await manager.getInstance('non-existent');
      expect(found).toBeUndefined();
    });
  });

  describe('createInstance', () => {
    it('creates an instance and saves to globalState without secrets', async () => {
      const created = await manager.createInstance({
        label: 'ci-prod',
        baseUrl: 'https://ci.example.com/jenkins/',
        authMode: 'apiToken',
        username: 'deployer',
        apiToken: 'tok_secret123'
      });

      expect(created.id).toBeDefined();
      expect(created.label).toBe('ci-prod');
      expect(created.baseUrl).toBe('https://ci.example.com/jenkins');
      expect(created.authMode).toBe('apiToken');
      expect(created.username).toBe('deployer');
      expect(created.verifyTls).toBe(true);
      expect(created.readOnly).toBe(false);
      expect(created.allowBackgroundAccess).toBe(false);
      expect(created.createdAt).toBeGreaterThan(0);
      expect(created.updatedAt).toBe(created.createdAt);

      // Verify globalState does NOT contain apiToken
      const stored = memento.peek(INSTANCES_KEY) as Array<Record<string, unknown>>;
      expect(stored[0]).not.toHaveProperty('apiToken');
      expect(stored[0]).not.toHaveProperty('password');

      // Verify SecretStore has the apiToken
      expect(await manager.getApiToken(created.id)).toBe('tok_secret123');
      expect(await secrets.get(`atJenkins.secret.apiToken.${created.id}`)).toBe('tok_secret123');
    });

    it('stores password in SecretStore under atJenkins.secret.password.<id>', async () => {
      const created = await manager.createInstance({
        label: 'ci-password',
        baseUrl: 'https://ci.example.com',
        authMode: 'password',
        username: 'admin',
        password: 'pwd_secret456'
      });

      expect(await manager.getPassword(created.id)).toBe('pwd_secret456');
      expect(await secrets.get(`atJenkins.secret.password.${created.id}`)).toBe('pwd_secret456');

      const stored = memento.peek(INSTANCES_KEY) as Array<Record<string, unknown>>;
      expect(stored[0]).not.toHaveProperty('password');
    });

    it('falls back to hostname from baseUrl when label is empty or whitespace', async () => {
      const created1 = await manager.createInstance({
        label: '',
        baseUrl: 'https://jenkins.corp.example.com:8443/jenkins',
        authMode: 'none'
      });
      expect(created1.label).toBe('jenkins.corp.example.com');

      const created2 = await manager.createInstance({
        label: '   ',
        baseUrl: 'http://192.168.1.100:8080',
        authMode: 'none'
      });
      expect(created2.label).toBe('192.168.1.100');

      const created3 = await manager.createInstance({
        baseUrl: 'https://ci.domain.org',
        authMode: 'none'
      });
      expect(created3.label).toBe('ci.domain.org');
    });

    it('respects verifyTls, readOnly, and allowBackgroundAccess when provided', async () => {
      const created = await manager.createInstance({
        label: 'custom-flags',
        baseUrl: 'https://ci.example.com',
        authMode: 'none',
        verifyTls: false,
        readOnly: true,
        allowBackgroundAccess: true
      });

      expect(created.verifyTls).toBe(false);
      expect(created.readOnly).toBe(true);
      expect(created.allowBackgroundAccess).toBe(true);
    });
  });

  describe('updateInstance', () => {
    it('updates instance fields and preserves createdAt while updating updatedAt', async () => {
      const created = await manager.createInstance({
        label: 'old-label',
        baseUrl: 'https://old.example.com',
        authMode: 'none',
        createdAt: 100
      } as any);

      const updated = await manager.updateInstance(created.id, {
        label: 'new-label',
        baseUrl: 'https://new.example.com',
        authMode: 'apiToken',
        username: 'new-user',
        verifyTls: false,
        readOnly: true,
        allowBackgroundAccess: true
      });

      expect(updated.id).toBe(created.id);
      expect(updated.label).toBe('new-label');
      expect(updated.baseUrl).toBe('https://new.example.com');
      expect(updated.authMode).toBe('apiToken');
      expect(updated.username).toBe('new-user');
      expect(updated.verifyTls).toBe(false);
      expect(updated.readOnly).toBe(true);
      expect(updated.allowBackgroundAccess).toBe(true);
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    it('throws when updating a non-existent instance', async () => {
      await expect(manager.updateInstance('unknown-id', { label: 'foo' })).rejects.toThrow(
        'Unknown Jenkins instance: unknown-id'
      );
    });

    it('falls back to hostname when patch label is empty string', async () => {
      const created = await manager.createInstance({
        label: 'my-custom-name',
        baseUrl: 'https://ci.example.com',
        authMode: 'none'
      });

      const updated = await manager.updateInstance(created.id, {
        label: '   ',
        baseUrl: 'https://jenkins2.example.com'
      });

      expect(updated.label).toBe('jenkins2.example.com');
    });

    it('keeps previous secret when update passes empty string or undefined', async () => {
      const created = await manager.createInstance({
        label: 'token-instance',
        baseUrl: 'https://ci.example.com',
        authMode: 'apiToken',
        username: 'bot',
        apiToken: 'initial-secret-token',
        password: 'initial-secret-password'
      });

      // Update without secrets
      await manager.updateInstance(created.id, { label: 'renamed' });
      expect(await manager.getApiToken(created.id)).toBe('initial-secret-token');
      expect(await manager.getPassword(created.id)).toBe('initial-secret-password');

      // Update with empty string secrets (series convention: keeps previous secret)
      await manager.updateInstance(created.id, {}, { apiToken: '', password: '' });
      expect(await manager.getApiToken(created.id)).toBe('initial-secret-token');
      expect(await manager.getPassword(created.id)).toBe('initial-secret-password');
    });

    it('rotates secrets when update passes new non-empty values', async () => {
      const created = await manager.createInstance({
        label: 'token-instance',
        baseUrl: 'https://ci.example.com',
        authMode: 'apiToken',
        apiToken: 'token-v1'
      });

      await manager.updateInstance(created.id, {}, { apiToken: 'token-v2' });
      expect(await manager.getApiToken(created.id)).toBe('token-v2');

      await manager.updateInstance(created.id, {}, { password: 'pwd-v1' });
      expect(await manager.getPassword(created.id)).toBe('pwd-v1');
    });
  });

  describe('deleteInstance', () => {
    it('deletes instance and cleans up secrets from SecretStore', async () => {
      const created = await manager.createInstance({
        label: 'to-delete',
        baseUrl: 'https://ci.example.com',
        authMode: 'apiToken',
        apiToken: 'token-to-delete',
        password: 'password-to-delete'
      });

      expect(await manager.getInstance(created.id)).toBeDefined();
      expect(await manager.getApiToken(created.id)).toBe('token-to-delete');
      expect(await manager.getPassword(created.id)).toBe('password-to-delete');

      await manager.deleteInstance(created.id);

      expect(await manager.getInstance(created.id)).toBeUndefined();
      expect(await manager.getApiToken(created.id)).toBeUndefined();
      expect(await manager.getPassword(created.id)).toBeUndefined();
      expect(await manager.listInstances()).toEqual([]);
    });

    it('clears activeInstanceId if the deleted instance was active', async () => {
      const created1 = await manager.createInstance({
        label: 'inst-1',
        baseUrl: 'https://ci1.example.com',
        authMode: 'none'
      });
      const created2 = await manager.createInstance({
        label: 'inst-2',
        baseUrl: 'https://ci2.example.com',
        authMode: 'none'
      });

      await manager.setActiveInstanceId(created1.id);
      expect(await manager.getActiveInstanceId()).toBe(created1.id);

      // Deleting instance 2 does not clear activeInstanceId
      await manager.deleteInstance(created2.id);
      expect(await manager.getActiveInstanceId()).toBe(created1.id);

      // Deleting active instance 1 clears activeInstanceId
      await manager.deleteInstance(created1.id);
      expect(await manager.getActiveInstanceId()).toBeUndefined();
    });
  });

  describe('activeInstanceId management', () => {
    it('gets and sets activeInstanceId', async () => {
      expect(await manager.getActiveInstanceId()).toBeUndefined();

      await manager.setActiveInstanceId('inst-xyz');
      expect(await manager.getActiveInstanceId()).toBe('inst-xyz');
      expect(memento.peek(ACTIVE_INSTANCE_KEY)).toBe('inst-xyz');

      await manager.setActiveInstanceId(undefined);
      expect(await manager.getActiveInstanceId()).toBeUndefined();
    });

    it('getActiveInstance returns active instance object or undefined', async () => {
      expect(await manager.getActiveInstance()).toBeUndefined();

      const created = await manager.createInstance({
        label: 'active-test',
        baseUrl: 'https://ci.example.com',
        authMode: 'none'
      });

      await manager.setActiveInstanceId(created.id);
      const active = await manager.getActiveInstance();
      expect(active).toEqual(created);

      await manager.setActiveInstanceId('non-existent');
      expect(await manager.getActiveInstance()).toBeUndefined();
    });
  });
});
