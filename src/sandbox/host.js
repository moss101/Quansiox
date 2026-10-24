'use strict';
/**
 * Quansiox sandbox computer — a forked Node process giving each agent session
 * an isolated "computer": a confined filesystem root plus exec/terminal
 * endpoints, spoken as newline-delimited JSON-RPC over a unix socket
 * (replicating the Manus sidecar bridge op set, locally).
 *
 * Env: QUANSIOX_SANDBOX_ROOT=<dir>, QUANSIOX_SANDBOX_SOCK=<path>
 * Every fs path is resolved inside ROOT and escape-checked.
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(process.env.QUANSIOX_SANDBOX_ROOT ?? '.');
const SOCK = process.env.QUANSIOX_SANDBOX_SOCK;

if (!SOCK) {
  console.error('[sandbox] missing QUANSIOX_SANDBOX_SOCK');
  process.exit(1);
}

function log(...args) {
  console.log(`[sandbox ${path.basename(ROOT)}]`, ...args);
}

/** Resolve a sandbox-relative or sandbox-absolute path; escape-checked. */
function resolveInRoot(p) {
  const abs = path.resolve(ROOT, String(p ?? '.'));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error('path escapes sandbox');
  }
  return abs;
}

const terminals = new Map(); // id -> { child, buffer }
let nextTerminal = 1;
let nextJob = 1;
const jobs = new Map();

/** ---- filesystem ops (the sidecar op set) ---- */
const fsOps = {
  'fs.stat': ({ p }) => {
    const st = fs.statSync(resolveInRoot(p));
    return {
      isDir: st.isDirectory(),
      size: st.size,
      mode: st.mode,
      mtimeMs: st.mtimeMs,
    };
  },
  'fs.listdir': ({ p = '.' }) =>
    fs.readdirSync(resolveInRoot(p), { withFileTypes: true }).map((e) => ({
      name: e.name,
      dir: e.isDirectory(),
    })),
  'fs.read': ({ p }) => {
    const abs = resolveInRoot(p);
    const st = fs.statSync(abs);
    if (st.size > 200_000) return `file too large (${st.size} bytes)`;
    return fs.readFileSync(abs, 'utf8');
  },
  'fs.write': ({ p, content }) => {
    if (typeof content !== 'string' || content.length > 2_000_000) throw new Error('invalid content');
    const abs = resolveInRoot(p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    return { bytes: Buffer.byteLength(content) };
  },
  'fs.mkdir': ({ p }) => {
    fs.mkdirSync(resolveInRoot(p), { recursive: true });
    return true;
  },
  'fs.remove': ({ p }) => {
    fs.rmSync(resolveInRoot(p), { recursive: true, force: true });
    return true;
  },
  'fs.rename': ({ from, to }) => {
    fs.renameSync(resolveInRoot(from), resolveInRoot(to));
    return true;
  },
};

/** ---- exec: run a command with cwd confined to the sandbox root, and the
 * filesystem kernel-isolated via a macOS seatbelt profile (writes allowed
 * only inside ROOT + temp/dev, the same mechanism Chromium uses) ---- */
/** Probe whether seatbelt profiles can be applied in this context (nested
 * sandboxes may deny sandbox_apply); fall back to plain exec if not. */
function probeSeatbelt() {
  if (process.env.QUANSIOX_SEATBELT === '0') return false;
  try {
    require('node:fs').accessSync('/usr/bin/sandbox-exec');
  } catch {
    return false;
  }
  try {
    require('node:child_process').execFileSync(
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)', '/bin/echo', 'ok'],
      { stdio: 'ignore', timeout: 5000 }
    );
    return true;
  } catch {
    log('seatbelt unavailable in this context — falling back to process isolation');
    return false;
  }
}
const SEATBELT_ON = probeSeatbelt();

function seatbeltProfile() {
  const lit = (p) => JSON.stringify(p);
  return [
    '(version 1)',
    '(allow default)', // reads, network, processes allowed…
    // The session computer does not launch the Mac's browsers. Web pages
    // belong in the Electron WebContentsView (browser_open).
    '(deny process-exec (literal "/usr/bin/open"))',
    '(deny process-exec (subpath "/Applications/Safari.app"))',
    '(deny process-exec (subpath "/Applications/Google Chrome.app"))',
    '(deny process-exec (subpath "/Applications/Chromium.app"))',
    '(deny process-exec (subpath "/Applications/Firefox.app"))',
    '(deny process-exec (subpath "/Applications/Arc.app"))',
    '(deny process-exec (subpath "/Applications/Brave Browser.app"))',
    '(deny process-exec (subpath "/Applications/Microsoft Edge.app"))',
    '(deny process-exec (subpath "/Applications/Orion.app"))',
    '(deny process-exec (subpath "/Applications/Opera.app"))',
    '(deny process-exec (subpath "/Applications/Vivaldi.app"))',
    '(deny process-exec (subpath "/Applications/Dia.app"))',
    '(deny file-write*)', // …but writes are kernel-blocked…
    // …except inside the sandbox root and ephemeral system paths shells need.
    `(allow file-write* (subpath ${lit(ROOT)}))`,
    '(allow file-write* (subpath "/private/var/tmp"))',
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/dtrace") (literal "/dev/tty"))',
  ].join('\n');
}

