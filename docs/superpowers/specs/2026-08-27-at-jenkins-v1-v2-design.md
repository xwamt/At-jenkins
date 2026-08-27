# AT Jenkins v1 / v2 Design

**Date:** 2026-08-27
**Status:** Approved — supplements `docs/superpowers/specs/2026-08-25-at-jenkins-design.md`
**Baseline:** `at-jenkins` 0.1.0 (M0–M5 shipped)
**Version split (frozen):** **v1** = make 0.1.0 production-safe / operator-usable → ships as **0.2.0**. **v2** = operator-depth features → ships as **0.3.0**.
**Locked decisions:** D1–D18 from the 2026-08-25 spec remain locked and are **not** renumbered or amended here. This spec adds addenda (A1–A15) that extend, but never contradict, the locked set.

---

## 中文摘要（维护者速览）

本规格把 0.1.0 之后的剩余工作冻结为两个版本：

- **v1（发布为 0.2.0）— 生产可用加固**：流水线保存冲突检测（Overwrite / Diff / Cancel，取消后草稿保持脏状态）；实例配置逐条 `safeParse`（单条损坏不影响其余实例）且 `verifyTls` 缺省为 `true`；日志跟随改为每个构建独立 Output 通道 + 停止命令 + 去重，progressiveText 每轮软上限、UTF-8 字节边界安全；HTTP 层同源 GET 3xx 跟随、登录页重定向映射为 `AuthError`、`requestJson` 空响应不再静默返回 `undefined`；File/Run/credentials 参数拒绝触发并提供“在 Jenkins 中打开”；TLS 生命周期（忘记证书命令、TOFU 弹窗合并、http+凭据警告）；状态栏支持并发跟随；`atJenkins.*` 设置热加载；GitHub Actions CI；MCP `jenkins_get_build` 加 `tree` 约束并对疑似密码参数脱敏（仍是 7 个只读工具，D14 不变）；补齐 i18n 残留；打包卫生（publisher 为**人工发布关口**，中英双 README，清理过期 vsce 参数）。
- **v2（发布为 0.3.0）— 运维深度功能**：任务搜索/跳转 QuickPick（仅活动实例，遵守 D6）；构建队列可见性（`why`）与取消排队项（UI 写操作，确认 + readOnly 守卫，属 D10 附录而非 D3 变更）；构建产物列表与下载（仅 UI，MCP 产物工具需修订 D14，排除在外）；按上次参数重建；SCM 流水线只读摘要（D2 保持 view-only）；任务关注与后台完成通知（可选开启）；收藏/置顶任务；文本化流水线阶段摘要（**不做** stage-timeline webview，D8 继续搁置）；构建 JUnit 测试计数（UI）；可选开启的真实 Jenkins 集成测试。

MCP 在两个版本中都保持锁定的 7 个只读工具（D3 / D14），任何写能力或新工具均不在本规格范围内。

**配套计划（实施时按此顺序读）：**

1. 本规格（决策与范围）
2. [`../plans/2026-08-27-at-jenkins-engineering.md`](../plans/2026-08-27-at-jenkins-engineering.md)（DoD / CI / 安全 / i18n）
3. [`../plans/2026-08-27-at-jenkins-v1.md`](../plans/2026-08-27-at-jenkins-v1.md)（0.2.0 任务）
4. [`../plans/2026-08-27-at-jenkins-v2.md`](../plans/2026-08-27-at-jenkins-v2.md)（0.3.0 任务，依赖 v1 完成）

**规范命令与环境变量（与实现计划对齐，实施时不得再改名）：**

| 用途 | 规范 ID |
|---|---|
| 忘记已信任证书 | `atJenkins.forgetTrustedCertificate` |
| 停止跟随日志 | `atJenkins.stopFollowingBuildLog` |
| 跳转到任务 | `atJenkins.searchJobs`（标题 “Go to Job…”） |
| 取消排队项 | `atJenkins.cancelQueueItem` |
| 下载产物 | `atJenkins.downloadArtifact` |
| 用上次参数重建 | `atJenkins.rebuildBuild` |
| 关注 / 置顶 | `atJenkins.watchJob` / `unwatchJob` / `pinJob` / `unpinJob` |
| 真实 Jenkins 集成测试 | `AT_JENKINS_TEST_URL` / `AT_JENKINS_TEST_USER` / `AT_JENKINS_TEST_TOKEN`（可选 `AT_JENKINS_TEST_JOB`） |

