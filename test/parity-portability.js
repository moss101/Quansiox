'use strict';
/* Parity (P4.3): portability — checksummed open-format exports.
 *
 * 1. Envelopes: canonical-JSON checksums are deterministic; tampering with
 *    the payload (or the checksum) fails verification.
 * 2. Session share: profile + transcript round-trip into a NEW session
 *    (re-minted ids, importable many times); no secrets ride the payload.
 * 3. Library export: saved messages + pins in one manifest.
 * 4. The namespace routes to the service; writeFile lands 0600 under
 *    userData/exports. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-portab-'));

const { portabilityService } = require('../src/main/services/portabilityService.js');
const { sessionService } = require('../src/main/services/sessionService.js');
const { savedMessagesService } = require('../src/main/services/savedMessagesService.js');
const { libraryService } = require('../src/main/services/libraryService.js');

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

check('checksums are deterministic over canonical JSON and tamper-evident', () => {
  const a = portabilityService.envelope('quansiox.test', { b: 2, a: 1 });
  const b = portabilityService.envelope('quansiox.test', { a: 1, b: 2 });
  assert.equal(a.sha256, b.sha256, 'key order does not change the checksum');
  portabilityService.verify(a);
  const tampered = { ...a, payload: { a: 1, b: 3 } };
  assert.throws(() => portabilityService.verify(tampered), /checksum mismatch/);
  assert.throws(() => portabilityService.verify({ ...a, version: 99 }), /version/);
  assert.throws(() => portabilityService.verify(null), /not a quansiox manifest/);
});

check('a session share round-trips into a fresh, importable-again session', () => {
  const sid = sessionService.create({ id: 'share-src', title: 'Release bot', label: 'ops', description: 'ships things' }).id;
  sessionService.appendTurn(sid, { role: 'user', content: 'ship it' });
  sessionService.appendTurn(sid, { role: 'assistant', content: 'shipped' });
  sessionService.update(sid, { pinned: true, notifyOnUpdates: false });

  const share = portabilityService.sessionShare(sessionService, sid);
  assert.equal(share.format, 'quansiox.session-share');
  assert.equal(share.payload.turns.length, 2);
  assert.equal(share.payload.pinned, true);
  assert.equal(share.payload.notifyOnUpdates, false);
  assert.ok(!JSON.stringify(share).includes('apiKey'), 'no secret fields ride the share');

  const { id: imported, turns } = portabilityService.importSessionShare(sessionService, share);
  assert.notEqual(imported, sid, 'ids are re-minted');
  assert.equal(turns, 2);
  const row = sessionService.list().find((s) => s.id === imported);
  assert.match(row.title, /Release bot \(imported\)/);
  const got = sessionService.get(imported);
  assert.equal(got.turns.length, 2);
  assert.equal(got.turns[0].content, 'ship it');

  // importable repeatedly
  const second = portabilityService.importSessionShare(sessionService, share);
  assert.notEqual(second.id, imported);
  assert.equal(sessionService.get(second.id).turns.length, 2);

  // a share from another app claiming our format but failing the checksum
  assert.throws(() => portabilityService.importSessionShare(sessionService, { ...share, payload: { ...share.payload, turns: [] } }), /checksum/);
});

check('the library export carries saved messages and pins in one manifest', () => {
  savedMessagesService.clear();
  libraryService.clear();
  savedMessagesService.save({ sessionId: 's1', messageId: 'm1', text: 'keep this' });
  libraryService.pin({ kind: 'page', refId: 'a1', title: 'Calculator' });
  const share = portabilityService.libraryShare(savedMessagesService, libraryService);
  assert.equal(share.format, 'quansiox.library-export');
  assert.equal(share.payload.savedMessages.length, 1);
  assert.equal(share.payload.pins.length, 1);
  portabilityService.verify(share);
});

check('writeFile lands a 0600 JSON manifest under userData/exports', () => {
  const share = portabilityService.sessionShare(sessionService, sessionService.create({ id: 'share-file' }).id);
  const file = portabilityService.writeFile('share-file', share);
  assert.match(file, /exports\/share-file\.json$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  portabilityService.verify(back);
  const ugly = portabilityService.writeFile('../../etc/passwd', share);
  assert.match(ugly, /exports\//, 'path traversal is sanitized to a name');
});

check('the portability namespace is registered and routes', async () => {
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
  const ns = allHandlers.portability ?? {};
  for (const handler of ['sessionShare', 'libraryShare', 'importSessionShare', 'writeFile']) {
    assert.equal(typeof ns[handler], 'function', `portability.${handler} missing`);
  }
  const sid = sessionService.create({ id: 'share-ipc' }).id;
  const share = await ns.sessionShare({}, { sessionId: sid });
  assert.equal(share.format, 'quansiox.session-share');
  const imported = await ns.importSessionShare({}, { manifest: share });
  assert.ok(imported.id);
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-portability FAILED');
    process.exit(1);
  }
  console.log(`\nparity portability: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — checksums, session round-trip, library export, files, namespace`);
})();
