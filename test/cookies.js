'use strict';
/* Chrome cookie import + vault → browser login:
 *  - PBKDF2/AES-CBC value decryption (v10, macOS params)
 *  - read-only DB copy/query with an injected runner (no real Chrome access)
 *  - explicit opt-in setting + per-session origin grants before import
 *  - browserCredentialsService fills from the vault without returning secrets.
 * Electron-free. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cookies-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { chromeCookies, _constants } = require('../src/main/services/chromeCookies');
const { cookieImportService } = require('../src/main/services/cookieImportService');
const { settingsService } = require('../src/main/services/settingsService');

const PASSWORD = 'test-safe-storage-password';
const KEY = chromeCookies.deriveKey(PASSWORD);

function encrypt(value, key = KEY) {
  const iv = Buffer.alloc(16, 0x20);
  const pad = 16 - (Buffer.byteLength(value) % 16);
  const plain = Buffer.concat([Buffer.from(value), Buffer.alloc(pad, pad)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

/**
 * Chrome 130+ (cookie DB meta.version >= 24) binds a cookie to its host:
 * the plaintext is `sha256(host_key) || value`. Reproduce that shape so the
 * regression is covered.
 */
function encryptDomainBound(hostKey, value, key = KEY) {
  const hash = crypto.createHash('sha256').update(hostKey, 'utf8').digest();
  return encrypt(Buffer.concat([hash, Buffer.from(value)]), key);
}

/**
 * The sqlite3 CLI's `-json` mode emits a BLOB as a JSON string whose code
 * units are the raw bytes (escaped as \uXXXX) — NOT base64. The fake runner
 * must reproduce that exactly, otherwise the test would not catch the
 * base64/latin1 mismatch that broke the real import.
 */
function blobColumn(buf) {
  return buf.toString('latin1');
}

