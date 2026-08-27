import { toUserMessage } from './redaction';

export function formatError(error: unknown): string {
  return toUserMessage(error);
}
