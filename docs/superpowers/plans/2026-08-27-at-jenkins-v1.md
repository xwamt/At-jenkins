# AT Jenkins v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing `at-jenkins` extension into a releasable v1: robust config parsing, correct HTTP redirect/auth semantics, bounded log transfer, safe pipeline-save flow (conflict + cancel keeps dirty), unsupported-parameter guards, TOFU UX polish, concurrent build follows with per-build Output channels and a multi-slot status bar, live-reload settings, tighter MCP responses, i18n completeness, CI, and docs.

**Architecture:** All changes are refinements of modules already in tree. No new subsystems: `src/config` (schema + manager), `src/jenkins` (http client, client façade, log truncation, TOFU), `src/document` (draft FS + providers), `src/commands` (build trigger/follow, open-in-Jenkins), `src/utils/statusBar.ts`, `src/agent` (MCP tool service), plus `package.json`/nls/l10n, `.github/workflows`, and docs. UI still owns all mutations; MCP stays the existing **seven read-only tools** (no additions, no removals).

**Tech Stack:** TypeScript 5.x strict, vitest (`test-fixtures/vscode.ts` mock + `test/jenkins/testHttpServer.ts` real HTTP fixture), zod, esbuild, `@at-series/mcp-hub`, VS Code `^1.85.0`, `vscode.l10n`.

**Spec:** `docs/superpowers/specs/2026-08-27-at-jenkins-v1-v2-design.md` (addenda A1–A10). Design decisions **D1–D18 from `docs/superpowers/specs/2026-08-25-at-jenkins-design.md` are locked** — nothing here may contradict them. **Contract:** `docs/superpowers/plans/2026-08-27-at-jenkins-engineering.md`.

**TDD:** Every task writes a failing test first, watches RED, then implements. Commits use HEREDOC. Never update git config. Never skip hooks.

**Baseline already in tree — do NOT re-implement:** weather icons/badges rendering, status-bar follow (single slot — Task 9 upgrades concurrency only), recent params memory (`src/commands/recentParams.ts`), `openInJenkins` scheme check (`isSafeJenkinsWebUrl`), `progressiveText` + `consoleText` fallback (`JenkinsClient.getBuildLog`), crumb + `JSESSIONID` cookie (`JenkinsAuthenticator`), settings read-at-activate (`readAtJenkinsSettings`), webview CSP (`renderWebviewHtml`), html tests.

**Hard constraints:** MCP stays exactly 7 read-only tools. Do not set a marketplace publisher id (`publisher` stays `local`; publishing is a human gate). Do not build SSO, stage timeline webview, artifact download, job search, or queue cancel — those are v2.

---

## File map

| Path | Touched by | Change |
|---|---|---|
| `src/config/schema.ts` | T1 | `verifyTls` default, lenient list parse |
| `src/config/JenkinsInstanceConfigManager.ts` | T1 | per-entry safeParse, preserve unparsed entries on persist |
| `src/jenkins/JenkinsHttpClient.ts` | T2, T3 | same-origin GET redirect follow, 3xx/login → AuthError, `requestJson` never silent-undefined, soft-cap partial body |
| `src/jenkins/logTruncate.ts` | T3 | UTF-8-safe slice boundaries |
| `src/jenkins/JenkinsClient.ts` | T3, T11 | capped `fetchProgressiveText`, `GET_BUILD_TREE` selector |
| `src/jenkins/types.ts` | T11 | `GET_BUILD_TREE`, `BuildAction`/parameter action typing |
| `src/jenkins/errors.ts` | T4 | new `Conflict` error |
| `src/document/JenkinsPipelineDraftFileSystemProvider.ts` | T4 | async `writeFile` publish gate (cancel keeps dirty) |
| `src/document/PipelineScriptDocumentProvider.ts` | T4 | conflict check vs `baseContent`, publish refactor |
| `src/document/BuildLogDocumentProvider.ts` | T8 | per-build Output channels, dedupe, stop support |
| `src/commands/buildCommands.ts` | T5 | unsupported param-type guard, optional multiline text handling |
| `src/commands/buildFollow.ts` | T9 | concurrent follows (drop generation counter), maxPolls expiry toast |
| `src/commands/openInJenkins.ts` | T12 | host vs baseUrl confirm-on-mismatch |
| `src/jenkins/createInteractiveCertVerifier.ts` | T6 | prompt coalescing |
| `src/webview/JenkinsInstancePanel.ts` | T7, T13 | http+credentials warning; webview lang |
| `src/webview/html.ts` | T13 | `lang` attribute from `vscode.env.language` |
| `src/utils/statusBar.ts` | T9 | multi-follow Map rendering |
| `src/tree/InstancesTreeProvider.ts`, `src/tree/JobsTreeProvider.ts` | T13 | localize `[RO]` / job-type badges |
| `src/config/settings.ts`, `src/extension.ts` | T4, T6, T8, T10 | publish wiring, forget-cert + stop-follow commands, `onDidChangeConfiguration` |
| `package.json`, `package.nls.json`, `package.nls.zh-cn.json`, `l10n/bundle.l10n.zh-cn.json` | T6, T8, T13 | new commands + strings |
| `.github/workflows/ci.yml` | T14 | typecheck, test, compile, package artifact |
| `README.md`, `README.zh-CN.md`, `CHANGELOG.md`, `docs/features.md`, `docs/features.zh-CN.md` | T15 | v1 docs |
| `test/**` | all | one test file per touched module (paths named per task) |

Run the full gate after every task: `npx vitest run` and `npm run typecheck`.

---

### Task 1: Config per-entry safeParse + verifyTls default (配置逐条解析与 verifyTls 默认值)

One corrupt stored instance currently breaks the whole extension: `listInstances()` calls `parseJenkinsInstanceConfigList(stored)` which `.parse()`s the array and throws. Also `verifyTls: z.boolean()` is required, so an entry written by an older/other build without the field is invalid.

**Files:**
- Modify: `src/config/schema.ts`, `src/config/JenkinsInstanceConfigManager.ts`
- Test: `test/config/schema.test.ts`, `test/config/JenkinsInstanceConfigManager.test.ts`

**Interfaces:**
- `schema.ts`: change `verifyTls: z.boolean()` → `z.boolean().default(true)` (fail-safe: unknown = verify).
- `schema.ts`: add `parseJenkinsInstanceConfigListLenient(value: unknown): { instances: JenkinsInstanceConfig[]; invalidCount: number }` — per-entry `jenkinsInstanceConfigSchema.safeParse`, skipping failures.
- `JenkinsInstanceConfigManager.listInstances()`: use the lenient parser; `log.warn` once per call when `invalidCount > 0` (include count, never entry contents — secrets policy).
- `JenkinsInstanceConfigManager.persist()`: read the **raw** stored array, replace/append only the entry with matching `id`, keep unparseable raw entries untouched (a corrupt entry must not be silently deleted by saving an unrelated instance).

- [ ] **Step 1: Write failing tests**

`test/config/schema.test.ts` — add:

