'use strict';
/* Chrome cookie reader — worker-thread (off-main-thread) path.
 *
 *  - a real SQLite cookie DB is built with the sqlite3 CLI
 *  - a Chrome 130+ domain-bound value (sha256(host_key) prefix) is stored
 *  - the WAL sidecar carries a row that only exists in the log
 *  - readCookiesAsync() must return both, with the prefix stripped
 *
 * No custom runner is injected here on purpose: the worker path is only
 * used for the real runner (a test-injected function cannot cross a thread
 * boundary). The Keychain is bypassed by passing an explicit `key`.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cookie-worker-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { chromeCookies } = require('../src/main/services/chromeCookies');

const PASSWORD = 'worker-safe-storage-password';
const KEY = chromeCookies.deriveKey(PASSWORD);

function encrypt(value, key = KEY) {
  const iv = Buffer.alloc(16, 0x20);
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const pad = 16 - (buf.length % 16);
  const plain = Buffer.concat([buf, Buffer.alloc(pad, pad)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

function domainBound(hostKey, value) {
  const hash = crypto.createHash('sha256').update(hostKey, 'utf8').digest();
  return encrypt(Buffer.concat([hash, Buffer.from(value, 'utf8')]));
}

(async () => {
  // Snapshot dirs left behind by *earlier* runs (the old implementation
  // unlinked a directory, which silently failed) must not count as a leak
  // from this run.
  const staleCookieDirs = new Set(
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('qx-cookies-')),
  );

  const dbDir = path.join(tmp, 'Chrome', 'Default');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'Cookies');

  // Build a real cookie DB. The row is written through the WAL (journal_mode
  // WAL keeps recent writes in Cookies-wal until a checkpoint).
  // NOTE: sqlite blob literals need HEX (sqlite3 emits BLOBs as base64 in JSON
  // output, which is what the reader parses back).
  const hex = (buf) => buf.toString('hex');
  execFileSync('/usr/bin/sqlite3', [dbPath], {
    input: `
      PRAGMA journal_mode=WAL;
      CREATE TABLE cookies (
        creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, name TEXT NOT NULL,
        value TEXT NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL,
        is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
        last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL,
        is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL,
        encrypted_value BLOB, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL
      );
      INSERT INTO cookies VALUES (0,'.example.com','sid','', '/', 0, 1, 1, 0, 0, 1, 1,
        x'${hex(domainBound('.example.com', 'worker-token'))}', 0, 0);
      INSERT INTO cookies VALUES (0,'.example.com','plain','', '/', 0, 1, 1, 0, 0, 1, 1,
        x'${hex(encrypt('plain-worker'))}', 0, 0);
      PRAGMA wal_checkpoint(TRUNCATE);
    `,
  });
  // Re-open in WAL mode and add a row that only lives in the log, then leave
  // the WAL un-checkpointed so the snapshot must replay it.
  execFileSync('/usr/bin/sqlite3', [dbPath], {
    input: `
      PRAGMA journal_mode=WAL;
      INSERT INTO cookies VALUES (0,'.example.com','walside','', '/', 0, 1, 1, 0, 0, 1, 1,
        x'${hex(domainBound('.example.com', 'wal-token'))}', 0, 0);
    `,
  });
  assert.ok(fs.existsSync(`${dbPath}-wal`), 'the WAL sidecar exists before the read');

  const res = await chromeCookies.readCookiesAsync({ dbPath, key: KEY });
  assert.equal(res.error, undefined);
  const byName = new Map(res.cookies.map((c) => [c.name, c]));

  // the domain-bound value is readable (no 32-byte sha256 prefix)
  assert.equal(byName.get('sid').value, 'worker-token');
  assert.equal(byName.get('plain').value, 'plain-worker');
  // the WAL-resident row was found (it only exists in Cookies-wal)
  assert.equal(byName.get('walside').value, 'wal-token');

  // the snapshot is cleaned up afterwards (dirs leaked by older runs of the
  // previous implementation are ignored — only this run's snapshots count)
  const leftovers = fs.readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('qx-cookies-') && !staleCookieDirs.has(n));
  assert.deepEqual(leftovers, [], 'no snapshot directory is left behind');

  // a missing database is reported honestly, not as an empty success
  const missing = await chromeCookies.readCookiesAsync({ dbPath: path.join(tmp, 'nope', 'Cookies'), key: KEY });
  assert.ok(missing.error, 'a missing DB reports an error');
  assert.equal(missing.cookies.length, 0);

  console.log('cookies-worker test: ALL OK (worker read/domain-bound/WAL rows/cleanup/missing)');
})().catch((e) => { console.error(e); process.exit(1); });
