'use strict';
/**
 * Desktop VM adapter — wires the (already-built + prototyped) Quansiox desktop
 * guest to the app. The desktop guest is Alpine + Xvfb + openbox + Chromium +
 * x11vnc; `qx-vm.next` publishes its **RFB (VNC, port 5900)** and **CDP (9222)**
 * endpoints as 0600 Unix sockets under `--socket-dir` (virtio-socket backed).
 *
 * `boot` spawns qx-vm.next with the desktop assets and resolves only after the
 * guest actually answers the RFB handshake. The socket *file* is created at VM
 * start (≈100 ms), long before Xvfb/x11vnc are up (≈3 s); treating file
 * existence as readiness made the viewer/console race a dead vsock port. The
 * readiness probe is injectable for tests.
 *
 * Verify note: VM boot/x11vnc was observed live (guest-desktop screenshot, RFB
 * greeting); here `spawn` + `probe` are injectable, so the orchestration +
 * endpoint discovery are unit-tested offline.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const VM_DIR = path.join(__dirname, '..', '..', '..', 'vm');
const QX_VM_NEXT = path.join(VM_DIR, 'qx-vm.next');
const DESKTOP_IMAGE = path.join(VM_DIR, 'desktop-Image');
const DESKTOP_INITRD = path.join(VM_DIR, 'desktop-initramfs.cpio.gz');

let _spawn = spawn;
function setSpawn(fn) { _spawn = typeof fn === 'function' ? fn : spawn; }

/** Connect once and require the server's 12-byte RFB version banner. */
function probeRfb(sockPath, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(ok === true);
    };
    const sock = net.connect(sockPath);
    sock.setTimeout(Math.max(100, Number(timeoutMs) || 800), () => done(false));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 12) done(/^RFB \d{3}\.\d{3}\n$/.test(buf.subarray(0, 12).toString('latin1')));
    });
    sock.on('error', () => done(false));
    sock.on('close', () => done(false));
  });
}

/** sessionId -> { sessionId, sockDir, rfbSock, cdpSock, proc, ready, readyPromise, startedAt, pending, buffer, nextId } */
const desktops = new Map();

/**
 * The desktop guest hosts BOTH the GUI (RFB/CDP sockets) and the shell/file
 * RPC (a dedicated vsock channel to the guest agent daemon). That makes it the
 * single per-session Linux box: computerRuntimeService drives the screen,
 * sandboxService runs exec/fs — one VM, one /share.
 *
 * The console is now only a boot signal: the RPC used to ride it, which
 * serialised every request behind the previous one and mixed kernel
 * printk output into the protocol stream.
 */
/** Where the VM host writes the machine-state files. */
function snapshotRoot() {
  const base = process.env.QUANSIOX_USER_DATA_DIR
    ?? path.join(os.homedir(), 'Library', 'Application Support', 'Quansiox');
  const dir = path.join(base, 'vm-snapshots');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  return dir;
}

function available() {
  return [QX_VM_NEXT, DESKTOP_IMAGE, DESKTOP_INITRD].every((p) => fs.existsSync(p));
}
function get(sessionId) { return desktops.get(String(sessionId)) || null; }

/** Guest vCPUs: half the host cores (bounded), override via QUANSIOX_VM_CPUS. */
function defaultCpus() {
  const override = Number(process.env.QUANSIOX_VM_CPUS);
  if (Number.isInteger(override) && override > 0) return Math.min(8, override);
  try { return Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2) || 1)); } catch { return 1; }
}

