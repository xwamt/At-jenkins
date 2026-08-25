/**
 * Webview client script for JenkinsInstancePanel.
 */

type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

interface FormStrings {
  submit: string;
  saving: string;
  testConnection: string;
  testing: string;
  unknownError: string;
}

const FALLBACK_STRINGS: FormStrings = {
  submit: 'Save Controller',
  saving: 'Saving...',
  testConnection: 'Test Connection',
  testing: 'Testing connection...',
  unknownError: 'Something went wrong.'
};

const vscode = acquireVsCodeApi();
const strings = readStrings();
const form = document.querySelector<HTMLFormElement>('#instance-form');
const authMode = document.querySelector<HTMLSelectElement>('#authMode');
const formError = document.querySelector<HTMLElement>('#form-error');
const testStatus = document.querySelector<HTMLElement>('#testStatus');
const testConnectionButton = document.querySelector<HTMLButtonElement>('#testConnectionButton');
const submitButton = document.querySelector<HTMLButtonElement>('#submitButton');
const submitLabel = document.querySelector<HTMLElement>('#submitLabel');

function readStrings(): FormStrings {
  const block = document.getElementById('atJenkinsStrings');
  if (!block?.textContent) {
    return FALLBACK_STRINGS;
  }
  try {
    return { ...FALLBACK_STRINGS, ...(JSON.parse(block.textContent) as Partial<FormStrings>) };
  } catch {
    return FALLBACK_STRINGS;
  }
}

function field(name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  const element = form?.elements.namedItem(name);
  return element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
    ? element
    : null;
}

function readValue(name: string): string {
  return field(name)?.value ?? '';
}

function isChecked(name: string): boolean {
  const element = field(name);
  return element instanceof HTMLInputElement && element.checked;
}

function payloadFromForm(): Record<string, unknown> {
  return {
    label: readValue('label'),
    baseUrl: readValue('baseUrl'),
    authMode: readValue('authMode'),
    username: readValue('username'),
    apiToken: readValue('apiToken'),
    password: readValue('password'),
    verifyTls: isChecked('verifyTls'),
    readOnly: isChecked('readOnly'),
    allowBackgroundAccess: isChecked('allowBackgroundAccess')
  };
}

function setError(message: string): void {
  if (formError) {
    formError.textContent = message;
  }
}

function setTestStatus(message: string, state?: 'success' | 'error'): void {
  if (!testStatus) {
    return;
  }
  testStatus.textContent = message;
  testStatus.classList.toggle('is-success', state === 'success');
  testStatus.classList.toggle('is-error', state === 'error');
}

function setSaving(isSaving: boolean): void {
  submitButton?.toggleAttribute('disabled', isSaving);
  if (submitLabel) {
    submitLabel.textContent = isSaving ? strings.saving : strings.submit;
  }
}

function setTesting(isTesting: boolean): void {
  testConnectionButton?.toggleAttribute('disabled', isTesting);
  if (testConnectionButton) {
    testConnectionButton.textContent = isTesting ? strings.testing : strings.testConnection;
  }
}

function applyAuthMode(mode: string): void {
  if (!form || !authMode) {
    return;
  }
  for (const option of Array.from(authMode.options)) {
    form.classList.toggle(`auth-mode-${option.value}`, option.value === mode);
  }
}

authMode?.addEventListener('change', () => {
  applyAuthMode(authMode.value);
});

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  setError('');
  setSaving(true);
  vscode.postMessage({ type: 'submit', payload: payloadFromForm() });
});

testConnectionButton?.addEventListener('click', () => {
  setError('');
  setTestStatus(strings.testing);
  setTesting(true);
  vscode.postMessage({ type: 'testConnection', payload: payloadFromForm() });
});

window.addEventListener('message', (event: MessageEvent<{ type?: string; payload?: unknown }>) => {
  const message = event.data;
  if (message.type === 'error') {
    setSaving(false);
    setError(typeof message.payload === 'string' ? message.payload : strings.unknownError);
    return;
  }
  if (message.type === 'connectionTestResult') {
    setTesting(false);
    const payload = (message.payload ?? {}) as { ok?: boolean; message?: string };
    setTestStatus(payload.message ?? strings.unknownError, payload.ok ? 'success' : 'error');
  }
});

export {};
