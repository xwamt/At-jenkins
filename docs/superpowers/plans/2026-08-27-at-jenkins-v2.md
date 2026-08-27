# AT Jenkins v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the shipped `at-jenkins` extension with v2 UX capabilities: Go to Job QuickPick, queue `why` + queue-item cancel, build artifact browsing/download, rebuild with same parameters, SCM-backed pipeline read-only view, opt-in job watching, favorites in the Jobs tree, textual `wfapi` stage summaries, JUnit counts on build hover, and opt-in live Jenkins integration tests. **All of it is UI-only — the MCP surface stays at the existing seven read-only tools (D14).**

**Architecture:** Everything builds on the existing single `JenkinsClient` façade + `JenkinsClientPool`, the dual tree providers, `JenkinsStatusBarManager`, `JenkinsBuildFollowService`, and the `at-jenkins:` virtual-document scheme. New client methods follow the `authenticator.withAuthRetry` + bounded `tree=` selector pattern. New persistent UI state (favorites, watched jobs) lives in `globalState` keyed per instance, like `atJenkins.recentBuildParams`. UI owns all mutations: queue cancel and rebuild check `readOnly` first and require a modal confirm; MCP never triggers, cancels, or edits.

**Tech Stack:** TypeScript strict, vitest, zod, esbuild, `@at-series/mcp-hub` ^0.3.2, VS Code `^1.85.0`, `vscode.l10n`

**Spec:** `docs/superpowers/specs/2026-08-27-at-jenkins-v1-v2-design.md` (v2 scope; decisions D2, D6, D8, D10 addendum, D14)

**Depends on:** the v1 plan from the same spec being fully implemented and green first. v2 assumes v1 delivered a bounded `tree=` selector on `JenkinsClient.getBuild` that includes `actions[causes[shortDescription,userId,userName],parameters[name,value]]` and `artifacts[displayPath,fileName,relativePath,size]`, with corresponding typed fields on `BuildDetail`. Verify in the preflight below; if v1 named these fields differently, adapt the rebuild/artifact tasks to the actual names — do not re-implement v1 work.

**TDD:** Every task writes a failing test first, watches RED, then implements. After implementing, run the task's vitest files **and** `npm run typecheck`. Commits use HEREDOC. Never update git config. Never skip hooks.

---

## Preflight (before Task 1)

- [ ] `npx vitest run` is green and `npm run typecheck` passes on the current branch.
- [ ] Confirm v1 deliverables exist: `getBuild` sends a `tree=` query whose selector includes `actions[causes[...],parameters[name,value]]` and `artifacts[...]`; `BuildDetail` exposes typed causes/parameters/artifacts. `grep -n "causes" src/jenkins/*.ts` should hit. If missing, STOP — v1 is not done.
- [ ] Confirm the MCP catalog has exactly seven `jenkins_*` tools in `src/mcp/toolCatalog.ts`. v2 must not change this file (D14).

---

## File map

| Path | Responsibility (v2 delta) |
|---|---|
| `src/jenkins/types.ts` | Add: `JobQueueInfo`, `QueueItem.id`, `BuildSummary.artifacts`, `JobSearchResult`, `ScmPipelineDefinition`, `PipelineStageSummary`, `TestReportSummary`, `SEARCH_JOBS_TREE` helper, `LIST_BUILDS_TREE_FIELDS` |
| `src/jenkins/JenkinsClient.ts` | Add: `cancelQueueItem`, `searchJobs`, `downloadArtifact`, `getScmPipelineDefinition`, `getPipelineStages`, `getTestReportSummary`; map `queueItem[id,why]` in `listJobs`/`getJob`; artifacts in `listBuilds` |
| `src/jenkins/buildActions.ts` | New: `extractBuildParameters(build)` pure helper for rebuild |
| `src/utils/statusBar.ts` | Add `setQueuedStatus(jobFullName, why?, instanceId?)` queued state |
| `src/commands/buildFollow.ts` | Show queue `why` in status bar while polling the queue item |
| `src/commands/queueCommands.ts` | New: `atJenkins.cancelQueueItem` handler (readOnly + confirm; UI write, not MCP) |
| `src/commands/buildCommands.ts` | `triggerBuildHandler` gains `options.prefillParams`; new `rebuildBuildHandler`; export `promptParameterValue` |
| `src/commands/artifactCommands.ts` | New: `atJenkins.downloadArtifact` handler (Save dialog + `workspace.fs.writeFile`) |
| `src/commands/searchJobs.ts` | New: `atJenkins.searchJobs` Go to Job QuickPick (active instance only, D6) |
| `src/commands/watchJobs.ts` | New: `WatchedJobsStore` + `JenkinsJobWatchService` + watch/unwatch commands |
| `src/tree/favorites.ts` | New: `FavoritesStore` over globalState, per-instance |
| `src/tree/treeIds.ts` | Add `artifactId`, `favoriteJobId`, `FAVORITES_ROOT_ID` |
| `src/tree/JobsTreeProvider.ts` | Queued tooltip + contextValue markers, artifact children, Favorites root, watch marker, `resolveTreeItem` lazy hover (stages + JUnit) |
| `src/document/uri.ts` | Add `scm-definition` document target |
| `src/document/ScmPipelineDocumentProvider.ts` | New: read-only markdown view for `CpsScmFlowDefinition` jobs |
| `src/document/openPipelineScriptDocument.ts` | Fall back to SCM definition view instead of an error toast |
| `src/config/settings.ts` | Add `atJenkins.watch.pollIntervalMs` |
| `src/extension.ts` | Wire new commands, stores, watch service, SCM document branch |
| `package.json` + `package.nls.json` + `package.nls.zh-cn.json` | New commands/menus/setting; migrate exact-match `viewItem ==` clauses to prefix regexes |
| `l10n/bundle.l10n.zh-cn.json` | zh-CN keys for every new `t('...')` string |
| `test/jenkins/JenkinsClient.test.ts` | New client method coverage via existing `createMockHttpClient` |
| `test/jenkins/buildActions.test.ts`, `test/commands/*.test.ts`, `test/tree/*.test.ts`, `test/document/*.test.ts`, `test/utils/statusBar.test.ts` | Per-feature unit coverage |
| `test/live/JenkinsClient.live.test.ts` | New: opt-in live tests gated on `AT_JENKINS_TEST_URL` |
| `README.md` / `CHANGELOG.md` / `docs/features.md` / `docs/features.zh-CN.md` | v2 feature docs, version 0.2.0 |

