# AT Jenkins — Features

**Audience:** end users and administrators configuring/using the extension (for the Agent-facing tool contract, see [`skills/at-jenkins-mcp/SKILL.md`](../skills/at-jenkins-mcp/SKILL.md)).

## Overview

AT Jenkins brings Jenkins CI/CD controller navigation, job inspection, build log streaming, and pipeline script editing natively into the IDE (VS Code and Cursor), and exposes Jenkins metadata, job configurations, and build logs to AI Agents through the shared [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) Protocol v1 — no separate MCP server entry to configure, and no per-plugin setup beyond adding your Jenkins controller(s).

---

## Instance Configuration

- **Multiple Jenkins Controllers**: Configure one or more Jenkins controllers (Label, Base URL, Auth Mode). Supports custom prefix paths (e.g. `http://ci.internal.net:8080/jenkins`).
- **Three Authentication Modes**:
  - **No authentication (None)**: For open or read-only internal mirrors. Anonymous POSTs still fetch a CSRF crumb and bind the session cookie when the controller requires it.
  - **API Token (recommended)**: Authenticates using the API token generated under Jenkins → User profile → Configure → API Token.
  - **Username and Password**: User account credentials with automatic CSRF Crumb fetching, session-cookie binding, and caching (supports Jenkins 2.x `DefaultCrumbIssuer`).
- **Encrypted Credential Storage**: Sensitive API tokens and passwords are stored exclusively in VS Code's native `SecretStorage`, never written to plaintext settings or disk configs.
- **TLS Trust-On-First-Use (TOFU)**: HTTPS connections to controllers with self-signed or private CA certificates prompt a certificate fingerprint confirmation dialog and record its SHA-256 fingerprint. Any subsequent fingerprint change blocks the connection and displays a security warning to prevent machine-in-the-middle attacks.
- **Read-Only Controller Mode (`readOnly`)**: Mark sensitive production controllers as read-only. Trigger/stop/save actions remain visible but refuse at runtime (user message + `ReadOnly` hard-block in the client).
- **Agent Background Access Gate (`allowBackgroundAccess`)**: Each controller instance has an independent "Allow Agent background access" toggle (default off). Controllers without the toggle still appear in jenkins_list_instances (with flags); other jenkins_* tools require the toggle.
- **Test Connection**: The instance configuration form provides a "Test Connection" button that validates network reachability, TLS verification, and authentication before saving.

---

## Sidebar Tree UI

- **Controllers View (`atJenkins.instances`)**:
  - Displays all configured Jenkins controllers with active status badges (`radio-tower` icon for active, `server` icon for inactive).
  - Inline and context menu actions: **Set as Active Controller**, **Test Connection**, **Edit Controller**, and **Delete Controller**.
  - Informative Markdown hover tooltips detailing Base URL, Auth Mode, Username, Active state, Read-only state, Background Access state, and TLS Verification status.
- **Jobs View (`atJenkins.jobs`)**:
  - Automatically loads the job hierarchy from the currently active controller.
  - Full Folder support: Folders (`com.cloudbees.hudson.plugins.folder.Folder`) can be recursively expanded.
  - Job type & status visualization:
    - Distinguishes Pipeline jobs (`WorkflowJob` / `CpsFlowDefinition`) and Freestyle jobs (`FreeStyleProject`).
    - Job status icons reflecting health and status (Pass / Error / Warning / Aborted / Disabled / Anime spinning for building).
    - Weather/stability from Jenkins `healthReport` (omitted when only a single lastBuild is known).
    - Type badges for Multibranch, Organization Folder, and Matrix jobs.
  - Lazy-loaded build history: Expanding a job queries its recent builds with incremental pagination (default 10 builds per page, `atJenkins.builds.pageSize`), providing a **"Load more builds..."** item to load subsequent pages on demand.
  - **Open in Jenkins** (`atJenkins.openInJenkins`): Opens the controller/folder/job/build (or the matching virtual document) in the browser. Only `http`/`https` URLs are accepted.
  - Empty and error rows: no-jobs and fetch-error placeholders, with retry on the error row.

---

## Virtual Documents & Editors

- **Pipeline Script Editor (`at-jenkins:` Scheme)**:
  - Opens controller-stored CPS Pipeline scripts via editable draft URI (`at-jenkins-draft://{instanceId}/Jenkinsfile?job={jobFullName}`).
  - Native Groovy syntax highlighting.
  - In-place editing and direct save (`Cmd+S` / `Ctrl+S`): modifying and saving the virtual document updates the pipeline script definition on the Jenkins controller (protected by read-only checks and a modal confirmation dialog).
- **Live Build Console Logs (`at-jenkins:` Scheme)**:
  - Opens build console logs via virtual document URI (`at-jenkins://{instanceId}/{buildNumber}/consoleText?job={jobFullName}`).
  - Native Log syntax highlighting.
  - Progressive live auto-refresh: for running builds (`building: true`), polls via `logText/progressiveText` (falls back to `consoleText`) using `atJenkins.log.pollIntervalMs` (default 3s) until completion.
  - Auto-cleanup: polling timers are automatically cancelled when the log tab is closed in the IDE.
