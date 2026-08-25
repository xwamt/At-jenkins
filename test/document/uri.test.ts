import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  buildBuildLogUri,
  buildPipelineScriptUri,
  parseJenkinsDocumentUri
} from '../../src/document/uri';

describe('Jenkins Document URI Helpers', () => {
  describe('buildPipelineScriptUri', () => {
    it('builds valid at-jenkins URI for top-level job', () => {
      const uri = buildPipelineScriptUri('inst-1', 'job-alpha');
      expect(uri.scheme).toBe('at-jenkins');
      expect(uri.path).toBe('/inst-1/job-alpha/Jenkinsfile');
    });

    it('encodes folder-nested jobFullName and instanceId with special chars', () => {
      const uri = buildPipelineScriptUri('inst#1', 'folder 1/sub folder/job#2');
      expect(uri.scheme).toBe('at-jenkins');
      expect(uri.path).toBe(
        `/${encodeURIComponent('inst#1')}/${encodeURIComponent('folder 1/sub folder/job#2')}/Jenkinsfile`
      );
    });
  });

  describe('buildBuildLogUri', () => {
    it('builds valid at-jenkins URI for build log', () => {
      const uri = buildBuildLogUri('inst-1', 'job-alpha', 42);
      expect(uri.scheme).toBe('at-jenkins');
      expect(uri.path).toBe('/inst-1/job-alpha/42/consoleText');
    });

    it('encodes folder-nested jobFullName for build log', () => {
      const uri = buildBuildLogUri('inst-prod', 'infra/deploy/k8s-app', 105);
      expect(uri.scheme).toBe('at-jenkins');
      expect(uri.path).toBe(
        `/${encodeURIComponent('inst-prod')}/${encodeURIComponent('infra/deploy/k8s-app')}/105/consoleText`
      );
    });
  });

  describe('parseJenkinsDocumentUri', () => {
    it('parses pipeline script URI correctly', () => {
      const uri = buildPipelineScriptUri('dev-server', 'team-a/backend-api');
      const parsed = parseJenkinsDocumentUri(uri);
      expect(parsed).toEqual({
        type: 'script',
        instanceId: 'dev-server',
        jobFullName: 'team-a/backend-api'
      });
    });

    it('parses build log URI correctly', () => {
      const uri = buildBuildLogUri('dev-server', 'team-a/backend-api', 123);
      const parsed = parseJenkinsDocumentUri(uri);
      expect(parsed).toEqual({
        type: 'log',
        instanceId: 'dev-server',
        jobFullName: 'team-a/backend-api',
        buildNumber: 123
      });
    });

    it('handles special characters in instanceId and jobFullName in roundtrip', () => {
      const instanceId = 'jenkins [prod] & staging';
      const jobFullName = 'ci/cd / test & build / job #1 (release)';
      const scriptUri = buildPipelineScriptUri(instanceId, jobFullName);
      expect(parseJenkinsDocumentUri(scriptUri)).toEqual({
        type: 'script',
        instanceId,
        jobFullName
      });

      const logUri = buildBuildLogUri(instanceId, jobFullName, 999);
      expect(parseJenkinsDocumentUri(logUri)).toEqual({
        type: 'log',
        instanceId,
        jobFullName,
        buildNumber: 999
      });
    });

    it('returns undefined for non-at-jenkins scheme', () => {
      const fileUri = vscode.Uri.file('/tmp/Jenkinsfile');
      expect(parseJenkinsDocumentUri(fileUri)).toBeUndefined();
    });

    it('returns undefined for unrecognized path format or missing segments', () => {
      const uri1 = vscode.Uri.from({ scheme: 'at-jenkins', path: '/inst-1' });
      expect(parseJenkinsDocumentUri(uri1)).toBeUndefined();

      const uri2 = vscode.Uri.from({ scheme: 'at-jenkins', path: '/inst-1/job-1/unknownFile' });
      expect(parseJenkinsDocumentUri(uri2)).toBeUndefined();

      const uri3 = vscode.Uri.from({ scheme: 'at-jenkins', path: '/inst-1/job-1/notANumber/consoleText' });
      expect(parseJenkinsDocumentUri(uri3)).toBeUndefined();

      const uri4 = vscode.Uri.from({ scheme: 'at-jenkins', path: '' });
      expect(parseJenkinsDocumentUri(uri4)).toBeUndefined();
    });
  });
});
