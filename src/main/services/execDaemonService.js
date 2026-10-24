'use strict';
/**
 * Exec-daemon supervisor — owns the long-lived local-exec daemon
 * (src/exec-daemon/index.js): spawn with a single-use 0600 bootstrap token,
 * owner-only unix socket, call/reuse/stop, and capability-restricted
 * credential minting + file sealing.
 *
 * Real behavior:
 *  - spawnLocalExecDaemon   → forks the daemon, waits ready, returns identity
 *  - mintLocalExecDaemonCredential → fresh 32-byte token in a 0600 file (unlinked by the daemon)
 *  - sealLocalExecFile      → chmod 0600 + fsync + sha256 digest (owner-only, durable)
 *  - exec/status/stop       → operational surface used by the app and tests
 */
const { fork } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DAEMON = path.join(__dirname, '..', '..', 'exec-daemon', 'index.js');

let daemon = null; // { proc, id, sockPath, token, startedAt, status }

function userDataDir() {
  return require('./userData').userDataDir();
}

function sockPathFor(id) {
  const hash = crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 10);
  return path.join(os.tmpdir(), `qx-xd-${hash}.sock`);
}

/** Mint a fresh control token; returns { id, token, path } (file is 0600). */
function mintCredential(id = `exec-${Date.now().toString(36)}`) {
  const token = crypto.randomBytes(32).toString('hex');
  const dir = path.join(userDataDir(), 'exec-daemon');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.bootstrap.json`);
  fs.writeFileSync(p, JSON.stringify({ token, id, mintedAt: Date.now() }), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
  return { id, token, path: p };
}

function callDaemon(sockPath, token, op, params = {}, timeoutMs = 30_000, { partial = false } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled && !partial) { settled = true; sock.destroy(); reject(new Error(`exec daemon ${op} timed out`)); } }, timeoutMs);
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ auth: token })}\n`);
      sock.write(`${JSON.stringify({ id: 'r1', op, ...params })}\n`);
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error && !settled) { settled = true; clearTimeout(timer); sock.destroy(); reject(new Error(msg.error)); return; }
        if (msg.result?.ok === true) continue; // auth ack
        if (msg.result?.started) continue; // partial exec ack
        if (msg.result?.jobId && msg.result?.exitCode !== undefined) {
          settled = true;
          clearTimeout(timer);
          sock.destroy();
          resolve(msg.result);
          return;
        }
        if (msg.result !== undefined && !settled) {
          settled = true;
          clearTimeout(timer);
          sock.destroy();
          resolve(msg.result);
          return;
        }
      }
    });
    sock.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