```ts
it('defaults verifyTls to true when missing', () => {
  const cfg = parseJenkinsInstanceConfig({
    id: 'i1', label: 'x', baseUrl: 'https://ci.example.com',
    authMode: 'none', createdAt: 1, updatedAt: 1
  });
  expect(cfg.verifyTls).toBe(true);
});

it('lenient list parse skips invalid entries and keeps valid ones', () => {
  const { instances, invalidCount } = parseJenkinsInstanceConfigListLenient([
    validEntry, { id: 42, garbage: true }
  ]);
  expect(instances).toHaveLength(1);
  expect(invalidCount).toBe(1);
});
```

`test/config/JenkinsInstanceConfigManager.test.ts` — add: `listInstances()` with one corrupt entry in the memento returns the valid ones (no throw); `createInstance()` while a corrupt entry exists does not drop the corrupt raw entry from the stored array (assert via `globalState.get('atJenkins.instances')`).

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/config/schema.test.ts test/config/JenkinsInstanceConfigManager.test.ts
```

- [ ] **Step 3: Implement** as per Interfaces above. Keep `parseJenkinsInstanceConfigList` exported (strict variant still used by tests) but stop calling it from `listInstances`.

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/config/
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/config test/config
git commit -m "$(cat <<'EOF'
fix: tolerate corrupt stored instances and default verifyTls to true
EOF
)"
```

**i18n keys:** none (log-only strings are not localized).
**Risk notes:** Low invasiveness. Watch the `persist()` sort — it currently sorts by label; keep raw entries at the tail (they have no guaranteed label). Do not `.parse()` inside `persist()` on the raw entries.

---

### Task 2: HTTP redirect + auth semantics (HTTP 重定向与认证语义)

`JenkinsHttpResponse.ok` is `status >= 200 && status < 400`, so a GET answered `302 → /login` (anonymous read disabled) is "ok" with an empty body, and `requestJson` returns `undefined as T` — a silent lie. Meanwhile Jenkins write endpoints (`/build`, `/buildWithParameters`, `/stop`, `config.xml` POST) legitimately answer 302 and `triggerBuild` reads `res.headers['location']` from it — that must keep working.

**Files:**
- Modify: `src/jenkins/JenkinsHttpClient.ts`
- Test: `test/jenkins/JenkinsHttpClient.test.ts` (uses `startTestHttpServer` from `test/jenkins/testHttpServer.ts`)

**Interfaces:**
- `performRequest`/`requestRaw`: for **GET/HEAD only**, follow `Location` redirects that resolve to the **same origin** (protocol + hostname + port equal to the current target), max 5 hops, re-sending the same headers. Never follow for POST/PUT/DELETE.
- `ok` semantics: for GET/HEAD, `ok = status >= 200 && status < 300` (any residual 3xx after following is not ok). For mutating methods, keep `ok = status >= 200 && status < 400` (preserves POST-302-as-success and the `location` header for `triggerBuild`).
- `handleHttpError`: residual GET 3xx whose `Location` path includes `/login` → `throw new AuthError(...)` (message says authentication is required / anonymous read is disabled); other residual 3xx → generic `Error` naming the redirect target.
- `requestJson<T>`: on 204 or empty body, `throw new Error(...)` naming `req.path` ("returned an empty response where JSON was expected") instead of `return undefined as T`. Callers already guard with `res?.jobs ?? []` etc., so behavior only changes where the old behavior was a bug. `JenkinsAuthenticator.fetchCrumb` uses `request()` and is unaffected.

- [ ] **Step 1: Write failing tests** in `test/jenkins/JenkinsHttpClient.test.ts`:

```ts
it('follows a same-origin GET redirect and returns the final body', async () => { /* 302 /a → /b, expect body of /b */ });
it('does not follow cross-origin redirects and maps GET 302 to /login to AuthError', async () => { /* Location: http://other-host/login */ });
it('maps residual same-origin GET redirect loops to an error after 5 hops', async () => { /* /a → /a */ });
it('keeps POST 302 as success and preserves the location header', async () => { /* POST → 302 Location: /queue/item/1/ */ });
it('requestJson throws instead of returning undefined on an empty 200 body', async () => { /* expect rejects.toThrow(/empty response/) */ });
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/jenkins/JenkinsHttpClient.test.ts
```

- [ ] **Step 3: Implement.** Put the hop loop in `requestRaw` around `performRequest` (reuse the existing stale-keep-alive retry inside each hop). Same-origin check compares `new URL(location, currentTarget)` origin to `currentTarget` origin. Redirect targets go through the same `certVerifier` path automatically (same client options).

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/jenkins/
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/jenkins/JenkinsHttpClient.ts test/jenkins/JenkinsHttpClient.test.ts
git commit -m "$(cat <<'EOF'
fix: follow same-origin GET redirects and surface login redirects as auth errors
EOF
)"
```

**i18n keys:** none (errors are formatted through `formatError` at UI call sites, message text is developer-facing English by existing convention in `errors.ts`).
**Risk notes:** Medium invasiveness — `ok` semantics change for GET. Audit callers of `request()`/`requestRaw()` for GET flows that previously "succeeded" on 3xx: `getPipelineScript` (config.xml GET), `getBuildLogConsoleText`, `fetchProgressiveText`, crumb fetch. All of them want the new behavior. Keep the redirect count out of `JenkinsHttpRequest` (internal constant `MAX_REDIRECTS = 5`).

---

### Task 3: progressiveText soft-cap + UTF-8-safe truncate (渐进日志软上限与 UTF-8 安全截断)

`maxResponseBytes` currently rejects the whole request when exceeded (`settleReject` + destroy), so a giant log chunk turns into an error instead of a partial result. And byte-based slicing in `truncateBuildLog` can cut a multi-byte UTF-8 character in half, producing `�` at chunk edges (bad for Chinese logs).

**Files:**
- Modify: `src/jenkins/JenkinsHttpClient.ts`, `src/jenkins/logTruncate.ts`, `src/jenkins/JenkinsClient.ts`
- Test: `test/jenkins/logTruncate.test.ts`, `test/jenkins/JenkinsHttpClient.test.ts`, `test/jenkins/JenkinsClient.test.ts`

**Interfaces:**
- `JenkinsHttpRequest`: add `truncateOverflow?: boolean`. When true and `maxResponseBytes` is hit, `performRequest` stops reading (destroy the response), and **resolves** with the partial body plus new response field `JenkinsHttpResponse.bodyTruncated?: boolean`. When false/absent, keep the current reject behavior (unchanged for JSON APIs).
- `logTruncate.ts`: add exported helpers `alignStartToUtf8(buf: Buffer, offset: number): number` (advance past `0b10xxxxxx` continuation bytes) and `alignEndToUtf8(buf: Buffer, offset: number): number` (retreat before an incomplete leading byte). Apply both inside `truncateBuildLog` whenever a cut is a truncation cut (never at offset 0 / buffer end). Returned `startByte`/`endByte` reflect the aligned offsets.
- `JenkinsClient.fetchProgressiveText(fullName, buildNumber, start, capBytes?)`: pass `maxResponseBytes: capBytes, truncateOverflow: true` when `capBytes` is set; when the response was `bodyTruncated`, compute `nextStart` as `start + res.body.length` (X-Text-Size describes the full log, the partial body ends earlier) and report `hasMore: true` upward.
- `JenkinsClient.getBuildLogProgressive`: derive `capBytes` from options — `opts.maxBytes ?? opts.tailBytes ?? DEFAULT_LOG_TAIL_BYTES` for the `start !== undefined` chunk path, and `tailBytes` for the tail path (a build can grow between the size probe and the tail fetch; the cap keeps memory bounded). Run the final `chunk.body` through the UTF-8 alignment helpers.

- [ ] **Step 1: Write failing tests**

`test/jenkins/logTruncate.test.ts`:

```ts
it('never splits a multi-byte UTF-8 character at the tail boundary', () => {
  const raw = Buffer.from('日志'.repeat(100), 'utf8'); // 3 bytes per char
  const r = truncateBuildLog(raw, { tailBytes: 100 }); // 100 % 3 !== 0
  expect(r.text).not.toContain('\uFFFD');
  expect(r.startByte % 3).toBe(0);
});
it('aligns start-offset slices to codepoint boundaries', () => { /* start: 1 into a 3-byte char */ });
```

`test/jenkins/JenkinsHttpClient.test.ts`:

```ts
it('resolves with a partial body and bodyTruncated when truncateOverflow is set', async () => { /* server sends 1 MiB, maxResponseBytes 64 KiB */ });
it('still rejects on overflow when truncateOverflow is not set', async () => { /* existing behavior preserved */ });
```

`test/jenkins/JenkinsClient.test.ts`: `getBuildLog` with a mocked http client whose progressiveText chunk reports `bodyTruncated` → result has `hasMore: true` and `endByte === startByte + body.length`.

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/jenkins/logTruncate.test.ts test/jenkins/JenkinsHttpClient.test.ts test/jenkins/JenkinsClient.test.ts
```

