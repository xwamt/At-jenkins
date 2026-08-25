# AT Jenkins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `at-jenkins` — a VS Code/Cursor extension that manages multiple Jenkins 2.x controllers (browse Folder/Job/Build, edit controller-stored Pipeline scripts, trigger/cancel builds, follow logs) and exposes seven **read-only** MCP tools via `@at-series/mcp-hub`.

**Architecture:** Nacos-aligned skeleton: `JenkinsInstanceConfigManager` + SecretStorage, HttpClient with TOFU, single `JenkinsClient` façade (no multi-driver chain), dual Activity Bar views (Instances + Jobs), virtual documents for script/log, localhost Bridge + Hub registration. UI owns all mutations; MCP never triggers or edits.

**Tech Stack:** TypeScript 5.x strict, vitest, zod, esbuild, `@at-series/mcp-hub` ^0.3.2, VS Code `^1.85.0`, `vscode.l10n`

**Spec:** `docs/superpowers/specs/2026-08-25-at-jenkins-design.md`

**TDD:** Every task writes a failing test first, watches RED, then implements. Commits use HEREDOC. Never update git config. Never skip hooks.

**Scaffold source:** Copy patterns from `/Users/clkj/项目/at/at-nacos-series` (same parent folder as this repo). Prefer adapting over reinventing Bridge/TOFU/i18n.

---

## File map

| Path | Responsibility |
|---|---|
| `package.json` | Extension manifest: `atJenkins` views/commands, single MCP-capable build |
| `package.nls.json` / `package.nls.zh-cn.json` | Contribute string keys |
| `l10n/bundle.l10n.zh-cn.json` | Runtime `t()` translations |
| `esbuild.config.mjs` | Bundle `src/extension.ts` + webview entries → `dist/` |
| `tsconfig.json` / `vitest.config.ts` | Strict TS; alias `vscode` → `test-fixtures/vscode.ts` |
| `test-fixtures/vscode.ts` | Minimal vscode mock (copy from nacos) |
| `src/extension.ts` | Activate: config, trees, documents, MCP bridge lifecycle |
| `src/config/schema.ts` | Zod: `JenkinsInstanceConfig`, auth modes |
| `src/config/JenkinsInstanceConfigManager.ts` | CRUD instances, secrets, activeInstanceId |
| `src/utils/url.ts` | Strip userinfo, trailing slashes |
| `src/utils/logger.ts` | Redacting logger (adapt nacos) |
| `src/i18n/t.ts` | `vscode.l10n.t` wrapper |
| `src/jenkins/errors.ts` | `AuthError`, `TlsError`, `NotFound`, `Unsupported`, `DeniedBackground`, `ReadOnly`, `Truncated` |
| `src/jenkins/JenkinsCertTrustStore.ts` | TOFU fingerprints under `atJenkins.tofu.fingerprints` |
| `src/jenkins/createInteractiveCertVerifier.ts` | UI prompt on unknown/changed cert |
| `src/jenkins/JenkinsHttpClient.ts` | http(s) request helper + TLS hook |
| `src/jenkins/JenkinsAuthenticator.ts` | none / apiToken Basic / password+crumb |
| `src/jenkins/types.ts` | Domain: JobSummary, BuildSummary, PipelineScript, etc. |
| `src/jenkins/JenkinsClient.ts` | Façade: listJobs, getJob, get/update script, builds, log, build, stop |
| `src/jenkins/JenkinsClientPool.ts` | Per-instanceId client cache |
| `src/jenkins/logTruncate.ts` | Tail / start byte helpers for MCP + UI |
| `src/tree/InstancesTreeProvider.ts` | Instance list; click → set active |
| `src/tree/JobsTreeProvider.ts` | Folder→Job→Build + load-more |
| `src/tree/treeIds.ts` | Stable id helpers |
| `src/document/PipelineScriptDocumentProvider.ts` | Virtual Jenkinsfile; save → API |
| `src/document/BuildLogDocumentProvider.ts` | Read-only consoleText + progressive poll |
| `src/webview/JenkinsInstancePanel.ts` | Add/edit instance form host |
| `webview/jenkins-instance-form/*` | Form UI (authMode, secrets, flags) |
| `src/agent/JenkinsAgentToolService.ts` | MCP invoke implementations + gates |
| `src/mcp/toolCatalog.ts` | `at.jenkins` + seven tools |
| `src/mcp/bridgeSchemas.ts` | Zod/JSON Schema for tool inputs |
| `src/mcp/BridgeServer.ts` | health/tools/invoke (adapt nacos) |
| `src/mcp/BridgeProtocol.ts` | Shared types |
| `src/mcp/hubSync.ts` / `McpConfigInstaller.ts` | Hub bundle + MCP config |
| `media/*` | Icon + activity bar SVG |
| `test/**/*.test.ts` | Vitest coverage per module |
| `README.md` / `CHANGELOG.md` / `docs/features.md` | User docs (Task 12) |

