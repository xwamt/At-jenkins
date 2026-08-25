import { describe, expect, it } from 'vitest';
import { DEFAULT_LOG_TAIL_BYTES } from '../../src/jenkins/types';
import { truncateBuildLog } from '../../src/jenkins/logTruncate';

describe('truncateBuildLog', () => {
  it('returns tail bytes by default and marks truncated', () => {
    const raw = Buffer.from('a'.repeat(1000));
    const r = truncateBuildLog(raw, { tailBytes: 100 });
    expect(r.text.length).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.totalBytes).toBe(1000);
    expect(r.startByte).toBe(900);
    expect(r.endByte).toBe(1000);
  });

  it('supports start offset', () => {
    const raw = Buffer.from('abcdefghij');
    const r = truncateBuildLog(raw, { start: 5, tailBytes: 1000 });
    expect(r.text).toBe('fghij');
    expect(r.truncated).toBe(false);
    expect(r.startByte).toBe(5);
    expect(r.endByte).toBe(10);
    expect(r.totalBytes).toBe(10);
  });

  it('handles string input and buffer input identically', () => {
    const str = 'line 1\nline 2\nline 3\n';
    const rStr = truncateBuildLog(str);
    const rBuf = truncateBuildLog(Buffer.from(str, 'utf8'));
    expect(rStr).toEqual(rBuf);
    expect(rStr.text).toBe(str);
    expect(rStr.truncated).toBe(false);
  });

  it('uses DEFAULT_LOG_TAIL_BYTES when options omitted', () => {
    expect(DEFAULT_LOG_TAIL_BYTES).toBe(64 * 1024);
    const small = 'hello world';
    const rSmall = truncateBuildLog(small);
    expect(rSmall.text).toBe('hello world');
    expect(rSmall.truncated).toBe(false);
    expect(rSmall.totalBytes).toBe(11);

    const large = Buffer.alloc(70 * 1024, 'x');
    const rLarge = truncateBuildLog(large);
    expect(rLarge.text.length).toBe(64 * 1024);
    expect(rLarge.truncated).toBe(true);
    expect(rLarge.totalBytes).toBe(70 * 1024);
    expect(rLarge.startByte).toBe(6 * 1024);
    expect(rLarge.endByte).toBe(70 * 1024);
  });

  it('handles empty input', () => {
    const r = truncateBuildLog('');
    expect(r.text).toBe('');
    expect(r.truncated).toBe(false);
    expect(r.totalBytes).toBe(0);
    expect(r.startByte).toBe(0);
    expect(r.endByte).toBe(0);
  });

  it('handles start offset beyond total length', () => {
    const r = truncateBuildLog('abc', { start: 10 });
    expect(r.text).toBe('');
    expect(r.truncated).toBe(false);
    expect(r.startByte).toBe(3);
    expect(r.endByte).toBe(3);
    expect(r.totalBytes).toBe(3);
  });

  it('handles start offset with maxBytes/tailBytes truncation', () => {
    const raw = Buffer.from('0123456789');
    const r = truncateBuildLog(raw, { start: 2, maxBytes: 4 });
    expect(r.text).toBe('2345');
    expect(r.startByte).toBe(2);
    expect(r.endByte).toBe(6);
    expect(r.totalBytes).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.hasMore).toBe(true);
  });

  it('handles start offset with tailBytes limiting range', () => {
    const raw = Buffer.from('0123456789');
    const r = truncateBuildLog(raw, { start: 2, tailBytes: 4 });
    expect(r.text).toBe('2345');
    expect(r.startByte).toBe(2);
    expect(r.endByte).toBe(6);
    expect(r.totalBytes).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.hasMore).toBe(true);
  });

  it('handles UTF-8 multi-byte characters', () => {
    const text = '你好，世界！Jenkins构建日志';
    const buf = Buffer.from(text, 'utf8');
    const r = truncateBuildLog(buf, { tailBytes: buf.length });
    expect(r.text).toBe(text);
    expect(r.totalBytes).toBe(buf.length);
    expect(r.truncated).toBe(false);
  });
});
