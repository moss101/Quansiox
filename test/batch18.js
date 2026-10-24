'use strict';
/* Batch 18 — gateway connection protocol depth:
 *  - symbolic resolveGatewayConnection paths ('gateway', 'cookie-provider',
 *    'passkey-provider', 'local-exec-refresh') returning real descriptors,
 *  - AES-256-GCM payload sealing (sealLocalExecFile payloadJson round-trip,
 *    keyId mismatch + tamper detection),
 *  - sealed local-exec-refresh envelope carrying a real bootstrap token.
 * Electron-free; spawns a real exec daemon for the refresh path. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-batch18-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { settingsService } = require('../src/main/services/settingsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { execDaemonService } = require('../src/main/services/execDaemonService');
const { gatewayStateService } = require('../src/main/services/gatewayStateService');
const { cookieApprovalService } = require('../src/main/services/cookieApprovalService');

(async () => {
  settingsService.save({ workspaceRoot: tmp });

  // 1. sealLocalExecFile({payloadJson}) — real AES-256-GCM round-trip
  const payload = JSON.stringify({ hello: 'world', n: 42 });
  const sealed = await grokCompatService.dispatch('sealLocalExecFile', { payloadJson: payload });
  assert.strictEqual(sealed.status, 'ok');
  assert.strictEqual(sealed.alg, 'aes-256-gcm');
  assert.match(sealed.keyId, /^[0-9a-f]{16}$/);
  assert.ok(sealed.contents.length > 40);
  assert.strictEqual(execDaemonService.unsealPayload({ contents: sealed.contents, keyId: sealed.keyId }), payload, 'round-trip');

  // wrong keyId refused
  assert.throws(() => execDaemonService.unsealPayload({ contents: sealed.contents, keyId: 'deadbeefdeadbeef' }), /keyId mismatch/);
  // tampered ciphertext refused (GCM auth tag)
  const tampered = Buffer.from(sealed.contents, 'base64');
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => execDaemonService.unsealPayload({ contents: tampered.toString('base64'), keyId: sealed.keyId }), /unable to authenticate|bad decrypt|authenticate/i);
  // empty payload rejected; seal key is 0600
  assert.strictEqual((await grokCompatService.dispatch('sealLocalExecFile', { payloadJson: '' })).status, 'error');
  const keyMode = fs.statSync(path.join(tmp, 'exec-daemon', 'seal.key')).mode & 0o777;
  assert.strictEqual(keyMode, 0o600, 'seal key owner-only');

  // 2. file sealing path still works
  const f = path.join(tmp, 'artifact.txt');
  fs.writeFileSync(f, 'sealed artifact', { mode: 0o644 });
  const fileSealed = await grokCompatService.dispatch('sealLocalExecFile', { path: f });
  assert.strictEqual(fileSealed.sealed, true);
  assert.strictEqual(fileSealed.mode & 0o777, 0o600);
  assert.match(fileSealed.sha256, /^[0-9a-f]{64}$/);

  // 3. filesystem path resolution unchanged (workspace-root relative)
  fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'sub', 'x.txt'), 'x');
  const dir = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'sub' });
  assert.strictEqual(dir.kind, 'directory');
  const file = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'sub/x.txt' });
  assert.strictEqual(file.kind, 'file');
  const missing = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'nope' });
  assert.strictEqual(missing.kind, 'missing');
  assert.strictEqual((await grokCompatService.dispatch('resolveGatewayConnection', {})).status, 'error');

  // 4. symbolic 'gateway' — real gateway state
  const gw = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'gateway' });
  assert.strictEqual(gw.connection.kind, 'gateway');
  assert.strictEqual(gw.connection.connected, true);
  assert.strictEqual(gw.connection.transport, 'in-process');
  await grokCompatService.dispatch('setGatewayPaused', { paused: true });
  const gw2 = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'gateway' });
  assert.strictEqual(gw2.connection.connected, false, 'paused gateway reports disconnected');
  await grokCompatService.dispatch('setGatewayPaused', { paused: false });

  // 5. symbolic 'cookie-provider' — in-process service + live pending count
  cookieApprovalService.request({ requestId: 'req-18', origins: ['https://example.com'], agentId: 'agent-18' });
  const cookies = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'cookie-provider' });
  assert.strictEqual(cookies.connection.service, 'cookieApprovalService');
  assert.ok(cookies.connection.pending >= 1, 'pending approval visible');
  cookieApprovalService.cancel({ requestId: 'req-18' });

  // 6. symbolic 'passkey-provider' — honest unavailable
  const passkey = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'passkey-provider' });
  assert.strictEqual(passkey.status, 'unavailable');
  assert.strictEqual(passkey.scope, 'backend');

  // 7. symbolic 'local-exec-refresh' — no daemon → available:false
  const noDaemon = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'local-exec-refresh' });
  assert.strictEqual(noDaemon.available, false);

  // spawn a real daemon → sealed refresh envelope with a live bootstrap token
  const spawned = await execDaemonService.spawnLocalExecDaemon({ cwd: tmp });
  assert.strictEqual(spawned.status, 'ready');
  const refresh = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'local-exec-refresh' });
  assert.strictEqual(refresh.available, true);
  assert.strictEqual(refresh.daemon.id, spawned.id);
  const envelope = JSON.parse(execDaemonService.unsealPayload({ contents: refresh.contents, keyId: refresh.keyId }));
  assert.strictEqual(envelope.kind, 'local-exec-refresh');
  assert.strictEqual(envelope.daemonId, spawned.id);
  assert.strictEqual(envelope.sockPath, spawned.sock);
  assert.match(envelope.token, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(envelope.bootstrapPath), 'minted bootstrap file exists');
  assert.strictEqual(fs.statSync(envelope.bootstrapPath).mode & 0o777, 0o600);
  await execDaemonService.stopLocalExecDaemon();

  // 8. gateway notes route through unaffected; sanity on state reset
  gatewayStateService.resetForTests();
  assert.strictEqual(gatewayStateService.status().backendReturns, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('batch18 test: ALL OK (symbolic gateway paths + AES-GCM sealing + local-exec-refresh envelope)');
})().catch((e) => { console.error(e); process.exit(1); });
