'use strict';
/**
 * Agent identity — named agents that outlive a conversation.
 *
 * A session is a conversation. An *agent* is the thing that has a name, an
 * avatar, a voice, a permission mode and a memory, and which can be handed
 * work over many conversations. The reference implementation models exactly
 * this: `CreateAgent`, `UpdateAgent`, `SetPrimaryBot`, `PublishToTeam`,
 * `ConvertToTeam`, `OfferTeamAccess` — agents are first-class objects with
 * their own roster, not just chat threads.
 *
 * This is the local-first counterpart: agents live in this install, are
 * listed in one roster, and are the unit that teams are made of. There is no
 * cloud and no account, so "publish" means "share inside this workspace".
 *
 * Stored 0600 next to the other user state. Electron-free.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const MAX_AGENTS = 200;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 400;

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'agents.json'); }

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.agents)) {
      return { version: VERSION, agents: parsed.agents };
    }
  } catch {}
  return { version: VERSION, agents: [] };
}

function writeAll(store) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function newId() {
  return `agt-${crypto.randomUUID().slice(0, 8)}`;
}

/** The shape of an agent. */
function normalize(input = {}, existing = null) {
  const now = Date.now();
  return {
    id: String(input.id ?? existing?.id ?? newId()),
    name: String(input.name ?? existing?.name ?? 'Agent').slice(0, NAME_MAX),
    description: String(input.description ?? existing?.description ?? '').slice(0, DESCRIPTION_MAX),
    title: String(input.title ?? existing?.title ?? '').slice(0, NAME_MAX),
    avatarShape: String(input.avatarShape ?? existing?.avatarShape ?? 'circle'),
    avatarColor: String(input.avatarColor ?? existing?.avatarColor ?? '#7c9cff'),
    avatarPngBase64: input.avatarPngBase64 ?? existing?.avatarPngBase64 ?? null,
    voiceId: String(input.voiceId ?? existing?.voiceId ?? ''),
    voiceSpeed: Number(input.voiceSpeed ?? existing?.voiceSpeed ?? 1),
    voiceLanguage: String(input.voiceLanguage ?? existing?.voiceLanguage ?? ''),
    // The permission mode this agent runs in. An agent may be stricter than
    // the install default.
    permissionMode: String(input.permissionMode ?? existing?.permissionMode ?? 'workspace'),
    // A team agent is shared with the workspace; a personal one is not.
    scope: input.scope === 'team' ? 'team' : (existing?.scope ?? 'personal'),
    published: Boolean(input.published ?? existing?.published ?? false),
    primary: Boolean(input.primary ?? existing?.primary ?? false),
    hidden: Boolean(input.hidden ?? existing?.hidden ?? false),
    pinned: Boolean(input.pinned ?? existing?.pinned ?? false),
    // The conversations that belong to this agent.
    sessionIds: Array.isArray(input.sessionIds) ? input.sessionIds.map(String) : (existing?.sessionIds ?? []),
    // Durable facts about this agent.
    memories: Array.isArray(input.memories) ? input.memories : (existing?.memories ?? []),
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  };
}

/** Create an agent. */
function create(input = {}) {
  const store = readAll();
  if (store.agents.length >= MAX_AGENTS) throw new Error(`too many agents (max ${MAX_AGENTS})`);
  const agent = normalize(input);
  if (store.agents.some((a) => a.id === agent.id)) throw new Error('an agent with that id already exists');
  store.agents.push(agent);
  writeAll(store);
  return agent;
}

/** Update an agent. Only the fields present are changed. */
function update(id, patch = {}) {
  const store = readAll();
  const index = store.agents.findIndex((a) => a.id === String(id));
  if (index < 0) throw new Error(`unknown agent: ${id}`);
  const merged = normalize(patch, store.agents[index]);
  store.agents[index] = merged;
  writeAll(store);
  return merged;
}

function get(id) {
  return readAll().agents.find((a) => a.id === String(id)) ?? null;
}

/** Every agent, primary first, then by name. */
function list() {
  const agents = [...readAll().agents];
  return agents.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function remove(id) {
  const store = readAll();
  const before = store.agents.length;
  store.agents = store.agents.filter((a) => a.id !== String(id));
  writeAll(store);
  return { id: String(id), removed: store.agents.length !== before };
}

/** Set the primary agent (exactly one at a time). */
function setPrimary(id) {
  const store = readAll();
  const target = String(id);
  if (!store.agents.some((a) => a.id === target)) throw new Error(`unknown agent: ${id}`);
  for (const agent of store.agents) agent.primary = agent.id === target;
  writeAll(store);
  return get(target);
}

/** The primary agent, or null. */
function primary() {
  return readAll().agents.find((a) => a.primary) ?? null;
}

/**
 * Convert a personal agent into a team agent (the local-first counterpart of
 * the reference's `ConvertToTeam`): it becomes visible to the whole
 * workspace and can be published.
 */
function convertToTeam(id) {
  return update(id, { scope: 'team' });
}

/**
 * Publish an agent to the workspace (the local counterpart of
 * `PublishToTeam`): it shows up in the shared agent library.
 */
function publish(id) {
  return update(id, { scope: 'team', published: true });
}

function unpublish(id) {
  return update(id, { published: false });
}

/**
 * Offer a team agent to the workspace (the local counterpart of
 * `OfferTeamAccess`). There is no access backend here, so the offer is
 * recorded on the agent: the local workspace IS the team.
 */
function offerAccess(id, { note = '' } = {}) {
  const agent = get(id);
  if (!agent) throw new Error(`unknown agent: ${id}`);
  return update(id, { scope: 'team', accessNote: String(note).slice(0, 400) });
}

/** Attach a conversation to an agent. */
function attachSession(agentId, sessionId) {
  const agent = get(agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  const sessionIds = new Set(agent.sessionIds);
  sessionIds.add(String(sessionId));
  return update(agentId, { sessionIds: [...sessionIds] });
}

/** The agent a conversation belongs to (the first one that claims it). */
function agentForSession(sessionId) {
  const sid = String(sessionId ?? '');
  return readAll().agents.find((a) => a.sessionIds.includes(sid)) ?? null;
}

/**
 * Clone an agent — the local counterpart of the reference's agent
 * duplication: a new agent with the same identity but no conversations.
 */
function clone(id, { name } = {}) {
  const agent = get(id);
  if (!agent) throw new Error(`unknown agent: ${id}`);
  const copy = create({
    ...agent,
    id: undefined,
    name: name ? String(name).slice(0, NAME_MAX) : `${agent.name} copy`,
    sessionIds: [],
    memories: [],
    primary: false,
    published: false,
  });
  return copy;
}

/** Add a durable fact to an agent's memory. */
function remember(agentId, text) {
  const agent = get(agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  const fact = String(text ?? '').trim().slice(0, 1000);
  if (!fact) throw new Error('a memory needs some text');
  const memories = [...agent.memories, { id: crypto.randomUUID(), text: fact, at: Date.now() }];
  return update(agentId, { memories });
}

/** Forget a memory by id. */
function forget(agentId, memoryId) {
  const agent = get(agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  return update(agentId, { memories: agent.memories.filter((m) => m.id !== String(memoryId)) });
}

module.exports = {
  agentIdentityService: {
    attachSession, agentForSession, clone, convertToTeam, create, forget, get, list,
    offerAccess, primary, publish, remember, remove, setPrimary, unpublish, update,
  },
};
