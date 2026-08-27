import { describe, expect, it, vi } from 'vitest';
import { formatJobSummaryMarkdown, JobSummaryDocumentProvider } from '../../src/document/JobSummaryDocumentProvider';
import { buildJobSummaryUri } from '../../src/document/uri';
import type { JenkinsClient } from '../../src/jenkins/JenkinsClient';
import type { JenkinsClientPool } from '../../src/jenkins/JenkinsClientPool';
import type { JobDetail } from '../../src/jenkins/types';

describe('JobSummaryDocumentProvider', () => {
  it('formats description and hides password defaults', () => {
    const job: JobDetail = {
      name: 'hotfix',
      fullName: 'ops/hotfix',
      url: 'https://ci.example.com/job/ops/job/hotfix/',
      _class: 'hudson.model.FreeStyleProject',
      buildable: true,
      color: 'blue',
      description: 'Emergency hotfix job',
      parameters: [
        {
          name: 'BRANCH',
          type: 'StringParameterDefinition',
          defaultValue: 'main'
        },
        {
          name: 'SECRET',
          type: 'PasswordParameterDefinition',
          defaultValue: 'should-not-appear'
        }
      ],
      lastBuild: {
        number: 9,
        url: 'https://ci.example.com/job/ops/job/hotfix/9/',
        building: false,
        result: 'SUCCESS',
        timestamp: 1,
        duration: 1000
      }
    };

    const md = formatJobSummaryMarkdown(job);
    expect(md).toContain('# ops/hotfix');
    expect(md).toContain('Emergency hotfix job');
    expect(md).toContain('BRANCH');
    expect(md).toContain('main');
    expect(md).toContain('SECRET');
    expect(md).not.toContain('should-not-appear');
    expect(md).toContain('(hidden)');
  });

  it('loads summary via content provider', async () => {
    const mockClient = {
      getJob: vi.fn().mockResolvedValue({
        name: 'demo',
        fullName: 'demo',
        url: 'https://ci.example.com/job/demo/',
        buildable: true
      })
    };
    const pool = {
      get: vi.fn().mockResolvedValue(mockClient as unknown as JenkinsClient)
    };
    const provider = new JobSummaryDocumentProvider(pool as unknown as JenkinsClientPool);
    const content = await provider.provideTextDocumentContent(buildJobSummaryUri('inst-1', 'demo'));
    expect(content).toContain('# demo');
    expect(mockClient.getJob).toHaveBeenCalledWith('demo');
  });
});