- **Follow Build Log in Output Channel**:
  - Context menu command **"Follow Build Log in Output"** streams build log chunks incrementally into the VS Code Output Channel (`AT Jenkins`), offering terminal-style following with progress indication.

---

## Safe Write Operations

- **Trigger Build (`atJenkins.triggerBuild`)**:
  - Parameter prompt modal: automatically queries the job's parameter definitions and interactively prompts the user for inputs:
    - **String / Text parameters**: Input box with parameter description and default value.
    - **Choice parameters**: QuickPick dropdown selector with default option indicated.
    - **Boolean parameters**: QuickPick selection for `true` / `false`.
    - **Password parameters**: Masked password input box.
  - Modal confirmation: prompts a confirmation dialog before sending the trigger request to Jenkins.
  - Recent parameters: when a job was triggered before, a QuickPick offers **Use recent parameters**, **Edit parameters**, or **Use default parameters** (password/secret parameters are never persisted).
  - After a trigger, the status bar follows queue → running → done and offers **View Log** / **Open in Jenkins** on completion.
  - Read-only protection: rejects execution if the target controller is configured with `readOnly: true`.
- **Stop Build (`atJenkins.stopBuild`)**:
  - Available on active, running builds (`jenkinsBuild.building`).
  - Prompts a modal confirmation dialog before aborting the build.
  - Read-only protection: rejects execution if the target controller is configured with `readOnly: true`.

---

## MCP Tool Catalog (for Agents)

Seven tools, all strictly `read-only` and auto-approved once the AT Series MCP configuration is installed — no per-tool approval prompts.

1. **`jenkins_list_instances`**:
   - Lists all configured Jenkins controllers with flags (including `allowBackgroundAccess`); other tools require the flag.
   - Never exposes API tokens, passwords, or secrets.
2. **`jenkins_list_jobs`**:
   - Queries jobs for a controller.
   - Accepts an optional `folderFullName` parameter to list jobs within nested folders.
   - Returns job names, full names, types (`_class`), color/status, and `isFolder` indicators.
3. **`jenkins_get_job`**:
   - Retrieves full metadata for a specific job, including parameter definitions and recent builds summary.
4. **`jenkins_get_pipeline_script`**:
   - Retrieves the Groovy Pipeline script for controller-stored CPS Pipeline jobs.
5. **`jenkins_list_builds`**:
   - Returns a paginated list of builds for a job (`limit`, `offset`).
   - Includes build numbers, status results, timestamps, durations, and building flags.
6. **`jenkins_get_build`**:
   - Retrieves detailed build information (result status, duration, timestamp, and related build fields from the Remote API).
7. **`jenkins_get_build_log`**:
   - Retrieves console log text for a specific build.
   - Defaults to tailing the last 64 KiB (`DEFAULT_LOG_TAIL_BYTES`).
   - Accepts a `start` byte offset for progressive chunk reading, returning continuation metadata (`hasMore`, `totalBytes`, `startByte`, `endByte`, `truncated`).

### Security Boundaries & Hard Exclusions
- **No Write Tools in MCP**: MCP does not provide tools to trigger builds, stop builds, delete jobs, or modify scripts. All mutating operations remain user-driven via IDE UI.
- **Background Access Gate**: Controllers with `allowBackgroundAccess` off still appear in `jenkins_list_instances` (with flags); other `jenkins_*` tools refuse access until the flag is enabled.
- **Redaction**: All logger outputs and error responses automatically redact tokens, cookies, and passwords.

---

## Settings

Tunable in the Settings UI under **AT Jenkins** (or `atJenkins.*` in `settings.json`):

- `atJenkins.builds.pageSize` — builds loaded per Jobs-tree page (default 10).
- `atJenkins.log.pollIntervalMs` — editor auto-refresh and Output-follow poll interval (default 3000).
- `atJenkins.log.uiTailBytes` — trailing bytes shown in the build-log editor (default 2 MiB).
- `atJenkins.follow.pollIntervalMs` / `atJenkins.follow.maxPolls` — status-bar follow after triggering a build.

---

## Hub / IDE Integration

- On activation, AT Jenkins installs/repairs the single shared `AT Series` MCP entry (Cursor, Kiro, Continue) used by all AT-family plugins — installing AT Jenkins never creates a second, plugin-specific MCP server entry.
- **Shared Bridge Protocol**: Communicates with `@at-series/mcp-hub` via local loopback bridge service (`127.0.0.1`).

---

## Non-goals (current release)

- Multibranch Pipeline branch indexing triggers (inspection and direct pipeline jobs are supported)
- Jenkins system administration / plugin installation / node provisioning
- Direct SSH execution on Jenkins agent machines
- Legacy Jenkins 1.x controllers (targeted for Jenkins 2.x+)
