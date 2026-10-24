'use strict';
/**
 * Consent service — local tool-permission grants (Grok Bot's
 * getLocalToolPermission / setLocalToolPermission / recordLocalToolStandingGrant,
 * minus the cloud credential flows). A user can, per scope (`*` = global or a
 * session id), set a tool subject to `allow` (a standing approval that overrides
 * policy gates the coordinator would otherwise apply) or `deny` (a hard block
 * that overrides everything, including permissive turns). Default is no grant →
 * unchanged behavior.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR); re-read on mtime so the
 * forked coordinator observes main-process saves, like settingsService.
 */
const fs = require('node:fs');
const path = require('node:path');

const MODES = new Set(['allow', 'deny']);
const SCOPE_RE = /^(\*|[A-Za-z0-9_-]{1,64})$/;
const SUBJECT_RE = /^[A-Za-z0-9_.*-]{1,80}$/;

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'consent.json'); }

let cached = null;
let cachedMtimeMs = -1;
function readAll() {
  try {
    const mtimeMs = fs.statSync(file()).mtimeMs;
    if (cached && mtimeMs === cachedMtimeMs) return cached;
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cached = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    cached = cached ?? {};
  }
  return cached;
}
function writeAll(store) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(store, null, 2), { mode: 0o600 });
  cached = store;
  cachedMtimeMs = fs.statSync(file()).mtimeMs;
}

function checkScope(scope) { const s = String(scope || '*'); if (!SCOPE_RE.test(s)) throw new Error('invalid scope'); return s; }
function checkSubject(subject) { const s = String(subject || ''); if (!SUBJECT_RE.test(s)) throw new Error('invalid subject'); return s; }

/** Decision for a tool under a scope: exact subject, then wildcard `*`, else undefined. */
function getGrant(scope, subject) {
  const store = readAll();
  const scopeKey = checkScope(scope);
  const exact = store[scopeKey]?.[String(subject)];
  if (exact) return exact.mode;
  const wildcard = exact === undefined ? store[scopeKey]?.['*'] : undefined;
  return wildcard ? wildcard.mode : undefined;
}
function setGrant(scope, subject, mode) {
  const s = checkScope(scope);
  const sub = checkSubject(subject);
  if (!MODES.has(mode)) throw new Error("mode must be 'allow' or 'deny'");
  const store = readAll();
  store[s] = store[s] || {};
  store[s][sub] = { mode, updatedAt: Date.now() };
  writeAll(store);
  return { scope: s, subject: sub, mode };
}
function revokeGrant(scope, subject) {
  const s = checkScope(scope);
  const sub = checkSubject(subject);
  const store = readAll();
  if (store[s]) { delete store[s][sub]; if (!Object.keys(store[s]).length) delete store[s]; }
  writeAll(store);
  return { scope: s, subject: sub, revoked: true };
}
function listGrants(scope) {
  const store = readAll();
  if (scope !== undefined && scope !== null) {
    const s = checkScope(scope);
    return Object.entries(store[s] || {}).map(([subject, v]) => ({ scope: s, subject, ...v }));
  }
  return Object.entries(store).flatMap(([s, subs]) => Object.entries(subs).map(([subject, v]) => ({ scope: s, subject, ...v })));
}

// ---- one-time local tool approvals (Grok recordLocalToolApproval) ----
// The renderer records a single-use approval after the user confirms a local
// tool action in the UI; `resolveLocalToolPermission` reads it back as
// `allow-once` until it expires or is cleared.
const APPROVAL_TTL_MS = 15 * 60 * 1000;

function approvalsFile() { return path.join(userDataDir(), 'consent-approvals.json'); }
function readApprovals() {
  try {
    const parsed = JSON.parse(fs.readFileSync(approvalsFile(), 'utf8'));
    return Array.isArray(parsed?.approvals) ? parsed.approvals : [];
  } catch { return []; }
}
function writeApprovals(approvals) {
  fs.mkdirSync(path.dirname(approvalsFile()), { recursive: true });
  fs.writeFileSync(approvalsFile(), JSON.stringify({ approvals }, null, 2), { mode: 0o600 });
}
function freshApprovals() {
  const cutoff = Date.now() - APPROVAL_TTL_MS;
  return readApprovals().filter((a) => (a.at ?? 0) >= cutoff);
}

function recordApproval({ approvalId, action, target, machineId } = {}) {
  const id = String(approvalId ?? action ?? '');
  if (!id) throw new Error('approvalId or action is required');
  const approvals = freshApprovals();
  const record = {
    approvalId: id.slice(0, 120),
    action: String(action ?? '').slice(0, 80),
    target: String(target ?? '').slice(0, 500),
    machineId: machineId ? String(machineId).slice(0, 120) : null,
    at: Date.now(),
  };
  approvals.push(record);
  writeApprovals(approvals);
  return { ...record, recorded: true, expiresAt: record.at + APPROVAL_TTL_MS };
}

function findApproval({ action, target } = {}) {
  const a = String(action ?? '');
  const t = String(target ?? '');
  return freshApprovals().find((r) => r.action === a && (!t || r.target === t)) ?? null;
}

function listApprovals() { return freshApprovals(); }

function clearApprovals() {
  const count = freshApprovals().length;
  writeApprovals([]);
  return { cleared: count };
}

module.exports = {
  consentService: { getGrant, setGrant, revokeGrant, listGrants, recordApproval, findApproval, listApprovals, clearApprovals },
};
