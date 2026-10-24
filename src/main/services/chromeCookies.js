'use strict';
/**
 * Chrome/Edge/Brave cookie reader for the in-app browser (Grok Bot
 * `importChromeCookies` parity). This is the one place that touches another
 * browser's private data, so it is deliberately narrow and explicit:
 *
 *  - Off by default: requires `chromeCookieImport: true` in settings.
 *  - Values are AES-128-CBC encrypted with a key derived from the macOS
 *    Keychain item "Chrome Safe Storage"; reading it triggers a Keychain
 *    prompt (`security find-generic-password`). We never cache the password.
 *  - The database is opened read-only and copied first, so Chrome is never
 *    locked and no writes can happen.
 *  - Decrypted values stay in memory and are returned only for the origins the
 *    session has explicitly granted (enforced by cookieImportService).
 *
 * Chromium >= 130 (cookie DB `meta.version >= 24`) binds a cookie to its host
 * by prepending a 32-byte SHA-256 of `host_key` to the plaintext. Grok Bot
 * strips that prefix in its `chrome-import-worker.cjs`; we do the same here
 * (see `stripHostHash`) — without it every imported value starts with 32
 * binary bytes and every authenticated site rejects the cookie.
 *
 * The live Chrome database is a WAL: recent (session) cookies live in
 * `Cookies-wal` until a checkpoint happens. We therefore snapshot `Cookies`,
 * `Cookies-wal` and `Cookies-shm` together, or we silently miss the cookies
 * the user actually cares about.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

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

let runner = (bin, args, opts) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
let sqliteCheck = null;
// A custom runner means a test harness injected SQL/Keychain fakes. The
// worker-thread path cannot carry a function across the thread boundary, so
// it is only used for the real (default) runner.
let customRunner = false;

/** True when a custom runner was injected (tests). */
function hasCustomRunner() { return customRunner; }

function appSupport() {
  return process.env.QUANSIOX_BROWSER_SUPPORT_DIR || path.join(os.homedir(), 'Library', 'Application Support');
}

