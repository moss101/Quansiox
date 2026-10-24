'use strict';
/**
 * Exec service — local command execution.
 *
 * Every host command runs through the supervised local-exec daemon
 * (src/exec-daemon/index.js) inside a macOS seatbelt profile: deny-by-
 * default, writes limited to the workspace (+ the toolchain caches a real
 * dev workflow needs), and the cloud metadata endpoints blocked even when
 * the network is otherwise open.
 *
 * This mirrors Grok Bot, whose `local-exec-daemon` runs agent shell commands
 * under a `CURSOR_FORCED_SHELL_EGRESS` policy with a native
 * `tree-sitter-bash` analysis of the command first. Quansiox does the
 * analysis in the coordinator (shell-analyze.js / shellAst.js) and the
 * enforcement here.
 *
 * The user can relax the sandbox from Settings (`shellSandbox: 'off'`).
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { secretsService } = require('./secretsService');

const running = new Set();

/**
 * Paths a real toolchain needs to write to even though they are outside
 * the workspace. Without these, `npm install`, `pip install`, `cargo
 * build` and `git` would all fail under the seatbelt profile.
 */
const TOOLCHAIN_WRITABLE = [
  '~/.npm',
  '~/.cache',
  '~/.cargo',
  '~/.rustup',
  '~/.local',
  '~/.config',
  '~/.composer',
  '~/.gradle',
  '~/.m2',
  '~/.nuget',
  '~/.pyenv',
  '~/Library/Caches',
  '~/Library/Application Support',
  '~/Library/Logs',
  '~/go/pkg',
  '~/go/bin',
];

/** Resolve a `~`-prefixed path. */
function expandHome(p) {
  const s = String(p ?? '');
  if (!s.startsWith('~')) return s;
  return path.join(os.homedir(), s.slice(1));
}

function resolveInWorkspace(p, cwd) {
  if (!p) return cwd;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/**
 * True when host commands should run through the local-exec daemon
 * (Seatbelt confinement, owner-only socket, single-use bootstrap token)
 * rather than a direct child of the app.
 *
 * The sandbox is ON by default (`settings.shellSandbox !== 'off'`), which
 * is what makes the deny-by-default policy meaningful. `daemon: false` is
 * an explicit per-call override.
 */
function useDaemon(opts = {}) {
  if (opts.daemon === true) return true;
  if (opts.daemon === false) return false;
  if (process.env.QUANSIOX_EXEC_DAEMON === '0') return false;
  if (process.env.QUANSIOX_EXEC_DAEMON === '1') return true;
  try {
    const s = require('./settingsService').settingsService?.load?.() ?? {};
    if (s.shellSandbox === 'off') return false;
    if (s.shellSandbox === 'on') return true;
  } catch { /* settings unavailable → keep the safe default */ }
  return true;
}

/** Should this call be confined by a seatbelt profile? */
function useSandbox(opts = {}) {
  if (opts.sandbox === true) return true;
  if (opts.sandbox === false) return false;
  try {
    const s = require('./settingsService').settingsService?.load?.() ?? {};
    return s.shellSandbox !== 'off';
  } catch { return true; }
}

/** The effective egress policy for a command. */
function egressPolicy() {
  try {
    const { normalizePolicy } = require('../../coordinator/egressPolicy');
    const s = require('./settingsService').settingsService?.load?.() ?? {};
    return normalizePolicy(s.egressPolicy ?? {});
  } catch {
    return { default: 'allow', allow: [], deny: [], writable: [] };
  }
}

async function runViaDaemon(command, cwd, timeoutMs, opts = {}) {
  const { execDaemonService } = require('./execDaemonService');
  const policy = egressPolicy();
  const workspace = opts.workspace || cwd;
  const extraWritable = [
    ...TOOLCHAIN_WRITABLE.map(expandHome),
    ...policy.writable.map(expandHome),
    ...(Array.isArray(opts.extraWritable) ? opts.extraWritable : []),
  ];

  // The per-domain allow-list is enforced by the egress proxy.
  //
  // SBPL cannot express "only these domains" — its network filters accept
  // only `*` or `localhost` — so the command's network is pinned to
  // localhost and the proxy decides, per request, whether the host is on
  // the list. The proxy reads the CONNECT target; it never decrypts TLS.
  //
  // The proxy is used whenever the network is allowed AT ALL, because it is
  // also what enforces the deny list (the cloud metadata endpoints, which
  // SBPL cannot express).
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
  const realAllow = policy.allow.filter((h) => !LOOPBACK.has(String(h).toLowerCase()));
  const networkAllowed = opts.allowNetwork === true
    || policy.default === 'allow'
    || realAllow.length > 0;
  const wantsProxy = networkAllowed;

  const result = await execDaemonService.exec(command, {
    cwd,
    timeoutMs,
    sandbox: useSandbox(opts),
    workspace,
    allowNetwork: networkAllowed,
    // The seatbelt cannot deny a host, so the deny list is the proxy's job.
    denyNetworkHosts: [],
    allowDomains: wantsProxy ? policy.allow : [],
    denyDomains: policy.deny,
    extraWritable,
    profile: opts.profile,
  });
  const code = result?.exitCode ?? 'signal';
  const out = `${result?.stdout ?? ''}${result?.stderr ? `\n[stderr]\n${result.stderr}` : ''}`.trim();
  const seal = result?.sandboxed ? ' [sandboxed]' : '';
  return `[exit ${code}]${seal}\n${out || '(no output)'}`;
}

function run(command, cwd, timeoutMs = 120_000, opts = {}) {
  // Resolve `{{secret:name.field}}` references at the privileged boundary so
  // decrypted values never touch on-disk transcripts/args.
  command = secretsService.resolve(command);
  if (useDaemon(opts)) {
    return runViaDaemon(command, cwd, timeoutMs, opts).catch((error) => `error: ${error.message}`);
  }
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    });
    running.add(child);
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) child.kill('SIGKILL');
    }, timeoutMs);

    const cap = (s, chunk) => (s.length > 100_000 ? s : s + chunk);
    child.stdout.on('data', (d) => (stdout = cap(stdout, d.toString())));
    child.stderr.on('data', (d) => (stderr = cap(stderr, d.toString())));
    child.on('close', (code) => {
      finished = true;
      clearTimeout(timer);
      running.delete(child);
      const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
      resolve(`[exit ${code ?? 'signal'}]\n${out || '(no output)'}`);
    });
    child.on('error', (error) => {
      finished = true;
      clearTimeout(timer);
      running.delete(child);
      resolve(`error: ${error.message}`);
    });
  });
}

function abortAll() {
  for (const child of running) {
    try { child.kill('SIGKILL'); } catch {}
  }
}

module.exports = { execService: { run, abortAll, resolveInWorkspace } };