- [ ] **Step 3: Implement** per Interfaces. The follow loop in `BuildLogDocumentProvider.followBuildLogInOutput` already advances via `chunk.endByte` and drains `hasMore` — it needs no change, but verify by test that a soft-capped chunk sequence still delivers every byte exactly once (extend `test/document/BuildLogDocumentProvider.test.ts` if a gap is found).

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/jenkins/ test/document/BuildLogDocumentProvider.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/jenkins test/jenkins test/document
git commit -m "$(cat <<'EOF'
feat: soft-cap progressive log fetches and keep utf-8 chunk boundaries intact
EOF
)"
```

**i18n keys:** none.
**Risk notes:** Medium. `startByte`/`endByte` shifting by up to 3 bytes must stay consistent with the follow loop's `startOffset = chunk.endByte` — align the **end** only when `hasMore`/truncated (the dropped bytes are re-fetched by the next chunk), never drop bytes at a final chunk end.

---

### Task 4: Pipeline save — conflict detection + cancel keeps dirty (流水线保存冲突检测与取消保持脏状态)

Today Ctrl+S runs `JenkinsPipelineDraftFileSystemProvider.writeFile` (VS Code marks the document clean) and only afterwards fires `onDidSaveTextDocument` → `savePipelineScript` → confirm modal. If the user cancels the confirm, the editor looks saved but Jenkins was never updated. There is also no protection against overwriting a script someone else changed after the draft was opened (`baseContent` exists but is unused for conflicts).

**Files:**
- Modify: `src/document/JenkinsPipelineDraftFileSystemProvider.ts`, `src/document/PipelineScriptDocumentProvider.ts`, `src/jenkins/errors.ts`, `src/extension.ts`
- Test: `test/document/JenkinsPipelineDraftFileSystemProvider.test.ts`, `test/document/PipelineScriptDocumentProvider.test.ts`, `test/jenkins/errors.test.ts`

**Interfaces:**
- `errors.ts`: add `Conflict` class (`code: 'Conflict'`, fields `jobFullName?: string`), extend `JenkinsErrorCode` union and `AnyJenkinsError`.
- Draft FS: add `setPublishHandler(handler: (uri: vscode.Uri, entry: PipelineDraftEntry, newContent: string) => Promise<'saved' | 'cancelled'>)`. Make `writeFile` async (`FileSystemProvider.writeFile` may return a Thenable): writability check as today; if a handler is set, await it **before** committing `draft.content`. On `'saved'`: set `content` and `baseContent` to `newContent` (this replaces the old post-hoc `markClean`), bump `mtime`, fire the change event. On `'cancelled'`: `throw vscode.FileSystemError.Unavailable(t('Save to Jenkins was cancelled. Your changes remain unsaved in the editor.'))` — the failed save keeps the document dirty, which is exactly the required UX.
- `PipelineScriptDocumentProvider`: refactor the body of `savePipelineScript` into `publishDraft(uri: vscode.Uri, entry: PipelineDraftEntry, newContent: string): Promise<'saved' | 'cancelled'>`:
  1. readOnly guard (existing message) → `'cancelled'`.
  2. Fetch remote via `client.getPipelineScript(entry.jobFullName)` (this is the existing pre-confirm writability probe — reuse its result, don't fetch twice). `Unsupported` → error message → `'cancelled'`.
  3. **Conflict check:** if `remote.script !== entry.baseContent` → modal `showWarningMessage` with actions *Overwrite on Jenkins* / cancel. Cancel → `'cancelled'`. (Throw/log `Conflict` internally so tests can assert the branch.)
  4. Existing confirm modal ("Save changes to Jenkins pipeline script…"). Cancel → `'cancelled'`.
  5. `client.updatePipelineScript(...)` → success toast → `'saved'`.
- `extension.ts`: call `draftFileSystemProvider.setPublishHandler((uri, entry, content) => pipelineScriptProvider.publishDraft(uri, entry, content))` right after both are constructed; **remove** the `JENKINS_DRAFT_SCHEME` branch from the `onDidSaveTextDocument` listener (keep the `JENKINS_DOCUMENT_SCHEME` branch that shows the "open as editable draft" error).

- [ ] **Step 1: Write failing tests**

`test/document/JenkinsPipelineDraftFileSystemProvider.test.ts`:

```ts
it('keeps the draft content unchanged and rejects the save when the publish handler cancels', async () => {
  provider.setPublishHandler(async () => 'cancelled');
  await expect(provider.writeFile(uri, Buffer.from('new'), opts)).rejects.toThrow();
  expect(provider.getDraft(uri)?.content).toBe('old');
});
it('commits content and baseContent together when the publish handler saves', async () => { /* 'saved' → content === baseContent === 'new' */ });
```

`test/document/PipelineScriptDocumentProvider.test.ts`:

```ts
it('detects a remote change vs baseContent and cancels when the user declines overwrite', async () => { /* remote.script !== baseContent; showWarningMessage returns undefined; expect 'cancelled', updatePipelineScript not called */ });
it('publishes when remote matches baseContent and the user confirms', async () => { /* expect 'saved' */ });
```

`test/jenkins/errors.test.ts`: `Conflict` has `code === 'Conflict'` and `isJenkinsError` accepts it.

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/document/JenkinsPipelineDraftFileSystemProvider.test.ts test/document/PipelineScriptDocumentProvider.test.ts test/jenkins/errors.test.ts
```