**Out of this plan:** Stage timeline webview, dual VSIX, SSO/custom headers, Agent/credential/plugin admin, workspace Jenkinsfile sync, Jenkins 1.x.

---

### Task 1: Repo scaffold + empty extension

**Files:**
- Create: `package.json`, `package.nls.json`, `package.nls.zh-cn.json`, `tsconfig.json`, `vitest.config.ts`, `esbuild.config.mjs`, `.gitignore`, `.vscodeignore`, `test-fixtures/vscode.ts`, `src/extension.ts`, `src/i18n/t.ts`, `media/at-jenkins-activity.svg`, `media/at-jenkins-icon.png` (placeholder OK), `test/extension.smoke.test.ts`
- Create: git repo at `at-jenkins-series`

- [ ] **Step 1: Initialize git and ignore clutter**

```bash
cd /Users/clkj/项目/at/at-jenkins-series
git init
```

`.gitignore`:

```
node_modules/
dist/
*.vsix
.DS_Store
.superpowers/
```

- [ ] **Step 2: Write failing smoke test**

`test/extension.smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('at-jenkins scaffold', () => {
  it('exports activate', async () => {
    const mod = await import('../src/extension');
    expect(typeof mod.activate).toBe('function');
    expect(typeof mod.deactivate).toBe('function');
  });
});
```

- [ ] **Step 3: Run test — expect FAIL (module missing)**

```bash
cd /Users/clkj/项目/at/at-jenkins-series
npm init -y
npm install -D typescript vitest esbuild @types/node @types/vscode
npm install zod @at-series/mcp-hub@^0.3.2
```

`vitest.config.ts` — copy from nacos (alias `vscode` → `test-fixtures/vscode.ts`). Copy `test-fixtures/vscode.ts` from nacos.

Run: `npx vitest run test/extension.smoke.test.ts`  
Expected: FAIL cannot find `../src/extension`

- [ ] **Step 4: Minimal `src/extension.ts` + package.json contributes**

`src/extension.ts`:

```ts
import type * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {
  // wired in later tasks
}

export function deactivate(): void {}
```

`package.json` essentials (full contributes grow in later tasks):

```json
{
  "name": "at-jenkins",
  "displayName": "%atJenkins.displayName%",
  "description": "%atJenkins.description%",
  "version": "0.1.0",
  "publisher": "local",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "keywords": ["jenkins", "pipeline", "mcp", "at-series"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "l10n": "./l10n",
  "contributes": {
    "viewsContainers": {
      "activitybar": [{
        "id": "atJenkins",
        "title": "%atJenkins.viewsContainer.title%",
        "icon": "media/at-jenkins-activity.svg"
      }]
    },
    "views": {
      "atJenkins": [
        { "id": "atJenkins.instances", "name": "%atJenkins.view.instances.name%" },
        { "id": "atJenkins.jobs", "name": "%atJenkins.view.jobs.name%" }
      ]
    }
  },
  "scripts": {
    "compile": "node esbuild.config.mjs",
    "test": "vitest run",
    "package": "npm run compile && npx @vscode/vsce package --no-dependencies"
  }
}
```

Add nls keys for displayName/description/views. Wire `esbuild.config.mjs` like nacos but only `src/extension.ts` entry for now.

- [ ] **Step 5: Re-run smoke test — PASS**

```bash
npx vitest run test/extension.smoke.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: scaffold at-jenkins extension package

EOF
)"
```

---

### Task 2: Config schema + InstanceConfigManager

**Files:**
- Create: `src/config/schema.ts`, `src/config/JenkinsInstanceConfigManager.ts`, `src/utils/url.ts`, `src/utils/logger.ts`
- Test: `test/config/schema.test.ts`, `test/config/JenkinsInstanceConfigManager.test.ts`, `test/utils/url.test.ts`

- [ ] **Step 1: Failing URL + schema tests**

