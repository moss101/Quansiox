'use strict';
/**
 * Computer host service — supervises the out-of-process computer-use helper
 * (src/computer-helper/index.js). Port of Manus Studio's pattern stack:
 *
 *  - skillRecordingClient.startHost(): 0600 single-use bootstrap file with a
 *    32-byte control token, helper launched out-of-process, NDJSON JSON-RPC
 *    2.0 client over a unix socket (0600), authenticate handshake, 50×100ms
 *    connect retries, request timeouts (5s auth / 120s calls).
 *  - operatorManager supervision: capped exponential restart (3s·2^n cap
 *    10s, reset after 30s stable), orphan cleanup at startup, env whitelist.
 *  - AddonHelperLocator socket derivation: /tmp/<app>.<uid>.<sha256(...)[24]>.sock
 */
const { fork, spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const HELPER = path.join(__dirname, '..', '..', 'computer-helper', 'index.js');

/**
 * Native helper (Phase 2a) when it has been built; otherwise the JXA helper.
 * QUANSIOX_COMPUTER_HELPER_BIN overrides for development.
 */
function nativeHelperPath() {
  // QUANSIOX_COMPUTER_HELPER_KIND=jxa forces the AppleScript helper (tests).
  if (String(process.env.QUANSIOX_COMPUTER_HELPER_KIND || '').toLowerCase() === 'jxa') return null;
  const candidates = [
    process.env.QUANSIOX_COMPUTER_HELPER_BIN,
    path.join(__dirname, '..', '..', '..', 'build', 'QuansioxComputerHelper'),
    path.join(__dirname, '..', '..', '..', 'native', 'QuansioxComputerHelper'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}
const RESTART_BASE_MS = 3_000;
const RESTART_MAX_MS = 10_000;
const RESTART_RESET_MS = 30_000;
const CONNECT_ATTEMPTS = 50;
const CONNECT_DELAY_MS = 100;
const AUTH_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

class ComputerHostService {
  constructor() {
    this.child = null;
    this.socket = null; // active connection
    this.controlToken = null;
    this.socketPath = null;
    this.pending = new Map();
    this.nextId = 1;
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.stableSince = null;
    this.starting = null;
    this.shuttingDown = false;
    this.listeners = new Set(); // status listeners (renderer events)
    this.helperKind = null; // 'native' | 'jxa' after start
  }

  /** Socket path derived Manus-style from the app identity + profile. */
  _deriveSocketPath() {
    const profile = process.env.QUANSIOX_USER_DATA_DIR
      ?? path.join(os.homedir(), 'Library', 'Application Support', 'Quansiox');
    const digest = crypto.createHash('sha256')
      .update('im.quansiox.desktop').update('\0').update(profile)
      .digest('hex').slice(0, 24);
    const base = os.tmpdir(); // respects TMPDIR; short paths (macOS 104 limit)
    return path.join(base, `qx-cu.${process.getuid()}.${digest}.sock`);
  }

  _runtimeDir() {
    const profile = process.env.QUANSIOX_USER_DATA_DIR
      ?? path.join(os.homedir(), 'Library', 'Application Support', 'Quansiox');
    const dir = path.join(profile, 'computer-helper', 'runtime');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** One-shot single-use bootstrap file (Manus skill-recorder pattern). */
  _writeBootstrap() {
    const dir = this._runtimeDir();
    const file = path.join(dir, `bootstrap-${crypto.randomBytes(16).toString('hex')}.json`);
    this.controlToken = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      profile: path.dirname(path.dirname(dir)),
      controlToken: this.controlToken,
      deviceKind: 'desktop',
    }), { mode: 0o600, flag: 'wx' });
    return file;
  }

  /** Ensure the helper is up and authenticated; returns the RPC surface. */
  ensure() {
    if (this.socket && this.child && this.child.exitCode === null) {
      return Promise.resolve(this);
    }
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    if (this.shuttingDown) throw new Error('computer host is shutting down');
    this._cleanupSocketFile();
    const bootstrap = this._writeBootstrap();
    this.socketPath = this._deriveSocketPath();
    const env = {
      ...this._whitelistedEnv(),
      QUANSIOX_COMPUTER_HELPER_BOOTSTRAP: bootstrap,
      QUANSIOX_COMPUTER_HELPER_SOCKET: this.socketPath,
    };
    const native = nativeHelperPath();
    this.helperKind = native ? 'native' : 'jxa';
    let child;
    try {
      child = native
        ? spawn(native, [], { env, stdio: ['ignore', 'ignore', 'pipe'] })
        : fork(HELPER, [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    } catch (error) {
      fs.rmSync(bootstrap, { force: true });
      throw error;
    }
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => process.stdout.write(`[computer-helper] ${c}`));
    // Native helpers announce readiness by binding the socket; the JXA helper
    // also sends an IPC message. Wait for whichever arrives first.
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const timeout = setTimeout(() => { cleanup(); reject(new Error('helper startup timeout')); }, 10_000);
      const poll = setInterval(() => {
        if (fs.existsSync(this.socketPath)) { cleanup(); resolve(); }
        else if (Date.now() - started > 10_000) { cleanup(); reject(new Error('helper startup timeout')); }
      }, 50);
      const onMsg = (msg) => {
        if (msg?.type === 'listening') { cleanup(); resolve(); }
      };
      const onExit = (code) => { cleanup(); reject(new Error(`helper exited during startup (${code})`)); };
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(poll);
        child.off('message', onMsg);
        child.off('exit', onExit);
      };
      child.on('message', onMsg);
      child.on('exit', onExit);
    });
    // …then connect and authenticate (Manus connectToHelper + authenticate).
    const sock = await this._connect(this.socketPath);
    this.socket = sock;
    sock.setEncoding('utf8');
    let buffer = '';
    sock.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let res;
        try { res = JSON.parse(line); } catch { continue; }
        if (res.id === undefined) continue;
        const waiter = this.pending.get(res.id);
        if (!waiter) continue;
        this.pending.delete(res.id);
        clearTimeout(waiter.timer);
        if (res.error) waiter.reject(Object.assign(new Error(res.error.message), { code: res.error.code }));
        else waiter.resolve(res.result);
      }
    });
    const closed = () => {
      if (this.socket !== sock) return;
      this.socket = null;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('computer helper connection closed'));
      }
      this.pending.clear();
      this._scheduleRestart();
    };
    sock.on('close', closed);
    sock.on('error', closed);
    child.on('exit', () => { sock.destroy(); });
    try {
      await this.request('initialize', {}, 5_000);
      await this.request('computer/authenticate', { controlToken: this.controlToken }, AUTH_TIMEOUT_MS);
    } catch (error) {
      this._teardown();
      throw error;
    }
    this.stableSince = Date.now();
    return this;
  }

  _whitelistedEnv() {
    // operatorManager pattern: children see only what they need.
    const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'QUANSIOX_USER_DATA_DIR', 'QUANSIOX_OSASCRIPT_BIN', 'QUANSIOX_COMPUTER_BLOCKLIST'];
    const env = {};
    for (const key of keep) if (process.env[key]) env[key] = process.env[key];
    return env;
  }

  _connect(socketPath) {
    let lastError;
    return new Promise(async (resolve, reject) => {
      for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
        try {
          const sock = await new Promise((res, rej) => {
            const s = net.createConnection(socketPath);
            const onErr = (e) => { s.destroy(); rej(e); };
            s.once('connect', () => { s.off('error', onErr); res(s); });
            s.once('error', onErr);
          });
          return resolve(sock);
        } catch (error) {
          lastError = error;
          await new Promise((r) => setTimeout(r, CONNECT_DELAY_MS));
        }
      }
      reject(new Error(`cannot connect to computer helper: ${lastError?.message ?? 'timeout'}`));
    });
  }

  /** NDJSON JSON-RPC request with per-call timeout. */
  async request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    await this.ensure();
    if (!this.socket) throw new Error('computer helper not connected');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`computer helper call timed out: ${method}`), { code: -32000 }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  _scheduleRestart() {
    if (this.shuttingDown || this.restartTimer) return;
    // Reset the backoff after a stable run (operatorManager pattern).
    if (this.stableSince && Date.now() - this.stableSince > RESTART_RESET_MS) {
      this.restartAttempts = 0;
    }
    const delay = Math.min(RESTART_BASE_MS * 2 ** this.restartAttempts, RESTART_MAX_MS);
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.ensure().catch(() => this._scheduleRestart());
    }, delay);
    this.restartTimer.unref?.();
  }

  _cleanupSocketFile() {
    if (this.socketPath) { try { fs.rmSync(this.socketPath, { force: true }); } catch {} }
  }

  _teardown() {
    this.socket?.destroy();
    this.socket = null;
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
    this.helperKind = null;
    this._cleanupSocketFile();
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this._teardown();
  }

  /** Recover: drop any live helper and re-arm supervision (the next request
   *  re-spawns and re-authenticates). Unlike shutdown(), stays usable. */
  restart() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this._teardown();
    this.shuttingDown = false;
    this.restartAttempts = 0;
    return true;
  }

  status() {
    return {
      running: Boolean(this.socket && this.child && this.child.exitCode === null),
      pid: this.child?.pid ?? null,
      socketPath: this.socketPath,
      helper: this.helperKind,
      restartAttempts: this.restartAttempts,
    };
  }
}

module.exports = { nativeHelperPath, computerHostService: new ComputerHostService(), ComputerHostService };
