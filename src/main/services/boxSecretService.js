'use strict';
/**
 * Box-secrets service — secrets provisioned to the agent's box/computer and
 * carried over to Grok-Bot-style bot secrets.
 *
 * Real behavior: values live in the encrypted secrets store (secretsService)
 * under `box_<name>`; an 0600 index tracks which names are provisioned.
 * `carry*` copies named secrets into `grokbot_<serverId>_<name>` records used
 * by bot/server integrations, without ever logging values.
 */
const fs = require('node:fs');
const path = require('node:path');
const { secretsService } = require('./secretsService');

function userDataDir() {
  return require('./userData').userDataDir();
}
function indexPath() { return path.join(userDataDir(), 'box-secrets.json'); }

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(indexPath(), 'utf8')); } catch { return { names: [] }; }
}
function saveIndex(index) {
  fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2), { mode: 0o600 });
}

/** Replace the box-secrets set: { secrets: { name: value } }. */
function setBoxSecrets({ secrets } = {}) {
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) throw new Error('secrets must be a { name: value } object');
  const index = loadIndex();
  const names = new Set(index.names);
  for (const [name, value] of Object.entries(secrets)) {
    secretsService.set(`box_${name}`, { value: String(value) }, `Box secret: ${name}`);
    names.add(name);
  }
  index.names = [...names].sort();
  index.updatedAt = Date.now();
  saveIndex(index);
  return { set: Object.keys(secrets).length, names: index.names };
}

function removeBoxSecret(name) {
  const index = loadIndex();
  index.names = index.names.filter((n) => n !== name);
  saveIndex(index);
  try { secretsService.remove(`box_${name}`); } catch {}
  return { removed: true, name };
}

function status() {
  const index = loadIndex();
  return { configured: index.names.length, names: index.names, updatedAt: index.updatedAt ?? null };
}

function carryToBot(serverId, names) {
  const server = String(serverId ?? '');
  if (!server) throw new Error('serverId is required');
  const index = loadIndex();
  const wanted = Array.isArray(names) && names.length ? names : index.names;
  const carried = [];
  const missing = [];
  for (const name of wanted) {
    const src = secretsService.get(`box_${name}`);
    if (!src) { missing.push(name); continue; }
    const target = `grokbot_${server.replace(/[^A-Za-z0-9_-]/g, '_')}_${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    secretsService.set(target, src.fields, `Carried from box secret: ${name}`);
    carried.push({ name, target });
  }
  return { serverId: server, carried: carried.map((c) => c.name), targets: carried.map((c) => c.target), missing };
}

function carryUserSecretsToBot(serverId, names) {
  const server = String(serverId ?? '');
  if (!server) throw new Error('serverId is required');
  const wanted = Array.isArray(names) ? names : [];
  if (!wanted.length) throw new Error('names is required');
  const carried = [];
  const missing = [];
  for (const name of wanted) {
    const src = secretsService.get(String(name));
    if (!src) { missing.push(name); continue; }
    const target = `grokbot_${server.replace(/[^A-Za-z0-9_-]/g, '_')}_${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    secretsService.set(target, src.fields, `Carried from user secret: ${name}`);
    carried.push({ name, target });
  }
  return { serverId: server, carried: carried.map((c) => c.name), targets: carried.map((c) => c.target), missing };
}

/** Bot secrets for one server, names stripped of the prefix. */
function listBotSecrets(serverId) {
  const prefix = `grokbot_${String(serverId ?? '').replace(/[^A-Za-z0-9_-]/g, '_')}_`;
  return secretsService.list()
    .filter((s) => s.name.startsWith(prefix))
    .map((s) => ({ name: s.name.slice(prefix.length), target: s.name, fields: s.fields, note: s.note, updatedAt: s.updatedAt }));
}

/** All grokbot secrets across servers (no serverId given). */
function listAllBotSecrets() {
  return secretsService.list()
    .filter((s) => s.name.startsWith('grokbot_'))
    .map((s) => {
      const rest = s.name.slice('grokbot_'.length);
      const split = rest.indexOf('_');
      return { serverId: split === -1 ? rest : rest.slice(0, split), name: split === -1 ? rest : rest.slice(split + 1), target: s.name, fields: s.fields, note: s.note, updatedAt: s.updatedAt };
    });
}

module.exports = { boxSecretService: { setBoxSecrets, removeBoxSecret, status, carryToBot, carryUserSecretsToBot, listBotSecrets, listAllBotSecrets } };
