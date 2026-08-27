import * as vscode from 'vscode';
import { createNonce } from '../utils/nonce';

export interface WebviewAsset {
  script: vscode.Uri;
  style?: vscode.Uri;
}

/**
 * Wraps a body in the document every Webview in this extension gets: a strict
 * CSP, a nonce minted here, and the bundle that drives the page.
 */
export function renderWebviewHtml(
  webview: vscode.Webview,
  asset: WebviewAsset,
  body: string,
  data: Readonly<Record<string, unknown>> = {}
): string {
  const nonce = createNonce();
  const styleTag = asset.style ? `<link rel="stylesheet" href="${webview.asWebviewUri(asset.style)}">` : '';
  const dataTags = Object.entries(data)
    .map(([id, value]) => `\n  ${renderJsonScript(id, value, nonce)}`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource}; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${styleTag}
</head>
<body>
  ${body}${dataTags}
  <script nonce="${nonce}" src="${webview.asWebviewUri(asset.script)}"></script>
</body>
</html>`;
}

/**
 * A data block the page reads with `JSON.parse`, and the one place where
 * a value is serialized into a `<script>` element.
 */
export function renderJsonScript(id: string, value: unknown, nonce: string): string {
  const json = JSON.stringify(value) ?? 'null';
  return `<script type="application/json" id="${escapeAttr(id)}" nonce="${escapeAttr(nonce)}">${json.replaceAll('<', '\\u003c')}</script>`;
}

/**
 * Escapes a value for an HTML double-quoted attribute.
 */
export function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
