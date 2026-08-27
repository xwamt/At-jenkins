import { describe, expect, it, vi } from 'vitest';
import type { JenkinsInstanceConfig } from '../../src/config/schema';
import { AuthError, NotFound, ReadOnly, Unsupported } from '../../src/jenkins/errors';
import { JenkinsAuthenticator } from '../../src/jenkins/JenkinsAuthenticator';
import { buildJobPath, JenkinsClient } from '../../src/jenkins/JenkinsClient';
import { JenkinsClientPool } from '../../src/jenkins/JenkinsClientPool';
import type { JenkinsHttpClient, JenkinsHttpRequest, JenkinsHttpResponse } from '../../src/jenkins/JenkinsHttpClient';

function createMockHttpClient(handler: (req: JenkinsHttpRequest) => Promise<Partial<JenkinsHttpResponse>>): JenkinsHttpClient {
  return {
    request: vi.fn().mockImplementation(async (req: JenkinsHttpRequest): Promise<JenkinsHttpResponse> => {
      const partial = await handler(req);
      const status = partial.status ?? 200;
      const headers = partial.headers ?? {};
      const body = partial.body ?? Buffer.from(partial.text ?? '', 'utf8');
      const text = partial.text ?? body.toString('utf8');
      const ok = status >= 200 && status < 400;
      if (!ok) {
        if (status === 401 || status === 403) {
          throw new AuthError(`HTTP ${status}`, status);
        }
        if (status === 404) {
          throw new NotFound(`HTTP 404`, req.path, status);
        }
        throw new Error(`HTTP ${status}`);
      }
      return {
        status,
        headers,
        body,
        text,
        ok,
        contentType: headers['content-type']
      };
    }),
    requestJson: vi.fn().mockImplementation(async <T>(req: JenkinsHttpRequest): Promise<T> => {
      const partial = await handler(req);
      const status = partial.status ?? 200;
      if (status >= 400) {
        if (status === 401 || status === 403) {
          throw new AuthError(`HTTP ${status}`, status);
        }
        if (status === 404) {
          throw new NotFound(`HTTP 404`, req.path, status);
        }
        throw new Error(`HTTP ${status}`);
      }
      if (partial.text) {
        return JSON.parse(partial.text) as T;
      }
      if (partial.body) {
        return JSON.parse(partial.body.toString('utf8')) as T;
      }
      return undefined as T;
    }),
    requestRaw: vi.fn().mockImplementation(async (req: JenkinsHttpRequest): Promise<JenkinsHttpResponse> => {
      const partial = await handler(req);
      const status = partial.status ?? 200;
      const headers = partial.headers ?? {};
      const body = partial.body ?? Buffer.from(partial.text ?? '', 'utf8');
      const text = partial.text ?? body.toString('utf8');
      return {
        status,
        headers,
        body,
        text,
        ok: status >= 200 && status < 400,
        contentType: headers['content-type']
      };
    })
  } as unknown as JenkinsHttpClient;
}

describe('buildJobPath', () => {
  it('encodes root / single job / nested folder paths', () => {
    expect(buildJobPath('')).toBe('');
    expect(buildJobPath('job1')).toBe('/job/job1');
    expect(buildJobPath('folder1/job2')).toBe('/job/folder1/job/job2');
    expect(buildJobPath('folder1/subfolder2/job3')).toBe('/job/folder1/job/subfolder2/job/job3');
    expect(buildJobPath('/folder1/job2/')).toBe('/job/folder1/job/job2');
    expect(buildJobPath('/a//b///c/')).toBe('/job/a/job/b/job/c');
  });

  it('escapes special characters in job path segments', () => {
    expect(buildJobPath('folder with spaces/job#1/job?2')).toBe(
      '/job/folder%20with%20spaces/job/job%231/job/job%3F2'
    );
  });
});

