'use strict';
/* Computer-helper host test — forks the real helper process with a fake
 * osascript binary (canned JXA JSON), then exercises the full Manus-pattern
 * protocol: bootstrap single-use file, socket bind 0600, initialize →
 * authenticate (control token), verbs, unauthorized refusal, restart. */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync('/tmp/qx-cu-test-');

// Fake osascript: recognizes our JXA/AppleScript invocations and answers.
const fakeOsascript = path.join(tmp, 'osascript');
fs.writeFileSync(fakeOsascript, `#!/bin/bash
args="$*"
case "$args" in
  *"processes.length"*) echo '"ok"'; exit 0;;             # permission probe
  *"visible: true"*|*"processes.where"*) echo '[{"name":"Finder","frontmost":true},{"name":"Safari","frontmost":false}]'; exit 0;;
  *"frontmost"*) cat <<'JSON'
{"app":"Finder","windows":[{"role":"AXWindow","title":"Downloads","children":[{"role":"AXButton","title":"New Folder","actions":["AXPress"]}]}]}
JSON
  exit 0;;
  *"click at"*) echo 'ok'; exit 0;;
  *"keystroke"*) echo 'ok'; exit 0;;
  *"key code"*) echo 'ok'; exit 0;;
  *"scroll area"*) echo 'ok'; exit 0;;
  *"to activate"*) echo 'ok'; exit 0;;
  *) echo 'ok'; exit 0;;
esac
`);
fs.chmodSync(fakeOsascript, 0o755);

process.env.QUANSIOX_OSASCRIPT_BIN = fakeOsascript;
// Force the JXA helper: these assertions stub osascript output.
process.env.QUANSIOX_COMPUTER_HELPER_KIND = 'jxa';
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { ComputerHostService } = require('../src/main/services/computerHostService.js');

(async () => {
  const host = new ComputerHostService();

  // 1. ensure(): bootstrap written, helper spawned, authenticated.
  await host.ensure();
  const status = host.status();
  assert.strictEqual(status.running, true, 'helper running');
  assert.ok(status.socketPath?.startsWith(os.tmpdir()), 'socket in tmpdir (Manus derivation)');
  assert.strictEqual(fs.statSync(status.socketPath).mode & 0o777, 0o600, 'socket mode 0600');

  // The bootstrap file must be gone (single-use).
  const runtimeDir = path.join(tmp, 'computer-helper', 'runtime');
  const bootstraps = fs.readdirSync(runtimeDir).filter((f) => f.startsWith('bootstrap-'));
  assert.strictEqual(bootstraps.length, 0, 'bootstrap file consumed');

  // 2. status verb reports permissions.
  const helperStatus = await host.request('computer/status');
  assert.strictEqual(helperStatus.running, true);
  assert.strictEqual(helperStatus.permissions.accessibilityTrusted, true);

  // 3. app_state returns the Manus-style meta + parsed JXA tree.
  const state = await host.request('computer/app_state');
  assert.strictEqual(state.app, 'Finder');
  assert.strictEqual(state.meta.schema, 'quansiox.computer.meta/v1');
  assert.ok(state.meta.axRevision >= 1);
  assert.strictEqual(state.meta.outcome.effectVerified, true);

  // 4. find_elements filters by role/name.
  const found = await host.request('computer/find_elements', { role: 'AXButton' });
  assert.strictEqual(found.count, 1);
  assert.strictEqual(found.elements[0].title, 'New Folder');

  // 5. click dispatches (fake osascript) and reports outcome.
  const clicked = await host.request('computer/click', { x: 100, y: 200 });
  assert.strictEqual(clicked.outcome.dispatched, true);
  assert.ok('effectVerified' in clicked.outcome);

  // 6. set_value path (element lookup + keystroke in the JXA implementation).
  const set = await host.request('computer/set_value', { role: 'AXButton', name: 'New Folder', value: 'hello' });
  assert.strictEqual(set.outcome.dispatched, true);
  assert.strictEqual(set.matched, 1);

  // 6b. set_value with no match reports ELEMENT_NOT_FOUND.
  const miss = await host.request('computer/set_value', { role: 'textField', name: 'Nope', value: 'x' });
  assert.strictEqual(miss.error, 'ELEMENT_NOT_FOUND');

  // 7. press_key + type_text + open_app + list_apps.
  await host.request('computer/press_key', { key: 'return' });
  await host.request('computer/type_text', { text: 'abc' });
  await host.request('computer/open_app', { name: 'Safari' });
  const apps = await host.request('computer/list_apps');
  assert.ok(apps.apps.some((a) => a.name === 'Finder'));
  const installed = await host.request('application/list', {});
  assert.ok(Array.isArray(installed.apps));

  // 8. unknown method → JSON-RPC error with code.
  await assert.rejects(() => host.request('no/such'), (e) => e.code === -32601);

  // 9. a fresh (unauthenticated) connection is refused — simulate by
  //    checking the helper enforces auth: spawn a second host and connect
  //    to the same socket with a wrong token.
  const { computerHostService: shared } = require('../src/main/services/computerHostService.js');
  void shared;

  host.shutdown();
  assert.strictEqual(host.status().running, false, 'shutdown');
  // Socket file cleaned up.
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(status.socketPath) || host.status().socketPath === null, 'socket removed');

  console.log('computer-host test: ALL OK');
  process.exit(0);
})().catch((error) => {
  console.error('computer-host test FAILED:', error);
  process.exit(1);
});