`test/utils/url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeJenkinsBaseUrl } from '../../src/utils/url';

describe('normalizeJenkinsBaseUrl', () => {
  it('strips trailing slashes and URL userinfo', () => {
    expect(normalizeJenkinsBaseUrl('https://admin:secret@ci.example.com:8443/jenkins/')).toBe(
      'https://ci.example.com:8443/jenkins'
    );
  });
});
```

`test/config/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseJenkinsInstanceConfig } from '../../src/config/schema';

describe('parseJenkinsInstanceConfig', () => {
  it('defaults readOnly and allowBackgroundAccess to false', () => {
    const cfg = parseJenkinsInstanceConfig({
      id: 'i1',
      label: 'prod',
      baseUrl: 'https://ci.example.com',
      authMode: 'apiToken',
      username: 'bot',
      verifyTls: true,
      createdAt: 1,
      updatedAt: 1
    });
    expect(cfg.readOnly).toBe(false);
    expect(cfg.allowBackgroundAccess).toBe(false);
  });
});
```

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/utils/url.test.ts test/config/schema.test.ts
```

- [ ] **Step 3: Implement `normalizeJenkinsBaseUrl` + schema**

`src/utils/url.ts` — adapt nacos `stripUrlCredentials`; export `normalizeJenkinsBaseUrl`.

`src/config/schema.ts`:

```ts
import { z } from 'zod';
import { normalizeJenkinsBaseUrl } from '../utils/url';

export const JENKINS_AUTH_MODES = ['none', 'apiToken', 'password'] as const;
export type JenkinsAuthMode = (typeof JENKINS_AUTH_MODES)[number];

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => normalizeJenkinsBaseUrl(value))
  .refine((value) => /^https?:\/\//i.test(value), 'URL must start with http:// or https://');

export const jenkinsInstanceConfigSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    baseUrl: httpUrlSchema,
    authMode: z.enum(JENKINS_AUTH_MODES),
    username: z.string().trim().optional(),
    verifyTls: z.boolean(),
    readOnly: z.boolean().default(false),
    allowBackgroundAccess: z.boolean().default(false),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strip();

export type JenkinsInstanceConfig = z.infer<typeof jenkinsInstanceConfigSchema>;
export const jenkinsInstanceConfigListSchema = z.array(jenkinsInstanceConfigSchema);
export function parseJenkinsInstanceConfig(value: unknown): JenkinsInstanceConfig {
  return jenkinsInstanceConfigSchema.parse(value);
}
export function parseJenkinsInstanceConfigList(value: unknown): JenkinsInstanceConfig[] {
  return jenkinsInstanceConfigListSchema.parse(value);
}
```

- [ ] **Step 4: Failing manager test then implement**

Test create/list/update/delete, secret store keys `atJenkins.secret.apiToken.<id>` / `atJenkins.secret.password.<id>`, `getActiveInstanceId` / `setActiveInstanceId`, empty secret on update means keep previous. Adapt structure from `NacosInstanceConfigManager` (drop customHeaders/akSk). Keys:

- `atJenkins.instances`
- `atJenkins.activeInstanceId`

Label rule: `trim()`; if empty after save input, use `hostname` from `baseUrl`.

- [ ] **Step 5: Tests PASS + commit**

```bash
npx vitest run test/utils/url.test.ts test/config/
git add src/config src/utils test/config test/utils
git commit -m "$(cat <<'EOF'
feat: add jenkins instance config schema and manager

EOF
)"
```

---

### Task 3: Errors + TOFU cert trust store

**Files:**
- Create: `src/jenkins/errors.ts`, `src/jenkins/JenkinsCertTrustStore.ts`
- Test: `test/jenkins/errors.test.ts`, `test/jenkins/JenkinsCertTrustStore.test.ts`

- [ ] **Step 1: Failing trust-store test**

```ts
import { describe, expect, it } from 'vitest';
import { JenkinsCertTrustStore } from '../../src/jenkins/JenkinsCertTrustStore';

class Mem {
  private data = new Map<string, unknown>();
  get<T>(key: string, def: T): T {
    return (this.data.has(key) ? this.data.get(key) : def) as T;
  }
  async update(key: string, value: unknown) {
    this.data.set(key, value);
  }
}

