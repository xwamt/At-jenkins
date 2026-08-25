# AT Jenkins Design

**Date:** 2026-08-25  
**Status:** Approved — implementation plan: `docs/superpowers/plans/2026-08-25-at-jenkins.md`  
**Repo:** `at-jenkins-series` (sibling to `at-series-mcp-hub`)  
**Approach:** Align with `at-nacos-series` skeleton (single Jenkins client façade, no multi-driver chain)

---

## 1. Goal

Ship an AT Series VS Code / Cursor extension that lets operators manage multiple Jenkins 2.x controllers from the IDE: browse Folder/Job/Build trees, edit Pipeline scripts stored on Jenkins, trigger/cancel builds with confirmations, follow console logs, and expose a **read-only** MCP tool surface via `@at-series/mcp-hub` for Agents to inspect jobs, definitions, build status, and logs — never to mutate build process.

---

## 2. Decisions (locked)

| # | Decision |
|---|----------|
| D1 | v1 job scope: **Pipeline + Freestyle** (parameterized builds + console logs). Out: Agent nodes, credentials store, plugin management, Views-as-primary nav. |
| D2 | “Edit pipeline” means edit **Jenkins-stored** Pipeline script text (job config). SCM-backed Multibranch/Pipeline-from-SCM and Freestyle are **view-only** for definitions in v1 (no IDE→SCM push, no full `config.xml` editor). |
| D3 | **MCP is read-only.** No trigger, stop, or script update tools. UI owns all mutations. |
| D4 | Auth modes: **API Token**, **Username+Password (+ CSRF Crumb)**, **none**. Out: custom headers, browser SSO/OIDC. |
| D5 | Activity Bar dual views: **Instances** + **Jobs** (Nacos-style split). |
| D6 | Clicking an instance sets `activeInstanceId`; Jobs tree shows **only** that instance. |
| D7 | Editor hybrid: Pipeline script → **native virtual document**; params/run → QuickPick or light webview. |
| D8 | Logs: **read-only virtual document** primary; optional Output Channel follow; Stage-timeline webview **deferred**. |
| D9 | Tree: `Folder → Job → Build`; Multibranch **branches are Jobs**; builds use **lazy “load more”**. |
| D10 | Write guards: per-instance **readOnly**; confirm before save script / trigger / cancel; cancel in-progress build **in UI only**. |
| D11 | Delivery: **single VSIX always includes MCP** (no base/mcp dual package). |
| D12 | Server target: **broad Jenkins 2.x** (including older LTS still in use). No 1.x commitment. |
| D13 | Per-instance **`allowBackgroundAccess`** (default `false`) gates MCP tools that take `instanceId`, except `jenkins_list_instances` (always lists configs + flags so Agents can discover what is enabled). |
| D14 | MCP tools: `jenkins_list_instances`, `jenkins_list_jobs`, `jenkins_get_job`, `jenkins_get_pipeline_script`, `jenkins_list_builds`, `jenkins_get_build`, `jenkins_get_build_log`. |
| D15 | TLS: **TOFU fingerprint trust** + optional system-CA verify per instance (`verifyTls`). |
| D16 | i18n: full **zh-CN + en** (`package.nls*` + `l10n`). |
| D17 | `jenkins_get_build_log`: default **tail 64 KiB**; `tailBytes` / `start` adjustable; always mark truncation. |
| D18 | Implementation skeleton: **Nacos-aligned** modules (config, http+TOFU, client façade, tree, documents, mcp Bridge). Single client — no Nacos-style multi-driver fallback chain unless a concrete API gap appears. |

---

## 3. Identity

| Item | Value |
|---|---|
| Directory | `/Users/clkj/项目/at/at-jenkins-series` |
| npm `name` | `at-jenkins` |
| `displayName` | `AT Jenkins` |
| `publisher` | `local` (side-load convention) |
| Command / settings / state prefix | `atJenkins.` |
| Activity Bar container id | `atJenkins` |
| MCP `pluginId` | `at.jenkins` |
| MCP tool prefix | `jenkins_` |
| `engines.vscode` | `^1.85.0` |
| Hub dependency | `@at-series/mcp-hub` (same major as siblings, currently `^0.3.2`) |

---

## 4. Architecture