async function spawnLocalExecDaemon({ cwd, id } = {}) {
  if (daemon && daemon.status === 'ready' && daemon.proc?.exitCode === null) {
    return describe();
  }
  await stopLocalExecDaemon().catch(() => {});

  const cred = mintCredential(id);
  const sockPath = sockPathFor(cred.id);
  try { fs.rmSync(sockPath, { force: true }); } catch {}

  const proc = fork(DAEMON, [], {
    env: {
      ...process.env,
      QUANSIOX_EXEC_DAEMON_SOCK: sockPath,
      QUANSIOX_EXEC_DAEMON_BOOTSTRAP: cred.path,
      QUANSIOX_EXEC_DAEMON_CWD: cwd || process.cwd(),
      QUANSIOX_EXEC_DAEMON_ID: cred.id,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  daemon = { proc, id: cred.id, sockPath, token: cred.token, startedAt: Date.now(), status: 'starting' };

  // Detach: the daemon must never hold the host app's event loop open. On host
  // exit the IPC channel closes and the daemon shuts itself down (see
  // src/exec-daemon/index.js `process.on('disconnect', shutdown)`).
  proc.unref();
  try { proc.channel?.unref(); } catch {}

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { daemon.status = 'failed: startup timeout'; resolve(); }, 10_000);
    proc.on('message', (msg) => {
      if (msg?.type === 'execDaemonReady') {
        clearTimeout(timer);
        daemon.status = 'ready';
        resolve();
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (daemon?.proc === proc) daemon.status = `exited (${code ?? 'signal'})`;
      resolve();
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      daemon.status = `error: ${error.message}`;
      reject(error);
    });
  });

  return describe();
}

async function stopLocalExecDaemon() {
  if (!daemon) return { stopped: false };
  try { await callDaemon(daemon.sockPath, daemon.token, 'shutdown', {}, 3000); } catch {}
  try { daemon.proc?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(daemon.sockPath, { force: true }); } catch {}
  daemon = null;
  return { stopped: true };
}

function describe() {
  if (!daemon) return { status: 'not-spawned' };
  return {
    id: daemon.id,
    status: daemon.status,
    pid: daemon.proc?.pid ?? null,
    sock: daemon.sockPath,
    startedAt: daemon.startedAt,
  };
}

function status() { return describe(); }

/** Run a command through the daemon (spawns one on demand). */
async function exec(command, { cwd, timeoutMs, env, sandbox, workspace, allowNetwork, denyNetworkHosts, allowDomains, denyDomains, extraWritable, profile } = {}) {
  if (!daemon || daemon.status !== 'ready') await spawnLocalExecDaemon({ cwd });
  if (daemon.status !== 'ready') throw new Error(`exec daemon unavailable (${daemon.status})`);
  const params = { command, cwd, timeoutMs, env };
  if (sandbox === true) {
    params.sandbox = true;
    if (workspace) params.workspace = workspace;
    if (allowNetwork === true) params.allowNetwork = true;
    if (Array.isArray(denyNetworkHosts) && denyNetworkHosts.length) params.denyNetworkHosts = denyNetworkHosts;
    if (Array.isArray(allowDomains) && allowDomains.length) params.allowDomains = allowDomains;
    if (Array.isArray(denyDomains) && denyDomains.length) params.denyDomains = denyDomains;
    if (Array.isArray(extraWritable)) params.extraWritable = extraWritable;
    if (profile) params.profile = profile;
  }
  return callDaemon(daemon.sockPath, daemon.token, 'exec', params, Math.max(Number(timeoutMs) || 120_000, 5_000) + 5_000);
}

/** Human-readable daemon description including Seatbelt availability. */
function capability() {
  const { seatbeltAvailable, seatbeltProfile } = require('../../exec-daemon/seatbelt');
  return { seatbelt: seatbeltAvailable(), canProfile: typeof seatbeltProfile === 'function', daemon: describe() };
}

/**
 * Sealing key — 32 random bytes in userData/exec-daemon/seal.key (0600).
 * keyId is a stable digest of the key, so consumers can tell whether they
 * hold the matching key before attempting to unseal.
 */
function sealKey() {
  const dir = path.join(userDataDir(), 'exec-daemon');
  const file = path.join(dir, 'seal.key');
  let key;
  try {
    key = fs.readFileSync(file);
  } catch {
    key = crypto.randomBytes(32);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  if (key.length !== 32) throw new Error('seal key corrupt');
  const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return { key, keyId };
}

/** AES-256-GCM seal of a JSON payload → { keyId, alg, contents (base64) }. */
function sealPayload(payloadJson) {
  const text = String(payloadJson ?? '');
  if (!text) throw new Error('payloadJson is required');
  const { key, keyId } = sealKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { keyId, alg: 'aes-256-gcm', contents: Buffer.concat([iv, tag, ct]).toString('base64') };
}

/** Unseal a payload sealed by sealPayload; throws on keyId mismatch or tamper. */
function unsealPayload({ contents, keyId } = {}) {
  const buf = Buffer.from(String(contents ?? ''), 'base64');
  if (buf.length < 12 + 16) throw new Error('sealed contents too short');
  const { key, keyId: localKeyId } = sealKey();
  if (keyId && keyId !== localKeyId) throw new Error(`seal keyId mismatch (have ${localKeyId})`);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Seal a file: enforce owner-only 0600, fsync, and return its digest.
 * Real semantics — the file is durable and readable only by the owner.
 */
function sealFile(filePath) {
  const p = path.resolve(String(filePath ?? ''));
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('not a file');
  fs.chmodSync(p, 0o600);
  const fd = fs.openSync(p, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const after = fs.statSync(p);
  return { path: p, sealed: true, mode: after.mode & 0o777, size: after.size, sha256: hash, mtimeMs: after.mtimeMs };
}

module.exports = {
  execDaemonService: {
    spawnLocalExecDaemon, stopLocalExecDaemon, mintCredential, status, describe, exec, capability, sealFile, sockPathFor,
    sealPayload, unsealPayload,
  },
};
