import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUILDS_PAGE_SIZE,
  DEFAULT_FOLLOW_MAX_POLLS,
  DEFAULT_FOLLOW_POLL_INTERVAL_MS,
  DEFAULT_LOG_POLL_INTERVAL_MS,
  DEFAULT_UI_LOG_TAIL_BYTES,
  readAtJenkinsSettings
} from '../../src/config/settings';

describe('readAtJenkinsSettings', () => {
  it('returns defaults when nothing is configured', () => {
    expect(readAtJenkinsSettings()).toEqual({
      buildsPageSize: DEFAULT_BUILDS_PAGE_SIZE,
      logPollIntervalMs: DEFAULT_LOG_POLL_INTERVAL_MS,
      uiLogTailBytes: DEFAULT_UI_LOG_TAIL_BYTES,
      followPollIntervalMs: DEFAULT_FOLLOW_POLL_INTERVAL_MS,
      followMaxPolls: DEFAULT_FOLLOW_MAX_POLLS
    });
  });

  it('clamps out-of-range and non-numeric values', () => {
    const values: Record<string, unknown> = {
      'builds.pageSize': 0,
      'log.pollIntervalMs': 10,
      'log.uiTailBytes': 999_999_999,
      'follow.pollIntervalMs': 'nope',
      'follow.maxPolls': 3
    };
    const settings = readAtJenkinsSettings((() => ({
      get: (key: string) => values[key]
    })) as never);

    expect(settings.buildsPageSize).toBe(1);
    expect(settings.logPollIntervalMs).toBe(500);
    expect(settings.uiLogTailBytes).toBe(32 * 1024 * 1024);
    expect(settings.followPollIntervalMs).toBe(DEFAULT_FOLLOW_POLL_INTERVAL_MS);
    expect(settings.followMaxPolls).toBe(10);
  });
});
