'use strict';
/* Parity (P2.4): the thread status surface derives correctly and is wired.
 *
 * 1. taskStatusModel.deriveChips — the chip derivation is pure and matches
 *    Grok's three always-visible facts (waiting / approval / running) plus
 *    the failure hint.
 * 2. asyncTaskService round-trip — the drawer's data source really persists
 *    and lists per-session, finished included.
 * 3. confirmations.list — the namespace handler exists and returns the
 *    redacted pending list (a restart can no longer orphan an approval).
 *
 * Electron-free (services are plain modules; the namespace check loads the
 * registry the same way test/ipc-verify does). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The services resolve storage through QUANSIOX_USER_DATA_DIR — isolate the
// store so this test can never touch the real user data.
process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-taskcards-'));

const { deriveChips, stepLabel } = require('../src/renderer-src/taskStatusModel.js');
const { asyncTaskService } = require('../src/main/services/asyncTaskService.js');
const { confirmationService } = require('../src/main/services/confirmationService.js');

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

check('empty state renders nothing', () => {
  const out = deriveChips({});
  assert.deepEqual(out.chips, []);
  assert.equal(out.runningCount, 0);
});

check('waiting chip counts forms + trays + widgets', () => {
  const out = deriveChips({ interactions: { forms: [{}, {}], trays: [{}], widgets: [] } });
  assert.equal(out.chips.length, 1);
  assert.equal(out.chips[0].kind, 'waiting');
  assert.equal(out.chips[0].count, 3);
  assert.equal(out.chips[0].label, 'Waiting on you · 3');
});

check('approval chip counts pending confirmations', () => {
  const out = deriveChips({ confirmations: [{ id: 'a' }] });
  assert.equal(out.chips[0].kind, 'approval');
  assert.equal(out.chips[0].label, 'Needs approval');
});

check('running chip shows the step label, progress and overflow count', () => {
  const tasks = [
    { status: 'running', title: 'Run command — npm test', progress: 0.4 },
    { status: 'running', title: 'Reading a file', progress: null },
    { status: 'queued', title: 'Compress exports' },
  ];
  const out = deriveChips({ tasks });
  const running = out.chips.find((c) => c.kind === 'running');
  assert.ok(running, 'running chip present');
  assert.equal(running.label, 'Run command · +2');
  assert.equal(running.progress, 0.4);
  assert.equal(out.runningCount, 3);
  assert.equal(stepLabel(tasks[0]), 'Run command');
});

check('failed tasks surface a failure chip and a finished hint', () => {
  const out = deriveChips({
    tasks: [
      { status: 'failed', title: 'x' },
      { status: 'succeeded', title: 'y' },
      { status: 'running', title: 'z' },
    ],
  });
  assert.equal(out.chips.find((c) => c.kind === 'failed').label, '1 task failed');
  assert.equal(out.finishedHint, '2 finished');
});

check('asyncTaskService round-trips through the store the drawer polls', async () => {
  const task = asyncTaskService.create({ sessionId: 's1', title: 'Run command — npm test' });
  asyncTaskService.update(task.id, { status: 'running', progress: 0.5, outputTail: 'ok\n' });
  const mine = asyncTaskService.list({ sessionId: 's1', includeFinished: true });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'running');
  assert.equal(mine[0].progress, 0.5);
  asyncTaskService.update(task.id, { status: 'succeeded' });
  assert.equal(asyncTaskService.active().length, 0, 'finished task must leave the active list');
  assert.equal(asyncTaskService.list({ sessionId: 's1' }).length, 1, 'finished task stays in the drawer list');
});

check('confirmations.list handler is registered and returns redacted pending entries', async () => {
  // Load the namespace registry the same way ipc-verify does (stubbed electron).
  const Module = require('node:module');
  const handlers = {};
  const stub = {
    app: { getPath: (k) => path.join(process.env.QUANSIOX_USER_DATA_DIR, k) },
    BrowserWindow: class { webContents = { on: () => {}, send: () => {} }; on() {} },
    ipcMain: { on: (ch, fn) => { handlers[ch] = fn; }, handle: (ch, fn) => { handlers[ch] = fn; } },
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
  const confirmationsHandlers = allHandlers.confirmations ?? {};
  assert.equal(typeof confirmationsHandlers.list, 'function', 'confirmations.list handler missing');

  // The handler returns the pending list with no resolvers leaked.
  const { id: cfmId, promise } = confirmationService.request(
    's1', 'shell', { command: 'npm test' }, null, 60_000,
    { tool: 'shell', target: 'npm test', argsPreview: { command: 'npm test' } },
  );
  const list = await confirmationsHandlers.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].tool, 'shell');
  assert.equal(typeof list[0].request, 'object');
  assert.ok(!('resolve' in list[0] && list[0].resolve), 'resolvers must not cross the bridge');
  await confirmationService.respond(cfmId, false);
  const settled = await promise;
  assert.equal(settled, false, 'fail-closed denial resolves the request');
  assert.equal((await confirmationsHandlers.list()).length, 0);
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-taskcards FAILED');
    process.exit(1);
  }
  console.log(`\nparity taskcards: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — thread status derives + is wired`);
})();
