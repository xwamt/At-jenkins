# AT Jenkins v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the hardened v1 (0.2.0) `at-jenkins` extension with the v2 (0.3.0) operator-depth features: Go to Job QuickPick, queue `why` visibility + queue-item cancel, build artifact browsing/download, rebuild with same parameters, SCM-backed pipeline read-only view, opt-in job watching, pinned/favorite jobs in the Jobs tree, textual `wfapi` stage summaries, JUnit counts on build hover, and opt-in live Jenkins integration tests. **All of it is UI-only — the MCP surface stays at exactly the seven read-only tools (D3/D14).**

**Architecture:** Everything builds on the existing single `JenkinsClient` façade + `JenkinsClientPool`, the dual tree providers, `JenkinsStatusBarManager`, `JenkinsBuildFollowService`, and the `at-jenkins:` virtual-document scheme. New client methods follow the `authenticator.withAuthRetry` + bounded `tree=` selector pattern. New persistent UI state (pinned jobs, watched jobs) lives in `globalState` (`atJenkins.pinnedJobs`, `atJenkins.watchedJobs` — spec A14), no secrets, rendering scoped to the active instance (D6). UI owns all mutations: queue cancel and rebuild check `readOnly` first and require a modal confirm (D10 addendum A11); MCP never triggers, cancels, or edits.

**Tech Stack:** TypeScript strict, vitest, zod, esbuild, `@at-series/mcp-hub` ^0.3.2, VS Code `^1.85.0`, `vscode.l10n`

**Spec:** `docs/superpowers/specs/2026-08-27-at-jenkins-v1-v2-design.md` (v2 = 0.3.0; addenda A11–A15; decisions D2, D6, D8, D10, D14)

**Contract:** `docs/superpowers/plans/2026-08-27-at-jenkins-engineering.md` is binding for every task: DoD is `npm run typecheck` + `npx vitest run` + `npm run compile` all green; the i18n suite (`test/i18n/nls.test.ts`) enforces zh-CN parity **and** no stale bundle keys, so every string is added/removed in the same commit as its code; the §4 security checklist must not regress.

**Depends on:** the v1 plan (`docs/superpowers/plans/2026-08-27-at-jenkins-v1.md`) being fully implemented and green first. v2 relies on these v1 deliverables:

- `GET_BUILD_TREE` on `JenkinsClient.getBuild` including `artifacts[fileName,relativePath,size]` and `actions[parameters[name,value],causes[shortDescription],totalCount,failCount,skipCount]` (v1 Task 11) — unlocks rebuild (Task 3) and artifacts (Task 4).
- Unsupported-parameter refusal (File/Run/Credentials) in `collectJobParameters` (v1 A5) — reused by rebuild.
- Concurrent status-bar follows keyed per build (v1 A7) — Task 2 extends that keyed API with a queued state.
- Settings live-reload (v1 A7) — the new `atJenkins.watch.pollIntervalMs` joins it.

**TDD:** Every task writes a failing test first, watches RED, then implements. After implementing, run the task's vitest files **and** `npm run typecheck`. Commits use HEREDOC. Never update git config. Never skip hooks.

---

## Preflight (before Task 1)

- [ ] Read the engineering contract end to end (`docs/superpowers/plans/2026-08-27-at-jenkins-engineering.md`).
- [ ] `npx vitest run`, `npm run typecheck`, and `npm run compile` are green on the current branch.
- [ ] Confirm v1 deliverables exist: `grep -n "GET_BUILD_TREE" src/jenkins/*.ts` hits and the selector includes `causes`, `parameters`, `artifacts`, `totalCount`; `collectJobParameters` refuses File/Run/Credentials parameter types; the status bar keys follows per build. If any is missing, STOP — v1 is not done.
- [ ] Confirm `src/mcp/toolCatalog.ts` has exactly seven `jenkins_*` tools, all `risk: 'read'`. v2 must not change `src/mcp/` or `src/agent/` (D14; the v1 `scrubBuildDetail` pass stays as-is).

---

## File map

| Path | Responsibility (v2 delta) |
|---|---|
| `src/jenkins/types.ts` | Add: `JobQueueInfo`, `QueueItem.id`, `BuildSummary.artifacts`, `JobSearchResult`, `ScmPipelineDefinition`, `PipelineStageSummary`, `TestReportSummary`, `buildSearchJobsTree`, `LIST_BUILDS_TREE_FIELDS` |
| `src/jenkins/JenkinsClient.ts` | Add: `cancelQueueItem`, `searchJobs`, `downloadArtifact`, `getScmPipelineDefinition`, `getBuildStages`, `getTestReportSummary`; map `queueItem[id,why]` in `listJobs`/`getJob`; artifacts in `listBuilds` |
| `src/jenkins/JenkinsHttpClient.ts` | Add streaming `downloadToFile(req, destPath)` (current client buffers whole bodies — unusable for large artifacts) |
| `src/jenkins/buildActions.ts` | New: `extractBuildParameters(build)` pure helper for rebuild |
| `src/utils/statusBar.ts` | Add queued state (`setQueuedStatus`) to the v1 keyed status bar |
| `src/commands/buildFollow.ts` | Show queue `why` in the status bar while polling the queue item |
| `src/commands/queueCommands.ts` | New: `atJenkins.cancelQueueItem` handler (readOnly + confirm; UI write per A11, not MCP) |
| `src/commands/rebuild.ts` | New: `atJenkins.rebuildBuild` handler (prefill from build actions; secrets re-prompted) |
| `src/commands/buildCommands.ts` | `triggerBuildHandler` gains `options.prefillParams` / `options.confirmMessage`; export `promptParameterValue` |
| `src/commands/artifacts.ts` | New: `atJenkins.downloadArtifact` handler (Save dialog + streamed download) |
| `src/commands/searchJobs.ts` | New: `atJenkins.searchJobs` Go to Job QuickPick (active instance only, D6) |
| `src/config/pinnedJobs.ts` | New: `PinnedJobsStore` over globalState key `atJenkins.pinnedJobs` |
| `src/config/watchedJobs.ts` | New: `WatchedJobsStore` over globalState key `atJenkins.watchedJobs` |
| `src/watch/JobWatchService.ts` | New: opt-in per-job lastBuild polling → `notifyBuildCompletion` |
| `src/tree/treeIds.ts` | Add `artifactId`, `pinnedJobId`, `PINNED_ROOT_ID` |
| `src/tree/JobsTreeProvider.ts` | Queued tooltip + contextValue markers, artifact children, Pinned root section, watch badge, `resolveTreeItem` lazy hover (stages + JUnit) |
| `src/document/JobSummaryDocumentProvider.ts` | Render the SCM pipeline definition section for `CpsScmFlowDefinition` jobs |
| `src/document/openPipelineScriptDocument.ts` | SCM-backed jobs open the job summary (read-only) instead of an error toast |
| `src/config/settings.ts` | Add `atJenkins.watch.pollIntervalMs` (default 15000, clamp 5000–300000, live-reload like the rest) |
| `src/extension.ts` | Wire new commands, stores, watch service |
| `package.json` + `package.nls.json` + `package.nls.zh-cn.json` | New commands/menus/setting; migrate exact-match `viewItem ==` clauses to prefix regexes |
| `l10n/bundle.l10n.zh-cn.json` | zh-CN key for every new `t('...')` string, same commit as the code (stale-key test enforces both directions) |
| `test/jenkins/JenkinsClient.test.ts` | New client method coverage via the existing `createMockHttpClient` pattern |
| `test/jenkins/JenkinsHttpClient.test.ts` | `downloadToFile` streaming coverage via the existing `testHttpServer` pattern |
| `test/jenkins/buildActions.test.ts`, `test/commands/*.test.ts`, `test/config/*.test.ts`, `test/watch/JobWatchService.test.ts`, `test/tree/*.test.ts`, `test/document/*.test.ts`, `test/utils/statusBar.test.ts` | Per-feature unit coverage |
| `test/live/JenkinsClient.live.test.ts` | New: opt-in live suite gated on `AT_JENKINS_TEST_URL` |
| `README.md` / `README.zh-CN.md` / `CHANGELOG.md` / `docs/features.md` / `docs/features.zh-CN.md` | v2 feature docs, version 0.3.0 |

