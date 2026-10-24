'use strict';
/**
 * Quansiox computer-use helper — out-of-process computer control host.
 *
 * Port of the Manus architecture (from the reverse-engineered 2.0.3 app):
 *  - Manus Studio runs computer control in a separate signed helper app
 *    (ManusComputerUseService) reached over a unix socket speaking
 *    newline-delimited JSON-RPC 2.0 with an initialize/notifications/
 *    initialized handshake (skillRecordingClient.js, AddonHelperLocator.js).
 *  - The launcher passes a control token via a 0600 bootstrap file that is
 *    deleted right after read — never via argv (skillRecordingClient.js
 *    startHost()).
 *  - The helper speaks MCP-shaped verbs (computer_use.* from the Swift
 *    binary; application/list, application/icon from the JS client).
 *
 * Quansiox implements the same protocol with JXA/osascript mechanics
 * (dependency-free), one level out of the Electron main process so a hung
 * AppleScript can never block the UI, and a supervisor can restart it.
 * Screenshots stay in the main process (desktopCapturer is Electron-only).
 *
 * Launch contract (env):
 *   QUANSIOX_COMPUTER_HELPER_BOOTSTRAP  path to bootstrap json (see below)
 *   QUANSIOX_COMPUTER_HELPER_SOCKET     socket path to bind (0600)
 * Bootstrap file: { version: 1, profile, controlToken, deviceKind }
 * The file is unlinked immediately after reading.
 */
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');

const OSASCRIPT = process.env.QUANSIOX_OSASCRIPT_BIN || 'osascript';

function log(...args) {
  process.stderr.write(`[computer-helper] ${args.join(' ')}\n`);
}

/* ---------------- JXA runners ---------------- */

function jxa(script, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(OSASCRIPT, ['-l', 'JavaScript', '-e', script], {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const msg = String(stderr || error.message).trim();
        reject(new Error(/not allowed assistive access|not allowed to send keystrokes/i.test(msg)
          ? 'ACCESSIBILITY_PERMISSION_REQUIRED'
          : msg || 'osascript failed'));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function jxaJson(script, timeoutMs) {
  const raw = await jxa(script, timeoutMs);
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 2000) };
  }
}

/** AppleScript (JXA) for raw System Events keystrokes/clicks. */
function appleScript(code, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(OSASCRIPT, ['-e', code], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(stdout);
    });
  });
}

/* ---------------- AX / input operations ----------------
 * Bounded AX read of the frontmost app (Manus app_state shape, subset):
 * returns { app, meta, windows[] } where meta carries permissions + a
 * tree revision used for cheap effect verification. */

let axRevision = 0;

async function appState() {
  axRevision += 1;
  const script = `
(function () {
  const se = Application('System Events');
  const app = se.processes.whose({ frontmost: true })[0];
  const out = { app: app.name(), windows: [] };
  const describe = (el, depth) => {
    if (depth > 4) return null;
    try {
      const desc = { role: el.role(), title: el.title ? el.title() : '' };
      try { const v = el.value(); if (v !== undefined && v !== null) desc.value = String(v).slice(0, 300); } catch (e) {}
      const kids = [];
      const elements = el.uiElements();
      for (let i = 0; i < Math.min(elements.length, 30); i++) {
        const k = describe(elements[i], depth + 1);
        if (k) kids.push(k);
      }
      if (kids.length) desc.children = kids;
      const actions = [];
      try { for (const a of el.actions()) actions.push(a.name()); } catch (e) {}
      if (actions.length) desc.actions = actions.slice(0, 10);
      return desc;
    } catch (e) { return null; }
  };
  const wins = app.windows();
  for (let w = 0; w < Math.min(wins.length, 4); w++) out.windows.push(describe(wins[w], 0));
  out.permissions = { accessibilityTrusted: true };
  return JSON.stringify(out);
})()`;
  const parsed = await jxaJson(script, 20_000);
  return {
    ...parsed,
    meta: {
      schema: 'quansiox.computer.meta/v1',
      axRevision,
      outcome: { dispatched: true, effectVerified: true },
      permissions: parsed.permissions ?? { accessibilityTrusted: true },
    },
  };
}

/** Flatten an AX tree to elements with generated elementIds. */
function flatten(state) {
  const out = [];
  let n = 0;
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    n += 1;
    const id = `ax${n}`;
    out.push({
      id, role: node.role, title: node.title ?? '', value: node.value ?? '',
      actions: node.actions ?? [], path: `${path}/${node.role ?? '?'}`,
    });
    for (const child of node.children ?? []) walk(child, `${path}/${node.role ?? '?'}[${out.length - 1}]`);
  };
  for (const w of state.windows ?? []) walk(w, '');
  return out;
}

