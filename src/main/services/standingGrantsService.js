'use strict';
/**
 * Standing-grant service — "always allow this" decisions that outlive a turn.
 *
 * Grok Bot identifies a standing grant by `(accountScope, scope, action[, recipient])`
 * where `scope` is either `action` (this exact action) or `subject` (this action
 * for a particular recipient), and stores them in a versioned file with a
 * `grantedAtMs` on each grant. We keep that identity and add the two things a
 * local-first app needs and the reference does not have:
 *
 *   - a **target**: an "always allow" must be bound to *what* was approved,
 *     not just to the tool name. "Always allow git push" must not become
 *     "always allow `shell`";
 *   - an **expiry**: a grant the user made months ago should not silently
 *     authorise something today.
 *
 * Grants are stored 0600 and are pruned on read.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const MAX_GRANTS = 500;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_TARGET_LEN = 1024;
const MAX_RECIPIENT_LEN = 320;

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'tool-standing-grants.json'); }

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.grants)) {
      return { version: VERSION, grants: parsed.grants };
    }
  } catch {}
  return { version: VERSION, grants: [] };
}

function writeAll(store) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

/**
 * The identity of a grant. Two grants match only when every field matches.
 * @param {object} grant
 * @returns {string}
 */
function grantKey(grant) {
  return JSON.stringify([
    String(grant?.scope ?? 'action'),
    String(grant?.action ?? ''),
    String(grant?.target ?? ''),
    String(grant?.recipient ?? ''),
  ]);
}

function normalize(input = {}) {
  const scope = input.scope === 'subject' ? 'subject' : 'action';
  const action = String(input.action ?? '').trim();
  if (!action) throw new Error('a grant needs an action');
  const target = String(input.target ?? '').trim().slice(0, MAX_TARGET_LEN);
  const recipient = String(input.recipient ?? '').trim().slice(0, MAX_RECIPIENT_LEN);
  if (recipient.includes('\n')) throw new Error('a grant recipient cannot contain a newline');
  const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs > 0
    ? Math.min(Number(input.ttlMs), DEFAULT_TTL_MS * 12)
    : DEFAULT_TTL_MS;
  const now = Date.now();
  return {
    id: String(input.id ?? crypto.randomUUID()),
    scope,
    action,
    target,
    recipient,
    tool: String(input.tool ?? action).trim().slice(0, 128),
    grantedAtMs: Number(input.grantedAtMs) || now,
    expiresAtMs: now + ttlMs,
  };
}

function prune(grants, now = Date.now()) {
  return grants.filter((g) => !g?.expiresAtMs || g.expiresAtMs > now);
}

/**
 * Record a standing grant. Re-granting the same identity refreshes it rather
 * than accumulating duplicates.
 */
function add(input = {}) {
  const grant = normalize(input);
  const store = readAll();
  const pruned = prune(store.grants);
  const key = grantKey(grant);
  const existing = pruned.findIndex((g) => grantKey(g) === key);
  if (existing >= 0) {
    const merged = { ...pruned[existing], grantedAtMs: Date.now(), expiresAtMs: grant.expiresAtMs };
    pruned[existing] = merged;
    store.grants = pruned;
    writeAll(store);
    return merged;
  }
  if (pruned.length >= MAX_GRANTS) throw new Error(`too many standing grants (max ${MAX_GRANTS})`);
  pruned.push(grant);
  store.grants = pruned;
  writeAll(store);
  return grant;
}

/**
 * Does a standing grant cover this action?
 *
 * A grant with a `target` only covers that exact target — a grant for
 * `git push --force origin main` does not cover `git push --force origin
 * other`.
 */
function has(input = {}) {
  const now = Date.now();
  const grants = prune(readAll().grants, now);
  const probe = {
    scope: input.scope === 'subject' ? 'subject' : 'action',
    action: String(input.action ?? '').trim(),
    target: String(input.target ?? '').trim(),
    recipient: String(input.recipient ?? '').trim(),
  };
  const probeKey = grantKey(probe);
  return grants.some((g) => grantKey(g) === probeKey);
}

/** All grants, newest first, with expired ones removed. */
function list({ includeExpired = false } = {}) {
  const now = Date.now();
  const all = readAll().grants;
  const kept = includeExpired ? all : prune(all, now);
  return {
    grants: [...kept].sort((a, b) => (b.grantedAtMs ?? 0) - (a.grantedAtMs ?? 0)),
    expired: all.length - prune(all, now).length,
  };
}

function revoke({ id } = {}) {
  const target = String(id ?? '');
  const store = readAll();
  const before = store.grants.length;
  store.grants = store.grants.filter((g) => g.id !== target);
  writeAll(store);
  return { id: target, removed: store.grants.length !== before };
}

function revokeAll() {
  const store = readAll();
  const removed = store.grants.length;
  store.grants = [];
  writeAll(store);
  return { removed };
}

module.exports = {
  standingGrantsService: { add, has, list, revoke, revokeAll, grantKey, DEFAULT_TTL_MS },
};