**Explicitly OUT of this plan:** Pipeline replay, Scan Multibranch/Organization folder, Matrix axis children, Blue Ocean links, SSO/custom headers, any MCP write tool, any 8th MCP tool (no artifact/test/queue/search MCP tools — each would amend D14 and is not proposed), stage-timeline webview (D8 stays deferred; textual only), Freestyle config.xml editor, Git push for SCM-backed Jenkinsfiles (D2 stays view-only).

**Canonical IDs match the spec’s frozen table.** Remaining implementation choices (already reflected in the spec):

1. On pick, `atJenkins.searchJobs` opens **Job Summary** instead of `TreeView.reveal` (`JobsTreeProvider` has no `getParent`).
2. Queue `why` comes from the job API’s `queueItem[id,why]` field on existing list/get calls, rendered on the **job row** (tooltip + queued marker) rather than a queued pseudo-node.
3. Stage summary and JUnit counts render in the **build hover** via `resolveTreeItem` (lazy, cached) rather than a dedicated command — hide cleanly when the plugin/report is absent.

---

### Task 1: Client — queue item id/why + `cancelQueueItem`

Unlocks Task 2. All client tests go in `test/jenkins/JenkinsClient.test.ts` using the existing `createMockHttpClient` helper.

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

UI write with confirm + readOnly (A11 — D10 addendum, not a D3 change). **Not an MCP tool** — `toolCatalog.ts` is untouched (D14).

**Files:**
- Modify: `src/utils/statusBar.ts`, `src/commands/buildFollow.ts`, `src/tree/JobsTreeProvider.ts`, `src/extension.ts`, `package.json`, `package.nls.json`, `package.nls.zh-cn.json`, `l10n/bundle.l10n.zh-cn.json`
- Create: `src/commands/queueCommands.ts`
- Test: `test/utils/statusBar.test.ts`, `test/commands/buildFollow.test.ts`, `test/tree/JobsTreeProvider.test.ts`, `test/commands/queueCommands.test.ts`

- [ ] **Step 1: Failing tests**

`test/utils/statusBar.test.ts` — new cases against the post-v1 **keyed** status bar (v1 A7 keys building entries per follow):

```ts
it('setQueuedStatus shows queued text and why in the tooltip', () => { /* text contains '(queued)'; tooltip contains why */ });
it('a queued entry is superseded by its own setBuildingStatus once the build starts', () => { /* ... */ });
it('clearing the queued entry restores the active-controller text when nothing else is active', () => { /* ... */ });
```

`test/commands/buildFollow.test.ts` — while `resolveBuildNumber` polls a queue item whose response has `why`, `statusBar.setQueuedStatus(jobFullName, why, instanceId)` is called each poll; once `executable.number` appears the entry switches to building; a cancelled queue item clears the entry.

`test/commands/queueCommands.test.ts`:

```ts
it('refuses cancel when instance is readOnly and never calls the client', async () => { /* error message shown, cancelQueueItem not called */ });
it('asks for modal confirmation before cancelling', async () => { /* confirm dismissed => no client call */ });
it('resolves queue id from job.queueItem, falls back to getJob, cancels, refreshes tree', async () => { /* ... */ });
it('shows an info message when the job is no longer queued', async () => { /* queue id unresolvable => no cancel call */ });
```

`test/tree/JobsTreeProvider.test.ts` — a queued job (`inQueue: true`, `queueItem.why` set) has a tooltip containing the `why` text and a contextValue containing the ` queued` marker.

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/utils/statusBar.test.ts test/commands/buildFollow.test.ts test/commands/queueCommands.test.ts test/tree/JobsTreeProvider.test.ts
```

- [ ] **Step 3: Implement status bar + follow + tree**

- `JenkinsStatusBarManager.setQueuedStatus(jobFullName, why?, instanceId?)`: `$(clock) Jenkins: {job} (queued)`, tooltip = `why` when present, else a generic queued message (all via `t()`); integrate with the v1 keyed-entry model so a queued entry occupies the same key its building entry will use and is replaced/cleared by `setBuildingStatus`/`clearBuildingStatus`.
- `JenkinsBuildFollowService.resolveBuildNumber`: on each queue poll call `options.statusBar?.setQueuedStatus(options.jobFullName, item.why, options.instanceId)`; clear the entry on cancelled/evaporated items.
- `JobsTreeProvider`: in `buildJobTooltip`, when `job.queueItem?.why` render `- **Queued:** {why}` (via `t()`); append the ` queued` contextValue marker.

**contextValue migration (required, do it in this task):** v2 appends space-separated markers (` queued`, later ` pinned`, ` watched`) to job contextValues, e.g. `jenkinsJob.pipeline queued`. Exact-match when-clauses in `package.json` would silently stop matching. Migrate them to prefix regexes first:

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
  // 5. info message + jobsTreeProvider.refresh() + clear this job's queued status-bar entry
}
```

