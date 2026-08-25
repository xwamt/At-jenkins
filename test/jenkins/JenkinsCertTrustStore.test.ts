import { describe, expect, it, vi } from 'vitest';
import { JenkinsCertTrustStore, type CertTrustMemento } from '../../src/jenkins/JenkinsCertTrustStore';
import type { AtJenkinsLog } from '../../src/utils/logger';

class Mem implements CertTrustMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string, def: T): T {
    return (this.data.has(key) ? this.data.get(key) : def) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

function createMockLog(): { log: AtJenkinsLog; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; trace: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const info = vi.fn();
  const trace = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  return {
    log: { warn, info, trace, error, debug },
    warn,
    info,
    trace
  };
}

describe('JenkinsCertTrustStore', () => {
  it('returns unknown then trusted after trust()', async () => {
    const store = new JenkinsCertTrustStore(new Mem());
    expect(await store.check('ci.example.com', 443, 'fp1')).toBe('unknown');
    await store.trust('ci.example.com', 443, 'fp1');
    expect(await store.check('ci.example.com', 443, 'fp1')).toBe('trusted');
    expect(await store.check('ci.example.com', 443, 'fp2')).toBe('changed');
  });

  it('normalizes hostnames to lowercase', async () => {
    const mem = new Mem();
    const store = new JenkinsCertTrustStore(mem);
    await store.trust('CI.Example.COM', 8443, 'fp-upper');

    expect(await store.check('ci.example.com', 8443, 'fp-upper')).toBe('trusted');
    expect(await store.check('CI.EXAMPLE.COM', 8443, 'fp-upper')).toBe('trusted');

    const trusted = store.getTrusted('ci.example.com', 8443);
    expect(trusted).toBeDefined();
    expect(trusted?.fingerprint).toBe('fp-upper');
    expect(trusted?.host).toBe('ci.example.com');
  });

  it('supports untrust and forget', async () => {
    const store = new JenkinsCertTrustStore(new Mem());
    await store.trust('ci.example.com', 443, 'fp1');
    expect(await store.check('ci.example.com', 443, 'fp1')).toBe('trusted');

    await store.untrust('ci.example.com', 443);
    expect(await store.check('ci.example.com', 443, 'fp1')).toBe('unknown');
    expect(store.getTrusted('ci.example.com', 443)).toBeUndefined();

    await store.trust('ci.example.com', 443, 'fp1');
    expect(await store.check('ci.example.com', 443, 'fp1')).toBe('trusted');

    await store.forget('ci.example.com', 443);
    expect(await store.check('ci.example.com', 443, 'fp1')).toBe('unknown');
  });

  it('supports clear to remove all stored fingerprints', async () => {
    const store = new JenkinsCertTrustStore(new Mem());
    await store.trust('ci1.example.com', 443, 'fp1');
    await store.trust('ci2.example.com', 8443, 'fp2');

    expect(await store.check('ci1.example.com', 443, 'fp1')).toBe('trusted');
    expect(await store.check('ci2.example.com', 8443, 'fp2')).toBe('trusted');

    await store.clear();

    expect(await store.check('ci1.example.com', 443, 'fp1')).toBe('unknown');
    expect(await store.check('ci2.example.com', 8443, 'fp2')).toBe('unknown');
  });

  it('deduplicates mismatch warnings', async () => {
    const mock = createMockLog();
    const store = new JenkinsCertTrustStore(new Mem(), mock.log);

    await store.trust('ci.example.com', 443, 'fp-original');
    expect(await store.check('ci.example.com', 443, 'fp-changed')).toBe('changed');
    expect(await store.check('ci.example.com', 443, 'fp-changed')).toBe('changed');
    expect(await store.check('ci.example.com', 443, 'fp-changed')).toBe('changed');

    expect(mock.warn).toHaveBeenCalledTimes(1);
  });

  it('persists under key atJenkins.tofu.fingerprints', async () => {
    const mem = new Mem();
    const store = new JenkinsCertTrustStore(mem);

    await store.trust('ci.example.com', 443, 'fp123');
    const raw = mem.get<Record<string, unknown>>('atJenkins.tofu.fingerprints', {});
    expect(raw['ci.example.com:443']).toMatchObject({
      host: 'ci.example.com',
      port: 443,
      fingerprint: 'fp123'
    });
  });
});
