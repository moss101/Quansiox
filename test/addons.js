'use strict';
/* Local addon/extension system (GPA G13): validated manifests, Ed25519
 * signature trust, permission enforcement, skill/MCP contributions, and
 * enable/disable/uninstall cleanup. Electron-free. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-addons-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { addonService, canonical, normalizeManifest } = require('../src/main/services/addonService');
const { skillsService } = require('../src/main/services/skillsService');
const { settingsService } = require('../src/main/services/settingsService');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
addonService.trustPublisher('acme', publicPem);

const base = {
  id: 'release-pack',
  name: 'Release Pack',
  version: '1.0.0',
  description: 'Release helpers',
  author: 'Acme',
  publisher: 'acme',
  permissions: ['skills', 'mcp'],
  contributes: {
    skills: [{ id: 'notes', name: 'Release notes', description: 'Write notes', body: 'Summarize the release in 5 bullets.' }],
    mcpServers: [{ name: 'linear', command: 'node', args: ['server.js'], env: { TOKEN: '{{secret:linear.token}}' } }],
  },
};
const sign = (manifest) => crypto.sign(null, Buffer.from(canonical(manifest)), privateKey).toString('base64');

// ---- unsigned install + contributions ----
const unsigned = addonService.installFromManifest({ ...base, id: 'unsigned-pack' });
assert.equal(unsigned.trust, 'unsigned');
assert.equal(unsigned.enabled, true);
assert.deepEqual(addonService.list().map((a) => a.id), ['unsigned-pack']);
let skills = skillsService.list();
assert.ok(skills.some((s) => s.id === 'addon-unsigned-pack-notes' && s.enabled), 'skill contribution installed');
let servers = settingsService.load().mcpServers ?? [];
assert.ok(servers.some((s) => s.name === 'addon:unsigned-pack:linear'), 'MCP contribution registered');
assert.match(addonService.get('unsigned-pack').contributes.mcpServers[0].env.TOKEN, /…/, 'env values are redacted');

// disable removes the contributions, enable re-applies
addonService.disable('unsigned-pack');
assert.equal(addonService.get('unsigned-pack').enabled, false);
assert.ok(!skillsService.list().some((s) => s.id === 'addon-unsigned-pack-notes'), 'skill removed on disable');
assert.ok(!(settingsService.load().mcpServers ?? []).some((s) => s.name.endsWith(':linear')), 'MCP removed on disable');
addonService.enable('unsigned-pack');
assert.ok(skillsService.list().some((s) => s.id === 'addon-unsigned-pack-notes'), 'skill re-applied');

// ---- signed install ----
const manifest = normalizeManifest({ ...base });
const signed = addonService.installFromManifest({ ...base }, { signature: sign(manifest) });
assert.equal(signed.trust, 'verified');
assert.equal(addonService.verify('release-pack').ok, true, 'signature verifies');

// tampered manifest is rejected
assert.throws(() => addonService.installFromManifest({ ...base, name: 'Evil Pack' }, { signature: sign(manifest) }),
  /signature rejected/);

// unknown publisher key is rejected
const other = crypto.generateKeyPairSync('ed25519');
const otherSig = crypto.sign(null, Buffer.from(canonical(manifest)), other.privateKey).toString('base64');
assert.throws(() => addonService.installFromManifest({ ...base, publisher: 'unknown-co' }, { signature: otherSig }), /no trusted key/);

// ---- permission enforcement ----
assert.throws(() => normalizeManifest({ ...base, permissions: ['mcp'] }), /without the "skills" permission/);
assert.throws(() => normalizeManifest({ ...base, permissions: ['skills'] }), /without the "mcp" permission/);
assert.throws(() => normalizeManifest({ ...base, id: '../escape' }), /invalid addon id/);
assert.throws(() => normalizeManifest({ ...base, version: '1' }), /semver/);
assert.throws(() => normalizeManifest({ ...base, permissions: ['exec'] }), /unknown permission/);

// ---- install from a real bundle directory ----
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-addon-bundle-'));
const bundleManifest = normalizeManifest({ ...base, id: 'bundle-pack', version: '2.0.0' });
fs.writeFileSync(path.join(bundle, 'addon.json'), JSON.stringify(bundleManifest, null, 2));
fs.writeFileSync(path.join(bundle, 'addon.sig'), sign(bundleManifest));
fs.mkdirSync(path.join(bundle, 'assets'));
fs.writeFileSync(path.join(bundle, 'assets', 'readme.txt'), 'hello');
const fromDir = addonService.installFromDir(bundle);
assert.equal(fromDir.id, 'bundle-pack');
assert.equal(fromDir.trust, 'verified');
assert.ok(fs.existsSync(path.join(tmp, 'addons', 'bundle-pack', 'assets', 'readme.txt')), 'bundle files copied');

// ---- policy: require signature ----
addonService.setPolicy({ requireSignature: true });
assert.throws(() => addonService.installFromManifest({ ...base, id: 'plain-pack' }), /unsigned addons are disabled/);
addonService.setPolicy({ requireSignature: false });

// ---- uninstall removes bundle + contributions ----
addonService.uninstall('bundle-pack');
assert.ok(!fs.existsSync(path.join(tmp, 'addons', 'bundle-pack')), 'bundle removed');
assert.equal(addonService.get('bundle-pack'), null);
assert.ok(!skillsService.list().some((s) => s.id.startsWith('addon-bundle-pack-')), 'skills removed');
addonService.uninstall('unsigned-pack');
assert.equal(addonService.list().length, 1, 'signed addon remains');

// signature store is 0600 and trust list is queryable
assert.equal(fs.statSync(path.join(tmp, 'addons.json')).mode & 0o777, 0o600);
assert.deepEqual(addonService.trustedPublishers(), ['acme']);
assert.equal(addonService.verify('release-pack').ok, true);

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(bundle, { recursive: true, force: true });
console.log('addons test: ALL OK');