Register in `extension.ts`. `package.json`: command `atJenkins.cancelQueueItem` (icon `$(stop-circle)`, `commandPalette` `when: false`), menu `view/item/context` with `view == atJenkins.jobs && viewItem =~ /\bqueued\b/`, group `inline@1`. Add nls titles to **both** `package.nls.json` and `package.nls.zh-cn.json`; add every new `t('...')` string to `l10n/bundle.l10n.zh-cn.json` **in this commit** (the stale-key test fails otherwise).

- [ ] **Step 5: PASS + typecheck + commit**

```bash
npx vitest run test/utils/statusBar.test.ts test/commands/ test/tree/ test/i18n/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: surface queue why in status bar and tooltip and add cancel queue item

EOF
)"
```

---

### Task 3: Rebuild with same parameters from a build node

Depends on v1's `GET_BUILD_TREE` exposing `actions[parameters[name,value],causes[...]]` (preflight). Composes `getBuild` actions with the existing `collectJobParameters` / `triggerBuildHandler` machinery. **Secrets must be re-prompted** — replayed values never include password/credential parameters (reuse `isSecretParameter` from `recentParams.ts`); parameter types v1 refuses (File/Run/Credentials) are refused here identically.

**Files:**
- Create: `src/jenkins/buildActions.ts`, `src/commands/rebuild.ts`
- Modify: `src/commands/buildCommands.ts`, `src/extension.ts`, `package.json`, nls ×2, `l10n/bundle.l10n.zh-cn.json`
- Test: `test/jenkins/buildActions.test.ts`, `test/commands/rebuild.test.ts`, `test/commands/buildCommands.test.ts`

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

`test/commands/rebuild.test.ts`:

```ts
it('refuses when instance is readOnly (no getBuild, no trigger)', async () => { /* ... */ });
it('prefills non-secret params from the source build and skips the recent/edit/defaults picker', async () => { /* triggerBuild called with { ENV: 'prod' } after confirm */ });
it('re-prompts secret parameters instead of replaying them', async () => {
  // job has PasswordParameterDefinition TOKEN; source build carried TOKEN
  // assert showInputBox called with password: true and its fresh value (not the old one) is sent
});
it('refuses unsupported parameter types exactly like a normal trigger', async () => { /* File/Run/Credentials => error + Open in Jenkins, no POST */ });
it('the modal confirm lists the name=value pairs being replayed', async () => { /* dismiss => triggerBuild not called */ });
```

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/jenkins/buildActions.test.ts test/commands/rebuild.test.ts test/commands/buildCommands.test.ts
```

- [ ] **Step 3: Implement**

- `src/jenkins/buildActions.ts`: `extractBuildParameters(build: BuildDetail): Record<string, string | number | boolean>` — scan `build.actions` for `_class` containing `ParametersAction`, collect `parameters[].{name,value}` for string/number/boolean values.
- `buildCommands.ts`: extend `triggerBuildHandler(context, target, options?: { prefillParams?: Record<string, string | number | boolean>; confirmMessage?: string })`. When `prefillParams` is provided: skip the recent/edit/defaults QuickPick; run the v1 unsupported-type refusal unchanged; final params = `{ ...defaultParameterValues(defs), ...sanitizeParamsForStorage(prefillParams, defs) }`, then for every secret definition (`isSecretParameter`) prompt via `promptParameterValue` (cancel aborts). The `readOnly` guard, modal confirm (using `confirmMessage` when given), follow, and recent-params persistence paths are unchanged and shared.
- `src/commands/rebuild.ts`: `rebuildBuildHandler(context, target: JenkinsBuildTreeItem | { instanceId?: string; jobFullName: string; buildNumber: number })` — resolve instance → readOnly guard → `getBuild` → `extractBuildParameters` → delegate to `triggerBuildHandler` with `prefillParams` and a confirm message that lists the replayed `name=value` pairs, e.g. `t('Rebuild "{job}" with the same parameters as #{number}?\n\n{params}')` (secret names shown as `name=(will be prompted)`). Register `atJenkins.rebuildBuild`.
- `package.json`: command `atJenkins.rebuildBuild` (icon `$(debug-rerun)`, palette `when: false`), menu on `view == atJenkins.jobs && viewItem =~ /^jenkinsBuild/`, group `atJenkins.action@2`. nls ×2 + zh-cn bundle keys in this commit.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/buildActions.test.ts test/commands/ test/i18n/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: add rebuild with same parameters from build nodes

EOF
)"
```

---

### Task 4: Build artifacts — tree children + streamed download via Save dialog

UI only. **Do NOT add MCP artifact tools — that would amend D14 and is out of scope.** Downloads are reads — no readOnly guard, no confirm. Per the spec, downloads **stream to disk** (`JenkinsHttpClient` currently buffers whole bodies, which is unusable for large artifacts).

**Files:**
- Modify: `src/jenkins/types.ts`, `src/jenkins/JenkinsClient.ts`, `src/jenkins/JenkinsHttpClient.ts`, `src/tree/treeIds.ts`, `src/tree/JobsTreeProvider.ts`, `src/extension.ts`, `package.json`, nls ×2, `l10n/bundle.l10n.zh-cn.json`
- Create: `src/commands/artifacts.ts`
- Test: `test/jenkins/JenkinsHttpClient.test.ts`, `test/jenkins/JenkinsClient.test.ts`, `test/tree/treeIds.test.ts`, `test/tree/JobsTreeProvider.test.ts`, `test/commands/artifacts.test.ts`

- [ ] **Step 1: Failing tests**

