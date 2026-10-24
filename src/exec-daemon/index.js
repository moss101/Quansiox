'use strict';
/**
 * Quansiox local-exec daemon — a long-lived, owner-only command daemon
 * (Grok 0.71's spawnLocalExecDaemon / local-exec daemon shape).
 *
 * Protocol: newline-delimited JSON over a 0600 unix socket. The first frame
 * on every connection must authenticate with the control token minted by
 * mintLocalExecDaemonCredential (constant-time compared). The token is read
 * from a single-use 0600 bootstrap file (deleted immediately after read) —
 * the same handoff pattern as the computer-use helper, never via argv.
 *
 * Ops:
 *   { id, op: 'ping' }
 *   { id, op: 'status' }
 *   { id, op: 'exec', command, cwd?, timeoutMs?, env? }   → { exitCode, signal, stdout, stderr, ms }
 *   { id, op: 'cancel', jobId }                            → kill a running exec
 *   { id, op: 'shutdown' }
 *
 * Env: QUANSIOX_EXEC_DAEMON_SOCK (socket path), QUANSIOX_EXEC_DAEMON_BOOTSTRAP
 *      (0600 JSON {token, id}), QUANSIOX_EXEC_DAEMON_CWD (default cwd).
 */
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { seatbeltProfile, seatbeltAvailable } = require('./seatbelt');

const SOCK = process.env.QUANSIOX_EXEC_DAEMON_SOCK;
const BOOTSTRAP = process.env.QUANSIOX_EXEC_DAEMON_BOOTSTRAP;
const DEFAULT_CWD = process.env.QUANSIOX_EXEC_DAEMON_CWD || process.cwd();
const ID = process.env.QUANSIOX_EXEC_DAEMON_ID || `exec-${process.pid}`;
const OUTPUT_CAP = 1_000_000;

function log(...args) { process.stderr.write(`[exec-daemon ${ID}] ${args.join(' ')}\n`); }

if (!SOCK) { log('missing QUANSIOX_EXEC_DAEMON_SOCK'); process.exit(2); }
if (!BOOTSTRAP) { log('missing QUANSIOX_EXEC_DAEMON_BOOTSTRAP'); process.exit(2); }

let token = '';
try {
  const boot = JSON.parse(fs.readFileSync(BOOTSTRAP, 'utf8'));
  token = String(boot?.token ?? '');
} catch (error) {
  log(`bootstrap read failed: ${error.message}`);
  process.exit(2);
}
try { fs.rmSync(BOOTSTRAP, { force: true }); } catch {}
if (!token) { log('empty control token'); process.exit(2); }

function tokenOk(given) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

const jobs = new Map(); // jobId -> { child, startedAt, command }
let nextJob = 1;