describe('JenkinsCertTrustStore', () => {
  it('returns unknown then trusted after trust()', async () => {
    const store = new JenkinsCertTrustStore(new Mem());
    expect(await store.check('ci.example.com', 443, 'fp1')).toBe('unknown');
    await store.trust('ci.example.com', 443, 'fp1');
    expect(await store.check('ci.example.com', 443, 'fp1')).toBe('trusted');
    expect(await store.check('ci.example.com', 443, 'fp2')).toBe('changed');
  });
});
```

- [ ] **Step 2: RED → implement**

Copy/adapt `NacosCertTrustStore` → `JenkinsCertTrustStore`, key `atJenkins.tofu.fingerprints`.

`errors.ts` — export classes with `code` discriminant matching spec §8.

- [ ] **Step 3: PASS + commit**

```bash
npx vitest run test/jenkins/JenkinsCertTrustStore.test.ts test/jenkins/errors.test.ts
git add src/jenkins/errors.ts src/jenkins/JenkinsCertTrustStore.ts test/jenkins
git commit -m "$(cat <<'EOF'
feat: add jenkins error types and TOFU cert trust store

EOF
)"
```

---

### Task 4: HttpClient + interactive cert verifier

**Files:**
- Create: `src/jenkins/JenkinsHttpClient.ts`, `src/jenkins/createInteractiveCertVerifier.ts`
- Test: `test/jenkins/JenkinsHttpClient.test.ts` (injectable `request` / mock `https`)

- [ ] **Step 1: Failing test — Basic auth header + JSON parse**

Use injectable fetch-like or undici-style mock. Assert:

- `verifyTls: true` uses default agent
- GET relative path joins `baseUrl`
- 401 maps to `AuthError`
- 404 maps to `NotFound`

Adapt from `NacosHttpClient` tests; keep surface minimal:

```ts
export interface JenkinsHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string; // absolute path on controller, e.g. /job/foo/api/json
  headers?: Record<string, string>;
  body?: string | Buffer;
  query?: Record<string, string | number | undefined>;
}

export class JenkinsHttpClient {
  constructor(
    private readonly opts: {
      baseUrl: string;
      verifyTls: boolean;
      certVerifier?: { verify(host: string, port: number, fp: string): Promise<boolean> };
    },
    private readonly transport?: /* test seam */
  ) {}

  request(req: JenkinsHttpRequest): Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
  requestJson<T>(req: JenkinsHttpRequest): Promise<T>;
}
```

- [ ] **Step 2: Implement + PASS**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add jenkins http client with TLS TOFU hook

EOF
)"
```

---

### Task 5: Authenticator (none / apiToken / password+crumb)

**Files:**
- Create: `src/jenkins/JenkinsAuthenticator.ts`
- Test: `test/jenkins/JenkinsAuthenticator.test.ts`

- [ ] **Step 1: Failing tests**

```ts
it('apiToken sends Authorization Basic username:token', async () => { /* ... */ });
it('password fetches crumb and attaches Jenkins-Crumb on POST', async () => { /* ... */ });
it('none sends no Authorization', async () => { /* ... */ });
it('clears crumb and retries once on 401 for password mode', async () => { /* ... */ });
```

Crumb endpoint: `GET {baseUrl}/crumbIssuer/api/json` → `{ crumb, crumbRequestField }`.  
Attach header `{ [crumbRequestField]: crumb }` on mutating requests.

- [ ] **Step 2: Implement `applyAuth(headers, method)` + crumb cache**

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add jenkins authenticator for token password and none

EOF
)"
```

---

### Task 6: JenkinsClient façade + log truncation

**Files:**
- Create: `src/jenkins/types.ts`, `src/jenkins/logTruncate.ts`, `src/jenkins/JenkinsClient.ts`, `src/jenkins/JenkinsClientPool.ts`
- Test: `test/jenkins/logTruncate.test.ts`, `test/jenkins/JenkinsClient.test.ts`

- [ ] **Step 1: logTruncate failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { truncateBuildLog } from '../../src/jenkins/logTruncate';

describe('truncateBuildLog', () => {
  it('returns tail bytes by default and marks truncated', () => {
    const raw = Buffer.from('a'.repeat(1000));
    const r = truncateBuildLog(raw, { tailBytes: 100 });
    expect(r.text.length).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.totalBytes).toBe(1000);
  });

  it('supports start offset', () => {
    const raw = Buffer.from('abcdefghij');
    const r = truncateBuildLog(raw, { start: 5, tailBytes: 1000 });
    expect(r.text).toBe('fghij');
    expect(r.truncated).toBe(false);
  });
});
```

