import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BuildLogDocumentProvider } from '../../src/document/BuildLogDocumentProvider';
import { buildBuildLogUri } from '../../src/document/uri';
import { truncateBuildLog } from '../../src/jenkins/logTruncate';
import type { JenkinsClient } from '../../src/jenkins/JenkinsClient';
import type { JenkinsClientPool } from '../../src/jenkins/JenkinsClientPool';

describe('Log Truncation & BuildLogDocumentProvider Integration', () => {
  it('truncates large logs when tailBytes is requested', () => {
    const raw = Buffer.from('Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n');
    const result = truncateBuildLog(raw, { tailBytes: 14 });

    expect(result.truncated).toBe(true);
    expect(result.totalBytes).toBe(raw.length);
    expect(result.text).toBe('Line 4\nLine 5\n');
  });

  it('supports progressive incremental reading with start offset', () => {
    const fullLog = Buffer.from('Chunk A\nChunk B\nChunk C\n');
    const firstRead = truncateBuildLog(fullLog.subarray(0, 8), { start: 0 });
    expect(firstRead.text).toBe('Chunk A\n');
    expect(firstRead.totalBytes).toBe(8);

    const secondRead = truncateBuildLog(fullLog, { start: firstRead.totalBytes });
    expect(secondRead.text).toBe('Chunk B\nChunk C\n');
    expect(secondRead.totalBytes).toBe(fullLog.length);
  });

  it('provider displays log and handles truncated indicator gracefully', async () => {
    const mockClient = {
      getBuild: vi.fn().mockResolvedValue({ number: 1, building: false, result: 'SUCCESS' }),
      getBuildLog: vi.fn().mockImplementation((_job: string, _num: number, opts?: { tailBytes?: number }) => {
        const fullBuffer = Buffer.from('A'.repeat(100) + 'B'.repeat(50));
        return truncateBuildLog(fullBuffer, opts);
      })
    };
    const mockClientPool = {
      get: vi.fn().mockResolvedValue(mockClient as unknown as JenkinsClient)
    };

    const provider = new BuildLogDocumentProvider(mockClientPool as unknown as JenkinsClientPool);
    const uri = buildBuildLogUri('inst-1', 'job-1', 1);

    const content = await provider.provideTextDocumentContent(uri);
    expect(content.length).toBe(150);
  });
});
