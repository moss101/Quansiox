'use strict';
/**
 * Secrets service — Grok Bot-style encrypted secret store with
 * `{{secret:<name>.<field>}}` reference resolution.
 *
 * At rest: an AES-256-GCM encrypted blob (secrets.vault) keyed by a 32-byte
 * random key in a 0600 file (.secrets.key) under userData — the same
 * 0600-on-disk trust model Cue uses for its device-id. This module is
 * Electron-free (honours QUANSIOX_USER_DATA_DIR) so the forked coordinator
 * can resolve references at tool-execution time, exactly like Grok's operator
 * provisions secret references to its exec-daemon. Values are never returned
 * by list(); only names + field names + metadata are exposed.
 *
 * Hardening note: wrapping .secrets.key with Electron safeStorage in the main
 * process is a future step; the 0600 keyfile keeps the store usable by the
 * child process today (like Manus's device-token handoff).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FIELD_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const REF_RE = /\{\{\s*secret:\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const MAX_FIELDS = 32;

function userDataDir() {
  return require('./userData').userDataDir();
}

function keyFile() { return path.join(userDataDir(), '.secrets.key'); }
function wrappedKeyFile() { return path.join(userDataDir(), '.secrets.key.wrapped'); }
function vaultFile() { return path.join(userDataDir(), 'secrets.vault'); }

/** Electron safeStorage when running in the main process and usable. */
function safeStorageApi() {
  try {
    const { safeStorage } = require('electron'); // lazy: main process only
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) return safeStorage;
  } catch { /* child process or stub */ }
  return null;
}

/** Parse a 32-byte key from hex (64), base64, or a raw utf8 fallback. */
function parseKey(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  try { const b = Buffer.from(s, 'base64'); if (b.length === 32) return b; } catch { /* not base64 */ }
  const raw = Buffer.from(s, 'utf8');
  return raw.length === 32 ? raw : null;
}

function loadKey() {
  // 1. Injected by the main process (wrapped-key handoff to the coordinator).
  const injected = parseKey(process.env.QUANSIOX_SECRETS_KEY);
  if (injected) return injected;
  // 2. safeStorage-wrapped key (main process, when OS encryption is available).
  const ss = safeStorageApi();
  if (ss) {
    try {
      const wrapped = fs.readFileSync(wrappedKeyFile(), 'utf8').trim();
      const dec = ss.decryptString(Buffer.from(wrapped, 'base64'));
      const key = parseKey(dec);
      if (key) return key;
    } catch { /* fall through to the raw keyfile */ }
  }
  // 3. Legacy 0600 keyfile (also the child-process path when no env is set).
  try {
    const buf = fs.readFileSync(keyFile());
    if (buf.length === 32) return buf;
  } catch { /* first run */ }
  // 4. First run: generate and persist the 0600 keyfile.
  const key = crypto.randomBytes(32);
  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.writeFileSync(keyFile(), key, { mode: 0o600 });
  try { fs.chmodSync(keyFile(), 0o600); } catch { /* best effort */ }
  return key;
}

/**
 * Wrap the keyfile with Electron safeStorage, keeping the raw 0600 keyfile as
 * the fallback for forked children and for OSes where encryption is missing.
 * Idempotent; returns { wrapped, available }.
 */
function wrapKeyWithSafeStorage() {
  const ss = safeStorageApi();
  if (!ss) return { wrapped: false, available: false };
  const key = loadKey();
  try {
    const blob = ss.encryptString(key.toString('base64'));
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(wrappedKeyFile(), blob.toString('base64'), { mode: 0o600 });
    try { fs.chmodSync(wrappedKeyFile(), 0o600); } catch { /* best effort */ }
    return { wrapped: true, available: true };
  } catch {
    return { wrapped: false, available: true };
  }
}

/** Hex key for the main process to hand to the coordinator via env. */
function exportKeyHex() { return loadKey().toString('hex'); }