```
JenkinsInstanceConfig (globalState) + secrets (SecretStorage)
        │
        ▼
JenkinsAuthenticator     ← apiToken | password+crumb | none; session/crumb cache; 401 refresh once
        │
        ▼
JenkinsHttpClient        ← node http(s), TOFU, timeouts, error taxonomy
        │
        ▼
JenkinsClient (façade)   ← normalized domain API
        │
        ├── UI: Instances view, Jobs tree, virtual docs, param UI, commands
        └── MCP: Bridge HTTP + toolCatalog (read-only; allowBackgroundAccess gate)
```

**Module layout (planned)**

| Area | Responsibility |
|---|---|
| `src/config/` | Zod schemas, `JenkinsInstanceConfigManager`, active instance id |
| `src/jenkins/` | Authenticator, HttpClient, Client façade, domain types |
| `src/tree/` | Instances provider, Jobs provider, lazy build children |
| `src/document/` | Script + consoleText virtual documents; save pipeline script |
| `src/webview/` | Optional light param form (if QuickPick insufficient) |
| `src/mcp/` | BridgeServer, toolCatalog, hub sync, config installer |
| `src/i18n/` | Portable i18n helpers (series pattern) |

---

## 5. Data model

### Instance (no secrets — `globalState`)

```ts
interface JenkinsInstanceConfig {
  id: string;
  label: string;
  baseUrl: string; // strip trailing slashes; strip URL userinfo on read/write
  authMode: 'none' | 'apiToken' | 'password';
  username?: string;
  /**
   * true: verify against system CAs only.
   * false: TOFU — on first connect prompt to trust fingerprint; later mismatch → TlsError.
   */
  verifyTls: boolean;
  readOnly: boolean;              // default false
  allowBackgroundAccess: boolean; // default false
  createdAt: number;
  updatedAt: number;
}
```

`label` after save: `trim()`; if empty, fall back to `new URL(baseUrl).hostname` (or raw host if URL parse fails). Never persist an empty label.

### Persistence

| Key | Store | Value |
|---|---|---|
| `atJenkins.instances` | globalState | `JenkinsInstanceConfig[]` |
| `atJenkins.activeInstanceId` | globalState | `string \| undefined` |
| `atJenkins.secret.apiToken.<id>` | SecretStorage | API token |
| `atJenkins.secret.password.<id>` | SecretStorage | password |
| `atJenkins.tofu.fingerprints` | globalState | host→fingerprint map (Grafana/Nacos TOFU pattern; no secrets) |

Credentials never appear in globalState, MCP payloads, Output logs, or error strings.

### Auth behavior

- **apiToken:** HTTP Basic `username:token` (Jenkins remote API standard).
- **password:** Obtain crumb via `crumbIssuer` for mutating requests; on 401 clear cached crumb/session and retry **once**.
- **none:** unauthenticated requests.
- Empty password/token on edit form means “keep existing secret” (series convention).

---

## 6. UI

### Views

1. **Instances** — list configured controllers; add/edit/delete/test connection/refresh; badges for readOnly / allowBackgroundAccess / connection health. **Single click** sets active instance and refreshes Jobs.
2. **Jobs** — tree for `activeInstanceId` only: Folder → Job → Build; empty states for no instances / no selection / load errors.

### Tree ids (stable, unique within active instance)

- Folder: `folder:<jobFullName>`
- Job: `job:<jobFullName>`
- Build: `build:<jobFullName>#<number>`
- Load-more sentinel: `builds-more:<jobFullName>:<cursor>`

### Editing

- Virtual document URI scheme e.g. `at-jenkins:/{instanceId}/{jobFullName}/Jenkinsfile`.
- Language mode: Groovy / Jenkinsfile association.
- Save → confirm → `updatePipelineScript` unless `readOnly`.
- **Script source constraint:** only Pipeline jobs whose definition is **stored on the Jenkins controller** (pipeline script in job config) are editable. Multibranch / Pipeline-from-SCM / Freestyle → open read-only or `Unsupported` on save; do not invent SCM push from the IDE in v1.
- Freestyle: open read-only summary (description/params); no config.xml round-trip in v1.

### Run / cancel (UI only)

