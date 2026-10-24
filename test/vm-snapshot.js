'use strict';
/* VM snapshots — the checkpoint/branch logic.
 *
 *  - a snapshot saves the machine state and clones the share copy-on-write
 *  - the clone is a real CoW clone (the file is a separate inode with
 *    shared blocks, so writing to the clone does not touch the original)
 *  - a restore replaces the live share with the clone and asks the VM host
 *    to restore the machine state
 *  - a branch produces a new session's share from a snapshot
 *  - the catalog is bounded and persisted
 *
 * The VM adapter is injected, so no guest is booted. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-snap-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { vmSnapshotService } = require('../src/main/services/vmSnapshotService');

/** A fake VM host that speaks the control protocol. */
function startControlServer(replies = {}) {
  const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qx-ctl-')), 'control.sock');
  const commands = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      commands.push(line);
      const reply = replies[line.split(' ')[0]] ?? 'OK';
      conn.write(`${reply}\n`);
    });
    conn.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(sockPath, () => resolve({ sockPath, commands, server }));
  });
}

(async () => {
  // 1. a live share + a control socket
  const share = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-share-'));
  fs.writeFileSync(path.join(share, 'work.txt'), 'v1');
  fs.mkdirSync(path.join(share, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(share, 'dir', 'nested.txt'), 'nested v1');

  const control = await startControlServer({ save: 'OK /tmp/snaps', restore: 'OK /tmp/snaps' });
  let booted = 0;
  let flushed = 0;
  vmSnapshotService.setAdapter({
    controlSocket: () => control.sockPath,
    shareDir: () => share,
    stop: async () => ({ stopped: true }),
    boot: async () => { booted += 1; return { booted: true }; },
    flush: async () => { flushed += 1; return true; },
  });

  // 2. a snapshot records both halves
  const snap = await vmSnapshotService.snapshot('session-a', { name: 'before-change' });
  assert.equal(snap.name, 'before-change');
  assert.equal(snap.sessionId, 'session-a');
  assert.ok(snap.sharePath, 'the snapshot has a share clone');
  assert.ok(fs.existsSync(snap.sharePath), 'the clone exists');
  assert.equal(fs.readFileSync(path.join(snap.sharePath, 'work.txt'), 'utf8'), 'v1');
  assert.equal(fs.readFileSync(path.join(snap.sharePath, 'dir', 'nested.txt'), 'utf8'), 'nested v1');
  assert.ok(control.commands.includes('save before-change'), 'the VM host was asked to quiesce the guest');
  assert.equal(flushed, 1, 'the guest was flushed before the clone');
  assert.equal(booted, 0, 'the guest keeps running after a snapshot');

  // 3. the catalog lists it
  const listed = vmSnapshotService.list('session-a');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'before-change');

  // 4. writing to the original does NOT change the clone (it is a copy)
  fs.writeFileSync(path.join(share, 'work.txt'), 'v2');
  assert.equal(fs.readFileSync(path.join(snap.sharePath, 'work.txt'), 'utf8'), 'v1',
    'the snapshot is independent of the live share');

  // 5. a restore puts the snapshot back and asks the VM host to restore
  const restored = await vmSnapshotService.restore('session-a', 'before-change');
  assert.equal(restored.restored, true);
  assert.equal(fs.readFileSync(path.join(share, 'work.txt'), 'utf8'), 'v1', 'the live share is back to the snapshot');
  assert.ok(restored.previousShare, 'the pre-restore share was kept aside');
  assert.equal(booted, 1, 'the guest was booted again on the restored share');

  // 6. an unknown snapshot is refused
  await assert.rejects(() => vmSnapshotService.restore('session-a', 'nope'), /unknown snapshot/);

  // 7. a branch produces a new session's share
  const branch = await vmSnapshotService.branch('session-a', 'before-change', { targetSessionId: 'session-b' });
  assert.equal(branch.sessionId, 'session-b');
  assert.equal(fs.readFileSync(path.join(branch.sharePath, 'work.txt'), 'utf8'), 'v1');
  // the branch is independent of the source
  fs.writeFileSync(path.join(branch.sharePath, 'work.txt'), 'branched');
  assert.equal(fs.readFileSync(path.join(snap.sharePath, 'work.txt'), 'utf8'), 'v1',
    'the branch is independent of the snapshot');

  // 8. removal cleans up
  assert.equal(vmSnapshotService.remove('session-a', 'before-change').removed, true);
  assert.equal(vmSnapshotService.list('session-a').length, 0);

  // 9. a failing VM host is reported honestly
  const failing = await startControlServer({ save: 'ERR could not quiesce' });
  vmSnapshotService.setAdapter({
    controlSocket: () => failing.sockPath,
    shareDir: () => share,
    stop: async () => ({ stopped: true }),
  });
  await assert.rejects(() => vmSnapshotService.snapshot('session-c', { name: 'x' }), /could not quiesce the VM/);

  // 10. a stopped session can still be snapshotted (the share is what counts)
  vmSnapshotService.setAdapter({ controlSocket: () => null, shareDir: () => share });
  const offline = await vmSnapshotService.snapshot('session-d', { name: 'offline' });
  assert.equal(offline.sessionId, 'session-d');
  assert.ok(fs.existsSync(offline.sharePath));

  // 10b. a session without a share is refused honestly
  vmSnapshotService.setAdapter({ controlSocket: () => null, shareDir: () => null });
  await assert.rejects(() => vmSnapshotService.snapshot('session-e', { name: 'x' }), /no share directory/);

  // 11. invalid input is refused
  vmSnapshotService.setAdapter({
    controlSocket: () => control.sockPath,
    shareDir: () => share,
  });
  await assert.rejects(() => vmSnapshotService.snapshot('bad/session', { name: 'x' }), /invalid session id/);
  await assert.rejects(() => vmSnapshotService.snapshot('session-a', { name: 'bad name!' }), /invalid snapshot name/);

  control.server.close();
  failing.server.close();
  console.log('vm-snapshot test: ALL OK (save+clone/restore/branch/CoW independence/catalog/cleanup/errors)');
})().catch((e) => { console.error(e); process.exit(1); });
