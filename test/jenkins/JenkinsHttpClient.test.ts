import { afterEach, describe, expect, it } from 'vitest';
import { AuthError, NotFound, TlsError } from '../../src/jenkins/errors';
import type { JenkinsCertVerifier } from '../../src/jenkins/JenkinsCertTrustStore';
import { JenkinsHttpClient, verifyCertFingerprint } from '../../src/jenkins/JenkinsHttpClient';
import type { AtJenkinsLog } from '../../src/utils/logger';
import {
  startTestHttpServer,
  startTestHttpsServer,
  type TestHttpServer,
  type TestHttpsServer
} from './testHttpServer';

let server: TestHttpServer | undefined;
let secondServer: TestHttpServer | undefined;
let tlsServer: TestHttpsServer | undefined;

afterEach(async () => {
  await server?.close();
  await secondServer?.close();
  await tlsServer?.close();
  server = undefined;
  secondServer = undefined;
  tlsServer = undefined;
});

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function recordingLog(): { lines: string[]; log: AtJenkinsLog } {
  const lines: string[] = [];
  const push = (message: string) => lines.push(message);
  return { lines, log: { error: push, warn: push, info: push, debug: push, trace: push } };
}

describe('JenkinsHttpClient basic requests', () => {
  it('joins a path onto a base URL that already carries a context path', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"name":"jenkins-root"}');
    });
    const client = new JenkinsHttpClient({ baseUrl: `${server.origin}/jenkins`, verifyTls: true });
    const res = await client.requestJson<{ name: string }>({ method: 'GET', path: '/api/json' });
    expect(res.name).toBe('jenkins-root');
    expect(server.requests[0]?.url).toBe('/jenkins/api/json');
  });

  it('joins a relative path without leading slash onto base URL', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"name":"root"}');
    });
    const client = new JenkinsHttpClient({ baseUrl: `${server.origin}/jenkins`, verifyTls: true });
    await client.requestJson({ method: 'GET', path: 'api/json' });
    expect(server.requests[0]?.url).toBe('/jenkins/api/json');
  });

  it('attaches auth and custom headers supplied by the caller', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    await client.requestJson({
      method: 'GET',
      path: '/api/json',
      headers: {
        authorization: 'Basic Ym90OnRva2Vu',
        'Jenkins-Crumb': 'test-crumb-value'
      }
    });
    expect(server.requests[0]?.headers.authorization).toBe('Basic Ym90OnRva2Vu');
    expect(server.requests[0]?.headers['jenkins-crumb']).toBe('test-crumb-value');
  });

  it('sends query parameters including strings, numbers and booleans', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    await client.requestJson({
      method: 'GET',
      path: '/job/my-job/api/json',
      query: { tree: 'name,color', depth: 1, fetchAll: true, unused: undefined }
    });
    const url = new URL(server.requests[0]?.url ?? '/', 'http://127.0.0.1');
    expect(url.pathname).toBe('/job/my-job/api/json');
    expect(url.searchParams.get('tree')).toBe('name,color');
    expect(url.searchParams.get('depth')).toBe('1');
    expect(url.searchParams.get('fetchAll')).toBe('true');
    expect(url.searchParams.has('unused')).toBe(false);
  });

  it('sends JSON body with application/json content-type', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    await client.requestJson({
      method: 'POST',
      path: '/job/test/config.xml',
      body: { script: 'echo "hello"' }
    });
    expect(server.requests[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(server.requests[0]?.body ?? '')).toEqual({ script: 'echo "hello"' });
  });

  it('sends string body as text/plain or caller-provided content-type', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    await client.request({
      method: 'POST',
      path: '/job/test/config.xml',
      headers: { 'content-type': 'application/xml' },
      body: '<flow-definition><script>println 1</script></flow-definition>'
    });
    expect(server.requests[0]?.headers['content-type']).toBe('application/xml');
    expect(server.requests[0]?.body).toBe('<flow-definition><script>println 1</script></flow-definition>');
  });

  it('sends form urlencoded body', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    await client.requestJson({
      method: 'POST',
      path: '/job/test/buildWithParameters',
      form: { PARAM1: 'val1', PARAM2: 'val 2&3' }
    });
    expect(server.requests[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(server.requests[0]?.body ?? '');
    expect(params.get('PARAM1')).toBe('val1');
    expect(params.get('PARAM2')).toBe('val 2&3');
  });

  it('refuses a request that carries both body and form', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    await expect(
      client.request({ method: 'POST', path: '/test', body: { a: 1 }, form: { b: '2' } })
    ).rejects.toThrow(/both a body and a form/i);
    expect(server.requests).toHaveLength(0);
  });
});

