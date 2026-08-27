# AT Jenkins v1 / v2 — Engineering, QA & Release Contract

**Date:** 2026-08-27
**Status:** Shared contract — applies to every task in the v1 and v2 plans
**Spec:** `docs/superpowers/specs/2026-08-27-at-jenkins-v1-v2-design.md` (decision record; carries forward D1–D18 from `docs/superpowers/specs/2026-08-25-at-jenkins-design.md`)
**Plans:** `docs/superpowers/plans/2026-08-27-at-jenkins-v1.md` · `docs/superpowers/plans/2026-08-27-at-jenkins-v2.md`

> 本文档是 v1 / v2 实施计划的工程纪律与验收契约：锁定决策提醒、完成定义（DoD）、CI 配置、安全与 i18n 检查单、测试策略、打包发布门槛、风险登记表。所有实施 Agent 在开始任何任务前必须先读本文；本文与计划冲突时，以规格（spec）的锁定决策为准。

---

## 1. Locked decisions — reminder and amendment procedure

The decision record lives in the spec. This section is a reminder, not a second source of truth. The full list is D1–D18; the ones implementers most often try to "improve" are called out below. **Do not relitigate these in a task.**

| # | Reminder |
|---|----------|
| D3 | **MCP is read-only.** No trigger, stop, save, or config-mutation tools, ever, in v1 or v2. The UI owns all mutations. |
| D13 | Per-instance **`allowBackgroundAccess`** (default `false`) gates every MCP tool that takes an `instanceId` — except `jenkins_list_instances`, which always answers so Agents can discover which instances are enabled. Denials return `DeniedBackground` with an actionable message. |
| D14 | **Exactly 7 MCP tools:** `jenkins_list_instances`, `jenkins_list_jobs`, `jenkins_get_job`, `jenkins_get_pipeline_script`, `jenkins_list_builds`, `jenkins_get_build`, `jenkins_get_build_log`. This is what `src/mcp/toolCatalog.ts` ships today, all `risk: 'read'`. |
| D15 | TLS is **TOFU fingerprint trust** when `verifyTls: false` (fail-closed prompt on first sight, `TlsError` on mismatch) and system-CA verification when `verifyTls: true`. |
| D16 | Full **zh-CN + en** i18n: `package.nls*.json` for the manifest, `l10n/bundle.l10n.zh-cn.json` + `t()` for runtime strings. No hardcoded user-facing literals. |

The remaining decisions (D1 scope, D2 controller-stored-script editing only, D4 auth modes, D5–D9 UI shape, D10 write guards, D11 single VSIX, D12 Jenkins 2.x, D17 64 KiB log tail default, D18 Nacos-aligned skeleton) are equally binding; consult the spec before deviating.

### How a future D14 amendment would be documented

If a tool is ever added, renamed, or removed (still read-only — D3 is not amendable by this procedure):

- [ ] Add a dated row `D14a (amended YYYY-MM-DD)` to the spec's Decisions table describing the new tool surface; do not silently edit the original D14 row.
- [ ] Add an entry to an **Amendments** section at the bottom of the spec: date, what changed, why, who approved.
- [ ] Update `src/mcp/toolCatalog.ts`, `src/mcp/bridgeSchemas.ts`, `src/agent/JenkinsAgentToolService.ts`, and `test/mcp/toolCatalog.test.ts` in the same commit as the spec amendment.
- [ ] Record the change under `CHANGELOG.md` → `[Unreleased]`.
- [ ] Any amendment proposing a **write** tool requires superseding D3 itself, which is a human decision, not an implementer decision.

---

## 2. Definition of Done

A task, and ultimately a version, is done only when all of the following hold. "It compiles on my machine" is not a state this project recognizes.

### DoD — every task (v1 and v2)