- [ ] **Step 3: Implement** per Interfaces. Keep a thin `savePipelineScript(document)` shim only if existing tests still call it; otherwise migrate those tests to `publishDraft`.

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/document/ test/jenkins/errors.test.ts test/extension.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/document src/jenkins/errors.ts src/extension.ts test/document test/jenkins/errors.test.ts
git commit -m "$(cat <<'EOF'
feat: gate pipeline draft saves on confirm with conflict detection against base content
EOF
)"
```

**i18n keys (add to `l10n/bundle.l10n.zh-cn.json`; `test/i18n/nls.test.ts` enforces coverage):**
- `'Save to Jenkins was cancelled. Your changes remain unsaved in the editor.'`
- `'The pipeline script for "{job}" changed on Jenkins after you opened this draft. Overwrite the remote version with your copy?'`
- `'Overwrite on Jenkins'`

**Risk notes:** Highest-risk task in this plan. VS Code surfaces a thrown `writeFile` as a "Failed to save" notification — the cancel message must read as intentional, not as a bug. `openPipelineScriptDocument`'s info toast ("Save (Cmd/Ctrl+S) writes the script back…") stays accurate. Verify manually in the Extension Host: cancel → tab keeps the dirty dot; confirm → tab clean and Jenkins updated.

---

### Task 5: Unsupported parameter-type guard (不支持的参数类型防护)

`promptParameterValue` happily renders a plain InputBox for `FileParameterDefinition`, `RunParameterDefinition`, and `CredentialsParameterDefinition`, producing values Jenkins rejects or misinterprets. Guard before prompting.

**Files:**
- Modify: `src/commands/buildCommands.ts`
- Test: `test/commands/buildCommands.test.ts`

**Interfaces:**
- Export `findUnsupportedParameter(definitions: JobParameterDefinition[]): JobParameterDefinition | undefined` — matches `type` (lowercased) containing `fileparameter` / `file`, `runparameter` / `run`, or `credentials` (word-ish match; be careful `run` alone would false-positive on nothing current, but anchor on the Jenkins class names: `FileParameterDefinition`, `RunParameterDefinition`, `CredentialsParameterDefinition`, checked case-insensitively with `.includes`).
- In `triggerBuildHandler`, after `client.getJob(...)` and before `collectJobParameters`: if an unsupported parameter is found, show `showErrorMessage` with an *Open in Jenkins* action (executes `atJenkins.openInJenkins` with `{ instanceId, jobFullName, url: job.url }`) and return `false` without prompting or triggering.
- Optional multiline text: for `TextParameterDefinition` (type contains `textparameter` or exactly `text`), keep the InputBox but set `ignoreFocusOut: true`, and when a recent/default value contains `\n`, first offer a QuickPick *Use current value (multiline)* / *Replace with single-line input* so an existing multiline default is never silently flattened. No webview.

- [ ] **Step 1: Write failing tests** in `test/commands/buildCommands.test.ts`:

```ts
it('refuses to trigger when the job declares a FileParameterDefinition', async () => { /* expect false, client.triggerBuild not called, error message shown */ });
it('refuses RunParameterDefinition and CredentialsParameterDefinition the same way', async () => { /* table-driven */ });
it('offers to keep a multiline default for text parameters instead of flattening it', async () => { /* QuickPick 'Use current value' → param keeps \n */ });
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/commands/buildCommands.test.ts
```

- [ ] **Step 3: Implement** per Interfaces.

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/commands/
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/buildCommands.ts test/commands/buildCommands.test.ts
git commit -m "$(cat <<'EOF'
feat: block triggering builds with file run or credentials parameters
EOF
)"
```

**i18n keys:**
- `'Cannot trigger "{job}" from AT Jenkins: parameter "{name}" has type {type}, which must be provided in the Jenkins web UI.'`
- `'Use current value (multiline)'`
- `'Replace with single-line input'`

**Risk notes:** Low. Note `recentParams.isSecretParameter` already treats `credential` types as secrets for storage — the new guard fires earlier, so those params are never collected at all; keep `sanitizeParamsForStorage` unchanged.

---

### Task 6: TOFU prompt coalescing + forget command (TOFU 弹窗合并与忘记证书命令)

Parallel requests (tree refresh + status bar follow + log poll) each pop their own modal for the same unknown certificate. And there is no UI to revoke a trusted fingerprint even though `JenkinsCertTrustStore.getAllTrusted()` / `untrust()` already exist.

**Files:**
- Modify: `src/jenkins/createInteractiveCertVerifier.ts`, `src/extension.ts`, `package.json`, `package.nls.json`, `package.nls.zh-cn.json`
- Test: `test/jenkins/createInteractiveCertVerifier.test.ts`, `test/extension.test.ts`

**Interfaces:**
- `createInteractiveCertVerifier`: hold `const inFlight = new Map<string, Promise<boolean>>()` keyed `${host.toLowerCase()}:${port}:${fingerprint256}` in the factory closure. `verify()` returns the existing promise when present; otherwise stores the prompt promise and `.finally(() => inFlight.delete(key))`. The trust-store fast path (`status === 'trusted'`) stays before the map so already-trusted hosts never queue.
- New command `atJenkins.forgetTrustedCertificate` (registered in `extension.ts`, contributed in `package.json` with `commandPalette` visible): read `trustStore.getAllTrusted()`; if empty → info toast; else QuickPick (label `host:port`, description first 16 chars of fingerprint + trusted date via `new Date(trustedAt).toLocaleString()`), then modal confirm, then `trustStore.untrust(host, port)` + confirmation toast. Also `clientPool.clear()` so pooled agents renegotiate TLS.

- [ ] **Step 1: Write failing tests**

`test/jenkins/createInteractiveCertVerifier.test.ts`:

```ts
it('coalesces concurrent verify calls for the same host, port and fingerprint into one prompt', async () => {
  // showWarningMessage mock counts invocations; fire verify() twice without awaiting; expect 1 prompt, both resolve true after accept
});
it('prompts again for a different fingerprint on the same host', async () => { /* two prompts */ });
```

`test/extension.test.ts` (or a new `test/commands/forgetTrustedCertificate.test.ts` if extension.test.ts is not command-level): forget flow calls `untrust` with the picked host/port and skips when the user cancels the confirm.

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/jenkins/createInteractiveCertVerifier.test.ts test/extension.test.ts
```

- [ ] **Step 3: Implement** per Interfaces. `package.json` command entry uses `%atJenkins.command.forgetTrustedCertificate.title%` with `icon: "$(shield)"`.

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/jenkins/ test/extension.test.ts test/i18n/nls.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/jenkins/createInteractiveCertVerifier.ts src/extension.ts package.json package.nls.json package.nls.zh-cn.json l10n test/jenkins test/extension.test.ts
git commit -m "$(cat <<'EOF'
feat: coalesce concurrent tofu prompts and add forget trusted certificate command
EOF
)"
```

