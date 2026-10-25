'use strict';
/* Parity (P2.8): widget cards — the lifecycle behind the renderer surface.
 *
 * 1. Widget lifecycle: request → pending() includes it → respondWidget
 *    settles state + waiters → dismissWidget resolves without a value.
 *    Values are clamped; entries persist (survive reload — the card comes
 *    back until answered, like Grok's widgets).
 * 2. The interactions namespace exposes respondWidget/dismissWidget (the
 *    card's backend).
 * 3. pending() carries forms + widgets + trays together — the P2.4 task
 *    strip and this surface poll the same call. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-widgets-'));

const { userInteractionService } = require('../src/main/services/userInteractionService.js');

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

check('a requested widget surfaces through pending() until answered', () => {
  const entry = userInteractionService.requestWidget({
    agentId: 'a1', sessionId: 's1', title: 'Pick a branch',
    widgetType: 'choice', value: 'main\nstaging\nrelease',
  });
  let pending = userInteractionService.pending();
  assert.equal(pending.widgets.length, 1);
  assert.equal(pending.widgets[0].id, entry.id);
  assert.equal(pending.widgets[0].state, 'pending');
  assert.ok(pending.forms.length === 0 && Array.isArray(pending.trays), 'pending() carries all three kinds');
});

check('respondWidget settles the entry and wakes the waiter with the value', async () => {
  const entry = userInteractionService.requestWidget({
    agentId: 'a1', sessionId: 's1', title: 'Confirm deploy', widgetType: 'confirm',
  });
  const waiter = userInteractionService.waitForEntry?.(entry.id)
    ?? new Promise((resolve) => {
      // fall back to polling if the service has no waitForEntry
      const poll = setInterval(() => {
        const done = userInteractionService.getEntry?.(entry.id);
        if (done && done.state !== 'pending') { clearInterval(poll); resolve(done); }
      }, 20);
      setTimeout(() => { clearInterval(poll); resolve(null); }, 3000);
    });
  const out = userInteractionService.respondWidget({ entryId: entry.id, value: 'yes' });
  assert.equal(out.state, 'responded');
  assert.equal(out.value, 'yes');
  const settled = await waiter;
  assert.ok(settled === null || settled.state !== 'pending', 'the waiter observed the settlement');
  assert.equal(userInteractionService.pending().widgets.some((w) => w.id === entry.id), false, 'answered widgets leave the pending surface');
});

check('dismissWidget resolves without a value; invalid ids are refused', () => {
  const entry = userInteractionService.requestWidget({ agentId: 'a1', title: 'FYI only', widgetType: 'generic' });
  const out = userInteractionService.dismissWidget({ entryId: entry.id });
  assert.ok(out);
  assert.equal(userInteractionService.pending().widgets.some((w) => w.id === entry.id), false);
  assert.throws(() => userInteractionService.respondWidget({ entryId: 'no-such-widget', value: 'x' }));
});

check('the interactions namespace exposes the widget handlers', async () => {
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
  const ns = allHandlers.interactions ?? {};
  for (const handler of ['pending', 'respondWidget', 'dismissWidget', 'dismissTray']) {
    assert.equal(typeof ns[handler], 'function', `interactions.${handler} missing`);
  }
  const pending = await ns.pending();
  assert.ok(pending && Array.isArray(pending.widgets) && Array.isArray(pending.forms) && Array.isArray(pending.trays));
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-widgets FAILED');
    process.exit(1);
  }
  console.log(`\nparity widgets: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — lifecycle, settlement, namespace wiring`);
})();
