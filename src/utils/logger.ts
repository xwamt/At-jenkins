import { redactSensitiveText } from './redaction';

export type LogLevelName = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * The five methods `vscode.LogOutputChannel` exposes, narrowed to the string
 * form this extension uses. Declared structurally so the modules that log
 * keep the property of not importing `vscode` directly.
 */
export interface LogSink {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  trace(message: string): void;
}

export type AtJenkinsLog = LogSink;

export function createRedactedLog(sink: LogSink): AtJenkinsLog {
  return {
    error: (message: string) => sink.error(redactSensitiveText(message)),
    warn: (message: string) => sink.warn(redactSensitiveText(message)),
    info: (message: string) => sink.info(redactSensitiveText(message)),
    debug: (message: string) => sink.debug(redactSensitiveText(message)),
    trace: (message: string) => sink.trace(redactSensitiveText(message))
  };
}

export const noopLog: AtJenkinsLog = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined
};

export function asRedactedLog(log: AtJenkinsLog | undefined): AtJenkinsLog {
  return log === undefined || log === noopLog ? noopLog : createRedactedLog(log);
}