v2 跳转到任务打开 Job Summary，不要求实现 `TreeView.reveal`（`JobsTreeProvider` 当前无 `getParent`）。阶段信息走 hover/summary 懒加载；不做 `atJenkins.showStageSummary` 独立命令，除非后续修订本表。

---

## 1. Goal

Harden the shipped 0.1.0 skeleton into an extension an operator can trust against a production Jenkins controller (v1 / 0.2.0), then add the operator-depth conveniences that make it a daily driver (v2 / 0.3.0) — without touching the locked contract: **UI owns all mutations, MCP stays the seven read-only tools of D14**, and the Nacos-aligned module layout of D18 stays intact.

### Shipped baseline — do not re-plan

Current `HEAD` already includes (all out of scope for this spec except where a v1 item explicitly hardens them):

- Jobs tree weather/`healthReport`, type badges, lazy build load-more
- Status-bar active controller + single build follow, recent-parameters reuse (`src/commands/recentParams.ts`)
- `atJenkins.openInJenkins` with http/https scheme check (`isSafeJenkinsWebUrl`)
- `logText/progressiveText` streaming with `/consoleText` fallback (`JenkinsClient.getBuildLog`)
- CSRF crumb + `JSESSIONID` binding for `password` **and** `none` auth modes
- Settings: `atJenkins.builds.pageSize`, `atJenkins.log.pollIntervalMs`, `atJenkins.log.uiTailBytes`, `atJenkins.follow.pollIntervalMs`, `atJenkins.follow.maxPolls` (clamped in `src/config/settings.ts`)
- Webview CSP without `unsafe-inline` (`src/webview/html.ts`) + webview html tests

---

## 2. Decisions — v1/v2 addenda

D1–D18 stay as written in the 2026-08-25 spec. Addenda below are numbered A1+ to avoid any confusion with the locked table.

| # | Ver | Addendum | Relates to |
|---|-----|----------|------------|
| A1 | v1 | Draft publish moves into the async `writeFile` of the draft FileSystemProvider; a cancelled or failed publish **rejects the save**, so the editor natively keeps the dirty flag. | D7, D10 |
| A2 | v1 | Remote-conflict detection on pipeline save: remote script is compared against the draft `baseContent`; divergence raises a new `Conflict` error and an **Overwrite / Show Diff / Cancel** modal (Cancel is default and keeps the draft dirty). | D10, §8 |
| A3 | v1 | Instance config parsing is per-entry `safeParse`: a corrupt entry is skipped with a warning, never bricks the rest, and is preserved in storage rather than silently deleted. `verifyTls` defaults to `true` when absent. | D15, D18 |
| A4 | v1 | `JenkinsHttpClient` follows same-origin GET/HEAD 3xx (≤ 5 hops); any redirect to a login page raises `AuthError`; `requestJson` throws on empty/204 bodies instead of returning `undefined`. | D4 |
| A5 | v1 | Parameter types the extension cannot collect (File / Run / credentials) refuse the trigger with an “Open in Jenkins” action instead of sending a wrong payload. Text (multiline) parameters get a minimal editor-based input. | D1 |
| A6 | v1 | TLS lifecycle: `atJenkins.forgetTrustedCertificate` command; concurrent TOFU prompts for the same `host:port` are coalesced into one modal; configuring `apiToken`/`password` on an `http:` baseUrl warns (non-blocking). | D15 |
| A7 | v1 | Status bar and follow service support **concurrent** build follows keyed per build; completion toasts are never dropped. `atJenkins.*` settings live-reload via `onDidChangeConfiguration`. | D8 |
| A8 | v1 | MCP `jenkins_get_build` uses a bounded `tree=` selector and scrubs password-like parameter values from results. The tool set stays **exactly** D14’s seven read-only tools. | D3, D14 |
| A9 | v1 | `openInJenkins` compares the resolved URL host against the configured instance `baseUrl` host; on mismatch it asks for confirmation before `openExternal`. | — |
| A10 | v1 | Real marketplace `publisher` is a **human release gate** (documented, not invented here). README ships in English (`README.md`) + Chinese (`README.zh-CN.md`). Stale vsce flags are dropped. | — |
| A11 | v2 | Cancelling a queued item is a **UI-owned write** behind confirm + per-instance `readOnly` — an addendum to D10’s write-guard list. D3 (MCP read-only) is unchanged. | D10 |
| A12 | v2 | Build artifacts are **UI-only** (list + download). MCP artifact tools would amend D14 and are out of v2. | D14 |
| A13 | v2 | Pipeline stage insight ships as a **textual summary** via the `wfapi` endpoint. The stage-timeline webview stays deferred. | D8 |
| A14 | v2 | Watch and pinned-job state persists in `globalState` (`atJenkins.watchedJobs`, `atJenkins.pinnedJobs`); rendering is scoped to the active instance. | D6 |
| A15 | v2 | Live Jenkins integration tests are opt-in via explicit `AT_JENKINS_TEST_*` env vars and never run in default CI. | §9 (2026-08-25) |