**Explicitly OUT of this plan:** Pipeline replay, Scan Multibranch/Organization folder, Matrix axis children, Blue Ocean links, SSO/custom headers, any MCP write tool, any 8th MCP tool (no artifact/test/queue/search MCP tools — D14), stage-timeline webview (D8 deferred; textual only), Freestyle config.xml editor, Git push for SCM-backed Jenkinsfiles (D2).

---

### Task 1: Client — queue item id/why + `cancelQueueItem`

Unlocks Task 2. All tests go in `test/jenkins/JenkinsClient.test.ts` using the existing `createMockHttpClient` helper.

**Files:**
- Modify: `src/jenkins/types.ts`, `src/jenkins/JenkinsClient.ts`
- Test: `test/jenkins/JenkinsClient.test.ts`

- [ ] **Step 1: Failing tests**

```ts
it('getQueueItem returns id and why while queued', async () => {
  const httpClient = createMockHttpClient(async (req) => {
    expect(req.path).toBe('/queue/item/55/api/json');
    expect(req.query?.tree).toBe('id,cancelled,why,executable[number,url]');
    return { text: JSON.stringify({ id: 55, why: 'Waiting for next available executor' }) };
  });
  const client = new JenkinsClient({ httpClient, authenticator: new JenkinsAuthenticator({ authMode: 'none' }), instanceConfig: dummyInstanceConfig });
  const item = await client.getQueueItem('https://ci.example.com/queue/item/55/');
  expect(item.id).toBe(55);
  expect(item.why).toContain('executor');
});

it('cancelQueueItem posts /queue/cancelItem and treats the 404 quirk as success', async () => {
  // JENKINS-21311: POST /queue/cancelItem returns 404 even when the item was cancelled.
  const httpClient = createMockHttpClient(async (req) => {
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/queue/cancelItem');
    expect(req.query?.id).toBe(55);
    return { status: 404 };
  });
  const client = new JenkinsClient({ httpClient, authenticator: new JenkinsAuthenticator({ authMode: 'none' }), instanceConfig: dummyInstanceConfig });
  await expect(client.cancelQueueItem(55)).resolves.toBeUndefined();
});

it('cancelQueueItem throws ReadOnly before any HTTP call on read-only instance', async () => {
  const httpClient = createMockHttpClient(async () => { throw new Error('must not be called'); });
  const client = new JenkinsClient({
    httpClient,
    authenticator: new JenkinsAuthenticator({ authMode: 'none' }),
    instanceConfig: { ...dummyInstanceConfig, readOnly: true }
  });
  await expect(client.cancelQueueItem(55)).rejects.toBeInstanceOf(ReadOnly);
});

it('listJobs maps queueItem why for queued jobs', async () => { /* payload has queueItem: { id, why }; assert JobSummary.queueItem */ });
```

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts
```

- [ ] **Step 3: Implement**

- `types.ts`: `export interface JobQueueInfo { id?: number; why?: string }`; add `id?: number` to `QueueItem`; add `queueItem?: JobQueueInfo` to `JobSummary` and `JobDetail`; append `queueItem[id,why]` to `LIST_JOBS_TREE` and `GET_JOB_TREE`.
- `JenkinsClient.getQueueItem`: tree becomes `id,cancelled,why,executable[number,url]`.
- `JenkinsClient.listJobs` / `getJob`: map `queueItem` through (only set when present).
- `JenkinsClient.cancelQueueItem(queueId: number)`: `readOnly` guard first (same `ReadOnly` construction as `stopBuild`), then `POST /queue/cancelItem` with `query: { id: queueId }`; wrap in `try/catch` and swallow `NotFound` only (the 404-on-success quirk); rethrow everything else.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts
npm run typecheck
git add src/jenkins/types.ts src/jenkins/JenkinsClient.ts test/jenkins/JenkinsClient.test.ts
git commit -m "$(cat <<'EOF'
feat: expose queue item id and why and add cancelQueueItem client call

EOF
)"
```

---

### Task 2: Queue UX — `why` in status bar + job tooltip, Cancel Queued Item command

UI write with confirm + readOnly (D10 addendum). **Not an MCP tool** — `toolCatalog.ts` is untouched (D14).

**Files:**
- Modify: `src/utils/statusBar.ts`, `src/commands/buildFollow.ts`, `src/tree/JobsTreeProvider.ts`, `src/extension.ts`, `package.json`, `package.nls.json`, `package.nls.zh-cn.json`, `l10n/bundle.l10n.zh-cn.json`
- Create: `src/commands/queueCommands.ts`
- Test: `test/utils/statusBar.test.ts`, `test/commands/buildFollow.test.ts`, `test/tree/JobsTreeProvider.test.ts`, `test/commands/queueCommands.test.ts`

- [ ] **Step 1: Failing tests**

`test/utils/statusBar.test.ts` — new cases:

```ts
it('setQueuedStatus shows queued text and why in tooltip', () => { /* text contains '(queued)'; tooltip contains why */ });
it('clearBuildingStatus clears queued state back to active-controller text', () => { /* ... */ });
it('setBuildingStatus supersedes a prior queued state', () => { /* ... */ });
```

`test/commands/buildFollow.test.ts` — assert that while `resolveBuildNumber` polls a queue item whose response has `why`, `statusBar.setQueuedStatus(jobFullName, why, instanceId)` is called, and once `executable.number` appears the status switches to `setBuildingStatus`.

`test/commands/queueCommands.test.ts`:

```ts
it('refuses cancel when instance is readOnly and never calls the client', async () => { /* error message shown, cancelQueueItem not called */ });
it('asks for modal confirmation before cancelling', async () => { /* confirm dismissed => no client call */ });
it('resolves queue id from job.queueItem, falls back to getJob, cancels, refreshes tree', async () => { /* ... */ });
```

