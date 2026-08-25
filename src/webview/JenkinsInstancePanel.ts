import * as vscode from 'vscode';
import { z } from 'zod';
import type {
  JenkinsInstanceConfigManager,
  JenkinsInstanceSecrets
} from '../config/JenkinsInstanceConfigManager';
import {
  JENKINS_AUTH_MODES,
  type JenkinsAuthMode,
  type JenkinsInstanceConfig
} from '../config/schema';
import { buildWebviewStrings, t } from '../i18n/t';
import { JenkinsAuthenticator } from '../jenkins/JenkinsAuthenticator';
import type { JenkinsCertVerifier } from '../jenkins/JenkinsCertTrustStore';
import { JenkinsClient } from '../jenkins/JenkinsClient';
import { JenkinsHttpClient } from '../jenkins/JenkinsHttpClient';
import { formatError } from '../utils/errors';
import { asRedactedLog, noopLog, type AtJenkinsLog } from '../utils/logger';
import { escapeAttr, renderWebviewHtml } from './html';
import { openOrRevealPanel, panelKey } from './openPanels';

export interface JenkinsInstanceFormOptions {
  testConnection?: (options: {
    baseUrl: string;
    authMode: JenkinsAuthMode;
    username?: string;
    secret?: string;
    verifyTls: boolean;
  }) => Promise<{ ok: boolean; message: string; nodeName?: string }>;
  certVerifier?: JenkinsCertVerifier;
  log?: AtJenkinsLog;
}

export interface RenderInstanceFormOptions {
  existing?: JenkinsInstanceConfig;
  hasStoredApiToken?: boolean;
  hasStoredPassword?: boolean;
}

export interface InstanceFormView {
  body: string;
  data: Record<string, unknown>;
}

const instanceFormPayloadSchema = z
  .object({
    label: z.string(),
    baseUrl: z.string(),
    authMode: z.enum(JENKINS_AUTH_MODES),
    username: z.string(),
    apiToken: z.string(),
    password: z.string(),
    verifyTls: z.boolean(),
    readOnly: z.boolean(),
    allowBackgroundAccess: z.boolean()
  })
  .strip();

export type InstanceFormPayload = z.infer<typeof instanceFormPayloadSchema>;

export type InstanceFormConfigManager = Pick<
  JenkinsInstanceConfigManager,
  'createInstance' | 'updateInstance' | 'getApiToken' | 'getPassword'
>;

export class JenkinsInstancePanel {
  static async open(
    context: vscode.ExtensionContext,
    configManager: JenkinsInstanceConfigManager,
    onSaved: () => void,
    existing?: JenkinsInstanceConfig,
    options: JenkinsInstanceFormOptions = {}
  ): Promise<void> {
    const key = panelKey('jenkinsInstanceForm', existing ? existing.id : 'new');

    const panel = openOrRevealPanel(key, () => {
      return vscode.window.createWebviewPanel(
        'atJenkins.instanceForm',
        instanceFormTitle(existing),
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [context.extensionUri]
        }
      );
    });

    if (!panel) {
      return;
    }

    const hasStoredApiToken = existing ? Boolean(await configManager.getApiToken(existing.id)) : false;
    const hasStoredPassword = existing ? Boolean(await configManager.getPassword(existing.id)) : false;

    const view = renderInstanceForm({
      existing,
      hasStoredApiToken,
      hasStoredPassword
    });

    panel.webview.html = renderWebviewHtml(
      panel.webview,
      {
        script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'jenkins-instance-form.js'),
        style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'jenkins-instance-form', 'index.css')
      },
      view.body,
      view.data
    );

    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      await handleInstanceFormMessage(message, existing, configManager, onSaved, panel, options);
    });
  }
}

export async function handleInstanceFormMessage(
  message: unknown,
  existing: JenkinsInstanceConfig | undefined,
  configManager: InstanceFormConfigManager,
  onSaved: () => void,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>,
  options: JenkinsInstanceFormOptions = {}
): Promise<boolean> {
  const type = messageType(message);
  if (type !== 'submit' && type !== 'testConnection') {
    return false;
  }

  const parsed = instanceFormPayloadSchema.safeParse((message as { payload?: unknown }).payload);
  if (!parsed.success) {
    await postError(panel, t('This form sent a value AT Jenkins could not read. Reload the panel and try again.'));
    return true;
  }

  if (type === 'testConnection') {
    await runConnectionTest(parsed.data, existing, configManager, panel, options);
    return true;
  }

  try {
    await saveInstance(parsed.data, existing, configManager, onSaved, panel);
  } catch (error) {
    await postError(panel, formatError(error));
  }
  return true;
}

