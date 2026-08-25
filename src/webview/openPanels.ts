import * as vscode from 'vscode';

/**
 * Tracks every Webview panel this extension has open, keyed by what it is showing.
 */
const openPanels = new Map<string, vscode.WebviewPanel>();

/**
 * Returns the panel for this key, created if there is none and revealed if there is.
 * Answers `undefined` when it revealed an existing one.
 */
export function openOrRevealPanel(key: string, create: () => vscode.WebviewPanel): vscode.WebviewPanel | undefined {
  const existing = openPanels.get(key);
  if (existing) {
    existing.reveal();
    return undefined;
  }
  const panel = create();
  openPanels.set(key, panel);
  panel.onDidDispose(() => {
    if (openPanels.get(key) === panel) {
      openPanels.delete(key);
    }
  });
  return panel;
}

/**
 * Closes every panel still open, for `deactivate`.
 */
export function disposeOpenPanels(): void {
  const panels = [...openPanels.values()];
  openPanels.clear();
  for (const panel of panels) {
    panel.dispose();
  }
}

/**
 * Generates a panel key for tracking.
 */
export function panelKey(kind: string, ...parts: string[]): string {
  return `${kind}:${parts.map(encodeURIComponent).join(':')}`;
}
