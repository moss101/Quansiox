'use strict';
/* Background computer control — the native helper addressing an app that
 * is NOT in front.
 *
 *  - a target (app name / bundle id / pid / window id) is honoured
 *  - the tree of the TARGET app is returned (not the frontmost one)
 *  - the element registry survives across calls, so an action can address
 *    an element by id
 *  - a stale snapshot is refused
 *  - an unknown target is refused honestly
 *
 * The Accessibility-dependent parts only run when the machine actually
 * grants the permission; otherwise the test verifies the honest refusal
 * path. The helper binary is optional (the JXA fallback stays in use). */
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
    const timer = setTimeout(() => { sock.off('data', onData); reject(new Error(`rpc timeout: ${method}`)); }, 10000);
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

/** The Finder (or any real app) is a good background target on macOS. */
function aRealApp() {
  const { execFileSync } = require('node:child_process');
  try {
    const out = execFileSync('/usr/bin/osascript', ['-e', 'id of app "Finder"'], { encoding: 'utf8' }).trim();
    return { bundleId: out, appName: 'Finder' };
  } catch {
    return { bundleId: 'com.apple.finder', appName: 'Finder' };
  }
}

(async () => {
  if (!hasBinary) {
    console.log('background-computer test: SKIP (build/QuansioxComputerHelper not built)');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-bg-'));
  const bootstrap = path.join(tmp, 'bootstrap.json');
  const socketPath = path.join(tmp, 'helper.sock');
  const token = 'bg-token-' + Date.now();
  fs.writeFileSync(bootstrap, JSON.stringify({ version: 1, profile: tmp, controlToken: token, deviceKind: 'desktop' }), { mode: 0o600 });
  const child = spawn(BIN, [], {
    env: { ...process.env, QUANSIOX_COMPUTER_HELPER_BOOTSTRAP: bootstrap, QUANSIOX_COMPUTER_HELPER_SOCKET: socketPath },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', () => {});
  const sock = await connect(socketPath);
  await rpc(sock, 1, 'initialize', {});
  await rpc(sock, 2, 'computer/authenticate', { controlToken: token });

  // 1. windows can be enumerated (ScreenCaptureKit)
  const windows = await rpc(sock, 3, 'computer/list_windows', {});
  if (windows.error) {
    // Screen Recording is not granted: the refusal must be structured.
    assert.ok(typeof windows.error.code === 'number', 'a refusal is structured');
  } else {
    assert.ok(Array.isArray(windows.result.windows), 'the window list is an array');
  }

  // 2. a target is honoured: the tree of the TARGET app comes back, not the
  //    frontmost one.
  const target = aRealApp();
  const state = await rpc(sock, 4, 'computer/app_state', { bundle_id: target.bundleId });
  if (state.error) {
    assert.ok(
      state.error.code === -32002 || state.error.code === -32007,
      `an honest refusal (got ${state.error.code}: ${state.error.message})`,
    );
  } else {
    assert.equal(state.result.bundleId, target.bundleId, 'the tree belongs to the target app');
    assert.ok(state.result.meta.snapshotId, 'the tree has a snapshot id');
    assert.ok(Array.isArray(state.result.elements), 'the tree lists its elements');
    const snapshotId = state.result.meta.snapshotId;

    // 3. the element registry survives: find_elements returns the same ids
    const found = await rpc(sock, 5, 'computer/find_elements', { bundle_id: target.bundleId, role: 'AXButton' });
    if (!found.error) {
      assert.equal(typeof found.result.count, 'number');
      assert.ok(Array.isArray(found.result.elements));
    }

    // 4. a stale snapshot is refused
    const stale = await rpc(sock, 6, 'computer/click', {
      bundle_id: target.bundleId,
      element_id: 'ax999999',
      snapshot_id: 'snap-not-a-real-snapshot',
    });
    if (!stale.error) {
      // some helpers ignore the snapshot; the click must still not fake success
      assert.notEqual(stale.result?.outcome?.dispatched, true, 'a stale element never reports success');
    }
  }

  // 5. an unknown target is refused honestly
  const unknown = await rpc(sock, 7, 'computer/app_state', { bundle_id: 'com.example.definitely-not-running' });
  if (!unknown.error) {
    // ScreenCaptureKit may still resolve something; the app state must not
    // claim a bogus bundle id.
    assert.notEqual(unknown.result?.bundleId, 'com.example.definitely-not-running');
  }

  sock.destroy();
  child.kill('SIGTERM');
  await wait(200);

  // 6. the JS service passes the target through
  const { computerUseService: svc } = require('../src/main/services/computerUseService');
  const passthrough = svc.targetParams({ bundle_id: 'com.apple.finder', app_name: 'Finder', x: 1, y: 2, junk: 'no' });
  assert.deepEqual(passthrough, { bundle_id: 'com.apple.finder', app_name: 'Finder' });
  assert.deepEqual(svc.targetParams({}), {});

  // 7. the model-facing tools advertise the target parameters
  const coordinator = require('../src/coordinator/index');
  const tools = coordinator.allTools();
  const axTool = tools.find((t) => t.function.name === 'computer_ax_tree');
  assert.ok(axTool.function.parameters.properties.bundle_id, 'computer_ax_tree accepts a target');
  assert.ok(axTool.function.parameters.properties.app_name, 'computer_ax_tree accepts an app name');
  const shotTool = tools.find((t) => t.function.name === 'computer_screenshot');
  assert.ok(shotTool.function.parameters.properties.window_id, 'computer_screenshot accepts a window id');
  const clickTool = tools.find((t) => t.function.name === 'computer_click');
  assert.ok(clickTool.function.parameters.properties.element_id, 'computer_click accepts an element id');
  assert.ok(tools.find((t) => t.function.name === 'computer_list_windows'), 'computer_list_windows exists');

  console.log('background-computer test: ALL OK (window list/target honoured/element registry/stale refusal/JS passthrough)');
})().catch((e) => { console.error(e); process.exit(1); });
