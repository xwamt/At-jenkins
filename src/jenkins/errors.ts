export type JenkinsErrorCode =
  | 'AuthError'
  | 'TlsError'
  | 'NotFound'
  | 'Unsupported'
  | 'DeniedBackground'
  | 'ReadOnly'
  | 'Truncated';

export abstract class JenkinsError extends Error {
  abstract readonly code: JenkinsErrorCode;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 401/403 or authentication failed (e.g. invalid username/apiToken or CSRF crumb failure).
 */
export class AuthError extends JenkinsError {
  readonly code = 'AuthError' as const;

  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface TlsErrorDetails {
  host?: string;
  port?: number;
  fingerprint?: string;
}

/**
 * Certificate verification mismatch or TLS connection failure.
 */
export class TlsError extends JenkinsError {
  readonly code = 'TlsError' as const;

  constructor(
    message: string,
    public readonly details?: TlsErrorDetails
  ) {
    super(message);
    this.name = 'TlsError';
  }
}

/**
 * Missing job, build, or other Jenkins resource (HTTP 404).
 */
export class NotFound extends JenkinsError {
  readonly code = 'NotFound' as const;

  constructor(
    message: string,
    public readonly resource?: string,
    public readonly status: number = 404
  ) {
    super(message);
    this.name = 'NotFound';
  }
}

export interface UnsupportedDetails {
  jobType?: string;
  operation?: string;
}

/**
 * Wrong job type for operation (e.g. attempting to fetch pipeline script for a Freestyle job).
 */
export class Unsupported extends JenkinsError {
  readonly code = 'Unsupported' as const;

  constructor(
    message: string,
    public readonly details?: UnsupportedDetails
  ) {
    super(message);
    this.name = 'Unsupported';
  }
}

/**
 * MCP access denied because allowBackgroundAccess is false on the instance.
 */
export class DeniedBackground extends JenkinsError {
  readonly code = 'DeniedBackground' as const;

  constructor(
    message: string = 'Instance background access is disabled. Enable allowBackgroundAccess in instance settings.',
    public readonly instanceId?: string
  ) {
    super(message);
    this.name = 'DeniedBackground';
  }
}

export interface ReadOnlyDetails {
  instanceId?: string;
  action?: string;
}

/**
 * Mutating action attempted on a readOnly instance.
 */
export class ReadOnly extends JenkinsError {
  readonly code = 'ReadOnly' as const;

  constructor(
    message: string = 'Instance is configured as read-only. Mutation operations are not allowed.',
    public readonly details?: ReadOnlyDetails
  ) {
    super(message);
    this.name = 'ReadOnly';
  }
}

export interface TruncatedContinuation {
  startByte?: number;
  totalBytes?: number;
  nextStartByte?: number;
  hasMore?: boolean;
}

/**
 * Log tail limit reached, with continuation parameters for progressive loading.
 */
export class Truncated extends JenkinsError {
  readonly code = 'Truncated' as const;

  constructor(
    message: string,
    public readonly continuation?: TruncatedContinuation
  ) {
    super(message);
    this.name = 'Truncated';
  }
}

export type AnyJenkinsError =
  | AuthError
  | TlsError
  | NotFound
  | Unsupported
  | DeniedBackground
  | ReadOnly
  | Truncated;

export function isJenkinsError(error: unknown): error is AnyJenkinsError {
  return error instanceof JenkinsError;
}

const TLS_ERROR_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
]);

export function isTlsConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: string }).code;
  return typeof code === 'string' && TLS_ERROR_CODES.has(code);
}
