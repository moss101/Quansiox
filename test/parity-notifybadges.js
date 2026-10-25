'use strict';
/* Parity (P3.10): per-agent notify-on-updates.
 *
 * 1. The session flag round-trips (default true; false silences OS
 *    notifications but never the unread dots).
 * 2. The grokCompat method setAgentNotifyOnUpdates routes to the per-agent
 *    backend (a real local handler, not the global settings toggle).
 * 3. The notify decision model: offscreen + not muted + notifyOnUpdates. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-notifybadges-'));

const { sessionService } = require('../src/main/services/sessionService.js');

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

/** The renderer attention hook's decision, extracted as a pure function. */
function shouldNotify({ offscreen, focused, muted, notifyOnUpdates }) {
  return offscreen && !focused && !muted && notifyOnUpdates !== false;
}

check('the session flag defaults to true and round-trips both ways', () => {
  const sid = sessionService.create({ id: 'notify-parity' }).id;
  assert.equal(sessionService.list().find((s) => s.id === sid).notifyOnUpdates, true, 'defaults to true');
  sessionService.update(sid, { notifyOnUpdates: false });
  assert.equal(sessionService.list().find((s) => s.id === sid).notifyOnUpdates, false);
  sessionService.update(sid, { notifyOnUpdates: true });
  assert.equal(sessionService.list().find((s) => s.id === sid).notifyOnUpdates, true);
});

check('silencing notifications does not touch the mute flag (unread dots live on)', () => {
  const sid = sessionService.create({ id: 'notify-parity-2' }).id;
  sessionService.update(sid, { notifyOnUpdates: false });
  const row = sessionService.list().find((s) => s.id === sid);
  assert.equal(row.notifyOnUpdates, false);
  assert.equal(row.muted, false, 'notify-off is not a mute');
});

check('the notify decision: offscreen + focused-window + not muted + notifyOnUpdates', () => {
  const base = { offscreen: true, focused: false, muted: false, notifyOnUpdates: true };
  assert.equal(shouldNotify(base), true);
  assert.equal(shouldNotify({ ...base, notifyOnUpdates: false }), false, 'opted-out agents never notify');
  assert.equal(shouldNotify({ ...base, muted: true }), false);
  assert.equal(shouldNotify({ ...base, focused: true }), false, 'the window is focused — no toast needed');
  assert.equal(shouldNotify({ ...base, offscreen: false }), false);
  assert.equal(shouldNotify({ ...base, notifyOnUpdates: undefined }), true, 'missing flag reads as true');
});

check('grokCompat routes setAgentNotifyOnUpdates to the per-agent backend', async () => {
  const catalogText = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'services', 'grokCompat', 'catalog.js'), 'utf8');
  const entry = /"method": "setAgentNotifyOnUpdates",[\s\S]*?"handler": "([^"]+)"/.exec(catalogText);
  assert.ok(entry, 'catalog entry exists');
  assert.equal(entry[1], 'agent.setAgentNotifyOnUpdates', 'routes to the per-agent handler, not the global toggle');

  const { HANDLERS: handlers } = require('../src/main/services/grokCompat/handlers.js');
  const handler = handlers['agent.setAgentNotifyOnUpdates'];
  assert.equal(typeof handler, 'function', 'the per-agent handler exists');

  const sid = sessionService.create({ id: 'notify-parity-3' }).id;
  const out = await handler({ agentId: sid, value: false });
  assert.equal(out.notifyOnUpdates, false);
  assert.equal(sessionService.list().find((s) => s.id === sid).notifyOnUpdates, false, 'the session flag was written');
  await handler({ agentId: sid, enabled: true });
  assert.equal(sessionService.list().find((s) => s.id === sid).notifyOnUpdates, true);
  await assert.rejects(() => handler({}), /agentId/);
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-notifybadges FAILED');
    process.exit(1);
  }
  console.log(`\nparity notifybadges: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — per-agent flag, decision model, grokCompat routing`);
})();