function boot({ sessionId, shareDir, memMB = 4096, cpus, timeoutMs = 60_000, sockDir: injectedSockDir } = {}) {
  const sid = String(sessionId ?? '');
  if (!sid) throw new Error('desktop boot needs a sessionId');
  const existing = desktops.get(sid);
  if (existing && (existing.ready || existing.readyPromise)) return existing.ready ? Promise.resolve(existing) : existing.readyPromise;
  if (!fs.existsSync(shareDir)) fs.mkdirSync(shareDir, { recursive: true });
  const sockDir = injectedSockDir || path.join(os.tmpdir(), `qx-desktop-${process.uid ?? 0}-${Math.random().toString(36).slice(2, 8)}`);
  const entry = {
    sessionId: sid,
    // The share directory this VM actually uses — the snapshot service
    // clones exactly this directory.
    shareDir,
    sockDir,
    rfbSock: path.join(sockDir, '5900.sock'),
    cdpSock: path.join(sockDir, '9222.sock'),
    // The QX agent RPC daemon (shell + file RPC) — a dedicated vsock
    // channel, not the serial console.
    agentSock: path.join(sockDir, '7777.sock'),
    // The snapshot control channel (save/restore the machine state).
    controlSock: path.join(sockDir, 'control.sock'),
    proc: null, ready: false, startedAt: Date.now(),
    pending: new Map(), buffer: '', nextId: 1, consoleReady: false,
    // jobId -> { sock } for live guest commands (so cancel can hang up)
    liveJobs: new Map(),
  };
  desktops.set(sid, entry);
  entry.readyPromise = new Promise((resolve, reject) => {
    const args = [
      '--kernel', DESKTOP_IMAGE,
      '--initrd', DESKTOP_INITRD,
      '--share', shareDir,
      '--socket-dir', sockDir,
      '--mem', String(Math.max(1024, Number(memMB) || 4096)),
      '--cpus', String(Math.max(1, Number(cpus) || defaultCpus())),
      '--control-sock', entry.controlSock,
      '--snapshot-dir', snapshotRoot(),
    ];
    entry.proc = _spawn(QX_VM_NEXT, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // Drain the guest console so a verbose kernel/init can never fill the pipe
    // and block the VM. The tail is kept for diagnostics. The console carries
    // only the boot signal now — RPC rides the dedicated vsock channel.
    const keep = (chunk) => {
      const text = chunk.toString();
      try { entry.log = `${entry.log || ''}${text}`.slice(-16_000); } catch {}
      entry.buffer += text;
      let nl;
      while ((nl = entry.buffer.indexOf('\n')) !== -1) {
        const line = entry.buffer.slice(0, nl).replace(/\r$/, '');
        entry.buffer = entry.buffer.slice(nl + 1);
        if (!line) continue;
        if (line.includes('QX_VM_READY')) { entry.consoleReady = true; }
      }
    };
    entry.proc.stdout?.on?.('data', keep);
    entry.proc.stderr?.on?.('data', keep);
    entry.proc.on('error', (e) => { cleanup(entry); reject(e); });
    entry.proc.on('exit', () => {
      for (const waiter of entry.pending.values()) waiter({ exitCode: -1, output: 'desktop VM exited' });
      entry.pending.clear();
      if (!entry.ready) { cleanup(entry); reject(new Error('desktop VM exited before the RFB endpoint appeared')); }
    });
    const t0 = Date.now();
    const poll = setInterval(async () => {
      if (entry.ready) { clearInterval(poll); return; }
      if (entry.probing) return;
      if (entry.proc?.exitCode != null) { clearInterval(poll); cleanup(entry); reject(new Error('desktop VM exited before the RFB endpoint appeared')); return; }
      entry.probing = true;
      let ok = false;
      try {
        const remaining = timeoutMs - (Date.now() - t0);
        ok = await probeRfb(entry.rfbSock, Math.min(800, Math.max(120, remaining)));
      } finally { entry.probing = false; }
      if (entry.ready) { clearInterval(poll); return; }
      if (ok) {
        entry.ready = true;
        clearInterval(poll);
        resolve(entry);
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(poll);
        try { entry.proc.kill('SIGKILL'); } catch {}
        cleanup(entry);
        reject(new Error('desktop VM RFB endpoint did not appear (VZ unavailable? headless environment?)'));
      }
    }, 200);
  });
  return entry.readyPromise;
}

/**
 * Shell/file RPC against the session's desktop guest.
 *
 * The guest runs a dedicated agent daemon on vsock port 7777 (`socat
 * VSOCK-LISTEN:7777,fork EXEC:/usr/bin/qx-agent`), so each request is
 * handled by its own forked process.
 *
 * The previous implementation multiplexed the same RPC over the serial
 * console, which meant:
 *   - one slow command blocked every other request
 *   - kernel printk output was interleaved into the protocol stream
 *   - everything was base64-encoded through a 16550 baud-ish pipe
 *
 * The vsock channel is a real socket: concurrent, framed, and fast.
 *
 * The console is still parsed for the `QX_VM_READY` marker (that is a
 * boot signal, not RPC traffic).
 */
const AGENT_RPC = {
  exec: 'EXEC',
  'fs.read': 'FSREAD',
  'fs.write': 'FSWRITE',
  'fs.listdir': 'LIST',
  ping: 'PING',
};

const AGENT_TIMEOUT_MS = 120_000;

/**
 * Send one request to the guest agent daemon and resolve with its reply.
 *
 * When `params.jobId` is set the live connection is registered under that
 * id, so `cancel(jobId)` can hang up on it — the guest handler sees EOF,
 * exits, and its EXIT trap kills the running command. That is what makes
 * "cancel a long shell" actually stop the work in the guest.
 *
 * @returns {Promise<{ exitCode: number, output: string }>}
 */
function agentCall(entry, method, params = {}) {
  const op = AGENT_RPC[method];
  if (!op) return Promise.reject(new Error(`desktop VM does not support ${method}`));
  const id = `a${entry.nextId++}`;
  const sockPath = entry.agentSock;

  let arg1 = '';
  let arg2 = '';
  if (op === 'EXEC') {
    arg1 = Buffer.from(String(params.command ?? ''), 'utf8').toString('base64');
  } else if (op === 'FSWRITE') {
    arg1 = String(params.p ?? '');
    arg2 = Buffer.from(String(params.content ?? ''), 'utf8').toString('base64');
  } else {
    arg1 = String(params.p ?? '.');
  }

  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buffer = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (params.jobId) {
        const live = entry.liveJobs.get(String(params.jobId));
        if (live && live.sock === sock) entry.liveJobs.delete(String(params.jobId));
      }
      try { sock.destroy(); } catch { /* already gone */ }
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`VM ${op} timed out`));
    }, AGENT_TIMEOUT_MS);
    if (params.jobId) {
      entry.liveJobs.set(String(params.jobId), { sock, startedAt: Date.now() });
    }
    sock.on('connect', () => {
      sock.write(`${op}\t${id}\t${arg1}\t${arg2}\n`);
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      const parts = line.split('\t');
      if (parts[0] !== 'RES' || parts[1] !== id) return;
      const exitCode = Number(parts[2] ?? 1) || 0;
      let output = '';
      try { output = Buffer.from(parts[3] ?? '', 'base64').toString('utf8'); } catch { output = ''; }
      finish(resolve, { exitCode, output });
    });
    sock.on('error', (error) => finish(reject, error));
    sock.on('close', () => finish(reject, new Error('VM agent connection closed')));
  });
}

