import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { JenkinsInstanceConfigManager } from '../../src/config/JenkinsInstanceConfigManager';
import type { JenkinsInstanceConfig } from '../../src/config/schema';
import { buildPipelineDraftUri } from '../../src/document/draftUri';
import { JenkinsPipelineDraftFileSystemProvider } from '../../src/document/JenkinsPipelineDraftFileSystemProvider';
import { PipelineScriptDocumentProvider } from '../../src/document/PipelineScriptDocumentProvider';
import { buildPipelineScriptUri } from '../../src/document/uri';
import { t } from '../../src/i18n/t';
import { Unsupported } from '../../src/jenkins/errors';
import type { JenkinsClient } from '../../src/jenkins/JenkinsClient';
import type { JenkinsClientPool } from '../../src/jenkins/JenkinsClientPool';

describe('PipelineScriptDocumentProvider', () => {
  let mockClient: {
    config: JenkinsInstanceConfig;
    getPipelineScript: ReturnType<typeof vi.fn>;
    updatePipelineScript: ReturnType<typeof vi.fn>;
  };
  let mockClientPool: { get: ReturnType<typeof vi.fn> };
  let mockConfigManager: { getInstance: ReturnType<typeof vi.fn> };
  let draftProvider: JenkinsPipelineDraftFileSystemProvider;
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
      getPipelineScript: vi.fn().mockResolvedValue({
        script: 'pipeline { agent any }',
        sandbox: true,
        scriptSource: 'stored'
      }),
      updatePipelineScript: vi.fn()
    };
    mockClientPool = {
      get: vi.fn().mockResolvedValue(mockClient as unknown as JenkinsClient)
    };
    mockConfigManager = {
      getInstance: vi.fn().mockResolvedValue(mockClient.config)
    };
    draftProvider = new JenkinsPipelineDraftFileSystemProvider();
    provider = new PipelineScriptDocumentProvider(
      mockClientPool as unknown as JenkinsClientPool,
      mockConfigManager as unknown as JenkinsInstanceConfigManager,
      { draftProvider }
    );

    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    vi.mocked(vscode.window.showErrorMessage).mockClear();
  });

  describe('provideTextDocumentContent', () => {
    it('returns pipeline script content for valid stored pipeline job', async () => {
      const scriptText = 'pipeline {\n  agent any\n}';
      mockClient.getPipelineScript.mockResolvedValue({
        script: scriptText,
        sandbox: true,
        scriptSource: 'stored'
      });

      const uri = buildPipelineScriptUri('inst-1', 'folder/my-pipeline');
      const content = await provider.provideTextDocumentContent(uri);

      expect(content).toBe(scriptText);
    });

    it('returns comment description when job throws Unsupported', async () => {
      mockClient.getPipelineScript.mockRejectedValue(
        new Unsupported('Job uses SCM-stored pipeline script.', {
          jobType: 'CpsScmFlowDefinition',
          operation: 'getPipelineScript'
        })
      );

      const uri = buildPipelineScriptUri('inst-1', 'scm-pipeline');
      const content = await provider.provideTextDocumentContent(uri);

      expect(content).toContain('Job uses SCM-stored pipeline script.');
    });
  });

  describe('savePipelineScript', () => {
    function draftDoc(jobFullName: string, text: string, writable = true): vscode.TextDocument {
      const uri = draftProvider.initDraft('inst-1', jobFullName, text, writable);
      return {
        uri,
        fileName: uri.toString(),
        isDirty: true,
        getText: () => text
      } as unknown as vscode.TextDocument;
    }

    it('refuses save on content-provider URI', async () => {
      const uri = buildPipelineScriptUri('inst-1', 'folder/my-pipeline');
      const doc = {
        uri,
        getText: () => 'pipeline { agent any }'
      } as unknown as vscode.TextDocument;

      expect(await provider.savePipelineScript(doc)).toBe(false);
      expect(mockClient.updatePipelineScript).not.toHaveBeenCalled();
    });

    it('refuses save when draft is not writable', async () => {
      const doc = draftDoc('scm-job', 'pipeline {}', false);
      expect(await provider.savePipelineScript(doc)).toBe(false);
      expect(mockClient.updatePipelineScript).not.toHaveBeenCalled();
    });

    it('refuses save when instance is read-only', async () => {
      mockClient.config = { ...instanceConfig, readOnly: true };
      const doc = draftDoc('folder/my-pipeline', 'pipeline { agent any }');

      expect(await provider.savePipelineScript(doc)).toBe(false);
      expect(mockClient.updatePipelineScript).not.toHaveBeenCalled();
    });

    it('cancels save if user declines confirmation', async () => {
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Cancel') as never);
      const doc = draftDoc('folder/my-pipeline', 'pipeline { agent any }');

      expect(await provider.savePipelineScript(doc)).toBe(false);
      expect(mockClient.updatePipelineScript).not.toHaveBeenCalled();
    });

    it('updates pipeline script when user confirms', async () => {
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(t('Save to Jenkins') as never);
      mockClient.updatePipelineScript.mockResolvedValue(undefined);
      const newScript = 'pipeline {\n  agent any\n}';
      const doc = draftDoc('folder/my-pipeline', newScript);

      expect(await provider.savePipelineScript(doc)).toBe(true);
      expect(mockClient.updatePipelineScript).toHaveBeenCalledWith('folder/my-pipeline', newScript);
    });

    it('refuses before confirm when getPipelineScript throws Unsupported', async () => {
      mockClient.getPipelineScript.mockRejectedValue(
        new Unsupported('SCM-backed', { jobType: 'CpsScmFlowDefinition', operation: 'getPipelineScript' })
      );
      const doc = draftDoc('scm-job', 'pipeline {}', true);

      expect(await provider.savePipelineScript(doc)).toBe(false);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockClient.updatePipelineScript).not.toHaveBeenCalled();
    });

    it('ignores non-jenkins schemes', async () => {
      const doc = {
        uri: vscode.Uri.file('/tmp/Jenkinsfile'),
        getText: () => 'pipeline {}'
      } as unknown as vscode.TextDocument;
      expect(await provider.savePipelineScript(doc)).toBe(false);
    });
  });

  describe('draft FS', () => {
    it('allows writeFile only when writable', () => {
      const uri = draftProvider.initDraft('inst-1', 'job', 'base', true);
      draftProvider.writeFile(uri, Buffer.from('changed'), { create: false, overwrite: true });
      expect(Buffer.from(draftProvider.readFile(uri)).toString('utf8')).toBe('changed');

      const ro = draftProvider.initDraft('inst-1', 'ro', 'base', false);
      expect(() =>
        draftProvider.writeFile(ro, Buffer.from('x'), { create: false, overwrite: true })
      ).toThrow();
    });

    it('round-trips draft uri helper', () => {
      const uri = buildPipelineDraftUri('inst-1', 'a/b');
      expect(uri.scheme).toBe('at-jenkins-draft');
    });
  });
});
