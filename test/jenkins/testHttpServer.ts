import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

export interface TestHttpServer {
  origin: string;
  requests: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  close(): Promise<void>;
}

export type TestRequestHandler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

export async function startTestHttpServer(handler: TestRequestHandler): Promise<TestHttpServer> {
  const requests: TestHttpServer['requests'] = [];
  const server: Server = createServer(recordThen(requests, handler));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeServer(server)
  };
}

export interface TestHttpsServer extends TestHttpServer {
  connections: number;
  fingerprint256: string;
}

export async function startTestHttpsServer(handler: TestRequestHandler): Promise<TestHttpsServer> {
  const requests: TestHttpServer['requests'] = [];
  const cert = readFixture('selfsigned-test.cert.pem');
  const server: HttpsServer = createHttpsServer(
    { key: readFixture('selfsigned-test.key.pem'), cert },
    recordThen(requests, handler)
  );
  const state = { connections: 0 };
  server.on('connection', () => {
    state.connections += 1;
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `https://127.0.0.1:${port}`,
    requests,
    get connections() {
      return state.connections;
    },
    fingerprint256: new X509Certificate(cert).fingerprint256,
    close: () => closeServer(server)
  };
}

function recordThen(
  requests: TestHttpServer['requests'],
  handler: TestRequestHandler
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body
      });
      handler(request, response, body);
    });
  };
}

function closeServer(server: Server | HttpsServer): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((done) => server.close(() => done()));
}

function readFixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'test/jenkins/fixtures', name), 'utf8');
}