- No params: confirm → `build`.
- With params: QuickPick or light webview → confirm → `buildWithParameters`.
- Running build: confirm → `stop` / `kill` as appropriate for the Jenkins API.
- All blocked when `readOnly`.

### Logs

- Primary: read-only virtual document for `consoleText`; in-progress builds poll progressive log API.
- Optional: mirror follow into an Output Channel.
- Stage timeline webview: **not in v1**.

---

## 7. MCP

### Wiring

- Localhost Bridge: `GET /health`, `GET /tools`, `POST /invoke`.
- Publish registry via `FsBridgePublisher`; `syncHubBundle` + `ensureAtSeriesMcpConfig`.
- `detectHostApp({ appName, appRoot, uriScheme, extensionPath })`.
- All tools `risk: 'read'`. Do not pass business tools into installer autoApprove.

### Gates

1. `jenkins_list_instances`: no `allowBackgroundAccess` gate (returns id/label/baseUrl/flags only).
2. All other tools: instance must exist **and** `allowBackgroundAccess === true` (else `DeniedBackground` with actionable message).
3. Never return secrets, crumbs, or cookies.

### Tools

| Tool | Purpose | Notes |
|---|---|---|
| `jenkins_list_instances` | Discover `instanceId`s | No credentials; include flags |
| `jenkins_list_jobs` | List jobs under instance | Folder paths; pagination/depth params |
| `jenkins_get_job` | Job metadata | Type, parameters, last build summary |
| `jenkins_get_pipeline_script` | Pipeline script body | Non-pipeline → `Unsupported` |
| `jenkins_list_builds` | Build list | Pagination |
| `jenkins_get_build` | One build | Status, result, duration, URL |
| `jenkins_get_build_log` | Console log | Default tail **64 KiB**; `tailBytes` / `start`; truncation flag |

### Hard exclusions

No MCP tools for: trigger build, cancel build, update script, change job config, manage nodes/credentials/plugins.

---

## 8. Errors

| Class | When | UX / Agent |
|---|---|---|
| `AuthError` | 401/403 | Reconfigure credentials; one crumb retry on write |
| `TlsError` | Cert mismatch | TOFU prompt or reject |
| `NotFound` | Missing job/build | Refresh tree / clear message |
| `Unsupported` | Wrong job type for operation | Explicit type message |
| `DeniedBackground` | MCP without allowBackgroundAccess | Tell user to enable on instance |
| `ReadOnly` | UI mutation on readOnly instance | Refuse command |
| `Truncated` | Log tail limit | Include continuation params |

---

## 9. Testing

- **vitest**, TDD for new modules.
- Unit: URL sanitize, auth header/crumb, tree ids, log truncation, MCP gates, tool schemas.
- Bridge: health/tools/invoke; assert no secret leakage in responses.
- Optional live Jenkins integration tests behind explicit env (not default CI secrets).

---

## 10. Milestones

| Milestone | Deliverable |
|---|---|
| **M0** | Repo skeleton, i18n, config model, HttpClient+TOFU, three auth modes, test connection |
| **M1** | Instances + Jobs views, Folder/Job tree, lazy build load-more |
| **M2** | Virtual docs: script edit (confirm + readOnly), console log, optional Output follow |
| **M3** | UI trigger + parameterized build + cancel |
| **M4** | MCP Bridge + seven read-only tools + Hub register + allowBackgroundAccess |
| **M5** | Polish, zh/en copy, README/features, VSIX package |

---

## 11. Non-goals (v1)

- SSO / custom auth headers
- Agent node, credential, plugin, or View administration
- Stage timeline webview
- Dual base/mcp VSIX split
- Any MCP write or exec capability
- Full Freestyle `config.xml` editing
- Jenkins 1.x support commitment
- Local workspace Jenkinsfile sync as primary edit path (may revisit later)

---

## 12. References

- Hub integration: `at-series-mcp-hub/docs/guides/plugin-integration.md`
- Protocol: `at-series-mcp-hub/docs/protocol/v1.md`, `v2.md`
- Skeleton reference: `at-nacos-series` (multi-instance, virtual docs, Bridge, allowBackgroundAccess)
- Multi-instance UX reference: `at-jumpserver-series` (bastion list patterns; AT Jenkins uses dual-view + active instance instead of multi-root tree)
