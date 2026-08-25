import { DEFAULT_LOG_TAIL_BYTES, type LogTruncateOptions, type LogTruncateResult } from './types';

export { DEFAULT_LOG_TAIL_BYTES };

/**
 * Truncates build log output based on start offset, tail bytes limit, or max bytes limit.
 */
export function truncateBuildLog(raw: Buffer | string, options?: LogTruncateOptions): LogTruncateResult {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const totalBytes = buf.length;

  if (totalBytes === 0) {
    return {
      text: '',
      startByte: 0,
      endByte: 0,
      totalBytes: 0,
      truncated: false,
      hasMore: false
    };
  }

  if (options?.start !== undefined) {
    const start = Math.max(0, Math.min(options.start, totalBytes));
    let maxLen = totalBytes - start;

    if (options.maxBytes !== undefined) {
      maxLen = Math.max(0, options.maxBytes);
    } else if (options.tailBytes !== undefined) {
      maxLen = Math.max(0, options.tailBytes);
    }

    const end = Math.min(totalBytes, start + maxLen);
    const slice = buf.subarray(start, end);
    const truncated = end < totalBytes;
    const hasMore = end < totalBytes;

    return {
      text: slice.toString('utf8'),
      startByte: start,
      endByte: end,
      totalBytes,
      truncated,
      hasMore
    };
  }

  const tailBytes = options?.tailBytes ?? DEFAULT_LOG_TAIL_BYTES;

  if (tailBytes <= 0) {
    return {
      text: '',
      startByte: totalBytes,
      endByte: totalBytes,
      totalBytes,
      truncated: totalBytes > 0,
      hasMore: false
    };
  }

  if (totalBytes <= tailBytes) {
    return {
      text: buf.toString('utf8'),
      startByte: 0,
      endByte: totalBytes,
      totalBytes,
      truncated: false,
      hasMore: false
    };
  }

  const startByte = totalBytes - tailBytes;
  const endByte = totalBytes;
  const slice = buf.subarray(startByte, endByte);

  return {
    text: slice.toString('utf8'),
    startByte,
    endByte,
    totalBytes,
    truncated: true,
    hasMore: false
  };
}