`test/jenkins/JenkinsHttpClient.test.ts` — use the existing `startTestHttpServer` pattern:

```ts
it('downloadToFile streams the response body to the destination path', async () => {
  const payload = Buffer.alloc(256 * 1024, 7);
  const server = await startTestHttpServer((req, res) => { res.writeHead(200); res.end(payload); });
  const client = new JenkinsHttpClient({ baseUrl: server.origin, verifyTls: true });
  const dest = join(tmpdir(), `at-jenkins-test-${Date.now()}.bin`);
  await client.downloadToFile({ method: 'GET', path: '/artifact/big.bin' }, dest);
  expect(readFileSync(dest).equals(payload)).toBe(true);
  await server.close();
});

it('downloadToFile maps 401/404 to AuthError/NotFound and leaves no partial file', async () => { /* ... */ });
```

`test/jenkins/JenkinsClient.test.ts`:

```ts
it('downloadArtifact targets .../artifact/<path> with per-segment encoding', async () => {
  // inject a spy transport/httpClient; assert path '/job/folder1/job/app/12/artifact/dist/app%20name.zip'
  // and that the destination path is forwarded to downloadToFile
});

it('listBuilds requests artifact fields and maps them onto BuildSummary', async () => { /* tree contains artifacts[fileName,relativePath,size]{0,50} */ });
```

`test/tree/treeIds.test.ts`: `artifactId('f/app', 12, 'dist/a.zip')` → `'artifact:f/app#12:dist/a.zip'` (matches the spec's node-id scheme).

`test/tree/JobsTreeProvider.test.ts`: a build with artifacts renders `Collapsed` and `getChildren(buildItem)` returns `JenkinsArtifactTreeItem`s (label = `fileName`, description = human-readable size, command `atJenkins.downloadArtifact`); a build without artifacts stays `None`.

`test/commands/artifacts.test.ts`: handler calls `showSaveDialog` defaulting to the artifact `fileName`, runs the download under `withProgress`, shows a success toast with "Open File / Reveal" actions; a cancelled Save dialog downloads nothing.

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/jenkins/ test/tree/ test/commands/artifacts.test.ts
```

- [ ] **Step 3: Implement**

- `JenkinsHttpClient.downloadToFile(req, destPath)`: same URL building/auth/TLS path as `requestRaw`, but pipe the response into `fs.createWriteStream(destPath)` instead of buffering; on non-2xx, consume/discard, delete any partial file, and map errors like `handleHttpError`.
- `types.ts`: `BuildSummary.artifacts?: BuildArtifact[]`; new `LIST_BUILDS_TREE_FIELDS = `${BUILD_SUMMARY_TREE_FIELDS},artifacts[fileName,relativePath,size]{0,50}``. Keep `GET_JOB_TREE`'s `lastBuild[...]` on the lean `BUILD_SUMMARY_TREE_FIELDS` (no artifacts) to avoid payload bloat.
- `JenkinsClient.listBuilds`: use `LIST_BUILDS_TREE_FIELDS`; `normalizeBuildSummary` passes `artifacts` through when present.
- `JenkinsClient.downloadArtifact(fullName, buildNumber, relativePath, destPath)`: path = `` `${buildJobPath(fullName)}/${buildNumber}/artifact/${relativePath.split('/').map(encodeURIComponent).join('/')}` ``; auth headers via `withAuthRetry`; delegate to `downloadToFile`.
- Tree: `JenkinsBuildTreeItem` gets `Collapsed` when `build.artifacts?.length` (its `openBuildLog` click command still works on collapsible items). New `JenkinsArtifactTreeItem` (icon `$(file-zip)` for archives / `$(file)` otherwise, id from `artifactId`, contextValue `jenkinsArtifact`, tooltip shows `relativePath` + size, command `atJenkins.downloadArtifact` with itself as arg). `getChildren` handles `JenkinsBuildTreeItem` → artifact items. Add a `formatArtifactSize(bytes?)` helper next to `formatDuration`.
- `src/commands/artifacts.ts`: `downloadArtifactHandler(context, target)` — `showSaveDialog({ defaultUri: file(fileName) })` → `withProgress` notification → `client.downloadArtifact(..., dest.fsPath)` → success toast with "Open File" / "Reveal in Finder/Explorer" actions. Register `atJenkins.downloadArtifact`.
- `package.json`: command (icon `$(cloud-download)`, palette `when: false`), menu `view == atJenkins.jobs && viewItem == jenkinsArtifact` inline. nls ×2 + zh-cn bundle keys in this commit.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/ test/tree/ test/commands/artifacts.test.ts test/i18n/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: list build artifacts in the tree and stream downloads via save dialog

EOF
)"
```

---

### Task 5: `atJenkins.searchJobs` — Go to Job QuickPick

Active instance only (D6). `JobsTreeProvider` has no `getParent`, so `TreeView.reveal` is unavailable — on pick, **open the Job Summary** (frozen-scope preference; see deviation note 2) instead of revealing the node. No MCP search tool (D14).

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
- `src/commands/searchJobs.ts`: `searchJobsHandler` — resolve the **active** instance only (D6; info message when none), busy QuickPick while fetching, items `{ label: fullName, description: badge/color }` with `matchOnDescription: true` (VS Code QuickPick does the fuzzy filtering), on pick `executeCommand('atJenkins.openJobSummary', { instanceId, jobFullName })`.
- `package.json`: command `atJenkins.searchJobs` title "Go to Job..." (icon `$(search)`), **enabled in the command palette** (no `when: false`), plus a `view/title` navigation button on `atJenkins.jobs`. nls ×2 + zh-cn bundle keys in this commit.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/commands/searchJobs.test.ts test/i18n/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: add go to job quickpick over a flattened job search

EOF
)"
```

---

### Task 6: Pinned (favorite) jobs at the top of the Jobs tree

Persistence per spec A14: globalState key `atJenkins.pinnedJobs`, value `Array<{ instanceId: string; jobFullName: string }>`, no secrets; rendering scoped to the active instance.

**Files:**
- Create: `src/config/pinnedJobs.ts`
- Modify: `src/tree/treeIds.ts`, `src/tree/JobsTreeProvider.ts`, `src/extension.ts`, `package.json`, nls ×2, `l10n/bundle.l10n.zh-cn.json`
- Test: `test/config/pinnedJobs.test.ts`, `test/tree/treeIds.test.ts`, `test/tree/JobsTreeProvider.test.ts`

- [ ] **Step 1: Failing tests**

`test/config/pinnedJobs.test.ts`:

```ts
it('pin/unpin/list are scoped per instance and persist as {instanceId, jobFullName} entries', async () => {
  const store = new PinnedJobsStore(memento); // ExtensionMemento mock, key atJenkins.pinnedJobs
  await store.pin('inst1', 'team/deploy');
  await store.pin('inst2', 'lint');
  expect(store.list('inst1')).toEqual(['team/deploy']);
  expect(memento.get('atJenkins.pinnedJobs', [])).toContainEqual({ instanceId: 'inst1', jobFullName: 'team/deploy' });
  await store.unpin('inst1', 'team/deploy');
  expect(store.list('inst1')).toEqual([]);
  expect(store.list('inst2')).toEqual(['lint']);
});
it('pin is idempotent', async () => { /* ... */ });
```

`test/tree/treeIds.test.ts`: `pinnedJobId('a/b')` → `'pinned:job:a/b'` (must differ from `jobId` — tree item ids must be unique across the whole view).

`test/tree/JobsTreeProvider.test.ts`: with pins present for the active instance, root children start with a `Pinned` section node (Expanded, id `PINNED_ROOT_ID`); its children are job items built from `client.getJob(fullName)` carrying `pinnedJobId` ids and a contextValue containing ` pinned`; a pin whose job 404s renders a removable placeholder item; regular job rows for pinned jobs also carry the ` pinned` marker (so pin/unpin toggles everywhere).

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/config/pinnedJobs.test.ts test/tree/
```

