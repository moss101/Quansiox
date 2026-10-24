'use strict';
/**
 * Addon service — a local extension system (GPA G13).
 *
 * An addon is a directory with `addon.json` (manifest) and optional
 * `addon.sig` (base64 Ed25519 signature over the canonical manifest) plus
 * assets. Addons contribute **skills** and **MCP servers**; they never run
 * arbitrary code in-process.
 *
 * Security model:
 *  - manifests are validated and bounded;
 *  - a signature is verified against a publisher key the user explicitly
 *    trusts (`addons.trustPublisher`); a bad signature rejects the install;
 *  - contributions must be covered by the declared permissions;
 *  - enabling applies the contributions, disabling removes them;
 *  - with `requireSignature` on, unsigned addons cannot be enabled.
 *
 * Store: <userData>/addons/<id>/ (copied bundle) + <userData>/addons.json
 * (0600 registry). Electron-free so tests and the coordinator can read it.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PUBLISHER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const PERMISSIONS = new Set(['skills', 'mcp']);
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_SKILLS = 40;
const MAX_MCP = 20;

function userDataDir() {
  return require('./userData').userDataDir();
}
function registryFile() { return path.join(userDataDir(), 'addons.json'); }
function addonsDir() { return path.join(userDataDir(), 'addons'); }

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    if (parsed && Array.isArray(parsed.addons)) {
      return {
        addons: parsed.addons,
        trust: (parsed.trust && typeof parsed.trust === 'object') ? parsed.trust : {},
        requireSignature: parsed.requireSignature === true,
      };
    }
  } catch { /* first install */ }
  return { addons: [], trust: {}, requireSignature: false };
}
function save(state) {
  fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Deterministic JSON so signatures survive key-order changes. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function validateId(id) {
  if (!ID_RE.test(String(id ?? ''))) throw new Error('invalid addon id (use [a-z0-9][a-z0-9_-], max 64)');
  return String(id);
}
function cleanText(value, max) { return String(value ?? '').slice(0, max); }

/** Validate a manifest and return the normalized, storable shape. */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('addon manifest must be an object');
  const id = validateId(raw.id);
  const version = String(raw.version ?? '');
  if (!VERSION_RE.test(version)) throw new Error('addon version must be semver (x.y.z)');
  const publisher = raw.publisher ? String(raw.publisher) : '';
  if (publisher && !PUBLISHER_RE.test(publisher)) throw new Error('invalid publisher');
  const permissions = [...new Set((Array.isArray(raw.permissions) ? raw.permissions : []).map(String))];
  for (const permission of permissions) {
    if (!PERMISSIONS.has(permission)) throw new Error(`unknown permission: ${permission}`);
  }
  const contributes = raw.contributes && typeof raw.contributes === 'object' ? raw.contributes : {};
  const skills = (Array.isArray(contributes.skills) ? contributes.skills : []).slice(0, MAX_SKILLS).map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`skills[${i}] must be an object`);
    if (!permissions.includes('skills')) throw new Error('addon contributes skills without the "skills" permission');
    const skillId = String(s.id ?? s.name ?? `skill-${i}`).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    if (!/^[a-z0-9][a-z0-9_-]{0,55}$/.test(skillId)) throw new Error(`invalid skill id: ${s.id}`);
    const body = String(s.body ?? s.prompt ?? s.content ?? '');
    if (!body.trim()) throw new Error(`skill ${skillId} needs a body`);
    return { id: skillId, name: cleanText(s.name ?? skillId, 120), description: cleanText(s.description, 400), body: body.slice(0, 16_000) };
  });
  const mcpServers = (Array.isArray(contributes.mcpServers) ? contributes.mcpServers : []).slice(0, MAX_MCP).map((m, i) => {
    if (!m || typeof m !== 'object') throw new Error(`mcpServers[${i}] must be an object`);
    if (!permissions.includes('mcp')) throw new Error('addon contributes MCP servers without the "mcp" permission');
    const name = String(m.name ?? `server-${i}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`invalid MCP server name: ${name}`);
    if (!m.command) throw new Error(`MCP server ${name} needs a command`);
    return {
      name,
      command: String(m.command),
      args: Array.isArray(m.args) ? m.args.map(String).slice(0, 40) : [],
      env: (m.env && typeof m.env === 'object') ? Object.fromEntries(Object.entries(m.env).slice(0, 40).map(([k, v]) => [k, String(v)])) : {},
    };
  });
  if (!skills.length && !mcpServers.length) throw new Error('addon contributes nothing (skills or mcpServers required)');
  return {
    id,
    name: cleanText(raw.name ?? id, 120),
    version,
    description: cleanText(raw.description, 400),
    author: cleanText(raw.author, 120),
    publisher,
    permissions,
    contributes: { skills, mcpServers },
    minAppVersion: raw.minAppVersion ? String(raw.minAppVersion) : null,
  };
}

function verifySignature(manifest, signatureB64, publicKeyPem) {
  let key;
  try { key = crypto.createPublicKey(publicKeyPem); } catch { return { ok: false, reason: 'invalid public key' }; }
  const sig = Buffer.from(String(signatureB64), 'base64');
  if (!sig.length) return { ok: false, reason: 'empty signature' };
  try {
    const ok = crypto.verify(null, Buffer.from(canonical(manifest)), key, sig);
    return ok ? { ok: true } : { ok: false, reason: 'signature mismatch (manifest was modified)' };
  } catch (error) { return { ok: false, reason: `signature error: ${error.message}` }; }
}

function dirStats(dir) {
  let bytes = 0; let files = 0;
  const walk = (current, depth = 0) => {
    if (depth > 8) throw new Error('bundle is nested too deeply');
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const p = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('addon bundles cannot contain symlinks');
      if (entry.isDirectory()) walk(p, depth + 1);
      else {
        files += 1;
        bytes += fs.statSync(p).size;
        if (files > MAX_FILES) throw new Error(`addon bundle has too many files (>${MAX_FILES})`);
        if (bytes > MAX_BUNDLE_BYTES) throw new Error(`addon bundle too large (>${MAX_BUNDLE_BYTES} bytes)`);
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * Install a bundle from a directory. Copies the bundle under userData/addons.
 * opts.allowUnsigned defaults true; a bad signature always rejects.
 */
function installFromDir(sourceDir, { allowUnsigned = true, enable = true } = {}) {
  const source = path.resolve(String(sourceDir));
  const manifestPath = path.join(source, 'addon.json');
  if (!fs.existsSync(manifestPath)) throw new Error('addon.json not found in bundle');
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifest = normalizeManifest(raw);
  dirStats(source);
  const sigPath = path.join(source, 'addon.sig');
  const signature = fs.existsSync(sigPath) ? fs.readFileSync(sigPath, 'utf8').trim() : null;
  const state = load();
  let trust = 'unsigned';
  if (signature) {
    const pem = manifest.publisher ? state.trust[manifest.publisher] : null;
    if (!pem) throw new Error(`no trusted key for publisher "${manifest.publisher || '(none)'}" — add it in Addons first`);
    const verdict = verifySignature(manifest, signature, pem);
    if (!verdict.ok) throw new Error(`addon signature rejected: ${verdict.reason}`);
    trust = 'verified';
  } else if (!allowUnsigned) {
    throw new Error('addon is unsigned and unsigned addons are not allowed');
  }
  const existingIndex = state.addons.findIndex((a) => a.id === manifest.id);
  if (existingIndex !== -1) disable(manifest.id);
  const target = path.join(addonsDir(), manifest.id);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(addonsDir(), { recursive: true });
  fs.cpSync(source, target, { recursive: true, dereference: false });
  const record = {
    ...manifest,
    trust,
    signature: signature ? 'present' : null,
    signedPayload: signature ? canonical(manifest) : null,
    enabled: false,
    installedAt: Date.now(),
    updatedAt: Date.now(),
    applied: { skills: [], mcpServers: [] },
    path: target,
  };
  if (existingIndex !== -1) state.addons.splice(existingIndex, 1);
  state.addons.push(record);
  save(state);
  if (enable) enableAddon(manifest.id);
  return get(manifest.id);
}

/** Inline manifest install (tests / manifest import) — no bundle assets. */
function installFromManifest(raw, { signature = null, enable = true } = {}) {
  const manifest = normalizeManifest(raw);
  const state = load();
  let trust = 'unsigned';
  if (signature) {
    const pem = manifest.publisher ? state.trust[manifest.publisher] : null;
    if (!pem) throw new Error(`no trusted key for publisher "${manifest.publisher || '(none)'}"`);
    const verdict = verifySignature(manifest, signature, pem);
    if (!verdict.ok) throw new Error(`addon signature rejected: ${verdict.reason}`);
    trust = 'verified';
  }
  if (state.requireSignature && trust !== 'verified') throw new Error('unsigned addons are disabled by policy');
  const target = path.join(addonsDir(), manifest.id);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'addon.json'), JSON.stringify(raw, null, 2), { mode: 0o600 });
  if (signature) fs.writeFileSync(path.join(target, 'addon.sig'), signature, { mode: 0o600 });
  const idx = state.addons.findIndex((a) => a.id === manifest.id);
  if (idx !== -1) state.addons.splice(idx, 1);
  const record = {
    ...manifest, trust, signature: signature ? 'present' : null,
    signedPayload: signature ? canonical(manifest) : null, enabled: false,
    installedAt: Date.now(), updatedAt: Date.now(), applied: { skills: [], mcpServers: [] }, path: target,
  };
  state.addons.push(record);
  save(state);
  if (enable) enableAddon(manifest.id);
  return get(manifest.id);
}

function list() {
  return load().addons.map((a) => ({
    id: a.id, name: a.name, version: a.version, description: a.description, author: a.author,
    publisher: a.publisher, trust: a.trust, enabled: a.enabled === true,
    permissions: a.permissions, skills: a.contributes?.skills?.length ?? 0,
    mcpServers: a.contributes?.mcpServers?.length ?? 0,
    installedAt: a.installedAt, updatedAt: a.updatedAt,
  })).sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
}

function get(id) {
  const record = load().addons.find((a) => a.id === id);
  if (!record) return null;
  return {
    ...record,
    contributes: {
      skills: (record.contributes?.skills ?? []).map((s) => ({ ...s, body: undefined })),
      mcpServers: (record.contributes?.mcpServers ?? []).map((m) => ({ ...m, env: Object.fromEntries(Object.keys(m.env ?? {}).map((k) => [k, '…'])) })),
    },
  };
}

function applyContributions(record) {
  const applied = { skills: [], mcpServers: [] };
  const { skillsService } = require('./skillsService');
  for (const skill of record.contributes?.skills ?? []) {
    const id = `addon-${record.id}-${skill.id}`.slice(0, 64);
    skillsService.install({
      id, name: `${record.name}: ${skill.name}`, description: skill.description,
      body: skill.body, version: record.version, enabled: true,
    });
    applied.skills.push(id);
  }
  if ((record.contributes?.mcpServers ?? []).length) {
    const { settingsService } = require('./settingsService');
    const current = settingsService.load();
    const servers = Array.isArray(current.mcpServers) ? current.mcpServers.filter((s) => !String(s.name ?? '').startsWith(`addon:${record.id}:`)) : [];
    for (const server of record.contributes.mcpServers) {
      const name = `addon:${record.id}:${server.name}`.slice(0, 80);
      servers.push({ name, command: server.command, args: server.args, env: server.env });
      applied.mcpServers.push(name);
    }
    settingsService.save({ mcpServers: servers });
    if (process.versions.electron) { try { require('./mcpService').mcpService.reloadAll(); } catch { /* reload is best-effort */ } }
  }
  return applied;
}

function removeContributions(record) {
  const { skillsService } = require('./skillsService');
  for (const id of record.applied?.skills ?? []) {
    try { skillsService.uninstall(id); } catch { /* already gone */ }
  }
  for (const name of record.applied?.mcpServers ?? []) {
    try {
      const { settingsService } = require('./settingsService');
      const current = settingsService.load();
      settingsService.save({ mcpServers: (current.mcpServers ?? []).filter((s) => s.name !== name) });
    } catch { /* settings unavailable */ }
  }
  if (process.versions.electron) { try { require('./mcpService').mcpService.reloadAll(); } catch { /* best-effort */ } }
  return { skills: record.applied?.skills?.length ?? 0, mcpServers: record.applied?.mcpServers?.length ?? 0 };
}

function enableAddon(id) {
  const state = load();
  const record = state.addons.find((a) => a.id === id);
  if (!record) throw new Error('unknown addon');
  if (record.enabled) return get(id);
  if (state.requireSignature && record.trust !== 'verified') {
    throw new Error('addon is not signed by a trusted publisher — enable require-signature policy off or install a signed addon');
  }
  record.applied = applyContributions(record);
  record.enabled = true;
  record.updatedAt = Date.now();
  save(state);
  return get(id);
}

function disable(id) {
  const state = load();
  const record = state.addons.find((a) => a.id === id);
  if (!record) throw new Error('unknown addon');
  if (!record.enabled) return get(id);
  removeContributions(record);
  record.enabled = false;
  record.applied = { skills: [], mcpServers: [] };
  record.updatedAt = Date.now();
  save(state);
  return get(id);
}

function uninstall(id) {
  const state = load();
  const index = state.addons.findIndex((a) => a.id === id);
  if (index === -1) throw new Error('unknown addon');
  const record = state.addons[index];
  if (record.enabled) removeContributions(record);
  state.addons.splice(index, 1);
  save(state);
  fs.rmSync(path.join(addonsDir(), id), { recursive: true, force: true });
  return true;
}

/** Re-verify an installed addon against the stored manifest + trusted key. */
function verify(id) {
  const state = load();
  const record = state.addons.find((a) => a.id === id);
  if (!record) throw new Error('unknown addon');
  if (record.trust === 'unsigned') return { id, trust: 'unsigned', ok: false, reason: 'no signature' };
  const pem = state.trust[record.publisher];
  if (!pem) return { id, trust: record.trust, ok: false, reason: 'publisher key no longer trusted' };
  const sigPath = path.join(addonsDir(), id, 'addon.sig');
  if (!fs.existsSync(sigPath)) return { id, trust: record.trust, ok: false, reason: 'signature file missing' };
  if (!record.signedPayload) return { id, trust: record.trust, ok: false, reason: 'signed manifest payload missing' };
  const verdict = verifySignature(JSON.parse(record.signedPayload), fs.readFileSync(sigPath, 'utf8').trim(), pem);
  return { id, trust: record.trust, ok: verdict.ok, reason: verdict.ok ? null : verdict.reason };
}

/** Trust a publisher's Ed25519 public key (main-window only in the app). */
function trustPublisher(publisher, publicKeyPem) {
  if (!PUBLISHER_RE.test(String(publisher ?? ''))) throw new Error('invalid publisher');
  const pem = String(publicKeyPem ?? '');
  let key;
  try { key = crypto.createPublicKey(pem); } catch { throw new Error('invalid public key PEM'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('publisher key must be Ed25519');
  const state = load();
  state.trust[publisher] = pem;
  save(state);
  return { publisher, trusted: true };
}
function trustedPublishers() {
  return Object.keys(load().trust);
}
function setPolicy({ requireSignature } = {}) {
  const state = load();
  state.requireSignature = requireSignature === true;
  save(state);
  return { requireSignature: state.requireSignature };
}
function policy() {
  const state = load();
  return { requireSignature: state.requireSignature, trustedPublishers: Object.keys(state.trust) };
}

module.exports = {
  addonService: {
    installFromDir, installFromManifest, list, get, enable: enableAddon, disable, uninstall,
    verify, trustPublisher, trustedPublishers, setPolicy, policy,
  },
  canonical, normalizeManifest, verifySignature,
};
