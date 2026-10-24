'use strict';
/* Feature-flag test — local device flags + experiment overrides. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-flags-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const flags = require('../src/main/services/flagsService').flagsService;

// ---- defaults + evaluate ----
assert.strictEqual(flags.evaluate('nestedDelegation'), true);
assert.strictEqual(flags.evaluate('unifiedComputerRuntime'), false);
assert.strictEqual(flags.evaluate('unknownFlag', 'fb'), 'fb', 'unknown flag falls back');
assert.strictEqual(flags.evaluate('bad-name!', 'x'), 'x', 'invalid name falls back');

// ---- overrides win, persisted 0600 ----
const snap0 = flags.snapshot();
assert.ok(snap0.flags.some((f) => f.name === 'nestedDelegation' && f.value === true && f.source === 'default'));
flags.override('nestedDelegation', false);
assert.strictEqual(flags.evaluate('nestedDelegation'), false, 'override wins');
assert.strictEqual(flags.evaluate('unifiedComputerRuntime'), false, 'other flags unaffected');
const snap1 = flags.snapshot();
const overridden = snap1.flags.find((f) => f.name === 'nestedDelegation');
assert.strictEqual(overridden.source, 'override');
assert.strictEqual(overridden.hasOverride, true);
assert.strictEqual(snap1.overrides, 1);
assert.strictEqual(fs.statSync(path.join(tmp, 'flags.json')).mode & 0o777, 0o600, 'flags.json is 0600');

// custom flag via override
flags.override('my-beta', true);
assert.strictEqual(flags.evaluate('my-beta'), true);
assert.ok(flags.snapshot().flags.some((f) => f.name === 'my-beta' && f.source === 'override'));

// ---- refresh re-reads from disk ----
flags.override('refreshed-flag', true);
fs.writeFileSync(path.join(tmp, 'flags.json'), JSON.stringify({ nestedDelegation: true }, null, 2));
assert.strictEqual(flags.evaluate('nestedDelegation'), true, 'fresh read after external change');
assert.strictEqual(flags.refresh().flags.length >= 1, true);

// ---- clear override reverts to default ----
flags.clearOverride('nestedDelegation');
assert.strictEqual(flags.evaluate('nestedDelegation'), true, 'cleared → back to default');
assert.throws(() => flags.override('bad name!', true), /invalid flag name/);

// ---- Grok compat surface ----
(async () => {
  const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
  let env = await grokCompatService.dispatch('getExperimentsSnapshot', {});
  assert.strictEqual(env.status, 'ok'); assert.ok(Array.isArray(env.flags) && env.flags.length >= 5);
  env = await grokCompatService.dispatch('applyFeatureFlagOverride', { flag: 'nestedDelegation', value: false });
  assert.strictEqual(env.status, 'ok'); assert.strictEqual(env.value, false);
  env = await grokCompatService.dispatch('exposeFeatureGate', { flag: 'nestedDelegation' });
  assert.strictEqual(env.value, false, 'override applied through the surface');
  env = await grokCompatService.dispatch('applyExperimentOverride', { flag: 'nestedDelegation', value: true });
  assert.strictEqual(env.value, true);
  env = await grokCompatService.dispatch('refreshFeatureFlags', {});
  assert.strictEqual(env.status, 'ok'); assert.ok(Array.isArray(env.flags));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('flags test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
