import { describe, expect, it } from 'vitest';
import {
  AuthError,
  TlsError,
  NotFound,
  Unsupported,
  DeniedBackground,
  ReadOnly,
  Truncated,
  JenkinsError,
  isJenkinsError,
  isTlsConnectionError
} from '../../src/jenkins/errors';

describe('Jenkins error types', () => {
  it('AuthError has code AuthError and optional status', () => {
    const err = new AuthError('Authentication failed: 401 Unauthorized', 401);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(JenkinsError);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.name).toBe('AuthError');
    expect(err.code).toBe('AuthError');
    expect(err.message).toBe('Authentication failed: 401 Unauthorized');
    expect(err.status).toBe(401);
  });

  it('TlsError has code TlsError and details', () => {
    const err = new TlsError('Certificate verification failed', {
      host: 'ci.example.com',
      port: 443,
      fingerprint: 'fp123'
    });
    expect(err).toBeInstanceOf(JenkinsError);
    expect(err.name).toBe('TlsError');
    expect(err.code).toBe('TlsError');
    expect(err.details?.host).toBe('ci.example.com');
    expect(err.details?.port).toBe(443);
    expect(err.details?.fingerprint).toBe('fp123');
  });

  it('NotFound has code NotFound and resource', () => {
    const err = new NotFound('Job not found: my-job', 'my-job');
    expect(err).toBeInstanceOf(JenkinsError);
    expect(err.name).toBe('NotFound');
    expect(err.code).toBe('NotFound');
    expect(err.resource).toBe('my-job');
    expect(err.status).toBe(404);
  });

  it('Unsupported has code Unsupported and operation/jobType', () => {
    const err = new Unsupported('Freestyle jobs do not have pipeline scripts', {
      jobType: 'hudson.model.FreeStyleProject',
      operation: 'getPipelineScript'
    });
    expect(err).toBeInstanceOf(JenkinsError);
    expect(err.name).toBe('Unsupported');
    expect(err.code).toBe('Unsupported');
    expect(err.details?.jobType).toBe('hudson.model.FreeStyleProject');
    expect(err.details?.operation).toBe('getPipelineScript');
  });

  it('DeniedBackground has code DeniedBackground with sensible defaults', () => {
    const errDefault = new DeniedBackground();
    expect(errDefault).toBeInstanceOf(JenkinsError);
    expect(errDefault.name).toBe('DeniedBackground');
    expect(errDefault.code).toBe('DeniedBackground');
    expect(errDefault.message).toContain('allowBackgroundAccess');

    const errCustom = new DeniedBackground('Custom message', 'inst-1');
    expect(errCustom.message).toBe('Custom message');
    expect(errCustom.instanceId).toBe('inst-1');
  });

  it('ReadOnly has code ReadOnly with sensible defaults', () => {
    const errDefault = new ReadOnly();
    expect(errDefault).toBeInstanceOf(JenkinsError);
    expect(errDefault.name).toBe('ReadOnly');
    expect(errDefault.code).toBe('ReadOnly');
    expect(errDefault.message).toContain('read-only');

    const errCustom = new ReadOnly('Custom read only', { instanceId: 'inst-1', action: 'triggerBuild' });
    expect(errCustom.message).toBe('Custom read only');
    expect(errCustom.details?.instanceId).toBe('inst-1');
    expect(errCustom.details?.action).toBe('triggerBuild');
  });

  it('Truncated has code Truncated and continuation params', () => {
    const err = new Truncated('Log tail limit reached', {
      startByte: 1024,
      totalBytes: 5000,
      nextStartByte: 2048,
      hasMore: true
    });
    expect(err).toBeInstanceOf(JenkinsError);
    expect(err.name).toBe('Truncated');
    expect(err.code).toBe('Truncated');
    expect(err.continuation?.startByte).toBe(1024);
    expect(err.continuation?.totalBytes).toBe(5000);
    expect(err.continuation?.nextStartByte).toBe(2048);
    expect(err.continuation?.hasMore).toBe(true);
  });

  it('isJenkinsError type guard works correctly', () => {
    expect(isJenkinsError(new AuthError('auth'))).toBe(true);
    expect(isJenkinsError(new TlsError('tls'))).toBe(true);
    expect(isJenkinsError(new NotFound('404'))).toBe(true);
    expect(isJenkinsError(new Unsupported('unsupported'))).toBe(true);
    expect(isJenkinsError(new DeniedBackground())).toBe(true);
    expect(isJenkinsError(new ReadOnly())).toBe(true);
    expect(isJenkinsError(new Truncated('truncated'))).toBe(true);
    expect(isJenkinsError(new Error('generic error'))).toBe(false);
    expect(isJenkinsError('not an error')).toBe(false);
    expect(isJenkinsError(null)).toBe(false);
  });

  it('isTlsConnectionError detects Node TLS verification errors', () => {
    expect(isTlsConnectionError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).toBe(true);
    expect(isTlsConnectionError({ code: 'SELF_SIGNED_CERT_IN_CHAIN' })).toBe(true);
    expect(isTlsConnectionError({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })).toBe(true);
    expect(isTlsConnectionError({ code: 'CERT_HAS_EXPIRED' })).toBe(true);
    expect(isTlsConnectionError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })).toBe(true);
    expect(isTlsConnectionError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isTlsConnectionError({ code: 'ECONNREFUSED' })).toBe(false);
    expect(isTlsConnectionError(new Error('plain error'))).toBe(false);
    expect(isTlsConnectionError(null)).toBe(false);
  });
});