**i18n keys:**
- nls: `atJenkins.command.forgetTrustedCertificate.title` (en: `Forget Trusted Certificate…`, zh: `忘记已信任的证书…`)
- l10n: `'No trusted Jenkins certificates recorded.'`, `'Select a trusted certificate to forget'`, `'Forget the trusted certificate for {host}:{port}? The next connection will prompt again.'`, `'Forget'`, `'Trusted certificate for {host}:{port} removed.'`

**Risk notes:** Low. Coalescing must key on the fingerprint too — a changed cert mid-flight must not reuse the accept for the old fingerprint. `test/i18n/nls.test.ts` will fail the build if any new `t()` string misses a zh-cn entry — add them in the same commit.

---

### Task 7: http + credentials warning (明文 HTTP 凭据警告)

Saving or test-connecting an instance whose `baseUrl` is `http://` with `authMode !== 'none'` sends Basic auth in cleartext. Warn, never block.

**Files:**
- Modify: `src/webview/JenkinsInstancePanel.ts`
- Test: `test/webview/JenkinsInstancePanel.test.ts`

**Interfaces:**
- Export `isPlaintextCredentialCombo(baseUrl: string, authMode: JenkinsAuthMode): boolean` — true when the URL parses with `protocol === 'http:'` and authMode is `apiToken` or `password`.
- `saveInstance`: after a successful save (do not gate the save), fire a non-modal `vscode.window.showWarningMessage(t('Controller "{label}" uses http:// with credentials. Tokens and passwords are sent unencrypted; prefer https://.', …))`.
- `runConnectionTest` / `probeWithFormValues`: when the combo holds, prefix the posted `connectionTestResult` message with the same warning sentence (result stays `ok: true` if the probe succeeded — warning only).

- [ ] **Step 1: Write failing tests** in `test/webview/JenkinsInstancePanel.test.ts`:

```ts
it('flags http:// with apiToken or password as a plaintext-credential combination', () => { /* table over authModes + protocols */ });
it('still saves and shows a warning toast for http+credentials', async () => { /* handleInstanceFormMessage submit; save called; warning shown */ });
it('does not warn for https or authMode none', async () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/webview/JenkinsInstancePanel.test.ts
```

- [ ] **Step 3: Implement** per Interfaces.

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/webview/ test/i18n/nls.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/webview/JenkinsInstancePanel.ts l10n test/webview
git commit -m "$(cat <<'EOF'
feat: warn without blocking when credentials are configured over plain http
EOF
)"
```

**i18n keys:** `'Controller "{label}" uses http:// with credentials. Tokens and passwords are sent unencrypted; prefer https://.'` (and a label-less variant for the test-connection path if `label` is blank: reuse hostname via `resolveLabel`).
**Risk notes:** Trivial. Keep the warning out of the modal path — D-decisions say confirm modals are reserved for mutations.

---

### Task 8: Dedicated follow Output channels + stop command + dedupe (独立跟随输出通道、停止命令与去重)

`followBuildLogInOutput` currently interleaves every followed build into the shared `AT Jenkins` log channel, cannot be stopped by the user, and following the same build twice double-appends.

**Files:**
- Modify: `src/document/BuildLogDocumentProvider.ts`, `src/extension.ts`, `package.json`, `package.nls.json`, `package.nls.zh-cn.json`
- Test: `test/document/BuildLogDocumentProvider.test.ts`

**Interfaces:**
- `BuildLogDocumentProvider`: add `private readonly activeFollows = new Map<string, { channel: vscode.OutputChannel; disposable: vscode.Disposable; label: string }>()`, keyed `followKey(instanceId, jobFullName, buildNumber)` (export the key helper).
- `followBuildLogInOutput(instanceId, jobFullName, buildNumber, outputChannel?, options?)`:
  - **Dedupe:** if the key is active, `channel.show(true)`, info toast "already following", return the existing disposable.
  - **Dedicated channel:** when no `outputChannel` is injected (tests inject one), create `vscode.window.createOutputChannel(\`AT Jenkins: ${jobFullName} #${buildNumber}\`)` and dispose it together with the follow when the extension deactivates (not when the follow ends — the user may still be reading).
  - Register in `activeFollows` and delete on dispose (wrap the existing `vscode.Disposable`).
- Add `listActiveFollows(): Array<{ key: string; label: string }>` and `stopFollow(key: string): boolean` (dispose + `appendLine(t('=== Follow stopped by user ==='))`).
- New command `atJenkins.stopFollowBuildLog` in `extension.ts`: zero active → info toast; one → stop it; several → QuickPick by label. Contribute the command in `package.json` (palette visible) with icon `$(stop-circle)`.

- [ ] **Step 1: Write failing tests** in `test/document/BuildLogDocumentProvider.test.ts`:

```ts
it('returns the existing follow and does not double-append when the same build is followed twice', async () => { /* two calls, one server, assert appended bytes once */ });
it('tracks active follows and stops one by key', async () => { /* listActiveFollows → 1; stopFollow → poller cleared, stop line appended */ });
it('removes the follow from the registry when the build finishes', async () => { /* building:false → key gone */ });
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/document/BuildLogDocumentProvider.test.ts
```

- [ ] **Step 3: Implement** per Interfaces; wire the command and `package.json`/nls entries.

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/document/ test/extension.test.ts test/i18n/nls.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/document/BuildLogDocumentProvider.ts src/extension.ts package.json package.nls.json package.nls.zh-cn.json l10n test/document test/extension.test.ts
git commit -m "$(cat <<'EOF'
feat: give each followed build its own output channel with stop and dedupe
EOF
)"
```

**i18n keys:**
- nls: `atJenkins.command.stopFollowBuildLog.title` (en: `Stop Following Build Log`, zh: `停止跟随构建日志`)
- l10n: `'Already following "{job} #{build}" — showing the existing output.'`, `'=== Follow stopped by user ==='`, `'No build log follows are active.'`, `'Select a build log follow to stop'`

**Risk notes:** Channel names must be unique per build or VS Code reuses the channel — the `job #n` suffix guarantees that. Dispose channels in `dispose()` (extension deactivate) to avoid leaking channels across reloads in the dev host.

---

### Task 9: Multi-follow status bar + completion + expiry (状态栏多构建跟随与超时提示)

`JenkinsBuildFollowService.follow` bumps a global `followGeneration`, so triggering a second build silently abandons the first follow — that is the single slot to remove. `JenkinsStatusBarManager` holds one `isBuilding` flag. And when `maxPolls` runs out the follow just clears the status bar with no explanation.

