'use strict';
/**
 * macOS Messages integration service — real host-side state and probes for
 * Grok's Messages (iMessage) surface: Full Disk Access (can we read
 * `~/Library/Messages/chat.db`?), Contacts (AddressBook store readable?),
 * Automation (recorded AppleScript grant), the toggle that enables Messages
 * for the agent, the allowlist of recipients the agent may message, the
 * grant request → await → resolve/cancel handshake, and the real
 * Messages.app icon.
 *
 * Probes read real system paths; without access they honestly report
 * `denied`/`missing`/`unknown` — nothing is faked.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR; osascript/sips injectable).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const GRANTS = ['automation', 'contacts', 'fullDiskAccess'];
const AWAIT_CAP_MS = 60_000;

function settings() { return require('./settingsService').settingsService; }
function emit(event, payload) {
  try { require('../ipc/emitEvent').emitEvent('messages', event, payload); } catch {}
}
function record(action, detail) {
  try { require('./diagnosticsService').diagnosticsService.record('messages', { action, ...detail }); } catch {}
}

function chatDbPath() { return path.join(os.homedir(), 'Library', 'Messages', 'chat.db'); }
function addressBookDir() { return path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook'); }

let runner = (cmd, args) => require('node:child_process').execFileSync(cmd, args, { timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
function _setRunner(fn) { runner = fn; }

function probeFullDiskAccess() {
  try {
    const fd = fs.openSync(chatDbPath(), 'r');
    fs.closeSync(fd);
    return 'granted';
  } catch (e) {
    if (e.code === 'ENOENT') return 'missing';
    return 'denied';
  }
}
function probeContacts() {
  try {
    fs.readdirSync(addressBookDir());
    return 'granted';
  } catch (e) {
    if (e.code === 'ENOENT') return 'missing';
    return 'denied';
  }
}
function probeAutomation({ prompt = false } = {}) {
  const cfg = settings().load();
  if (cfg.messagesAutomationGranted === true) return 'granted';
  if (!prompt) return 'unknown';
  try {
    runner('osascript', ['-e', 'tell application "Messages" to get name']);
    settings().save({ messagesAutomationGranted: true });
    record('automation-granted', {});
    return 'granted';
  } catch {
    return 'denied';
  }
}

function checkPermissions({ prompt } = {}) {
  const grant = GRANTS.includes(prompt) ? prompt : null;
  const result = {
    fullDiskAccess: probeFullDiskAccess(),
    contacts: probeContacts(),
    automation: probeAutomation({ prompt: grant === 'automation' }),
    platform: process.platform,
  };
  if (grant && grant !== 'automation') {
    result.hint = grant === 'fullDiskAccess'
      ? 'Grant Full Disk Access to Quansiox in System Settings → Privacy & Security → Full Disk Access'
      : 'Grant Contacts access to Quansiox in System Settings → Privacy & Security → Contacts';
  }
  return result;
}

function getEnabled() {
  return { messagesEnabled: settings().load().messagesEnabled === true };
}
function setEnabled(messagesEnabled) {
  const on = Boolean(messagesEnabled);
  settings().save({ messagesEnabled: on });
  emit('enabled', { messagesEnabled: on });
  record('set-enabled', { messagesEnabled: on });
  return { messagesEnabled: on, permissions: checkPermissions({}) };
}

function iconPath() {
  return '/System/Applications/Messages.app/Contents/Resources/AppIcon.icns';
}
function getAppIcon() {
  const icns = iconPath();
  if (!fs.existsSync(icns)) return { icon: null, path: null, reason: 'Messages.app not found' };
  const out = path.join(os.tmpdir(), `qx-messages-icon-${crypto.randomBytes(4).toString('hex')}.png`);
  try {
    runner('sips', ['-s', 'format', 'png', '--resampleHeightWidthMax', '128', icns, '--out', out]);
    const buf = fs.readFileSync(out);
    fs.unlinkSync(out);
    if (buf.length > 512 * 1024) throw new Error('icon too large');
    return { icon: `data:image/png;base64,${buf.toString('base64')}`, path: icns };
  } catch {
    try { fs.unlinkSync(out); } catch {}
    return { icon: null, path: icns, reason: 'png conversion unavailable (sips)' };
  }
}

// ---------------- recipient allowlist ----------------
function normalizeRecipient(value) {
  const r = String(value ?? '').trim();
  if (!r || r.length > 320) throw new Error('recipient must be a non-empty string (≤320 chars)');
  return r;
}
function listRecipients() {
  const list = settings().load().messagesAllowedRecipients;
  return { recipients: Array.isArray(list) ? list.map(String) : [] };
}
function allowRecipients(recipients) {
  const current = new Set(listRecipients().recipients);
  for (const r of recipients) current.add(normalizeRecipient(r));
  const next = [...current].slice(0, 500);
  settings().save({ messagesAllowedRecipients: next });
  return listRecipients();
}
function revokeRecipient(recipient) {
  const r = normalizeRecipient(recipient);
  const before = listRecipients().recipients;
  const next = before.filter((x) => x !== r);
  settings().save({ messagesAllowedRecipients: next });
  record('revoke-recipient', { recipient: r, removed: before.length !== next.length });
  return { recipient: r, removed: before.length !== next.length, recipients: next };
}

// ---------------- grant requests ----------------
const pending = new Map();

function requestGrants({ requestId, grants } = {}) {
  const id = String(requestId ?? '').trim();
  if (!id) throw new Error('requestId is required');
  if (!Array.isArray(grants) || grants.length === 0) throw new Error('grants must be a non-empty array');
  const bad = grants.filter((g) => !GRANTS.includes(g));
  if (bad.length) throw new Error(`unknown grant(s): ${bad.join(', ')} (valid: ${GRANTS.join(', ')})`);
  const entry = { requestId: id, grants: [...new Set(grants)], requestedAt: Date.now(), status: 'pending', waiters: [] };
  pending.set(id, entry);
  emit('grantsRequested', { requestId: id, grants: entry.grants });
  record('grants-requested', { requestId: id, grants: entry.grants });
  return { requestId: id, grants: entry.grants, status: 'pending' };
}

function settle(entry, outcome) {
  entry.status = outcome.status;
  entry.outcome = outcome;
  entry.settledAt = Date.now();
  for (const w of entry.waiters) { clearTimeout(w.timer); w.resolve(outcome); }
  entry.waiters = [];
  emit('grantsResolved', { requestId: entry.requestId, ...outcome });
}

function resolveGrants({ requestId } = {}) {
  const id = String(requestId ?? '').trim();
  const entry = pending.get(id);
  if (!entry) throw new Error(`unknown grants request: ${id}`);
  const resolved = {};
  const granted = [];
  const denied = [];
  for (const g of entry.grants) {
    if (g === 'automation') resolved[g] = probeAutomation({ prompt: true });
    else if (g === 'contacts') resolved[g] = probeContacts();
    else if (g === 'fullDiskAccess') resolved[g] = probeFullDiskAccess();
    (resolved[g] === 'granted' ? granted : denied).push(g);
  }
  const outcome = { requestId: id, status: denied.length ? 'denied' : 'granted', resolved, granted, denied };
  settle(entry, outcome);
  record('grants-resolved', { requestId: id, granted, denied });
  return outcome;
}

function awaitGrants({ requestId, waitMs } = {}) {
  const id = String(requestId ?? '').trim();
  const entry = pending.get(id);
  if (!entry) throw new Error(`unknown grants request: ${id}`);
  if (entry.status !== 'pending') return Promise.resolve(entry.outcome);
  const ms = Math.min(AWAIT_CAP_MS, Math.max(1000, Number(waitMs) || 30_000));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      entry.waiters = entry.waiters.filter((w) => w.timer !== timer);
      resolve({ requestId: id, status: 'pending', timedOut: true, grants: entry.grants });
    }, ms);
    entry.waiters.push({ resolve, timer });
  });
}

function cancelGrants({ requestId } = {}) {
  const id = String(requestId ?? '').trim();
  const entry = pending.get(id);
  if (!entry) throw new Error(`unknown grants request: ${id}`);
  pending.delete(id);
  settle(entry, { requestId: id, status: 'cancelled' });
  return { requestId: id, status: 'cancelled' };
}

// ---------------- real chat.db reads ----------------
const reader = () => require('./imessageReader').imessageReader;

/** Health of the Messages database read path (missing/denied/granted). */
function readStatus() {
  return reader().probe();
}
async function listChats(opts) { return reader().listChats(opts); }
async function readMessages(opts) { return reader().readMessages(opts); }
async function searchMessages(opts) { return reader().searchMessages(opts); }