---

## 3. Architecture deltas

No new top-level modules; D18’s layout stays. Invasiveness is labeled **small / medium / large** per file.

### v1 (0.2.0)

| Area | File(s) | Delta | Invasiveness |
|---|---|---|---|
| Pipeline save | `src/document/JenkinsPipelineDraftFileSystemProvider.ts`, `src/document/PipelineScriptDocumentProvider.ts` | Publish (confirm → conflict check → POST) moves into async `writeFile` via an injected publish callback; `savePipelineScript` refactored to be that callback; the `onDidSaveTextDocument` hook is removed. Throwing from `writeFile` keeps the editor dirty (A1). | medium |
| Conflict check | `src/jenkins/JenkinsClient.ts`, `src/jenkins/errors.ts` | `updatePipelineScript(fullName, script, opts?: { expectedCurrentScript?: string })` — the script extracted from the config.xml fetched for the POST is compared against `expectedCurrentScript` (the draft `baseContent`); mismatch throws `Conflict` **before** the POST. Single fetch; no extra round-trip; minimal TOCTOU window. | small |
| Config resilience | `src/config/schema.ts`, `src/config/JenkinsInstanceConfigManager.ts` | New `parseJenkinsInstanceConfigListSafe(value): { instances, dropped }` using per-entry `safeParse`; `verifyTls: z.boolean().default(true)`. `persist()` merges by `id` into the **raw** stored array so unparseable entries survive until the user fixes or deletes them. | medium |
| HTTP redirects | `src/jenkins/JenkinsHttpClient.ts` | GET/HEAD follow same-origin 3xx up to 5 hops (auth headers re-sent only same-origin); redirect `Location` matching `/login` (Jenkins securityRealm) → `AuthError`; cross-origin redirect → error, not followed. `ok` tightens to `2xx`. POST is never auto-followed (trigger-build’s 201 + `Location` queue header remains data, not a redirect). | medium |
| `requestJson` | `src/jenkins/JenkinsHttpClient.ts` | 204/empty body throws `Error('Jenkins returned an empty response where JSON was expected: <path>')`; callers audited (`testConnection`, `listJobs`, `getQueueItem`, MCP handlers). | small |
| Log follow | `src/document/BuildLogDocumentProvider.ts`, new `src/commands/followRegistry.ts`, `src/commands/buildFollow.ts` | Per-build Output channel + registry (dedupe), stop command, non-quadratic progressive reads, UTF-8-safe appends (§5, §6). | medium |
| UTF-8 slicing | `src/jenkins/logTruncate.ts` | New `alignUtf8Start(buf, offset)` helper skips continuation bytes (`0b10xxxxxx`) so byte-offset slices never start mid-character; follow loop uses a streaming `TextDecoder('utf-8', { stream: true })` per session so chunk boundaries never split characters. | small |
| Parameters | `src/commands/buildCommands.ts` | Unsupported-type refusal + Text multiline flow (§6). | small |
| TLS lifecycle | `src/jenkins/createInteractiveCertVerifier.ts`, new `src/commands/certCommands.ts` | Prompt coalescing map; `atJenkins.forgetTrustedCertificate` over `JenkinsCertTrustStore.getAllTrusted()`. | small |
| http+creds warning | `src/webview/JenkinsInstancePanel.ts` (save path) | Non-blocking warning when `baseUrl` is `http:` and `authMode !== 'none'`. | small |
| Status bar | `src/utils/statusBar.ts`, `src/commands/buildFollow.ts` | `Map`-keyed concurrent follows; drop the single-slot `followGeneration` invalidation (§6). | medium |
| Settings reload | `src/extension.ts`, `src/config/settings.ts` | `onDidChangeConfiguration('atJenkins')` → consumers read settings through a getter instead of an activation-time snapshot. | small |
| CI | new `.github/workflows/ci.yml` | `npm ci` → `typecheck` → `vitest run` → `compile`; optional VSIX artifact. | small |
| MCP | `src/jenkins/types.ts`, `src/jenkins/JenkinsClient.ts`, new `src/mcp/scrubBuildDetail.ts` | `GET_BUILD_TREE` bounded selector for `getBuild`; scrub pass on `jenkins_get_build` results (§7). | small |
| Open in Jenkins | `src/commands/openInJenkins.ts` | Host check vs configured `baseUrl` (A9). | small |
| i18n | `src/tree/JobsTreeProvider.ts`, `src/webview/html.ts`, `l10n/bundle.l10n.zh-cn.json` | Wrap `[Multibranch]` / `[Organization]` badges in `t()`; audit TOFU dialog strings in the zh bundle; `lang` attribute from `vscode.env.language`. | small |
| Packaging | `package.json`, `README.md`, new `README.zh-CN.md` | Drop `--allow-missing-repository` (repository field exists); re-evaluate `--no-rewrite-relative-links`; README split (A10). | small |

