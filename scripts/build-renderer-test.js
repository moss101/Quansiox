#!/usr/bin/env node
'use strict';
/**
 * Build the renderer bundle the component tests import.
 *
 * The renderer sources are JSX, which Node cannot import directly, so the
 * testable components are bundled with esbuild — the same bundler the app
 * itself is built with. React stays external so the test and the components
 * share one React instance.
 */
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', '.build');
const ENTRY = path.join(ROOT, 'test', 'renderer-test-entry.js');

const entry = `// Generated: the components the renderer tests exercise.
export { Card } from '../src/renderer-src/cards/Cards.jsx';
export { DiffView, parseDiff } from '../src/renderer-src/DiffView.jsx';
export * from '../src/renderer-src/cards/registry.js';
`;

async function build() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(ENTRY, entry);
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outfile: path.join(OUT, 'renderer-test.mjs'),
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    jsx: 'automatic',
    logLevel: 'error',
  });
  return path.join(OUT, 'renderer-test.mjs');
}

if (require.main === module) {
  build()
    .then((file) => console.log(`renderer test bundle → ${path.relative(ROOT, file)}`))
    .catch((error) => { console.error(error.message ?? error); process.exit(1); });
}

module.exports = { build };