`test/tree/JobsTreeProvider.test.ts` — queued job (`inQueue: true`, `queueItem.why` set) has a tooltip containing the `why` text and a contextValue containing the ` queued` marker.

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/utils/statusBar.test.ts test/commands/buildFollow.test.ts test/commands/queueCommands.test.ts test/tree/JobsTreeProvider.test.ts
```

- [ ] **Step 3: Implement status bar + follow + tree**

- `JenkinsStatusBarManager.setQueuedStatus(jobFullName, why?, instanceId?)`: `$(clock) Jenkins: {job} (queued)`, tooltip = `why` when present, else a generic queued message; track a `queued` state so `updateActiveInstance` does not clobber it; `setBuildingStatus`/`clearBuildingStatus` clear it.
- `JenkinsBuildFollowService.resolveBuildNumber`: on each queue poll call `options.statusBar?.setQueuedStatus(options.jobFullName, item.why, options.instanceId)`; ensure `clearBuildingStatus` runs on cancelled/evaporated items.
- `JobsTreeProvider`: in `buildJobTooltip`, when `job.queueItem?.why` render `- **Queued:** {why}` (via `t()`); contextValue markers.

**contextValue migration (required, do it in this task):** v2 appends space-separated markers (` queued`, later ` favorite`, ` watched`) to job contextValues, e.g. `jenkinsJob.pipeline queued`. Exact-match when-clauses in `package.json` (`viewItem == jenkinsJob.pipeline`, `viewItem == jenkinsJob`, `viewItem == jenkinsBuild`, etc.) would silently stop matching. Migrate them to prefix regexes first:

- `atJenkins.openPipelineScript` → `viewItem =~ /^jenkinsJob\.pipeline/`
- `atJenkins.openJobSummary` → `viewItem =~ /^jenkinsJob/`
- `atJenkins.triggerBuild` → `viewItem =~ /^jenkinsJob/`
- `atJenkins.openBuildLog` / `followBuildLogInOutput` / `openInJenkins` build rows → `viewItem =~ /^jenkinsBuild/`
- `atJenkins.stopBuild` → `viewItem =~ /^jenkinsBuild\.building/`

- [ ] **Step 4: Implement `atJenkins.cancelQueueItem`**

`src/commands/queueCommands.ts` (mirror the `stopBuildHandler` structure):

```ts
export async function cancelQueueItemHandler(context: BuildCommandsContext, target?: JenkinsJobTreeItem | { instanceId?: string; jobFullName: string }): Promise<boolean> {
  // 1. resolve instanceId (target → active), client via pool
  // 2. readOnly guard FIRST: showErrorMessage + return false, no HTTP
  // 3. queueId = target.job.queueItem?.id ?? (await client.getJob(fullName)).queueItem?.id
  //    → if undefined: info message "no longer queued", refresh, return false
  // 4. modal showWarningMessage confirm → client.cancelQueueItem(queueId)
  // 5. info message + jobsTreeProvider.refresh() + statusBar clear if it was showing this job as queued
}
```

Register in `extension.ts`. `package.json`: command `atJenkins.cancelQueueItem` (icon `$(stop-circle)`, `commandPalette` `when: false`), menu `view/item/context` with `view == atJenkins.jobs && viewItem =~ /\bqueued\b/`, group `inline@1`. Add nls titles to **both** `package.nls.json` and `package.nls.zh-cn.json`; add every new `t('...')` string to `l10n/bundle.l10n.zh-cn.json`.

- [ ] **Step 5: PASS + typecheck + commit**

```bash
npx vitest run test/utils/statusBar.test.ts test/commands/ test/tree/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: surface queue why in status bar and tooltip and add cancel queue item

EOF
)"
```

---

### Task 3: Rebuild with same parameters from a build node

Depends on v1's `getBuild` returning `actions[causes,parameters]` (preflight). Composes `getBuild` actions with the existing `collectJobParameters` / `triggerBuildHandler` machinery. **Secrets must be re-prompted** — stored/replayed values never include password/credential parameters (reuse `isSecretParameter` from `recentParams.ts`).

**Files:**
- Create: `src/jenkins/buildActions.ts`
- Modify: `src/commands/buildCommands.ts`, `src/extension.ts` (registration lives in `registerBuildCommands`), `package.json`, nls ×2, `l10n/bundle.l10n.zh-cn.json`
- Test: `test/jenkins/buildActions.test.ts`, `test/commands/buildCommands.test.ts`

- [ ] **Step 1: Failing tests**

`test/jenkins/buildActions.test.ts`:

```ts
import { extractBuildParameters } from '../../src/jenkins/buildActions';

it('reads name/value pairs from hudson.model.ParametersAction only', () => {
  const build = {
    number: 12,
    actions: [
      { _class: 'hudson.model.CauseAction', causes: [{ shortDescription: 'Started by user admin' }] },
      { _class: 'hudson.model.ParametersAction', parameters: [
        { name: 'ENV', value: 'prod' },
        { name: 'DRY_RUN', value: false }
      ] }
    ]
  };
  expect(extractBuildParameters(build as never)).toEqual({ ENV: 'prod', DRY_RUN: false });
});

it('returns empty object when actions are missing', () => { /* ... */ });
```

`test/commands/buildCommands.test.ts` — new cases:

```ts
it('rebuild refuses when instance is readOnly (no getBuild, no trigger)', async () => { /* ... */ });
it('rebuild prefills non-secret params from the source build and skips the recent/edit/defaults picker', async () => { /* triggerBuild called with { ENV: 'prod' } after confirm */ });
it('rebuild re-prompts secret parameters instead of replaying them', async () => {
  // job has PasswordParameterDefinition TOKEN; source build carried TOKEN
  // assert showInputBox called with password: true and its value (not the old one) is sent
});
it('rebuild still requires the modal confirm', async () => { /* dismiss => triggerBuild not called */ });
```

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/jenkins/buildActions.test.ts test/commands/buildCommands.test.ts
```

- [ ] **Step 3: Implement**

- `src/jenkins/buildActions.ts`: `extractBuildParameters(build: BuildDetail): Record<string, string | number | boolean>` — scan `build.actions` for `_class` containing `ParametersAction`, collect `parameters[].{name,value}` for string/number/boolean values.
- `buildCommands.ts`:
  - Extend `triggerBuildHandler(context, target, options?: { prefillParams?: Record<string, string | number | boolean>; confirmMessage?: string })`. When `prefillParams` is provided: skip the recent/edit/defaults QuickPick; final params = `{ ...defaultParameterValues(defs), ...sanitizeParamsForStorage(prefillParams, defs) }`, then for every secret definition (`isSecretParameter`) prompt via `promptParameterValue` (cancel aborts). ReadOnly guard and modal confirm paths are unchanged and shared.
  - New `rebuildBuildHandler(context, target: JenkinsBuildTreeItem | { instanceId?: string; jobFullName: string; buildNumber: number })`: resolve instance → readOnly guard → `getBuild` → `extractBuildParameters` → delegate to `triggerBuildHandler` with `prefillParams` and a confirm message like `t('Rebuild "{job}" with the same parameters as #{number}?')`. Follow/status-bar/recent-params persistence come free from the delegate.
  - Register `atJenkins.rebuildBuild` in `registerBuildCommands`.
