import * as vscode from 'vscode';
import { t } from '../i18n/t';
import {
  buildPipelineDraftUri,
  parsePipelineDraftUri,
  pipelineDraftKey,
  pipelineDraftKeyFromUri
} from './draftUri';

export interface PipelineDraftEntry {
  instanceId: string;
  jobFullName: string;
  content: string;
  baseContent: string;
  writable: boolean;
  ctime: number;
  mtime: number;
}

/**
 * In-memory FileSystemProvider for editable Pipeline script drafts (`at-jenkins-draft:`).
 * Ctrl+S updates local memory via writeFile; publish-to-Jenkins is handled by
 * onDidSaveTextDocument + confirm (see PipelineScriptDocumentProvider.savePipelineScript).
 */
export class JenkinsPipelineDraftFileSystemProvider implements vscode.FileSystemProvider {
  private readonly drafts = new Map<string, PipelineDraftEntry>();
  private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

  readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

  initDraft(
    instanceId: string,
    jobFullName: string,
    script: string,
    writable: boolean
  ): vscode.Uri {
    const uri = buildPipelineDraftUri(instanceId, jobFullName);
    const key = pipelineDraftKey(instanceId, jobFullName);
    const existing = this.drafts.get(key);
    const now = Date.now();
    this.drafts.set(key, {
      instanceId,
      jobFullName,
      content: existing && existing.writable ? existing.content : script,
      baseContent: script,
      writable,
      ctime: existing?.ctime ?? now,
      mtime: now
    });
    return uri;
  }

  getDraft(uri: vscode.Uri): PipelineDraftEntry | undefined {
    const key = pipelineDraftKeyFromUri(uri);
    return key ? this.drafts.get(key) : undefined;
  }

  deleteDraft(uri: vscode.Uri): void {
    const key = pipelineDraftKeyFromUri(uri);
    if (!key) {
      return;
    }
    if (this.drafts.delete(key)) {
      this.onDidChangeFileEmitter.fire([
        {
          type: 2 as vscode.FileChangeType,
          uri
        }
      ]);
    }
  }

  isDirty(uri: vscode.Uri): boolean {
    const draft = this.getDraft(uri);
    return draft ? draft.content !== draft.baseContent : false;
  }

  markClean(uri: vscode.Uri, newBaseContent: string): void {
    const draft = this.getDraft(uri);
    if (!draft) {
      return;
    }
    draft.baseContent = newBaseContent;
    draft.content = newBaseContent;
    draft.mtime = Date.now();
  }

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    return { dispose: () => undefined };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const draft = this.getDraft(uri);
    if (!draft) {
      const target = parsePipelineDraftUri(uri);
      if (!target) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw vscode.FileSystemError.FileNotFound(
        t('Pipeline draft for "{job}" is not currently open.', { job: target.jobFullName })
      );
    }
    return {
      type: 1 as vscode.FileType,
      ctime: draft.ctime,
      mtime: draft.mtime,
      size: Buffer.byteLength(draft.content, 'utf8'),
      // Match nacos-draft: omit permissions when writable (undefined ≠ Readonly).
      permissions: draft.writable ? undefined : vscode.FilePermission.Readonly
    };
  }

  readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(_uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const draft = this.getDraft(uri);
    if (!draft) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return Buffer.from(draft.content, 'utf8');
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean }
  ): void {
    const draft = this.getDraft(uri);
    if (!draft) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (!draft.writable) {
      throw vscode.FileSystemError.NoPermissions(
        t('This pipeline script is read-only (SCM-backed or non-editable job type).')
      );
    }
    draft.content = Buffer.from(content).toString('utf8');
    draft.mtime = Date.now();
    this.onDidChangeFileEmitter.fire([
      {
        type: 0 as vscode.FileChangeType,
        uri
      }
    ]);
  }

  delete(uri: vscode.Uri, _options: { recursive: boolean }): void {
    this.deleteDraft(uri);
  }

  rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean }): void {
    throw vscode.FileSystemError.NoPermissions('Renaming pipeline drafts is not supported.');
  }

  dispose(): void {
    this.drafts.clear();
    this.onDidChangeFileEmitter.dispose();
  }
}
