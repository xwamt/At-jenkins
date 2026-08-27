import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { buildPipelineDraftUri, parsePipelineDraftUri } from '../../src/document/draftUri';
import { JenkinsPipelineDraftFileSystemProvider } from '../../src/document/JenkinsPipelineDraftFileSystemProvider';

describe('JenkinsPipelineDraftFileSystemProvider', () => {
  it('resolves drafts by parsed target even when Uri.toString() differs', () => {
    const provider = new JenkinsPipelineDraftFileSystemProvider();
    const original = provider.initDraft('inst-1', 'folder/app', 'pipeline {}', true);

    // Simulate VS Code re-parsing / re-encoding the same logical URI.
    const reparsed = vscode.Uri.parse(original.toString());
    expect(parsePipelineDraftUri(reparsed)).toEqual({
      instanceId: 'inst-1',
      jobFullName: 'folder/app'
    });

    expect(provider.getDraft(reparsed)?.content).toBe('pipeline {}');
    expect(provider.stat(reparsed).permissions).toBeUndefined();
    expect(() =>
      provider.writeFile(reparsed, Buffer.from('pipeline { agent any }'), {
        create: false,
        overwrite: true
      })
    ).not.toThrow();
    expect(provider.getDraft(original)?.content).toBe('pipeline { agent any }');
  });

  it('uses path-based draft URIs without authority (nacos-draft style)', () => {
    const uri = buildPipelineDraftUri('inst-1', 'folder/app');
    expect(uri.scheme).toBe('at-jenkins-draft');
    expect(uri.authority).toBe('');
    expect(uri.path).toContain('/inst-1/');
    expect(uri.path.endsWith('/Jenkinsfile')).toBe(true);
  });
});
