'use strict';
/**
 * Sandbox service — owns one sandbox computer per agent session
 * (Manus SessionSupervisor pattern): desired-state reconcile, supervised
 * spawn with capped backoff, status reporting, hard cleanup.
 *
 * Each sandbox: a forked src/sandbox/host.js process with its own root dir
 * (workspace/.quansiox/sandboxes/<sessionId>/) and unix-socket JSON-RPC.
 */
const { fork } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { settingsService } = require('./settingsService');

const HOST = path.join(__dirname, '..', '..', 'sandbox', 'host.js');
const MAX_ATTEMPTS = 20;
const BACKOFF_MIN_MS = 3_000;
const BACKOFF_MAX_MS = 30_000;

/** sessionId -> { proc, sock, root, status, attempts, startedAt, pending: Map } */
const sandboxes = new Map();

function sandboxRoot(sessionId) {
  // settingsService normalizes empty/root workspaceRoot to a writable home
  // folder, so a Finder-launched packaged app never builds `/.quansiox/...`.
  const ws = settingsService.workspaceRoot();
  return path.join(ws, '.quansiox', 'sandboxes', sessionId);
}

/** Socket path must stay under the ~104-char unix limit → short, in tmpdir. */
function sockPathFor(sessionId) {
  const os = require('node:os');
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha1').update(sessionId).digest('hex').slice(0, 10);
  return path.join(os.tmpdir(), `qx-sb-${hash}.sock`);
}

const DESKTOP_RPC = new Set(['exec', 'fs.read', 'fs.write', 'fs.listdir', 'ping']);

function call(entry, method, params, sessionId, timeoutMs = 60_000) {
  if (entry?.kind === 'vm') {
    // Headless Linux VM sandbox — TSV protocol over the VM's stdio.
    return require('./vmSandboxService').vmSandbox.callVm(sessionId, method, params);
  }
  if (entry?.kind === 'desktop-vm') {
    // Unified runtime: the desktop guest also serves shell/file RPC over its
    // own vsock channel, so a session has ONE Linux box for both GUI and
    // sandbox work.
    if (method === 'exec.cancel') {
      return Promise.resolve(require('./desktopVmService').desktopVmService.cancel(params?.jobId ?? params?.p));
    }
    return require('./desktopVmService').desktopVmService.call(sessionId, method, params);
  }
  // A live per-bot desktop is that session's Linux box even when the configured
  // sandbox is the process jail (the bot booted its VM for computer use):
  // keep shell/files in the same guest the agent sees, terminal included.
  if (sessionId && DESKTOP_RPC.has(method)) {
    try {
      const desktop = require('./desktopVmService').desktopVmService.get(sessionId);
      if (desktop?.ready) return require('./desktopVmService').desktopVmService.call(sessionId, method, params);
    } catch { /* fall back to the process sandbox */ }
  }
  if (sessionId && method === 'exec.cancel') {
    const desktop = (() => { try { return require('./desktopVmService').desktopVmService.get(sessionId); } catch { return null; } })();
    if (desktop?.ready) {
      // The guest agent runs each command in its own forked process, so
      // cancelling really kills the work instead of just abandoning it.
      return Promise.resolve(require('./desktopVmService').desktopVmService.cancel(params?.jobId ?? params?.p));
    }
  }
  return new Promise((resolve, reject) => {
    if (!entry.sockPath) return reject(new Error('sandbox not ready'));
    const id = `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sock = net.connect(entry.sockPath);
    let buffer = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`sandbox ${method} timed out`));
    }, timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify({ id, method, params })}\n`));
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      sock.destroy();
      clearTimeout(timer);
      try {
        const msg = JSON.parse(line);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      } catch (error) {
        reject(error);
      }
    });
    sock.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Tell every window the session computer's status changed. */
function publishStatus(sessionId) {
  if (!sessionId) return;
  try {
    const { emitEvent } = require('../ipc/emitEvent');
    emitEvent('sandbox', 'onStatus', sessionId);
  } catch { /* plain-node tests have no BrowserWindow */ }
}

/** Desired-state entry point: ensure a sandbox exists+ready for the session.
 * sandboxMode: 'vm' = Linux VM (kernel isolation), 'sandboxed' = forked host
 * process with seatbelt writes, 'off' = raw host tools. */