/** Discover cookie databases across installed Chromium-family browsers. */
function listProfiles({ support = appSupport() } = {}) {
  const found = [];
  for (const [browser, rels] of Object.entries(BROWSERS)) {
    for (const rel of rels) {
      const base = path.join(support, rel);
      if (rel.endsWith('User Data')) { // Arc keeps User Data one level deeper
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

/** The app Keychain password, or null if the user cancels / item is absent. */
function keychainPassword(browser = 'chrome', opts = {}) {
  const service = browser === 'edge' ? 'Microsoft Edge Safe Storage'
    : browser === 'brave' ? 'Brave Safe Storage'
      : browser === 'chromium' ? 'Chromium Safe Storage'
        : 'Chrome Safe Storage';
  try {
    const out = runner('/usr/bin/security', ['find-generic-password', '-w', '-s', service], opts);
    return String(out).replace(/\n$/, '') || null;
  } catch {
    return null;
  }
}

/** PBKDF2-HMAC-SHA1, 1003 iterations, 16 bytes (Chromium on macOS). */
function deriveKey(password) {
  return crypto.pbkdf2Sync(String(password), SALT, ITERATIONS, KEY_LENGTH, 'sha1');
}

/**
 * Strip Chromium's domain-binding prefix.
 *
 * Cookie DB `meta.version >= 24` (Chrome 130+) stores the plaintext as
 * `sha256(host_key) || value`. The hash is verified, so a cookie that predates
 * the change (or a host we mis-canonicalised) is returned untouched.
 */
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

/** Decrypt one Chrome `encrypted_value` (v10 prefix, IV = 16 spaces). */
function decryptValue(encrypted, key, hostKey) {
  if (!encrypted) return '';
  const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(String(encrypted), 'utf8');
  if (buf.length === 0) return '';
  if (buf.subarray(0, 3).toString('utf8') !== 'v10') {
    // Some builds store plaintext in `value`; encrypted_value would be empty.
    return '';
  }
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  let out;
  try { out = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]); } catch { return ''; }
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16 && pad <= out.length) out = out.subarray(0, out.length - pad);
  // Chrome >= 130 prepends sha256(host_key) to the plaintext (see stripHostHash).
  out = stripHostHash(out, hostKey);
  return out.toString('utf8');
}

function chromeExpiryToMs(value) {
  const n = Number(value) || 0;
  if (n <= 0) return 0;
  if (n > 1e15) return Math.round(n / 1000) - CHROME_EPOCH_MS; // microseconds
  return n * 1000 - CHROME_EPOCH_MS; // seconds
}

/**
 * Convert a JSON column back to bytes.
 *
 * The sqlite3 CLI's `-json` mode emits a BLOB as a JSON string whose code
 * units are the raw bytes (escaped as \uXXXX), NOT base64. Decoding it as
 * base64 produced garbage, every AES decryption failed, and the import
 * silently returned zero cookies. `latin1` maps each code unit back to one
 * byte, which is the exact inverse of what the CLI emits.
 */
function blobToBuffer(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.from(value);
  return Buffer.from(String(value), 'latin1');
}

/**
 * Snapshot the live cookie database.
 *
 * Chrome keeps recently-written cookies in the write-ahead log until a
 * checkpoint runs, so a copy of `Cookies` alone misses live session cookies.
 * We copy `Cookies`, `Cookies-wal` and `Cookies-shm` side by side (same
 * base name, so SQLite replays the log) before opening the snapshot.
 */
function snapshotCookieDb(dbPath, destDir) {
  const base = path.basename(dbPath);
  const dest = path.join(destDir, base);
  fs.copyFileSync(dbPath, dest);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    try {
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${dest}${suffix}`);
    } catch { /* sidecar is optional (checkpointed DBs have none) */ }
  }
  return dest;
}

/** Read raw (still encrypted) cookie rows from a cookie DB, read-only. */
function readEncryptedRows(dbPath, { domains = [], limit = MAX_COOKIES } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cookies-'));
  try {
    // never lock or touch Chrome's live DB
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

/**
 * Read + decrypt cookies for a browser profile.
 * @returns {{cookies:Array, needsKeychain?:boolean, error?:string}}
 */
function readCookies({ browser = 'chrome', dbPath, domains = [], key } = {}) {
  if (sqliteCheck && sqliteCheck() === false) return { cookies: [], error: 'sqlite3 unavailable' };
  const db = dbPath || (listProfiles().find((p) => p.browser === browser)?.path);
  if (!db || !fs.existsSync(db)) return { cookies: [], error: `no ${browser} cookie database found` };
  let rows;
  try { rows = readEncryptedRows(db, { domains }); } catch (e) { return { cookies: [], error: `cookie db read failed: ${String(e?.message ?? e)}` }; }

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
    cookies.push({ domain: String(r.host_key).replace(/^\.+/, ''), name: r.name, value: String(r.value), path: r.path || '/', secure: Number(r.is_secure) === 1, httpOnly: Number(r.is_httponly) === 1, expires: chromeExpiryToMs(r.expires_utc) });
  }
  for (const r of enc) {
    const value = decryptValue(r.encrypted_value, resolved, r.host_key);
    if (!value) continue;
    cookies.push({ domain: String(r.host_key).replace(/^\.+/, ''), name: r.name, value, path: r.path || '/', secure: Number(r.is_secure) === 1, httpOnly: Number(r.is_httponly) === 1, expires: chromeExpiryToMs(r.expires_utc) });
  }
  return { cookies };
}

/**
 * Off-main-thread cookie read.
 *
 * The synchronous path above blocks the Electron main thread for the whole
 * Keychain prompt + sqlite3 scan (hundreds of ms, and a Keychain modal on
 * top). The UI calls this variant so the window never freezes; the worker
 * re-runs the identical snapshot→query→decrypt pipeline in its own thread.
 *
 * Falls back to the synchronous path when a custom runner is injected
 * (tests) or when the worker cannot start.
 */
async function readCookiesAsync(opts = {}) {
  if (customRunner) return readCookies(opts);
  if (sqliteCheck && sqliteCheck() === false) return { cookies: [], error: 'sqlite3 unavailable' };
  try {
    const { Worker } = require('node:worker_threads');
    const workerPath = path.join(__dirname, 'chromeCookieWorker.cjs');
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: opts });
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('cookie read timed out')); }, 60_000);
      worker.once('message', (msg) => {
        clearTimeout(timer);
        worker.terminate();
        if (msg?.error) reject(Object.assign(new Error(msg.error), { needsKeychain: msg.needsKeychain === true }));
        else resolve(msg);
      });
      worker.once('error', (error) => { clearTimeout(timer); reject(error); });
      worker.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`cookie worker exited (${code})`)); });
    });
    return result;
  } catch (error) {
    // Honest fallback: the sync path still produces the right answer, it is
    // just slower. Never fail the import because the worker could not start.
    try { return readCookies(opts); } catch { /* fall through */ }
    return { cookies: [], error: `cookie read failed: ${String(error?.message ?? error)}` };
  }
}

module.exports = {
  chromeCookies: {
    listProfiles, keychainPassword, deriveKey, decryptValue, chromeExpiryToMs,
    readEncryptedRows, readCookies, readCookiesAsync,
    stripHostHash, snapshotCookieDb, hasCustomRunner,
    _setRunner: (fn) => { runner = fn; customRunner = true; },
    _setSqliteCheck: (fn) => { sqliteCheck = fn; },
  },
  _constants: { CHROME_EPOCH_MS, ITERATIONS, SALT, HOST_HASH_LEN },
};