- [ ] **Step 3: Implement**

- `pinnedJobs.ts`: `PinnedJobsStore` over `ExtensionMemento`, key `atJenkins.pinnedJobs`, stored shape `Array<{ instanceId, jobFullName }>` (spec A14); `pin`/`unpin`/`list(instanceId)`/`isPinned`.
- `treeIds.ts`: `pinnedJobId`, `PINNED_ROOT_ID`.
- `JobsTreeProvider`: constructor accepts optional `pinnedJobsStore`; `getRootChildren` prepends a `JenkinsPinnedRootTreeItem` (label `t('Pinned')`, icon `$(pinned)`, contextValue `jenkinsPinnedRoot`) when the active instance has pins; `getChildren(pinnedRoot)` maps each stored fullName via `getJob` → `JenkinsJobTreeItem` (constructor option so the item uses `pinnedJobId` and appends ` pinned`); `NotFound` → placeholder item with contextValue `jenkinsPinnedMissing` and the unpin command attached.
- Commands in `extension.ts`: `atJenkins.pinJob` / `atJenkins.unpinJob` (accept `JenkinsJobTreeItem` or `{ instanceId?, jobFullName }`; resolve instance like the other handlers; update store; `jobsTreeProvider.refresh()`).
- `package.json`: both commands (icons `$(pin)` / `$(pinned)`, palette `when: false`); menus on `view == atJenkins.jobs`: pin when `viewItem =~ /^jenkinsJob/ && !(viewItem =~ /\bpinned\b/)`, unpin when `viewItem =~ /\bpinned\b/ || viewItem == jenkinsPinnedMissing`. nls ×2 + zh-cn bundle keys in this commit.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/config/pinnedJobs.test.ts test/tree/ test/i18n/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: add per-instance pinned jobs section to the jobs tree

EOF
)"
```

---

### Task 7: Opt-in Watch job → poll lastBuild → notify

Reuses `notifyBuildCompletion` from `buildFollow.ts`. **UI watch is user-initiated and runs only while the extension host is alive** — the `allowBackgroundAccess` flag gates MCP only and is intentionally NOT checked here; say so in a code comment and in `docs/features.md`.

**Files:**
- Create: `src/config/watchedJobs.ts`, `src/watch/JobWatchService.ts`
- Modify: `src/config/settings.ts`, `src/tree/JobsTreeProvider.ts` (watched badge), `src/extension.ts`, `package.json` (commands + `atJenkins.watch.pollIntervalMs` setting), nls ×2, `l10n/bundle.l10n.zh-cn.json`
- Test: `test/config/watchedJobs.test.ts`, `test/watch/JobWatchService.test.ts`, `test/config/settings.test.ts`

- [ ] **Step 1: Failing tests**

`test/config/watchedJobs.test.ts`: `WatchedJobsStore` mirrors `PinnedJobsStore` — key `atJenkins.watchedJobs`, shape `Array<{ instanceId, jobFullName }>` (spec A14), watch/unwatch/list/isWatched, idempotent.

`test/watch/JobWatchService.test.ts`:

```ts
it('notifies once when a watched building job completes', async () => {
  // injectable sleep + notify (defaults to notifyBuildCompletion); getJob returns
  // lastBuild {number: 7, building: true} then {number: 7, building: false, result: 'SUCCESS'}
  // assert notify called exactly once with build 7
});
it('notifies when a new completed build appears while not building', async () => { /* lastSeen 7 → lastBuild 8 completed → notify */ });
it('does not re-notify the same build number', async () => { /* ... */ });
it('unwatching a job stops its polling loop', async () => { /* ... */ });
it('a per-poll client error is swallowed and polling continues', async () => { /* ... */ });
```

`test/config/settings.test.ts`: `watchPollIntervalMs` defaults to 15000 and clamps to [5000, 300000] (spec §4).

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/config/watchedJobs.test.ts test/watch/JobWatchService.test.ts test/config/settings.test.ts
```

- [ ] **Step 3: Implement**

