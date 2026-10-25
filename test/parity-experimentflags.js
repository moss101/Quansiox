'use strict';
/* Parity (P3.15): Grok's experiment names are registered as documented
 * no-op-local defaults — every extracted grok_bot / sand flag resolves
 * locally with a truthful value, and nothing phones home. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-pflags-'));

const { flagsService } = require('../src/main/services/flagsService.js');

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

/** The experiment names found in the 0.75.0 extraction (case artifacts in
 * docs/parity). Every one must be registered. */
const EXTRACTED = [
  'grok_bot_canvas_design_mode',
  'grok_bot_glean_remote_mcp_setup_enabled',
  'grok_bot_library_external_docs',
  'grok_bot_library_hover_cards',
  'grok_bot_library_pages',
  'grok_bot_library_pins',
  'grok_bot_library_v2',
  'grok_bot_memory_import',
  'grok_bot_multiplayer',
  'grok_bot_pages_search',
  'grok_bot_team_bot_details_panel',
  'sand_enable_visualizations',
  'sand_mcp_apps',
  'sand_simplified_right_pane',
  'sand_area',
];

check('every extracted experiment name is a registered local default', () => {
  for (const name of EXTRACTED) {
    assert.ok(name in flagsService.DEFAULTS, `${name} missing from the defaults map`);
    assert.equal(typeof flagsService.DEFAULTS[name], 'boolean', `${name} must be boolean`);
  }
});

check('values are truthful: true only where the feature shipped here', () => {
  const shippedTrue = ['grok_bot_library_v2', 'grok_bot_library_pins', 'grok_bot_library_hover_cards'];
  for (const name of EXTRACTED) {
    const value = flagsService.evaluate(name, null);
    assert.equal(typeof value, 'boolean', `${name} resolves without a network fallback`);
    if (shippedTrue.includes(name)) assert.equal(value, true, `${name} shipped — must read true`);
    else assert.equal(value, false, `${name} not shipped — must read false`);
  }
});

check('the snapshot reports every experiment with its source', () => {
  const snap = flagsService.snapshot();
  const byName = Object.fromEntries((snap.flags ?? snap).map?.((f) => [f.name, f]) ?? []);
  for (const name of EXTRACTED) {
    const entry = Array.isArray(snap) ? snap.find((f) => f.name === name) : byName[name];
    assert.ok(entry, `${name} missing from the snapshot`);
    assert.equal(entry.source ?? 'default', 'default');
  }
});

check('local overrides still win over the documented defaults', () => {
  flagsService.override('sand_enable_visualizations', true);
  assert.equal(flagsService.evaluate('sand_enable_visualizations', false), true);
  flagsService.clearOverride('sand_enable_visualizations');
  assert.equal(flagsService.evaluate('sand_enable_visualizations', false), false);
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-experimentflags FAILED');
    process.exit(1);
  }
  console.log(`\nparity experimentflags: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — ${EXTRACTED.length} grok/sand experiment names registered as truthful local defaults`);
})();
