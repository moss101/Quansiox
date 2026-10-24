'use strict';
/* Parity (P1.5): boot shell + pre-theme + CSP scheme map.
 *
 * 1. The pre-boot splash exists (template + synchronous insertion) and the
 *    app removes it on mount.
 * 2. The pre-theme transparent rule (Grok's :root:not([data-theme]) trick)
 *    is present in the component stylesheet.
 * 3. The CSP/scheme parity map exists and covers all seven Grok schemes —
 *    the mapping cannot silently rot.
 * 4. The renderer CSP keeps its strict shape (self-only, no remote origins,
 *    no unsafe-eval) — parity never weakens security.
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const results = [];
const checks = [];
function check(name, fn) { checks.push([name, fn]); }
async function run() {
  for (const [name, fn] of checks) {
    try {
      await fn();
      results.push(`  ok   ${name}`);
    } catch (error) {
      results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
      process.exitCode = 1;
    }
  }
}

check('the boot shell ships: pure-JS splash, synchronous insert, mount-time removal', () => {
  const boot = read('src/renderer/boot-shell.js');
  assert.match(boot, /id = 'qx-boot-shell'/, 'splash element id');
  assert.match(boot, /document\.body\.appendChild\(shell\)/, 'synchronous body insertion');
  assert.ok(!boot.includes('<template'), 'must be pure JS — a .js file cannot carry HTML markup');
  const html = read('src/renderer/index.html');
  assert.match(html, /boot-shell\.js/, 'index.html loads the boot shell');
  const app = read('src/renderer-src/main.jsx');
  assert.match(app, /qx-boot-shell'\)\?\.remove\(\)/, 'the app removes the splash on mount');
  const css = read('src/renderer/styles.css');
  assert.match(css, /#qx-boot-shell\s*{/, 'splash styles');
});

check('the pre-theme transparent rule is present (Grok :root:not([data-theme]) trick)', () => {
  const css = read('src/renderer/styles.css');
  assert.match(css, /:root:not\(\[data-theme\]\)\s*{[^}]*background:\s*transparent/, 'transparent before the theme lands');
});

check('the CSP scheme map covers every Grok scheme with a named equivalent or status', () => {
  const map = read('docs/csp-scheme-parity.md');
  for (const scheme of ['sand-media:', 'sand-avatar:', 'sand-favicon:', 'sand-html-preview:', 'sand-canvas:', 'sand-mcp-app:', 'sand-visualization:']) {
    assert.ok(map.includes(scheme), `${scheme} missing from the map`);
  }
  assert.match(map, /qx-artifact/, 'quansiox equivalent named');
});

check('the renderer CSP stays strict — parity never weakens it', () => {
  const html = read('src/renderer/index.html');
  const csp = /Content-Security-Policy"\s*content="([^"]+)"/.exec(html)?.[1] ?? '';
  assert.ok(csp.includes("default-src 'self'"), 'default-src self');
  assert.ok(!csp.includes('unsafe-eval'), 'no unsafe-eval');
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+/i.test(csp.replace(/ws:\/\//g, 'wss://')), 'no remote origins');
  assert.ok(csp.includes('ws://127.0.0.1:*'), 'loopback ws for session bridges');
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-bootshell FAILED');
    process.exit(1);
  }
  console.log(`\nparity bootshell: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — splash, pre-theme rule, CSP scheme map, strict CSP`);
})();