- `watchedJobs.ts`: `WatchedJobsStore` (globalState key `atJenkins.watchedJobs`, array-of-objects shape).
- `JobWatchService.ts`: `JobWatchService implements vscode.Disposable` — constructor takes `{ clientPool, store, pollIntervalMs, sleep?, notify? }` (injectable `sleep` and `notify` defaulting to `notifyBuildCompletion`, same test-seam style as `JenkinsBuildFollowService`). One poll loop per watched `(instanceId, jobFullName)`: `getJob` → track last notified build number per key → notify on `building → completed` transition or on a newly completed number; swallow and debug-log per-iteration errors (a flaky controller must not kill the loop); `watch()`/`unwatch()` start/stop loops; `dispose()` stops all. Honor the v1 settings live-reload pattern for `pollIntervalMs`.
- `settings.ts`: `watchPollIntervalMs` via `clampInt(cfg.get('watch.pollIntervalMs'), 15_000, 5_000, 300_000)`.
- `JobsTreeProvider`: watched jobs get the ` watched` contextValue marker and an `$(eye)` hint in the description; provider takes optional `watchedJobsStore` for the lookup.
- `extension.ts`: construct store + service, re-arm watches for the persisted set on activate, register `atJenkins.watchJob` / `atJenkins.unwatchJob`, push service to subscriptions.
- `package.json`: commands (icons `$(eye)` / `$(eye-closed)`, palette `when: false`); menus: watch when `viewItem =~ /^jenkinsJob/ && !(viewItem =~ /\bwatched\b/)`, unwatch when `viewItem =~ /\bwatched\b/`; setting `atJenkins.watch.pollIntervalMs` (default 15000, min 5000, max 300000) with descriptions in **both** nls files. zh-cn bundle keys for new `t()` strings in this commit.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/config/ test/watch/ test/i18n/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: add opt-in job watching with completion notifications

EOF
)"
```

---

### Task 8: SCM-backed pipeline read-only view (`CpsScmFlowDefinition`)

D2 holds: no Git push, no editing — save stays disabled (the view lives in the read-only job summary document; `TextDocumentContentProvider` documents cannot be saved). `getPipelineScript` keeps throwing `Unsupported` (the MCP tool contract must not change — D14); the UI catches it and opens the job summary, which now renders the SCM definition, instead of an error toast.

**Files:**
- Modify: `src/jenkins/types.ts`, `src/jenkins/JenkinsClient.ts`, `src/document/JobSummaryDocumentProvider.ts`, `src/document/openPipelineScriptDocument.ts`, `l10n/bundle.l10n.zh-cn.json`
- Test: `test/jenkins/JenkinsClient.test.ts`, `test/document/JobSummaryDocumentProvider.test.ts`, `test/document/openPipelineScriptDocument.test.ts`

- [ ] **Step 1: Failing tests**

`test/jenkins/JenkinsClient.test.ts`:

```ts
it('getScmPipelineDefinition parses repo, branches, scriptPath, and lightweight flag from CpsScmFlowDefinition config.xml', async () => {
  const xml = `<?xml version='1.1'?><flow-definition>
    <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition">
      <scm class="hudson.plugins.git.GitSCM">
        <userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>https://user:pass@github.example.com/acme/app.git</url></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs>
        <branches><hudson.plugins.git.BranchSpec><name>*/main</name></hudson.plugins.git.BranchSpec></branches>
      </scm>
      <scriptPath>ci/Jenkinsfile</scriptPath>
      <lightweight>true</lightweight>
    </definition></flow-definition>`;
  const httpClient = createMockHttpClient(async (req) => {
    expect(req.path).toBe('/job/app/config.xml');
    return { text: xml };
  });
  const client = new JenkinsClient({ httpClient, authenticator: new JenkinsAuthenticator({ authMode: 'none' }), instanceConfig: dummyInstanceConfig });
  const def = await client.getScmPipelineDefinition('app');
  // userinfo must be stripped from the remote URL (never render credentials)
  expect(def).toEqual({
    scmClass: 'hudson.plugins.git.GitSCM',
    repoUrl: 'https://github.example.com/acme/app.git',
    branches: ['*/main'],
    scriptPath: 'ci/Jenkinsfile',
    lightweight: true
  });
});

it('getScmPipelineDefinition throws Unsupported for controller-stored or Freestyle jobs', async () => { /* ... */ });
```

`test/document/JobSummaryDocumentProvider.test.ts`: for a `WorkflowJob` whose definition is SCM-backed, the rendered markdown contains a "Pipeline from SCM" section with SCM class, userinfo-stripped remote, branches, script path, lightweight flag, and a localized note that the Jenkinsfile lives in source control and cannot be edited or pushed from here (D2). Controller-stored and Freestyle jobs render no such section.

`test/document/openPipelineScriptDocument.test.ts`: when `getPipelineScript` throws `Unsupported` with `jobType: 'CpsScmFlowDefinition'`, the job summary document opens (no error toast) plus an info message pointing at the SCM section; Freestyle `Unsupported` keeps the existing error message.

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/document/
```

- [ ] **Step 3: Implement**

- `types.ts`: `ScmPipelineDefinition { scmClass?: string; repoUrl?: string; branches?: string[]; scriptPath: string; lightweight?: boolean }`.
- `JenkinsClient.getScmPipelineDefinition(fullName)`: GET `config.xml` (same headers as `getPipelineScript`); require the `CpsScmFlowDefinition` marker, else `Unsupported`; regex-extract `<scriptPath>`, the first `<url>` inside `userRemoteConfigs`, all `<name>` under `BranchSpec`, `<lightweight>`, and the `scm class="…"` attribute (same lightweight regex style as `extractScriptFromXml` — no XML dependency). Strip URL userinfo with the existing `src/utils/url.ts` helper before returning (`repoUrl` must never carry credentials — engineering contract §4 redaction spirit).
- `JobSummaryDocumentProvider`: when the job `_class` is a `WorkflowJob`, attempt `getScmPipelineDefinition`; on success append the "Pipeline from SCM" section to `formatJobSummaryMarkdown` output; on `Unsupported` (controller-stored / Freestyle) render nothing extra; never fail the whole summary because of this section.
- `openPipelineScriptDocument.ts`: in the `Unsupported` catch, when `details.jobType === 'CpsScmFlowDefinition'` execute `atJenkins.openJobSummary` for the job and show an info message (script is in SCM; view-only here); other `Unsupported` cases keep the current error path.
- zh-cn bundle keys for every new `t()` string in this commit. No new command / no package.json change (the existing `atJenkins.openPipelineScript` entry point now degrades gracefully).

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/document/ test/i18n/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: render read-only scm pipeline definition in the job summary

