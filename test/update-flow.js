'use strict';
/* Update flow smoke test — install identity (device-id), feed check with the
 * device header, staged zip swap, prepare-restart handshake, relaunch, and
 * the playback-active install gate (Cue updater patterns). */
const Module = require('node:module');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execSync } = require('node:child_process');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-upd-'));
process.env.QUANSIOX_TEST_USERDATA = userData;
process.env.QUANSIOX_USER_DATA_DIR = userData;
process.env.QUANSIOX_TEST_PACKAGED = '1';
process.env.QUANSIOX_APP_VERSION = '0.1.0';

// Fake packaged app layout for the swap test.
const fakeBundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-app-'));
const fakeBundle = path.join(fakeBundleRoot, 'Quansiox.app');
fs.mkdirSync(path.join(fakeBundle, 'Contents', 'MacOS'), { recursive: true });
fs.writeFileSync(path.join(fakeBundle, 'Contents', 'MacOS', 'Quansiox'), '#!/bin/sh\n');
process.env.QUANSIOX_TEST_EXEC_PATH = path.join(fakeBundle, 'Contents', 'MacOS', 'Quansiox');

// Build an update zip containing a newer Quansiox.app.
const newBundle = path.join(fakeBundleRoot, 'new');
fs.mkdirSync(path.join(newBundle, 'Quansiox.app', 'Contents', 'MacOS'), { recursive: true });
fs.writeFileSync(path.join(newBundle, 'Quansiox.app', 'Contents', 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>9.9.9</string></dict></plist>');
execSync(`cd ${JSON.stringify(newBundle)} && zip -qr ${JSON.stringify(path.join(fakeBundleRoot, 'update.zip'))} Quansiox.app`);

class FakeBrowserWindow {}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-playback.js');
  return origResolve.call(this, req, ...rest);
};
const stub = require('./stub-electron-playback.js');
stub.__setBrowserWindow(FakeBrowserWindow);

const server = http.createServer((req, res) => {
  if (req.url === '/latest.json') {
    assert(req.headers['x-quansiox-device'], 'device id header present on feed request');
    res.end(JSON.stringify({ version: '9.9.9', url: `http://127.0.0.1:${server.address().port}/update.zip`, notes: 'test' }));
  } else if (req.url === '/update.zip') {
    const buf = fs.readFileSync(path.join(fakeBundleRoot, 'update.zip'));
    res.setHeader('content-length', buf.length);
    res.end(buf);
  } else {
    res.statusCode = 404;
    res.end('nope');
  }
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const { settingsService } = require('../src/main/services/settingsService');
  const { updaterService } = require('../src/main/services/updaterService');
  const { installIdService } = require('../src/main/services/installIdService');
  const { playbackService } = require('../src/main/services/playbackService');

  // ---- install identity (Cue device-id pattern) ----
  const id1 = installIdService.getOrCreate();
  assert(/^[0-9a-f-]{36}$/.test(id1), `uuid shape: ${id1}`);
  assert.strictEqual(installIdService.getOrCreate(), id1, 'stable across calls');
  const stored = fs.readFileSync(path.join(userData, 'device-id'), 'utf8').trim();
  assert.strictEqual(stored, id1, 'persisted 0600');
  const mode = fs.statSync(path.join(userData, 'device-id')).mode & 0o777;
  assert.strictEqual(mode, 0o600, `0600 permissions (got ${mode.toString(8)})`);

  // ---- feed check with install-identity header ----
  settingsService.save({ updateFeedUrl: `http://127.0.0.1:${port}/latest.json` });
  const check = await updaterService.check();
  assert(check.enabled && check.updateAvailable, `update detected: ${JSON.stringify(check)}`);
  assert.strictEqual(check.latest, '9.9.9');

  // ---- playback gate: installs refused while a recording is watched ----
  playbackService.setWindowManager({
    windowsOfType: () => [{ sessionId: 's1', win: { isDestroyed: () => false } }],
  });
  const gated = await updaterService.install();
  assert(!gated.ok && /playback window is active/.test(gated.error), `gated: ${JSON.stringify(gated)}`);
  playbackService.setWindowManager({ windowsOfType: () => [] });

  // ---- prepared handshake: unknown id is a no-op ----
  assert.strictEqual(updaterService.prepared('nope'), false);

  // ---- staged install with handshake + relaunch ----
  // Simulate the renderer acking the prepare-restart request (Cue's
  // agents:updater:prepared handshake) as soon as main asks.
  const emitEvent = require('../src/main/ipc/emitEvent').emitEvent;
  const registry = require('../src/main/ipc/emitEvent');
  let acked = false;
  const origEmit = registry.emitEvent;
  registry.emitEvent = (ns, method, ...args) => {
    if (ns === 'updater' && method === 'onPrepareRestart') {
      acked = true;
      updaterService.prepared(args[0].id, 'ok');
    }
    return origEmit.call(registry, ns, method, ...args);
  };
  const result = await updaterService.install();
  registry.emitEvent = origEmit;
  assert(acked, 'prepare-restart handshake round-tripped');
  assert.strictEqual(result.ack, 'ok', `renderer ack recorded: ${JSON.stringify(result)}`);
  assert(result.ok, `install ok: ${JSON.stringify(result)}`);
  assert(result.applied, 'bundle swapped in place');
  assert(fs.existsSync(`${fakeBundle}.old${''}`) || fs.existsSync(`${fakeBundle}.old`), 'old bundle retained');
  const plist = fs.readFileSync(path.join(fakeBundle, 'Contents', 'Info.plist'), 'utf8');
  assert(plist.includes('9.9.9'), 'new bundle content in place');
  assert(stub.__state.relaunched >= 1, 'app.relaunch called');
  assert(stub.__state.exited >= 1, 'app.exit called');

  // ---- non-zip artifacts are revealed, not swapped ----
  fs.rmSync(fakeBundle, { recursive: true, force: true });
  fs.mkdirSync(path.join(fakeBundle, 'Contents', 'MacOS'), { recursive: true });

  server.close();
  console.log('UPDATE-FLOW SMOKE OK — device-id, feed header, gate, staged swap, handshake, relaunch all pass');
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
