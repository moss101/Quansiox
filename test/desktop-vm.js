'use strict';
/* Desktop VM adapter test — boot orchestration + endpoint discovery with an
 * injected spawn + tmp sockDir (no VZ needed). The fake guest serves a real RFB
 * banner, so "ready" means the guest answers, not merely that the socket file
 * exists. Covers arg construction, readiness, timeout on a stalled boot,
 * idempotent re-boot, and stop cleanup. Node-only. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), net = require('node:net'), os = require('node:os'), path = require('node:path');
const { desktopVmService } = require('../src/main/services/desktopVmService');

async function run() {
  const servers = [];
  // Serve RFB at sockPath after `delay` ms (simulating x11vnc coming up).
  function serveRfb(sockPath, { delay = 60, banner = 'RFB 003.008\n' } = {}) {
    setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(sockPath), { recursive: true });
        const server = net.createServer((conn) => {
          conn.on('error', () => {});
          try { conn.write(banner); } catch {}
        });
        server.on('error', () => {});
        server.listen(sockPath);
        servers.push(server);
      } catch {}
    }, delay);
  }

  const spawned = [];
  desktopVmService.setSpawn((bin, args, opts) => {
    spawned.push({ bin, args, opts });
    const sockDir = args[args.indexOf('--socket-dir') + 1];
    serveRfb(path.join(sockDir, '5900.sock'));
    setTimeout(() => {
      try { fs.writeFileSync(path.join(sockDir, '9222.sock'), ''); } catch {}
    }, 60);
    return { pid: 1234, exitCode: null, on() {}, kill() {} };
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-dvm-'));
  const shareDir = path.join(tmp, 'share');
  const sockDir = path.join(tmp, 'sock');

  // 1. boot resolves only once the guest answers RFB
  const t0 = Date.now();
  const entry = await desktopVmService.boot({ sessionId: 'ds1', shareDir, sockDir, timeoutMs: 4000 });
  assert.strictEqual(entry.ready, true);
  assert.ok(Date.now() - t0 >= 60, 'waited for the guest RFB banner, not just the socket file');
  assert.strictEqual(entry.rfbSock, path.join(sockDir, '5900.sock'));
  assert.strictEqual(entry.cdpSock, path.join(sockDir, '9222.sock'));
  // arg construction
  const argStr = spawned[0].args.join(' ');
  assert.ok(/--kernel \S*desktop-Image/.test(argStr), 'boots the desktop image');
  assert.ok(/--initrd \S*desktop-initramfs\.cpio\.gz/.test(argStr), 'boots the desktop initramfs');
  assert.ok(argStr.includes(`--socket-dir ${sockDir}`), 'publishes RFB/CDP via --socket-dir');
  assert.ok(/--mem 4096/.test(argStr), 'desktop gets more RAM');
  assert.ok(spawned[0].bin.endsWith('qx-vm.next'), 'boots the desktop VM binary');

  // 2. idempotent re-boot returns the same ready entry (no double spawn)
  const again = await desktopVmService.boot({ sessionId: 'ds1', shareDir, sockDir });
  assert.strictEqual(again, entry, 're-boot returns the existing entry');
  assert.strictEqual(spawned.length, 1, 'no second spawn');

  // 3. rfbSockFor/list reflect the running desktop
  assert.strictEqual(desktopVmService.rfbSockFor('ds1'), entry.rfbSock);
  assert.ok(desktopVmService.list().some((d) => d.sessionId === 'ds1' && d.ready));

  // 4. stop cleans up
  assert.strictEqual(desktopVmService.stop('ds1'), true);
  assert.strictEqual(desktopVmService.get('ds1'), null);

  // 5. a socket file that never speaks RFB is NOT ready → boot times out
  desktopVmService.setSpawn(() => ({ pid: 0, exitCode: null, on() {}, kill() {} }));
  const deadSock = path.join(tmp, 'sock-dead');
  fs.mkdirSync(deadSock, { recursive: true });
  const deadServer = net.createServer((conn) => { conn.on('error', () => {}); conn.write('HTTP/1.0 400 Bad Request\r\n\r\n'); });
  deadServer.listen(path.join(deadSock, '5900.sock'));
  servers.push(deadServer);
  await assert.rejects(
    () => desktopVmService.boot({ sessionId: 'ds-dead', shareDir, sockDir: deadSock, timeoutMs: 700 }),
    /RFB endpoint did not appear/,
  );
  assert.strictEqual(desktopVmService.get('ds-dead'), null, 'dead endpoint cleaned up');

  for (const server of servers) { try { server.close(); } catch {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('desktop-vm test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
