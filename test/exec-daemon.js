'use strict';
/* Local-exec daemon + diagnostics + process ops — real local implementations
 * (Grok 0.71: spawnLocalExecDaemon, mintLocalExecDaemonCredential,
 * sealLocalExecFile, isProcessAlive, terminateProcess, reportProcessCrash).
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-exec-daemon-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { execDaemonService } = require('../src/main/services/execDaemonService');
const { diagnosticsService } = require('../src/main/services/diagnosticsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  // 1. mint credential → 0600 bootstrap file with a 64-hex token
  const cred = execDaemonService.mintCredential('test-daemon');
  assert.match(cred.token, /^[0-9a-f]{64}$/, '32-byte hex token');
  assert.strictEqual(fs.statSync(cred.path).mode & 0o777, 0o600, 'bootstrap 0600');

  // 2. seal a file → owner-only mode, durable, digest
  const f = path.join(tmp, 'payload.sh');
  fs.writeFileSync(f, '#!/bin/bash\necho sealed\n', { mode: 0o644 });
  const sealed = execDaemonService.sealFile(f);
  assert.strictEqual(sealed.mode, 0o600, 'sealed file is owner-only');
  assert.strictEqual(sealed.sha256, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));

  // 3. daemon spawn → ready, socket is 0600, its bootstrap is consumed by the daemon
  const spawned = await execDaemonService.spawnLocalExecDaemon({ cwd: tmp });
  assert.strictEqual(spawned.status, 'ready', JSON.stringify(spawned));
  assert.ok(spawned.pid > 0);
  assert.strictEqual(fs.statSync(spawned.sock).mode & 0o777, 0o600, 'daemon socket 0600');
  const bootDir = path.join(tmp, 'exec-daemon');
  const bootsLeft = fs.readdirSync(bootDir).filter((f) => f.endsWith('.bootstrap.json'));
  assert.deepStrictEqual(bootsLeft, ['test-daemon.bootstrap.json'], 'only the manual credential remains; the daemon unlinked its own bootstrap');

  // 4. exec through the daemon — real output + exit code
  const out = await execDaemonService.exec('echo hello-daemon; pwd');
  assert.strictEqual(out.exitCode, 0);
  assert.match(out.stdout, /hello-daemon/);
  assert.match(out.stdout, new RegExp(tmp.split('/').pop()), 'cwd is the daemon cwd');

  // failing command surfaces its exit code
  const bad = await execDaemonService.exec('exit 3', { timeoutMs: 5000 });
  assert.strictEqual(bad.exitCode, 3);

  // 5. compat surface — process + diagnostics
  const aliveSelf = await grokCompatService.dispatch('isProcessAlive', { pid: process.pid });
  assert.strictEqual(aliveSelf.alive, true);
  const aliveDead = await grokCompatService.dispatch('isProcessAlive', { pid: 999999 });
  assert.strictEqual(aliveDead.alive, false);

  const sleeper = spawn('sleep', ['30']);
  await new Promise((r) => setTimeout(r, 150));
  const term = await grokCompatService.dispatch('terminateProcess', { pid: sleeper.pid, signal: 'SIGKILL' });
  assert.strictEqual(term.terminated, true);
  await new Promise((r) => setTimeout(r, 150));
  const after = await grokCompatService.dispatch('isProcessAlive', { pid: sleeper.pid });
  assert.strictEqual(after.alive, false, 'sleeper is gone');

  const crash = await grokCompatService.dispatch('reportProcessCrash', { pid: 4242, exitCode: 139, signal: 'SIGSEGV', command: 'node worker.js', reason: 'segfault' });
  assert.strictEqual(crash.status, 'ok');
  const events = diagnosticsService.list({ kind: 'process_crash' });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].detail.pid, 4242);
  assert.strictEqual(fs.statSync(diagnosticsService.file()).mode & 0o777, 0o600, 'diagnostics 0600');
  const summary = diagnosticsService.summary();
  assert.strictEqual(summary.byKind.process_crash, 1);

  // 6. dispatch-level daemon ops + seal
  const st = await grokCompatService.dispatch('localExecDaemonStatus', {});
  assert.strictEqual(st.status, 'ok');
  assert.strictEqual(st.daemon.status, 'ready');
  const spawnAgain = await grokCompatService.dispatch('spawnLocalExecDaemon', {});
  assert.strictEqual(spawnAgain.daemon.status, 'ready', 'spawn reuses the running daemon');
  const seal2 = await grokCompatService.dispatch('sealLocalExecFile', { path: f });
  assert.strictEqual(seal2.sealed, true);
  const sealedMissing = await grokCompatService.dispatch('sealLocalExecFile', { path: path.join(tmp, 'nope.txt') });
  assert.strictEqual(sealedMissing.status, 'error');

  // 7. stop daemon
  const stopped = await execDaemonService.stopLocalExecDaemon();
  assert.strictEqual(stopped.stopped, true);
  assert.strictEqual(execDaemonService.status().status, 'not-spawned');
  assert.ok(!fs.existsSync(spawned.sock), 'socket cleaned up');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('exec-daemon test: ALL OK (spawn/mint/seal/exec/process/diagnostics)');
})().catch(async (e) => { try { await execDaemonService.stopLocalExecDaemon(); } catch {} console.error(e); process.exit(1); });