Default MCP constant: `DEFAULT_LOG_TAIL_BYTES = 64 * 1024`.

- [ ] **Step 2: Client failing tests with mocked HttpClient**

Cover:

| Method | Jenkins API (indicative) |
|---|---|
| `testConnection()` | `GET /api/json?tree=nodeName` |
| `listJobs(path?)` | `GET /job/.../api/json?tree=jobs[name,_class,url,color]` recursive folders |
| `getJob(fullName)` | `GET /job/a/job/b/api/json` |
| `getPipelineScript(fullName)` | parse `definition.script` from job JSON / `GET .../config.xml` extract `<script>` for Pipeline job only; else `Unsupported` |
| `updatePipelineScript(fullName, script)` | update via config.xml replace of script (only controller-stored Pipeline) |
| `listBuilds(fullName, { cursor, limit })` | `tree=builds[number,result,building,timestamp,duration]` |
| `getBuild(fullName, number)` | `/job/.../{n}/api/json` |
| `getBuildLog(fullName, number, opts)` | `/job/.../{n}/logText/progressiveText` or `consoleText` + `truncateBuildLog` |
| `triggerBuild(fullName, params?)` | `POST .../build` or `buildWithParameters` |
| `stopBuild(fullName, number)` | `POST .../{n}/stop` |

Job fullName encoding: split on `/`, map to `/job/{seg}/job/{seg}`.

Multibranch: branch jobs appear as nested jobs under the multibranch project (treat as normal jobs in list).

- [ ] **Step 3: Implement types + client + pool**

`JenkinsClientPool.get(instanceId)` builds client from config manager + secrets + authenticator.

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add jenkins client façade and build log truncation

EOF
)"
```

---

### Task 7: Instances view + instance form + test connection

**Files:**
- Create: `src/tree/InstancesTreeProvider.ts`, `src/webview/JenkinsInstancePanel.ts`, `webview/jenkins-instance-form/index.ts`, `webview/jenkins-instance-form/index.css`
- Modify: `src/extension.ts`, `package.json`, nls files, `esbuild.config.mjs` (add webview entry)
- Test: `test/tree/InstancesTreeProvider.test.ts` (pure helpers if provider is thin)

- [ ] **Step 1: Register commands in package.json**

Commands (titles via nls):

- `atJenkins.addInstance`
- `atJenkins.editInstance`
- `atJenkins.deleteInstance`
- `atJenkins.testConnection`
- `atJenkins.refreshInstances`
- `atJenkins.setActiveInstance` (also invoked on tree item click)

Menus: view/title + item context.

- [ ] **Step 2: Implement InstancesTreeProvider**

- Items show `label`, description `baseUrl`, icons for readOnly / allowBackgroundAccess / unhealthy
- `onDidChangeSelection` or command on click → `config.setActiveInstanceId(id)` + fire Jobs refresh event

- [ ] **Step 3: Instance form webview**

Fields: label, baseUrl, authMode, username, token/password (optional on edit), verifyTls, readOnly, allowBackgroundAccess. Adapt nacos instance form structure; rename strings to Jenkins.

Save → `config.create` / `update` → optional `client.testConnection()` → refresh tree.

- [ ] **Step 4: Manual checklist (document in commit body)**

- Add instance with apiToken; Test Connection succeeds against a reachable Jenkins or mocked server in unit test for command handler

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add instances tree and instance configuration form

EOF
)"
```

---

### Task 8: Jobs tree with lazy builds

**Files:**
- Create: `src/tree/treeIds.ts`, `src/tree/JobsTreeProvider.ts`
- Modify: `src/extension.ts`, `package.json` (refreshJobs, loadMoreBuilds, openJob, …)
- Test: `test/tree/treeIds.test.ts`, `test/tree/JobsTreeProvider.test.ts`

- [ ] **Step 1: treeIds tests**

```ts
expect(jobId('folder/app')).toBe('job:folder/app');
expect(buildId('folder/app', 42)).toBe('build:folder/app#42');
expect(buildsMoreId('folder/app', '10')).toBe('builds-more:folder/app:10');
```

- [ ] **Step 2: JobsTreeProvider behavior**

