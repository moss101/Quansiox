'use strict';
/**
 * Tool-permission service — the user's per-tool permission matrix.
 *
 * Grok Bot stores a per-scope policy of the shape
 * `{ tools: { <tool>: always_allow | needs_approval | blocked }, reads, writes }`
 * and ships `GetGrokBotMcpToolPermissions` / `SetGrokBotMcpToolPermissions` on
 * top of it. We keep the shape.
 *
 * Scopes:
 *   'global'        — every conversation in this install (the default)
 *   '<workspace>'   — one workspace root
 *   'session:<id>'  — one conversation
 *
 * The matrix is stored 0600 next to the other user state. A corrupt file
 * degrades to "no explicit overrides" rather than throwing, because a broken
 * settings file must never be able to brick the app.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR).
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  LEVELS, MODE_READ_ONLY, MODE_WORKSPACE, MODE_COMPUTER, MODES,
  defaultMatrixForMode, normalizeLevel, normalizeMatrix, normalizeMode,
} = require('../../shared/policy');

const VERSION = 1;
const MAX_SCOPES = 200;
const MAX_TOOLS_PER_SCOPE = 500;

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'tool-permissions.json'); }

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.scopes && typeof parsed.scopes === 'object') {
      return { version: VERSION, scopes: parsed.scopes };
    }
  } catch {}
  return { version: VERSION, scopes: {} };
}

function writeAll(store) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function checkScope(scope) {
  const s = String(scope ?? 'global').trim() || 'global';
  if (s.length > 200) throw new Error('permission scope is too long');
  return s;
}

/**
 * Read one scope's matrix. Returns the mode default when the scope has no
 * explicit overrides, so the caller always gets a usable matrix.
 */
function get({ scope = 'global', mode = MODE_WORKSPACE } = {}) {
  const s = checkScope(scope);
  const store = readAll();
  const stored = store.scopes[s];
  return {
    scope: s,
    mode: normalizeMode(stored?.mode ?? mode),
    matrix: normalizeMatrix(stored?.matrix, stored?.mode ?? mode),
    explicit: Boolean(stored),
  };
}

/**
 * Replace a scope's matrix.
 * @param {object} opts
 * @param {string} [opts.scope]
 * @param {string} [opts.mode]
 * @param {object} [opts.matrix] { tools: {}, reads, writes }
 */
function set({ scope = 'global', mode, matrix } = {}) {
  const s = checkScope(scope);
  const store = readAll();
  const normalizedMode = normalizeMode(mode ?? store.scopes[s]?.mode ?? MODE_WORKSPACE);
  const normalized = normalizeMatrix(matrix, normalizedMode);
  const toolCount = Object.keys(normalized.tools).length;
  if (toolCount > MAX_TOOLS_PER_SCOPE) throw new Error(`too many tool overrides (max ${MAX_TOOLS_PER_SCOPE})`);
  for (const [name, level] of Object.entries(normalized.tools)) {
    if (!LEVELS.includes(level)) throw new Error(`invalid level for ${name}: ${level}`);
  }
  if (!store.scopes[s] && Object.keys(store.scopes).length >= MAX_SCOPES) {
    throw new Error(`too many permission scopes (max ${MAX_SCOPES})`);
  }
  store.scopes[s] = { mode: normalizedMode, matrix: normalized, updatedAtMs: Date.now() };
  writeAll(store);
  return { scope: s, mode: normalizedMode, matrix: normalized };
}

/** Set a single tool's level without touching the rest of the matrix. */
function setTool({ scope = 'global', tool, level, mode } = {}) {
  const name = String(tool ?? '').trim();
  if (!name) throw new Error('tool name is required');
  if (!LEVELS.includes(level)) throw new Error(`invalid level: ${level}`);
  const current = get({ scope, mode });
  const matrix = {
    tools: { ...current.matrix.tools, [name]: level },
    reads: current.matrix.reads,
    writes: current.matrix.writes,
  };
  return set({ scope, mode: current.mode, matrix });
}

/** Change the permission mode for a scope. */
function setMode({ scope = 'global', mode } = {}) {
  if (!MODES.includes(mode)) throw new Error(`invalid permission mode: ${mode}`);
  const current = get({ scope });
  // Keep the explicit per-tool overrides; they still win over the mode.
  return set({ scope, mode, matrix: current.matrix });
}

/** Remove a scope's overrides entirely (back to the mode default). */
function clear({ scope = 'global' } = {}) {
  const s = checkScope(scope);
  const store = readAll();
  const existed = Boolean(store.scopes[s]);
  delete store.scopes[s];
  writeAll(store);
  return { scope: s, removed: existed };
}

function list() {
  const store = readAll();
  return {
    scopes: Object.entries(store.scopes).map(([scope, entry]) => ({
      scope,
      mode: normalizeMode(entry.mode),
      matrix: normalizeMatrix(entry.matrix, entry.mode),
      updatedAtMs: entry.updatedAtMs ?? null,
    })),
    defaults: {
      readOnly: defaultMatrixForMode(MODE_READ_ONLY),
      workspace: defaultMatrixForMode(MODE_WORKSPACE),
      computer: defaultMatrixForMode(MODE_COMPUTER),
    },
  };
}

module.exports = {
  toolPermissionsService: { get, set, setTool, setMode, clear, list },
};
