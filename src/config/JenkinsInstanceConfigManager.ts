import { randomUUID } from 'node:crypto';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import {
  parseJenkinsInstanceConfig,
  parseJenkinsInstanceConfigList,
  type JenkinsAuthMode,
  type JenkinsInstanceConfig
} from './schema';

const INSTANCES_KEY = 'atJenkins.instances';
const ACTIVE_INSTANCE_KEY = 'atJenkins.activeInstanceId';
const API_TOKEN_PREFIX = 'atJenkins.secret.apiToken.';
const PASSWORD_PREFIX = 'atJenkins.secret.password.';

export interface ExtensionMemento {
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface JenkinsInstanceSecrets {
  apiToken?: string;
  password?: string;
}

export interface CreateJenkinsInstanceInput extends JenkinsInstanceSecrets {
  label?: string;
  baseUrl: string;
  authMode: JenkinsAuthMode;
  username?: string;
  verifyTls?: boolean;
  readOnly?: boolean;
  allowBackgroundAccess?: boolean;
}

export type UpdateJenkinsInstanceInput = Partial<
  Pick<
    CreateJenkinsInstanceInput,
    'label' | 'baseUrl' | 'authMode' | 'username' | 'verifyTls' | 'readOnly' | 'allowBackgroundAccess'
  >
>;

/**
 * Derives a fallback label from a base URL when no explicit label is provided.
 */
export function deriveDefaultLabel(baseUrl: string): string {
  try {
    const url = new URL(
      baseUrl.startsWith('http://') || baseUrl.startsWith('https://') ? baseUrl : `http://${baseUrl}`
    );
    return url.hostname || baseUrl.trim();
  } catch {
    return baseUrl.trim();
  }
}

/**
 * Resolves the effective label by trimming user input, or falling back to the baseUrl hostname.
 */
export function resolveLabel(label: string | undefined, baseUrl: string): string {
  const trimmed = label?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return deriveDefaultLabel(baseUrl);
}

export class JenkinsInstanceConfigManager {
  private readonly log: AtJenkinsLog;

  constructor(
    private readonly globalState: ExtensionMemento,
    private readonly secrets: SecretStore,
    log: AtJenkinsLog = noopLog
  ) {
    this.log = asRedactedLog(log);
  }

  /**
   * Reads all stored instance configs from globalState.
   * If globalState contains corrupted non-array data, logs a warning and returns an empty list.
   */
  async listInstances(): Promise<JenkinsInstanceConfig[]> {
    const stored = this.globalState.get<unknown>(INSTANCES_KEY, []);
    if (!Array.isArray(stored)) {
      this.log.warn(
        `Ignoring stored ${INSTANCES_KEY} value: expected an array, found ${describeType(stored)}. ` +
          'Adding an instance will overwrite it.'
      );
      return [];
    }
    const parsed = parseJenkinsInstanceConfigList(stored);
    return parsed.sort((a, b) => a.label.localeCompare(b.label));
  }

  async getInstance(id: string): Promise<JenkinsInstanceConfig | undefined> {
    const instances = await this.listInstances();
    return instances.find((instance) => instance.id === id);
  }

  async getActiveInstanceId(): Promise<string | undefined> {
    return this.globalState.get<string | undefined>(ACTIVE_INSTANCE_KEY, undefined);
  }

  async setActiveInstanceId(id: string | undefined): Promise<void> {
    await this.globalState.update(ACTIVE_INSTANCE_KEY, id);
  }

  async getActiveInstance(): Promise<JenkinsInstanceConfig | undefined> {
    const activeId = await this.getActiveInstanceId();
    if (!activeId) {
      return undefined;
    }
    return this.getInstance(activeId);
  }

  async createInstance(input: CreateJenkinsInstanceInput): Promise<JenkinsInstanceConfig> {
    const now = Date.now();
    const label = resolveLabel(input.label, input.baseUrl);
    const instance = parseJenkinsInstanceConfig({
      id: randomUUID(),
      label,
      baseUrl: input.baseUrl.trim(),
      authMode: input.authMode,
      username: input.username?.trim() || undefined,
      verifyTls: input.verifyTls ?? true,
      readOnly: input.readOnly ?? false,
      allowBackgroundAccess: input.allowBackgroundAccess ?? false,
      createdAt: now,
      updatedAt: now
    });
    await this.persist(instance, input);
    return instance;
  }

  async updateInstance(
    id: string,
    patch: UpdateJenkinsInstanceInput,
    secrets: JenkinsInstanceSecrets = {}
  ): Promise<JenkinsInstanceConfig> {
    const existing = await this.getInstance(id);
    if (!existing) {
      throw new Error(`Unknown Jenkins instance: ${id}`);
    }

    const nextBaseUrl = (patch.baseUrl ?? existing.baseUrl).trim();
    const nextLabel = patch.label !== undefined ? resolveLabel(patch.label, nextBaseUrl) : existing.label;

    const updated = parseJenkinsInstanceConfig({
      ...existing,
      ...patch,
      label: nextLabel,
      baseUrl: nextBaseUrl,
      username: patch.username !== undefined ? (patch.username.trim() || undefined) : existing.username,
      updatedAt: Date.now()
    });

    await this.persist(updated, secrets);
    return updated;
  }

  async deleteInstance(id: string): Promise<void> {
    const instances = await this.listInstances();
    await this.globalState.update(
      INSTANCES_KEY,
      instances.filter((instance) => instance.id !== id)
    );
    await this.secrets.delete(this.apiTokenKey(id));
    await this.secrets.delete(this.passwordKey(id));

    const activeId = await this.getActiveInstanceId();
    if (activeId === id) {
      await this.setActiveInstanceId(undefined);
    }
  }

  async getApiToken(id: string): Promise<string | undefined> {
    return this.secrets.get(this.apiTokenKey(id));
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.secrets.get(this.passwordKey(id));
  }

  apiTokenKey(id: string): string {
    return `${API_TOKEN_PREFIX}${id}`;
  }

  passwordKey(id: string): string {
    return `${PASSWORD_PREFIX}${id}`;
  }

  /**
   * Persists instance configuration to globalState and secrets to SecretStorage.
   * Empty string or undefined secret on update keeps previous secret.
   */
  private async persist(instance: JenkinsInstanceConfig, secrets: JenkinsInstanceSecrets): Promise<void> {
    const instances = await this.listInstances();
    const next = [...instances.filter((entry) => entry.id !== instance.id), instance].sort((a, b) =>
      a.label.localeCompare(b.label)
    );
    await this.globalState.update(INSTANCES_KEY, next);

    if (secrets.apiToken !== undefined && secrets.apiToken !== '') {
      await this.secrets.store(this.apiTokenKey(instance.id), secrets.apiToken);
    }
    if (secrets.password !== undefined && secrets.password !== '') {
      await this.secrets.store(this.passwordKey(instance.id), secrets.password);
    }

    // Drop secrets that no longer apply to the active auth mode so mode
    // switches do not leave orphan credentials in SecretStorage.
    if (instance.authMode !== 'apiToken') {
      await this.secrets.delete(this.apiTokenKey(instance.id));
    }
    if (instance.authMode !== 'password') {
      await this.secrets.delete(this.passwordKey(instance.id));
    }
  }
}

function describeType(value: unknown): string {
  return value === null ? 'null' : typeof value;
}
