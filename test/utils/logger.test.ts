import { describe, expect, it } from 'vitest';
import {
  asRedactedLog,
  createRedactedLog,
  noopLog,
  type LogLevelName,
  type LogSink
} from '../../src/utils/logger';

function createLogRecorder(): LogSink & { lines: Array<{ level: LogLevelName; msg: string }> } {
  const lines: Array<{ level: LogLevelName; msg: string }> = [];
  return {
    lines,
    error: (msg) => lines.push({ level: 'error', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
    info: (msg) => lines.push({ level: 'info', msg }),
    debug: (msg) => lines.push({ level: 'debug', msg }),
    trace: (msg) => lines.push({ level: 'trace', msg })
  };
}

describe('logger utils', () => {
  it('redacts sensitive data across all log levels', () => {
    const sink = createLogRecorder();
    const log = createRedactedLog(sink);

    log.error('Error with password=foo');
    log.warn('Warn with apiToken=bar');
    log.info('Info with Bearer tok123');
    log.debug('Debug with Basic dXNlcjpwYXNz');
    log.trace('Trace with secret=xyz');

    expect(sink.lines).toEqual([
      { level: 'error', msg: 'Error with password=[REDACTED]' },
      { level: 'warn', msg: 'Warn with apiToken=[REDACTED]' },
      { level: 'info', msg: 'Info with Bearer [REDACTED]' },
      { level: 'debug', msg: 'Debug with Basic [REDACTED]' },
      { level: 'trace', msg: 'Trace with secret=[REDACTED]' }
    ]);
  });

  it('noopLog does nothing safely', () => {
    expect(() => {
      noopLog.error('test');
      noopLog.warn('test');
      noopLog.info('test');
      noopLog.debug('test');
      noopLog.trace('test');
    }).not.toThrow();
  });

  it('asRedactedLog wraps sink or returns noopLog', () => {
    expect(asRedactedLog(undefined)).toBe(noopLog);
    expect(asRedactedLog(noopLog)).toBe(noopLog);

    const sink = createLogRecorder();
    const wrapped = asRedactedLog(sink);
    wrapped.info('password=secret');
    expect(sink.lines[0].msg).toBe('password=[REDACTED]');
  });
});