async function ensure(sessionId) {
  const settings = settingsService.load();
  const previous = sandboxes.get(sessionId);
  const previousIsVm = previous?.kind === 'vm' || previous?.kind === 'desktop-vm';
  if (previous && (settings.sandboxMode === 'off' || previousIsVm !== (settings.sandboxMode === 'vm'))) {
    await stop(sessionId);
  }
  if (settings.sandboxMode === 'off') {
    publishStatus(sessionId);
    return null;
  }

  const root = sandboxRoot(sessionId);
  fs.mkdirSync(root, { recursive: true });

  if (settings.sandboxMode === 'vm') {
    const registered = sandboxes.get(sessionId);
    if (registered?.kind === 'vm' && registered.status === 'ready' && registered.proc?.exitCode === null) {
      publishStatus(sessionId);
      return registered;
    }
    const { desktopVmService } = require('./desktopVmService');
    // One Linux box per session: prefer the desktop guest (GUI + shell/files
    // over one virtiofs /share) and fall back to the headless sandbox VM only
    // when the desktop images are missing.
    if (desktopVmService.available()) {
      const entry = await desktopVmService.boot({ sessionId, shareDir: root });
      const computer = { kind: 'desktop-vm', status: entry.ready ? 'ready' : 'starting', root, sockPath: null, proc: entry.proc, attempts: 0, startedAt: entry.startedAt };
      sandboxes.set(sessionId, computer);
      entry.proc.once('exit', () => {
        if (sandboxes.get(sessionId) === computer) {
          sandboxes.delete(sessionId);
          publishStatus(sessionId);
        }
      });
      publishStatus(sessionId);
      return computer;
    }
    const { vmSandbox } = require('./vmSandboxService');
    if (!vmSandbox.available()) throw new Error('VM sandbox unavailable (missing vm/qx-vm or kernel image)');
    const entry = await vmSandbox.ensureVm(sessionId, root);
    const computer = { kind: 'vm', status: entry.ready ? 'ready' : 'starting', root, sockPath: null, proc: entry.proc, attempts: 0, startedAt: entry.startedAt };
    sandboxes.set(sessionId, computer);
    entry.proc.once('exit', () => {
      if (sandboxes.get(sessionId) === computer) {
        sandboxes.delete(sessionId);
        publishStatus(sessionId);
      }
    });
    publishStatus(sessionId);
    return computer;
  }

  let entry = sandboxes.get(sessionId);
  if (entry && entry.status === 'ready' && entry.proc?.exitCode === null) {
    publishStatus(sessionId);
    return entry;
  }

  const sockPath = sockPathFor(sessionId);

  entry = {
    proc: null,
    sockPath,
    root,
    status: 'starting',
    attempts: (entry?.attempts ?? 0) + 1,
    startedAt: Date.now(),
  };
  sandboxes.set(sessionId, entry);

  await new Promise((resolve) => {
    const proc = fork(HOST, [], {
      env: {
        ...process.env,
        QUANSIOX_SANDBOX_ROOT: root,
        QUANSIOX_SANDBOX_SOCK: sockPath,
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    entry.proc = proc;
    const timer = setTimeout(() => {
      entry.status = 'failed: startup timeout';
      resolve();
    }, 10_000);
    proc.on('message', (msg) => {
      if (msg?.type === 'sandboxReady') {
        clearTimeout(timer);
        entry.status = 'ready';
        entry.attempts = 0;
        resolve();
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (sandboxes.get(sessionId) === entry && entry.status !== 'stopped') {
        entry.status = `exited (${code ?? 'signal'})`;
        // Manus-style capped backoff respawn (lazy: on next ensure()).
        if (entry.attempts < MAX_ATTEMPTS) {
          const delay = Math.min(BACKOFF_MIN_MS * 2 ** Math.min(entry.attempts, 4), BACKOFF_MAX_MS);
          entry.respawnAt = Date.now() + delay;
          sandboxes.delete(sessionId);
          sandboxes.set(`__retry_${sessionId}`, entry); // keep attempt count
        }
      }
      resolve();
    });
  });
  publishStatus(sessionId);
  return entry;
}

async function stop(sessionId) {
  try {
    require('./vmSandboxService').vmSandbox.stopVm(sessionId);
  } catch {}
  const entry = sandboxes.get(sessionId);
  if (!entry) {
    publishStatus(sessionId);
    return true;
  }
  entry.status = 'stopped';
  try {
    if (entry.kind === 'desktop-vm') {
      require('./desktopVmService').desktopVmService.stop(sessionId);
    } else {
      if (entry.kind !== 'vm') await call(entry, 'shutdown', {}, sessionId, 3000).catch(() => {});
      entry.proc?.kill('SIGKILL');
    }
  } catch {}
  sandboxes.delete(sessionId);
  publishStatus(sessionId);
  return true;
}

function status() {
  return [...sandboxes.entries()].map(([id, e]) => ({
    sessionId: id.replace('__retry_', ''),
    status: e.status,
    root: e.root,
    pid: e.proc?.pid ?? null,
    attempts: e.attempts,
  }));
}

/** Identity and status of one session computer, including while it is idle.
 * The root is the computer this session will own. It is not host GUI control. */
function describe(sessionId) {
  const id = String(sessionId ?? '');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('invalid session');
  const entry = sandboxes.get(id);
  const mode = settingsService.load().sandboxMode;
  const isVm = entry?.kind === 'vm' || entry?.kind === 'desktop-vm' || mode === 'vm';
  // When a per-bot desktop is live, shell/files route into that same guest.
  let desktopLive = false;
  try {
    desktopLive = require('./desktopVmService').desktopVmService.get(id)?.ready === true;
  } catch { /* adapter not loaded */ }
  const runtimeKind = mode === 'off' ? 'host' : (isVm || desktopLive) ? 'linux-vm' : 'process-sandbox';
  // A live per-bot desktop is the session's display; when it is up it is the
  // same guest, so report it honestly instead of the old hard-coded false.
  let desktop = null;
  try { desktop = require('./computerRuntimeService').computerRuntimeService.status(id); } catch { /* runtime not loaded */ }
  const desktopDisplay = desktopLive || desktop?.phase === 'ready';
  return {
    sessionId: id,
    identity: `computer:${id}`,
    root: sandboxRoot(id),
    status: entry?.status ?? 'idle',
    kind: 'session-computer',
    runtimeKind,
    desktopDisplay,
    desktopPhase: desktop?.phase ?? 'off',
    desktopUrl: desktopDisplay ? desktop.url : null,
    browserRuntime: desktopDisplay ? 'guest' : 'electron-host',
    distinctFrom: 'host-mac',
    pid: entry?.proc?.pid ?? null,
  };
}

function get(sessionId) {
  const entry = sandboxes.get(sessionId);
  if (entry?.status === 'ready' && entry.proc?.exitCode === null) return entry;
  return null;
}

module.exports = {
  sandboxService: { ensure, stop, status, describe, get, call, sandboxRoot },
};