/**
 * Cancel a running guest command.
 *
 * Hangs up on the live connection, which makes the guest handler exit and
 * kill the command it was running.
 */
function cancel(jobId) {
  const id = String(jobId ?? '');
  if (!id) return { cancelled: false, reason: 'no job id' };
  for (const entry of desktops.values()) {
    const live = entry.liveJobs?.get(id);
    if (!live) continue;
    try { live.sock.destroy(); } catch { /* already gone */ }
    entry.liveJobs.delete(id);
    return { cancelled: true, jobId: id };
  }
  return { cancelled: false, reason: 'no such running job' };
}

/**
 * Call a shell/file method on the session's desktop guest.
 *
 * @param {string} sessionId
 * @param {string} method  exec | fs.read | fs.write | fs.listdir | ping
 * @param {object} [params]
 */
async function call(sessionId, method, params = {}, { timeoutMs = AGENT_TIMEOUT_MS } = {}) {
  const entry = desktops.get(String(sessionId));
  if (!entry || !entry.ready) throw new Error('desktop VM not ready');
  if (!AGENT_RPC[method]) throw new Error(`desktop VM does not support ${method}`);
  if (method.startsWith('fs.')) {
    // The guest only serves /share; refuse anything that could escape it.
    const p = String(params.p ?? '.');
    if (/[\t\r\n]/.test(p) || path.posix.isAbsolute(p) || p.split('/').includes('..')) {
      throw new Error('invalid VM file path');
    }
  }
  const result = await agentCall(entry, method, params);
  if (method === 'fs.read') {
    if (result.exitCode !== 0) throw new Error(result.output || `VM ${method} failed`);
    return result.output;
  }
  if (method === 'fs.write') {
    if (result.exitCode !== 0) throw new Error(result.output || `VM ${method} failed`);
    return { bytes: Buffer.byteLength(String(params.content ?? ''), 'utf8') };
  }
  if (method === 'fs.listdir') {
    if (result.exitCode !== 0) throw new Error(result.output || `VM ${method} failed`);
    return result.output.split('\n').filter(Boolean).map((name) => ({
      name: name.endsWith('/') ? name.slice(0, -1) : name,
      dir: name.endsWith('/'),
    }));
  }
  if (method === 'ping') {
    return { exitCode: result.exitCode, output: result.output };
  }
  return result;
}

function cleanup(entry) { if (desktops.get(entry.sessionId) === entry) desktops.delete(entry.sessionId); }

function stop(sessionId) {
  const entry = desktops.get(String(sessionId));
  if (!entry) return false;
  try { entry.proc?.kill('SIGTERM'); } catch {}
  desktops.delete(String(sessionId));
  return true;
}
function list() { return [...desktops.values()].map((e) => ({ sessionId: e.sessionId, ready: e.ready, rfbSock: e.rfbSock, pid: e.proc?.pid ?? null, uptimeMs: Date.now() - e.startedAt })); }

module.exports = { desktopVmService: { boot, stop, get, available, list, call, setSpawn, rfbSockFor: (s) => get(s)?.rfbSock || null, cdpSockFor: (s) => get(s)?.cdpSock || null, agentSockFor: (s) => get(s)?.agentSock || null, controlSockFor: (s) => get(s)?.controlSock || null, snapshotRoot, cancel } };