async function saveInstance(
  payload: InstanceFormPayload,
  existing: JenkinsInstanceConfig | undefined,
  configManager: InstanceFormConfigManager,
  onSaved: () => void,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>
): Promise<void> {
  const baseUrl = payload.baseUrl.trim();
  if (!isValidJenkinsUrl(baseUrl)) {
    await postError(panel, t('A valid Jenkins controller URL (starting with http:// or https://) is required.'));
    return;
  }

  const credentials = await resolveCredentials(payload, existing, configManager);
  if (!credentials.ok) {
    await postError(panel, credentials.message);
    return;
  }

  const fields = {
    label: payload.label.trim() || undefined,
    baseUrl,
    authMode: payload.authMode,
    username: payload.username.trim() || undefined,
    verifyTls: payload.verifyTls,
    readOnly: payload.readOnly,
    allowBackgroundAccess: payload.allowBackgroundAccess
  };

  if (existing) {
    await configManager.updateInstance(existing.id, fields, credentials.secrets);
  } else {
    await configManager.createInstance({
      ...fields,
      ...credentials.secrets
    });
  }

  panel.dispose();
  onSaved();
}

type CredentialResolution =
  | { ok: true; secrets: JenkinsInstanceSecrets }
  | { ok: false; message: string };

async function resolveCredentials(
  payload: InstanceFormPayload,
  existing: JenkinsInstanceConfig | undefined,
  configManager: InstanceFormConfigManager
): Promise<CredentialResolution> {
  const secrets: JenkinsInstanceSecrets = {};

  if (payload.authMode === 'apiToken') {
    if (!payload.username.trim()) {
      return { ok: false, message: t('A username is required for API Token authentication.') };
    }
    const stored = existing ? await configManager.getApiToken(existing.id) : undefined;
    if (payload.apiToken === '' && !stored) {
      return { ok: false, message: t('An API Token is required for API Token authentication.') };
    }
    secrets.apiToken = payload.apiToken === '' ? undefined : payload.apiToken;
    secrets.password = existing ? '' : undefined;
  } else if (payload.authMode === 'password') {
    if (!payload.username.trim()) {
      return { ok: false, message: t('A username is required for password authentication.') };
    }
    const stored = existing ? await configManager.getPassword(existing.id) : undefined;
    if (payload.password === '' && !stored) {
      return { ok: false, message: t('A password is required for password authentication.') };
    }
    secrets.password = payload.password === '' ? undefined : payload.password;
    secrets.apiToken = existing ? '' : undefined;
  } else {
    secrets.apiToken = existing ? '' : undefined;
    secrets.password = existing ? '' : undefined;
  }

  return { ok: true, secrets };
}

async function runConnectionTest(
  payload: InstanceFormPayload,
  existing: JenkinsInstanceConfig | undefined,
  configManager: InstanceFormConfigManager,
  panel: Pick<vscode.WebviewPanel, 'webview'>,
  options: JenkinsInstanceFormOptions
): Promise<void> {
  let outcome: { ok: boolean; message: string };
  try {
    outcome = await probeWithFormValues(payload, existing, configManager, options);
  } catch (error) {
    outcome = { ok: false, message: formatError(error) };
  }
  await post(panel, { type: 'connectionTestResult', payload: outcome });
}

