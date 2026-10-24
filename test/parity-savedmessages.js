'use strict';
/* Parity (P2.4 remainder): saved messages — the library store, its IPC
 * namespace, and the view model.
 *
 * 1. savedMessagesService — save/list/remove/clear with one-save-per-message
 *    semantics (re-save refreshes, never duplicates), snapshot capture, and
 *    a bounded library.
 * 2. The savedMessages namespace handlers are registered and route to the
 *    service (the renderer's Save action and Library dialog poll these).
 * 3. savedMessagesModel — grouping by session (newest-saved first), snippet
 *    clamping, group labels.
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-saved-'));

const { savedMessagesService } = require('../src/main/services/savedMessagesService.js');
const model = require('../src/renderer-src/savedMessagesModel.js');

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

check('save → list newest-first; re-save refreshes instead of duplicating', () => {
  savedMessagesService.clear();
  const a = savedMessagesService.save({ sessionId: 's1', messageId: 'm1', text: 'first saved message', kind: 'user' });
  savedMessagesService.save({ sessionId: 's2', messageId: 'm2', text: 'second saved message', kind: 'assistant', author: 'Quansiox' });
  let rows = savedMessagesService.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].messageId, 'm2', 'newest saved first');

  const refreshed = savedMessagesService.save({ sessionId: 's1', messageId: 'm1', text: 'first saved message (edited later)' });
  rows = savedMessagesService.list();
  assert.equal(rows.length, 2, 're-save must not duplicate');
  assert.equal(rows.find((r) => r.messageId === 'm1').text, 'first saved message (edited later)');
  assert.ok(refreshed.bumpedAt >= refreshed.savedAt, 'bump timestamp advances');
  assert.equal(rows.find((r) => r.messageId === 'm1').messageId, 'm1');
});

check('the library keeps a snapshot — rollback of the session cannot empty it', () => {
  savedMessagesService.clear();
  savedMessagesService.save({ sessionId: 's1', messageId: 'm1', text: 'keep this even if the session is rolled back' });
  const rows = savedMessagesService.list();
  assert.equal(rows[0].text, 'keep this even if the session is rolled back');
});

check('remove and clear are explicit; isSaved tracks membership', () => {
  savedMessagesService.clear();
  savedMessagesService.save({ sessionId: 's1', messageId: 'm1', text: 'x' });
  savedMessagesService.save({ sessionId: 's1', messageId: 'm2', text: 'y' });
  assert.equal(savedMessagesService.isSaved('m1'), true);
  const { removed } = savedMessagesService.remove('m1');
  assert.equal(removed, 1);
  assert.equal(savedMessagesService.isSaved('m1'), false);
  assert.equal(savedMessagesService.list().length, 1);
  savedMessagesService.clear();
  assert.equal(savedMessagesService.list().length, 0);
});

check('the library is bounded', () => {
  savedMessagesService.clear();
  for (let i = 0; i < savedMessagesService.MAX_SAVED + 10; i += 1) {
    savedMessagesService.save({ sessionId: 's1', messageId: `m${i}`, text: `entry ${i}` });
  }
  assert.equal(savedMessagesService.list().length, savedMessagesService.MAX_SAVED);
  savedMessagesService.clear();
});

check('empty and invalid saves are refused', () => {
  savedMessagesService.clear();
  assert.throws(() => savedMessagesService.save({ messageId: 'm1', text: '   ' }), /empty/);
  assert.throws(() => savedMessagesService.save({ text: 'no id' }), /messageId/);
  assert.equal(savedMessagesService.list().length, 0);
});

check('the namespace handlers are registered and route to the service', async () => {
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
  const ns = allHandlers.savedMessages ?? {};
  for (const handler of ['list', 'save', 'remove', 'clear', 'isSaved']) {
    assert.equal(typeof ns[handler], 'function', `savedMessages.${handler} handler missing`);
  }
  await ns.save({}, { sessionId: 's1', messageId: 'via-ipc', text: 'saved through the namespace' });
  const rows = await ns.list();
  assert.equal(rows.some((r) => r.messageId === 'via-ipc'), true);
  assert.equal((await ns.isSaved({}, { messageId: 'via-ipc' })).saved, true);
  const { removed } = await ns.remove({}, { messageId: 'via-ipc' });
  assert.equal(removed, 1);
});

check('view model groups by session, newest-saved first inside groups', () => {
  const groups = model.groupBySession([
    { sessionId: 's1', messageId: 'a', bumpedAt: 3 },
    { sessionId: 's2', messageId: 'b', bumpedAt: 5 },
    { sessionId: 's1', messageId: 'c', bumpedAt: 4 },
    { sessionId: null, messageId: 'd', bumpedAt: 1 },
  ]);
  assert.deepEqual(groups.map((g) => g.sessionId), ['s2', 's1', null]);
  assert.deepEqual(groups.find((g) => g.sessionId === 's1').items.map((i) => i.messageId), ['c', 'a']);
  assert.deepEqual(model.groupBySession(null), []);
});

check('snippets collapse whitespace and clamp without eating words silently', () => {
  assert.equal(model.snippet('  a   b\n\nc  ', 10), 'a b c');
  const long = 'word '.repeat(40).trim();
  const cut = model.snippet(long, 30);
  assert.ok(cut.length <= 31 && cut.endsWith('…'));
  assert.ok(cut.slice(0, -1).endsWith('word'), 'clamps on a word boundary');
  assert.equal(model.snippet(null), '');
});

check('group labels prefer known titles and fall back to the session id', () => {
  assert.equal(model.groupLabel('s1', { s1: 'Release chat' }), 'Release chat');
  assert.equal(model.groupLabel('s1', {}), 's1');
  assert.equal(model.groupLabel(null, {}), 'Unknown session');
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-savedmessages FAILED');
    process.exit(1);
  }
  console.log(`\nparity savedmessages: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — library store, namespace, view model`);
})();