describe('JenkinsHttpClient error mapping', () => {
  it('maps HTTP 401 to AuthError', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 401;
      response.end('Invalid credentials');
    });
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    const err = await client.requestJson({ method: 'GET', path: '/api/json' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('AuthError');
    expect((err as AuthError).status).toBe(401);
  });

  it('maps HTTP 403 to AuthError', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 403;
      response.end('No valid crumb was included in the request');
    });
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    const err = await client.request({ method: 'POST', path: '/job/my-job/build' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('AuthError');
    expect((err as AuthError).status).toBe(403);
  });

  it('maps HTTP 404 to NotFound', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 404;
      response.end('Job not found');
    });
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    const err = await client.requestJson({ method: 'GET', path: '/job/non-existent/api/json' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFound);
    expect((err as NotFound).code).toBe('NotFound');
    expect((err as NotFound).status).toBe(404);
    expect((err as NotFound).resource).toBe('/job/non-existent/api/json');
  });

  it('throws for HTTP 500 error', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 500;
      response.end('Internal controller error');
    });
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    await expect(client.request({ method: 'GET', path: '/api/json' })).rejects.toThrow(/HTTP 500/i);
  });
});

describe('JenkinsHttpClient requestRaw', () => {
  it('does not throw on 404 and returns status and text', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 404;
      response.setHeader('content-type', 'text/plain');
      response.end('Not found raw');
    });
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    const res = await client.requestRaw({ method: 'GET', path: '/job/non-existent' });
    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
    expect(res.text).toBe('Not found raw');
    expect(res.contentType).toBe('text/plain');
  });

  it('does not throw on 401 and returns status and text', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 401;
      response.end('Unauthorized');
    });
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    const res = await client.requestRaw({ method: 'GET', path: '/api/json' });
    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
    expect(res.text).toBe('Unauthorized');
  });
});

describe('JenkinsHttpClient URL normalization and overrides', () => {
  it('supports baseUrlOverride', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{"server":1}'));
    secondServer = await startTestHttpServer((_request, response) => response.end('{"server":2}'));
    const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
    const res = await client.requestJson<{ server: number }>({
      method: 'GET',
      path: '/api/json',
      baseUrlOverride: secondServer.origin
    });
    expect(res.server).toBe(2);
    expect(secondServer.requests).toHaveLength(1);
    expect(server.requests).toHaveLength(0);
  });

  it('strips userinfo and trailing slashes from baseUrl', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const origin = new URL(server.origin);
    const client = new JenkinsHttpClient({
      baseUrl: `${origin.protocol}//admin:pass@${origin.host}/jenkins///`,
      verifyTls: true
    });
    await client.requestJson({ method: 'GET', path: '/api/json' });
    expect(server.requests[0]?.url).toBe('/jenkins/api/json');
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });
});

