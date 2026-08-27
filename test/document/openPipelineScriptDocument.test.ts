import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { JENKINS_DRAFT_SCHEME } from '../../src/document/draftUri';
import { JenkinsPipelineDraftFileSystemProvider } from '../../src/document/JenkinsPipelineDraftFileSystemProvider';
import { openPipelineScriptDocument } from '../../src/document/openPipelineScriptDocument';
import { JENKINS_DOCUMENT_SCHEME } from '../../src/document/uri';
import { Unsupported } from '../../src/jenkins/errors';
import type { JenkinsClientPool } from '../../src/jenkins/JenkinsClientPool';

describe('openPipelineScriptDocument', () => {
  let draftProvider: JenkinsPipelineDraftFileSystemProvider;
  let getPipelineScript: ReturnType<typeof vi.fn>;
  let clientPool: { get: ReturnType<typeof vi.fn> };
  let openedUris: vscode.Uri[];

  beforeEach(() => {
    draftProvider = new JenkinsPipelineDraftFileSystemProvider();
    getPipelineScript = vi.fn();
    clientPool = {
      get: vi.fn().mockResolvedValue({ getPipelineScript })
    };
    openedUris = [];

    vi.spyOn(vscode.workspace, 'openTextDocument').mockImplementation(async (target: unknown) => {
      const uri = target instanceof vscode.Uri ? target : (target as { uri: vscode.Uri }).uri;
      openedUris.push(uri);
      return { uri, getText: () => '', languageId: 'plaintext' } as unknown as vscode.TextDocument;
    });
    vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue({} as vscode.TextEditor);
    vi.spyOn(vscode.languages, 'setTextDocumentLanguage').mockImplementation(async (doc) => doc);
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
  });

  it('opens an editable at-jenkins-draft document for controller-stored Pipeline scripts', async () => {
    getPipelineScript.mockResolvedValue({
      script: 'pipeline { agent any }',
      sandbox: true,
      scriptSource: 'stored'
    });

    const doc = await openPipelineScriptDocument({
      instanceId: 'inst-1',
      jobFullName: 'folder/app',
      clientPool: clientPool as unknown as JenkinsClientPool,
      draftProvider
    });

    expect(doc?.uri.scheme).toBe(JENKINS_DRAFT_SCHEME);
    expect(openedUris[0]?.scheme).toBe(JENKINS_DRAFT_SCHEME);
    const draft = draftProvider.getDraft(openedUris[0]!);
    expect(draft?.writable).toBe(true);
    expect(draftProvider.stat(openedUris[0]!).permissions).toBeUndefined();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('does not open a read-only at-jenkins content tab for Unsupported (SCM) jobs', async () => {
    getPipelineScript.mockRejectedValue(
      new Unsupported('Job uses SCM-stored pipeline script (CpsScmFlowDefinition).', {
        jobType: 'CpsScmFlowDefinition',
        operation: 'getPipelineScript'
      })
    );

    const doc = await openPipelineScriptDocument({
      instanceId: 'inst-1',
      jobFullName: 'scm-pipeline',
      clientPool: clientPool as unknown as JenkinsClientPool,
      draftProvider
    });

    expect(doc).toBeUndefined();
    expect(openedUris).toHaveLength(0);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    const message = String(vi.mocked(vscode.window.showErrorMessage).mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/scm-pipeline/i);
    expect(message.toLowerCase()).toMatch(/scm|git|controller/);
    expect(openedUris.every((u) => u.scheme !== JENKINS_DOCUMENT_SCHEME)).toBe(true);
  });
});