(async () => {
  // Snapshot dirs left behind by *earlier* runs (the old implementation
  // unlinked a directory, which silently failed) must not count as a leak
  // from this run.
  const staleCookieDirs = new Set(
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('qx-cookies-')),
  );

  // 0. key derivation matches Chromium/macOS parameters
  assert.equal(_constants.SALT, 'saltysalt');
  assert.equal(_constants.ITERATIONS, 1003);
  assert.equal(KEY.length, 16);
  assert.equal(KEY.toString('hex'), crypto.pbkdf2Sync(PASSWORD, 'saltysalt', 1003, 16, 'sha1').toString('hex'));
  assert.notEqual(chromeCookies.deriveKey('other').toString('hex'), KEY.toString('hex'));

  // 1. decryptValue: v10 AES-128-CBC + PKCS7, rejects foreign prefixes
  assert.equal(chromeCookies.decryptValue(encrypt('session-token-123'), KEY), 'session-token-123');
  assert.equal(chromeCookies.decryptValue(encrypt('a'), KEY), 'a');
  assert.equal(chromeCookies.decryptValue(Buffer.from('plain-value'), KEY), '');
  assert.equal(chromeCookies.decryptValue(null, KEY), '');

  // 1b. Chrome 130+ domain binding: sha256(host_key) is prepended to the
  // plaintext and must be stripped, or every value starts with 32 garbage
  // bytes and the site rejects the cookie.
  assert.equal(
    chromeCookies.decryptValue(encryptDomainBound('.example.com', 'bound-token'), KEY, '.example.com'),
    'bound-token',
  );
  // the dot-stripped host form is accepted too (Chrome canonicalises hosts)
  assert.equal(
    chromeCookies.decryptValue(encryptDomainBound('example.com', 'bound-token'), KEY, '.example.com'),
    'bound-token',
  );
  // a cookie whose host does not match the hash is left untouched
  assert.equal(
    chromeCookies.stripHostHash(Buffer.from('0123456789abcdef0123456789abcdefXY'), '.other.test').toString('utf8'),
    '0123456789abcdef0123456789abcdefXY',
  );
  // stripHostHash is a no-op without a host key
  const raw = Buffer.alloc(40, 0x41);
  assert.equal(chromeCookies.stripHostHash(raw, null).length, 40);

  // 2. expiry conversion: seconds → ms (1601 epoch) and microseconds
  const unixMs = Date.UTC(2026, 0, 1);
  const chromeSec = (unixMs + 11644473600000) / 1000;
  assert.equal(chromeCookies.chromeExpiryToMs(chromeSec), unixMs);
  assert.equal(chromeCookies.chromeExpiryToMs(chromeSec * 1_000_000), unixMs);
  assert.equal(chromeCookies.chromeExpiryToMs(0), 0);

  // 3. listProfiles discovers only real cookie DBs
  const support = path.join(tmp, 'support');
  const dbPath = path.join(support, 'Google', 'Chrome', 'Default', 'Cookies');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, 'db');
  // a live Chrome DB ships WAL/SHM sidecars next to the main file
  fs.writeFileSync(`${dbPath}-wal`, 'wal');
  fs.writeFileSync(`${dbPath}-shm`, 'shm');
  fs.mkdirSync(path.join(support, 'Google', 'Chrome', 'NotAProfile'), { recursive: true });
  const profiles = chromeCookies.listProfiles({ support });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].browser, 'chrome');
  assert.equal(profiles[0].path, dbPath);

  // 4. readCookies with an injected runner (sqlite → rows, security → key)
  const calls = [];
  chromeCookies._setRunner((bin, args) => {
    calls.push({ bin, args });
    if (bin === '/usr/bin/security') return `${PASSWORD}\n`;
    if (bin === '/usr/bin/sqlite3') {
      assert.ok(args.includes('-readonly'));
      // the snapshot must carry the WAL sidecar so live session cookies are
      // visible (Chrome keeps recent writes in Cookies-wal until checkpoint)
      const snapshot = args[args.length - 2];
      assert.ok(fs.existsSync(`${snapshot}-wal`), 'Cookies-wal is snapshotted alongside Cookies');
      assert.ok(fs.existsSync(`${snapshot}-shm`), 'Cookies-shm is snapshotted alongside Cookies');
      return JSON.stringify([
        { host_key: '.example.com', name: 'sid', path: '/', expires_utc: chromeSec, is_secure: 1, is_httponly: 1, encrypted_value: blobColumn(encrypt('token-a')), value: '' },
        { host_key: '.example.com', name: 'bound', path: '/', expires_utc: chromeSec, is_secure: 1, is_httponly: 1, encrypted_value: blobColumn(encryptDomainBound('.example.com', 'token-bound')), value: '' },
        { host_key: 'plain.test', name: 'plain', path: '/', expires_utc: 0, is_secure: 0, is_httponly: 0, encrypted_value: '', value: 'plain-b' },
        { host_key: '.example.com', name: 'broken', path: '/', expires_utc: 0, is_secure: 1, is_httponly: 0, encrypted_value: blobColumn(Buffer.from('junk')), value: '' },
      ]);
    }
    throw new Error(`unexpected ${bin}`);
  });
  const read = chromeCookies.readCookies({ dbPath });
  assert.equal(read.error, undefined);
  const byName = new Map(read.cookies.map((c) => [c.name, c]));
  assert.equal(byName.get('sid').value, 'token-a');
  assert.equal(byName.get('bound').value, 'token-bound', 'domain-bound value is stripped of its sha256 prefix');
  assert.equal(byName.get('sid').domain, 'example.com');
  assert.equal(byName.get('sid').secure, true);
  assert.equal(byName.get('sid').httpOnly, true);
  assert.equal(byName.get('sid').expires, unixMs);
  assert.equal(byName.get('plain').value, 'plain-b');
  assert.equal(byName.has('broken'), false, 'undecryptable values are skipped');
  assert.ok(calls.some((c) => c.bin === '/usr/bin/security' && c.args.includes('Chrome Safe Storage')));
  // temp copy is cleaned up
  assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => /^qx-cookies-[0-9a-f]+\.db$/.test(n)).length, 0);
  const cookieDirs = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('qx-cookies-'));
  const leaked = cookieDirs.filter((n) => !staleCookieDirs.has(n));
  assert.deepEqual(leaked, [], 'the whole snapshot dir is removed');

  // 5. keychain denied → needsKeychain, no cookies
  chromeCookies._setRunner((bin) => {
    if (bin === '/usr/bin/security') throw new Error('denied');
    return JSON.stringify([{ host_key: 'x.test', name: 'n', path: '/', expires_utc: 0, is_secure: 0, is_httponly: 0, encrypted_value: encrypt('v').toString('base64'), value: '' }]);
  });
  const denied = chromeCookies.readCookies({ dbPath });
  assert.equal(denied.needsKeychain, true);
  assert.deepEqual(denied.cookies, []);

  // 6. import gating: off by default, needs grants, then filters by grant
  settingsService.save({ workspaceRoot: tmp });
  assert.throws(() => cookieImportService.planChromeImport('s1', { dbPath }), /disabled/i);
  settingsService.save({ chromeCookieImport: true });
  assert.throws(() => cookieImportService.planChromeImport('s1', { dbPath }), /grant at least one origin/i);
  cookieImportService.putGrants('s1', { add: ['https://example.com/login'] });
  chromeCookies._setRunner((bin) => {
    if (bin === '/usr/bin/security') return `${PASSWORD}\n`;
    return JSON.stringify([
      { host_key: '.example.com', name: 'sid', path: '/', expires_utc: 0, is_secure: 1, is_httponly: 1, encrypted_value: blobColumn(encrypt('token-a')), value: '' },
      { host_key: '.other.test', name: 'other', path: '/', expires_utc: 0, is_secure: 0, is_httponly: 0, encrypted_value: blobColumn(encrypt('nope')), value: '' },
    ]);
  });
  const plan = cookieImportService.planChromeImport('s1', { dbPath });
  assert.equal(plan.parsed, 2);
  assert.equal(plan.granted, 1);
  assert.equal(plan.records[0].name, 'sid');
  assert.deepEqual(plan.unmatchedOrigins, ['other.test']);

  // 7. applyPlan goes through browserService.applyCookies (no electron → honest failure)
  const applied = await cookieImportService.applyPlan('s1', plan);
  assert.equal(applied.set, 0);
  assert.equal(applied.failed, 1);
  assert.match(applied.error, /electron (session )?unavailable/);

  // 8. Netscape parse → same grant filter (regression for the text path)
  const text = ['# Netscape HTTP Cookie File', '.example.com\tTRUE\t/\tTRUE\t0\tsid\ttoken-a', '.other.test\tTRUE\t/\tFALSE\t0\tx\ty'].join('\n');
  const textPlan = cookieImportService.planImport('s1', text);
  assert.equal(textPlan.granted, 1);
  assert.equal(textPlan.records[0].name, 'sid');

  // 8b. origin matching + grant bookkeeping + input validation
  assert.equal(cookieImportService.normalizeOrigin('https://Sub.Example.com/path'), 'sub.example.com');
  assert.equal(cookieImportService.domainMatch('.example.com', 'example.com'), true);
  assert.equal(cookieImportService.domainMatch('a.example.com', 'example.com'), true);
  assert.equal(cookieImportService.domainMatch('evil-example.com', 'example.com'), false);
  assert.equal(cookieImportService.domainMatch('example.com', ''), false);
  assert.deepEqual(cookieImportService.putGrants('s1', { add: ['other.test'] }), ['example.com', 'other.test']);
  assert.deepEqual(cookieImportService.putGrants('s1', { remove: ['other.test'] }), ['example.com']);
  assert.throws(() => cookieImportService.getGrants('../escape'), /invalid session id/);
  assert.throws(() => cookieImportService.resolveImportText({ path: '/etc/passwd' }), /outside the workspace/);
  assert.throws(() => cookieImportService.resolveImportText({}), /provide cookies text/);
  const confined = path.join(tmp, 'cookies.txt');
  fs.writeFileSync(confined, text);
  assert.equal(cookieImportService.resolveImportText({ path: confined }), text);
  fs.writeFileSync(path.join(tmp, 'huge.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => cookieImportService.resolveImportText({ path: path.join(tmp, 'huge.txt') }), /too large/);

  // 9. vault → browser login (values never returned)
  const { vaultService } = require('../src/main/services/vaultService');
  const cred = vaultService.putGrokBotVaultCredential({
    title: 'Example', username: 'me@example.com', password: 'hunter2', sites: ['example.com'],
  });
  assert.equal(vaultService.credentialForOrigin('https://app.example.com/login').id, cred.id);
  assert.equal(vaultService.credentialForOrigin('https://evil.test/login'), null);
  assert.equal(vaultService.internalCredentialById(cred.id).secretName.startsWith('vault_cred_'), true);

  const { browserService } = require('../src/main/services/browserService');
  const { browserCredentialsService } = require('../src/main/services/browserCredentialsService');
  const injected = [];
  const originalAct = browserService.act;
  browserService.act = async (sessionId, method, args) => {
    injected.push({ sessionId, method, args });
    if (method === 'js' && args.code === 'location.href') return 'https://app.example.com/login';
    if (method === 'js') return JSON.stringify({ filledUser: true, filledPass: true, submitted: true, host: 'app.example.com' });
    throw new Error(`unexpected ${method}`);
  };
  try {
    const fill = await browserCredentialsService.fillCredentials('s1', { submit: true });
    assert.equal(fill.filled, true);
    assert.deepEqual(fill.fields, ['username', 'password']);
    assert.equal(fill.submitted, true);
    assert.equal(fill.credential.username, 'me@example.com');
    assert.ok(!JSON.stringify(fill).includes('hunter2'), 'password never leaves the main process');
    const script = injected.find((c) => c.method === 'js' && c.args.code !== 'location.href').args.code;
    assert.ok(script.includes('hunter2'));
    assert.ok(script.includes('me@example.com'));
    assert.ok(script.includes('requestSubmit'));

    // no matching credential → clear reason, nothing injected
    injected.length = 0;
    browserService.act = async (sid, method) => (method === 'js' ? 'https://unknown.test/login' : null);
    const none = await browserCredentialsService.fillCredentials('s1', {});
    assert.equal(none.filled, false);
    assert.match(none.reason, /no vault credential matches unknown\.test/);
    assert.equal(injected.length, 0, 'no fill script is injected without a credential');

    // explicit credentialId still works, and a page with no login fields is honest
    browserService.act = async (sid, method, args) => {
      if (method === 'js' && args.code === 'location.href') return 'https://anything.test/';
      return JSON.stringify({ filledUser: false, filledPass: false, submitted: false, host: 'anything.test' });
    };
    const noFields = await browserCredentialsService.fillCredentials('s1', { credentialId: cred.id });
    assert.equal(noFields.filled, false);
    assert.match(noFields.reason, /no login fields/);
  } finally {
    browserService.act = originalAct;
  }

  console.log('cookies test: ALL OK (derive/decrypt/profiles/read/denied/gating/apply/netscape/vault-fill)');
})().catch((e) => { console.error(e); process.exit(1); });
