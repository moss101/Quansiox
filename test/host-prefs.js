'use strict';
/* Host preferences test — pinned agents + sidebar sections. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-host-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const pref = require('../src/main/services/hostPrefsService').hostPrefsService;

// ---- pinned ----
assert.deepStrictEqual(pref.getPinned(), []);
pref.pin('s1'); pref.pin('s2'); pref.pin('s1'); // dedupe
assert.deepStrictEqual(pref.getPinned(), ['s1', 's2']);
assert.deepStrictEqual(pref.setPinned(['a', 'b', 'a']), ['a', 'b'], 'setPinned dedupes');
pref.unpin('a');
assert.deepStrictEqual(pref.getPinned(), ['b']);
assert.throws(() => pref.pin('bad id!'), /invalid id/);
assert.throws(() => pref.setPinned('notanarray'.length > 64 ? [] : Array(51).fill(0).map((_, i) => `s${i}`)), /too many pinned/);
assert.strictEqual(fs.statSync(path.join(tmp, 'host-prefs.json')).mode & 0o777, 0o600, '0600');

// ---- sections: defaults all-on, override wins ----
const def = pref.sections();
assert.strictEqual(def.computer, true); assert.strictEqual(def.subagents, true);
pref.setSections({ subagents: false, customPanel: true });
const after = pref.sections();
assert.strictEqual(after.subagents, false, 'override wins');
assert.strictEqual(after.computer, true, 'other defaults intact');
assert.strictEqual(after.customPanel, true, 'unknown section accepted (forward-compatible)');
pref.toggleSection('computer', false);
assert.strictEqual(pref.sections().computer, false, 'toggleSection');
assert.throws(() => pref.setSections({ 'bad name!': true }), /invalid section/);
assert.throws(() => pref.setSections('nope'), /must be an object/);

// ---- compat surface ----
(async () => {
  const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
  let env = await grokCompatService.dispatch('setHostPinnedAgents', { ids: ['x1', 'x2'] });
  assert.strictEqual(env.status, 'ok'); assert.deepStrictEqual(env.pinned, ['x1', 'x2']);
  env = await grokCompatService.dispatch('getHostPinnedAgents', {});
  assert.deepStrictEqual(env.pinned, ['x1', 'x2']);
  env = await grokCompatService.dispatch('setHostSidebarSections', { sections: { computer: false } });
  assert.strictEqual(env.sections.computer, false);
  env = await grokCompatService.dispatch('getHostSidebarSections', {});
  assert.strictEqual(env.sections.computer, false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('host-prefs test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
