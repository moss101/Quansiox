'use strict';
/* Parity (P4.4 — the differentiator): privacy mode, enforced locally.
 *
 * 1. The run gate: off → allowed; on + cloud provider → REFUSED with an
 *    actionable reason; on + local provider (localhost baseUrl) → allowed.
 * 2. The toggle round-trips through settings (single source of truth).
 * 3. The namespace and the grokCompat method route to the same backend. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-privacy-'));

const { privacyService } = require('../src/main/services/privacyService.js');
const { settingsService } = require('../src/main/services/settingsService.js');

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

check('the gate: privacy off allows any provider', () => {
  const out = privacyService.gateRun({ privacyMode: false }, { hasLocalProvider: false });
  assert.deepEqual(out, { allowed: true });
  const unset = privacyService.gateRun({}, { hasLocalProvider: false });
  assert.equal(unset.allowed, true, 'missing flag reads as off');
});

check('the gate: privacy on refuses cloud providers with an actionable reason', () => {
  const out = privacyService.gateRun({ privacyMode: true }, { hasLocalProvider: false });
  assert.equal(out.allowed, false);
  assert.match(out.reason, /Privacy mode is on/);
  assert.match(out.reason, /local provider/i, 'the refusal says what to do');
});

check('the gate: local providers keep working under privacy mode', () => {
  const out = privacyService.gateRun({ privacyMode: true }, { hasLocalProvider: true });
  assert.equal(out.allowed, true);
  assert.match(out.note, /local provider only/);
});

check('the toggle round-trips through settings (the single source of truth)', () => {
  assert.equal(privacyService.isEnabled(), false, 'defaults off');
  assert.equal(privacyService.setEnabled(true), true);
  assert.equal(settingsService.load().privacyMode, true, 'the flag lives in settings');
  assert.equal(privacyService.isEnabled(), true);
  privacyService.setEnabled(false);
  assert.equal(privacyService.isEnabled(), false);
});

check('the coordinator gate sits in front of the API-key check', () => {
  const coord = fs.readFileSync(path.join(__dirname, '..', 'src', 'coordinator', 'index.js'), 'utf8');
  const gateAt = coord.indexOf('privacyService.gateRun');
  const keyAt = coord.indexOf('no API key configured');
  assert.ok(gateAt >= 0, 'the coordinator calls the gate');
  assert.ok(keyAt > gateAt, 'privacy is enforced BEFORE anything is prepared or sent');
});

check('the namespace and grokCompat route to the same backend', async () => {
  const Module = require('node:module');
  const stub = {
    app: { getPath: (k) => path.join(process.env.QUANSIOX_USER_DATA_DIR, k) },
    BrowserWindow: class { webContents = { on: () => {}, send: () => {} }; on() {} },
    ipcMain: { on: () => {}, handle: () => {} },
    webContents: {},
  };
  const orig = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return stub;
    return orig.call(this, request, parent, isMain);
  };
  try {
    require('../src/main/ipc/namespaces.js');
  } finally {
    Module._load = orig;
  }
  const { allHandlers } = require('../src/main/ipc/registry.js');
  const ns = allHandlers.privacy ?? {};
  assert.equal(typeof ns.get, 'function', 'privacy.get');
  assert.equal(typeof ns.set, 'function', 'privacy.set');
  assert.equal((await ns.get()).enabled, false);
  await ns.set({}, { enabled: true });
  assert.equal((await ns.get()).enabled, true);
  await ns.set({}, { enabled: false });

  const catalogText = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'services', 'grokCompat', 'catalog.js'), 'utf8');
  const entry = /"method": "getCursorPrivacyModeEnabled",[\s\S]*?"handler": "([^"]+)"/.exec(catalogText);
  assert.ok(entry, 'catalog entry');
  assert.equal(entry[1], 'privacy.get', 'the Grok-named method resolves to our backend');
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-privacy FAILED');
    process.exit(1);
  }
  console.log(`\nparity privacy: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — enforced gate, toggle round-trip, routing`);
})();