function exec({ command, timeoutMs = 120_000, jobId }) {
  const { classifyShell, HOST_BROWSER_REFUSAL } = require('../coordinator/hostBrowser');
  const decision = classifyShell(command);
  if (decision) {
    const output = decision.kind === 'url'
      ? `refused: ${decision.url} opens in the Electron browser. Use browser_open.`
      : (decision.message || HOST_BROWSER_REFUSAL);
    return Promise.resolve({ exitCode: 1, output });
  }
  return new Promise((resolve) => {
    const profilePath = path.join(ROOT, '.seatbelt.sb');
    const launcher = SEATBELT_ON
      ? ['/usr/bin/sandbox-exec', '-f', profilePath, '/bin/bash', '-lc', String(command ?? '')]
      : ['/bin/bash', '-lc', String(command ?? '')];
    if (SEATBELT_ON) {
      fs.writeFileSync(profilePath, seatbeltProfile(), 'utf8');
    }
    const child = spawn(launcher[0], launcher.slice(1), {
      cwd: ROOT,
      env: {
        ...process.env,
        TERM: 'dumb',
        NO_COLOR: '1',
        HOME: ROOT,
        QUANSIOX_SANDBOX: SEATBELT_ON ? 'seatbelt' : '1',
      },
    });
    // Client-supplied jobId lets the caller cancel a long-running command
    // (Grok `interrupt` on a child shell). Default to a local counter.
    const job = jobId != null && String(jobId) ? String(jobId) : `job-${nextJob++}`;
    jobs.set(job, child);
    let out = '';
    const cap = (s, c) => (s.length > 100_000 ? s : s + c);
    child.stdout.on('data', (d) => (out = cap(out, d.toString())));
    child.stderr.on('data', (d) => (out = cap(out, d.toString())));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const done = (result) => { clearTimeout(timer); jobs.delete(job); resolve(result); };
    child.on('close', (code) => done({ exitCode: code ?? -1, output: out.slice(0, 30_000), jobId: job }));
    child.on('error', (error) => done({ exitCode: -1, output: `error: ${error.message}`, jobId: job }));
  });
}

function execCancel({ jobId }) {
  const child = jobs.get(String(jobId ?? ''));
  if (!child) return { cancelled: false, reason: 'no such job' };
  jobs.delete(String(jobId));
  try { child.kill('SIGKILL'); } catch {}
  return { cancelled: true, jobId: String(jobId) };
}

/** ---- terminals: persistent interactive sessions in the sandbox ---- */
function terminalCreate() {
  const id = `t${nextTerminal++}`;
  const child = spawn('/bin/bash', ['-i'], {
    cwd: ROOT,
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', HOME: ROOT, PS1: '$ ' },
  });
  const entry = { child, buffer: '' };
  terminals.set(id, entry);
  child.stdout.on('data', (d) => (entry.buffer = (entry.buffer + d.toString()).slice(-50_000)));
  child.stderr.on('data', (d) => (entry.buffer = (entry.buffer + d.toString()).slice(-50_000)));
  child.on('exit', () => terminals.delete(id));
  return { id };
}

async function handle(method, params) {
  if (fsOps[method]) return fsOps[method](params ?? {});
  switch (method) {
    case 'ping':
      return {
        root: ROOT,
        seatbelt: SEATBELT_ON,
        uptimeMs: Date.now() - startedAt,
        jobs: jobs.size,
        terminals: terminals.size,
      };
    case 'exec':
      return exec(params ?? {});
    case 'exec.cancel':
      return execCancel(params ?? {});
    case 'terminal.create':
      return terminalCreate();
    case 'terminal.write': {
      const entry = terminals.get(params?.id);
      if (!entry) throw new Error('no such terminal');
      entry.child.stdin.write(String(params.input ?? ''));
      return true;
    }
    case 'terminal.read': {
      const entry = terminals.get(params?.id);
      if (!entry) throw new Error('no such terminal');
      const out = entry.buffer;
      entry.buffer = '';
      return out;
    }
    case 'shutdown':
      setTimeout(() => process.exit(0), 50);
      return true;
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

const startedAt = Date.now();
fs.mkdirSync(ROOT, { recursive: true });
try { fs.rmSync(SOCK, { force: true }); } catch {}

const server = net.createServer((conn) => {
  let buffer = '';
  conn.on('data', async (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        conn.write(`${JSON.stringify({ id: null, error: 'bad json' })}\n`);
        continue;
      }
      try {
        const result = await handle(req.method, req.params);
        conn.write(`${JSON.stringify({ id: req.id, result })}\n`);
      } catch (error) {
        conn.write(`${JSON.stringify({ id: req.id, error: String(error?.message ?? error) })}\n`);
      }
    }
  });
});

server.listen(SOCK, () => {
  fs.chmodSync(SOCK, 0o600);
  log('ready at', SOCK);
  // The parent may already be gone (it was killed mid-startup). Writing to
  // a closed IPC channel raises EPIPE, which would kill this host for
  // nothing — the sandbox is useless anyway, so it just exits quietly.
  if (process.send) {
    process.on('error', () => { /* the parent is gone */ });
    try {
      process.send({ type: 'sandboxReady' }, () => { /* the parent may be gone */ });
    } catch { /* the parent is gone */ }
  }
});

// sandboxed tools get a hard lifetime cap
setTimeout(() => process.exit(0), 24 * 60 * 60 * 1000).unref?.();
process.on('disconnect', () => process.exit(0));
