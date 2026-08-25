import * as http from 'node:http';
import * as https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { asRedactedLog, type AtJenkinsLog } from '../utils/logger';
import { normalizeJenkinsBaseUrl } from '../utils/url';
import { AuthError, isTlsConnectionError, NotFound, TlsError } from './errors';
import type { JenkinsCertVerifier } from './JenkinsCertTrustStore';

export interface JenkinsHttpClientOptions {
  baseUrl: string;
  verifyTls: boolean;
  certVerifier?: JenkinsCertVerifier | { verify(host: string, port: number, fp: string): Promise<boolean> };
  timeoutMs?: number;
  agent?: http.Agent | https.Agent;
  log?: AtJenkinsLog;
}

export interface JenkinsHttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Record<string, unknown> | unknown;
  form?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  maxResponseBytes?: number;
  baseUrlOverride?: string;
}

export interface JenkinsHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  text: string;
  ok: boolean;
  contentType?: string;
}

interface RequestPayload {
  buffer: Buffer;
  contentType: string;
}

export interface CertVerificationHooks {
  onVerified(): void;
  onRejected(error: TlsError): void;
}

const defaultHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 30,
  maxFreeSockets: 10
});

const defaultHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 30,
  maxFreeSockets: 10
});

const DEFAULT_TIMEOUT_MS = 15_000;

export class JenkinsHttpClient {
  private readonly baseUrl: string;
  private readonly log: AtJenkinsLog;

  constructor(private readonly options: JenkinsHttpClientOptions) {
    this.baseUrl = normalizeJenkinsBaseUrl(options.baseUrl);
    this.log = asRedactedLog(options.log);
  }

  async request(req: JenkinsHttpRequest): Promise<JenkinsHttpResponse> {
    const res = await this.requestRaw(req);
    if (!res.ok) {
      this.handleHttpError(res, req);
    }
    return res;
  }

  async requestJson<T>(req: JenkinsHttpRequest): Promise<T> {
    const headers = { accept: 'application/json', ...req.headers };
    const res = await this.request({ ...req, headers });
    if (res.status === 204 || res.text.trim().length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new Error(`Jenkins returned a non-JSON response for ${req.path}: ${res.text.slice(0, 200)}`);
    }
  }

  async requestRaw(req: JenkinsHttpRequest): Promise<JenkinsHttpResponse> {
    let target: URL | undefined;
    const method = (req.method ?? 'GET').toUpperCase();
    try {
      const payload = this.toPayload(req);
      target = this.buildUrl(req);
      return await this.performRequest(target, method, payload, req, '*/*');
    } catch (error) {
      this.logFailure(method, target?.pathname ?? req.path, error);
      throw error;
    }
  }

