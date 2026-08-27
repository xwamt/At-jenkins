import type { JenkinsAuthMode } from '../config/schema';
import { AuthError, NotFound } from './errors';
import type { JenkinsHttpClient, JenkinsHttpRequest, JenkinsHttpResponse } from './JenkinsHttpClient';

export interface JenkinsCrumb {
  crumb: string;
  crumbRequestField: string;
  cookie?: string;
}

export interface JenkinsCrumbResponse {
  crumb?: string;
  crumbRequestField?: string;
  _class?: string;
}

export type JenkinsAuthHttpClient =
  | Pick<JenkinsHttpClient, 'requestJson' | 'request'>
  | {
      requestJson<T>(req: JenkinsHttpRequest): Promise<T>;
      request?(req: JenkinsHttpRequest): Promise<JenkinsHttpResponse>;
    };

export interface JenkinsAuthOptions {
  authMode: JenkinsAuthMode;
  username?: string;
  secret?: string; // api token or password
  httpClient?: JenkinsAuthHttpClient;
}

export class JenkinsAuthenticator {
  private readonly authMode: JenkinsAuthMode;
  private readonly username?: string;
  private readonly secret?: string;
  private readonly httpClient?: JenkinsAuthHttpClient;

  private cachedCrumb: JenkinsCrumb | null | undefined;
  private inFlightCrumb: Promise<JenkinsCrumb | null> | undefined;
  private isCrumbDisabled = false;

  constructor(options: JenkinsAuthOptions) {
    this.authMode = options.authMode;
    this.username = options.username;
    this.secret = options.secret;
    this.httpClient = options.httpClient;
  }

  get mode(): JenkinsAuthMode {
    return this.authMode;
  }

  get user(): string | undefined {
    return this.username;
  }

  /**
   * Generates authorization and crumb headers for the given HTTP method.
   */
  async getAuthHeaders(method: string = 'GET'): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    const basicAuth = this.getBasicAuthHeader();
    if (basicAuth) {
      headers['authorization'] = basicAuth;
    }

    if ((this.authMode === 'password' || this.authMode === 'none') && isMutatingMethod(method)) {
      const crumb = await this.getCrumb();
      if (crumb) {
        headers[crumb.crumbRequestField] = crumb.crumb;
        if (crumb.cookie) {
          headers.cookie = crumb.cookie;
        }
      }
    }

    return headers;
  }

  /**
   * Applies authentication and CSRF headers onto an existing headers dictionary.
   */
  async applyAuth(headers: Record<string, string> = {}, method: string = 'GET'): Promise<Record<string, string>> {
    const authHeaders = await this.getAuthHeaders(method);
    return { ...headers, ...authHeaders };
  }

  /**
   * Clears any cached crumb or disabled CSRF flag, forcing the next mutating request to query crumbIssuer.
   */
  clearCrumb(): void {
    this.cachedCrumb = undefined;
    this.isCrumbDisabled = false;
  }

  /**
   * Runs an operation with authentication headers, catching 401/403 errors in password mode
   * to clear the cached crumb and retry once.
   */
  async withAuthRetry<T>(
    action: (headers: Record<string, string>) => Promise<T>,
    method: string = 'GET'
  ): Promise<T> {
    const headers = await this.applyAuth({}, method);
    try {
      return await action(headers);
    } catch (error: unknown) {
      if (
        (this.authMode === 'password' || this.authMode === 'none') &&
        isAuthErrorOrUnauthorized(error)
      ) {
        this.clearCrumb();
        const retryHeaders = await this.applyAuth({}, method);
        return await action(retryHeaders);
      }
      throw error;
    }
  }

  /**
   * Retrieves or fetches the CSRF crumb for password auth mode.
   */
  private async getCrumb(): Promise<JenkinsCrumb | undefined> {
    if ((this.authMode !== 'password' && this.authMode !== 'none') || this.isCrumbDisabled) {
      return undefined;
    }

    if (this.cachedCrumb !== undefined) {
      return this.cachedCrumb ?? undefined;
    }

    if (!this.httpClient) {
      return undefined;
    }

    if (!this.inFlightCrumb) {
      this.inFlightCrumb = this.fetchCrumb().finally(() => {
        this.inFlightCrumb = undefined;
      });
    }

    const crumb = await this.inFlightCrumb;
    this.cachedCrumb = crumb;
    return crumb ?? undefined;
  }

  private async fetchCrumb(): Promise<JenkinsCrumb | null> {
    const basicAuth = this.getBasicAuthHeader();
    const headers: Record<string, string> = basicAuth ? { authorization: basicAuth } : {};
    const req: JenkinsHttpRequest = {
      method: 'GET',
      path: 'crumbIssuer/api/json',
      headers
    };

    try {
      const client = this.httpClient!;
      let payload: JenkinsCrumbResponse | undefined;
      let setCookies: string[] = [];

      if (typeof client.request === 'function') {
        const response = await client.request(req);
        setCookies = response.setCookies ?? [];
        if (response.text.trim()) {
          payload = JSON.parse(response.text) as JenkinsCrumbResponse;
        }
      } else {
        payload = await client.requestJson<JenkinsCrumbResponse>(req);
      }

      if (payload && typeof payload.crumb === 'string') {
        return {
          crumb: payload.crumb,
          crumbRequestField: payload.crumbRequestField || 'Jenkins-Crumb',
          cookie: extractSessionCookie(setCookies)
        };
      }
      return null;
    } catch (error: unknown) {
      if (isNotFoundOr404(error)) {
        this.isCrumbDisabled = true;
        return null;
      }
      throw error;
    }
  }

  private getBasicAuthHeader(): string | undefined {
    if (this.authMode === 'none') {
      return undefined;
    }
    const username = this.username ?? '';
    const secret = this.secret ?? '';
    const credentials = Buffer.from(`${username}:${secret}`, 'utf8').toString('base64');
    return `Basic ${credentials}`;
  }
}

export function extractSessionCookie(setCookies: string[] | undefined): string | undefined {
  if (!setCookies || setCookies.length === 0) {
    return undefined;
  }
  const pairs: string[] = [];
  for (const raw of setCookies) {
    const pair = raw.split(';')[0]?.trim();
    if (pair && /^JSESSIONID(?:\.\w+)?=/i.test(pair)) {
      pairs.push(pair);
    }
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

function isMutatingMethod(method?: string): boolean {
  if (!method) {
    return false;
  }
  const upper = method.toUpperCase();
  return !['GET', 'HEAD', 'OPTIONS'].includes(upper);
}

function isNotFoundOr404(error: unknown): boolean {
  if (error instanceof NotFound) {
    return true;
  }
  if (error && typeof error === 'object') {
    const code = (error as { code?: string }).code;
    const status = (error as { status?: number }).status;
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (code === 'NotFound' || status === 404 || statusCode === 404) {
      return true;
    }
    if (error instanceof Error && error.message.includes('HTTP 404')) {
      return true;
    }
  }
  return false;
}

function isAuthErrorOrUnauthorized(error: unknown): boolean {
  if (error instanceof AuthError) {
    return true;
  }
  if (error && typeof error === 'object') {
    const code = (error as { code?: string }).code;
    const status = (error as { status?: number }).status;
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (code === 'AuthError' || status === 401 || status === 403 || statusCode === 401 || statusCode === 403) {
      return true;
    }
    if (error instanceof Error && (error.message.includes('HTTP 401') || error.message.includes('HTTP 403'))) {
      return true;
    }
  }
  return false;
}
