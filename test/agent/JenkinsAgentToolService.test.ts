import { describe, expect, it, vi } from 'vitest';
import { JenkinsAgentToolService, type JenkinsApiClientLike } from '../../src/agent/JenkinsAgentToolService';
import type { JenkinsInstanceConfig } from '../../src/config/schema';
import { DEFAULT_LOG_TAIL_BYTES } from '../../src/jenkins/types';

const allowedInstance: JenkinsInstanceConfig = {
  id: 'inst-allowed',
  label: 'CI Controller',
  baseUrl: 'http://ci.example.com:8080',
  authMode: 'apiToken',
  username: 'admin',
  verifyTls: true,
  readOnly: false,
  allowBackgroundAccess: true,
  createdAt: 1000,
  updatedAt: 1000
};

const blockedInstance: JenkinsInstanceConfig = {
  id: 'inst-blocked',
  label: 'Prod Controller',
  baseUrl: 'https://prod.example.com',
  authMode: 'password',
  username: 'ops',
  verifyTls: true,
  readOnly: true,
  allowBackgroundAccess: false,
  createdAt: 2000,
  updatedAt: 2000
};

function createMockDeps(clientOverrides: Partial<JenkinsApiClientLike> = {}) {
  const instances = [allowedInstance, blockedInstance];
  const configManager = {
    listInstances: vi.fn().mockResolvedValue(instances),
    getInstance: vi.fn().mockImplementation(async (id: string) => instances.find((i) => i.id === id))
  };

  const client: JenkinsApiClientLike = {
    listJobs: vi.fn().mockResolvedValue([
      {
        name: 'frontend',
        fullName: 'frontend',
        url: 'http://ci.example.com:8080/job/frontend/',
        color: 'blue',
        isFolder: false,
        isBuildable: true,
        isMultibranch: false
      }
    ]),
    getJob: vi.fn().mockResolvedValue({
      name: 'frontend',
      fullName: 'frontend',
      url: 'http://ci.example.com:8080/job/frontend/',
      color: 'blue',
      buildable: true,
      parameters: [
        {
          name: 'ENVIRONMENT',
          type: 'ChoiceParameterDefinition',
          defaultValue: 'staging',
          choices: ['staging', 'production']
        }
      ],
      lastSuccessfulBuild: { number: 42, url: 'http://ci.example.com:8080/job/frontend/42/', building: false, timestamp: 12345, duration: 1000 }
    }),
    getPipelineScript: vi.fn().mockResolvedValue({
      script: 'pipeline { agent any; stages { stage("Build") { steps { echo "hello" } } } }',
      sandbox: true,
      scriptSource: 'stored'
    }),
    listBuilds: vi.fn().mockResolvedValue([
      {
        number: 42,
        url: 'http://ci.example.com:8080/job/frontend/42/',
        result: 'SUCCESS',
        building: false,
        timestamp: 12345,
        duration: 1000
      }
    ]),
    getBuild: vi.fn().mockResolvedValue({
      number: 42,
      url: 'http://ci.example.com:8080/job/frontend/42/',
      result: 'SUCCESS',
      building: false,
      timestamp: 12345,
      duration: 1000,
      description: 'Build #42 release'
    }),
    getBuildLog: vi.fn().mockResolvedValue({
      text: 'Finished: SUCCESS\n',
      startByte: 0,
      endByte: 18,
      totalBytes: 18,
      truncated: false,
      hasMore: false
    }),
    ...clientOverrides
  };

  const clientPool = {
    get: vi.fn().mockResolvedValue(client)
  };

  const service = new JenkinsAgentToolService({
    configManager,
    clientPool
  });

  return { service, client, configManager, clientPool };
}