### v2 (0.3.0)

| Area | File(s) | Delta | Invasiveness |
|---|---|---|---|
| Go to Job | new `src/commands/searchJobs.ts` | `atJenkins.searchJobs` QuickPick over a cached recursive job walk of the **active instance only** (D6); pick opens Job Summary (no `getParent` / `reveal` required). | medium |
| Queue | `src/jenkins/JenkinsClient.ts`, `src/tree/JobsTreeProvider.ts`, `src/commands/buildCommands.ts` | `getQueueItemsForJob` (`GET /queue/api/json?tree=items[id,why,inQueueSince,stuck,task[name,url]]`, filtered by job URL), `cancelQueueItem(id)` (`POST /queue/cancelItem?id=<id>`, `ReadOnly` guard); queued pseudo-node with `why` as description. | medium |
| Artifacts | `src/jenkins/JenkinsHttpClient.ts`, new `src/commands/artifacts.ts`, `src/tree/JobsTreeProvider.ts` | Streaming `downloadToFile(req, destPath)` on the HTTP client (current client buffers whole bodies — required for large artifacts); artifacts children under completed builds; download via `showSaveDialog`. | medium |
| Rebuild | new `src/commands/rebuild.ts` | Fetch prior parameters from `getBuild` `actions[parameters[name,value]]`; masked/password values re-prompted; unsupported types refused as in v1; confirm shows the parameter table; then `triggerBuild`. | small |
| SCM summary | `src/jenkins/JenkinsClient.ts`, `src/document/JobSummaryDocumentProvider.ts` | Parse `CpsScmFlowDefinition` config.xml (SCM class, remote URL with userinfo stripped, branches, `scriptPath`, lightweight flag) into the read-only job summary. No SCM push (D2). | medium |
| Watch | new `src/watch/JobWatchService.ts`, `src/tree/JobsTreeProvider.ts` | Opt-in per-job polling of `getJob().lastBuild`; building→finished transition fires `notifyBuildCompletion`. Runs only while the extension host is alive. | medium |
| Pinned | new `src/config/pinnedJobs.ts`, `src/tree/JobsTreeProvider.ts` | Pinned section at the top of the Jobs tree for the active instance. | small |
| Stage summary | `src/jenkins/JenkinsClient.ts`, `src/document/uri.ts`, `src/document/JobSummaryDocumentProvider.ts` (or a sibling provider) | `getBuildStages` via `GET <job>/<n>/wfapi/describe`; 404 → `Unsupported` (“requires the Pipeline Stage View plugin”). Textual table in a read-only virtual doc; **no webview** (A13). | medium |
| JUnit counts | `src/jenkins/types.ts`, `src/tree/JobsTreeProvider.ts` | Extend `GET_BUILD_TREE` with `actions[totalCount,failCount,skipCount]` (`TestResultAction`); render counts in build tooltip/description and job summary. | small |
| Live tests | new `vitest.live.config.ts`, `test/integration/`, optional `test-fixtures/live/docker-compose.yml` | Env-gated live suite (A15). | small |

---

## 4. Data / API

### New error class (v1)

`src/jenkins/errors.ts` — extend `JenkinsErrorCode` with `'Conflict'`:

```ts
export interface ConflictDetails {
  jobFullName?: string;
  operation?: string; // 'updatePipelineScript'
}

/** Remote resource changed since the draft baseline was taken. */
export class Conflict extends JenkinsError {
  readonly code = 'Conflict' as const;
  constructor(message: string, public readonly details?: ConflictDetails) { … }
}
```

Login-redirect detection maps to the existing `AuthError` — no new class.

### Settings keys

