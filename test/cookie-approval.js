'use strict';
/* Cookie-origin approval flow — real pending registry, native-dialog UI
 * (stubbed Electron dialog), grant persistence, await/cancel semantics.
 * (Grok 0.71: request/present/await/cancelCookieOriginApproval). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cookie-approval-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

let nextResponse = 1;
const dialogs = [];
const origLoad = Module._load;
Module._load = function patched(request) {
  if (request === 'electron') {
    return {
      dialog: { showMessageBox: async (opts) => { dialogs.push(opts); return { response: nextResponse }; } },
      BrowserWindow: class { static getAllWindows() { return []; } },
      app: { getPath: () => tmp },
    };
  }
  return origLoad.apply(this, arguments);
};

const { cookieApprovalService } = require('../src/main/services/cookieApprovalService');
const { cookieImportService } = require('../src/main/services/cookieImportService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  // The service's internal timers are unref'd (the app event loop is always
  // alive in production); keep a live handle so awaits here behave the same.
  const keepalive = setInterval(() => {}, 1_000);

  // 1. request → pending; idempotent
  const r1 = cookieApprovalService.request({ requestId: 'req-1', origins: [{ origin: 'example.com', profileId: 'Default' }], agentId: 'sess-1' });
  assert.strictEqual(r1.status, 'pending');
  const again = cookieApprovalService.request({ requestId: 'req-1', origins: [{ origin: 'example.com' }] });
  assert.strictEqual(again.status, 'pending', 'same requestId reuses the pending entry');

  // 2. await times out as pending while undecided
  const waited = await cookieApprovalService.await({ requestId: 'req-1', waitMs: 150 });
  assert.strictEqual(waited.kind, 'pending');
  assert.strictEqual(waited.waitedMs, 150);

  // 3. present → native dialog per origin → granted; grants persisted
  const granted = await cookieApprovalService.present({ requestId: 'req-1', origins: [{ origin: 'example.com', profileId: 'Default' }], agentId: 'sess-1' });
  assert.strictEqual(granted.kind, 'granted');
  assert.strictEqual(granted.grantsPersisted, true);
  assert.strictEqual(dialogs.length, 1);
  assert.match(dialogs[0].message, /example\.com/);
  assert.ok(cookieImportService.getGrants('sess-1').includes('example.com'), 'origin grant persisted');
  const grantsFile = path.join(tmp, 'cookie-grants.json');
  assert.strictEqual(fs.statSync(grantsFile).mode & 0o777, 0o600);

  // await after settle returns the decision immediately
  const after = await cookieApprovalService.await({ requestId: 'req-1', waitMs: 5_000 });
  assert.strictEqual(after.kind, 'granted');

  // 4. refusal — deny on the second origin; nothing granted for it
  nextResponse = 0;
  const refused = await cookieApprovalService.present({ requestId: 'req-2', origins: [{ origin: 'a.example.com' }, { origin: 'b.example.com' }], agentId: 'sess-2' });
  assert.strictEqual(refused.kind, 'refused');
  assert.strictEqual(refused.origin, 'a.example.com', 'first deny short-circuits');
  assert.strictEqual(dialogs.length, 2, 'only one dialog shown for a two-origin request denied up front');
  assert.ok(!cookieImportService.getGrants('sess-2').includes('a.example.com'));

  // 5. cancel — settles as cancelled; await sees it
  nextResponse = 1;
  cookieApprovalService.request({ requestId: 'req-3', origins: [{ origin: 'c.example.com' }] });
  const pendingWait = cookieApprovalService.await({ requestId: 'req-3', waitMs: 5_000 });
  const cancelled = cookieApprovalService.cancel({ requestId: 'req-3' });
  assert.strictEqual(cancelled.cancelled, true);
  const waitResult = await pendingWait;
  assert.strictEqual(waitResult.kind, 'cancelled', 'await resolves when cancel settles the request');

  // 6. unknown/missing requests behave honestly
  assert.strictEqual((await cookieApprovalService.await({ requestId: 'nope' })).kind, 'unknown');
  assert.strictEqual(cookieApprovalService.cancel({ requestId: 'nope' }).cancelled, false);

  // 7. present without Electron parks the request (await/cancel drive it)
  const realLoad = Module._load;
  Module._load = function noElectron(request) {
    if (request === 'electron') throw new Error('no electron in this sub-check');
    return realLoad.apply(this, arguments);
  };
  const parked = await cookieApprovalService.present({ requestId: 'req-4', origins: [{ origin: 'd.example.com' }] });
  assert.strictEqual(parked.kind, 'pending');
  Module._load = realLoad;
  const parkedSettled = cookieApprovalService.cancel({ requestId: 'req-4' });
  assert.strictEqual(parkedSettled.cancelled, true);

  // 8. dispatch envelopes
  const reqEnv = await grokCompatService.dispatch('requestCookieOriginApproval', { requestId: 'req-5', origins: [{ origin: 'e.example.com' }], agentId: 'sess-5' });
  assert.strictEqual(reqEnv.status, 'ok');
  assert.strictEqual(reqEnv.state, 'pending');
  assert.strictEqual(reqEnv.requestId, 'req-5');
  nextResponse = 1;
  const presEnv = await grokCompatService.dispatch('presentCookieOriginApproval', { requestId: 'req-5', agentId: 'sess-5' });
  assert.strictEqual(presEnv.kind, 'granted');
  assert.ok(cookieImportService.getGrants('sess-5').includes('e.example.com'));
  const awaitEnv = await grokCompatService.dispatch('awaitCookieOriginApproval', { requestId: 'req-5', waitMs: 1000 });
  assert.strictEqual(awaitEnv.kind, 'granted');
  const cancelEnv = await grokCompatService.dispatch('cancelCookieOriginApproval', { requestId: 'req-5' });
  assert.strictEqual(cancelEnv.cancelled, false, 'already settled');

  clearInterval(keepalive);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('cookie-approval test: ALL OK (request/present/await/cancel + grant persistence)');
})().catch((e) => { console.error(e); process.exit(1); });
