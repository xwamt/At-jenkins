import { describe, expect, it } from 'vitest';
import {
  buildId,
  buildsMoreId,
  folderId,
  jobId
} from '../../src/tree/treeIds';

describe('treeIds', () => {
  it('generates folder tree item id', () => {
    expect(folderId('folder/app')).toBe('folder:folder/app');
    expect(folderId('root-folder')).toBe('folder:root-folder');
  });

  it('generates job tree item id', () => {
    expect(jobId('folder/app')).toBe('job:folder/app');
    expect(jobId('my-job')).toBe('job:my-job');
  });

  it('generates build tree item id', () => {
    expect(buildId('folder/app', 42)).toBe('build:folder/app#42');
    expect(buildId('my-job', 1)).toBe('build:my-job#1');
  });

  it('generates builds-more sentinel tree item id', () => {
    expect(buildsMoreId('folder/app', '10')).toBe('builds-more:folder/app:10');
    expect(buildsMoreId('folder/app', 10)).toBe('builds-more:folder/app:10');
    expect(buildsMoreId('my-job', 20)).toBe('builds-more:my-job:20');
  });
});