EOF
)"
```

---

### Task 9: `wfapi` stage summary + JUnit counts on build hover

Textual only — **NOT a stage-timeline webview (A13; D8 stays deferred)**. UI only — **no MCP stage/test tools (D14)**. Uses `TreeDataProvider.resolveTreeItem` so the tree render path stays N+1-free: the extra requests happen lazily on hover, one build at a time, and both sections simply **hide** when the endpoint is unavailable (frozen-scope requirement; see deviation note 4).

**Files:**
- Modify: `src/jenkins/types.ts`, `src/jenkins/JenkinsClient.ts`, `src/tree/JobsTreeProvider.ts`, `l10n/bundle.l10n.zh-cn.json`
- Test: `test/jenkins/JenkinsClient.test.ts`, `test/tree/JobsTreeProvider.test.ts`

- [ ] **Step 1: Failing tests**

`test/jenkins/JenkinsClient.test.ts`:

```ts
it('getBuildStages maps wfapi describe stages', async () => {
  const httpClient = createMockHttpClient(async (req) => {
    expect(req.path).toBe('/job/app/12/wfapi/describe');
    return { text: JSON.stringify({ stages: [
      { name: 'Build', status: 'SUCCESS', durationMillis: 61000 },
      { name: 'Deploy', status: 'FAILED', durationMillis: 900 }
    ] }) };
  });
  // expect [{ name: 'Build', status: 'SUCCESS', durationMillis: 61000 }, ...]
});

it('getBuildStages converts a 404 (plugin absent / not a Pipeline build) to Unsupported', async () => { /* spec §4 */ });

it('getTestReportSummary maps pass/fail/skip counts and converts 404 to undefined', async () => {
  // GET /job/app/12/testReport/api/json?tree=passCount,failCount,skipCount,duration
});
```

`test/tree/JobsTreeProvider.test.ts`:

```ts
it('resolveTreeItem enriches a build tooltip with stages and test counts', async () => { /* both sections appear in the MarkdownString */ });
it('resolveTreeItem hides the stages section when getBuildStages throws Unsupported', async () => { /* no Stages header, no error toast */ });
it('resolveTreeItem hides the tests line when no JUnit report exists', async () => { /* ... */ });
it('resolveTreeItem caches enrichment for completed builds', async () => { /* second call: no extra client calls */ });
```

- [ ] **Step 2: Run — RED**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/tree/JobsTreeProvider.test.ts
```

- [ ] **Step 3: Implement**

- `types.ts`: `PipelineStageSummary { name: string; status?: string; durationMillis?: number }`; `TestReportSummary { passCount: number; failCount: number; skipCount: number; duration?: number }`.
- `JenkinsClient.getBuildStages(fullName, buildNumber)`: GET `{jobPath}/{n}/wfapi/describe` (Pipeline Stage View plugin); convert `NotFound` to `Unsupported('… requires the Pipeline Stage View plugin …')` per spec §4; map `stages[]`.
- `JenkinsClient.getTestReportSummary(fullName, buildNumber)`: GET `{jobPath}/{n}/testReport/api/json` with `tree=passCount,failCount,skipCount,duration` (frozen-scope endpoint); `NotFound` → `undefined` (no JUnit results recorded).
- `JobsTreeProvider.resolveTreeItem(item, element, token)`: only for `JenkinsBuildTreeItem` — fetch both concurrently, append to the existing tooltip:
  - `**Stages:**` list — one line per stage: status glyph (`✔` / `✘` / `➖` by status) + name + `formatDuration(durationMillis)`; the whole section is omitted when `getBuildStages` throws `Unsupported`.
  - `**Tests:**` one line — `t('{pass} passed, {fail} failed, {skip} skipped', ...)`; omitted when `undefined`.
  - Cache the enriched `MarkdownString` in a `Map` keyed by tree item id for **completed** builds only (they are immutable); never cache while `building`. Swallow all errors — hover enrichment must never surface an error toast.
- zh-cn bundle keys for the new `t()` strings in this commit. No package.json changes.

- [ ] **Step 4: PASS + typecheck + commit**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/tree/JobsTreeProvider.test.ts test/i18n/
npm run typecheck
git add -A
git commit -m "$(cat <<'EOF'
feat: enrich build hovers with wfapi stages and junit counts

EOF
)"
```

---

### Task 10: Opt-in live Jenkins integration tests

Default `npm test` must stay green and skip these entirely — gated on `AT_JENKINS_TEST_URL` / `AT_JENKINS_TEST_USER` / `AT_JENKINS_TEST_TOKEN`. Read-only assertions only: live tests never trigger, cancel, or edit anything. Never in CI. Never put real hosts/credentials in the repo — live values exist only in the runner's environment.

**Files:**
- Create: `test/live/JenkinsClient.live.test.ts`
- Modify: `README.md` (live-tests section), `docs/superpowers/plans/2026-08-27-at-jenkins-engineering.md` (§6 env-var names)

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

  it('testConnection reaches the controller', { timeout: 30_000 }, async () => {
    const info = await client().testConnection();
    expect(info).toBeDefined();
  });

  it('listJobs and searchJobs return job sets', { timeout: 30_000 }, async () => {
    const c = client();
    expect(Array.isArray(await c.listJobs())).toBe(true);
    expect(Array.isArray(await c.searchJobs())).toBe(true);
  });

  // Optional deeper read-only checks gated on AT_JENKINS_TEST_JOB (a known job fullName):
  // getJob, listBuilds (artifact fields tolerated absent), getBuildLog tail,
  // getBuildStages / getTestReportSummary tolerating Unsupported/undefined.
});
```

