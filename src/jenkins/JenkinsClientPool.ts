import type { JenkinsInstanceConfigManager } from '../config/JenkinsInstanceConfigManager';
import type { JenkinsInstanceConfig } from '../config/schema';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import { NotFound } from './errors';
import { JenkinsAuthenticator } from './JenkinsAuthenticator';
import type { JenkinsCertVerifier } from './JenkinsCertTrustStore';
import { JenkinsClient } from './JenkinsClient';
import { JenkinsHttpClient } from './JenkinsHttpClient';

export interface JenkinsClientPoolOptions {
  certVerifier?: JenkinsCertVerifier | { verify(host: string, port: number, fp: string): Promise<boolean> };
  log?: AtJenkinsLog;
}

interface CachedClientEntry {
  client: JenkinsClient;
  instance: JenkinsInstanceConfig;
}

export class JenkinsClientPool {
  private readonly cache = new Map<string, CachedClientEntry>();
  private readonly log: AtJenkinsLog;

  constructor(
    private readonly configManager: JenkinsInstanceConfigManager,
    private readonly options?: JenkinsClientPoolOptions
  ) {
    this.log = asRedactedLog(options?.log ?? noopLog);
  }

  /**
   * Returns a cached or freshly instantiated JenkinsClient for the specified instanceId.
   */
  async get(instanceId: string): Promise<JenkinsClient> {
    const instance = await this.configManager.getInstance(instanceId);
    if (!instance) {
      throw new NotFound(`Jenkins instance '${instanceId}' not found.`, instanceId, 404);
    }

    const cached = this.cache.get(instanceId);
    if (cached && this.isCacheValid(cached.instance, instance)) {
      return cached.client;
    }

    const client = await this.createClient(instance);
    this.cache.set(instanceId, { client, instance });
    return client;
  }

  /**
   * Removes a cached client entry for the given instanceId.
   */
  evict(instanceId: string): void {
    this.cache.delete(instanceId);
  }

  /**
   * Clears the entire client cache.
   */
  clear(): void {
    this.cache.clear();
  }

  private isCacheValid(prev: JenkinsInstanceConfig, current: JenkinsInstanceConfig): boolean {
    return (
      prev.updatedAt === current.updatedAt &&
      prev.baseUrl === current.baseUrl &&
      prev.authMode === current.authMode &&
      prev.username === current.username &&
      prev.verifyTls === current.verifyTls &&
      prev.readOnly === current.readOnly &&
      prev.allowBackgroundAccess === current.allowBackgroundAccess
    );
  }

  private async createClient(instance: JenkinsInstanceConfig): Promise<JenkinsClient> {
    let secret: string | undefined;
    if (instance.authMode === 'apiToken') {
      secret = await this.configManager.getApiToken(instance.id);
    } else if (instance.authMode === 'password') {
      secret = await this.configManager.getPassword(instance.id);
    }

    const httpClient = new JenkinsHttpClient({
      baseUrl: instance.baseUrl,
      verifyTls: instance.verifyTls,
      // Only attach TOFU verifier when system CA verification is off (D15).
      certVerifier: instance.verifyTls ? undefined : this.options?.certVerifier,
      log: this.log
    });

    const authenticator = new JenkinsAuthenticator({
      authMode: instance.authMode,
      username: instance.username,
      secret,
      httpClient
    });

    return new JenkinsClient({
      httpClient,
      authenticator,
      instanceConfig: instance,
      log: this.log
    });
  }
}