| Key | Ver | Default (clamped) | Purpose |
|---|---|---|---|
| `atJenkins.follow.softCapBytesPerPoll` | v1 | `1048576` (min `65536`, max `16777216`) | Per-poll soft cap on progressive log text appended to an Output follow; overflow is skipped with an explicit `[… N bytes omitted …]` marker (never silently). |
| `atJenkins.watch.pollIntervalMs` | v2 | `15000` (min `5000`, max `300000`) | Poll interval for watched jobs. |

All existing `atJenkins.*` keys become live-reloadable in v1 (A7); no key is renamed.

### Persistence keys (v2, `globalState`, no secrets)

| Key | Value |
|---|---|
| `atJenkins.watchedJobs` | `Array<{ instanceId: string; jobFullName: string }>` |
| `atJenkins.pinnedJobs` | `Array<{ instanceId: string; jobFullName: string }>` |

### Client façade changes

| Method | Ver | Notes |
|---|---|---|
| `updatePipelineScript(fullName, script, opts?)` | v1 | `opts.expectedCurrentScript` → `Conflict` on divergence (A2). |
| `getBuild(fullName, n)` | v1 | Adds `query: { tree: GET_BUILD_TREE }` — bounded fields: `number,url,result,building,timestamp,duration,estimatedDuration,displayName,fullDisplayName,description,queueId,artifacts[fileName,relativePath,size],actions[parameters[name,value],causes[shortDescription],totalCount,failCount,skipCount]` (JUnit fields consumed in v2 but harmless in v1). |
| `getBuildLog(fullName, n, { start, maxBytes })` | v1 | Progressive path delivers **every fetched byte exactly once**: `endByte` advances to the server’s `X-Text-Size` (`nextStart`), never by a client-side re-slice. When the fetched body exceeds `maxBytes` (soft cap), the result keeps the **last** `maxBytes` and reports `omittedBytes` (new optional field on `LogTruncateResult`); the caller renders the omission marker. This removes the current quadratic re-download in the drain loop of `followBuildLogInOutput`, where each iteration refetched the remainder but advanced only `OUTPUT_FOLLOW_CHUNK_BYTES` (256 KiB). A `maxResponseBytes` hard cap (8× soft cap) still aborts truly runaway responses. |
| `getQueueItemsForJob(fullName)` / `cancelQueueItem(id)` | v2 | See §3. `cancelQueueItem` throws `ReadOnly` on read-only instances. |
| `getBuildStages(fullName, n)` | v2 | `wfapi/describe`; `NotFound` from the endpoint converts to `Unsupported`. |
| `downloadArtifact(fullName, n, relativePath, destPath)` | v2 | Streams `GET <build>/artifact/<relativePath>` via the new `JenkinsHttpClient.downloadToFile`. |

### Config schema (v1)

- `verifyTls: z.boolean().default(true)` — legacy or hand-edited entries missing the field parse instead of failing.
- `parseJenkinsInstanceConfigListSafe` returns `{ instances: JenkinsInstanceConfig[]; dropped: Array<{ index: number; reason: string }> }`; `JenkinsInstanceConfigManager.listInstances` logs one redacted warning per dropped entry. `persist()` reads the raw stored array and replaces/appends by `id`, leaving undroppable-but-unparseable entries in place.

---

## 5. HTTP behavior (v1)

1. **Redirect policy.** GET/HEAD only; ≤ 5 hops; each hop must resolve to the **same origin** (protocol + host + port) as the request base, else the chain aborts with an error naming the cross-origin target. Auth headers are re-sent only within the same origin.
2. **Login detection.** Any 3xx whose `Location` path ends in or contains `/login` (Jenkins redirects unauthenticated requests to the securityRealm login page) throws `AuthError('Jenkins redirected to its login page — credentials are missing or expired.', status)` — for **all** methods, before any hop is followed.
3. **`ok` semantics.** With redirects followed, `ok` tightens from `2xx–3xx` to `2xx`. `TriggerBuild` keeps reading the `Location` header off the `201` response directly (POST is never auto-followed).
4. **`requestJson`.** Empty/204 responses throw instead of returning `undefined as T`. Callers that legitimately tolerate empty bodies use `request()`.

---

## 6. UI

### v1

**Pipeline save (A1 + A2).** `Ctrl+S` on an `at-jenkins-draft:` document now runs the full publish inside `writeFile`:

1. readOnly / writability guards (unchanged messages).
2. Fetch config.xml once; extract remote script; compare with the draft’s `baseContent`.
3. Equal → existing “Save to Jenkins” confirm → POST → `markClean(uri, content)`.
4. Different → modal: *“The pipeline script for `<job>` changed on Jenkins since you opened this draft.”* with **Overwrite** / **Show Diff** / **Cancel** (default). *Show Diff* opens `vscode.diff(remoteScriptUri, draftUri)` using the read-only `at-jenkins:` script document (refreshed first) and rejects the save. *Cancel* rejects the save. In both non-overwrite paths `markClean` is **not** called and `writeFile` throws, so the tab keeps its dirty dot and the local draft content survives.