- [ ] `npm run typecheck` exits 0 (`tsc --noEmit`, `strict: true` per `tsconfig.json`).
- [ ] `npm test` (`vitest run`) exits 0 with **zero** skipped tests that were previously passing. Baseline at contract time: **40 files / 364 tests, all green**. The count may only decrease alongside an explicitly removed feature, with the removal named in the commit message.
- [ ] `npm run compile` exits 0 and does **not** print `Could not copy hub bundle to dist` (that warning means `dist/hub.js` / `dist/hub-version.json` are missing from the artifact).
- [ ] The i18n suite `test/i18n/nls.test.ts` passes — including the **reverse stale-key test** (`leaves no stale bundle key that is never passed to t()`) and the manifest tests (`leaves no nls key unused`). If you add a string, you add its zh-CN translation in the same commit; if you delete a string, you delete its bundle key in the same commit.
- [ ] **`noUnusedLocals` policy:** `tsconfig.json` does not currently enable `noUnusedLocals` / `noUnusedParameters`. Until the dedicated v1 hardening task flips them on (a tsconfig-only diff with its own commit), unused locals/imports/parameters are review-blocking anyway — do not land them. Once enabled, the flags are never turned off or worked around (no underscore-renaming of genuinely dead symbols) to make a task pass.
- [ ] **Vitest counts are not a vanity metric.** A task is not more done because the test count grew. New tests must assert observable behavior — error taxonomy, redaction output, gate refusals, truncation flags, tree ids — not internal call sequences. A test that cannot fail when the behavior regresses does not count toward DoD.
- [ ] Work is committed and pushed on the working branch before any testing/verification round begins.

### DoD — v1 release (in addition)

- [ ] Every v1 plan task's checkbox list is complete; every risk in §8 has its mitigation landed and tested.
- [ ] Security checklist (§4) re-verified end to end on the release candidate.
- [ ] `npm run package` produces a VSIX; installing it into a clean VS Code ≥ 1.85 profile activates without errors and shows both views.
- [ ] Opt-in live suite (§6) executed at least once against a real Jenkins 2.x LTS by whoever cuts the release, results noted in the release notes.
- [ ] All §7 packaging gates pass.

### DoD — v2 release (in addition)

- [ ] All v1 DoD items still hold — v2 must not regress any v1 gate, checklist, or test.
- [ ] Every v2 feature is behind the same discipline: read-only MCP surface unchanged unless a documented D14 amendment exists (§1).
- [ ] Migration safety: v2 must load v1 `globalState` / `SecretStorage` data unchanged, or ship an explicit, tested migration. No silent config-shape breaks.
- [ ] CHANGELOG distinguishes v2 features from v1 fixes; README (en + zh) updated for new capabilities.

---

## 3. CI

There is no `.github/workflows/` today. Proposed contents for `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - name: Install (locked)
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test

      - name: Compile
        run: npm run compile

      - name: Package VSIX
        run: npm run package

      - name: Upload VSIX
        uses: actions/upload-artifact@v4
        with:
          name: at-jenkins-vsix
          path: '*.vsix'
          if-no-files-found: error
```

Notes:

- **Node version.** `package.json` declares `engines.vscode: ^1.85.0` (extension host runtime ≈ Node 18) but no `engines.node`. The *shipped bundle's* runtime compatibility is enforced by esbuild's `target: 'node18'` in `esbuild.config.mjs` — CI does not need to run Node 18 to guarantee it. The *toolchain* (TypeScript 7, vitest 4, esbuild 0.28) is verified on Node 22 (this repo's dev environment runs 22.14), so CI pins Node 22. If an `engines.node` field is ever added, CI's `node-version` must be derived from it, and this workflow updated in the same commit.
- **`@at-series/mcp-hub`.** The lockfile resolves `@at-series/mcp-hub@0.3.2` from `registry.npmjs.org` with an integrity hash, so `npm ci` needs no extra registry auth. Do not replace it with a `file:` / `link:` dependency without updating this workflow — `npm ci` would break, and `esbuild.config.mjs` copies `dist/hub.js` out of that package at compile time.
- **No live Jenkins in CI.** The opt-in live suite (§6) is never wired into this workflow; CI must stay green with zero network access to any Jenkins.
- `npm run package` already chains `compile`; the separate Compile step exists so a bundling failure is attributed to the right step.

---

## 4. Security checklist — implementers must not regress

Each item below is implemented and tested today. Any task touching these areas must keep the corresponding tests green and must not weaken the behavior. When in doubt: secrets never leave `SecretStorage`, and the Agent surface never widens.

- [ ] **SecretStorage only.** API tokens and passwords live under `atJenkins.secret.apiToken.<id>` / `atJenkins.secret.password.<id>` in VS Code `SecretStorage` — never in `globalState`, settings, files, or MCP payloads (`src/config/JenkinsInstanceConfigManager.ts`). Deleting an instance deletes its secrets.
- [ ] **Redaction everywhere logs flow.** `src/utils/redaction.ts` masks `password / token / apiToken / secret / crumb / credential / key`-shaped values; every logger sink is wrapped (`src/utils/logger.ts`) and user-facing error messages pass through `toUserMessage`. New log lines and error paths must go through these, not raw `console`/`appendLine`.
- [ ] **MCP payload scrub.** `jenkins_list_instances` returns only `{id, label, baseUrl, readOnly, allowBackgroundAccess}` — no usernames, secrets, cookies, or crumbs. `scrubJobSecrets` in `src/agent/JenkinsAgentToolService.ts` strips secret-typed parameter default values from job payloads. Any new field added to an MCP result needs an explicit "can an Agent see this?" review.
- [ ] **`openExternal` host check.** `src/commands/openInJenkins.ts` refuses anything that is not `http:`/`https:` with a non-empty hostname before calling `vscode.env.openExternal` — server-supplied URLs (`file:`, `javascript:`, `vscode:`…) must never reach the OS handler. Keep `test/commands/openInJenkins.test.ts` covering the rejection cases.
- [ ] **No write MCP.** Every entry in `src/mcp/toolCatalog.ts` is `risk: 'read'`; the catalog has exactly the 7 D14 tools; `test/mcp/toolCatalog.test.ts` enforces it. No business tool is ever passed into the installer's autoApprove list.
- [ ] **Loopback-only bridge.** `BridgeServer` listens on `BRIDGE_HOST` = `127.0.0.1` with an ephemeral port (`src/mcp/BridgeServer.ts`). Never bind `0.0.0.0`, never a fixed well-known port, never disable the token header the hub protocol provides.
- [ ] **TOFU fail-closed.** `createInteractiveCertVerifier` rejects unseen certificates unless the user explicitly clicks "Trust New Certificate"; fingerprint mismatch yields `TlsError` (with mismatch-prompt dedup in `JenkinsCertTrustStore`). A timeout, dismissed prompt, or any ambiguity must reject — trust is never implied.
- [ ] **Crumb + session cookie binding.** `src/jenkins/JenkinsAuthenticator.ts` fetches the CSRF crumb from `crumbIssuer` and sends it together with the session cookie it was issued under (Jenkins ties crumbs to sessions); on 401 it clears the cached crumb/session and retries exactly once. Applies to `password` *and* `none` auth for mutating requests.

---

## 5. i18n checklist

The machinery in `test/i18n/nls.test.ts` enforces most of this mechanically; the checklist tells you how to stay inside its rules.

- [ ] Every user-facing runtime string goes through `t('…')` from `src/i18n/t.ts` with a **single-quoted string literal** as the key. The test scanner only recognizes literal `t('…')` calls — no template literals, no computed keys, no key constants. If you need interpolation, use `{placeholder}` args.
- [ ] `package.nls.json` and `package.nls.zh-cn.json` declare **exactly the same keys**, all namespaced `atJenkins.`, none blank.
- [ ] Every `%placeholder%` in `package.json` resolves in both nls files; placeholders are never embedded inside a longer manifest string; **no nls key is unused** by the manifest.
- [ ] `l10n/bundle.l10n.zh-cn.json` has a zh-CN entry for **every** `t()` key in `src/`, and — the reverse test — **no stale key** that no `t()` call uses anymore. Add and remove translations in the same commit as the code.
- [ ] Translations preserve every `{placeholder}` of the English source verbatim.
- [ ] **Badges and decorations count.** Tree-item badges (readOnly / allowBackgroundAccess / health), tooltips, status-bar text, and Output-channel headers are user-facing: both languages, same rules. Codicon ids and tree `contextValue`s are *not* translated.
- [ ] New contributed commands/views/settings in `package.json` use `%…%` placeholders from day one — never an English literal "to fix later".

---

## 6. Test strategy

### Unit tests (default; what CI runs)

- Everything under `test/` runs hermetically via vitest. HTTP behavior is exercised against the in-repo test server (`test/jenkins/testHttpServer.ts`) and fixtures — never a real Jenkins.
- Coverage responsibilities per area (keep these when refactoring): URL sanitization, auth header/crumb/cookie flows, TOFU trust-store semantics, error taxonomy mapping, tree ids and lazy paging, log truncation math, MCP gate refusals and schema validation, bridge health/tools/invoke with **no-secret-leak assertions**, redaction patterns, nls/l10n integrity (§5).

### Opt-in live suite (never in CI)

- Gated by environment variables; when unset, the suite is skipped entirely (`describe.skipIf`), so `npm test` stays green offline. Canonical names (v2 plan Task 10):
  - `AT_JENKINS_TEST_URL`
  - `AT_JENKINS_TEST_USER`
  - `AT_JENKINS_TEST_TOKEN`
  - optional `AT_JENKINS_TEST_JOB` (known job fullName for deeper read-only checks)
- Password+crumb live path may reuse the same user/token pair; do not add extra env names.
- What the live suite covers — the things mocks can't prove:
  - Real auth handshakes: API-token Basic auth, password + crumbIssuer + session-cookie binding, `none` against an open controller.
  - `logText/progressiveText` semantics (`X-Text-Size`, `start`, `X-More-Data`) across the Jenkins LTS versions we claim (D12), and the `consoleText` fallback on controllers where progressive is unavailable.
  - Redirect behavior (trailing-slash and auth redirects) against real controllers.
  - TLS: real certificate fingerprinting, TOFU prompt path, system-CA verification with `verifyTls: true`.
  - Large-log truncation against genuinely large console outputs.
- **Never put real secrets, tokens, or internal URLs in the repo** — not in fixtures, not in test names, not in recorded responses. Fixtures use invented hosts (`jenkins.example.invalid`) and dummy credentials. Live credentials exist only in the runner's environment.

---

## 7. Packaging & release gates

- [ ] **Publisher id is a human decision.** `package.json` keeps `"publisher": "local"` (the side-load convention) until a human explicitly chooses and registers a marketplace publisher. Do **not** invent, guess, or placeholder a marketplace publisher name in any commit.
- [ ] **README in both languages.** The README is currently zh-CN only; before v1 release it must carry an English section (or split files) covering: features, auth modes, security model (SecretStorage / TOFU / read-only MCP), MCP tool list, and settings.
- [ ] **CHANGELOG discipline.** `CHANGELOG.md` `[Unreleased]` is updated as work lands; on release it is promoted to a dated version heading matching `package.json` `version`.
- [ ] **vsce flags stay intentional.** `npm run package` = `npm run compile && npx @vscode/vsce package --no-dependencies --allow-missing-repository --no-rewrite-relative-links`. `--no-dependencies` is required because esbuild bundles everything (including the hub copy in `dist/hub.js`); removing it would balloon the VSIX with `node_modules`. Do not add or remove flags without noting why in the commit.
- [ ] **Engine coherence.** `engines.vscode ^1.85.0`, `@types/vscode ^1.85.0`, and esbuild `target: 'node18'` move together. Raising the minimum VS Code version is a deliberate, changelogged decision — not a side effect of wanting a newer API.
- [ ] **VSIX smoke test.** Install the built VSIX into a clean profile: extension activates on startup, both views render, welcome content appears with zero instances, no errors in the extension host log.
- [ ] **Artifact integrity.** `dist/hub.js` + `dist/hub-version.json` are present in the VSIX (see §2 compile gate); l10n files and `package.nls*.json` are packaged; no `.map` files ship.

---

## 8. Risk register

Known sharp edges, each mapped to the v1 plan task that mitigates it. A risk is closed only when its task's tests land.

| # | Risk | Failure mode | Mitigating v1 task |
|---|------|--------------|--------------------|
| R1 | **Last-write-wins pipeline save** | Two editors (or IDE + Jenkins UI) edit the same controller-stored script; the later save silently overwrites the earlier one. | v1 plan — *version-checked pipeline save*: re-fetch the script (or config version) before submit; if it changed since open, block the save and prompt with a diff/refresh path. |
| R2 | **Quadratic log handling** | Rebuilding the whole log document every poll makes long builds O(n²) in bytes transferred and re-rendered; the UI stalls on multi-hundred-MB logs. | v1 plan — *incremental log append*: use `progressiveText` `start` offsets to fetch only new bytes, append instead of replace, enforce `atJenkins.log.uiTailBytes` as a hard window. |
| R3 | **3xx renders an empty tree** | A redirect (missing trailing slash, auth gateway) is treated as an empty/invalid job list; the Jobs view shows "no jobs" instead of an error, and the user believes the controller is empty. | v1 plan — *explicit redirect handling in `JenkinsHttpClient`*: follow safe same-origin redirects a bounded number of times; anything else surfaces a typed error, never an empty result. |
| R4 | **Corrupt persisted config** | A malformed entry in `atJenkins.instances` (bad migration, manual edit, sync conflict) throws during activation and takes down the whole extension. | v1 plan — *config quarantine on load*: `safeParse` each entry against `src/config/schema.ts`; skip and report invalid entries; never let one bad instance block the rest. |
| R5 | **Concurrent follows on one build** | Starting "follow in Output" twice for the same build spawns duplicate pollers: interleaved output, doubled request load, orphaned timers after the build ends. | v1 plan — *single-flight follow registry*: one poller per `(instanceId, jobFullName, buildNumber)`; a second follow focuses the existing channel; `follow.maxPolls` and build completion both tear the poller down. |
| R6 | **MCP `jenkins_get_build` unfiltered** | Returning raw Jenkins build JSON leaks `actions[]` contents — build parameters (possibly secret-typed), env hints, upstream cause details — to Agents. | v1 plan — *whitelisted build mapping*: map to an explicit result shape (status, result, timestamps, duration, url, scrubbed cause/params via the `scrubJobSecrets` pattern); unknown fields are dropped, not forwarded. |

---

## 9. What is already solid — do not rework

The following are implemented, tested (40 files / 364 tests green at contract time), and match the locked decisions. Tasks must build on them, not rewrite them. If a task genuinely requires changing one, say so explicitly in the task and keep its tests green.

- **The 7-tool read-only MCP catalog** (`src/mcp/toolCatalog.ts` + `bridgeSchemas.ts` + `JenkinsAgentToolService.ts`): names, descriptions, `risk: 'read'`, `allowBackgroundAccess` gating, and the 64 KiB default log tail all match D3/D13/D14/D17.
- **SecretStorage credential handling** including "empty field on edit keeps the existing secret" and delete-instance secret cleanup.
- **TOFU semantics** (`JenkinsCertTrustStore`, `createInteractiveCertVerifier`): fail-closed prompt, fingerprint persistence, mismatch dedup, `verifyTls` system-CA mode.
- **`progressiveText` with `consoleText` fallback is already present** in `src/jenkins/JenkinsClient.ts` — do not re-add a "switch logs to progressiveText" task; remaining log work is the incremental-append/windowing of R2 only.
- **The nls/l10n test machinery** (`test/i18n/nls.test.ts`): parity, placeholder, reverse stale-key, and manifest checks. Extend the string tables; never weaken the tests.
- **Client pool invalidation by `updatedAt`** (`src/jenkins/JenkinsClientPool.ts`): editing an instance config rotates its pooled client; no manual cache-bust needed after config edits.
- **Crumb-to-session-cookie binding with single 401 retry** (`JenkinsAuthenticator`) and **redacting logger** (`src/utils/logger.ts` + `redaction.ts`).
- **`openExternal` scheme/host validation** (`src/commands/openInJenkins.ts`).
