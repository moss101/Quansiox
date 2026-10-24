'use strict';
/* Native computer-use helper (Phase 2a): NDJSON JSON-RPC over a unix socket,
 * bootstrap/token auth, app blocklist, honest Accessibility refusal, and the
 * host service preferring the binary when built. Skips cleanly when the helper
 * has not been compiled (JS/AppleScript fallback then remains in use). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'build', 'QuansioxComputerHelper');
const hasBinary = fs.existsSync(BIN);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(socketPath, deadlineMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.createConnection(socketPath);
      sock.once('connect', () => { sock.off('error', noop); resolve(sock); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > deadlineMs) reject(new Error('connect timeout'));
        else setTimeout(attempt, 60);
      });
    };
    const noop = () => {};
    attempt();
  });
}

function rpc(sock, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { sock.off('data', onData); reject(new Error(`rpc timeout: ${method}`)); }, 8000);
    const onData = (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        clearTimeout(timer);
        sock.off('data', onData);
        resolve(msg);
        return;
      }
    };
    sock.on('data', onData);
    sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

(async () => {
  // 1. source/build contract even when the binary is absent
  const source = fs.readFileSync(path.join(ROOT, 'native', 'QuansioxComputerHelper.swift'), 'utf8');
  for (const method of ['computer/authenticate', 'computer/app_state', 'computer/find_elements', 'computer/click', 'computer/type_text', 'computer/set_value', 'computer/press_key', 'computer/scroll', 'computer/open_app', 'computer/list_apps', 'application/list', 'application/icon']) {
    assert.ok(source.includes(method), `helper implements ${method}`);
  }
  assert.ok(source.includes('QUANSIOX_COMPUTER_BLOCKLIST'));
  assert.ok(source.includes('chmod(path, 0o600)'));
  assert.ok(source.includes('AXIsProcessTrusted'));
  assert.ok(source.includes('CGEvent'));
  // background control: the helper must be able to address a background app
  assert.ok(source.includes('ScreenCaptureKit'), 'per-window capture uses ScreenCaptureKit');
  assert.ok(source.includes('SCShareableContent.current'), 'background windows are enumerated');
  assert.ok(source.includes('kAXPressAction'), 'elements are actuated through AX');
  assert.ok(source.includes('postToPid'), 'coordinate clicks can target a process without moving the pointer');

  const { nativeHelperPath, ComputerHostService } = require('../src/main/services/computerHostService');
  if (!hasBinary) {
    assert.equal(nativeHelperPath(), null, 'no binary → host service uses the JXA fallback');
    console.log('native-helper test: SKIP (build/QuansioxComputerHelper not built; source contract OK)');
    return;
  }
  assert.equal(nativeHelperPath(), BIN);

  // 2. direct protocol: bootstrap, auth, token checks, listing, blocklist, shutdown
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-native-'));
  const bootstrap = path.join(tmp, 'bootstrap.json');
  const socketPath = path.join(tmp, 'helper.sock');
  const token = 'test-token-' + Date.now();
  fs.writeFileSync(bootstrap, JSON.stringify({ version: 1, profile: tmp, controlToken: token, deviceKind: 'desktop' }), { mode: 0o600 });
  const child = spawn(BIN, [], {
    env: { ...process.env, QUANSIOX_COMPUTER_HELPER_BOOTSTRAP: bootstrap, QUANSIOX_COMPUTER_HELPER_SOCKET: socketPath, QUANSIOX_COMPUTER_BLOCKLIST: 'com.apple.keychainaccess,BlockedApp' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));

  const sock = await connect(socketPath);
  assert.equal(fs.existsSync(bootstrap), false, 'bootstrap file is single-use');
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600, 'socket is 0600');

  const init = await rpc(sock, 1, 'initialize', {});
  assert.equal(init.result.protocol, 'quansiox.computer/v1');
  assert.ok(init.result.methods.includes('computer/app_state'));

  const beforeAuth = await rpc(sock, 2, 'computer/status', {});
  assert.equal(beforeAuth.error.code, -32001, 'methods require authentication');

  const badAuth = await rpc(sock, 3, 'computer/authenticate', { controlToken: 'wrong' });
  assert.equal(badAuth.error.code, -32001);
  const auth = await rpc(sock, 4, 'computer/authenticate', { controlToken: token });
  assert.deepEqual(auth.result, { authenticated: true, deviceKind: 'desktop' });

  const status = await rpc(sock, 5, 'computer/status', {});
  assert.equal(status.result.running, true);
  assert.equal(typeof status.result.permissions.accessibilityTrusted, 'boolean');
  assert.equal(status.result.version, 4, 'the helper reports its capability version');
  assert.ok(init.result.methods.includes('computer/list_windows'), 'the helper can enumerate windows');
  assert.ok(init.result.methods.includes('computer/screenshot'), 'the helper can capture a single window');
  assert.ok(init.result.methods.includes('computer/finish'), 'the helper can release its element handles');
  assert.equal(init.result.capabilities?.background, true, 'the helper advertises background control');
  assert.equal(init.result.capabilities?.windowCapture, true, 'the helper advertises per-window capture');

  const listed = await rpc(sock, 6, 'application/list', {});
  assert.ok(Array.isArray(listed.result.apps) && listed.result.apps.length > 0);
  assert.ok(listed.result.apps.every((a) => typeof a.name === 'string' && typeof a.path === 'string'));

  const running = await rpc(sock, 7, 'computer/list_apps', {});
  assert.ok(Array.isArray(running.result.apps));

  const blocked = await rpc(sock, 8, 'computer/open_app', { name: 'BlockedApp' });
  assert.equal(blocked.error.code, -32005);
  assert.match(blocked.error.message, /APP_BLOCKED/);

  // Accessibility-dependent calls must return a structured refusal, never fake success.
  const state = await rpc(sock, 9, 'computer/app_state', {});
  if (state.error) {
    assert.equal(state.error.code, -32002);
    assert.match(state.error.message, /ACCESSIBILITY_PERMISSION_REQUIRED/);
    const click = await rpc(sock, 10, 'computer/click', { x: 1, y: 1 });
    assert.equal(click.error.code, -32002);
  } else {
    assert.equal(typeof state.result.app, 'string');
    assert.equal(state.result.meta.schema, 'quansiox.computer.meta/v2');
    assert.ok(state.result.meta.snapshotId, 'the tree carries a snapshot id');
    assert.ok(Array.isArray(state.result.elements), 'the tree lists its elements');
  }

  const finished = await rpc(sock, 12, 'computer/finish', {});
  assert.equal(finished.result.finished, true, 'finish acknowledges the release');
  assert.equal(typeof finished.result.releasedSnapshots, 'number', 'finish reports how many snapshots it dropped');

  const unknown = await rpc(sock, 11, 'nope/nope', {});
  assert.equal(unknown.error.code, -32601);
  sock.destroy();

  // 3. lifecycle: SIGTERM exits and removes the socket
  child.kill('SIGTERM');
  const exit = await Promise.race([exited, wait(5000).then(() => ({ timeout: true }))]);
  assert.ok(exit.code === 0 || exit.signal === 'SIGTERM', `helper exits on SIGTERM (${JSON.stringify(exit)})`);
  await wait(150);
  assert.equal(fs.existsSync(socketPath), false, 'socket cleaned up');
  assert.ok(stderr.includes('listening'), 'helper announced itself on stderr');

  // 4. host service prefers the native binary and speaks to it
  const host = new ComputerHostService();
  try {
    await host.ensure();
    assert.equal(host.status().helper, 'native');
    const s = await host.request('computer/status', {}, 5000);
    assert.equal(s.running, true);
    const released = await host.request('computer/finish', {}, 5000);
    assert.equal(released.finished, true, 'the host can release element handles');
    const apps = await host.request('application/list', {}, 15000);
    assert.ok(Array.isArray(apps.apps) && apps.apps.length > 0);
  } finally {
    host.shutdown();
  }

  console.log('native-helper test: ALL OK (protocol/auth/listing/blocklist/accessibility/lifecycle/host-selection)');
})().catch((error) => { console.error(error); process.exit(1); });
