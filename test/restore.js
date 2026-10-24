'use strict';
/* Restore checkpoint test (GPA G15) — route + pending-update continuity. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-restore-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { restoreService } = require('../src/main/services/restoreService');

// ---- validation ----
assert.throws(() => restoreService.checkpoint({ type: 'bogus', id: 'x' }), /invalid restore route/);
assert.throws(() => restoreService.checkpoint({ type: 'session', id: '../escape' }), /invalid restore route/);
assert.throws(() => restoreService.markUpdate({ from: '1.0.0' }), /target version/);

// ---- route round-trip + consume clears ----
const route = restoreService.checkpoint({ type: 'session', id: 'sess_abc-123' });
assert.equal(route.id, 'sess_abc-123');
assert.equal(fs.statSync(path.join(tmp, 'restore.json')).mode & 0o777, 0o600, '0600 at rest');
let peek = restoreService.peek();
assert.equal(peek.route.id, 'sess_abc-123', 'peek is non-destructive');
let boot = restoreService.consume();
assert.equal(boot.route.id, 'sess_abc-123');
assert.equal(boot.pendingUpdate, null);
assert.equal(boot.bootCount, 1, 'first consume counts the boot');
assert.equal(restoreService.peek().route, null, 'route consumed');
boot = restoreService.consume();
assert.equal(boot.bootCount, 1, 'bootCount increments once per process');
assert.equal(boot.route, null);

// ---- pending update ----
restoreService.markUpdate({ from: '0.1.0', to: '0.2.0' });
restoreService.checkpoint({ type: 'session', id: 'sess_xyz' });
boot = restoreService.consume();
assert.deepEqual({ route: boot.route.id, update: boot.pendingUpdate.to, from: boot.pendingUpdate.from },
  { route: 'sess_xyz', update: '0.2.0', from: '0.1.0' });
assert.equal(restoreService.peek().pendingUpdate, null, 'update checkpoint consumed once');

// ---- clear ----
restoreService.checkpoint({ type: 'session', id: 'sess_clear' });
restoreService.markUpdate({ to: '9.9.9' });
restoreService.clear();
assert.deepEqual(restoreService.peek(), { route: null, pendingUpdate: null, bootCount: 1, lastBootAt: restoreService.peek().lastBootAt });

// ---- updater integration: install marks the checkpoint before relaunch ----
const source = fs.readFileSync(path.join(__dirname, '../src/main/services/updaterService.js'), 'utf8');
assert.match(source, /restoreService\.markUpdate\(\{ from: info\.current, to: info\.latest \}\)/, 'install marks the next-boot update');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('restore test: ALL OK');
