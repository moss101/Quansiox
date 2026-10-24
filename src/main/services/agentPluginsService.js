'use strict';
/**
 * Agent plugins — per-agent plugin MCP bindings (Grok getGrokBotAgentPlugins /
 * setGrokBotAgentPlugins / setGrokBotAgentPluginVariables).
 *
 * Bindings are real state (userData/agent-plugins.json) referencing installed
 * MCP servers or catalog plugins; `config-update` and `inline` carry validated
 * `mcpConfigJson` configs, and per-agent variable overrides merge over the
 * server's install values. Installed state is resolved live from settings.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_BINDINGS_PER_AGENT = 25;
const MAX_VARIABLES = 50;

function userDataDir() {
  return require('./userData').userDataDir();
}
function bindingsFile() { return path.join(userDataDir(), 'agent-plugins.json'); }

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
function settings() { return require('./settingsService').settingsService; }
function catalog() {
  try { return require('./marketplaceService').marketplaceService.CATALOG ?? []; } catch { return []; }
}
function installedServer(id) {
  return (settings().load().mcpServers ?? []).find((s) => s.name === id) ?? null;
}
function parseConfig(json, field) {
  if (json === undefined || json === null || json === '') return null;
  try {
    const parsed = JSON.parse(String(json));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (e) {
    throw new Error(`${field} must be a JSON object (${String(e?.message ?? e)})`);
  }
}
function publicBinding(b) {
  const server = b.pluginId ? installedServer(b.pluginId) : null;
  const defaults = server?.installValues ?? {};
  return {
    kind: b.kind,
    pluginId: b.pluginId ?? null,
    name: b.name,
    displayName: b.displayName ?? b.name,
    description: b.description ?? '',
    mcpConfigJson: b.mcpConfigJson ?? null,
    variables: { ...defaults, ...(b.variables ?? {}) },
    installed: b.kind === 'plugin' || b.kind === 'config-update' ? Boolean(server) : true,
    attachedAt: b.attachedAt,
  };
}

function getPlugins({ agentId } = {}) {
  const id = agentIdOf(agentId);
  return { agentId: id, plugins: (load().agents[id] ?? []).map(publicBinding) };
}

function setPlugins({ agentId, plugins } = {}) {
  const id = agentIdOf(agentId);
  const list = Array.isArray(plugins) ? plugins : [];
  if (list.length > MAX_BINDINGS_PER_AGENT) throw new Error(`too many plugins (max ${MAX_BINDINGS_PER_AGENT})`);
  const previous = load().agents[id] ?? [];
  const variablesById = new Map(previous.map((b) => [`${b.kind}:${b.pluginId ?? b.name}`, b.variables]));
  const next = [];
  for (const raw of list) {
    const kind = String(raw?.kind ?? '');
    if (kind === 'plugin' || kind === 'config-update') {
      const pluginId = String(raw.pluginId ?? '');
      if (!pluginId) throw new Error(`${kind} binding needs pluginId`);
      const known = installedServer(pluginId) || catalog().some((p) => p.id === pluginId && p.kind === 'mcp');
      if (!known) throw new Error(`unknown plugin: ${pluginId}`);
      const binding = {
        kind, pluginId, name: pluginId,
        mcpConfigJson: kind === 'config-update' ? JSON.stringify(parseConfig(raw.mcpConfigJson ?? '{}', 'mcpConfigJson')) : null,
        variables: variablesById.get(`${kind}:${pluginId}`) ?? {},
        attachedAt: Date.now(),
      };
      next.push(binding);
    } else if (kind === 'inline') {
      const name = String(raw?.name ?? '');
      if (!name) throw new Error('inline binding needs name');
      next.push({
        kind: 'inline', name,
        displayName: String(raw?.displayName ?? name).slice(0, 120),
        description: String(raw?.description ?? '').slice(0, 400),
        mcpConfigJson: JSON.stringify(parseConfig(raw.mcpConfigJson ?? '{}', 'mcpConfigJson')),
        variables: variablesById.get(`inline:${name}`) ?? {},
        attachedAt: Date.now(),
      });
    } else {
      throw new Error(`unknown plugin kind: ${kind || '(missing)'}`);
    }
  }
  const store = load();
  if (next.length) store.agents[id] = next;
  else delete store.agents[id];
  save(store);
  return getPlugins({ agentId: id });
}

function setPluginVariables({ agentId, pluginId, variables, mergeWithStored } = {}) {
  const id = agentIdOf(agentId);
  const pid = String(pluginId ?? '');
  if (!pid) throw new Error('pluginId is required');
  const clean = {};
  for (const [k, v] of Object.entries(variables ?? {})) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new Error(`variable ${k} must be string|number|boolean`);
    if (Object.keys(clean).length >= MAX_VARIABLES) throw new Error(`too many variables (max ${MAX_VARIABLES})`);
    clean[k.slice(0, 120)] = v;
  }
  const store = load();
  const bindings = store.agents[id] ?? [];
  const binding = bindings.find((b) => b.pluginId === pid || b.name === pid);
  if (!binding) throw new Error(`plugin not attached to this agent: ${pid}`);
  binding.variables = mergeWithStored === true ? { ...(binding.variables ?? {}), ...clean } : clean;
  save(store);
  return { agentId: id, plugin: publicBinding(binding) };
}

module.exports = { agentPluginsService: { getPlugins, setPlugins, setPluginVariables } };
