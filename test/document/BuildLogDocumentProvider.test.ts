import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { BuildLogDocumentProvider } from '../../src/document/BuildLogDocumentProvider';
import { buildBuildLogUri } from '../../src/document/uri';
import type { JenkinsClient } from '../../src/jenkins/JenkinsClient';
import type { JenkinsClientPool } from '../../src/jenkins/JenkinsClientPool';

describe('BuildLogDocumentProvider', () => {
  let mockClient: {
    getBuild: ReturnType<typeof vi.fn>;
    getBuildLog: ReturnType<typeof vi.fn>;
  };
  let mockClientPool: {
    get: ReturnType<typeof vi.fn>;
  };
  let provider: BuildLogDocumentProvider;

  beforeEach(() => {
    vi.useFakeTimers();

    mockClient = {
      getBuild: vi.fn(),
      getBuildLog: vi.fn()
    };
    mockClientPool = {
      get: vi.fn().mockResolvedValue(mockClient as unknown as JenkinsClient)
    };

    provider = new BuildLogDocumentProvider(
      mockClientPool as unknown as JenkinsClientPool,
      { pollIntervalMs: 500 }
    );
  });

  describe('provideTextDocumentContent', () => {
    it('returns console log text for completed build and does not start polling', async () => {
      mockClient.getBuildLog.mockResolvedValue({
        text: 'Started by user admin\nRunning in Durability level: MAX_SURVIVABILITY\nFinished: SUCCESS\n',
        truncated: false,
        totalBytes: 85,
        start: 0,
        end: 85
      });
      mockClient.getBuild.mockResolvedValue({
        number: 42,
        building: false,
        result: 'SUCCESS'
      });

      const uri = buildBuildLogUri('inst-1', 'folder/build-job', 42);
      const content = await provider.provideTextDocumentContent(uri);

      expect(mockClientPool.get).toHaveBeenCalledWith('inst-1');
      expect(mockClient.getBuildLog).toHaveBeenCalledWith('folder/build-job', 42, {
        tailBytes: 2 * 1024 * 1024
      });
      expect(content).toContain('Finished: SUCCESS');

      // Fast forward time, no onDidChange events should fire for completed build
      const firedUris: vscode.Uri[] = [];
      provider.onDidChange((u) => firedUris.push(u));
      await vi.advanceTimersByTimeAsync(1500);
      expect(firedUris).toHaveLength(0);
    });

    it('starts progressive auto-refresh polling while build is running', async () => {
      mockClient.getBuildLog.mockResolvedValue({
        text: 'Stage: build in progress...\n',
        truncated: false,
        totalBytes: 30,
        start: 0,
        end: 30
      });
      mockClient.getBuild
        .mockResolvedValueOnce({ number: 10, building: true, result: null }) // initial
        .mockResolvedValueOnce({ number: 10, building: true, result: null }) // tick 1
        .mockResolvedValueOnce({ number: 10, building: false, result: 'SUCCESS' }); // tick 2

      const uri = buildBuildLogUri('inst-1', 'active-job', 10);
      const content = await provider.provideTextDocumentContent(uri);
      expect(content).toBe('Stage: build in progress...\n');

      const firedUris: vscode.Uri[] = [];
      provider.onDidChange((u) => firedUris.push(u));

      // Advance by 1 interval
      await vi.advanceTimersByTimeAsync(500);
      expect(firedUris).toHaveLength(1);
      expect(firedUris[0].toString()).toBe(uri.toString());

      // Advance by 2nd interval -> build completes
      await vi.advanceTimersByTimeAsync(500);
      expect(firedUris).toHaveLength(2);

      // Advance further -> no more events
      await vi.advanceTimersByTimeAsync(1000);
      expect(firedUris).toHaveLength(2);
    });

    it('returns error comment if build log fetch fails', async () => {
      mockClient.getBuildLog.mockRejectedValue(new Error('Jenkins 500 Server Error'));

      const uri = buildBuildLogUri('inst-1', 'failing-job', 5);
      const content = await provider.provideTextDocumentContent(uri);

      expect(content).toContain('//');
      expect(content).toContain('Jenkins 500 Server Error');
    });

    it('returns error comment for invalid URI', async () => {
      const invalidUri = vscode.Uri.file('/not-at-jenkins');
      const content = await provider.provideTextDocumentContent(invalidUri);

      expect(content).toContain('//');
      expect(mockClientPool.get).not.toHaveBeenCalled();
    });

    it('annotates truncated UI logs', async () => {
      mockClient.getBuildLog.mockResolvedValue({
        text: 'tail only',
        truncated: true,
        totalBytes: 10_000,
        startByte: 9000,
        endByte: 10_000,
        hasMore: false
      });
      mockClient.getBuild.mockResolvedValue({ number: 1, building: false, result: 'SUCCESS' });

      const uri = buildBuildLogUri('inst-1', 'big-job', 1);
      const content = await provider.provideTextDocumentContent(uri);
      expect(content).toContain('Log truncated');
      expect(content).toContain('tail only');
    });
  });

  describe('handleDidCloseTextDocument and dispose', () => {
    it('stops active polling timer when document is closed', async () => {
      mockClient.getBuildLog.mockResolvedValue({
        text: 'Building...\n',
        truncated: false,
        totalBytes: 12,
        start: 0,
        end: 12
      });
      mockClient.getBuild.mockResolvedValue({ number: 20, building: true, result: null });

      const uri = buildBuildLogUri('inst-1', 'job-close', 20);
      await provider.provideTextDocumentContent(uri);

      const firedUris: vscode.Uri[] = [];
      provider.onDidChange((u) => firedUris.push(u));

      // Close the document
      provider.handleDidCloseTextDocument({
        uri,
        fileName: uri.fsPath
      } as vscode.TextDocument);

      await vi.advanceTimersByTimeAsync(1500);
      expect(firedUris).toHaveLength(0);
    });

    it('clears all polling timers on dispose', async () => {
      mockClient.getBuildLog.mockResolvedValue({
        text: 'Building...\n',
        truncated: false,
        totalBytes: 12,
        start: 0,
        end: 12
      });
      mockClient.getBuild.mockResolvedValue({ number: 21, building: true, result: null });

      const uri = buildBuildLogUri('inst-1', 'job-dispose', 21);
      await provider.provideTextDocumentContent(uri);

      provider.dispose();

      const firedUris: vscode.Uri[] = [];
      provider.onDidChange((u) => firedUris.push(u));

      await vi.advanceTimersByTimeAsync(1500);
      expect(firedUris).toHaveLength(0);
    });
  });

  describe('followBuildLogInOutput', () => {
    it('streams build log incrementally to OutputChannel until build finishes', async () => {
      const writtenLines: string[] = [];
      const mockOutputChannel = {
        show: vi.fn(),
        append: vi.fn((text: string) => writtenLines.push(text)),
        appendLine: vi.fn((text: string) => writtenLines.push(text + '\n'))
      } as unknown as vscode.OutputChannel;

      mockClient.getBuildLog
        .mockResolvedValueOnce({
          text: 'Chunk 1: starting build\n',
          truncated: false,
          totalBytes: 24,
          startByte: 0,
          endByte: 24,
          hasMore: false
        })
        .mockResolvedValueOnce({
          text: 'Chunk 2: compilation finished\n',
          truncated: false,
          totalBytes: 55,
          startByte: 24,
          endByte: 55,
          hasMore: false
        });

      mockClient.getBuild
        .mockResolvedValueOnce({ number: 30, building: true, result: null }) // after first drain
        .mockResolvedValueOnce({ number: 30, building: false, result: 'SUCCESS' }); // after poll

      const stream = await provider.followBuildLogInOutput(
        'inst-1',
        'pipeline-app',
        30,
        mockOutputChannel,
        { pollIntervalMs: 500 }
      );

      expect(mockOutputChannel.show).toHaveBeenCalled();
      expect(mockClient.getBuildLog).toHaveBeenCalledWith('pipeline-app', 30, {
        start: 0,
        maxBytes: 256 * 1024
      });
      expect(writtenLines.join('')).toContain('Chunk 1: starting build');

      await vi.advanceTimersByTimeAsync(500);
      expect(mockClient.getBuildLog).toHaveBeenCalledWith('pipeline-app', 30, {
        start: 24,
        maxBytes: 256 * 1024
      });
      expect(writtenLines.join('')).toContain('Chunk 2: compilation finished');
      expect(writtenLines.join('')).toContain('SUCCESS');

      stream.dispose();
    });

    it('stops streaming when disposable is disposed early', async () => {
      const writtenLines: string[] = [];
      const mockOutputChannel = {
        show: vi.fn(),
        append: vi.fn((text: string) => writtenLines.push(text)),
        appendLine: vi.fn((text: string) => writtenLines.push(text + '\n'))
      } as unknown as vscode.OutputChannel;

      mockClient.getBuildLog.mockResolvedValue({
        text: 'Initial log\n',
        truncated: false,
        totalBytes: 12,
        startByte: 0,
        endByte: 12,
        hasMore: false
      });
      mockClient.getBuild.mockResolvedValue({ number: 31, building: true, result: null });

      const stream = await provider.followBuildLogInOutput(
        'inst-1',
        'long-job',
        31,
        mockOutputChannel,
        { pollIntervalMs: 500 }
      );

      expect(mockClient.getBuildLog).toHaveBeenCalledTimes(1);

      // Dispose stream early
      stream.dispose();

      await vi.advanceTimersByTimeAsync(1500);
      expect(mockClient.getBuildLog).toHaveBeenCalledTimes(1);
    });
  });
});
