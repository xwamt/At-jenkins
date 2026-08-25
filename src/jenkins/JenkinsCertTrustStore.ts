import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';

export const JENKINS_TRUSTED_CERTS_KEY = 'atJenkins.tofu.fingerprints';

export type CertTrustStatus = 'unknown' | 'trusted' | 'changed';

export interface TrustedCert {
  host: string;
  port: number;
  fingerprint: string;
  trustedAt: number;
}

export interface CertTrustMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/**
 * The TOFU decision, decoupled from UI and client.
 */
export interface JenkinsCertVerifier {
  verify(host: string, port: number, fingerprint256: string): Promise<boolean>;
}

/**
 * Trust-on-first-use (TOFU) store for self-signed / private-CA Jenkins TLS certificates,
 * stored under `atJenkins.tofu.fingerprints` in globalState (Memento).
 * Key format: `${host.toLowerCase()}:${port}`.
 */
export class JenkinsCertTrustStore {
  private readonly reportedMismatches = new Set<string>();
  private readonly log: AtJenkinsLog;

  constructor(
    private readonly globalState: CertTrustMemento,
    log: AtJenkinsLog = noopLog
  ) {
    this.log = asRedactedLog(log);
  }

  async check(host: string, port: number, fingerprint: string): Promise<CertTrustStatus> {
    const existing = this.read()[this.key(host, port)];
    if (!existing) {
      this.log.trace(`cert-trust: no recorded fingerprint for ${this.key(host, port)}`);
      return 'unknown';
    }
    if (existing.fingerprint === fingerprint) {
      this.log.trace(`cert-trust: ${this.key(host, port)} matches the trusted fingerprint`);
      return 'trusted';
    }
    this.warnOnceAboutMismatch(host, port, existing.fingerprint, fingerprint);
    return 'changed';
  }

  async trust(host: string, port: number, fingerprint: string): Promise<void> {
    const normalizedHost = host.trim().toLowerCase();
    const certs = this.read();
    const existingKey = this.key(normalizedHost, port);
    const previous = certs[existingKey];
    certs[existingKey] = {
      host: normalizedHost,
      port,
      fingerprint,
      trustedAt: Date.now()
    };
    await this.globalState.update(JENKINS_TRUSTED_CERTS_KEY, certs);
    this.log.info(
      previous
        ? `cert-trust: replaced the trusted fingerprint for ${existingKey} (was ${previous.fingerprint}, now ${fingerprint})`
        : `cert-trust: trusted ${existingKey} on first use (fingerprint ${fingerprint})`
    );
    this.reportedMismatches.delete(this.mismatchKey(normalizedHost, port, fingerprint));
  }

  getTrusted(host: string, port: number): TrustedCert | undefined {
    return this.read()[this.key(host, port)];
  }

  getAllTrusted(): Record<string, TrustedCert> {
    return this.read();
  }

  async untrust(host: string, port: number): Promise<void> {
    const normalizedHost = host.trim().toLowerCase();
    const certs = this.read();
    const existingKey = this.key(normalizedHost, port);
    delete certs[existingKey];
    await this.globalState.update(JENKINS_TRUSTED_CERTS_KEY, certs);
    this.log.info(`cert-trust: untrusted ${existingKey}`);
  }

  async forget(host: string, port: number): Promise<void> {
    return this.untrust(host, port);
  }

  async clear(): Promise<void> {
    this.reportedMismatches.clear();
    await this.globalState.update(JENKINS_TRUSTED_CERTS_KEY, {});
    this.log.info('cert-trust: cleared all trusted certificates');
  }

  private warnOnceAboutMismatch(host: string, port: number, expected: string, presented: string): void {
    const key = this.mismatchKey(host, port, presented);
    if (this.reportedMismatches.has(key)) {
      return;
    }
    this.reportedMismatches.add(key);
    this.log.warn(
      `cert-trust: fingerprint CHANGED for ${this.key(host, port)} (trusted ${expected}, presented ${presented}); ` +
        'refusing the connection until the new certificate is confirmed'
    );
  }

  private read(): Record<string, TrustedCert> {
    return this.globalState.get<Record<string, TrustedCert>>(JENKINS_TRUSTED_CERTS_KEY, {});
  }

  private key(host: string, port: number): string {
    return `${host.trim().toLowerCase()}:${port}`;
  }

  private mismatchKey(host: string, port: number, fingerprint: string): string {
    return `${this.key(host, port)}|${fingerprint}`;
  }
}