**Files:**
- Modify: `src/utils/statusBar.ts`, `src/commands/buildFollow.ts`
- Test: `test/utils/statusBar.test.ts`, `test/commands/buildFollow.test.ts`

**Interfaces:**
- `statusBar.ts`: export `buildingKey(instanceId: string | undefined, jobFullName: string, buildNumber: number): string`. Replace the boolean with `private readonly building = new Map<string, { jobFullName; buildNumber; durationText?; instanceId? }>()`. Methods:
  - `upsertBuilding(entry)` — keyed by `buildingKey(...)`; re-render.
  - `removeBuilding(key)` — re-render (falls back to active-instance state at zero).
  - `clearBuildingStatus()` — clears the whole map (kept for dispose/error paths).
  - Rendering: 1 entry → existing single format (`$(sync~spin) Jenkins: {job} #{n} ({dur})`, click opens that log). N > 1 → `$(sync~spin) Jenkins: {n} builds running` with a `MarkdownString` tooltip listing every entry; click opens the log of the **most recently upserted** entry (no new command; document in the tooltip).
  - Keep `setBuildingStatus(...)` as a thin alias calling `upsertBuilding` so existing tests keep passing, or migrate the tests — pick one, do not keep both semantics.
- `buildFollow.ts`: delete `followGeneration`; add `private readonly active = new Set<string>()` keyed with `buildingKey`. `follow()`:
  - After `resolveBuildNumber`, compute the key; if already in `active`, return (dedupe — the running loop will notify).
  - Poll loop condition uses `!this.disposed && this.active.has(key)`.
  - On completion: `statusBar.removeBuilding(key)` (not `clearBuildingStatus`), `notifyBuildCompletion(...)` per build as today.
  - **maxPolls expiry:** when the loop exhausts while `build.building` is still true, remove the status-bar entry and show a toast `showWarningMessage(t('Stopped watching "{job} #{number}" — it is still running after {minutes} minutes.'), View Log, Open in Jenkins)` reusing the existing `t('View Log')` / `t('Open in Jenkins')` actions from `notifyBuildCompletion`.

- [ ] **Step 1: Write failing tests**

`test/utils/statusBar.test.ts`:

```ts
it('shows a single follow in full and an aggregate count for two follows', () => { /* upsert A, assert text; upsert B, expect '2 builds running' */ });
it('drops back to the remaining follow when one is removed', () => { /* remove A → renders B */ });
it('returns to the active-instance state at zero follows', () => { /* remove both */ });
```

`test/commands/buildFollow.test.ts`:

```ts
it('follows two builds concurrently and notifies completion for each', async () => { /* two follow() calls, fake sleep, both notifyBuildCompletion paths hit */ });
it('does not start a duplicate follow for the same build', async () => { /* same key twice → one poll loop */ });
it('shows an expiry toast when maxPolls is exhausted while still building', async () => { /* maxPolls: 2, building forever */ });
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/utils/statusBar.test.ts test/commands/buildFollow.test.ts
```

- [ ] **Step 3: Implement** per Interfaces. `buildCommands.triggerBuildHandler` needs no change (it already calls `followService.follow(...)` fire-and-forget).

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/utils/ test/commands/
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/statusBar.ts src/commands/buildFollow.ts l10n test/utils test/commands
git commit -m "$(cat <<'EOF'
feat: follow multiple builds concurrently with per-build status and expiry toast
EOF
)"
```

**i18n keys:**
- `'{count} builds running'` (zh: `{count} 个构建进行中`)
- `'Stopped watching "{job} #{number}" — it is still running after {minutes} minutes.'`
- Tooltip line strings if not composed from existing keys.

**Risk notes:** Medium. The old generation counter also served as "switching follows cancels the previous one" — that behavior is intentionally removed; make sure `dispose()` still ends every loop (the `disposed` flag covers it). `formatDuration` import from `JobsTreeProvider` stays.

---

### Task 10: Live-reload settings (设置热更新)

`readAtJenkinsSettings()` runs once in `activate`; changing `atJenkins.builds.pageSize` etc. requires a window reload today.

**Files:**
- Modify: `src/extension.ts`, `src/tree/JobsTreeProvider.ts`, `src/document/BuildLogDocumentProvider.ts`, `src/commands/buildFollow.ts`
- Test: `test/tree/JobsTreeProvider.test.ts`, `test/document/BuildLogDocumentProvider.test.ts`, `test/commands/buildFollow.test.ts`, `test/extension.test.ts`

**Interfaces:**
- `JobsTreeProvider.applySettings({ pageSize })` — update `this.pageSize` (drop `readonly`); existing per-job limits in `jobBuildLimits` are left as-is, only future paging uses the new size.
- `BuildLogDocumentProvider.applySettings({ pollIntervalMs, uiLogTailBytes })` — new values apply to pollers started after the change (document this; do not restart running intervals).
- `JenkinsBuildFollowService.applySettings({ pollIntervalMs, maxPolls })` — same forward-only rule.
- `extension.ts`: register

```ts
vscode.workspace.onDidChangeConfiguration((e) => {
  if (!e.affectsConfiguration('atJenkins')) return;
  const next = readAtJenkinsSettings();
  jobsTreeProvider.applySettings({ pageSize: next.buildsPageSize });
  buildLogProvider.applySettings({ pollIntervalMs: next.logPollIntervalMs, uiLogTailBytes: next.uiLogTailBytes });
  followService.applySettings({ pollIntervalMs: next.followPollIntervalMs, maxPolls: next.followMaxPolls });
});
```

- [ ] **Step 1: Write failing tests** — one per consumer:

```ts
it('applies a new page size to subsequent load-more paging', () => { /* JobsTreeProvider.applySettings({pageSize: 25}); loadMoreBuilds grows by 25 */ });
it('uses the updated tail bytes for the next log document render', async () => { /* BuildLogDocumentProvider.applySettings; assert getBuildLog called with new tailBytes */ });
it('uses the updated poll interval and maxPolls for the next follow', async () => { /* follow after applySettings */ });
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/tree/JobsTreeProvider.test.ts test/document/BuildLogDocumentProvider.test.ts test/commands/buildFollow.test.ts
```

- [ ] **Step 3: Implement** per Interfaces; wire the listener in `extension.ts` and push it to `context.subscriptions`.

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/tree/ test/document/ test/commands/ test/extension.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/tree/JobsTreeProvider.ts src/document/BuildLogDocumentProvider.ts src/commands/buildFollow.ts test
git commit -m "$(cat <<'EOF'
feat: apply atJenkins settings changes without a window reload
EOF
)"
```

**i18n keys:** none.
**Risk notes:** Low. `readAtJenkinsSettings` already clamps, so no re-validation needed. Forward-only application avoids interval-restart races in `activePollers`.

---

### Task 11: getBuild tree selector + MCP build-parameter scrub (构建详情 tree 选择器与 MCP 参数脱敏)

`JenkinsClient.getBuild` fetches `/{n}/api/json` with **no** `tree` — Jenkins returns the full action graph (huge on pipeline builds). And `jenkins_get_build` returns build `actions` verbatim, including `hudson.model.ParametersAction` values whose names look like secrets. NO new MCP tools.