describe('JenkinsClient API operations', () => {
  const dummyInstanceConfig: JenkinsInstanceConfig = {
    id: 'test-inst',
    label: 'Test Jenkins',
    baseUrl: 'https://ci.example.com',
    authMode: 'none',
    verifyTls: true,
    readOnly: false,
    allowBackgroundAccess: true,
    createdAt: 1000,
    updatedAt: 1000
  };

  it('provides access to instanceConfig via config getter', () => {
    const httpClient = createMockHttpClient(async () => ({ text: '{}' }));
    const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
    const client = new JenkinsClient({ httpClient, authenticator, instanceConfig: dummyInstanceConfig });
    expect(client.config).toEqual(dummyInstanceConfig);
  });

  it('testConnection returns controller nodeName and mode', async () => {
    const httpClient = createMockHttpClient(async (req) => {
      expect(req.path).toBe('/api/json');
      expect(req.query?.tree).toBe('nodeName,mode');
      return { text: JSON.stringify({ nodeName: 'master-1', mode: 'NORMAL' }) };
    });
    const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
    const client = new JenkinsClient({ httpClient, authenticator, instanceConfig: dummyInstanceConfig });

    const result = await client.testConnection();
    expect(result.nodeName).toBe('master-1');
    expect(result.mode).toBe('NORMAL');
  });

  it('listJobs lists root jobs and maps folder/multibranch/buildable flags', async () => {
    const httpClient = createMockHttpClient(async (req) => {
      expect(req.path).toBe('/api/json');
      return {
        text: JSON.stringify({
          jobs: [
            {
              _class: 'hudson.model.FreeStyleProject',
              name: 'freestyle-app',
              url: 'https://ci.example.com/job/freestyle-app/',
              color: 'blue'
            },
            {
              _class: 'com.cloudbees.hudson.plugins.folder.Folder',
              name: 'dev-folder',
              url: 'https://ci.example.com/job/dev-folder/',
              jobs: [{ name: 'sub-job' }]
            },
            {
              _class: 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject',
              name: 'repo-pipeline',
              url: 'https://ci.example.com/job/repo-pipeline/',
              jobs: []
            }
          ]
        })
      };
    });
    const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
    const client = new JenkinsClient({ httpClient, authenticator });

    const jobs = await client.listJobs();
    expect(jobs).toHaveLength(3);

    expect(jobs[0]).toEqual({
      name: 'freestyle-app',
      fullName: 'freestyle-app',
      url: 'https://ci.example.com/job/freestyle-app/',
      color: 'blue',
      _class: 'hudson.model.FreeStyleProject',
      isFolder: false,
      isBuildable: true,
      isMultibranch: false
    });

    expect(jobs[1]).toEqual({
      name: 'dev-folder',
      fullName: 'dev-folder',
      url: 'https://ci.example.com/job/dev-folder/',
      color: undefined,
      _class: 'com.cloudbees.hudson.plugins.folder.Folder',
      isFolder: true,
      isBuildable: false,
      isMultibranch: false
    });

    expect(jobs[2]).toEqual({
      name: 'repo-pipeline',
      fullName: 'repo-pipeline',
      url: 'https://ci.example.com/job/repo-pipeline/',
      color: undefined,
      _class: 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject',
      isFolder: true,
      isBuildable: false,
      isMultibranch: true
    });
  });

  it('listJobs within a subfolder builds nested path and fullNames', async () => {
    const httpClient = createMockHttpClient(async (req) => {
      expect(req.path).toBe('/job/dev-folder/job/team-a/api/json');
      return {
        text: JSON.stringify({
          jobs: [
            {
              _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
              name: 'backend',
              url: 'https://ci.example.com/job/dev-folder/job/team-a/job/backend/',
              color: 'blue'
            }
          ]
        })
      };
    });
    const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
    const client = new JenkinsClient({ httpClient, authenticator });

    const jobs = await client.listJobs('dev-folder/team-a');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe('backend');
    expect(jobs[0]?.fullName).toBe('dev-folder/team-a/backend');
    expect(jobs[0]?.isBuildable).toBe(true);
    expect(jobs[0]?.isFolder).toBe(false);
  });

  it('getJob extracts metadata, parameters, and lastBuild references', async () => {
    const httpClient = createMockHttpClient(async (req) => {
      expect(req.path).toBe('/job/folder/job/my-job/api/json');
      return {
        text: JSON.stringify({
          name: 'my-job',
          _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
          url: 'https://ci.example.com/job/folder/job/my-job/',
          description: 'Main service build',
          color: 'blue',
          buildable: true,
          inQueue: false,
          nextBuildNumber: 43,
          property: [
            {
              _class: 'hudson.model.ParametersDefinitionProperty',
              parameterDefinitions: [
                {
                  _class: 'hudson.model.StringParameterDefinition',
                  name: 'BRANCH',
                  description: 'Target git branch',
                  defaultParameterValue: { value: 'main' }
                },
                {
                  _class: 'hudson.model.ChoiceParameterDefinition',
                  name: 'ENVIRONMENT',
                  description: 'Deploy target',
                  choices: ['staging', 'prod'],
                  defaultParameterValue: { value: 'staging' }
                },
                {
                  _class: 'hudson.model.BooleanParameterDefinition',
                  name: 'RUN_TESTS',
                  description: 'Run test suite',
                  defaultParameterValue: { value: true }
                }
              ]
            }
          ],
          lastBuild: { number: 42, url: 'https://ci.example.com/job/folder/job/my-job/42/' },
          lastSuccessfulBuild: { number: 42, url: 'https://ci.example.com/job/folder/job/my-job/42/' },
          lastFailedBuild: { number: 40, url: 'https://ci.example.com/job/folder/job/my-job/40/' }
        })
      };
    });
    const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
    const client = new JenkinsClient({ httpClient, authenticator });

    const job = await client.getJob('folder/my-job');
    expect(job.name).toBe('my-job');
    expect(job.fullName).toBe('folder/my-job');
    expect(job.description).toBe('Main service build');
    expect(job.buildable).toBe(true);
    expect(job.nextBuildNumber).toBe(43);
    expect(job.parameters).toHaveLength(3);
    expect(job.parameters?.[0]).toEqual({
      name: 'BRANCH',
      type: 'hudson.model.StringParameterDefinition',
      description: 'Target git branch',
      defaultValue: 'main',
      choices: undefined
    });
    expect(job.parameters?.[1]).toEqual({
      name: 'ENVIRONMENT',
      type: 'hudson.model.ChoiceParameterDefinition',
      description: 'Deploy target',
      defaultValue: 'staging',
      choices: ['staging', 'prod']
    });
    expect(job.parameters?.[2]).toEqual({
      name: 'RUN_TESTS',
      type: 'hudson.model.BooleanParameterDefinition',
      description: 'Run test suite',
      defaultValue: true,
      choices: undefined
    });
    expect(job.lastBuild?.number).toBe(42);
    expect(job.lastSuccessfulBuild?.number).toBe(42);
    expect(job.lastFailedBuild?.number).toBe(40);
  });

  it('getJob extracts parameters from actions when property is absent', async () => {
    const httpClient = createMockHttpClient(async () => {
      return {
        text: JSON.stringify({
          name: 'param-action-job',
          url: 'https://ci.example.com/job/param-action-job/',
          actions: [
            {
              parameterDefinitions: [
                {
                  name: 'VERSION',
                  type: 'hudson.model.StringParameterDefinition',
                  description: 'Release version'
                }
              ]
            }
          ]
        })
      };
    });
    const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
    const client = new JenkinsClient({ httpClient, authenticator });

    const job = await client.getJob('param-action-job');
    expect(job.parameters).toEqual([
      {
        name: 'VERSION',
        type: 'hudson.model.StringParameterDefinition',
        description: 'Release version',
        defaultValue: undefined,
        choices: undefined
      }
    ]);
  });

  it('getJob returns undefined parameters when job is parameterless', async () => {
    const httpClient = createMockHttpClient(async () => {
      return {
        text: JSON.stringify({
          name: 'simple-job',
          url: 'https://ci.example.com/job/simple-job/'
        })
      };
    });
    const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
    const client = new JenkinsClient({ httpClient, authenticator });

    const job = await client.getJob('simple-job');
    expect(job.parameters).toBeUndefined();
  });

  describe('getPipelineScript and updatePipelineScript', () => {
    const cpsConfigXml = `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job@1385.vb_58b_86ea_21cf">
  <actions/>
  <description>Demo Pipeline</description>
  <keepDependencies>false</keepDependencies>
  <properties/>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps@3853.vb_a_490d892963">
    <script>pipeline {
    agent any
    stages {
        stage(&apos;Hello&apos;) {
            steps {
                echo &quot;Hello World &amp; Jenkins&quot;
            }
        }
    }
}</script>
    <sandbox>true</sandbox>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>`;

    const scmConfigXml = `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job@1385.vb_58b_86ea_21cf">
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps@3853.vb_a_490d892963">
    <scriptPath>Jenkinsfile</scriptPath>
    <lightweight>true</lightweight>
  </definition>
</flow-definition>`;

    const freestyleXml = `<?xml version='1.1' encoding='UTF-8'?>
<project>
  <actions/>
  <description></description>
  <builders/>
</project>`;

    it('getPipelineScript extracts unescaped script and sandbox from CpsFlowDefinition', async () => {
      const httpClient = createMockHttpClient(async (req) => {
        expect(req.path).toBe('/job/my-pipeline/config.xml');
        return { text: cpsConfigXml, headers: { 'content-type': 'application/xml' } };
      });
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const res = await client.getPipelineScript('my-pipeline');
      expect(res.sandbox).toBe(true);
      expect(res.scriptSource).toBe('stored');
      expect(res.script).toContain(`stage('Hello')`);
      expect(res.script).toContain(`echo "Hello World & Jenkins"`);
    });

    it('getPipelineScript handles CDATA script tags in XML', async () => {
      const cdataXml = `<flow-definition>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition">
    <script><![CDATA[node { echo 'raw <xml> & code' }]]></script>
    <sandbox>false</sandbox>
  </definition>
</flow-definition>`;

      const httpClient = createMockHttpClient(async () => ({ text: cdataXml }));
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const res = await client.getPipelineScript('cdata-job');
      expect(res.script).toBe(`node { echo 'raw <xml> & code' }`);
      expect(res.sandbox).toBe(false);
    });

    it('getPipelineScript handles empty script tag', async () => {
      const emptyScriptXml = `<flow-definition>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition">
    <sandbox>true</sandbox>
  </definition>
</flow-definition>`;

      const httpClient = createMockHttpClient(async () => ({ text: emptyScriptXml }));
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const res = await client.getPipelineScript('empty-job');
      expect(res.script).toBe('');
      expect(res.sandbox).toBe(true);
    });

    it('getPipelineScript throws Unsupported for SCM-based pipeline jobs', async () => {
      const httpClient = createMockHttpClient(async () => ({ text: scmConfigXml }));
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const err = await client.getPipelineScript('scm-pipeline').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Unsupported);
      expect((err as Unsupported).code).toBe('Unsupported');
      expect((err as Unsupported).message).toContain('SCM');
    });

    it('getPipelineScript throws Unsupported for freestyle jobs', async () => {
      const httpClient = createMockHttpClient(async () => ({ text: freestyleXml }));
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const err = await client.getPipelineScript('freestyle-job').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Unsupported);
      expect((err as Unsupported).code).toBe('Unsupported');
    });

    it('updatePipelineScript modifies script inside CpsFlowDefinition and POSTs config.xml', async () => {
      let savedXml = '';
      const httpClient = createMockHttpClient(async (req) => {
        if (req.method === 'GET') {
          return { text: cpsConfigXml };
        }
        if (req.method === 'POST') {
          expect(req.path).toBe('/job/my-pipeline/config.xml');
          expect(req.headers?.['content-type']).toBe('text/xml; charset=UTF-8');
          savedXml = String(req.body);
          return { status: 200, text: '' };
        }
        throw new Error(`Unexpected ${req.method}`);
      });
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const newScript = `pipeline {\n  agent any\n  stages {\n    stage('New') { echo "1 < 2 & 3 > 0" }\n  }\n}`;
      await client.updatePipelineScript('my-pipeline', newScript);

      expect(savedXml).toContain('<script><![CDATA[');
      expect(savedXml).toContain('1 < 2 & 3 > 0');
      expect(savedXml).toContain(']]></script>');
      expect(savedXml).toContain('org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition');
    });

    it('updatePipelineScript preserves Groovy $1 / $env / $class in script (no String.replace $-patterns)', async () => {
      let savedXml = '';
      const httpClient = createMockHttpClient(async (req) => {
        if (req.method === 'GET') {
          return { text: cpsConfigXml };
        }
        if (req.method === 'POST') {
          savedXml = String(req.body);
          return { status: 200, text: '' };
        }
        throw new Error(`Unexpected ${req.method}`);
      });
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      // These $-patterns are special in String.prototype.replace replacement strings and
      // must survive round-trip into config.xml or Jenkins returns HTTP 500 on parse.
      const newScript =
        "echo \"$1 and $& and ${env.BUILD_NUMBER}\"\n[$class: 'Foo']";

      await client.updatePipelineScript('my-pipeline', newScript);

      expect(savedXml).toContain('<![CDATA[');
      expect(savedXml).toContain('$1');
      expect(savedXml).toContain('$&');
      expect(savedXml).toContain('${env.BUILD_NUMBER}');
      expect(savedXml).toContain("$class: 'Foo'");
      expect(savedXml).toContain('<sandbox>true</sandbox>');
    });

    it('updatePipelineScript escapes CDATA terminators inside Groovy scripts', async () => {
      let savedXml = '';
      const httpClient = createMockHttpClient(async (req) => {
        if (req.method === 'GET') {
          return { text: cpsConfigXml };
        }
        if (req.method === 'POST') {
          savedXml = String(req.body);
          return { status: 200, text: '' };
        }
        throw new Error(`Unexpected ${req.method}`);
      });
      const client = new JenkinsClient({
        httpClient,
        authenticator: new JenkinsAuthenticator({ authMode: 'none' })
      });

      await client.updatePipelineScript('my-pipeline', 'echo "]]>"');
      expect(savedXml).toContain(']]]]><![CDATA[>');
      expect(savedXml).toContain('<![CDATA[');
    });

    it('updatePipelineScript throws ReadOnly when instance is configured readOnly', async () => {
      const httpClient = createMockHttpClient(async () => ({ text: cpsConfigXml }));
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const readOnlyConfig: JenkinsInstanceConfig = {
        ...dummyInstanceConfig,
        readOnly: true
      };
      const client = new JenkinsClient({ httpClient, authenticator, instanceConfig: readOnlyConfig });

      const err = await client.updatePipelineScript('my-pipeline', 'node {}').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReadOnly);
      expect((err as ReadOnly).code).toBe('ReadOnly');
    });

    it('updatePipelineScript throws Unsupported for non-CpsFlowDefinition jobs', async () => {
      const httpClient = createMockHttpClient(async () => ({ text: scmConfigXml }));
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const err = await client.updatePipelineScript('scm-pipeline', 'node {}').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Unsupported);
    });
  });

  describe('listBuilds and getBuild', () => {
    it('listBuilds requests builds tree and supports offset and limit pagination', async () => {
      const httpClient = createMockHttpClient(async (req) => {
        expect(req.path).toBe('/job/folder/job/app/api/json');
        return {
          text: JSON.stringify({
            builds: [
              { number: 5, result: 'SUCCESS', building: false, timestamp: 5000, duration: 100, url: '.../5/' },
              { number: 4, result: 'FAILURE', building: false, timestamp: 4000, duration: 200, url: '.../4/' },
              { number: 3, result: 'UNSTABLE', building: false, timestamp: 3000, duration: 150, url: '.../3/' },
              { number: 2, result: null, building: true, timestamp: 2000, duration: 50, url: '.../2/' },
              { number: 1, result: 'SUCCESS', building: false, timestamp: 1000, duration: 120, url: '.../1/' }
            ]
          })
        };
      });
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const all = await client.listBuilds('folder/app');
      expect(all).toHaveLength(5);

      const paged = await client.listBuilds('folder/app', { offset: 1, limit: 2 });
      expect(paged).toHaveLength(2);
      expect(paged[0]?.number).toBe(4);
      expect(paged[1]?.number).toBe(3);
    });

    it('getBuild retrieves detailed build status', async () => {
      const httpClient = createMockHttpClient(async (req) => {
        expect(req.path).toBe('/job/folder/job/app/42/api/json');
        return {
          text: JSON.stringify({
            number: 42,
            result: 'SUCCESS',
            building: false,
            timestamp: 1700000000000,
            duration: 45000,
            estimatedDuration: 40000,
            displayName: '#42',
            fullDisplayName: 'folder » app #42',
            description: 'Nightly deploy',
            url: 'https://ci.example.com/job/folder/job/app/42/',
            artifacts: [
              {
                displayPath: 'app.jar',
                fileName: 'app.jar',
                relativePath: 'target/app.jar',
                size: 1024000
              }
            ]
          })
        };
      });
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const build = await client.getBuild('folder/app', 42);
      expect(build.number).toBe(42);
      expect(build.result).toBe('SUCCESS');
      expect(build.building).toBe(false);
      expect(build.duration).toBe(45000);
      expect(build.description).toBe('Nightly deploy');
      expect(build.artifacts).toHaveLength(1);
      expect(build.artifacts?.[0]?.fileName).toBe('app.jar');
    });
  });

  describe('getBuildLog', () => {
    it('fetches consoleText and applies log truncation', async () => {
      const logContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n';
      const httpClient = createMockHttpClient(async (req) => {
        expect(req.path).toBe('/job/demo/10/consoleText');
        return { text: logContent };
      });
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const log = await client.getBuildLog('demo', 10, { tailBytes: 15 });
      expect(log.truncated).toBe(true);
      expect(log.text.length).toBe(15);
      expect(log.totalBytes).toBe(Buffer.byteLength(logContent));
    });

    it('maps HTTP 401 on consoleText to AuthError', async () => {
      const httpClient = createMockHttpClient(async () => ({ status: 401, text: 'login form' }));
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });
      await expect(client.getBuildLog('demo', 10)).rejects.toBeInstanceOf(AuthError);
    });

    it('maps HTTP 404 on consoleText to NotFound', async () => {
      const httpClient = createMockHttpClient(async () => ({ status: 404, text: 'not found' }));
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });
      await expect(client.getBuildLog('demo', 99)).rejects.toBeInstanceOf(NotFound);
    });
  });

  describe('triggerBuild and stopBuild', () => {
    it('triggerBuild without params sends POST /job/{name}/build and extracts queueUrl', async () => {
      const httpClient = createMockHttpClient(async (req) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/job/demo/build');
        return {
          status: 201,
          headers: { location: 'https://ci.example.com/queue/item/108/' }
        };
      });
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const res = await client.triggerBuild('demo');
      expect(res.queueUrl).toBe('https://ci.example.com/queue/item/108/');
    });

    it('triggerBuild with params sends POST /job/{name}/buildWithParameters with form data', async () => {
      let sentForm: Record<string, string> | undefined;
      const httpClient = createMockHttpClient(async (req) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/job/demo/buildWithParameters');
        sentForm = req.form;
        return {
          status: 201,
          headers: { location: 'https://ci.example.com/queue/item/109/' }
        };
      });
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      const res = await client.triggerBuild('demo', { BRANCH: 'develop', RUN_TESTS: true, RETRIES: 3 });
      expect(res.queueUrl).toBe('https://ci.example.com/queue/item/109/');
      expect(sentForm).toEqual({
        BRANCH: 'develop',
        RUN_TESTS: 'true',
        RETRIES: '3'
      });
    });

    it('triggerBuild throws ReadOnly when instance is readOnly', async () => {
      const httpClient = createMockHttpClient(async () => ({ status: 200 }));
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const readOnlyConfig: JenkinsInstanceConfig = { ...dummyInstanceConfig, readOnly: true };
      const client = new JenkinsClient({ httpClient, authenticator, instanceConfig: readOnlyConfig });

      const err = await client.triggerBuild('demo').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReadOnly);
    });

    it('stopBuild sends POST /job/{name}/{buildNumber}/stop', async () => {
      let stopCalled = false;
      const httpClient = createMockHttpClient(async (req) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/job/demo/42/stop');
        stopCalled = true;
        return { status: 200, text: '' };
      });
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const client = new JenkinsClient({ httpClient, authenticator });

      await client.stopBuild('demo', 42);
      expect(stopCalled).toBe(true);
    });

    it('stopBuild throws ReadOnly when instance is readOnly', async () => {
      const httpClient = createMockHttpClient(async () => ({ status: 200 }));
      const authenticator = new JenkinsAuthenticator({ authMode: 'none' });
      const readOnlyConfig: JenkinsInstanceConfig = { ...dummyInstanceConfig, readOnly: true };
      const client = new JenkinsClient({ httpClient, authenticator, instanceConfig: readOnlyConfig });

      const err = await client.stopBuild('demo', 42).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReadOnly);
    });
  });
});

