import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  buildBuildLogUri,
  buildPipelineScriptUri,
  parseJenkinsDocumentUri
} from '../../src/document/uri';
import { buildPipelineDraftUri, parsePipelineDraftUri } from '../../src/document/draftUri';

describe('Jenkins Document URI Helpers', () => {
  describe('buildPipelineScriptUri', () => {
    it('builds at-jenkins URI with job in query', () => {
      const uri = buildPipelineScriptUri('inst-1', 'job-alpha');
      expect(uri.scheme).toBe('at-jenkins');
      expect(uri.authority).toBe(encodeURIComponent('inst-1'));
      expect(uri.path).toBe('/Jenkinsfile');
      expect(uri.query).toBe(`job=${encodeURIComponent('job-alpha')}`);
    });

    it('keeps nested jobFullName intact via query', () => {
      const uri = buildPipelineScriptUri('inst#1', 'folder 1/sub folder/job#2');
      expect(parseJenkinsDocumentUri(uri)).toEqual({
        type: 'script',
        instanceId: 'inst#1',
        jobFullName: 'folder 1/sub folder/job#2'
      });
    });
  });

  describe('buildBuildLogUri', () => {
    it('builds at-jenkins log URI with job in query', () => {
      const uri = buildBuildLogUri('inst-1', 'job-alpha', 42);
      expect(uri.scheme).toBe('at-jenkins');
      expect(uri.path).toBe('/42/consoleText');
      expect(parseJenkinsDocumentUri(uri)).toEqual({
        type: 'log',
        instanceId: 'inst-1',
        jobFullName: 'job-alpha',
        buildNumber: 42
      });
    });
  });

  describe('parseJenkinsDocumentUri', () => {
    it('round-trips special characters', () => {
      const instanceId = 'jenkins [prod] & staging';
      const jobFullName = 'ci/cd / test & build / job #1 (release)';
      expect(parseJenkinsDocumentUri(buildPipelineScriptUri(instanceId, jobFullName))).toEqual({
        type: 'script',
        instanceId,
        jobFullName
      });
      expect(parseJenkinsDocumentUri(buildBuildLogUri(instanceId, jobFullName, 999))).toEqual({
        type: 'log',
        instanceId,
        jobFullName,
        buildNumber: 999
      });
    });

    it('returns undefined for non-at-jenkins scheme', () => {
      expect(parseJenkinsDocumentUri(vscode.Uri.file('/tmp/Jenkinsfile'))).toBeUndefined();
    });

    it('returns undefined for unrecognized path', () => {
      const uri = vscode.Uri.from({
        scheme: 'at-jenkins',
        authority: 'inst-1',
        path: '/unknown',
        query: 'job=demo'
      });
      expect(parseJenkinsDocumentUri(uri)).toBeUndefined();
    });
  });

  describe('draft URI', () => {
    it('round-trips nested job names with path-based URI (no authority)', () => {
      const uri = buildPipelineDraftUri('inst-1', 'folder/app/pipeline');
      expect(uri.scheme).toBe('at-jenkins-draft');
      expect(uri.authority).toBe('');
      expect(uri.path).toBe(`/${encodeURIComponent('inst-1')}/Jenkinsfile`);
      expect(parsePipelineDraftUri(uri)).toEqual({
        instanceId: 'inst-1',
        jobFullName: 'folder/app/pipeline'
      });
    });
  });
});
