'use strict';
/* Desktop stores & shell — client persistence KV (+localStorage migration),
 * deep-link readiness queue, openExternal guard, one-time local tool
 * approvals, link metadata and network diagnostics (real DNS/TCP/fetch). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-stores-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const opened = [];
const relaunched = [];
const realElectron = {
  shell: { openExternal: async (url) => { opened.push(url); } },
  app: { relaunch: () => relaunched.push(Date.now()), exit: () => { relaunched.push('exit'); } },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return realElectron;
  return origLoad.call(this, request, parent, isMain);
};

const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { deepLinkService } = require('../src/main/services/deepLinkService');
const { consentService } = require('../src/main/services/consentService');

(async () => {
  // 1. client persistence — write/read/readMany/listKeys/remove
  assert.strictEqual((await grokCompatService.dispatch('readClientPersistence', { key: 'missing' })).value, null);
  assert.strictEqual((await grokCompatService.dispatch('writeClientPersistence', { key: 'sidebar.width', value: '320' })).ok, true);
  await grokCompatService.dispatch('writeClientPersistence', { key: 'sidebar.open', value: 'true' });
  await grokCompatService.dispatch('writeClientPersistence', { key: 'theme.mode', value: 'dark' });
  assert.strictEqual((await grokCompatService.dispatch('readClientPersistence', { key: 'sidebar.width' })).value, '320');
  assert.strictEqual(fs.statSync(path.join(tmp, 'client-persistence.json')).mode & 0o777, 0o600);

  const many = await grokCompatService.dispatch('readManyClientPersistence', { include: ['sidebar.'] });
  assert.deepStrictEqual(Object.keys(many.values).sort(), ['sidebar.open', 'sidebar.width']);
  const excl = await grokCompatService.dispatch('readManyClientPersistence', { include: ['sidebar.'], exclude: ['sidebar.open'] });
  assert.deepStrictEqual(Object.keys(excl.values), ['sidebar.width']);
  const keys = await grokCompatService.dispatch('listClientPersistenceKeys', { prefix: 'theme' });
  assert.deepStrictEqual(keys.keys, ['theme.mode']);

  const removed = await grokCompatService.dispatch('removeClientPersistence', { key: 'theme.mode' });
  assert.strictEqual(removed.removed, true);
  assert.strictEqual((await grokCompatService.dispatch('removeClientPersistence', { key: 'theme.mode' })).removed, false);

  // migration: applies once, never overwrites live values, flips the flag
  assert.strictEqual((await grokCompatService.dispatch('hasMigratedClientPersistence', {})).migrated, false);
  const mig1 = await grokCompatService.dispatch('migrateClientPersistence', { entries: [
    { key: 'sidebar.width', value: '999' }, { key: 'legacy.once', value: 'yes' }, { key: '', value: 'skip' },
  ] });
  assert.strictEqual(mig1.migrated, true);
  assert.strictEqual(mig1.applied, 1);
  assert.strictEqual((await grokCompatService.dispatch('readClientPersistence', { key: 'sidebar.width' })).value, '320', 'existing keys win');
  assert.strictEqual((await grokCompatService.dispatch('readClientPersistence', { key: 'legacy.once' })).value, 'yes');
  assert.strictEqual((await grokCompatService.dispatch('hasMigratedClientPersistence', {})).migrated, true);
  const tooBig = await grokCompatService.dispatch('writeClientPersistence', { key: 'big', value: 'x'.repeat(1024 * 1024 + 1) });
  assert.strictEqual(tooBig.status, 'error');

  // 2. deep links — queued until ready, then flushed in order
  deepLinkService.deliver({ type: 'session', id: 's1' });
  deepLinkService.deliver({ type: 'settings' });
  assert.strictEqual(deepLinkService.status().pending, 2);
  const ready = await grokCompatService.dispatch('markDeepLinksReady', {});
  assert.strictEqual(ready.ready, true);
  assert.strictEqual(ready.flushed, 2);
  assert.strictEqual(deepLinkService.status().pending, 0);
  assert.deepStrictEqual(deepLinkService.deliver({ type: 'new' }), { delivered: true, queued: false, pending: 0 });

  // 3. openExternal — scheme guard + real handoff to shell
  const openedEnv = await grokCompatService.dispatch('openExternal', { url: 'https://example.com/x' });
  assert.strictEqual(openedEnv.opened, true);
  assert.deepStrictEqual(opened, ['https://example.com/x']);
  const blocked = await grokCompatService.dispatch('openExternal', { url: 'file:///etc/passwd' });
  assert.strictEqual(blocked.status, 'error');
  assert.strictEqual(opened.length, 1);

  // 4. relaunchDesktop — real app.relaunch handoff (stubbed app)
  const rel = await grokCompatService.dispatch('relaunchDesktop', {});
  assert.strictEqual(rel.relaunching, true);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(relaunched, [relaunched[0], 'exit']);

  // 5. local tool approvals — record once, resolve allow-once, expire/clear
  const rec = await grokCompatService.dispatch('recordLocalToolApproval', { approvalId: 'ap-1', action: 'computer_click', target: 'Safari' });
  assert.strictEqual(rec.recorded, true);
  assert.ok(rec.expiresAt > Date.now());
  const resolved = await grokCompatService.dispatch('resolveLocalToolPermission', { subject: 'computer_click', action: 'computer_click', target: 'Safari' });
  assert.strictEqual(resolved.mode, 'allow-once');
  assert.strictEqual(resolved.approvalId, 'ap-1');
  const other = await grokCompatService.dispatch('resolveLocalToolPermission', { subject: 'computer_click', action: 'computer_click', target: 'Terminal' });
  assert.strictEqual(other.mode, 'ask');
  const cleared = await grokCompatService.dispatch('clearLocalToolApprovals', {});
  assert.strictEqual(cleared.cleared, 1);
  assert.strictEqual(consentService.listApprovals().length, 0);

  // 6. link metadata — real fetch against a local HTTP server
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Fallback &amp; Title</title><meta property="og:title" content="OG Title"><meta property="og:description" content="OG Desc"><meta property="og:image" content="/img.png"><link rel="icon" href="/favicon.ico"></head><body></body></html>');
    } else if (req.url === '/img.png') { res.writeHead(200); res.end('x'); } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const meta = await grokCompatService.dispatch('getLinkMetadata', { url: `${base}/page` });
  assert.strictEqual(meta.metadata.title, 'OG Title');
  assert.strictEqual(meta.metadata.description, 'OG Desc');
  assert.strictEqual(meta.metadata.image, `${base}/img.png`);
  assert.strictEqual(meta.metadata.favicon, `${base}/favicon.ico`);
  const badMeta = await grokCompatService.dispatch('getLinkMetadata', { url: 'ftp://x' });
  assert.strictEqual(badMeta.metadata, null);

  // 7. network diagnostics — real DNS + TCP probes (localhost must connect)
  const diag = await grokCompatService.dispatch('runNetworkDiagnostics', { hosts: ['localhost'] });
  assert.strictEqual(diag.status, 'ok');
  assert.strictEqual(diag.tcp[0].ok, false, 'localhost:443 is closed in CI → reports honest failure');
  assert.ok(diag.dns[0].ok, 'localhost resolves');
  assert.ok(Array.isArray(diag.dns[0].addresses));

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('desktop-stores test: ALL OK (persistence/deep links/shell/approvals/link+dns diagnostics)');
})().catch((e) => { console.error(e); process.exit(1); });