- `package.json`: command `atJenkins.rebuildBuild` (icon `$(debug-rerun)`, palette `when: false`), menu on `view == atJenkins.jobs && viewItem =~ /^jenkinsBuild/`, group `atJenkins.action@2`. nls ×2 + zh-cn bundle keys for all new strings.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/buildActions.test.ts test/commands/buildCommands.test.ts
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: add rebuild with same parameters from build nodes

EOF
)"
```

---

### Task 4: Build artifacts — tree children + download via Save dialog

UI only. **Do NOT add MCP artifact tools (D14).** Downloads are reads — no readOnly guard, no confirm.

**Files:**
- Modify: `src/jenkins/types.ts`, `src/jenkins/JenkinsClient.ts`, `src/tree/treeIds.ts`, `src/tree/JobsTreeProvider.ts`, `src/extension.ts`, `package.json`, nls ×2, `l10n/bundle.l10n.zh-cn.json`
- Create: `src/commands/artifactCommands.ts`
- Test: `test/jenkins/JenkinsClient.test.ts`, `test/tree/treeIds.test.ts`, `test/tree/JobsTreeProvider.test.ts`, `test/commands/artifactCommands.test.ts`

- [ ] **Step 1: Failing tests**

`test/jenkins/JenkinsClient.test.ts`:

```ts
it('downloadArtifact GETs .../artifact/<path> with per-segment encoding and returns bytes', async () => {
  const httpClient = createMockHttpClient(async (req) => {
    expect(req.path).toBe('/job/folder1/job/app/12/artifact/dist/app%20name.zip');
    return { body: Buffer.from([0x50, 0x4b]) };
  });
  const client = new JenkinsClient({ httpClient, authenticator: new JenkinsAuthenticator({ authMode: 'none' }), instanceConfig: dummyInstanceConfig });
  const bytes = await client.downloadArtifact('folder1/app', 12, 'dist/app name.zip');
  expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
});

it('listBuilds requests artifacts fields and maps them onto BuildSummary', async () => { /* tree contains artifacts[fileName,relativePath,size]{0,50} */ });
```

`test/tree/treeIds.test.ts`: `artifactId('f/app', 12, 'dist/a.zip')` → `'artifact:f/app#12:dist/a.zip'`.

`test/tree/JobsTreeProvider.test.ts`: a build with artifacts renders `Collapsed` and `getChildren(buildItem)` returns `JenkinsArtifactTreeItem`s (label = `fileName`, description = human size, command `atJenkins.downloadArtifact`); a build without artifacts stays `None`.

`test/commands/artifactCommands.test.ts`: handler calls `showSaveDialog` with the artifact `fileName` as default, writes the returned buffer via `vscode.workspace.fs.writeFile`, shows a success message; a cancelled Save dialog downloads nothing.

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/tree/ test/commands/artifactCommands.test.ts
```

- [ ] **Step 3: Implement**

- `types.ts`: `BuildSummary.artifacts?: BuildArtifact[]`; new `LIST_BUILDS_TREE_FIELDS = `${BUILD_SUMMARY_TREE_FIELDS},artifacts[fileName,relativePath,size]{0,50}``. Keep `GET_JOB_TREE`'s `lastBuild[...]` on the lean `BUILD_SUMMARY_TREE_FIELDS` (no artifacts) to avoid payload bloat.
- `JenkinsClient.listBuilds`: use `LIST_BUILDS_TREE_FIELDS`; `normalizeBuildSummary` passes `artifacts` through when present.
- `JenkinsClient.downloadArtifact(fullName, buildNumber, relativePath): Promise<Buffer>`: path = `` `${buildJobPath(fullName)}/${buildNumber}/artifact/${relativePath.split('/').map(encodeURIComponent).join('/')}` ``; use `httpClient.request` (so 401/404 map to `AuthError`/`NotFound`) inside `withAuthRetry`; return `res.body`.
- Tree: `JenkinsBuildTreeItem` gets `Collapsed` when `build.artifacts?.length`; keep its `openBuildLog` click command (works on collapsible items). New `JenkinsArtifactTreeItem` (icon `$(file-zip)` for archives / `$(file)` otherwise, id from `artifactId`, contextValue `jenkinsArtifact`, tooltip shows `relativePath` + size, command `atJenkins.downloadArtifact` with itself as arg). `getChildren` handles `JenkinsBuildTreeItem` → artifact items. Add a `formatArtifactSize(bytes?)` helper next to `formatDuration`.
- `src/commands/artifactCommands.ts`: `downloadArtifactHandler(context, target)` — `showSaveDialog({ defaultUri: file(fileName) })` → progress notification → `client.downloadArtifact` → `vscode.workspace.fs.writeFile` → info message with an "Open File" action. Register `atJenkins.downloadArtifact`.
- `package.json`: command (icon `$(cloud-download)`, palette `when: false`), menu `view == atJenkins.jobs && viewItem == jenkinsArtifact` inline. nls ×2 + zh-cn bundle keys.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/tree/ test/commands/artifactCommands.test.ts
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: list build artifacts in the tree and download via save dialog