async function probeWithFormValues(
  payload: InstanceFormPayload,
  existing: JenkinsInstanceConfig | undefined,
  configManager: InstanceFormConfigManager,
  options: JenkinsInstanceFormOptions
): Promise<{ ok: boolean; message: string }> {
  const baseUrl = payload.baseUrl.trim();
  if (!isValidJenkinsUrl(baseUrl)) {
    return {
      ok: false,
      message: t('A valid Jenkins controller URL (starting with http:// or https://) is required.')
    };
  }

  let effectiveSecret: string | undefined;
  if (payload.authMode === 'apiToken') {
    if (!payload.username.trim()) {
      return { ok: false, message: t('A username is required for API Token authentication.') };
    }
    effectiveSecret =
      payload.apiToken !== ''
        ? payload.apiToken
        : existing
          ? await configManager.getApiToken(existing.id)
          : undefined;
    if (!effectiveSecret) {
      return { ok: false, message: t('An API Token is required for API Token authentication.') };
    }
  } else if (payload.authMode === 'password') {
    if (!payload.username.trim()) {
      return { ok: false, message: t('A username is required for password authentication.') };
    }
    effectiveSecret =
      payload.password !== ''
        ? payload.password
        : existing
          ? await configManager.getPassword(existing.id)
          : undefined;
    if (!effectiveSecret) {
      return { ok: false, message: t('A password is required for password authentication.') };
    }
  }

  if (options.testConnection) {
    return options.testConnection({
      baseUrl,
      authMode: payload.authMode,
      username: payload.username.trim() || undefined,
      secret: effectiveSecret,
      verifyTls: payload.verifyTls
    });
  }

  const log = asRedactedLog(options.log ?? noopLog);
  const httpClient = new JenkinsHttpClient({
    baseUrl,
    verifyTls: payload.verifyTls,
    certVerifier: options.certVerifier,
    log
  });

  const authenticator = new JenkinsAuthenticator({
    authMode: payload.authMode,
    username: payload.username.trim() || undefined,
    secret: effectiveSecret,
    httpClient
  });

  const client = new JenkinsClient({
    httpClient,
    authenticator,
    log
  });

  const result = await client.testConnection();
  const nodeInfo = result.nodeName ? ` (${result.nodeName})` : '';
  return {
    ok: true,
    message: t('Connected to Jenkins controller{nodeInfo}.', { nodeInfo })
  };
}

