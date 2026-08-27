import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { escapeAttr, renderJsonScript, renderWebviewHtml } from '../../src/webview/html';

function fakeWebview(cspSource = 'https://webview.example'): vscode.Webview {
  return {
    cspSource,
    asWebviewUri: (uri: vscode.Uri) => uri
  } as vscode.Webview;
}

describe('webview HTML helpers', () => {
  it('emits a strict CSP with the minted nonce and no unsafe-inline styles', () => {
    const html = renderWebviewHtml(
      fakeWebview(),
      { script: vscode.Uri.file('/tmp/index.js'), style: vscode.Uri.file('/tmp/index.css') },
      '<p class="ok">hi</p>',
      { payload: { hello: 'world' } }
    );

    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/script-src https:\/\/webview\.example 'nonce-[A-Za-z0-9_-]+'/);
    expect(html).toContain('style-src https://webview.example');
    expect(html).not.toContain("'unsafe-inline'");
    expect(html).toMatch(/<script nonce="[A-Za-z0-9_-]+" src="/);
  });

  it('escapes JSON so a payload cannot break out of the script block', () => {
    const html = renderJsonScript(
      'atJenkinsStrings',
      { x: '</script><script>alert(1)</script>', y: '<img src=x>' },
      'abc+nonce'
    );
    const inner = html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    expect(inner).not.toContain('<');
    expect(inner).toContain('\\u003c/script>');
    expect(inner).not.toMatch(/<\/script>/i);
    expect(html).toContain('id="atJenkinsStrings"');
    expect(html).toContain('nonce="abc+nonce"');
  });

  it('escapes all five HTML attribute metacharacters', () => {
    expect(escapeAttr(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
