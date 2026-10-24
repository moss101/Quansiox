'use strict';
/* Vault key handoff — the main process injects the AES key into the forked
 * coordinator via QUANSIOX_SECRETS_KEY; the legacy 0600 keyfile remains the
 * fallback, and a wrong/absent key must not silently rotate the vault. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-secrets-handoff-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { secretsService, _internal } = require('../src/main/services/secretsService');

// 1. first write creates the keyfile and encrypts
secretsService.set('demo', { token: 'shh-1' });
assert.strictEqual(fs.statSync(_internal.keyFile()).mode & 0o777, 0o600, 'keyfile is owner-only');
assert.strictEqual(secretsService.get('demo').fields.token, 'shh-1');

// 2. a child process with the injected key reads the same vault
const hex = secretsService.exportKeyHex();
assert.match(hex, /^[0-9a-f]{64}$/, 'key export is 32-byte hex');
const child = require('node:child_process').spawnSync(process.execPath, ['-e', `
  const { secretsService } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main', 'services', 'secretsService'))});
  process.stdout.write(JSON.stringify(secretsService.get('demo').fields));
`], { env: { ...process.env, QUANSIOX_SECRETS_KEY: hex }, encoding: 'utf8' });
assert.strictEqual(child.status, 0, child.stderr);
assert.deepStrictEqual(JSON.parse(child.stdout), { token: 'shh-1' }, 'injected key decrypts the vault');
assert.deepStrictEqual(secretsService.get('demo').fields, { token: 'shh-1' });

// 3. no safeStorage in a headless test: wrap reports unavailable, keyfile stays
const wrapped = secretsService.wrapKeyWithSafeStorage();
assert.strictEqual(wrapped.available, false, 'no OS keychain in this environment');
assert.ok(fs.existsSync(_internal.keyFile()), 'raw keyfile retained as child fallback');

// 4. injected key takes precedence over the on-disk key
process.env.QUANSIOX_SECRETS_KEY = Buffer.alloc(32, 7).toString('hex');
const wrong = _internal.loadKey();
assert.strictEqual(wrong.toString('hex'), Buffer.alloc(32, 7).toString('hex'), 'env key wins');
delete process.env.QUANSIOX_SECRETS_KEY;

// 5. parseKey accepts hex + base64 and rejects junk
assert.strictEqual(_internal.parseKey(Buffer.alloc(32, 1).toString('hex')).length, 32);
assert.strictEqual(_internal.parseKey(Buffer.alloc(32, 2).toString('base64')).length, 32);
assert.strictEqual(_internal.parseKey('nope'), null);
assert.strictEqual(_internal.parseKey(''), null);

console.log('secrets-key-handoff test: ALL OK (env handoff + keyfile fallback)');
