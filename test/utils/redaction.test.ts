import { describe, expect, it } from 'vitest';
import { redactSensitiveText, toUserMessage } from '../../src/utils/redaction';

describe('redactSensitiveText', () => {
  it('redacts bearer tokens', () => {
    expect(redactSensitiveText('Authorization: Bearer secret-token-123')).toBe(
      'Authorization: Bearer [REDACTED]'
    );
    expect(redactSensitiveText('bearer my-long-token')).toBe('bearer [REDACTED]');
  });

  it('redacts basic auth headers', () => {
    expect(redactSensitiveText('Authorization: Basic dXNlcjpwYXNz')).toBe(
      'Authorization: Basic [REDACTED]'
    );
  });

  it('redacts private keys', () => {
    const key = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0...
-----END RSA PRIVATE KEY-----`;
    expect(redactSensitiveText(key)).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('redacts JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgN_pkwqVvP4vB_c_V38j';
    expect(redactSensitiveText(`token is ${jwt}`)).toBe('token is [REDACTED]');
  });

  it('redacts secret and token fields in key-value format', () => {
    expect(redactSensitiveText('password=myPassword123')).toBe('password=[REDACTED]');
    expect(redactSensitiveText('apiToken: "secret-api-token"')).toBe('apiToken: "[REDACTED]"');
    expect(redactSensitiveText("secret_key: 'my-secret'")).toBe("secret_key: '[REDACTED]'");
    expect(redactSensitiveText('crumb=39847293847293847')).toBe('crumb=[REDACTED]');
  });

  it('is idempotent on already redacted text', () => {
    const once = redactSensitiveText('password=myPassword123');
    const twice = redactSensitiveText(once);
    expect(twice).toBe('password=[REDACTED]');
  });
});

describe('toUserMessage', () => {
  it('redacts sensitive information in error messages', () => {
    const error = new Error('Failed to connect with password=supersecret');
    expect(toUserMessage(error)).toBe('Failed to connect with password=[REDACTED]');
  });

  it('handles objects with message property', () => {
    const errorObj = { message: 'Auth failed with apiToken=tok123' };
    expect(toUserMessage(errorObj)).toBe('Auth failed with apiToken=[REDACTED]');
  });

  it('falls back to Unexpected error for unrecognized error types', () => {
    expect(toUserMessage(null)).toBe('Unexpected error');
    expect(toUserMessage(42)).toBe('Unexpected error');
  });
});
