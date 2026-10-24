'use strict';
/* Live VM snapshot test — runs against a real booted guest.
 *
 * It skips itself when the machine cannot run the Virtualization.framework
 * guest (no `com.apple.security.virtualization` entitlement, which is the
 * case for a plain `node` process on an unsigned binary), so the normal
 * test suite stays fast and portable.
 *
 * When it does run it checks the whole loop:
 *   boot -> write a file in the guest -> snapshot -> change the file ->
 *   restore -> the guest sees the old content again.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-vmlive-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { desktopVmService } = require('../src/main/services/desktopVmService');
const { vmSnapshotService } = require('../src/main/services/vmSnapshotService');

const sessionId = 'live-test';
const share = path.join(tmp, 'share');

async function main() {
  let entry = null;
  try {
    entry = await desktopVmService.boot({ sessionId, shareDir: share, memMB: 2048, cpus: 2 });
  } catch (error) {
    // No entitlement, no memory, no hypervisor — the live test is optional.
    console.log(`vm-snapshot-live: SKIPPED — the guest cannot boot here (${error.message})`);
    try { desktopVmService.stop(sessionId); } catch { /* nothing to stop */ }
    return;
  }
  try {
    assert.ok(entry.rfbSock, 'the VM published its RFB socket');

    // the guest agent answers
    const ping = await desktopVmService.call(sessionId, 'exec', { command: 'echo ready' });
    assert.equal(ping.exitCode, 0);
    assert.match(ping.output, /ready/);

    // a file the guest writes
    await desktopVmService.call(sessionId, 'exec', { command: 'echo "before the snapshot" > work.txt' });

    // the snapshot
    const snap = await vmSnapshotService.snapshot(sessionId, { name: 'checkpoint-1' });
    assert.equal(snap.name, 'checkpoint-1');
    assert.ok(fs.existsSync(snap.sharePath), 'the clone exists');
    assert.ok(snap.bytes > 0, 'the snapshot has content');

    // the guest changes the file
    await desktopVmService.call(sessionId, 'exec', { command: 'echo "after the snapshot" > work.txt' });
    assert.equal(fs.readFileSync(path.join(share, 'work.txt'), 'utf8').trim(), 'after the snapshot');

    // the restore puts it back, and the guest agrees
    await vmSnapshotService.restore(sessionId, 'checkpoint-1');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fs.readFileSync(path.join(share, 'work.txt'), 'utf8').trim(), 'before the snapshot',
      'the host share was restored');
    const after = await desktopVmService.call(sessionId, 'exec', { command: 'cat work.txt' });
    assert.equal(after.output.trim(), 'before the snapshot', 'the guest sees the restored content');

    console.log('vm-snapshot-live: ALL OK (boot/agent/snapshot/change/restore — real guest)');
  } finally {
    // Never leave a guest running, or the next boot may fail for lack of
    // resources.
    try { desktopVmService.stop(sessionId); } catch { /* already stopped */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