function readAll() {
  try {
    const raw = fs.readFileSync(vaultFile(), 'utf8');
    const blob = Buffer.from(raw, 'base64');
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const ct = blob.subarray(28);
    const dec = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
    dec.setAuthTag(tag);
    const pt = Buffer.concat([dec.update(ct), dec.final()]);
    const parsed = JSON.parse(pt.toString('utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {}; // no vault yet, wrong key, or corrupt → empty store
  }
}

function writeAll(store) {
  const iv = crypto.randomBytes(12);
  const enc = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([enc.update(Buffer.from(JSON.stringify(store), 'utf8')), enc.final()]);
  const blob = Buffer.concat([iv, enc.getAuthTag(), ct]);
  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.writeFileSync(vaultFile(), blob.toString('base64'), { mode: 0o600 });
}

/** Names + field names + metadata only. NEVER returns values. */
function list() {
  const store = readAll();
  return Object.keys(store).sort().map((name) => {
    const entry = store[name] || {};
    return {
      name,
      fields: Object.keys(entry.fields || {}).sort(),
      note: entry.note || '',
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
    };
  });
}

function get(name) {
  if (!validName(name)) throw new Error('invalid secret name');
  return readAll()[name] || null;
}

/** Create or merge fields onto a secret. Returns the redacted record. */
function set(name, fields, note) {
  if (!validName(name)) throw new Error('invalid secret name (use [A-Za-z0-9][A-Za-z0-9_-]*)');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields must be a { field: value } object');
  const store = readAll();
  const now = Date.now();
  const existing = store[name] || { fields: {}, createdAt: now };
  const merged = { ...existing.fields };
  let count = Object.keys(merged).length;
  for (const [k, v] of Object.entries(fields)) {
    if (!FIELD_RE.test(k)) throw new Error(`invalid field name: ${k}`);
    const value = String(v);
    if (!value) throw new Error(`empty value for field ${k}`);
    if (!(k in merged)) {
      count += 1;
      if (count > MAX_FIELDS) throw new Error('too many fields (max 32)');
    }
    merged[k] = value;
  }
  store[name] = {
    fields: merged,
    note: typeof note === 'string' ? note.slice(0, 200) : (existing.note || ''),
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  writeAll(store);
  const rec = list().find((s) => s.name === name);
  return rec;
}

function remove(name) {
  if (!validName(name)) throw new Error('invalid secret name');
  const store = readAll();
  delete store[name];
  writeAll(store);
  return true;
}

/**
 * Replace `{{secret:NAME}}` / `{{secret:NAME.FIELD}}` references in text.
 * Unknown references are left untouched so the model can see them and react.
 */
function resolve(text) {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return text;
  if (!REF_RE.test(text)) return text; // fast path: no secret refs
  REF_RE.lastIndex = 0;
  let store;
  return text.replace(REF_RE, (match, ref) => {
    const dot = ref.indexOf('.');
    const name = dot === -1 ? ref : ref.slice(0, dot);
    const field = dot === -1 ? null : ref.slice(dot + 1);
    if (!validName(name)) return match;
    if (store === undefined) store = readAll();
    const entry = store[name];
    if (!entry || !entry.fields) return match;
    if (field) {
      return field in entry.fields ? String(entry.fields[field]) : `[secret ${name} has no field ${field}]`;
    }
    const keys = Object.keys(entry.fields);
    if (keys.length === 1) return String(entry.fields[keys[0]]);
    if (keys.length === 0) return `[secret ${name} is empty]`;
    return keys.map((k) => `${k}=${entry.fields[k]}`).join('\n');
  });
}

/** Resolve references inside any string/value fields of a tool-args object. */
function resolveArgs(args) {
  const walk = (v) => {
    if (typeof v === 'string') return resolve(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(args);
}

function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/**
 * Redact the stored secret values out of a piece of text.
 *
 * A secret can leak into a transcript through a path the model never chose:
 * a command that prints a config file, a tool that reads a file containing
 * a token, an MCP server that echoes its input. The reference implementation
 * has a "redacted read" executor for exactly this.
 *
 * The values are matched literally, so only the actual secrets are masked —
 * not anything that merely looks like one.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.minLength] ignore values shorter than this
 * @returns {{ text: string, redacted: number }}
 */
function redact(text, opts = {}) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', redacted: 0 };
  const store = readAll();
  let redacted = 0;
  let out = text;
  for (const entry of Object.values(store)) {
    for (const value of Object.values(entry?.fields ?? {})) {
      const secret = String(value ?? '');
      if (secret.length < (Number(opts.minLength) || 8)) continue;
      if (!out.includes(secret)) continue;
      const parts = out.split(secret);
      redacted += parts.length - 1;
      out = parts.join('•••');
    }
  }
  return { text: out, redacted };
}

module.exports = {
  secretsService: {
    redact,
    list, get, set, remove, resolve, resolveArgs, validName,
    wrapKeyWithSafeStorage, exportKeyHex,
  },
  _internal: { readAll, writeAll, keyFile, wrappedKeyFile, vaultFile, loadKey, parseKey, safeStorageApi },
};