async function runExec(params, respond) {
  const command = String(params.command ?? '');
  if (!command) return respond({ error: 'command required' });
  const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 120_000, 1_000), 10 * 60_000);
  const cwd = params.cwd ? path.resolve(String(params.cwd)) : DEFAULT_CWD;
  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' };
  if (params.env && typeof params.env === 'object') {
    for (const [k, v] of Object.entries(params.env)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
  }

  // The egress proxy (W4.5).
  //
  // A per-domain allow-list cannot be expressed in SBPL: its network
  // filters accept only `*` or `localhost`. So when the caller supplies an
  // allow-list, the command's network is pinned to localhost and the proxy
  // decides, per request, whether the host is allowed. The proxy is not a
  // TLS interceptor — it reads the CONNECT target and gates it.
  const allowDomains = Array.isArray(params.allowDomains) ? params.allowDomains : [];
  const denyDomains = Array.isArray(params.denyDomains) ? params.denyDomains : [];
  const useProxy = allowDomains.length > 0 && params.allowNetwork === true;
  let proxy = null;
  if (useProxy) {
    try {
      const { startEgressProxy } = require('./egressProxy');
      proxy = await startEgressProxy({
        allow: allowDomains,
        deny: denyDomains,
        defaultAction: 'deny',
        onDecision: (decision) => {
          try {
            require('./egressLog').record(decision);
          } catch { /* the audit log is best-effort */ }
        },
      });
    } catch { /* the proxy could not start → the command keeps its coarse policy */ }
  }
  const jobId = `job-${nextJob++}`;
  const startedAt = Date.now();
  // Optional Seatbelt confinement (macOS): deny-by-default, workspace-writable.
  let argv = ['/bin/bash', '-lc', command];
  let sandboxed = false;
  if (params.sandbox === true && seatbeltAvailable()) {
    const baseProfile = params.profile
      ? String(params.profile)
      : seatbeltProfile({
        workspace: params.workspace ? path.resolve(String(params.workspace)) : undefined,
        workdir: cwd,
        allowNetwork: params.allowNetwork === true,
        extraWritable: Array.isArray(params.extraWritable) ? params.extraWritable : [],
        denyNetworkHosts: Array.isArray(params.denyNetworkHosts) ? params.denyNetworkHosts : [],
      });
    if (proxy) {
      const { proxyEnv, proxySeatbeltProfile } = require('./egressProxy');
      // The command may only reach the proxy.
      const profile = proxySeatbeltProfile(baseProfile);
      Object.assign(env, proxyEnv(proxy.port));
      argv = ['/usr/bin/sandbox-exec', '-p', profile, '/bin/bash', '-lc', command];
    } else {
      argv = ['/usr/bin/sandbox-exec', '-p', baseProfile, '/bin/bash', '-lc', command];
    }
    sandboxed = true;
  }
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), { cwd, env });
  } catch (error) {
    return respond({ error: `spawn failed: ${error.message}` });
  }
  jobs.set(jobId, { child, startedAt, command });
  let stdout = '';
  let stderr = '';
  let done = false;
  const cap = (s, chunk) => (s.length >= OUTPUT_CAP ? s : s + chunk.toString());
  child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
  child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
  child.on('close', (code, signal) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    jobs.delete(jobId);
    respond({ result: { jobId, exitCode: code, signal: signal ?? null, stdout, stderr, sandboxed, ms: Date.now() - startedAt } });
  });
  child.on('error', (error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    jobs.delete(jobId);
    respond({ error: `exec error: ${error.message}` });
  });
  // Early ack so the caller can cancel a long job by id.
  respond({ result: { jobId, started: true, pid: child.pid } }, { partial: true });
}

function cancelJob(params, respond) {
  const job = jobs.get(String(params.jobId ?? ''));
  if (!job) return respond({ error: 'unknown job' });
  try { job.child.kill('SIGKILL'); } catch (error) { return respond({ error: error.message }); }
  respond({ result: { cancelled: true, jobId: params.jobId } });
}

const server = net.createServer((sock) => {
  let authed = false;
  let buffer = '';
  const reply = (msg, opts = {}) => {
    if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`);
    if (!opts.partial) { /* keep connection for job streams */ }
  };
  sock.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { reply({ error: 'bad json' }); continue; }
      if (!authed) {
        if (!tokenOk(msg.auth)) { reply({ error: 'unauthorized' }); sock.destroy(); return; }
        authed = true;
        reply({ result: { ok: true, id: ID, pid: process.pid } });
        continue;
      }
      const id = msg.id ?? null;
      const respond = (out, opts) => reply({ id, ...out }, opts);
      if (msg.op === 'ping') respond({ result: 'pong' });
      else if (msg.op === 'status') respond({ result: { id: ID, pid: process.pid, jobs: jobs.size, uptimeMs: Date.now() - startedAt } });
      else if (msg.op === 'exec') runExec(msg, respond);
      else if (msg.op === 'cancel') cancelJob(msg, respond);
      else if (msg.op === 'shutdown') { respond({ result: 'bye' }); setTimeout(() => process.exit(0), 20); }
      else respond({ error: `unknown op ${msg.op}` });
    }
  });
  sock.on('error', () => {});
});

const startedAt = Date.now();

server.on('error', (error) => {
  log(`socket error: ${error.message}`);
  process.exit(3);
});

try { fs.rmSync(SOCK, { force: true }); } catch {}
server.listen(SOCK, () => {
  try { fs.chmodSync(SOCK, 0o600); } catch {}
  log(`ready at ${SOCK}`);
  if (process.send) process.send({ type: 'execDaemonReady', id: ID, pid: process.pid, sock: SOCK });
});

function shutdown() {
  for (const job of jobs.values()) { try { job.child.kill('SIGKILL'); } catch {} }
  try { fs.rmSync(SOCK, { force: true }); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', shutdown); // parent (supervisor) exited
process.on('exit', () => { try { fs.rmSync(SOCK, { force: true }); } catch {} });