**Log follow (A7).**

- Channel name: `AT Jenkins — <jobFullName> #<n>` (one per followed build, replacing the shared `AT Jenkins` channel for follows; the extension log channel is untouched).
- `src/commands/followRegistry.ts`: `Map<followKey, { channel, disposable }>` with `followKey = '<instanceId>/<jobFullName>#<n>'`. Re-invoking `atJenkins.followBuildLogInOutput` on an already-followed build focuses the existing channel instead of starting a second poller (dedupe). Channels persist after completion for reading; they are disposed when the same key is re-followed or explicitly stopped.
- New command **`atJenkins.stopFollowingBuildLog`**: QuickPick of active follows (multi-select, plus a “Stop all” item); stopping disposes the poller and appends a “follow stopped” line.
- Appends go through a per-session streaming `TextDecoder` so multi-byte characters split across chunk boundaries render correctly; soft-cap omissions render as `[… N bytes omitted — open the full log in Jenkins …]`.

**Trigger parameters (A5).** In `collectJobParameters`:

- Definitions whose `type`/`_class` matches `/FileParameterDefinition|RunParameterDefinition|CredentialsParameterDefinition/i` abort the trigger **before** any prompt, with an error notification *“`<job>` uses parameter types this extension cannot collect (`<names>`)”* and an **Open in Jenkins** button targeting the job’s build page. No partial/garbage payload is ever POSTed.
- `TextParameterDefinition` (multiline): cheap editor round-trip — open an untitled side editor pre-filled with the recent/default value, then a modal *“Use editor content for `<name>`?”* (**Use content** / **Cancel**). Single-line String/Choice/Boolean/Password flows are unchanged.

**TLS (A6).**

- **`atJenkins.forgetTrustedCertificate`**: QuickPick over trusted fingerprints (`host:port`, description = fingerprint + trusted date) → confirm → `JenkinsCertTrustStore.untrust`. Registered in `src/commands/certCommands.ts`, contributed to the command palette.
- TOFU prompt coalescing: `createInteractiveCertVerifier` keeps `Map<'host:port', Promise<boolean>>`; concurrent verifications for the same endpoint await one modal; the entry clears on settle.
- Instance save with `http:` + `apiToken`/`password` → one warning toast (*credentials will transit in cleartext*), never a block.

**Status bar (A7).** `JenkinsStatusBarManager` keys building entries by `followKey`; the item shows the most recent entry, with `(+N)` when more follows are active and a tooltip listing all; clicking with multiple follows opens a QuickPick to jump to a build log. `JenkinsBuildFollowService` drops the single-slot `followGeneration` guard in favor of per-key handles, so an earlier follow finishing **always** raises its completion toast.

**Open in Jenkins (A9).** When the resolved URL’s host differs from the configured instance’s `baseUrl` host (server-supplied `job.url` / `build.url` can point elsewhere behind reverse proxies), show a confirm modal naming both hosts before `openExternal`. Scheme check from 0.1.0 is unchanged.

**i18n.** `[Multibranch]` / `[Organization]` badges via `t()`; TOFU dialog strings verified in `l10n/bundle.l10n.zh-cn.json`; webview `<html lang>` derived from `vscode.env.language`.

### v2

| Command | Surface | Behavior |
|---|---|---|
| `atJenkins.searchJobs` | palette + Jobs view title | Title “Go to Job…”. QuickPick over the active instance’s job list (recursive walk, cached, cancellable); select → `atJenkins.openJobSummary`. Active instance only (D6). |
| `atJenkins.cancelQueueItem` | queued node context | Confirm modal → `cancelQueueItem(id)`; blocked by `readOnly` (A11). Queued node id: `queue:<jobFullName>:<queueId>`, description = queue `why`. |
| `atJenkins.downloadArtifact` | artifact node context | `showSaveDialog` → streamed download → toast with “Open File / Reveal”. Artifact node id: `artifact:<jobFullName>#<n>:<relativePath>`. |
| `atJenkins.rebuildBuild` | build node context | Prior parameters pre-filled; masked password values re-prompted; unsupported types refused; confirm lists name=value pairs; triggers and follows like a normal trigger. |
| `atJenkins.watchJob` / `atJenkins.unwatchJob` | job node context | Toggle membership in `atJenkins.watchedJobs`; watched jobs get an eye badge; `JobWatchService` polls at `atJenkins.watch.pollIntervalMs` and raises the existing completion notification on building→finished. Opt-in, in-IDE only. |
| `atJenkins.pinJob` / `atJenkins.unpinJob` | job node context | Toggle `atJenkins.pinnedJobs`; “Pinned” virtual section at the top of the Jobs tree for the active instance. |
| *(no dedicated command)* | build hover / job summary | Textual `wfapi` stage table and JUnit counts, lazy on hover; hide when the plugin/report is absent. **Not** a webview (A13, D8 deferred). |