  private handleHttpError(res: JenkinsHttpResponse, req: JenkinsHttpRequest): never {
    const path = req.path;
    const msg = describeFailure(res.status, res.text, path);
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(msg, res.status);
    }
    if (res.status === 404) {
      throw new NotFound(msg, path, res.status);
    }
    throw new Error(`Jenkins request to ${path} failed with HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }

  private buildUrl(req: JenkinsHttpRequest): URL {
    const base = normalizeJenkinsBaseUrl(req.baseUrlOverride ?? this.baseUrl);
    const path = req.path.replace(/^\/+/, '');
    const target = new URL(path, `${base}/`);
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (value !== undefined) {
          target.searchParams.set(key, String(value));
        }
      }
    }
    return target;
  }

  private toPayload(req: JenkinsHttpRequest): RequestPayload | undefined {
    if (req.body !== undefined && req.form !== undefined) {
      throw new Error('A Jenkins request supplied both a body and a form; exactly one encoding can win.');
    }
    if (req.form !== undefined) {
      const text = new URLSearchParams(req.form).toString();
      return {
        buffer: Buffer.from(text, 'utf8'),
        contentType: 'application/x-www-form-urlencoded'
      };
    }
    if (req.body !== undefined) {
      if (Buffer.isBuffer(req.body)) {
        return {
          buffer: req.body,
          contentType: 'application/octet-stream'
        };
      }
      if (typeof req.body === 'string') {
        return {
          buffer: Buffer.from(req.body, 'utf8'),
          contentType: 'text/plain'
        };
      }
      return {
        buffer: Buffer.from(JSON.stringify(req.body), 'utf8'),
        contentType: 'application/json'
      };
    }
    return undefined;
  }

  private logFailure(method: string, path: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.log.debug(`jenkins-http: ${method} ${path} failed: ${detail}`);
  }

  private performRequest(
    target: URL,
    method: string,
    payload: RequestPayload | undefined,
    req: JenkinsHttpRequest,
    defaultAccept: string
  ): Promise<JenkinsHttpResponse> {
    const maxResponseBytes = req.maxResponseBytes;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = (value: JenkinsHttpResponse) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const settleReject = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const isHttps = target.protocol === 'https:';
      const client: typeof http | typeof https = isHttps ? https : http;
      const agent = this.options.agent ?? (isHttps ? defaultHttpsAgent : defaultHttpAgent);

      const headers: Record<string, string> = { accept: defaultAccept };
      if (req.headers) {
        for (const [k, v] of Object.entries(req.headers)) {
          headers[k.toLowerCase()] = v;
        }
      }

      if (payload) {
        if (!headers['content-type']) {
          headers['content-type'] = payload.contentType;
        }
        headers['content-length'] = payload.buffer.length.toString();
      }

      const certVerifier = this.options.certVerifier;
      const usesCertVerifier = isHttps && Boolean(certVerifier);

      let rejectUnauthorized: boolean | undefined;
      if (usesCertVerifier) {
        rejectUnauthorized = false;
      } else if (this.options.verifyTls === false) {
        rejectUnauthorized = false;
      } else {
        rejectUnauthorized = undefined;
      }

      const request = client.request(
        target,
        {
          method,
          headers,
          agent,
          timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          rejectUnauthorized
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer | string) => {
            if (settled) {
              return;
            }
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buf.length;
            if (maxResponseBytes !== undefined && size > maxResponseBytes) {
              settleReject(
                new Error(
                  `The Jenkins response for ${target.pathname} exceeded the configured maximum of ${maxResponseBytes} bytes; aborted.`
                )
              );
              response.destroy();
              return;
            }
            chunks.push(buf);
          });

          response.on('end', () => {
            const body = Buffer.concat(chunks);
            const text = body.toString('utf8');
            const status = response.statusCode ?? 0;
            const resHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(response.headers)) {
              if (Array.isArray(v)) {
                resHeaders[k.toLowerCase()] = v.join(', ');
              } else if (typeof v === 'string') {
                resHeaders[k.toLowerCase()] = v;
              }
            }
            settleResolve({
              status,
              ok: status >= 200 && status < 400,
              headers: resHeaders,
              body,
              text,
              contentType: response.headers['content-type']
            });
          });

          response.on('error', (error: NodeJS.ErrnoException) => {
            settleReject(this.mapError(error, target));
          });
        }
      );

      request.on('timeout', () => {
        request.destroy(new Error(`The request to Jenkins timed out: ${target.pathname}`));
      });

      request.on('error', (error) => {
        settleReject(this.mapError(error as NodeJS.ErrnoException, target));
      });

      if (usesCertVerifier && certVerifier) {
        attachCertVerification(request, target.hostname, portOf(target), certVerifier, {
          onVerified: () => writeAndEnd(request, payload),
          onRejected: (error) => request.destroy(error)
        });
        return;
      }

      writeAndEnd(request, payload);
    });
  }

  private mapError(error: NodeJS.ErrnoException | Error, target: URL): Error {
    if (error instanceof TlsError || error instanceof AuthError || error instanceof NotFound) {
      return error;
    }
    if (isTlsConnectionError(error) || isNodeTlsError(error)) {
      return new TlsError(error.message, { host: target.hostname, port: portOf(target) });
    }
    return error;
  }
}

function isNodeTlsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message;
  if (typeof code === 'string' && (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'))) {
    return true;
  }
  if (typeof message === 'string' && (message.includes('certificate') || message.includes('SSL routines') || message.includes('TLS'))) {
    return true;
  }
  return false;
}

export function attachCertVerification(
  request: http.ClientRequest,
  host: string,
  port: number,
  certVerifier: JenkinsCertVerifier | { verify(host: string, port: number, fp: string): Promise<boolean> },
  hooks: CertVerificationHooks
): void {
  request.on('socket', (socket) => {
    const tlsSocket = socket as TLSSocket;
    const verify = (): void => {
      const restartClock = pauseInactivityTimeout(tlsSocket);
      const fingerprint256 = tlsSocket.getPeerCertificate()?.fingerprint256;
      verifyCertFingerprint(certVerifier, host, port, fingerprint256)
        .then((verifyError) => {
          restartClock();
          if (verifyError) {
            hooks.onRejected(verifyError);
            return;
          }
          hooks.onVerified();
        })
        .catch((error: unknown) => {
          restartClock();
          hooks.onRejected(
            new TlsError(
              `Jenkins TLS certificate verification failed: ${error instanceof Error ? error.message : String(error)}`,
              { host, port, fingerprint: fingerprint256 }
            )
          );
        });
    };

    if (hasCompletedHandshake(tlsSocket)) {
      verify();
      return;
    }
    tlsSocket.once('secureConnect', verify);
  });
}

export function pauseInactivityTimeout(socket: TLSSocket): () => void {
  const deadlineMs = socket.timeout;
  if (!deadlineMs) {
    return () => undefined;
  }
  socket.setTimeout(0);
  return () => {
    if (!socket.destroyed) {
      socket.setTimeout(deadlineMs);
    }
  };
}

export function hasCompletedHandshake(socket: TLSSocket): boolean {
  return typeof socket.getPeerCertificate === 'function' && Boolean(socket.getPeerCertificate()?.fingerprint256);
}

export async function verifyCertFingerprint(
  verifier: JenkinsCertVerifier | { verify(host: string, port: number, fp: string): Promise<boolean> },
  host: string,
  port: number,
  fingerprint256: string | undefined
): Promise<TlsError | undefined> {
  if (!fingerprint256) {
    return new TlsError(`The Jenkins TLS certificate for ${host}:${port} did not present a fingerprint.`, {
      host,
      port
    });
  }
  const trusted = await verifier.verify(host, port, fingerprint256);
  return trusted
    ? undefined
    : new TlsError(`The Jenkins TLS certificate for ${host}:${port} was rejected by the certificate verifier.`, {
        host,
        port,
        fingerprint: fingerprint256
      });
}

function writeAndEnd(request: http.ClientRequest, payload: RequestPayload | undefined): void {
  if (payload) {
    request.write(payload.buffer);
  }
  request.end();
}

function portOf(target: URL): number {
  if (target.port) {
    return Number(target.port);
  }
  return target.protocol === 'https:' ? 443 : 80;
}

function describeFailure(status: number, text: string, path: string): string {
  if (text.trim().length > 0) {
    return `Jenkins request to ${path} failed with HTTP ${status}: ${text.slice(0, 200)}`;
  }
  return `Jenkins request to ${path} failed with HTTP ${status}.`;
}
