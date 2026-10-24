'use strict';
/**
 * Agent skills — per-agent skill attachments (Grok addGrokBotAgentSkill /
 * updateGrokBotAgentSkill / removeGrokBotAgentSkill).
 *
 * A skill is installed into the local skills catalog (skillsService) and bound
 * to the agent; optional skill files land in the agent's file store
 * (agentFilesService) so the model can read them mid-run. Bindings are real
 * state under userData/agent-skills.json; uninstalling removes the catalog
 * entry only when no other agent still binds it.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_BINDINGS_PER_AGENT = 50;

function userDataDir() {
  return require('./userData').userDataDir();
}
function bindingsFile() { return path.join(userDataDir(), 'agent-skills.json'); }

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(bindingsFile(), 'utf8'));
    return { agents: parsed?.agents && typeof parsed.agents === 'object' ? parsed.agents : {} };
  } catch { return { agents: {} }; }
}
function save(store) {
  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.writeFileSync(bindingsFile(), JSON.stringify(store, null, 2), { mode: 0o600 });
}
function agentIdOf(agentId) {
  const id = String(agentId ?? '');
  if (!id) throw new Error('agentId is required');
  return id;
}
function slugify(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function skills() { return require('./skillsService').skillsService; }
function agentFiles() { return require('./agentFilesService').agentFilesService; }

function uploadSkillFiles(agentId, files) {
  const stored = [];
  if (!Array.isArray(files)) return stored;
  for (const f of files.slice(0, 25)) {
    const name = path.basename(String(f?.path ?? '')).trim();
    if (!name) continue;
    const content = String(f?.content ?? '');
    const result = agentFiles().uploadGrokBotAgentFile({
      agentId,
      fileName: name,
      contentType: name.endsWith('.md') ? 'text/markdown' : 'text/plain',
      bytes: Buffer.from(content, 'utf8'),
    });
    stored.push(result.name);
  }
  return stored;
}

function list(agentId) {
  const id = agentIdOf(agentId);
  const store = load();
  const bindings = store.agents[id] ?? [];
  return bindings.map((b) => {
    const skill = skills().get(b.skillId);
    return {
      skillId: b.skillId,
      name: skill?.name ?? b.name,
      description: skill?.description ?? '',
      enabled: skill ? skill.enabled !== false : false,
      inCatalog: Boolean(skill),
      files: b.files ?? [],
      attachedAt: b.attachedAt,
    };
  });
}

function add({ agentId, name, description, content, files } = {}) {
  const id = agentIdOf(agentId);
  const body = String(content ?? '');
  if (!body.trim()) throw new Error('skill content is required');
  const skillId = slugify(name) || `skill-${Date.now().toString(36)}`;
  const installed = skills().install({ id: skillId, name: name ?? skillId, description: description ?? '', body });
  const store = load();
  const bindings = store.agents[id] ?? [];
  if (bindings.length >= MAX_BINDINGS_PER_AGENT) throw new Error('too many skills for this agent');
  const storedFiles = uploadSkillFiles(id, files);
  const record = { skillId: installed.id, name: installed.name, files: storedFiles, attachedAt: Date.now() };
  store.agents[id] = [...bindings.filter((b) => b.skillId !== installed.id), record];
  save(store);
  return { agentId: id, skillId: installed.id, name: installed.name, description: installed.description, files: storedFiles };
}

function update({ agentId, name, description, content, files } = {}) {
  const id = agentIdOf(agentId);
  const wanted = slugify(name);
  if (!wanted) throw new Error('skill name is required');
  const store = load();
  const bindings = store.agents[id] ?? [];
  const binding = bindings.find((b) => b.skillId === wanted || slugify(b.name) === wanted);
  if (!binding) throw new Error(`no such agent skill: ${name}`);
  const body = String(content ?? '');
  if (!body.trim()) throw new Error('skill content is required');
  const installed = skills().install({ id: binding.skillId, name: name ?? binding.name, description: description ?? '', body });
  const storedFiles = uploadSkillFiles(id, files);
  if (storedFiles.length) binding.files = [...new Set([...(binding.files ?? []), ...storedFiles])];
  binding.name = installed.name;
  save(store);
  return { agentId: id, skillId: installed.id, name: installed.name, description: installed.description, files: binding.files ?? [] };
}

function remove({ agentId, name } = {}) {
  const id = agentIdOf(agentId);
  const wanted = slugify(name);
  const store = load();
  const bindings = store.agents[id] ?? [];
  const binding = bindings.find((b) => b.skillId === wanted || slugify(b.name) === wanted);
  if (!binding) return { removed: false, agentId: id, name: name ?? null };
  store.agents[id] = bindings.filter((b) => b !== binding);
  if (!store.agents[id].length) delete store.agents[id];
  save(store);
  const stillBound = Object.values(load().agents).some((list) => list.some((b) => b.skillId === binding.skillId));
  if (!stillBound) { try { skills().uninstall(binding.skillId); } catch {} }
  return { removed: true, agentId: id, skillId: binding.skillId, name: binding.name, catalogRemoved: !stillBound };
}

module.exports = { agentSkillsService: { list, add, update, remove } };