SCM-backed Pipeline jobs additionally render a read-only definition summary (SCM class, remote — userinfo stripped, branches, script path, lightweight flag) inside the existing job summary document. JUnit counts (`✔ pass ✘ fail ➖ skip`) appear on build tree items and in the job summary.

---

## 7. MCP

Restated, unchanged: **D3 — MCP is read-only; UI owns all mutations. D14 — the tool set is exactly** `jenkins_list_instances`, `jenkins_list_jobs`, `jenkins_get_job`, `jenkins_get_pipeline_script`, `jenkins_list_builds`, `jenkins_get_build`, `jenkins_get_build_log`. Neither v1 nor v2 adds, removes, or renames a tool. D13’s `allowBackgroundAccess` gate and the no-secrets rule stand.

v1 changes inside that envelope (A8):

1. **Bounded `tree`** — `jenkins_get_build` shares the UI’s `GET_BUILD_TREE`, so an Agent asking about one build no longer pulls the unbounded `api/json` graph (unfiltered, it includes full actions and can be very large).
2. **Scrub pass** — `src/mcp/scrubBuildDetail.ts` post-processes `jenkins_get_build` results: any `actions[].parameters[]` entry whose `name` matches `/pass(word)?|secret|token|credential/i`, or whose class marks it as a password parameter value, has its `value` replaced with `'[REDACTED]'`. Applied in the Bridge invoke path only (the UI shows what the operator can already see in Jenkins).

Explicitly out (would amend D14, not proposed): artifact list/download tools, queue tools, stage tools, any write or exec capability.

---

## 8. Errors

The 2026-08-25 error table stays; one row is added and one is clarified:

| Class | When | UX / Agent |
|---|---|---|
| `Conflict` *(new, v1)* | Pipeline script on Jenkins diverged from the draft `baseContent` at save time | Overwrite / Show Diff / Cancel modal; save rejected on non-overwrite so the draft stays dirty |
| `AuthError` *(clarified, v1)* | 401/403 **or** any redirect to the Jenkins login page | Reconfigure credentials; one crumb retry on write (unchanged) |

`Truncated` semantics extend with the optional `omittedBytes` reporting on progressive follow results (§4); continuation parameters are unchanged.

---

## 9. Testing

- **vitest**, TDD for every new/changed module (series convention). Existing suites in `test/` are updated where behavior changes (draft save path, status bar, follow service).
- v1 unit coverage: per-entry `safeParse` (one corrupt entry among valid ones; missing `verifyTls`); `Conflict` raised/not raised around `expectedCurrentScript`; cancel-keeps-dirty via a fake FS/document harness; redirect policy (same-origin hop, cross-origin abort, login-path → `AuthError`, hop limit); `requestJson` empty-body throw; `alignUtf8Start` and streaming-decoder boundary cases (2/3/4-byte sequences split across chunks); soft-cap `omittedBytes` accounting (every byte delivered exactly once — no re-download of already-fetched ranges); unsupported-parameter refusal (no HTTP call recorded); TOFU prompt coalescing (N concurrent verifies → 1 prompt); status-bar Map (two follows, first completion still toasts); `scrubBuildDetail` (password-named and password-classed values redacted, others untouched); `openInJenkins` host-mismatch confirm.
- v1 Bridge tests: `jenkins_get_build` response carries the bounded tree and redacted values; still asserts no secret/cookie leakage.
- **CI (v1):** `.github/workflows/ci.yml` — Node LTS, `npm ci`, `npm run typecheck`, `npm test`, `npm run compile`; VSIX packaging as an artifact step (non-publishing).
- v2 unit coverage: queue path parsing/filtering + `ReadOnly` guard on cancel; artifact download streaming (temp-file target, size mismatch abort); rebuild parameter extraction incl. masked-password re-prompt; `wfapi` 404 → `Unsupported`; watch service transition detection with fake timers; pinned/watched persistence round-trips.
- **Live integration tests (v2, A15):** `test/live/*.live.test.ts` behind `AT_JENKINS_TEST_URL` / `AT_JENKINS_TEST_USER` / `AT_JENKINS_TEST_TOKEN` (optional `AT_JENKINS_TEST_JOB`); whole suite skips when unset; never wired into default CI. Optional local harness: `test-fixtures/live/docker-compose.yml` (jenkins/jenkins:lts + JCasC-seeded jobs).

