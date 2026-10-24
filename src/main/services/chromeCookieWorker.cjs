'use strict';
/**
 * Chrome cookie reader worker.
 *
 * Runs the whole snapshot → sqlite3 query → Keychain → decrypt pipeline off
 * the Electron main thread so a Keychain prompt or a large cookie jar never
 * freezes the UI. The logic intentionally mirrors `chromeCookies.js` exactly;
 * this file is a thin CommonJS worker that re-implements it against the real
 * `execFileSync` runner (a test-injected runner cannot cross a thread
 * boundary, so the parent falls back to its synchronous path in that case).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parentPort, workerData } = require('node:worker_threads');

const CHROME_EPOCH_MS = 11644473600000;
const SALT = 'saltysalt';
const ITERATIONS = 1003;
const KEY_LENGTH = 16;
const MAX_COOKIES = 5000;
const HOST_HASH_LEN = 32;

const BROWSERS = {
  chrome: ['Google/Chrome'],
  chromium: ['Chromium'],
  edge: ['Microsoft Edge'],
  brave: ['BraveSoftware/Brave-Browser'],
  arc: ['Arc/User Data'],
};

function runner(bin, args, opts) {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function appSupport() {
  return process.env.QUANSIOX_BROWSER_SUPPORT_DIR || path.join(os.homedir(), 'Library', 'Application Support');
}

function listProfiles({ support = appSupport() } = {}) {
  const found = [];
  for (const [browser, rels] of Object.entries(BROWSERS)) {
    for (const rel of rels) {
      const base = path.join(support, rel);
      if (rel.endsWith('User Data')) {
        const cookies = path.join(base, 'Default', 'Cookies');
        if (fs.existsSync(cookies)) found.push({ browser, profile: 'Default', path: cookies });
        continue;
      }
      let entries = [];
      try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/^(Default|Profile \d+|Guest Profile)$/.test(entry.name)) continue;
        const cookies = path.join(base, entry.name, 'Cookies');
        if (fs.existsSync(cookies)) found.push({ browser, profile: entry.name, path: cookies });
      }
    }
  }
  return found;
}

function keychainPassword(browser = 'chrome') {
  const service = browser === 'edge' ? 'Microsoft Edge Safe Storage'
    : browser === 'brave' ? 'Brave Safe Storage'
      : browser === 'chromium' ? 'Chromium Safe Storage'
        : 'Chrome Safe Storage';
  try {
    const out = runner('/usr/bin/security', ['find-generic-password', '-w', '-s', service], {});
    return String(out).replace(/\n$/, '') || null;
  } catch {
    return null;
  }
}

function deriveKey(password) {
  return crypto.pbkdf2Sync(String(password), SALT, ITERATIONS, KEY_LENGTH, 'sha1');
}

function stripHostHash(plain, hostKey) {
  if (!plain || plain.length < HOST_HASH_LEN) return plain;
  if (!hostKey) return plain;
  const host = String(hostKey);
  const candidates = host.startsWith('.') ? [host, host.slice(1)] : [host, `.${host}`];
  for (const candidate of candidates) {
    const hash = crypto.createHash('sha256').update(candidate, 'utf8').digest();
    if (plain.subarray(0, HOST_HASH_LEN).equals(hash)) return plain.subarray(HOST_HASH_LEN);
  }
  return plain;
}

function decryptValue(encrypted, key, hostKey) {
  if (!encrypted) return '';
  const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(String(encrypted), 'utf8');
  if (buf.length === 0) return '';
  if (buf.subarray(0, 3).toString('utf8') !== 'v10') return '';
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  let out;
  try { out = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]); } catch { return ''; }
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16 && pad <= out.length) out = out.subarray(0, out.length - pad);
  out = stripHostHash(out, hostKey);
  return out.toString('utf8');
}

function chromeExpiryToMs(value) {
  const n = Number(value) || 0;
  if (n <= 0) return 0;
  if (n > 1e15) return Math.round(n / 1000) - CHROME_EPOCH_MS;
  return n * 1000 - CHROME_EPOCH_MS;
}

/**
 * Convert a JSON column back to bytes.
 *
 * The sqlite3 CLI's `-json` mode emits a BLOB as a JSON string whose code
 * units are the raw bytes (escaped as \uXXXX), NOT base64 — decoding it as
 * base64 silently broke every encrypted cookie.
 */
function blobToBuffer(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.from(value);
  return Buffer.from(String(value), 'latin1');
}

/** Snapshot Cookies + Cookies-wal + Cookies-shm so live sessions are included. */
function snapshotCookieDb(dbPath, destDir) {
  const dest = path.join(destDir, path.basename(dbPath));
  fs.copyFileSync(dbPath, dest);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    try { if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${dest}${suffix}`); } catch { /* optional */ }
  }
  return dest;
}

function readEncryptedRows(dbPath, { domains = [], limit = MAX_COOKIES } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cookies-'));
  try {
    const snapshot = snapshotCookieDb(dbPath, tmp);
    const where = domains.length
      ? `WHERE ${domains.map((d) => `host_key LIKE '%${String(d).replace(/'/g, "''")}%'`).join(' OR ')}`
      : '';
    const sql = `SELECT host_key, name, path, expires_utc, is_secure, is_httponly, encrypted_value, value FROM cookies ${where} LIMIT ${Math.max(1, Math.min(MAX_COOKIES, Number(limit) || MAX_COOKIES))};`;
    const out = runner('/usr/bin/sqlite3', ['-readonly', '-json', snapshot, sql], {});
    const rows = JSON.parse(String(out || '[]'));
    return rows.map((r) => ({ ...r, encrypted_value: blobToBuffer(r.encrypted_value) }));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function readCookies({ browser = 'chrome', dbPath, domains = [], key } = {}) {
  const db = dbPath || (listProfiles().find((p) => p.browser === browser)?.path);
  if (!db || !fs.existsSync(db)) return { cookies: [], error: `no ${browser} cookie database found` };
  let rows;
  try { rows = readEncryptedRows(db, { domains }); } catch (e) {
    return { cookies: [], error: `cookie db read failed: ${String(e?.message ?? e)}` };
  }
  const plain = rows.filter((r) => r.value && !r.encrypted_value?.length);
  const enc = rows.filter((r) => r.encrypted_value?.length);
  let resolved = key;
  if (enc.length && !resolved) {
    const pw = keychainPassword(browser);
    if (!pw) return { cookies: [], needsKeychain: true, error: 'Keychain access to the browser Safe Storage key was denied' };
    resolved = deriveKey(pw);
  }
  const cookies = [];
  for (const r of plain) {
    cookies.push({
      domain: String(r.host_key).replace(/^\.+/, ''), name: r.name, value: String(r.value),
      path: r.path || '/', secure: Number(r.is_secure) === 1, httpOnly: Number(r.is_httponly) === 1,
      expires: chromeExpiryToMs(r.expires_utc),
    });
  }
  for (const r of enc) {
    const value = decryptValue(r.encrypted_value, resolved, r.host_key);
    if (!value) continue;
    cookies.push({
      domain: String(r.host_key).replace(/^\.+/, ''), name: r.name, value,
      path: r.path || '/', secure: Number(r.is_secure) === 1, httpOnly: Number(r.is_httponly) === 1,
      expires: chromeExpiryToMs(r.expires_utc),
    });
  }
  return { cookies };
}

try {
  parentPort?.postMessage(readCookies(workerData || {}));
} catch (error) {
  parentPort?.postMessage({ cookies: [], error: String(error?.message ?? error) });
}