EOF
)"
```

---

### Task 5: `atJenkins.searchJobs` — Go to Job QuickPick

Active instance only (D6). `JobsTreeProvider` has no `getParent`, so `TreeView.reveal` is unavailable — on pick, **open the Job Summary** (per spec preference) instead of revealing the node. No MCP search tool (D14).

**Files:**
- Modify: `src/jenkins/types.ts`, `src/jenkins/JenkinsClient.ts`, `src/extension.ts`, `package.json`, nls ×2, `l10n/bundle.l10n.zh-cn.json`
- Create: `src/commands/searchJobs.ts`
- Test: `test/jenkins/JenkinsClient.test.ts`, `test/commands/searchJobs.test.ts`

- [ ] **Step 1: Failing tests**

`test/jenkins/JenkinsClient.test.ts`:

```ts
it('searchJobs fetches one nested tree and flattens jobs with fullName, skipping folder nodes', async () => {
  const httpClient = createMockHttpClient(async (req) => {
    expect(req.path).toBe('/api/json');
    expect(String(req.query?.tree)).toContain('jobs[fullName,name,url,color,_class,jobs[');
    return {
      text: JSON.stringify({
        jobs: [
          { _class: 'com.cloudbees.hudson.plugins.folder.Folder', fullName: 'team', name: 'team',
            jobs: [{ _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', fullName: 'team/deploy', name: 'deploy', color: 'blue', url: 'https://ci.example.com/job/team/job/deploy/' }] },
          { _class: 'hudson.model.FreeStyleProject', fullName: 'lint', name: 'lint', color: 'red', url: 'https://ci.example.com/job/lint/' }
        ]
      })
    };
  });
  const client = new JenkinsClient({ httpClient, authenticator: new JenkinsAuthenticator({ authMode: 'none' }), instanceConfig: dummyInstanceConfig });
  const results = await client.searchJobs();
  expect(results.map((r) => r.fullName)).toEqual(['team/deploy', 'lint']);
});
```

`test/commands/searchJobs.test.ts`: no active instance → info message, no QuickPick; QuickPick items labeled with `fullName` (description = type badge/status); picking one executes `atJenkins.openJobSummary` with `{ instanceId, jobFullName }`; cancelling does nothing.

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/commands/searchJobs.test.ts
```

- [ ] **Step 3: Implement**

- `types.ts`: `JobSearchResult { fullName: string; name: string; url: string; color?: string; _class?: string }`; `buildSearchJobsTree(depth = 5): string` producing the nested `jobs[fullName,name,url,color,_class,jobs[...]]` selector (single request, bounded depth — no N+1 folder walk).
- `JenkinsClient.searchJobs()`: GET `/api/json` with the nested tree; recursively flatten; include only non-folder jobs (branch jobs inside multibranch projects are plain jobs and are included, e.g. `mb/main`); folders/organization folders are traversed but not returned.
- `src/commands/searchJobs.ts`: `searchJobsHandler` — resolve **active** instance only (D6; info message when none), busy QuickPick while fetching, items `{ label: fullName, description: badge/color }` with `matchOnDescription: true` (VS Code QuickPick does the fuzzy filtering), on pick `executeCommand('atJenkins.openJobSummary', { instanceId, jobFullName })`.
- `package.json`: command `atJenkins.searchJobs` title "Go to Job..." (icon `$(search)`), **enabled in the command palette** (no `when: false`), plus `view/title` navigation button on `atJenkins.jobs`. nls ×2 + zh-cn bundle keys.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/commands/searchJobs.test.ts
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: add go to job quickpick over a flattened job search

EOF
)"
```

---

### Task 6: Favorites / pinned jobs in the Jobs tree root

Per-instance persistence in `globalState`, mirroring the `atJenkins.recentBuildParams` pattern.

**Files:**
- Create: `src/tree/favorites.ts`
- Modify: `src/tree/treeIds.ts`, `src/tree/JobsTreeProvider.ts`, `src/extension.ts`, `package.json`, nls ×2, `l10n/bundle.l10n.zh-cn.json`
- Test: `test/tree/favorites.test.ts`, `test/tree/treeIds.test.ts`, `test/tree/JobsTreeProvider.test.ts`

- [ ] **Step 1: Failing tests**

`test/tree/favorites.test.ts`:

```ts
it('add/remove/list favorites are scoped per instance', async () => {
  const store = new FavoritesStore(memento); // ExtensionMemento mock, key atJenkins.favoriteJobs
  await store.add('inst1', 'team/deploy');
  await store.add('inst2', 'lint');
  expect(store.list('inst1')).toEqual(['team/deploy']);
  await store.remove('inst1', 'team/deploy');
  expect(store.list('inst1')).toEqual([]);
  expect(store.list('inst2')).toEqual(['lint']);
});
it('add is idempotent', async () => { /* ... */ });
```

`test/tree/treeIds.test.ts`: `favoriteJobId('a/b')` → `'favorite:job:a/b'` (must differ from `jobId` — tree item ids have to be unique across the whole view).

`test/tree/JobsTreeProvider.test.ts`: with favorites present, root children start with a `Favorites` node (Expanded, id `FAVORITES_ROOT_ID`); its children are job items built from `client.getJob(fullName)` with `favoriteJobId` ids and a contextValue containing ` favorite`; a favorite whose job 404s renders a removable placeholder item; regular job rows for favorited jobs also carry the ` favorite` marker (so the star toggles everywhere).

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/tree/
```

- [ ] **Step 3: Implement**

- `favorites.ts`: `FavoritesStore` over `ExtensionMemento`, key `atJenkins.favoriteJobs`, shape `Record<string /* instanceId */, string[] /* jobFullNames */>`; `add`/`remove`/`list`/`isFavorite`.
- `treeIds.ts`: `favoriteJobId`, `FAVORITES_ROOT_ID`.
- `JobsTreeProvider`: constructor accepts optional `favoritesStore`; `getRootChildren` prepends `JenkinsFavoritesRootTreeItem` (label `t('Favorites')`, icon `$(star-full)`, contextValue `jenkinsFavoritesRoot`) when the active instance has favorites; `getChildren(favoritesRoot)` maps each stored fullName via `getJob` → `JenkinsJobTreeItem` (pass an option so the item uses `favoriteJobId` and appends ` favorite`); `NotFound` → placeholder item with contextValue `jenkinsFavoriteMissing` and the remove command attached.
- Commands in `extension.ts`: `atJenkins.addFavoriteJob` / `atJenkins.removeFavoriteJob` (accept `JenkinsJobTreeItem` or `{ instanceId?, jobFullName }`; resolve instance like the other handlers; update store; `jobsTreeProvider.refresh()`).
- `package.json`: both commands (icons `$(star-empty)` / `$(star-full)`, palette `when: false`); menus on `view == atJenkins.jobs`: add when `viewItem =~ /^jenkinsJob/ && !(viewItem =~ /\bfavorite\b/)`, remove when `viewItem =~ /\bfavorite\b/ || viewItem == jenkinsFavoriteMissing`. nls ×2 + zh-cn bundle keys.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/tree/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: add per-instance favorite jobs section to the jobs tree

EOF
)"
```

---

### Task 7: Opt-in Watch job → poll lastBuild → notify

Reuses `notifyBuildCompletion` from `buildFollow.ts`. **UI watch is user-initiated** — the `allowBackgroundAccess` flag gates MCP only and is intentionally NOT checked here; document that in a code comment and in `docs/features.md`.

**Files:**
- Create: `src/commands/watchJobs.ts`
- Modify: `src/config/settings.ts`, `src/tree/JobsTreeProvider.ts` (watched marker), `src/extension.ts`, `package.json` (commands + `atJenkins.watch.pollIntervalMs` setting), nls ×2, `l10n/bundle.l10n.zh-cn.json`
- Test: `test/commands/watchJobs.test.ts`, `test/config/settings.test.ts`

- [ ] **Step 1: Failing tests**

`test/commands/watchJobs.test.ts`:

```ts
it('WatchedJobsStore add/remove/list is scoped per instance (key atJenkins.watchedJobs)', async () => { /* same shape as FavoritesStore */ });

it('notifies once when a watched building job completes', async () => {
  // fake sleep; getJob returns lastBuild {number: 7, building: true} then {number: 7, building: false, result: 'SUCCESS'}
  // assert notifyBuildCompletion-equivalent (inject notifier fn) called exactly once with build 7
});

it('notifies when a new completed build appears while not building', async () => { /* lastSeen 7 → lastBuild 8 completed → notify */ });
it('does not re-notify the same build number', async () => { /* ... */ });
it('unwatching a job stops its polling', async () => { /* ... */ });
```

`test/config/settings.test.ts`: `watchPollIntervalMs` defaults to 15000 and clamps to [5000, 600000].

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/commands/watchJobs.test.ts test/config/settings.test.ts
```

- [ ] **Step 3: Implement**

- `watchJobs.ts`:
  - `WatchedJobsStore` (globalState key `atJenkins.watchedJobs`, `Record<instanceId, string[]>`).
  - `JenkinsJobWatchService implements vscode.Disposable`: constructor takes `{ clientPool, store, pollIntervalMs, sleep?, notify? }` (injectable `sleep` and `notify` defaulting to `notifyBuildCompletion` for testability, same seam style as `JenkinsBuildFollowService`). One poll loop per watched `(instanceId, jobFullName)`: `getJob` → track last notified build number per key → notify on `building → completed` transition or on a newly completed number; swallow and debug-log per-iteration errors (a flaky controller must not kill the loop); `watch()`/`unwatch()` start/stop loops; `dispose()` stops all.
  - `registerWatchCommands`: `atJenkins.watchJob` / `atJenkins.unwatchJob` handlers (resolve instance, update store, start/stop service loop, `jobsTreeProvider.refresh()`).
- `settings.ts`: `watchPollIntervalMs` via `clampInt(cfg.get('watch.pollIntervalMs'), 15_000, 5_000, 600_000)`.
- `JobsTreeProvider`: watched jobs get the ` watched` contextValue marker and an `$(eye)` hint in the description; provider takes optional `watchedJobsStore` for the lookup.
- `extension.ts`: construct store + service, re-arm watches for the persisted set on activate, push service to subscriptions.
- `package.json`: commands (icons `$(eye)` / `$(eye-closed)`, palette `when: false`); menus: watch when `viewItem =~ /^jenkinsJob/ && !(viewItem =~ /\bwatched\b/)`, unwatch when `viewItem =~ /\bwatched\b/`; setting `atJenkins.watch.pollIntervalMs` (default 15000, min 5000, max 600000) with descriptions in **both** nls files. zh-cn bundle keys for new `t()` strings.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/commands/watchJobs.test.ts test/config/settings.test.ts
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: add opt-in job watching with completion notifications

EOF
)"
```

---

### Task 8: SCM-backed pipeline read-only view (`CpsScmFlowDefinition`)

D2 holds: no Git push, no editing — save stays disabled (the view is a `TextDocumentContentProvider` document, which is inherently read-only). `getPipelineScript` keeps throwing `Unsupported` (the MCP tool contract must not change — D14); the UI catches it and shows this view instead of an error toast.

**Files:**
- Modify: `src/jenkins/types.ts`, `src/jenkins/JenkinsClient.ts`, `src/document/uri.ts`, `src/document/openPipelineScriptDocument.ts`, `src/extension.ts` (combined provider branch), `l10n/bundle.l10n.zh-cn.json`
- Create: `src/document/ScmPipelineDocumentProvider.ts`
- Test: `test/jenkins/JenkinsClient.test.ts`, `test/document/uri.test.ts`, `test/document/ScmPipelineDocumentProvider.test.ts`, `test/document/openPipelineScriptDocument.test.ts`

- [ ] **Step 1: Failing tests**

`test/jenkins/JenkinsClient.test.ts`:

```ts
it('getScmPipelineDefinition parses repo, branches, and scriptPath from CpsScmFlowDefinition config.xml', async () => {
  const xml = `<?xml version='1.1'?><flow-definition>
    <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition">
      <scm class="hudson.plugins.git.GitSCM">
        <userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>git@github.com:acme/app.git</url></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs>
        <branches><hudson.plugins.git.BranchSpec><name>*/main</name></hudson.plugins.git.BranchSpec></branches>
      </scm>
      <scriptPath>ci/Jenkinsfile</scriptPath>
    </definition></flow-definition>`;
  const httpClient = createMockHttpClient(async (req) => {
    expect(req.path).toBe('/job/app/config.xml');
    return { text: xml };
  });
  const client = new JenkinsClient({ httpClient, authenticator: new JenkinsAuthenticator({ authMode: 'none' }), instanceConfig: dummyInstanceConfig });
  const def = await client.getScmPipelineDefinition('app');
  expect(def).toEqual({ scriptPath: 'ci/Jenkinsfile', repoUrl: 'git@github.com:acme/app.git', branches: ['*/main'], scmClass: 'hudson.plugins.git.GitSCM' });
});