describe('JenkinsHttpClient TLS and TOFU verification', () => {
  it('accepts self-signed cert when verifier approves', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"nodeName":"master"}');
    });
    const client = new JenkinsHttpClient({
      baseUrl: tlsServer.origin,
      verifyTls: false,
      certVerifier: { verify: async () => true }
    });
    const res = await client.requestJson<{ nodeName: string }>({ method: 'GET', path: '/api/json' });
    expect(res.nodeName).toBe('master');
  });

  it('hands verifier the host, port and certificate SHA-256 fingerprint', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    const seen: { host: string; port: number; fp: string }[] = [];
    const client = new JenkinsHttpClient({
      baseUrl: tlsServer.origin,
      verifyTls: false,
      certVerifier: {
        verify: async (host, port, fp) => {
          seen.push({ host, port, fp });
          return true;
        }
      }
    });
    await client.requestJson({ method: 'GET', path: '/api/json' });
    expect(seen[0]?.host).toBe('127.0.0.1');
    expect(seen[0]?.port).toBe(Number(new URL(tlsServer.origin).port));
    expect(seen[0]?.fp).toBe(tlsServer.fingerprint256);
  });

  it('sends no request bytes and throws TlsError when verifier rejects cert', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    let consulted = false;
    const client = new JenkinsHttpClient({
      baseUrl: tlsServer.origin,
      verifyTls: false,
      certVerifier: {
        verify: async () => {
          consulted = true;
          return false;
        }
      }
    });
    const error = await client
      .requestJson({ method: 'POST', path: '/job/secret/build', body: { secret: 'do-not-leak' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TlsError);
    expect((error as TlsError).code).toBe('TlsError');
    expect(tlsServer.connections).toBeGreaterThan(0);
    expect(consulted).toBe(true);
    expect(tlsServer.requests).toHaveLength(0);
  });

  it('defers write until verifier settles', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    let approve: () => void = () => undefined;
    const verdict = new Promise<void>((settle) => {
      approve = settle;
    });
    const client = new JenkinsHttpClient({
      baseUrl: tlsServer.origin,
      verifyTls: false,
      certVerifier: {
        verify: async () => {
          await verdict;
          return true;
        }
      }
    });
    const pending = client.requestJson({ method: 'GET', path: '/api/json' });
    await delay(60);
    expect(tlsServer.requests).toHaveLength(0);

    approve();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(tlsServer.requests).toHaveLength(1);
  });

  it('supports connection reuse across multiple requests with TOFU verification', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    let checks = 0;
    const client = new JenkinsHttpClient({
      baseUrl: tlsServer.origin,
      verifyTls: false,
      timeoutMs: 3000,
      certVerifier: {
        verify: async () => {
          checks += 1;
          return true;
        }
      }
    });

    await expect(client.requestJson({ method: 'GET', path: '/first' })).resolves.toMatchObject({ ok: true });
    await expect(client.requestJson({ method: 'GET', path: '/second' })).resolves.toMatchObject({ ok: true });
    expect(tlsServer.requests.map((r) => r.url)).toEqual(['/first', '/second']);
    expect(checks).toBe(2);
  });

  it('falls back to Node default CA verification when verifyTls is true and no verifier provided', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    const client = new JenkinsHttpClient({ baseUrl: tlsServer.origin, verifyTls: true });
    const error = await client.requestJson({ method: 'GET', path: '/api/json' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TlsError);
    expect(tlsServer.requests).toHaveLength(0);
  });

  it('pauses socket inactivity timeout during verifier prompt', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    const client = new JenkinsHttpClient({
      baseUrl: tlsServer.origin,
      verifyTls: false,
      timeoutMs: 80,
      certVerifier: {
        verify: async () => {
          await delay(300);
          return true;
        }
      }
    });
    await expect(client.requestJson({ method: 'GET', path: '/api/json' })).resolves.toMatchObject({ ok: true });
    expect(tlsServer.requests).toHaveLength(1);
  });

  it('ignores certVerifier when verifyTls is true and still uses system CA (self-signed fails)', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    let consulted = false;
    const client = new JenkinsHttpClient({
      baseUrl: tlsServer.origin,
      verifyTls: true,
      certVerifier: {
        verify: async () => {
          consulted = true;
          return true;
        }
      }
    });
    const error = await client.requestJson({ method: 'GET', path: '/api/json' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TlsError);
    expect(consulted).toBe(false);
    expect(tlsServer.requests).toHaveLength(0);
  });

  it('refuses insecure TLS when verifyTls is false and no verifier is provided', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    const client = new JenkinsHttpClient({ baseUrl: tlsServer.origin, verifyTls: false });
    const error = await client.requestJson({ method: 'GET', path: '/api/json' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TlsError);
    expect((error as TlsError).message).toMatch(/no certificate verifier/i);
    expect(tlsServer.requests).toHaveLength(0);
  });

  it('maps verifier exception to TlsError', async () => {
    tlsServer = await startTestHttpsServer((_request, response) => response.end('{}'));
    const client = new JenkinsHttpClient({
      baseUrl: tlsServer.origin,
      verifyTls: false,
      certVerifier: {
        verify: async () => {
          throw new Error('Trust store disk failure');
        }
      }
    });
    const error = await client.requestJson({ method: 'GET', path: '/api/json' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TlsError);
    expect((error as TlsError).message).toContain('Trust store disk failure');
  });
});

describe('verifyCertFingerprint', () => {
  it('returns TlsError when fingerprint is missing', async () => {
    const err = await verifyCertFingerprint({ verify: async () => true }, 'host', 443, undefined);
    expect(err).toBeInstanceOf(TlsError);
    expect(err?.message).toContain('did not present a fingerprint');
  });

  it('returns undefined when verifier approves', async () => {
    const err = await verifyCertFingerprint({ verify: async () => true }, 'host', 443, 'fp');
    expect(err).toBeUndefined();
  });

  it('returns TlsError when verifier rejects', async () => {
    const err = await verifyCertFingerprint({ verify: async () => false }, 'host', 443, 'fp');
    expect(err).toBeInstanceOf(TlsError);
    expect(err?.message).toContain('rejected by the certificate verifier');
  });
});
