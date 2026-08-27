import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

function copyHub() {
  try {
    const req = createRequire(import.meta.url);
    const hubEntry = req.resolve('@at-series/mcp-hub/hub');
    const hubPkgPath = join(dirname(hubEntry), '..', 'package.json');
    const hubPkg = JSON.parse(readFileSync(hubPkgPath, 'utf8'));
    const { AT_SERIES_HUB_PROTOCOL_VERSION } = req('@at-series/mcp-hub');

    mkdirSync('dist', { recursive: true });
    copyFileSync(hubEntry, join('dist', 'hub.js'));
    writeFileSync(
      join('dist', 'hub-version.json'),
      `${JSON.stringify(
        {
          version: hubPkg.version,
          protocolVersion: AT_SERIES_HUB_PROTOCOL_VERSION
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  } catch (err) {
    console.warn('Could not copy hub bundle to dist:', err);
  }
}

copyHub();

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  // No production sourcemaps: .vscodeignore strips **/*.map and would leave dangling references.
  sourcemap: watch,
  minify: !watch
};

const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode']
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/jenkins-instance-form/index.ts'],
    outfile: 'dist/webview/jenkins-instance-form.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114'
  })
];

const contexts = await Promise.all(contextConfigs);
if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}