it('getScmPipelineDefinition throws Unsupported for controller-stored or Freestyle jobs', async () => { /* ... */ });
```

`test/document/uri.test.ts`: `buildScmPipelineUri(instanceId, jobFullName)` round-trips through `parseJenkinsDocumentUri` as `{ type: 'scm-definition', ... }` (path `/scm-definition.md`, `job=` query like the other targets).

`test/document/ScmPipelineDocumentProvider.test.ts`: `formatScmPipelineMarkdown(def, jobFullName)` includes repo URL, branches, scriptPath, and a localized note that the Jenkinsfile lives in source control and cannot be edited or pushed from here.

`test/document/openPipelineScriptDocument.test.ts`: when `getPipelineScript` throws `Unsupported` with `jobType: 'CpsScmFlowDefinition'`, the SCM definition document opens (no error toast); Freestyle `Unsupported` keeps the existing error message.

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/document/
```

- [ ] **Step 3: Implement**

- `types.ts`: `ScmPipelineDefinition { scriptPath: string; repoUrl?: string; branches?: string[]; scmClass?: string }`.
- `JenkinsClient.getScmPipelineDefinition(fullName)`: GET `config.xml` (same headers as `getPipelineScript`); require the `CpsScmFlowDefinition` marker, else `Unsupported`; regex-extract `<scriptPath>`, first `<url>` inside `userRemoteConfigs`, all `<name>` under `BranchSpec`, and the `scm class="…"` attribute (same lightweight regex style as `extractScriptFromXml` — no XML dependency).
- `uri.ts`: add `'scm-definition'` to `JenkinsDocumentTarget`, `buildScmPipelineUri`, and the `/scm-definition.md` branch in `parseJenkinsDocumentUri`.
- `ScmPipelineDocumentProvider.ts`: mirror `JobSummaryDocumentProvider` (clientPool + log, `provideTextDocumentContent` → `formatScmPipelineMarkdown`); export the formatter for tests. All strings via `t()`.
- `openPipelineScriptDocument.ts`: in the `Unsupported` catch, when `details.jobType === 'CpsScmFlowDefinition'` open `buildScmPipelineUri(...)` with markdown language + `preview: false` and return the doc; other `Unsupported` cases keep the current error path.
- `extension.ts`: route `type === 'scm-definition'` through the combined content provider.
- zh-cn bundle keys for every new `t()` string. No new command / no package.json change (the existing `atJenkins.openPipelineScript` entry point now degrades gracefully).

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/document/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: show read-only scm pipeline definition view for scm-backed jobs