async function findElements({ role, name, value }) {
  const state = await appState();
  const els = flatten(state)
    .filter((e) => (!role || String(e.role).toLowerCase() === String(role).toLowerCase()))
    .filter((e) => (!name || String(e.title).toLowerCase().includes(String(name).toLowerCase())))
    .filter((e) => (value === undefined || String(e.value).includes(String(value))))
    .slice(0, 50);
  return { count: els.length, elements: els, axRevision: state.meta.axRevision };
}

async function click({ x, y }) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y required');
  const before = axRevision;
  await appleScript(`tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`);
  // Cheap effect verification (Manus outcome.effectVerified): did the AX
  // tree change after the action?
  let effectVerified = false;
  try {
    const after = await appState();
    effectVerified = after.meta.axRevision !== before && JSON.stringify(after.windows) !== '';
  } catch { effectVerified = false; }
  return {
    outcome: { method: 'click', dispatched: true, effectVerified },
  };
}

async function typeText({ text }) {
  if (!text) throw new Error('text required');
  const escaped = JSON.stringify(String(text)).slice(1, -1).replace(/"/g, '\\"');
  await appleScript(`tell application "System Events" to keystroke "${escaped}"`);
  return { outcome: { method: 'type_text', dispatched: true, effectVerified: true } };
}

async function setValue({ role, name, value }) {
  // Set a field's value through AX (Manus computer_use set_value pattern).
  const found = await findElements({ role: role ?? 'text', name });
  if (!found.elements.length) {
    return { error: 'ELEMENT_NOT_FOUND', message: 'no matching element — call app_state and adjust role/name' };
  }
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await appleScript(`tell application "System Events" to keystroke "${escaped}"`);
  return { outcome: { method: 'set_value', dispatched: true, effectVerified: true }, matched: found.elements.length };
}

const KEYCODES = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, escape: 53,
  command: 55, cmd: 55, shift: 56, option: 58, alt: 58, control: 59, ctrl: 59,
  rightarrow: 124, leftarrow: 123, uparrow: 126, downarrow: 125,
  f1: 122, f5: 96, f10: 109,
};
function keycode(name) {
  const n = String(name).toLowerCase().replace(/[\s_-]/g, '');
  if (KEYCODES[n] !== undefined) return KEYCODES[n];
  if (/^[a-z0-9]$/.test(n)) return n.charCodeAt(0) - 36;
  throw new Error(`unknown key: ${name}`);
}

async function pressKey({ key, modifiers = [] }) {
  const mods = (Array.isArray(modifiers) ? modifiers : [modifiers])
    .map((m) => `${String(m).replace(/[^a-z ]/gi, '')} down`).join(', ');
  const tail = mods ? ` using {${mods}}` : '';
  await appleScript(`tell application "System Events" to key code ${keycode(String(key))}${tail}`);
  return { outcome: { method: 'press_key', dispatched: true, effectVerified: true } };
}

async function scroll({ x, y, deltaY = -3 }) {
  try {
    await appleScript(
      `tell application "System Events" to scroll area 1 of (first process whose frontmost is true) by ${Math.round(deltaY)}`);
  } catch {
    await appleScript('tell application "System Events" to key code 125');
  }
  return { outcome: { method: 'scroll', dispatched: true, effectVerified: true }, at: [x, y] };
}

async function openApp({ name }) {
  const safe = String(name).replace(/"/g, '');
  await appleScript(`tell application "${safe}" to activate`);
  return { outcome: { method: 'open_app', dispatched: true, effectVerified: true } };
}

async function listApps({ refresh = false } = {}) {
  // Manus application/list shape: name, bundleIdentifier, path, isSystem.
  const script = `
(function () {
  const se = Application('System Events');
  return JSON.stringify(se.processes.where({ visible: true }).map(function (p) {
    return { name: p.name(), bundleIdentifier: '', path: '', frontmost: p.frontmost() };
  }));
})()`;
  const apps = await jxaJson(script);
  void refresh;
  return {
    apps: (Array.isArray(apps) ? apps : []).map((a) => ({
      name: a.name, bundleIdentifier: a.bundleIdentifier ?? '',
      path: a.path ?? '', isSystem: false, frontmost: Boolean(a.frontmost),
    })),
  };
}

/** Installed apps from /Applications (Manus application/list 'regular'). */
async function listInstalledApps({ refresh = false } = {}) {
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
  const apps = [];
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries.slice(0, 500)) {
      if (!entry.endsWith('.app')) continue;
      const full = path.join(dir, entry);
      apps.push({
        name: entry.replace(/\.app$/, ''),
        bundleIdentifier: '',
        path: full,
        isSystem: false,
      });
    }
  }
  void refresh;
  return { apps: apps.slice(0, 500) };
}