describe('JenkinsAgentToolService', () => {
  it('jenkins_list_instances returns all instances with public fields and no secrets', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('jenkins_list_instances', {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.result as {
        instances: Array<{
          id: string;
          label: string;
          baseUrl: string;
          readOnly: boolean;
          allowBackgroundAccess: boolean;
        }>;
      };
      expect(data.instances).toHaveLength(2);
      expect(data.instances).toEqual([
        {
          id: 'inst-allowed',
          label: 'CI Controller',
          baseUrl: 'http://ci.example.com:8080',
          readOnly: false,
          allowBackgroundAccess: true
        },
        {
          id: 'inst-blocked',
          label: 'Prod Controller',
          baseUrl: 'https://prod.example.com',
          readOnly: true,
          allowBackgroundAccess: false
        }
      ]);

      const json = JSON.stringify(data);
      expect(json).not.toContain('username');
      expect(json).not.toContain('password');
      expect(json).not.toContain('apiToken');
      expect(json).not.toContain('secret');
    }
  });

  it('rejects access to instances where allowBackgroundAccess is false with actionable message', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('jenkins_list_jobs', { instanceId: 'inst-blocked' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('UNAVAILABLE');
      expect(res.message).toBe(
        'Background access is not enabled for Jenkins instance "Prod Controller" (inst-blocked). Please enable "Allow Agent background access" in the AT Jenkins extension instance settings.'
      );
    }
  });

  it('returns NOT_FOUND when instanceId does not exist', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('jenkins_list_jobs', { instanceId: 'non-existent' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('NOT_FOUND');
      expect(res.message).toContain('non-existent');
    }
  });

  it('jenkins_list_jobs invokes client.listJobs with optional folderFullName', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('jenkins_list_jobs', {
      instanceId: 'inst-allowed',
      folderFullName: 'folder1'
    });
    expect(res.ok).toBe(true);
    expect(client.listJobs).toHaveBeenCalledWith('folder1');
    if (res.ok) {
      const data = res.result as { jobs: unknown[] };
      expect(data.jobs).toHaveLength(1);
    }
  });

  it('jenkins_get_job invokes client.getJob with jobFullName', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('jenkins_get_job', {
      instanceId: 'inst-allowed',
      jobFullName: 'frontend'
    });
    expect(res.ok).toBe(true);
    expect(client.getJob).toHaveBeenCalledWith('frontend');
    if (res.ok) {
      expect(res.result).toMatchObject({
        name: 'frontend',
        fullName: 'frontend'
      });
    }
  });

  it('jenkins_get_pipeline_script invokes client.getPipelineScript', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('jenkins_get_pipeline_script', {
      instanceId: 'inst-allowed',
      jobFullName: 'frontend'
    });
    expect(res.ok).toBe(true);
    expect(client.getPipelineScript).toHaveBeenCalledWith('frontend');
    if (res.ok) {
      expect(res.result).toMatchObject({
        sandbox: true,
        scriptSource: 'stored'
      });
    }
  });

  it('jenkins_list_builds invokes client.listBuilds with pagination options', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('jenkins_list_builds', {
      instanceId: 'inst-allowed',
      jobFullName: 'frontend',
      limit: 5,
      offset: 10
    });
    expect(res.ok).toBe(true);
    expect(client.listBuilds).toHaveBeenCalledWith('frontend', { limit: 5, offset: 10 });
    if (res.ok) {
      const data = res.result as { builds: unknown[] };
      expect(data.builds).toHaveLength(1);
    }
  });

  it('jenkins_get_build invokes client.getBuild with buildNumber', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('jenkins_get_build', {
      instanceId: 'inst-allowed',
      jobFullName: 'frontend',
      buildNumber: 42
    });
    expect(res.ok).toBe(true);
    expect(client.getBuild).toHaveBeenCalledWith('frontend', 42);
    if (res.ok) {
      expect(res.result).toMatchObject({
        number: 42,
        result: 'SUCCESS'
      });
    }
  });

  it('jenkins_get_build_log defaults to DEFAULT_LOG_TAIL_BYTES when tailBytes and start omitted', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('jenkins_get_build_log', {
      instanceId: 'inst-allowed',
      jobFullName: 'frontend',
      buildNumber: 42
    });
    expect(res.ok).toBe(true);
    expect(client.getBuildLog).toHaveBeenCalledWith('frontend', 42, {
      start: undefined,
      tailBytes: DEFAULT_LOG_TAIL_BYTES
    });
  });

  it('jenkins_get_build_log forwards explicit start and tailBytes options', async () => {
    const { service, client } = createMockDeps();
    const res = await service.invoke('jenkins_get_build_log', {
      instanceId: 'inst-allowed',
      jobFullName: 'frontend',
      buildNumber: 42,
      start: 500,
      tailBytes: 2048
    });
    expect(res.ok).toBe(true);
    expect(client.getBuildLog).toHaveBeenCalledWith('frontend', 42, {
      start: 500,
      tailBytes: 2048
    });
  });

  it('returns VALIDATION_ERROR for invalid parameters', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('jenkins_get_job', { instanceId: 'inst-allowed' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns NOT_FOUND for unregistered tool', async () => {
    const { service } = createMockDeps();
    const res = await service.invoke('jenkins_non_existent', {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('NOT_FOUND');
    }
  });
});