EOF
)"
```

---

### Task 9: `wfapi` stage summary + JUnit counts on build hover

Textual only — **NOT a stage-timeline webview (D8 deferred)**. UI only — **no MCP test/stage tools (D14)**. Uses `TreeDataProvider.resolveTreeItem` so the tree render path stays N+1-free: the extra requests happen lazily on hover, one build at a time.

**Files:**
- Modify: `src/jenkins/types.ts`, `src/jenkins/JenkinsClient.ts`, `src/tree/JobsTreeProvider.ts`, `l10n/bundle.l10n.zh-cn.json`
- Test: `test/jenkins/JenkinsClient.test.ts`, `test/tree/JobsTreeProvider.test.ts`

- [ ] **Step 1: Failing tests**

`test/jenkins/JenkinsClient.test.ts`:

```ts
it('getPipelineStages maps wfapi describe stages', async () => {
  const httpClient = createMockHttpClient(async (req) => {
    expect(req.path).toBe('/job/app/12/wfapi/describe');
    return { text: JSON.stringify({ stages: [
      { name: 'Build', status: 'SUCCESS', durationMillis: 61000 },
      { name: 'Deploy', status: 'FAILED', durationMillis: 900 }
    ] }) };
  });
  // expect [{ name: 'Build', status: 'SUCCESS', durationMillis: 61000 }, ...]
});

it('getPipelineStages returns undefined when the workflow plugin endpoint 404s', async () => { /* hide, do not throw */ });

it('getTestReportSummary maps pass/fail/skip counts and 404s to undefined', async () => {
  // GET /job/app/12/testReport/api/json?tree=passCount,failCount,skipCount,duration
});
```

`test/tree/JobsTreeProvider.test.ts`:

```ts
it('resolveTreeItem enriches a build tooltip with stages and test counts', async () => { /* both sections appear in the MarkdownString */ });
it('resolveTreeItem hides the stages section when wfapi is unavailable', async () => { /* undefined → no Stages header */ });
it('resolveTreeItem caches enrichment for completed builds', async () => { /* second call: no extra client calls */ });
```

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/tree/JobsTreeProvider.test.ts
```

- [ ] **Step 3: Implement**

- `types.ts`: `PipelineStageSummary { name: string; status?: string; durationMillis?: number }`; `TestReportSummary { passCount: number; failCount: number; skipCount: number; duration?: number }`.
- `JenkinsClient.getPipelineStages(fullName, buildNumber)`: GET `{jobPath}/{n}/wfapi/describe` (Pipeline Stage View plugin); catch `NotFound` → `undefined` (plugin absent or not a Pipeline build → caller hides the section); map `stages[]`.
- `JenkinsClient.getTestReportSummary(fullName, buildNumber)`: GET `{jobPath}/{n}/testReport/api/json` with `tree=passCount,failCount,skipCount,duration`; `NotFound` → `undefined` (no JUnit results recorded).
- `JobsTreeProvider.resolveTreeItem(item, element, token)`: only for `JenkinsBuildTreeItem` — fetch both concurrently, append to the existing tooltip:
  - `**Stages:**` list — one line per stage: status glyph (✓ / ✗ / ○ by status) + name + `formatDuration(durationMillis)`;
  - `**Tests:**` one line — `t('{pass} passed, {fail} failed, {skip} skipped', ...)`.
  - Cache the enriched `MarkdownString` in a `Map` keyed by tree item id for **completed** builds only (they are immutable); never cache while `building`. Swallow errors — hover enrichment must never surface an error toast.
- zh-cn bundle keys for the new `t()` strings. No package.json changes.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/tree/JobsTreeProvider.test.ts
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: enrich build hovers with wfapi stages and junit counts

EOF
)"
```

---

### Task 10: Opt-in live Jenkins integration tests

Default `npm test` must stay green and skip these entirely — gated on `AT_JENKINS_TEST_URL` / `AT_JENKINS_TEST_USER` / `AT_JENKINS_TEST_TOKEN`. Read-only assertions only: live tests never trigger, cancel, or edit anything.

**Files:**
- Create: `test/live/JenkinsClient.live.test.ts`
- Modify: `README.md` (short "live tests" section)

- [ ] **Step 1: Write the gated suite**

```ts
import { describe, expect, it } from 'vitest';
import { JenkinsAuthenticator } from '../../src/jenkins/JenkinsAuthenticator';
import { JenkinsClient } from '../../src/jenkins/JenkinsClient';
import { JenkinsHttpClient } from '../../src/jenkins/JenkinsHttpClient';

