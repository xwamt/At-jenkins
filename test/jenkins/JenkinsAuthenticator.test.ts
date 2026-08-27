import { describe, expect, it, vi } from 'vitest';
import { AuthError, NotFound } from '../../src/jenkins/errors';
import { JenkinsAuthenticator } from '../../src/jenkins/JenkinsAuthenticator';
import { JenkinsHttpClient } from '../../src/jenkins/JenkinsHttpClient';
import { startTestHttpServer } from './testHttpServer';

describe('JenkinsAuthenticator', () => {
  describe('authMode: none', () => {
    it('none sends no Authorization', async () => {
      const auth = new JenkinsAuthenticator({ authMode: 'none' });
      const headers = await auth.getAuthHeaders('GET');
      expect(headers).toEqual({});

      const applied = await auth.applyAuth({ 'content-type': 'application/json' }, 'POST');
      expect(applied).toEqual({ 'content-type': 'application/json' });
    });

    it('fetches a crumb for anonymous POSTs when CSRF is enabled', async () => {
      const requestJson = vi.fn().mockResolvedValue({
        crumb: 'anon-crumb',
        crumbRequestField: 'Jenkins-Crumb'
      });
      const auth = new JenkinsAuthenticator({
        authMode: 'none',
        httpClient: { requestJson }
      });

      const headers = await auth.getAuthHeaders('POST');
      expect(headers).toEqual({ 'Jenkins-Crumb': 'anon-crumb' });
      expect(requestJson).toHaveBeenCalledTimes(1);
    });
  });

  describe('authMode: apiToken', () => {
    it('apiToken sends Authorization Basic username:token', async () => {
      const auth = new JenkinsAuthenticator({
        authMode: 'apiToken',
        username: 'alice',
        secret: '11a1b2c3d4e5f6'
      });

      const headers = await auth.getAuthHeaders('GET');
      const expectedToken = Buffer.from('alice:11a1b2c3d4e5f6').toString('base64');
      expect(headers).toEqual({
        authorization: `Basic ${expectedToken}`
      });
    });

    it('does not request crumb on POST (apiToken is CSRF immune in Jenkins)', async () => {
      const requestJson = vi.fn();
      const auth = new JenkinsAuthenticator({
        authMode: 'apiToken',
        username: 'alice',
        secret: 'tok123',
        httpClient: { requestJson }
      });

      const postHeaders = await auth.getAuthHeaders('POST');
      const expectedToken = Buffer.from('alice:tok123').toString('base64');
      expect(postHeaders).toEqual({
        authorization: `Basic ${expectedToken}`
      });
      expect(requestJson).not.toHaveBeenCalled();
    });

    it('handles UTF-8 characters in username and secret', async () => {
      const auth = new JenkinsAuthenticator({
        authMode: 'apiToken',
        username: '用户',
        secret: '密码🔑'
      });

      const headers = await auth.getAuthHeaders('GET');
      const expectedToken = Buffer.from('用户:密码🔑', 'utf8').toString('base64');
      expect(headers.authorization).toBe(`Basic ${expectedToken}`);
    });

    it('handles undefined username or secret gracefully', async () => {
      const auth = new JenkinsAuthenticator({
        authMode: 'apiToken'
      });

      const headers = await auth.getAuthHeaders('GET');
      const expectedToken = Buffer.from(':').toString('base64');
      expect(headers.authorization).toBe(`Basic ${expectedToken}`);
    });
  });

  describe('authMode: password', () => {
    it('password on GET sends Authorization Basic username:password without fetching crumb', async () => {
      const requestJson = vi.fn();
      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      const headers = await auth.getAuthHeaders('GET');
      const expectedToken = Buffer.from('bob:secret123').toString('base64');
      expect(headers).toEqual({
        authorization: `Basic ${expectedToken}`
      });
      expect(requestJson).not.toHaveBeenCalled();
    });

    it('attaches the crumb session cookie from Set-Cookie when request() is available', async () => {
      const request = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: {},
        body: Buffer.from('{}'),
        text: JSON.stringify({ crumb: 'bound-crumb', crumbRequestField: 'Jenkins-Crumb' }),
        setCookies: ['JSESSIONID=sess-1; Path=/; HttpOnly']
      });
      const requestJson = vi.fn();
      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson, request }
      });

      const headers = await auth.getAuthHeaders('POST');
      expect(headers['Jenkins-Crumb']).toBe('bound-crumb');
      expect(headers.cookie).toBe('JSESSIONID=sess-1');
      expect(requestJson).not.toHaveBeenCalled();
    });

    it('password fetches crumb and attaches Jenkins-Crumb on POST', async () => {
      const requestJson = vi.fn().mockResolvedValue({
        crumb: 'crumb-value-xyz',
        crumbRequestField: 'Jenkins-Crumb'
      });

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      const headers = await auth.getAuthHeaders('POST');
      const expectedToken = Buffer.from('bob:secret123').toString('base64');

      expect(headers).toEqual({
        authorization: `Basic ${expectedToken}`,
        'Jenkins-Crumb': 'crumb-value-xyz'
      });

      expect(requestJson).toHaveBeenCalledTimes(1);
      expect(requestJson).toHaveBeenCalledWith({
        method: 'GET',
        path: 'crumbIssuer/api/json',
        headers: {
          authorization: `Basic ${expectedToken}`
        }
      });
    });

    it('attaches crumb on other mutating methods (PUT, DELETE, PATCH)', async () => {
      const requestJson = vi.fn().mockResolvedValue({
        crumb: 'crumb-123',
        crumbRequestField: 'Jenkins-Crumb'
      });

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      const putHeaders = await auth.getAuthHeaders('put');
      expect(putHeaders['Jenkins-Crumb']).toBe('crumb-123');

      const deleteHeaders = await auth.getAuthHeaders('DELETE');
      expect(deleteHeaders['Jenkins-Crumb']).toBe('crumb-123');

      const patchHeaders = await auth.getAuthHeaders('PATCH');
      expect(patchHeaders['Jenkins-Crumb']).toBe('crumb-123');
    });

    it('uses custom crumbRequestField from crumbIssuer response', async () => {
      const requestJson = vi.fn().mockResolvedValue({
        crumb: 'custom-val',
        crumbRequestField: '.crumb'
      });

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      const headers = await auth.getAuthHeaders('POST');
      expect(headers['.crumb']).toBe('custom-val');
      expect(headers['Jenkins-Crumb']).toBeUndefined();
    });

    it('caches crumb across multiple mutating requests', async () => {
      const requestJson = vi.fn().mockResolvedValue({
        crumb: 'cached-crumb',
        crumbRequestField: 'Jenkins-Crumb'
      });

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      const first = await auth.getAuthHeaders('POST');
      const second = await auth.getAuthHeaders('POST');
      const third = await auth.getAuthHeaders('DELETE');

      expect(first['Jenkins-Crumb']).toBe('cached-crumb');
      expect(second['Jenkins-Crumb']).toBe('cached-crumb');
      expect(third['Jenkins-Crumb']).toBe('cached-crumb');
      expect(requestJson).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent crumb requests in flight', async () => {
      let resolveCrumb!: (val: unknown) => void;
      const delayedPromise = new Promise((resolve) => {
        resolveCrumb = resolve;
      });
      const requestJson = vi.fn().mockReturnValue(delayedPromise);

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      const req1 = auth.getAuthHeaders('POST');
      const req2 = auth.getAuthHeaders('POST');

      resolveCrumb({ crumb: 'concurrent-crumb', crumbRequestField: 'Jenkins-Crumb' });

      const [res1, res2] = await Promise.all([req1, req2]);
      expect(res1['Jenkins-Crumb']).toBe('concurrent-crumb');
      expect(res2['Jenkins-Crumb']).toBe('concurrent-crumb');
      expect(requestJson).toHaveBeenCalledTimes(1);
    });

    it('treats 404 from crumbIssuer as CSRF disabled and succeeds without crumb', async () => {
      const requestJson = vi.fn().mockRejectedValue(new NotFound('Crumb issuer not found', 'crumbIssuer/api/json', 404));

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      const headers = await auth.getAuthHeaders('POST');
      const expectedToken = Buffer.from('bob:secret123').toString('base64');
      expect(headers).toEqual({
        authorization: `Basic ${expectedToken}`
      });

      // Subsequent requests also do not re-request crumbIssuer
      const headers2 = await auth.getAuthHeaders('POST');
      expect(headers2).toEqual({
        authorization: `Basic ${expectedToken}`
      });
      expect(requestJson).toHaveBeenCalledTimes(1);
    });

    it('rethrows non-404 errors from crumbIssuer', async () => {
      const requestJson = vi.fn().mockRejectedValue(new Error('Internal Server Error'));

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      await expect(auth.getAuthHeaders('POST')).rejects.toThrow('Internal Server Error');
    });

    it('clearCrumb invalidates cached crumb and fetches fresh crumb on next request', async () => {
      let callCount = 0;
      const requestJson = vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          crumb: `crumb-v${callCount}`,
          crumbRequestField: 'Jenkins-Crumb'
        };
      });

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      const h1 = await auth.getAuthHeaders('POST');
      expect(h1['Jenkins-Crumb']).toBe('crumb-v1');

      auth.clearCrumb();

      const h2 = await auth.getAuthHeaders('POST');
      expect(h2['Jenkins-Crumb']).toBe('crumb-v2');
      expect(requestJson).toHaveBeenCalledTimes(2);
    });
  });

  describe('withAuthRetry and 401 recovery', () => {
    it('clears crumb and retries once on 401 for password mode', async () => {
      let crumbCalls = 0;
      const requestJson = vi.fn().mockImplementation(async () => {
        crumbCalls++;
        return {
          crumb: `crumb-v${crumbCalls}`,
          crumbRequestField: 'Jenkins-Crumb'
        };
      });

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      let attempts = 0;
      const action = vi.fn().mockImplementation(async (headers: Record<string, string>) => {
        attempts++;
        if (attempts === 1) {
          expect(headers['Jenkins-Crumb']).toBe('crumb-v1');
          throw new AuthError('CSRF crumb invalid or expired', 403);
        }
        expect(headers['Jenkins-Crumb']).toBe('crumb-v2');
        return { ok: true, data: 'build triggered' };
      });

      const result = await auth.withAuthRetry(action, 'POST');
      expect(result).toEqual({ ok: true, data: 'build triggered' });
      expect(attempts).toBe(2);
      expect(crumbCalls).toBe(2);
    });

    it('does not loop infinitely if retry also fails with 401', async () => {
      const requestJson = vi.fn().mockResolvedValue({
        crumb: 'crumb-val',
        crumbRequestField: 'Jenkins-Crumb'
      });

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'wrong-pass',
        httpClient: { requestJson }
      });

      let attempts = 0;
      const action = vi.fn().mockImplementation(async () => {
        attempts++;
        throw new AuthError('Invalid credentials', 401);
      });

      await expect(auth.withAuthRetry(action, 'POST')).rejects.toThrow('Invalid credentials');
      expect(attempts).toBe(2); // Initial attempt + 1 retry
    });

    it('does not retry on 401 for apiToken mode', async () => {
      const auth = new JenkinsAuthenticator({
        authMode: 'apiToken',
        username: 'alice',
        secret: 'bad-token'
      });

      let attempts = 0;
      const action = vi.fn().mockImplementation(async () => {
        attempts++;
        throw new AuthError('Bad token', 401);
      });

      await expect(auth.withAuthRetry(action, 'POST')).rejects.toThrow('Bad token');
      expect(attempts).toBe(1);
    });

    it('does not retry on non-auth errors (e.g. 500 error)', async () => {
      const requestJson = vi.fn().mockResolvedValue({
        crumb: 'crumb-val',
        crumbRequestField: 'Jenkins-Crumb'
      });

      const auth = new JenkinsAuthenticator({
        authMode: 'password',
        username: 'bob',
        secret: 'secret123',
        httpClient: { requestJson }
      });

      let attempts = 0;
      const action = vi.fn().mockImplementation(async () => {
        attempts++;
        throw new Error('Database down');
      });

      await expect(auth.withAuthRetry(action, 'POST')).rejects.toThrow('Database down');
      expect(attempts).toBe(1);
    });
  });

  describe('end-to-end integration with test HTTP server and JenkinsHttpClient', () => {
    it('authenticates against real HTTP server, fetches crumb and sends in POST', async () => {
      let crumbIssued = false;
      const server = await startTestHttpServer((req, res) => {
        const authHeader = req.headers['authorization'];
        const expectedAuth = `Basic ${Buffer.from('admin:pass123').toString('base64')}`;

        if (authHeader !== expectedAuth) {
          res.statusCode = 401;
          res.end('Unauthorized');
          return;
        }

        if (req.url === '/crumbIssuer/api/json' && req.method === 'GET') {
          crumbIssued = true;
          res.setHeader('content-type', 'application/json');
          res.setHeader('set-cookie', 'JSESSIONID=abc123; Path=/; HttpOnly');
          res.end(JSON.stringify({ crumb: 'server-crumb-999', crumbRequestField: 'Jenkins-Crumb' }));
          return;
        }

        if (req.url === '/job/demo/build' && req.method === 'POST') {
          const crumb = req.headers['jenkins-crumb'];
          const cookie = String(req.headers.cookie ?? '');
          if (crumb !== 'server-crumb-999' || !cookie.includes('JSESSIONID=abc123')) {
            res.statusCode = 403;
            res.end('No valid crumb');
            return;
          }
          res.statusCode = 201;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ status: 'queued' }));
          return;
        }

        res.statusCode = 404;
        res.end('Not found');
      });

      try {
        const httpClient = new JenkinsHttpClient({
          baseUrl: server.origin,
          verifyTls: false
        });

        const authenticator = new JenkinsAuthenticator({
          authMode: 'password',
          username: 'admin',
          secret: 'pass123',
          httpClient
        });

        const res = await authenticator.withAuthRetry(async (headers) => {
          return httpClient.requestJson<{ status: string }>({
            method: 'POST',
            path: '/job/demo/build',
            headers
          });
        }, 'POST');

        expect(res).toEqual({ status: 'queued' });
        expect(crumbIssued).toBe(true);
        expect(server.requests).toHaveLength(2); // crumb request + job build request
      } finally {
        await server.close();
      }
    });
  });
});