- If no `activeInstanceId`, show single informational TreeItem (viewsWelcome also in package.json)
- Root children = top-level jobs/folders from `listJobs()`
- Folder expand → child jobs
- Job expand → first page of builds + `Load more…` sentinel when more exist
- Click sentinel → append next page (track cursor per job in provider state)
- Commands: `atJenkins.refreshJobs`, `atJenkins.openPipelineScript`, `atJenkins.openBuildLog`, `atJenkins.triggerBuild`, `atJenkins.stopBuild` (handlers may stub until Tasks 9–10)

- [ ] **Step 3: Wire active instance change → `jobsProvider.refresh()`**

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add jobs tree with lazy build pagination

EOF
)"
```

---

### Task 9: Virtual documents — pipeline script + build log

**Files:**
- Create: `src/document/PipelineScriptDocumentProvider.ts`, `src/document/BuildLogDocumentProvider.ts`, `src/document/uri.ts`
- Modify: `src/extension.ts` (register content providers + save participant / `workspace.onDidSaveTextDocument`)
- Test: `test/document/uri.test.ts`, `test/document/PipelineScriptDocumentProvider.test.ts`, `test/document/logTruncate.integration.test.ts` (provider uses truncate helpers)

- [ ] **Step 1: URI helpers**

Scheme `at-jenkins`:

- Script: `at-jenkins:/{instanceId}/{jobFullNameEncoded}/Jenkinsfile`
- Log: `at-jenkins:/{instanceId}/{jobFullNameEncoded}/{buildNumber}/consoleText`

Encode `jobFullName` with `encodeURIComponent` per path segment join rule documented in `uri.ts`.

- [ ] **Step 2: Script provider**

- `provideTextDocumentContent` → `client.getPipelineScript` (Unsupported → show message in doc header comment or throw with user message)
- On save: if instance `readOnly` → `ReadOnly` error; else `window.showWarningMessage` confirm → `updatePipelineScript`
- SCM-backed / Freestyle: content provider may open read-only (`document.isUntitled` false + refuse save)

- [ ] **Step 3: Log provider**

- Load `consoleText` / progressive; for building jobs, `setInterval` refresh and `onDidChangeEmitter.fire(uri)`
- Optional command `atJenkins.followBuildLogInOutput` writes same stream to OutputChannel `AT Jenkins`

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add virtual documents for pipeline scripts and build logs

EOF
)"
```

---

### Task 10: UI trigger / parameters / cancel + write guards

**Files:**
- Create: `src/commands/buildCommands.ts` (or handlers inside extension)
- Modify: Jobs tree context menus, `package.json`
- Test: `test/commands/buildCommands.test.ts` (mock client + mock `showWarningMessage`)

- [x] **Step 1: Failing tests**

```ts
it('refuses trigger when readOnly', async () => { /* expect ReadOnly, client.triggerBuild not called */ });
it('confirms before triggerBuild', async () => { /* ... */ });
it('passes parameters to buildWithParameters', async () => { /* ... */ });
it('confirms before stopBuild', async () => { /* ... */ });
```

- [x] **Step 2: Implement**

- No params: confirm → `triggerBuild`
- Params from `getJob().parameters`: sequential QuickPick / InputBox per param (light path); if >5 params or choice lists awkward, add minimal webview later — **start with QuickPick/InputBox**
- Stop: only when `building === true`
- All paths check `readOnly` first

- [x] **Step 3: PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat: add ui build trigger stop and parameter prompts

EOF
)"
```

---

### Task 11: MCP Bridge + seven read-only tools

**Files:**
- Create: `src/mcp/toolCatalog.ts`, `src/mcp/bridgeSchemas.ts`, `src/mcp/BridgeProtocol.ts`, `src/mcp/BridgeServer.ts`, `src/mcp/hubSync.ts`, `src/mcp/McpConfigInstaller.ts`, `src/agent/JenkinsAgentToolService.ts`
- Modify: `src/extension.ts` (start bridge, publish, sync hub on activate; dispose on deactivate)
- Test: `test/mcp/toolCatalog.test.ts`, `test/mcp/BridgeServer.test.ts`, `test/agent/JenkinsAgentToolService.test.ts`

- [ ] **Step 1: toolCatalog**

```ts
export const AT_JENKINS_PLUGIN_ID = 'at.jenkins' as const;

