'use strict';
/* Parity (P2.5): library v2 — pins store, namespace, and view model.
 *
 * 1. libraryService — content pins (media/page/document/sheet/deck): one
 *    pin per kind+refId (re-pin refreshes), title captured at pin time,
 *    bounded, explicit unpin/clear, unknown kinds rejected.
 * 2. The library namespace routes to the service.
 * 3. libraryModel — one collection across the saved-messages and pins
 *    stores: kind taxonomy in Grok's order, hover-card payloads, and the
 *    artifact→library kind map. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-library-'));

const { libraryService } = require('../src/main/services/libraryService.js');
const model = require('../src/renderer-src/libraryModel.js');

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

check('Grok\u2019s library v2 kinds are the closed set', () => {
  assert.deepEqual([...libraryService.KINDS].sort(), ['deck', 'document', 'media', 'page', 'sheet']);
});

check('pin → list newest-first; re-pin refreshes instead of duplicating', () => {
  libraryService.clear();
  libraryService.pin({ kind: 'page', refId: 'a1', title: 'Launch calculator' });
  libraryService.pin({ kind: 'sheet', refId: 'c1', title: 'Revenue chart' });
  let pins = libraryService.list();
  assert.equal(pins.length, 2);
  assert.equal(pins[0].refId, 'c1', 'newest pinned first');
  libraryService.pin({ kind: 'page', refId: 'a1', title: 'Launch calculator (renamed later)', note: 'keep' });
  pins = libraryService.list();
  assert.equal(pins.length, 2, 're-pin must not duplicate');
  const refreshed = pins.find((p) => p.refId === 'a1');
  assert.equal(refreshed.title, 'Launch calculator', 'snapshot semantics: the title stays as pinned');
  assert.equal(refreshed.note, 'keep', 're-pin refreshes the note');
});

check('unpin/isPinned/clear are explicit; bounds hold; invalid pins refused', () => {
  libraryService.clear();
  libraryService.pin({ kind: 'media', refId: 'm1', title: 'promo clip' });
  assert.equal(libraryService.isPinned('media', 'm1'), true);
  assert.equal(libraryService.isPinned('page', 'm1'), false, 'pins are per kind+ref');
  const { removed } = libraryService.unpin('media', 'm1');
  assert.equal(removed, 1);
  assert.throws(() => libraryService.pin({ kind: 'widget', refId: 'x', title: 't' }), /unknown library kind/);
  assert.throws(() => libraryService.pin({ kind: 'page', refId: '', title: 't' }), /refId/);
  assert.throws(() => libraryService.pin({ kind: 'page', refId: 'x', title: '  ' }), /title/);
  for (let i = 0; i < libraryService.MAX_PINS + 5; i += 1) {
    libraryService.pin({ kind: 'page', refId: `bulk-${i}`, title: `p ${i}` });
  }
  assert.equal(libraryService.list().length, libraryService.MAX_PINS);
  libraryService.clear();
  assert.equal(libraryService.list().length, 0);
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
  const ns = allHandlers.libraryPins ?? {};
  for (const handler of ['list', 'pin', 'unpin', 'isPinned', 'clear']) {
    assert.equal(typeof ns[handler], 'function', `library.${handler} handler missing`);
  }
  await ns.pin({}, { kind: 'deck', refId: 'via-ipc', title: 'Quarterly deck' });
  assert.equal((await ns.isPinned({}, { kind: 'deck', refId: 'via-ipc' })).pinned, true);
  assert.equal((await ns.list()).some((p) => p.refId === 'via-ipc'), true);
  const { removed } = await ns.unpin({}, { kind: 'deck', refId: 'via-ipc' });
  assert.equal(removed, 1);
});

check('the view model merges both stores into Grok\u2019s kind order', () => {
  const entries = [
    { kind: 'message', refId: 'm1', bumpedAt: 5, text: 'note to self' },
    { kind: 'sheet', refId: 'c1', bumpedAt: 4, title: 'Revenue chart' },
    { kind: 'page', refId: 'a1', bumpedAt: 3, title: 'Calculator' },
    { kind: 'deck', refId: 'd1', bumpedAt: 2, title: 'Q3 deck' },
  ];
  const groups = model.groupByKind(entries);
  assert.deepEqual(groups.map((g) => g.kind), ['message', 'page', 'sheet', 'deck'], 'taxonomy order, not bump order');
  assert.equal(groups[0].label, 'Saved messages');
  assert.deepEqual(model.groupByKind([]), []);
  // unknown kinds render last with their own label instead of vanishing
  const odd = model.groupByKind([{ kind: 'widget', refId: 'w1', bumpedAt: 1 }]);
  assert.equal(odd[0].label, 'widget');
});

check('hover cards describe what the pin is and where it came from', () => {
  const card = model.hoverCard({ kind: 'sheet', title: 'Revenue chart', sessionId: 's1', origin: 'artifact:chart', note: 'q3 numbers' }, { titles: { s1: 'Release chat' } });
  assert.equal(card.headline, 'Revenue chart');
  assert.equal(card.kindLabel, 'Sheets');
  assert.equal(card.origin, 'from Release chat · artifact:chart');
  assert.equal(card.hasNote, true);
  const bare = model.hoverCard({ kind: 'page', title: 'X' });
  assert.equal(bare.origin, 'from this library');
});

check('artifact kinds map onto the library taxonomy (facts both sides)', () => {
  assert.equal(model.libraryKindForArtifact('chart'), 'sheet');
  for (const kind of ['html', 'report', 'game', 'diagram', 'code', 'form']) {
    assert.equal(model.libraryKindForArtifact(kind), 'page', kind);
  }
});

check('saved-message rows normalize with their author kind', () => {
  const entry = model.messageEntry({ messageId: 'm9', kind: 'assistant', text: 'hi', sessionId: 's1', bumpedAt: 1 });
  assert.equal(entry.kind, 'message');
  assert.equal(entry.authorKind, 'assistant');
  assert.equal(entry.refId, 'm9');
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-library FAILED');
    process.exit(1);
  }
  console.log(`\nparity library: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — pins store, namespace, unified view model`);
})();