**Files:**
- Modify: `src/jenkins/types.ts`, `src/jenkins/JenkinsClient.ts`, `src/agent/JenkinsAgentToolService.ts`
- Test: `test/jenkins/JenkinsClient.test.ts`, `test/agent/JenkinsAgentToolService.test.ts`

**Interfaces:**
- `types.ts`: add

```ts
export const GET_BUILD_TREE = [
  BUILD_SUMMARY_TREE_FIELDS,
  'description,queueId',
  'artifacts[displayPath,fileName,relativePath]',
  'actions[parameters[name,value],causes[shortDescription,userId,userName]]'
].join(',');
```

- `JenkinsClient.getBuild`: pass `query: { tree: GET_BUILD_TREE }` (mirrors how `getJob` uses `GET_JOB_TREE`).
- `JenkinsAgentToolService`: add `scrubBuildSecrets(build: BuildDetail): BuildDetail` beside the existing `scrubJobSecrets` — walk `build.actions`, and for every `parameters: [{name, value}]` entry whose **name** matches `/password|passwd|secret|token|credential/i`, replace `value` with `'[REDACTED]'`. Apply it in the `getBuild` handler (`result: scrubBuildSecrets(build)`), UI paths untouched.

- [ ] **Step 1: Write failing tests**

`test/jenkins/JenkinsClient.test.ts`:

```ts
it('requests build detail with the compact GET_BUILD_TREE selector', async () => { /* assert query.tree === GET_BUILD_TREE */ });
```

`test/agent/JenkinsAgentToolService.test.ts`:

```ts
it('redacts password-like parameter values in jenkins_get_build responses', async () => {
  // actions: [{ parameters: [{name:'DEPLOY_TOKEN', value:'s3cret'}, {name:'ENV', value:'prod'}] }]
  // expect DEPLOY_TOKEN → '[REDACTED]', ENV untouched
});
it('registers no MCP tool beyond the existing seven', async () => { /* invoke('jenkins_anything_else') → NOT_FOUND; toolCatalog length still 7 */ });
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/jenkins/JenkinsClient.test.ts test/agent/JenkinsAgentToolService.test.ts
```

- [ ] **Step 3: Implement** per Interfaces.

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/jenkins/ test/agent/ test/mcp/toolCatalog.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/jenkins/types.ts src/jenkins/JenkinsClient.ts src/agent/JenkinsAgentToolService.ts test
git commit -m "$(cat <<'EOF'
feat: trim build detail via tree selector and scrub secret-like build parameters over mcp
EOF
)"
```

**i18n keys:** none (MCP payloads are not localized).
**Risk notes:** Low. The tree selector drops fields the UI never read (`executor`, raw `actions` subtrees); `BuildDetail` already types `actions?: unknown[]`, so no type break. Scrub by **name** (values give no type info in `ParametersAction`).

---

### Task 12: Open in Jenkins host mismatch confirm (跨主机跳转确认)

Server-supplied `job.url` / `build.url` may point at a different host than the configured `baseUrl` (reverse proxy misconfig, or a hostile controller response). `isSafeJenkinsWebUrl` already blocks non-http(s); add a confirm when the host differs from the instance the item belongs to.

**Files:**
- Modify: `src/commands/openInJenkins.ts`
- Test: `test/commands/openInJenkins.test.ts`

**Interfaces:**
- Change `resolveJenkinsWebUrl` to return `Promise<{ url: string; expectedBaseUrl?: string } | undefined>`: whenever the target carries an `instanceId` (tree items, document URIs, plain objects) resolve `expectedBaseUrl` from `configManager.getInstance(...).baseUrl`; for `JenkinsInstanceTreeItem` set it to the instance's own baseUrl (never mismatches).
- Export `hostMatchesBaseUrl(url: string, baseUrl: string): boolean` — compare `URL.hostname` (case-insensitive) and effective port; protocol difference alone (http vs https, same host) counts as a match with no prompt.
- `openInJenkinsHandler`: after the scheme check, when `expectedBaseUrl` is known and `hostMatchesBaseUrl` is false → modal `showWarningMessage` (*Open Anyway* / cancel); cancel → return false.

- [ ] **Step 1: Write failing tests** in `test/commands/openInJenkins.test.ts`:

```ts
it('opens without prompting when the job url host matches the controller baseUrl', async () => { /* no showWarningMessage call */ });
it('asks before opening a url whose host differs from the controller', async () => { /* decline → openExternal not called */ });
it('opens the mismatched url when the user confirms', async () => { /* accept → openExternal called */ });
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/commands/openInJenkins.test.ts
```

- [ ] **Step 3: Implement** per Interfaces (update every `resolveJenkinsWebUrl` return site; the recursion for the active-editor fallback threads the same shape).

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/commands/ test/i18n/nls.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/openInJenkins.ts l10n test/commands
git commit -m "$(cat <<'EOF'
feat: confirm before opening jenkins links that leave the controller host
EOF
)"
```

**i18n keys:** `'This link points to {host}, but controller "{label}" is at {expectedHost}. Open it anyway?'`, `'Open Anyway'`.
**Risk notes:** Low, but the return-shape change touches every branch of `resolveJenkinsWebUrl` — the compiler enforces completeness. Port defaulting: treat missing port as 80/443 by protocol before comparing.

---

### Task 13: i18n completeness — badges, TOFU strings, webview lang (国际化补全)

Hardcoded UI literals remain: `[RO]` in `InstancesTreeProvider`, `[Pipeline]`/`[Freestyle]`/`[Multibranch]`/`[Organization]` in `JobsTreeProvider.formatJobTypeBadge` and the folder description, and `renderWebviewHtml` emits `<html lang="en">` regardless of `vscode.env.language`.

**Files:**
- Modify: `src/tree/InstancesTreeProvider.ts`, `src/tree/JobsTreeProvider.ts`, `src/webview/html.ts`, `src/webview/JenkinsInstancePanel.ts`, `l10n/bundle.l10n.zh-cn.json`
- Test: `test/tree/JobsTreeProvider.test.ts`, `test/tree/InstancesTreeProvider.test.ts`, `test/webview/html.test.ts`, `test/i18n/nls.test.ts` (existing suite auto-enforces bundle coverage)

**Interfaces:**
- Badges: wrap the inner word with `t()` keeping the bracket format — `` `[${t('Pipeline')}]` ``, `` `[${t('Freestyle')}]` ``, `` `[${t('Multibranch')}]` ``, `` `[${t('Organization')}]` ``, and `[RO]` → `` `[${t('RO')}]` `` (short badge key; the tooltip already uses the long `t('Read-only')`).
- `renderWebviewHtml(webview, asset, body, data, lang?)`: new optional trailing `lang` param defaulting to `'en'`; emit `<html lang="${escapeAttr(lang)}">`. `JenkinsInstancePanel.open` passes `vscode.env.language`.
- TOFU strings: audit `createInteractiveCertVerifier.ts` (including Task 6 additions) against `l10n/bundle.l10n.zh-cn.json`; `test/i18n/nls.test.ts` ("has a zh-cn translation for every one") is the executable audit — make it green.