export const AT_JENKINS_TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: 'jenkins_list_instances', risk: 'read', /* ... */ },
  { name: 'jenkins_list_jobs', risk: 'read', /* ... */ },
  { name: 'jenkins_get_job', risk: 'read', /* ... */ },
  { name: 'jenkins_get_pipeline_script', risk: 'read', /* ... */ },
  { name: 'jenkins_list_builds', risk: 'read', /* ... */ },
  { name: 'jenkins_get_build', risk: 'read', /* ... */ },
  { name: 'jenkins_get_build_log', risk: 'read', /* description documents default tail 64KiB */ }
];
```

Copy BridgeServer/hubSync/McpConfigInstaller from nacos; rename plugin constants; **do not** filter catalog by allowBackgroundAccess at publish time.

- [ ] **Step 2: AgentToolService gates**

```ts
async listInstances() {
  return config.listInstances().map(/* id label baseUrl readOnly allowBackgroundAccess — no secrets */);
}

async listJobs(input: { instanceId: string; /* ... */ }) {
  await this.requireBackgroundAccess(input.instanceId);
  // ...
}

private async requireBackgroundAccess(instanceId: string) {
  const inst = config.requireInstance(instanceId);
  if (!inst.allowBackgroundAccess) throw new DeniedBackground(/* actionable message */);
}
```

Assert in tests: without flag → DeniedBackground; with flag → calls client; `get_build_log` uses `DEFAULT_LOG_TAIL_BYTES`; response never contains password/token.

- [ ] **Step 3: Wire extension activate**

```ts
const hostApp = detectHostApp({
  appName: vscode.env.appName,
  appRoot: vscode.env.appRoot,
  uriScheme: vscode.env.uriScheme,
  extensionPath: context.extensionPath
});
// createBridgeToken, BridgeServer.listen(127.0.0.1), FsBridgePublisher.publish, syncHubBundle, ensureAtSeriesMcpConfig
```

- [ ] **Step 4: PASS + commit**

```bash
npx vitest run test/mcp/ test/agent/
git commit -m "$(cat <<'EOF'
feat: register read-only jenkins mcp tools via at-series hub

EOF
)"
```

---

### Task 12: i18n completeness + docs + VSIX

**Files:**
- Modify: all user-facing strings → `package.nls*` + `l10n/bundle.l10n.zh-cn.json` + `t()`
- Create: `README.md`, `CHANGELOG.md`, `docs/features.md`, `docs/features.zh-CN.md`
- Modify: `.vscodeignore` so VSIX excludes tests/docs source maps as per series

- [ ] **Step 1: Audit strings — no raw English/Chinese in `src/` UI paths without `t()` / `%atJenkins.%`**

- [ ] **Step 2: README** covers: multi-instance, auth modes, readOnly, allowBackgroundAccess, MCP tool list + hard exclusions, TOFU

- [ ] **Step 3: Full test suite + package**

```bash
npx vitest run
npm run compile
npx @vscode/vsce package --no-dependencies
```

Expected: `at-jenkins-0.1.0.vsix` created; all tests green.

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: add readme features and package at-jenkins 0.1.0

EOF
)"
```

---

## Milestone mapping

| Milestone | Tasks |
|---|---|
| M0 | 1–5 |
| M1 | 7–8 |
| M2 | 9 |
| M3 | 10 |
| M4 | 11 |
| M5 | 12 |

Task 6 (client) underpins M1–M4; complete before Task 7.

---

## Spec coverage self-check

| Spec item | Task(s) |
|---|---|
| D1 Pipeline+Freestyle scope | 6, 8, 10 |
| D2 controller-stored script edit only | 6, 9 |
| D3 MCP read-only | 11 |
| D4 auth modes | 5, 7 |
| D5–D6 dual views + active instance | 7, 8 |
| D7 hybrid editor | 9, 10 |
| D8 log virtual doc + optional Output | 9 |
| D9 tree + lazy builds | 8 |
| D10 readOnly + confirm + cancel UI | 9, 10 |
| D11 single VSIX with MCP | 1, 11, 12 |
| D12 Jenkins 2.x client | 6 |
| D13 allowBackgroundAccess gate | 2, 11 |
| D14 seven tools | 11 |
| D15 TOFU | 3, 4 |
| D16 i18n | 1, 12 |
| D17 log tail 64KiB | 6, 11 |
| D18 Nacos-aligned skeleton | 1–11 |

**Placeholder scan:** none intentional.  
**Type names:** `JenkinsInstanceConfig`, `allowBackgroundAccess`, `DeniedBackground`, `DEFAULT_LOG_TAIL_BYTES`, `AT_JENKINS_PLUGIN_ID` — use consistently.