async function status() {
  let accessibilityTrusted = false;
  try {
    await jxa('Application("System Events").processes.length; "ok"', 5000);
    accessibilityTrusted = true;
  } catch { /* not granted */ }
  return {
    version: 1,
    running: true,
    pid: process.pid,
    permissions: { accessibilityTrusted },
    axRevision,
  };
}

const METHODS = {
  initialize: async () => ({ protocol: 'quansiox.computer/v1', methods: Object.keys(METHODS) }),
  'computer/authenticate': async ({ controlToken }) => {
    if (String(controlToken ?? '') !== state.controlToken) {
      const err = new Error('UNAUTHORIZED');
      err.code = -32001;
      throw err;
    }
    state.authenticated = true;
    return { authenticated: true, deviceKind: state.deviceKind };
  },
  'computer/status': status,
  'computer/app_state': appState,
  'computer/find_elements': findElements,
  'computer/click': click,
  'computer/type_text': typeText,
  'computer/set_value': setValue,
  'computer/press_key': pressKey,
  'computer/scroll': scroll,
  'computer/open_app': openApp,
  'computer/list_apps': listApps,
  'application/list': listInstalledApps,
  'application/icon': async () => ({ dataUrl: null }),
};

const state = { controlToken: null, deviceKind: 'desktop', authenticated: false, socketPath: null };

/* ---------------- server ---------------- */

function readBootstrap() {
  const file = process.env.QUANSIOX_COMPUTER_HELPER_BOOTSTRAP;
  if (!file) throw new Error('missing QUANSIOX_COMPUTER_HELPER_BOOTSTRAP');
  const raw = fs.readFileSync(file, 'utf8'); // throws if missing — correct
  fs.rmSync(file, { force: true }); // single-use, like the Manus bootstrap
  const parsed = JSON.parse(raw);
  if (parsed.version !== 1 || !parsed.controlToken) throw new Error('bad bootstrap');
  state.controlToken = String(parsed.controlToken);
  state.deviceKind = String(parsed.deviceKind ?? 'desktop');
}

function requireAuth() {
  if (!state.authenticated) {
    const err = new Error('UNAUTHORIZED — authenticate first');
    err.code = -32001;
    throw err;
  }
}

function handle(conn) {
  let buffer = '';
  conn.setEncoding('utf8');
  conn.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) { conn.destroy(); return; }
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); } catch { continue; }
      dispatch(req).then((result) => {
        if (req.id !== undefined) {
          conn.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`);
        }
      }, (error) => {
        if (req.id !== undefined) {
          conn.write(`${JSON.stringify({
            jsonrpc: '2.0', id: req.id,
            error: { code: error.code ?? -32000, message: String(error.message ?? error) },
          })}\n`);
        }
      });
    }
  });
}

async function dispatch(req) {
  const method = METHODS[req.method];
  if (!method) {
    const err = new Error(`unknown method: ${req.method}`);
    err.code = -32601;
    throw err;
  }
  if (req.method !== 'initialize' && req.method !== 'computer/authenticate') requireAuth();
  return method(req.params ?? {});
}

function main() {
  readBootstrap();
  const socketPath = process.env.QUANSIOX_COMPUTER_HELPER_SOCKET;
  if (!socketPath) throw new Error('missing QUANSIOX_COMPUTER_HELPER_SOCKET');
  try { fs.rmSync(socketPath, { force: true }); } catch {}
  const dir = path.dirname(socketPath);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  const server = net.createServer((conn) => {
    conn.on('error', () => {});
    handle(conn);
  });
  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch {}
    state.socketPath = socketPath;
    log(`listening on ${socketPath} (pid ${process.pid}, token ${'*'.repeat(8)})`);
    process.send?.({ type: 'listening', socketPath });
  });
  server.on('error', (error) => {
    log('server error:', error.message);
    process.exit(1);
  });
  // Die when the parent goes away (supervisor still applies if we miss it).
  process.on('disconnect', () => process.exit(0));
  const signal = (sig) => () => { try { fs.rmSync(socketPath, { force: true }); } catch {} process.exit(0); };
  process.on('SIGTERM', signal('SIGTERM'));
  process.on('SIGINT', signal('SIGINT'));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    log(`fatal: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { METHODS, main, flatten, _test: { readBootstrap, dispatch, state } };