const liveUrl = process.env.AT_JENKINS_TEST_URL;
const liveUser = process.env.AT_JENKINS_TEST_USER;
const liveToken = process.env.AT_JENKINS_TEST_TOKEN;

describe.skipIf(!liveUrl)('live jenkins (read-only, opt-in)', () => {
  const client = () => {
    const httpClient = new JenkinsHttpClient({ baseUrl: liveUrl!, verifyTls: true });
    const authenticator = liveUser && liveToken
      ? new JenkinsAuthenticator({ authMode: 'apiToken', username: liveUser, secret: liveToken })
      : new JenkinsAuthenticator({ authMode: 'none' });
    return new JenkinsClient({ httpClient, authenticator });
  };

  it('testConnection reaches the controller', async () => {
    const info = await client().testConnection();
    expect(info).toBeDefined();
  });

  it('listJobs and searchJobs return consistent job sets', async () => {
    const c = client();
    const roots = await c.listJobs();
    const flat = await c.searchJobs();
    expect(Array.isArray(roots)).toBe(true);
    expect(Array.isArray(flat)).toBe(true);
  });

  // Optional deeper checks gated on AT_JENKINS_TEST_JOB (a known job fullName):
  // getJob, listBuilds(+artifacts fields), getBuildLog tail, getPipelineStages/getTestReportSummary tolerating undefined.
});
```

Use a generous per-test timeout (e.g. `{ timeout: 30_000 }`).

- [ ] **Step 2: Verify both modes**

```bash
npx vitest run test/live/JenkinsClient.live.test.ts   # without env: suite reported as skipped
npx vitest run                                        # full default run stays green
```

If a live controller is actually available in the environment, also run once with `AT_JENKINS_TEST_URL=... AT_JENKINS_TEST_USER=... AT_JENKINS_TEST_TOKEN=...` and record the result in the commit body.

- [ ] **Step 3: README section + commit**

Document the three env vars, the optional `AT_JENKINS_TEST_JOB`, and that the suite is read-only and skipped by default.

```bash
git add test/live README.md
git commit -m "$(cat <<'EOF'
test: add opt-in live jenkins integration suite gated on env vars

EOF
)"
```

---

### Task 11: i18n completeness audit + docs + package 0.2.0

**Files:**
- Modify: `package.json` (version 0.2.0), `package.nls.json`, `package.nls.zh-cn.json`, `l10n/bundle.l10n.zh-cn.json`, `README.md`, `CHANGELOG.md`, `docs/features.md`, `docs/features.zh-CN.md`

- [ ] **Step 1: i18n audit**

- Every `t('...')` string added in Tasks 2–9 has a key in `l10n/bundle.l10n.zh-cn.json` (grep new `t(` call sites; diff against the bundle).
- Every new command (`searchJobs`, `cancelQueueItem`, `downloadArtifact`, `rebuildBuild`, `addFavoriteJob`, `removeFavoriteJob`, `watchJob`, `unwatchJob`) and the `atJenkins.watch.pollIntervalMs` setting have entries in **both** `package.nls.json` and `package.nls.zh-cn.json`.
- No raw user-facing English/Chinese literals in `src/` UI paths outside `t()` / `%atJenkins.%`.

- [ ] **Step 2: D14 audit**

`git diff <v2-start>..HEAD -- src/mcp src/agent` must be empty: no new MCP tools, no catalog or schema changes, still exactly seven `jenkins_*` tools. Queue cancel and rebuild exist only as UI commands with readOnly + modal confirm.

- [ ] **Step 3: Docs + version**

- `CHANGELOG.md`: 0.2.0 entry listing the ten v2 items.
- `README.md` / `docs/features.md` / `docs/features.zh-CN.md`: Go to Job, queue why/cancel, artifacts download, rebuild (secrets re-prompted), SCM read-only view (no Git push), watch (user-initiated; `allowBackgroundAccess` remains MCP-only), favorites, stage/test hover, live test opt-in.
- `package.json` version → `0.2.0`.

- [ ] **Step 4: Full suite + package + commit**

```bash
npx vitest run
npm run typecheck
npm run compile
npx @vscode/vsce package --no-dependencies --allow-missing-repository --no-rewrite-relative-links
```

Expected: all tests green (live suite skipped), `at-jenkins-0.2.0.vsix` created.

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: document v2 features and package at-jenkins 0.2.0

EOF
)"
```

---

## Frozen-scope coverage self-check

| v2 scope item | Task(s) |
|---|---|
| 1. `atJenkins.searchJobs` Go to Job QuickPick (active instance, D6; job summary instead of `reveal`) | 5 |
| 2. Queue `why` in status bar + tooltip; `cancelQueueItem` UI write with confirm + readOnly (D10 addendum, not MCP) | 1, 2 |
| 3. Artifacts as tree children; download via `.../artifact/<path>` + Save dialog; no MCP artifact tools (D14) | 4 |
| 4. Rebuild with same parameters; secrets re-prompted | 3 |
| 5. SCM-backed pipeline read-only view; save disabled; no Git push (D2) | 8 |
| 6. Opt-in watch job → poll lastBuild → `notifyBuildCompletion`; user-initiated (allowBackgroundAccess is MCP-only) | 7 |
| 7. Favorites/pinned jobs at Jobs tree root, per-instance globalState | 6 |
| 8. Textual `wfapi` stage summary, hidden when plugin absent; no stage-timeline webview (D8 deferred) | 9 |
| 9. JUnit `testReport/api/json` counts on build tooltip; UI only | 9 |
| 10. Opt-in live tests gated on `AT_JENKINS_TEST_URL`/user/token; default `npm test` skips | 10 |

**Write-guard double-check:** the two UI mutations in this plan — queue cancel (Task 2) and rebuild (Task 3) — both (a) check `instance.readOnly` before any prompt or HTTP call, in the handler **and** in the client method, and (b) require a modal `showWarningMessage` confirm. Artifact download, search, favorites, watch, stages, and test counts are reads.

**D14 hard rule:** no changes under `src/mcp/` or `src/agent/` anywhere in this plan. No MCP tools for artifacts, tests, queue, or search.

**Consistency:** new state keys are `atJenkins.favoriteJobs` and `atJenkins.watchedJobs`; new setting is `atJenkins.watch.pollIntervalMs`; contextValue markers are space-separated ` queued` / ` favorite` / ` watched` appended to the existing `jenkinsJob*` values, with the Task 2 when-clause migration done before any marker ships.

**Placeholder scan:** none intentional.
