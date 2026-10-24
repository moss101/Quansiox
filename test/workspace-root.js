'use strict';
/* Workspace-root normalization — the packaged app is launched from Finder with
 * cwd `/`, so an empty workspaceRoot must not become `/.quansiox/...`. Verifies
 * the in-memory fallback, disk persistence, sandbox path, and root rejection. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-ws-user-'));
const fallback = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-ws-default-'));
process.env.QUANSIOX_USER_DATA_DIR = userData;
process.env.QUANSIOX_DEFAULT_WORKSPACE = fallback;

const { settingsService } = require('../src/main/services/settingsService');
const { sandboxService } = require('../src/main/services/sandboxService');

function run() {
  // 1. no settings file yet → normalized default, no cwd `/`
  assert.strictEqual(settingsService.load().workspaceRoot, fallback);
  assert.strictEqual(settingsService.workspaceRoot(), fallback);

  // 2. persisted empty value is normalized on read
  settingsService.save({ workspaceRoot: '' });
  assert.strictEqual(settingsService.load().workspaceRoot, fallback, 'empty root falls back');

  // 3. filesystem root is rejected (it is never a valid agent workspace)
  settingsService.save({ workspaceRoot: '/' });
  assert.strictEqual(settingsService.load().workspaceRoot, fallback, 'root path falls back');

  // 4. sandboxRoot never builds `/.quansiox/...`
  const root = sandboxService.sandboxRoot('5ce0906c-e4d9-4823-bf96-fc16d693100c');
  assert.ok(root.startsWith(fallback + path.sep), `sandbox root is under the fallback: ${root}`);
  assert.ok(!root.startsWith(`${path.sep}.quansiox`), 'never /.quansiox');

  // 5. startup seed creates the folder and persists the normalized value
  const seeded = settingsService.ensureWorkspaceRoot();
  assert.strictEqual(seeded, fallback);
  assert.ok(fs.existsSync(fallback));
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'quansiox-settings.json'), 'utf8'));
  assert.strictEqual(onDisk.workspaceRoot, fallback, 'normalized root persisted');

  // 6. a real configured workspace is preserved
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-ws-explicit-'));
  settingsService.save({ workspaceRoot: explicit });
  assert.strictEqual(settingsService.load().workspaceRoot, explicit);
  assert.ok(sandboxService.sandboxRoot('s1').startsWith(explicit + path.sep));

  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(fallback, { recursive: true, force: true });
  fs.rmSync(explicit, { recursive: true, force: true });
  console.log('workspace-root test: ALL OK');
}
run();
