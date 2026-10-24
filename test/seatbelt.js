'use strict';
/* Seatbelt profiles + daemon confinement — the exec-daemon runs agent shell
 * commands under a deny-by-default SBPL profile on macOS: workspace writes are
 * allowed, everything else is not, and network is opt-in. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-seatbelt-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { seatbeltProfile, seatbeltAvailable } = require('../src/exec-daemon/seatbelt');
const { execDaemonService } = require('../src/main/services/execDaemonService');
const { execService } = require('../src/main/services/execService');

(async () => {
  // 1. profile shape: deny-by-default, workspace writable, no network by default
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-seatbelt-ws-'));
  const profile = seatbeltProfile({ workspace: ws, workdir: ws });
  assert.match(profile, /^\(version 1\)/, 'SBPL header');
  assert.match(profile, /\(deny default\)/, 'deny-by-default');
  assert.match(profile, /\(allow file-read\*\)/, 'reads allowed for toolchains');
  assert.match(profile, /\(allow file-write\*/, 'writes are gated');
  assert.ok(profile.includes('(subpath "/tmp")'), 'temp writable');
  assert.match(profile, /\(deny network\*\)/, 'no network unless requested');
  assert.ok(!profile.includes('(allow network*)'), 'network stays denied');
  const netProfile = seatbeltProfile({ workspace: ws, allowNetwork: true });
  assert.match(netProfile, /\(allow network\*\)/, 'network opt-in');

  // 2. paths with quotes cannot break out of the SBPL string literal
  const evil = seatbeltProfile({ workspace: '/tmp/a" ) (allow file-write* (subpath "/' });
  assert.ok(evil.includes('\\"'), 'quotes escaped in profile');

  if (!seatbeltAvailable()) {
    console.log('seatbelt test: ALL OK (profile only — sandbox-exec unavailable)');
    return;
  }

  // 3. real enforcement through the local-exec daemon
  const inWs = await execDaemonService.exec('echo hello > ok.txt && cat ok.txt', { cwd: ws, sandbox: true, workspace: ws });
  assert.strictEqual(inWs.exitCode, 0, `workspace write should succeed: ${inWs.stderr}`);
  assert.strictEqual(inWs.stdout.trim(), 'hello');
  assert.strictEqual(inWs.sandboxed, true, 'daemon reports it ran under Seatbelt');
  assert.ok(fs.existsSync(path.join(ws, 'ok.txt')), 'file really landed in the workspace');

  const escapeTarget = path.join(os.homedir(), '.qx-seatbelt-escape.txt');
  const escape = await execDaemonService.exec(`echo pwn > ${escapeTarget}`, { cwd: ws, sandbox: true, workspace: ws });
  assert.notStrictEqual(escape.exitCode, 0, 'write outside the workspace is denied');
  assert.match(`${escape.stderr}${escape.stdout}`, /not permitted|denied|Operation/i);
  assert.strictEqual(fs.existsSync(escapeTarget), false, 'no file created outside the workspace');

  const net = await execDaemonService.exec('curl -s -m 3 https://example.com >/dev/null; echo rc=$?', { cwd: ws, sandbox: true, workspace: ws });
  assert.match(net.stdout, /rc=[1-9]/, 'network denied by default in the sandbox');

  await execDaemonService.stopLocalExecDaemon();

  // 4. execService can route through the daemon on request and formats output
  const routed = await execService.run('echo routed', ws, 10_000, { daemon: true, sandbox: true, workspace: ws });
  assert.match(routed, /^\[exit 0\] \[sandboxed\]/, `daemon-routed output is annotated: ${routed}`);
  assert.match(routed, /routed/);
  const direct = await execService.run('echo direct', ws, 10_000, { daemon: false });
  assert.match(direct, /^\[exit 0\]\ndirect/, 'default path stays unchanged');
  await execDaemonService.stopLocalExecDaemon();

  console.log('seatbelt test: ALL OK (profile + daemon confinement + execService routing)');
})().catch((e) => { console.error(e); process.exit(1); });
