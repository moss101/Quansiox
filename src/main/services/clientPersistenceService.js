'use strict';
/**
 * Client-persistence service — the desktop key-value store the renderer uses
 * for durable UI state (Grok Bot's readClientPersistence / writeClientPersistence
 * family, including the localStorage migration path). File-backed, 0600, with
 * size/count caps so a runaway renderer cannot wedge the app.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR).
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_KEY_LEN = 512;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_KEYS = 5000;

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'client-persistence.json'); }

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.values && typeof parsed.values === 'object') return parsed;
  } catch {}
  return { values: {}, migrated: false };
}
function writeAll(store) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(store, null, 2), { mode: 0o600 });
}
function checkKey(key) {
  const k = String(key ?? '');
  if (!k || k.length > MAX_KEY_LEN) throw new Error('invalid persistence key');
  return k;
}
function checkValue(value) {
  const v = String(value ?? '');
  if (Buffer.byteLength(v) > MAX_VALUE_BYTES) throw new Error('persistence value too large (max 1 MB)');
  return v;
}

function read({ key } = {}) {
  const k = checkKey(key);
  const store = readAll();
  const value = Object.prototype.hasOwnProperty.call(store.values, k) ? store.values[k] : null;
  return { key: k, value };
}

function readMany({ include, exclude } = {}) {
  const store = readAll();
  const inc = Array.isArray(include) ? include.map(String) : [];
  const exc = Array.isArray(exclude) ? exclude.map(String) : [];
  const values = {};
  for (const [k, v] of Object.entries(store.values)) {
    if (inc.length && !inc.some((p) => k.startsWith(p))) continue;
    if (exc.some((p) => k.startsWith(p))) continue;
    values[k] = v;
  }
  return { values, count: Object.keys(values).length };
}

function write({ key, value } = {}) {
  const k = checkKey(key);
  const v = checkValue(value);
  const store = readAll();
  if (!Object.prototype.hasOwnProperty.call(store.values, k) && Object.keys(store.values).length >= MAX_KEYS) {
    throw new Error(`persistence store full (max ${MAX_KEYS} keys)`);
  }
  store.values[k] = v;
  writeAll(store);
  return { key: k, ok: true };
}

function remove({ key } = {}) {
  const k = checkKey(key);
  const store = readAll();
  const had = Object.prototype.hasOwnProperty.call(store.values, k);
  delete store.values[k];
  writeAll(store);
  return { key: k, removed: had };
}

function listKeys({ prefix } = {}) {
  const store = readAll();
  const p = String(prefix ?? '');
  return { keys: Object.keys(store.values).filter((k) => k.startsWith(p)).sort() };
}

function hasMigrated() {
  return { migrated: Boolean(readAll().migrated) };
}

/** One-way import from the renderer's localStorage residue. */
function migrate({ entries } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const store = readAll();
  let applied = 0;
  for (const entry of list) {
    const k = String(entry?.key ?? '');
    if (!k || k.length > MAX_KEY_LEN) continue;
    if (Object.prototype.hasOwnProperty.call(store.values, k)) continue;
    const v = String(entry?.value ?? '');
    if (Buffer.byteLength(v) > MAX_VALUE_BYTES) continue;
    store.values[k] = v;
    applied += 1;
  }
  store.migrated = true;
  writeAll(store);
  return { migrated: true, applied, total: Object.keys(store.values).length };
}

module.exports = { clientPersistenceService: { read, readMany, write, remove, listKeys, hasMigrated, migrate } };