- [ ] **Step 1: Write failing tests**

`test/tree/JobsTreeProvider.test.ts` / `InstancesTreeProvider.test.ts`: with a `t()` mock that marks translated strings (the existing vscode fixture pattern), assert badge strings route through `t()` (e.g. mock returns `«Pipeline»` and the description contains `[«Pipeline»]`).

`test/webview/html.test.ts`:

```ts
it('renders the html lang attribute from the requested language', () => {
  expect(renderWebviewHtml(webview, asset, '<p/>', {}, 'zh-cn')).toContain('<html lang="zh-cn">');
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx vitest run test/tree/JobsTreeProvider.test.ts test/tree/InstancesTreeProvider.test.ts test/webview/html.test.ts test/i18n/nls.test.ts
```

- [ ] **Step 3: Implement**, then add every new key to `l10n/bundle.l10n.zh-cn.json` (zh: 流水线 / 自由风格 / 多分支 / 组织 / 只读). Re-run the nls suite until the "stale bundle key" and coverage assertions both pass.

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/tree src/webview l10n test
git commit -m "$(cat <<'EOF'
fix: localize tree badges and webview language attribute
EOF
)"
```

**i18n keys:** `'Pipeline'`, `'Freestyle'`, `'Multibranch'`, `'Organization'`, `'RO'` + any TOFU/T6–T12 strings the nls suite reports missing.
**Risk notes:** Trivial code, but `test/i18n/nls.test.ts` also fails on *stale* bundle keys — remove translations for any strings deleted by earlier tasks in this same pass.

---

### Task 14: GitHub Actions CI (持续集成)

No `.github/workflows` exists. Add one workflow running the same gate every task uses locally, plus a VSIX artifact.

**Files:**
- Create: `.github/workflows/ci.yml`
- Test: `test/ci/workflow.test.ts` (file-based assertion, same style as `test/i18n/nls.test.ts`)

**Interfaces:** single job `build` on `ubuntu-latest`, triggers `push` + `pull_request`; steps: `actions/checkout@v4` → `actions/setup-node@v4` (node 20, cache npm) → `npm ci` → `npm run typecheck` → `npm test` → `npm run compile` → `npm run package` → `actions/upload-artifact@v4` with `*.vsix`.

- [ ] **Step 1: Write failing test** `test/ci/workflow.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('ci workflow', () => {
  const yml = readFileSync('.github/workflows/ci.yml', 'utf8');
  it('runs the full verification gate and uploads the vsix', () => {
    for (const step of ['npm ci', 'npm run typecheck', 'npm test', 'npm run compile', 'npm run package', 'upload-artifact']) {
      expect(yml).toContain(step);
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL (file missing)**

```bash
npx vitest run test/ci/workflow.test.ts
```

- [ ] **Step 3: Implement** `.github/workflows/ci.yml` per Interfaces. `npm run package` already passes `--allow-missing-repository --no-rewrite-relative-links`, and `publisher` stays `local` — CI packages a sideloadable VSIX, it does **not** publish (marketplace publisher id is a human decision, out of scope).

- [ ] **Step 4: Re-run tests + typecheck**

```bash
npx vitest run test/ci/workflow.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add .github test/ci
git commit -m "$(cat <<'EOF'
ci: add github actions gate with typecheck tests compile and vsix artifact
EOF
)"
```

**i18n keys:** none.
**Risk notes:** `npm run package` invokes `npx @vscode/vsce` (a devDependency, so `npm ci` provides it). If vsce balks at `publisher: local` in CI, keep the step but do not change the publisher — add `--skip-license` style flags only if the error demands it.

---

### Task 15: Docs — README en+zh, CHANGELOG, features, packaging notes (文档)

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `docs/features.md`, `docs/features.zh-CN.md`
- Create: `README.zh-CN.md`

**Interfaces:** README (both languages, cross-linked at the top) covers: multi-controller setup + auth modes, readOnly / allowBackgroundAccess semantics, TOFU flow **including the new Forget Trusted Certificate command**, http+credentials warning, follow Output channels + stop command + multi-follow status bar, unsupported parameter types, conflict-safe pipeline save, live-reload settings table (`atJenkins.builds.pageSize`, `atJenkins.log.pollIntervalMs`, `atJenkins.log.uiTailBytes`, `atJenkins.follow.pollIntervalMs`, `atJenkins.follow.maxPolls`), the seven MCP tools with their hard exclusions, and a **Packaging** section: `npm run package` → sideloadable VSIX; marketplace publishing requires a human-owned publisher id and is explicitly not automated. CHANGELOG gains an `## [Unreleased]` section with one line per task T1–T14. `docs/features.md` / `docs/features.zh-CN.md` updated to match.

- [ ] **Step 1: Failing check** — docs have no unit tests; the executable gate is the existing suite (nls tests read files) plus a grep check. Run before writing to record the baseline:

```bash
rg -n "Unreleased" CHANGELOG.md || echo "MISSING (expected before this task)"
```

- [ ] **Step 2: Write the docs** per Interfaces. Keep English as the source of truth; zh-CN mirrors structure, not word-for-word.

- [ ] **Step 3: Full verification gate**

```bash
npx vitest run
npm run typecheck
npm run compile
npm run package
```

Expected: all green; `at-jenkins-0.1.0.vsix` produced.

- [ ] **Step 4: Commit**

```bash
git add README.md README.zh-CN.md CHANGELOG.md docs/features.md docs/features.zh-CN.md
git commit -m "$(cat <<'EOF'
docs: document v1 features in english and chinese with packaging notes
EOF
)"
```

**i18n keys:** none (docs, not runtime strings).
**Risk notes:** None technical. Do not add a `publisher` change or marketplace badges — publishing is gated on a human decision.

---

## Verification summary

After Task 15, the release gate is:

```bash
npx vitest run          # all suites including new ci/workflow and nls coverage
npm run typecheck
npm run compile
npm run package         # sideloadable VSIX, publisher stays "local"
```

Manual spot checks in the Extension Development Host: cancel a pipeline save (tab stays dirty), edit the same job from the web UI then save (conflict prompt), trigger two builds (status bar shows `2 builds running`, two Output channels, two completion toasts), let a follow hit `follow.maxPolls` (expiry toast), run *Forget Trusted Certificate*, save an `http://` controller with an API token (warning toast, save succeeds).

## Out of this plan (v2)

Deferred to the v2 plan (see `docs/superpowers/specs/2026-08-27-at-jenkins-v1-v2-design.md` §v2): SSO / custom-header auth, pipeline stage timeline webview, build artifact browsing/download, job search / quick-open, queue item cancel, marketplace publisher id + publishing pipeline, workspace Jenkinsfile sync, and any new MCP tools beyond the existing seven.
