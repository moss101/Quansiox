'use strict';
/* Secrets vault test — Grok Bot submitSecret / {{secret:name.field}} model.
 * Covers: at-rest encryption roundtrip, reference resolution (single-field and
 * name.field), merge, unknown-ref passthrough, redaction (list never leaks
 * values), name validation, deep arg resolution, and end-to-end resolution at
 * the execService boundary. Electron-free: uses QUANSIOX_USER_DATA_DIR. */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-secrets-test-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { secretsService } = require('../src/main/services/secretsService');
const { execService } = require('../src/main/services/execService');

// 1. strictly-empty store
assert.deepStrictEqual(secretsService.list(), []);

// 2. set a single-field secret + a multi-field secret
let rec = secretsService.set('github_token', { value: 'ghp_SECRET123' }, 'CI token');
assert.strictEqual(rec.name, 'github_token');
assert.deepStrictEqual(rec.fields, ['value']); // field NAMES only
secretsService.set('db', { user: 'admin', pass: 'p@ssw0rd' });

// 3. at-rest encryption: the vault file exists and does NOT contain plaintext
const vaultRaw = fs.readFileSync(path.join(tmp, 'secrets.vault'), 'utf8');
assert.ok(!vaultRaw.includes('ghp_SECRET123'), 'plaintext value must not be on disk');
assert.ok(!vaultRaw.includes('p@ssw0rd'), 'plaintext value must not be on disk');
assert.strictEqual(fs.statSync(path.join(tmp, '.secrets.key')).mode & 0o777, 0o600, 'key file must be 0600');

// 4. decrypt roundtrip (get returns values internally; list never does)
assert.strictEqual(secretsService.get('github_token').fields.value, 'ghp_SECRET123');
const listed = secretsService.list().map((s) => s.name);
assert.deepStrictEqual(listed.sort(), ['db', 'github_token']);
assert.ok(!JSON.stringify(secretsService.list()).includes('ghp_SECRET123'), 'list() must never leak values');

// 5. reference resolution
assert.strictEqual(secretsService.resolve('Authorization: {{secret:github_token}}'), 'Authorization: ghp_SECRET123');
assert.strictEqual(secretsService.resolve('user={{secret:db.user}} pass={{secret:db.pass}}'), 'user=admin pass=p@ssw0rd');
// unknown refs pass through untouched
assert.strictEqual(secretsService.resolve('{{secret:nope}}'), '{{secret:nope}}');
assert.strictEqual(secretsService.resolve('{{secret:db.missing}}'), '[secret db has no field missing]');
// no refs → unchanged fast path
assert.strictEqual(secretsService.resolve('plain text'), 'plain text');

// 6. merge keeps existing fields, updates provided ones
secretsService.set('db', { pass: 'NEWpass' });
assert.strictEqual(secretsService.get('db').fields.user, 'admin');
assert.strictEqual(secretsService.get('db').fields.pass, 'NEWpass');

// 7. validation
assert.throws(() => secretsService.set('-bad', { value: 'x' }), /invalid secret name/);
assert.throws(() => secretsService.set('ok', { 'bad name!': 'x' }), /invalid field name/);
assert.throws(() => secretsService.set('ok', { empty: '' }), /empty value/);

// 8. deep arg resolution
const resolved = secretsService.resolveArgs({ command: 'echo {{secret:github_token}}', nested: { cmd: 'curl -H "{{secret:db.pass}}"' }, arr: ['{{secret:db.user}}'], n: 5 });
assert.strictEqual(resolved.command, 'echo ghp_SECRET123');
assert.strictEqual(resolved.nested.cmd, 'curl -H "p@ssw0rd"'.replace('p@ssw0rd', 'NEWpass'));
assert.deepStrictEqual(resolved.arr, ['admin']);
assert.strictEqual(resolved.n, 5);

// 9. remove
secretsService.remove('github_token');
assert.deepStrictEqual(secretsService.list().map((s) => s.name), ['db']);

// 10. end-to-end: execService.run resolves before bash sees the command
secretsService.set('probe', { value: 'RESOLVED_OK_42' });
(async () => {
  const out = await execService.run('echo "{{secret:probe}}"', tmp);
  assert.ok(/\[exit 0\]/.test(out), 'command should exit 0');
  assert.ok(out.includes('RESOLVED_OK_42'), 'exec output must contain the resolved value');
  assert.ok(!out.includes('{{secret:'), 'no unresolved reference may reach the shell');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('secrets test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
