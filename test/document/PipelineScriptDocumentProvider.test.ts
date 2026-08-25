import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { JenkinsInstanceConfigManager } from '../../src/config/JenkinsInstanceConfigManager';
import type { JenkinsInstanceConfig } from '../../src/config/schema';
import { PipelineScriptDocumentProvider } from '../../src/document/PipelineScriptDocumentProvider';
import { buildPipelineScriptUri } from '../../src/document/uri';
import { t } from '../../src/i18n/t';
import { ReadOnly, Unsupported } from '../../src/jenkins/errors';
import type { JenkinsClient } from '../../src/jenkins/JenkinsClient';
import type { JenkinsClientPool } from '../../src/jenkins/JenkinsClientPool';

describe('PipelineScriptDocumentProvider', () => {
  let mockClient: {
    config: JenkinsInstanceConfig;
    getPipelineScript: ReturnType<typeof vi.fn>;
    updatePipelineScript: ReturnType<typeof vi.fn>;
  };
  let mockClientPool: {
    get: ReturnType<typeof vi.fn>;
  };
  let mockConfigManager: {
    getInstance: ReturnType<typeof vi.fn>;
  };
  let provider: PipelineScriptDocumentProvider;

  const instanceConfig: JenkinsInstanceConfig = {
    id: 'inst-1',
    label: 'Main Jenkins',
    baseUrl: 'https://jenkins.example.com',
    authMode: 'none',
    verifyTls: true,
    readOnly: false,
    allowBackgroundAccess: true,
    createdAt: 100,
    updatedAt: 100
  };

  beforeEach(() => {
    mockClient = {
      config: { ...instanceConfig },
      getPipelineScript: vi.fn(),
      updatePipelineScript: vi.fn()
    };
    mockClientPool = {
      get: vi.fn().mockResolvedValue(mockClient as unknown as JenkinsClient)
    };
    mockConfigManager = {
      getInstance: vi.fn().mockResolvedValue(mockClient.config)
    };

    provider = new PipelineScriptDocumentProvider(
      mockClientPool as unknown as JenkinsClientPool,
      mockConfigManager as unknown as JenkinsInstanceConfigManager
    );

    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
  });

  describe('provideTextDocumentContent', () => {
    it('returns pipeline script content for valid stored pipeline job', async () => {
      const scriptText = 'pipeline {\n  agent any\n  stages {\n    stage("Test") { echo "ok" }\n  }\n}';
      mockClient.getPipelineScript.mockResolvedValue({
        script: scriptText,
        sandbox: true,
        scriptSource: 'stored'
      });

      const uri = buildPipelineScriptUri('inst-1', 'folder/my-pipeline');
      const content = await provider.provideTextDocumentContent(uri);

      expect(mockClientPool.get).toHaveBeenCalledWith('inst-1');
      expect(mockClient.getPipelineScript).toHaveBeenCalledWith('folder/my-pipeline');
      expect(content).toBe(scriptText);
    });

    it('returns comment description when job throws Unsupported (e.g. SCM or Freestyle)', async () => {
      mockClient.getPipelineScript.mockRejectedValue(
        new Unsupported('Job uses SCM-stored pipeline script.', {
          jobType: 'CpsScmFlowDefinition',
          operation: 'getPipelineScript'
        })
      );

      const uri = buildPipelineScriptUri('inst-1', 'scm-pipeline');
      const content = await provider.provideTextDocumentContent(uri);

      expect(content).toContain('//');
      expect(content).toContain('Job uses SCM-stored pipeline script.');
    });

    it('returns comment description when client fails to fetch', async () => {
      mockClient.getPipelineScript.mockRejectedValue(new Error('Network connection refused'));

      const uri = buildPipelineScriptUri('inst-1', 'my-job');
      const content = await provider.provideTextDocumentContent(uri);

      expect(content).toContain('//');
      expect(content).toContain('Network connection refused');
    });

    it('returns comment when URI is invalid or not a script target', async () => {
      const invalidUri = vscode.Uri.parse('at-jenkins:/inst-1/job/10/consoleText');
      const content = await provider.provideTextDocumentContent(invalidUri);

      expect(content).toContain('//');
      expect(mockClientPool.get).not.toHaveBeenCalled();
    });
  });

  describe('savePipelineScript', () => {
    it('refuses save when instance is read-only', async () => {
      mockClient.config = { ...instanceConfig, readOnly: true };

      const uri = buildPipelineScriptUri('inst-1', 'folder/my-pipeline');
      const doc = {
        uri,
        fileName: uri.fsPath,
        isDirty: true,
        getText: () => 'pipeline { agent any }'
      } as unknown as vscode.TextDocument;

      const result = await provider.savePipelineScript(doc);

      expect(result).toBe(false);
      expect(mockClient.updatePipelineScript).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('is read-only')
      );
    });

    it('cancels save if user declines confirmation dialog', async () => {
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Cancel') as never);

      const uri = buildPipelineScriptUri('inst-1', 'folder/my-pipeline');
      const doc = {
        uri,
        fileName: uri.fsPath,
        isDirty: true,
        getText: () => 'pipeline { agent any }'
      } as unknown as vscode.TextDocument;

      const result = await provider.savePipelineScript(doc);

      expect(result).toBe(false);
      expect(mockClient.updatePipelineScript).not.toHaveBeenCalled();
    });

    it('updates pipeline script and shows success message when user confirms', async () => {
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Save to Jenkins') as never);
      mockClient.updatePipelineScript.mockResolvedValue(undefined);

      const uri = buildPipelineScriptUri('inst-1', 'folder/my-pipeline');
      const newScript = 'pipeline {\n  agent any\n  stages {\n    stage("Build") { echo "saved" }\n  }\n}';
      const doc = {
        uri,
        fileName: uri.fsPath,
        isDirty: true,
        getText: () => newScript
      } as unknown as vscode.TextDocument;

      const result = await provider.savePipelineScript(doc);

      expect(result).toBe(true);
      expect(mockClient.updatePipelineScript).toHaveBeenCalledWith('folder/my-pipeline', newScript);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('folder/my-pipeline')
      );
    });

    it('handles server update error and shows error notification', async () => {
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Save to Jenkins') as never);
      mockClient.updatePipelineScript.mockRejectedValue(new Error('Permission denied 403'));

      const uri = buildPipelineScriptUri('inst-1', 'folder/my-pipeline');
      const doc = {
        uri,
        fileName: uri.fsPath,
        isDirty: true,
        getText: () => 'pipeline { agent any }'
      } as unknown as vscode.TextDocument;

      const result = await provider.savePipelineScript(doc);

      expect(result).toBe(false);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied 403')
      );
    });

    it('ignores documents with non-at-jenkins scheme or non-script target', async () => {
      const doc1 = {
        uri: vscode.Uri.file('/tmp/Jenkinsfile'),
        fileName: '/tmp/Jenkinsfile',
        getText: () => 'pipeline {}'
      } as unknown as vscode.TextDocument;
      expect(await provider.savePipelineScript(doc1)).toBe(false);

      const doc2 = {
        uri: vscode.Uri.parse('at-jenkins:/inst-1/job/1/consoleText'),
        fileName: '/inst-1/job/1/consoleText',
        getText: () => 'log content'
      } as unknown as vscode.TextDocument;
      expect(await provider.savePipelineScript(doc2)).toBe(false);
    });
  });

  describe('refresh and onDidChange', () => {
    it('fires onDidChange when refresh is called', () => {
      const firedUris: vscode.Uri[] = [];
      const sub = provider.onDidChange((uri) => {
        firedUris.push(uri);
      });

      provider.refresh('inst-1', 'folder/my-job');

      expect(firedUris).toHaveLength(1);
      expect(firedUris[0].toString()).toBe(buildPipelineScriptUri('inst-1', 'folder/my-job').toString());

      sub.dispose();
    });
  });
});