describe('JenkinsClientPool', () => {
  class MockConfigManager {
    private instances = new Map<string, JenkinsInstanceConfig>();
    private apiTokens = new Map<string, string>();
    private passwords = new Map<string, string>();

    setInstance(config: JenkinsInstanceConfig, apiToken?: string, password?: string) {
      this.instances.set(config.id, config);
      if (apiToken) this.apiTokens.set(config.id, apiToken);
      if (password) this.passwords.set(config.id, password);
    }

    async getInstance(id: string): Promise<JenkinsInstanceConfig | undefined> {
      return this.instances.get(id);
    }

    async getApiToken(id: string): Promise<string | undefined> {
      return this.apiTokens.get(id);
    }

    async getPassword(id: string): Promise<string | undefined> {
      return this.passwords.get(id);
    }
  }

  it('creates and caches JenkinsClient per instanceId', async () => {
    const configManager = new MockConfigManager();
    const inst1: JenkinsInstanceConfig = {
      id: 'i1',
      label: 'Jenkins 1',
      baseUrl: 'https://jenkins1.example.com',
      authMode: 'apiToken',
      username: 'alice',
      verifyTls: true,
      readOnly: false,
      allowBackgroundAccess: true,
      createdAt: 1000,
      updatedAt: 1000
    };
    configManager.setInstance(inst1, 'token-1');

    const pool = new JenkinsClientPool(configManager as any);
    const client1 = await pool.get('i1');
    expect(client1).toBeInstanceOf(JenkinsClient);

    const client2 = await pool.get('i1');
    expect(client1).toBe(client2); // Cached instance
  });

  it('creates client with password authentication mode', async () => {
    const configManager = new MockConfigManager();
    const inst1: JenkinsInstanceConfig = {
      id: 'i-pass',
      label: 'Jenkins Pass',
      baseUrl: 'https://jenkins-pass.example.com',
      authMode: 'password',
      username: 'admin',
      verifyTls: true,
      readOnly: false,
      allowBackgroundAccess: true,
      createdAt: 1000,
      updatedAt: 1000
    };
    configManager.setInstance(inst1, undefined, 'super-secret-password');

    const pool = new JenkinsClientPool(configManager as any);
    const client = await pool.get('i-pass');
    expect(client).toBeInstanceOf(JenkinsClient);
  });

  it('recreates client when instance config is updated', async () => {
    const configManager = new MockConfigManager();
    const inst1: JenkinsInstanceConfig = {
      id: 'i1',
      label: 'Jenkins 1',
      baseUrl: 'https://jenkins1.example.com',
      authMode: 'apiToken',
      username: 'alice',
      verifyTls: true,
      readOnly: false,
      allowBackgroundAccess: true,
      createdAt: 1000,
      updatedAt: 1000
    };
    configManager.setInstance(inst1, 'token-1');

    const pool = new JenkinsClientPool(configManager as any);
    const client1 = await pool.get('i1');

    // Instance updated with new timestamp
    const updatedInst: JenkinsInstanceConfig = {
      ...inst1,
      baseUrl: 'https://jenkins1-new.example.com',
      updatedAt: 2000
    };
    configManager.setInstance(updatedInst, 'token-1');

    const client2 = await pool.get('i1');
    expect(client2).not.toBe(client1);
  });

  it('evict and clear remove clients from cache', async () => {
    const configManager = new MockConfigManager();
    const inst1: JenkinsInstanceConfig = {
      id: 'i1',
      label: 'Jenkins 1',
      baseUrl: 'https://jenkins1.example.com',
      authMode: 'none',
      verifyTls: true,
      readOnly: false,
      allowBackgroundAccess: true,
      createdAt: 1000,
      updatedAt: 1000
    };
    configManager.setInstance(inst1);

    const pool = new JenkinsClientPool(configManager as any);
    const client1 = await pool.get('i1');

    pool.evict('i1');
    const client2 = await pool.get('i1');
    expect(client2).not.toBe(client1);

    pool.clear();
    const client3 = await pool.get('i1');
    expect(client3).not.toBe(client2);
  });

  it('throws NotFound when instanceId does not exist', async () => {
    const configManager = new MockConfigManager();
    const pool = new JenkinsClientPool(configManager as any);

    await expect(pool.get('non-existent')).rejects.toThrow(NotFound);
  });
});