export function renderInstanceForm(options: RenderInstanceFormOptions = {}): InstanceFormView {
  const { existing, hasStoredApiToken = false, hasStoredPassword = false } = options;
  const submitLabel = existing ? t('Save Controller') : t('Add Controller');
  const authMode = renderedAuthMode(existing);
  const verifyTlsChecked = existing ? existing.verifyTls : true;

  const body = `<main class="instance-form-shell">
  <header class="form-header">
    <div>
      <h1>${escapeAttr(instanceFormTitle(existing))}</h1>
      <p>${escapeAttr(t('Connect AT Jenkins to a Jenkins controller to browse jobs, builds, and pipeline logs.'))}</p>
    </div>
  </header>
  <form id="instance-form" class="instance-form auth-mode-${escapeAttr(authMode)}">
    <div class="form-panel">
      <div class="field-grid">
        <label class="field-stack">${escapeAttr(t('Label'))}
          <input name="label" value="${escapeAttr(existing?.label ?? '')}" placeholder="${escapeAttr(t('e.g. Jenkins Production'))}" autocomplete="off">
          <span class="field-help">${escapeAttr(t('Optional display name. Defaults to the hostname if left blank.'))}</span>
        </label>
        <label class="field-stack">${escapeAttr(t('Controller URL'))}
          <input name="baseUrl" type="url" value="${escapeAttr(existing?.baseUrl ?? '')}" placeholder="http://jenkins.example.com:8080" required autocomplete="off">
          <span class="field-help">${escapeAttr(t('Root URL of the Jenkins controller, including any prefix path (e.g. /jenkins).'))}</span>
        </label>
      </div>
    </div>
    <div class="form-panel">
      <div class="field-grid">
        <label class="field-stack field-wide">${escapeAttr(t('Authentication'))}
          <select id="authMode" name="authMode">
            ${renderAuthOptions(authMode)}
          </select>
        </label>
        <label class="field-stack auth-user-field">${escapeAttr(t('Username'))}
          <input name="username" value="${escapeAttr(existing?.username ?? '')}" autocomplete="off">
        </label>
        <label class="field-stack auth-api-token-field">${escapeAttr(t('API Token'))}
          <input name="apiToken" type="password" autocomplete="new-password">
          <span class="field-help">${escapeAttr(
            hasStoredApiToken
              ? t('Leave blank to keep the saved API token.')
              : t('Created under Jenkins → User profile → Configure → API Token.')
          )}</span>
        </label>
        <label class="field-stack auth-password-field">${escapeAttr(t('Password'))}
          <input name="password" type="password" autocomplete="new-password">
          <span class="field-help">${escapeAttr(
            hasStoredPassword
              ? t('Leave blank to keep the saved password.')
              : t('User account password. API Token is recommended instead.')
          )}</span>
        </label>
      </div>
    </div>
    <div class="form-panel">
      <div class="toggle-grid">
        <label class="toggle-row" for="verifyTls">
          <span class="toggle-copy">
            <span class="toggle-title">${escapeAttr(t('Verify TLS certificate'))}</span>
            <span class="field-help">${escapeAttr(t('Validates controller TLS certificate with TOFU trust support.'))}</span>
          </span>
          <input id="verifyTls" name="verifyTls" type="checkbox"${verifyTlsChecked ? ' checked' : ''}>
        </label>
        <label class="toggle-row" for="readOnly">
          <span class="toggle-copy">
            <span class="toggle-title">${escapeAttr(t('Read-only controller'))}</span>
            <span class="field-help">${escapeAttr(t('Blocks triggering builds, stopping builds, and modifying pipeline scripts.'))}</span>
          </span>
          <input id="readOnly" name="readOnly" type="checkbox"${existing?.readOnly ? ' checked' : ''}>
        </label>
        <label class="toggle-row" for="allowBackgroundAccess">
          <span class="toggle-copy">
            <span class="toggle-title">${escapeAttr(t('Allow Agent background access'))}</span>
            <span class="field-help">${escapeAttr(t('Lets Agents query jobs and logs over MCP even when no panel is open.'))}</span>
          </span>
          <input id="allowBackgroundAccess" name="allowBackgroundAccess" type="checkbox"${
            existing?.allowBackgroundAccess ? ' checked' : ''
          }>
        </label>
      </div>
    </div>
    <footer class="form-footer">
      <div class="form-feedback">
        <div id="form-error" class="form-error" role="status" aria-live="polite"></div>
        <div id="testStatus" class="test-status" role="status" aria-live="polite"></div>
      </div>
      <div class="form-actions">
        <button id="testConnectionButton" class="secondary-action" type="button">${escapeAttr(t('Test Connection'))}</button>
        <button id="submitButton" class="primary-action" type="submit">
          <span id="submitLabel">${escapeAttr(submitLabel)}</span>
        </button>
      </div>
    </footer>
  </form>
</main>`;

  return {
    body,
    data: {
      atJenkinsStrings: buildWebviewStrings({
        submit: existing ? 'Save Controller' : 'Add Controller',
        saving: 'Saving...',
        testConnection: 'Test Connection',
        testing: 'Testing connection...',
        unknownError: 'Something went wrong.'
      })
    }
  };
}

const AUTH_MODE_LABELS: Record<JenkinsAuthMode, string> = {
  none: 'No authentication',
  apiToken: 'API Token (recommended)',
  password: 'Username and Password'
};

function renderAuthOptions(selected: JenkinsAuthMode): string {
  return JENKINS_AUTH_MODES.map(
    (mode) =>
      `<option value="${mode}"${mode === selected ? ' selected' : ''}>${escapeAttr(t(AUTH_MODE_LABELS[mode]))}</option>`
  ).join('\n            ');
}

function renderedAuthMode(existing: JenkinsInstanceConfig | undefined): JenkinsAuthMode {
  const stored = existing?.authMode;
  return JENKINS_AUTH_MODES.find((mode) => mode === stored) ?? 'none';
}

function instanceFormTitle(existing: JenkinsInstanceConfig | undefined): string {
  return existing
    ? t('Edit Jenkins Controller: {label}', { label: existing.label })
    : t('Add Jenkins Controller');
}

function isValidJenkinsUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function messageType(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const { type } = message as { type?: unknown };
  return typeof type === 'string' ? type : undefined;
}

async function postError(panel: Pick<vscode.WebviewPanel, 'webview'>, message: string): Promise<void> {
  await post(panel, { type: 'error', payload: message });
}

async function post(panel: Pick<vscode.WebviewPanel, 'webview'>, message: unknown): Promise<void> {
  try {
    await panel.webview.postMessage(message);
  } catch {
    // The panel is gone.
  }
}
