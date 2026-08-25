const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g;
const BEARER_PATTERN = /(\bbearer\s+)(\S+)/gi;
const BASIC_AUTH_PATTERN = /(\bbasic\s+)(\S+)/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Secret fields pattern matching common credentials in logs and errors:
 * password, apiToken, secret, crumb, token, credential, etc.
 */
const JENKINS_SECRET_FIELD_PATTERN =
  /((?:password|passwd|pwd|secret[.\-_]?key|secret|access[.\-_]?key|api[.\-_]?token|api[.\-_]?key|token|credential|crumb|private[.\-_]?key)["']?[ \t]*[=:][ \t]*)(\[REDACTED\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s{]\S*)/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(JWT_PATTERN, '[REDACTED]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(BASIC_AUTH_PATTERN, '$1[REDACTED]')
    .replace(JENKINS_SECRET_FIELD_PATTERN, (_match, name: string, secret: string) => name + redactFieldValue(secret));
}

export function toUserMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? redactSensitiveText(message) : 'Unexpected error';
  }
  return 'Unexpected error';
}

function redactFieldValue(value: string): string {
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
  return `${quote}[REDACTED]${quote}`;
}