/**
 * Send a message through Messages.app. Gated three ways: the feature toggle,
 * the recipient allowlist, and a length cap. AppleScript strings are escaped;
 * the recipient/text never reach a shell.
 */
function sendMessage({ to, text, allowUnlisted = false } = {}) {
  if (settings().load().messagesEnabled !== true) throw new Error('Messages is disabled for the agent');
  const recipient = normalizeRecipient(to);
  const allowed = listRecipients().recipients;
  if (!allowUnlisted && !allowed.includes(recipient)) {
    throw new Error(`recipient "${recipient}" is not in the allowed list (add it first)`);
  }
  const body = String(text ?? '');
  if (!body.trim()) throw new Error('message text is required');
  if (body.length > 4000) throw new Error('message too long (max 4000 chars)');
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "Messages"',
    '  set targetService to 1st account whose service type = iMessage',
    `  set targetBuddy to participant "${esc(recipient)}" of targetService`,
    `  send "${esc(body)}" to targetBuddy`,
    'end tell',
  ].join('\n');
  runner('osascript', ['-e', script]);
  record('send', { to: recipient, chars: body.length });
  emit('sent', { to: recipient, chars: body.length });
  return { to: recipient, sent: true, chars: body.length };
}

module.exports = {
  macMessagesService: {
    GRANTS,
    checkPermissions, probeFullDiskAccess, probeContacts, probeAutomation,
    getEnabled, setEnabled, getAppIcon,
    listRecipients, allowRecipients, revokeRecipient,
    requestGrants, awaitGrants, resolveGrants, cancelGrants,
    readStatus, listChats, readMessages, searchMessages, sendMessage,
    _setRunner,
  },
};
