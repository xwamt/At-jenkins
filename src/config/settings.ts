import * as vscode from 'vscode';

export const DEFAULT_BUILDS_PAGE_SIZE = 10;
export const DEFAULT_LOG_POLL_INTERVAL_MS = 3000;
export const DEFAULT_UI_LOG_TAIL_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FOLLOW_POLL_INTERVAL_MS = 2000;
export const DEFAULT_FOLLOW_MAX_POLLS = 150;

export interface AtJenkinsSettings {
  buildsPageSize: number;
  logPollIntervalMs: number;
  uiLogTailBytes: number;
  followPollIntervalMs: number;
  followMaxPolls: number;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Reads `atJenkins.*` settings with bounds so a bad value cannot stall polling
 * or request multi-gigabyte log tails.
 */
export function readAtJenkinsSettings(
  getConfiguration: typeof vscode.workspace.getConfiguration = (section?: string) =>
    vscode.workspace.getConfiguration(section)
): AtJenkinsSettings {
  const cfg = getConfiguration('atJenkins');
  return {
    buildsPageSize: clampInt(cfg.get('builds.pageSize'), DEFAULT_BUILDS_PAGE_SIZE, 1, 100),
    logPollIntervalMs: clampInt(
      cfg.get('log.pollIntervalMs'),
      DEFAULT_LOG_POLL_INTERVAL_MS,
      500,
      60_000
    ),
    uiLogTailBytes: clampInt(
      cfg.get('log.uiTailBytes'),
      DEFAULT_UI_LOG_TAIL_BYTES,
      16 * 1024,
      32 * 1024 * 1024
    ),
    followPollIntervalMs: clampInt(
      cfg.get('follow.pollIntervalMs'),
      DEFAULT_FOLLOW_POLL_INTERVAL_MS,
      500,
      60_000
    ),
    followMaxPolls: clampInt(cfg.get('follow.maxPolls'), DEFAULT_FOLLOW_MAX_POLLS, 10, 10_000)
  };
}
