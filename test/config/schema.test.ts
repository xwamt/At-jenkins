import { describe, expect, it } from 'vitest';
import {
  JENKINS_AUTH_MODES,
  parseJenkinsInstanceConfig,
  parseJenkinsInstanceConfigList
} from '../../src/config/schema';

const base = {
  id: 'inst-1',
  label: 'prod',
  baseUrl: 'https://ci.example.com',
  authMode: 'apiToken' as const,
  username: 'bot',
  verifyTls: true,
  createdAt: 1000,
  updatedAt: 2000
};

describe('parseJenkinsInstanceConfig', () => {
  it('defaults readOnly and allowBackgroundAccess to false', () => {
    const cfg = parseJenkinsInstanceConfig({
      id: 'i1',
      label: 'prod',
      baseUrl: 'https://ci.example.com',
      authMode: 'apiToken',
      username: 'bot',
      verifyTls: true,
      createdAt: 1,
      updatedAt: 1
    });
    expect(cfg.readOnly).toBe(false);
    expect(cfg.allowBackgroundAccess).toBe(false);
  });

  it('accepts a full config with all fields', () => {
    const cfg = parseJenkinsInstanceConfig({
      ...base,
      readOnly: true,
      allowBackgroundAccess: true
    });
    expect(cfg.id).toBe('inst-1');
    expect(cfg.label).toBe('prod');
    expect(cfg.baseUrl).toBe('https://ci.example.com');
    expect(cfg.authMode).toBe('apiToken');
    expect(cfg.username).toBe('bot');
    expect(cfg.verifyTls).toBe(true);
    expect(cfg.readOnly).toBe(true);
    expect(cfg.allowBackgroundAccess).toBe(true);
  });

  it('normalizes baseUrl by stripping credentials and trailing slashes', () => {
    const cfg = parseJenkinsInstanceConfig({
      ...base,
      baseUrl: 'https://admin:secret@ci.example.com:8443/jenkins///'
    });
    expect(cfg.baseUrl).toBe('https://ci.example.com:8443/jenkins');
  });

  it('trims whitespace from baseUrl and username', () => {
    const cfg = parseJenkinsInstanceConfig({
      ...base,
      baseUrl: '  http://localhost:8080/  ',
      username: '  admin  '
    });
    expect(cfg.baseUrl).toBe('http://localhost:8080');
    expect(cfg.username).toBe('admin');
  });

  it('rejects invalid baseUrl missing http/https scheme', () => {
    expect(() =>
      parseJenkinsInstanceConfig({
        ...base,
        baseUrl: 'ci.example.com:8080'
      })
    ).toThrow();

    expect(() =>
      parseJenkinsInstanceConfig({
        ...base,
        baseUrl: 'ssh://ci.example.com'
      })
    ).toThrow();
  });

  it('accepts all valid auth modes', () => {
    for (const authMode of JENKINS_AUTH_MODES) {
      const cfg = parseJenkinsInstanceConfig({
        ...base,
        authMode
      });
      expect(cfg.authMode).toBe(authMode);
    }
  });

  it('rejects unknown auth mode', () => {
    expect(() =>
      parseJenkinsInstanceConfig({
        ...base,
        authMode: 'oauth2'
      })
    ).toThrow();
  });

  it('rejects empty id or label', () => {
    expect(() => parseJenkinsInstanceConfig({ ...base, id: '' })).toThrow();
    expect(() => parseJenkinsInstanceConfig({ ...base, label: '' })).toThrow();
  });

  it('strips extra unrecognized properties', () => {
    const cfg = parseJenkinsInstanceConfig({
      ...base,
      extraField: 'unexpected'
    });
    expect((cfg as Record<string, unknown>).extraField).toBeUndefined();
  });
});

describe('parseJenkinsInstanceConfigList', () => {
  it('parses an array of instance configs', () => {
    const list = parseJenkinsInstanceConfigList([
      base,
      {
        ...base,
        id: 'inst-2',
        label: 'staging',
        baseUrl: 'http://staging.example.com:8080',
        authMode: 'password'
      }
    ]);
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('inst-1');
    expect(list[1].id).toBe('inst-2');
  });

  it('rejects non-array or invalid entries', () => {
    expect(() => parseJenkinsInstanceConfigList('invalid')).toThrow();
    expect(() => parseJenkinsInstanceConfigList([base, { invalid: true }])).toThrow();
  });
});