---

## 10. Milestones

No calendar estimates; sized by invasiveness.

### v1 → 0.2.0

| Milestone | Deliverable | Size |
|---|---|---|
| **M6** | Config resilience (per-entry `safeParse`, `verifyTls` default, raw-array-preserving persist) + HTTP hardening (same-origin GET 3xx, login → `AuthError`, `requestJson` throw) | medium |
| **M7** | Pipeline save safety: publish-in-`writeFile`, `Conflict` error, Overwrite/Diff/Cancel, cancel-keeps-dirty | medium |
| **M8** | Log follow UX: per-build channels + registry + `atJenkins.stopFollowingBuildLog`, non-quadratic progressive reads with soft cap, UTF-8-safe slicing | medium |
| **M9** | Parameters (unsupported-type refusal, Text multiline), TLS lifecycle (`atJenkins.forgetTrustedCertificate`, prompt coalescing, http+creds warning), concurrent status-bar follows, settings live-reload | medium |
| **M10** | Engineering & packaging: CI workflow, `GET_BUILD_TREE` + MCP scrub, openInJenkins host check, i18n leftovers, README en/zh, vsce flag cleanup, **publisher release-gate doc** | small |

### v2 → 0.3.0

| Milestone | Deliverable | Size |
|---|---|---|
| **M11** | Go to Job QuickPick (+ `getParent` for reveal), Favorites/pinned jobs | medium |
| **M12** | Queue visibility (`why`) + cancel queued item (confirm + readOnly) | medium |
| **M13** | Artifacts list + streaming download; Rebuild with same parameters | medium |
| **M14** | SCM read-only summary, textual stage summary (`wfapi`), JUnit counts | medium |
| **M15** | Watch jobs + background completion notifications (opt-in), live integration test harness | medium |

**Release gate (human, before any marketplace publish):** choose and register the real `publisher` id, update `package.json`, re-verify icon/license/repository metadata, and re-package. This spec deliberately does not invent a publisher id.

---

## 11. Non-goals

Everything in §11 of the 2026-08-25 spec still holds. Additionally out of v1/v2 core (may revisit later):

- Pipeline **replay** (`/replay`)
- **Scan Multibranch** / re-index triggers
- **Matrix** configuration child nodes
- Blue Ocean APIs or UI
- SSO / OIDC / custom auth headers
- **Any MCP write**, and any new MCP tool (artifacts, queue, stages) — each would amend D14 and is explicitly not proposed
- Stage-timeline **webview** (D8 stays deferred; v2 ships the textual summary only)
- IDE→SCM push for SCM-backed pipelines (D2 stays view-only)

---

## 12. References

- Locked design: `docs/superpowers/specs/2026-08-25-at-jenkins-design.md` (D1–D18)
- Implementation plan for the baseline: `docs/superpowers/plans/2026-08-25-at-jenkins.md`
- UX optimization plan already shipped into 0.1.0: `docs/superpowers/plans/2026-08-27-jenkins-ui-ux-optimization.md`
- Code anchors: `src/jenkins/JenkinsHttpClient.ts`, `src/jenkins/JenkinsClient.ts`, `src/jenkins/logTruncate.ts`, `src/config/schema.ts`, `src/config/JenkinsInstanceConfigManager.ts`, `src/document/JenkinsPipelineDraftFileSystemProvider.ts`, `src/document/PipelineScriptDocumentProvider.ts`, `src/document/BuildLogDocumentProvider.ts`, `src/commands/buildCommands.ts`, `src/commands/buildFollow.ts`, `src/commands/openInJenkins.ts`, `src/utils/statusBar.ts`, `src/mcp/toolCatalog.ts`
- Hub integration: `at-series-mcp-hub/docs/guides/plugin-integration.md`; protocol `v1.md` / `v2.md`
- Jenkins APIs used: `logText/progressiveText` (+ `X-Text-Size`), `crumbIssuer`, `queue/api/json` + `queue/cancelItem`, `artifact/<path>`, `wfapi/describe` (Pipeline Stage View plugin)