`describe.skipIf` keeps the default `npm test` green offline (these tests were never "previously passing" in a default run, so the contract's no-new-skips rule is satisfied — note this in the commit body).

- [ ] **Step 2: Verify both modes**

```bash
npx vitest run test/live/JenkinsClient.live.test.ts   # without env: suite reported as skipped
npx vitest run                                        # full default run stays green
```

If a live controller is actually available in the environment, also run once with `AT_JENKINS_TEST_URL=... AT_JENKINS_TEST_USER=... AT_JENKINS_TEST_TOKEN=...` and record the result in the commit body.

- [ ] **Step 3: Docs + contract sync + commit**

README: document the three env vars, the optional `AT_JENKINS_TEST_JOB`, and that the suite is read-only and skipped by default.

```bash
git add test/live README.md docs/superpowers/plans/2026-08-27-at-jenkins-engineering.md
git commit -m "$(cat <<'EOF'
test: add opt-in live jenkins integration suite gated on env vars

EOF
)"
```

---

### Task 11: i18n completeness audit + docs + package 0.3.0

v1 shipped as 0.2.0; v2 ships as **0.3.0** (spec §10).

**Files:**
- Modify: `package.json` (version 0.3.0), `package.nls.json`, `package.nls.zh-cn.json`, `l10n/bundle.l10n.zh-cn.json`, `README.md`, `README.zh-CN.md` (or the zh section, per v1's split), `CHANGELOG.md`, `docs/features.md`, `docs/features.zh-CN.md`

- [ ] **Step 1: i18n audit**

Most of this is mechanical via `npx vitest run test/i18n/` (parity, placeholders, stale keys, unused manifest keys). Verify green, then spot-check:

- Every command added in Tasks 2–7 (`cancelQueueItem`, `rebuildBuild`, `downloadArtifact`, `searchJobs`, `pinJob`, `unpinJob`, `watchJob`, `unwatchJob`) and the `atJenkins.watch.pollIntervalMs` setting have entries in **both** nls files.
- No raw user-facing literals in `src/` UI paths outside `t()` / `%atJenkins.%` (tree badges, tooltips, status-bar text, and toasts all count — engineering contract §5).

- [ ] **Step 2: D14 / security audit**

- `git diff <v2-start>..HEAD -- src/mcp src/agent` must be empty: no new MCP tools, no catalog/schema changes, still exactly seven `jenkins_*` tools, `test/mcp/toolCatalog.test.ts` untouched and green.
- Queue cancel and rebuild exist only as UI commands with readOnly + modal confirm (A11 / D10).
- Re-run the engineering contract §4 security checklist items touched by v2: no secrets in `atJenkins.pinnedJobs` / `atJenkins.watchedJobs`, SCM `repoUrl` userinfo-stripped, artifact downloads use the redacting logger for errors.
- Migration safety (contract v2 DoD): v2 loads v1 `globalState`/`SecretStorage` data unchanged — the new keys are additive; no existing key changed shape.

- [ ] **Step 3: Docs + version**

- `CHANGELOG.md`: promote `[Unreleased]` v2 entries to `0.3.0`, listing the ten v2 scope items and distinguishing them from v1 fixes.
- `README.md` / zh + `docs/features.md` / `docs/features.zh-CN.md`: Go to Job, queue why/cancel, artifact download, rebuild (secrets re-prompted), SCM read-only view (no Git push, D2), watch (user-initiated; `allowBackgroundAccess` remains MCP-only), pinned jobs, stage/test hover, live-test opt-in.
- `package.json` version → `0.3.0`. Publisher stays `"local"` — choosing a marketplace publisher is a human release gate, never done by an implementer (engineering contract §7).

- [ ] **Step 4: Full suite + package + commit**

```bash
npx vitest run
npm run typecheck
npm run compile
npm run package
```

Expected: all tests green (live suite skipped without env), compile prints no hub-bundle warning, `at-jenkins-0.3.0.vsix` created.

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: document v2 features and package at-jenkins 0.3.0

EOF
)"
```

---

## Frozen-scope coverage self-check

| v2 scope item | Task(s) |
|---|---|
| 1. `atJenkins.searchJobs` Go to Job QuickPick (active instance, D6; job summary instead of `reveal` since `getParent` is absent) | 5 |
| 2. Queue `why` in status bar + job tooltip during queue poll; `atJenkins.cancelQueueItem` UI write with confirm + readOnly (A11 / D10 addendum, not MCP) | 1, 2 |
| 3. Artifacts as tree children; download via `.../artifact/<path>` + Save dialog; UI only, no MCP artifact tools (D14) | 4 |
| 4. Rebuild with same parameters composing `getBuild` actions + `collectJobParameters`/`triggerBuildHandler`; secrets re-prompted | 3 |
| 5. SCM-backed pipeline read-only view for `CpsScmFlowDefinition` (repo/branch/scriptPath from config.xml); save stays disabled; no Git push (D2) | 8 |
| 6. Opt-in watch job → poll lastBuild → `notifyBuildCompletion`; user-initiated (allowBackgroundAccess is MCP-only) | 7 |
| 7. Favorites/pinned jobs at Jobs tree root, per-instance globalState (`atJenkins.pinnedJobs`) | 6 |
| 8. Textual `wfapi` stage summary, hidden when plugin absent; NOT a stage-timeline webview (A13, D8 deferred) | 9 |
| 9. JUnit `testReport/api/json` counts on build tooltip; UI only | 9 |
| 10. Opt-in live tests gated on `AT_JENKINS_TEST_URL`/user/token; default `npm test` skips | 10 |

## Milestone mapping (spec §10)

| Spec milestone | Tasks |
|---|---|
| M11 — Go to Job, pinned jobs | 5, 6 |
| M12 — Queue visibility + cancel | 1, 2 |
| M13 — Artifacts + rebuild | 3, 4 |
| M14 — SCM summary, stage summary, JUnit counts | 8, 9 |
| M15 — Watch + live test harness | 7, 10 |
| Release polish | 11 |

**Write-guard double-check:** the two UI mutations in this plan — queue cancel (Task 2) and rebuild (Task 3) — both (a) check `instance.readOnly` before any prompt or HTTP call, in the handler **and** in the client method, and (b) require a modal `showWarningMessage` confirm. Artifact download, search, pins, watch, stages, and test counts are reads.

**D14 hard rule:** no changes under `src/mcp/` or `src/agent/` anywhere in this plan. No MCP tools for artifacts, tests, queue, or search — each would require a documented D14 amendment (engineering contract §1), which this plan does not propose.

**Consistency:** persistence keys are `atJenkins.pinnedJobs` and `atJenkins.watchedJobs` (spec A14 shape `Array<{instanceId, jobFullName}>`); the new setting is `atJenkins.watch.pollIntervalMs` (15000, clamp 5000–300000); contextValue markers are space-separated ` queued` / ` pinned` / ` watched` appended to the existing `jenkinsJob*` values, with the Task 2 when-clause migration landing before any marker ships.

**Placeholder scan:** none intentional.
