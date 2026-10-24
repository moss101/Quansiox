'use strict';
/**
 * Local AI-tool ecosystem discovery.
 *
 * A developer who already has Claude Code, Codex, Cursor or OpenCode
 * configured has MCP servers, skills, slash commands and rules sitting on
 * disk. Grok Bot discovers them automatically (`discoverAiTool` in its
 * local-exec daemon) and lets the user import them.
 *
 * Quansiox does the same, locally:
 *
 *   ~/.claude.json            MCP servers (global + per project)
 *   ~/.claude/settings.json   MCP servers, permissions
 *   ~/.claude/skills/         SKILL.md per skill
 *   ~/.claude/commands/       slash commands (markdown)
 *   ~/.claude/plugins/        installed plugins
 *   ~/.codex/config.toml      [mcp_servers.NAME] sections
 *   ~/.codex/skills/          SKILL.md per skill
 *   ~/.codex/prompts/         prompt templates (markdown)
 *   ~/.codex/history.jsonl    recent session titles
 *   ~/.cursor/mcp.json        MCP servers
 *   ~/.cursor/rules/          rules (.mdc)
 *
 * Nothing is imported automatically: the user picks what to bring over.
 * Secrets are never read — only the server definitions.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR for the import side).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_ITEMS = 60;
const MAX_FILE_BYTES = 512 * 1024;

/** The ecosystems we know how to read. */
const SOURCES = [
  { id: 'claude_code', label: 'Claude Code', roots: ['.claude', '.claude.json'] },
  { id: 'codex', label: 'Codex', roots: ['.codex'] },
  { id: 'cursor', label: 'Cursor', roots: ['.cursor'] },
  { id: 'opencode', label: 'OpenCode', roots: ['.config/opencode', '.opencode'] },
];

function home() { return os.homedir(); }

function readJson(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file, limit = 64 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8').slice(0, limit);
  } catch {
    return null;
  }
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * Parse the subset of TOML we need: `[section.sub]` headers and
 * `key = "value"` / `key = ["a", "b"]` entries.
 *
 * Codex's `config.toml` uses exactly this shape for `[mcp_servers.NAME]`.
 */
function parseToml(text) {
  const out = {};
  let section = '';
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      out[section] = out[section] ?? {};
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let raw = kv[2].trim();
    // strip a trailing comment outside quotes
    if (!raw.startsWith('"') && !raw.startsWith('[')) raw = raw.split('#')[0].trim();
    let value;
    if (raw.startsWith('[')) {
      const items = [];
      for (const m of raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)) items.push(m[1].replace(/\\"/g, '"'));
      value = items;
    } else if (raw.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
      value = m ? m[1].replace(/\\"/g, '"') : raw;
    } else if (raw === 'true' || raw === 'false') {
      value = raw === 'true';
    } else {
      const n = Number(raw);
      value = Number.isFinite(n) ? n : raw;
    }
    if (section) {
      out[section] = out[section] ?? {};
      out[section][key] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/* ---------------- per-ecosystem discovery ---------------- */

function discoverClaudeCode() {
  const items = [];
  const roots = [];

  // ~/.claude.json — global + per-project MCP servers
  const claudeJson = readJson(path.join(home(), '.claude.json'));
  if (claudeJson) {
    roots.push('.claude.json');
    for (const [name, def] of Object.entries(claudeJson.mcpServers ?? {})) {
      items.push(mcpItem(name, def, 'claude_code'));
    }
    for (const [project, def] of Object.entries(claudeJson.projects ?? {})) {
      for (const [name, server] of Object.entries(def?.mcpServers ?? {})) {
        items.push(mcpItem(name, server, 'claude_code', project));
      }
    }
  }

  // ~/.claude/settings.json
  const settings = readJson(path.join(home(), '.claude', 'settings.json'));
  if (settings) {
    roots.push('.claude/settings.json');
    for (const [name, def] of Object.entries(settings.mcpServers ?? {})) {
      items.push(mcpItem(name, def, 'claude_code'));
    }
  }

  // ~/.claude/skills/*/SKILL.md
  const skillDir = path.join(home(), '.claude', 'skills');
  for (const entry of listDir(skillDir)) {
    if (!entry.isDirectory()) continue;
    const body = readText(path.join(skillDir, entry.name, 'SKILL.md'));
    if (!body) continue;
    items.push(skillItem(entry.name, body, 'claude_code'));
  }

  // ~/.claude/commands/*.md — slash commands
  const commandDir = path.join(home(), '.claude', 'commands');
  for (const entry of listDir(commandDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const body = readText(path.join(commandDir, entry.name));
    if (!body) continue;
    items.push(promptItem(entry.name.replace(/\.md$/, ''), body, 'claude_code'));
  }

  // ~/.claude/plugins/installed_plugins.json
  const plugins = readJson(path.join(home(), '.claude', 'plugins', 'installed_plugins.json'));
  if (plugins) {
    roots.push('.claude/plugins');
    for (const [name, def] of Object.entries(plugins.plugins ?? plugins ?? {})) {
      items.push({
        kind: 'plugin',
        title: String(name),
        excerpt: typeof def === 'string' ? def : (def?.version ? `v${def.version}` : ''),
        source: 'claude_code',
        importable: false,
      });
    }
  }

  return { items, roots };
}

function discoverCodex() {
  const items = [];
  const roots = [];
  const codexDir = path.join(home(), '.codex');

  // ~/.codex/config.toml — [mcp_servers.NAME]
  const configText = readText(path.join(codexDir, 'config.toml'));
  if (configText) {
    roots.push('.codex/config.toml');
    const config = parseToml(configText);
    for (const [section, def] of Object.entries(config)) {
      const m = /^mcp_servers\.(.+)$/.exec(section);
      if (!m) continue;
      items.push(mcpItem(m[1], def, 'codex'));
    }
  }

  // ~/.codex/skills/*/SKILL.md
  for (const entry of listDir(path.join(codexDir, 'skills'))) {
    if (!entry.isDirectory()) continue;
    const body = readText(path.join(codexDir, 'skills', entry.name, 'SKILL.md'));
    if (!body) continue;
    items.push(skillItem(entry.name, body, 'codex'));
  }

  // ~/.codex/prompts/*.md
  for (const entry of listDir(path.join(codexDir, 'prompts'))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const body = readText(path.join(codexDir, 'prompts', entry.name));
    if (!body) continue;
    items.push(promptItem(entry.name.replace(/\.md$/, ''), body, 'codex'));
  }

  // ~/.codex/history.jsonl — recent session titles
  const history = readText(path.join(codexDir, 'history.jsonl'), 256 * 1024);
  if (history) {
    roots.push('.codex/history.jsonl');
    const seen = new Set();
    for (const line of history.split('\n').reverse()) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        const text = String(row.text ?? row.prompt ?? '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        items.push({
          kind: 'session',
          title: text.slice(0, 120),
          excerpt: text.slice(0, 200),
          source: 'codex',
          importable: false,
        });
        if (seen.size >= 10) break;
      } catch { /* not a JSON line */ }
    }
  }

  return { items, roots };
}

function discoverCursor() {
  const items = [];
  const roots = [];
  const cursorDir = path.join(home(), '.cursor');

  const mcp = readJson(path.join(cursorDir, 'mcp.json'));
  if (mcp) {
    roots.push('.cursor/mcp.json');
    for (const [name, def] of Object.entries(mcp.mcpServers ?? {})) {
      items.push(mcpItem(name, def, 'cursor'));
    }
  }

  for (const entry of listDir(path.join(cursorDir, 'rules'))) {
    if (!entry.isFile() || !entry.name.endsWith('.mdc')) continue;
    const body = readText(path.join(cursorDir, 'rules', entry.name));
    if (!body) continue;
    items.push(promptItem(entry.name.replace(/\.mdc$/, ''), body, 'cursor'));
  }

  return { items, roots };
}

function discoverOpencode() {
  const items = [];
  const roots = [];
  for (const base of ['.config/opencode', '.opencode']) {
    const dir = path.join(home(), base);
    const config = readJson(path.join(dir, 'opencode.json'))
      ?? readJson(path.join(dir, 'config.json'));
    if (config) {
      roots.push(`${base}/opencode.json`);
      for (const [name, def] of Object.entries(config.mcp ?? config.mcpServers ?? {})) {
        items.push(mcpItem(name, def, 'opencode'));
      }
    }
    for (const entry of listDir(path.join(dir, 'command'))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const body = readText(path.join(dir, 'command', entry.name));
      if (!body) continue;
      items.push(promptItem(entry.name.replace(/\.md$/, ''), body, 'opencode'));
    }
  }
  return { items, roots };
}

/* ---------------- item shapes ---------------- */

function mcpItem(name, def, source, project) {
  const type = def?.type ?? (def?.url ? 'http' : 'stdio');
  const excerpt = type === 'http'
    ? String(def?.url ?? '')
    : `stdio · ${[def?.command, ...(def?.args ?? [])].filter(Boolean).join(' ')}`.trim();
  return {
    kind: 'mcp_server',
    title: String(name),
    excerpt: excerpt.slice(0, 200),
    source,
    project: project ?? null,
    importable: true,
    definition: {
      name: String(name),
      command: def?.command ?? null,
      args: Array.isArray(def?.args) ? def.args.map(String) : [],
      env: def?.env && typeof def.env === 'object' ? Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, String(v)])) : {},
      url: def?.url ?? null,
      type,
    },
  };
}

function skillItem(name, body, source) {
  const description = /^---\s*\n([\s\S]*?)\n---/.exec(body)?.[1] ?? '';
  const descLine = description.split('\n').find((l) => l.startsWith('description:')) ?? '';
  return {
    kind: 'skill',
    title: name,
    excerpt: (descLine.replace(/^description:\s*/, '') || body.replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, 200)).slice(0, 200),
    source,
    importable: true,
    body,
  };
}

function promptItem(name, body, source) {
  return {
    kind: 'prompt',
    title: name,
    excerpt: body.replace(/^---\s*[\s\S]*?---\s*/, '').trim().slice(0, 200),
    source,
    importable: true,
    body,
  };
}

/* ---------------- the public surface ---------------- */

/**
 * Discover everything the local AI-tool ecosystems expose.
 * @returns {{ sources: object[], items: object[], counts: object }}
 */
function discover() {
  const perSource = {
    claude_code: discoverClaudeCode(),
    codex: discoverCodex(),
    cursor: discoverCursor(),
    opencode: discoverOpencode(),
  };
  const items = [];
  const sources = [];
  for (const source of SOURCES) {
    const found = perSource[source.id] ?? { items: [], roots: [] };
    items.push(...found.items);
    sources.push({
      id: source.id,
      label: source.label,
      found: found.items.length > 0,
      count: found.items.length,
      roots: found.roots,
    });
  }
  const counts = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return { sources, items: items.slice(0, MAX_ITEMS), counts };
}

/** The catalogue of importable items (id-addressable for the import calls). */
function catalog() {
  const found = discover();
  const entries = found.items.map((item, index) => ({
    id: `${item.source}:${item.kind}:${item.title}:${index}`,
    kind: item.kind,
    title: item.title,
    excerpt: item.excerpt,
    source: item.source,
    project: item.project ?? null,
    importable: item.importable === true,
  }));
  return { ...found, entries };
}

/** Resolve a catalogue entry back to its full definition. */
function resolve(entryId) {
  const found = discover();
  const index = Number(String(entryId).split(':').pop());
  const item = found.items[index];
  if (!item) return null;
  return item;
}

/**
 * Import one discovered item into Quansiox.
 *
 *  - mcp_server → the MCP server list (then the MCP service reloads)
 *  - skill      → the local skill catalog
 *  - prompt     → the prompt library
 */
async function importItem(entryId) {
  const item = resolve(entryId);
  if (!item) return { status: 'error', error: 'unknown entry' };
  if (!item.importable) return { status: 'error', error: 'this entry cannot be imported' };
  const { settingsService } = require('./settingsService');
  if (item.kind === 'mcp_server') {
    const def = item.definition ?? {};
    if (!def.command && !def.url) return { status: 'error', error: 'the server has neither a command nor a url' };
    const current = settingsService.load().mcpServers ?? [];
    const next = [...current.filter((s) => s.name !== def.name), {
      name: def.name,
      command: def.command ?? undefined,
      args: def.args ?? [],
      env: def.env ?? {},
      ...(def.url ? { url: def.url } : {}),
    }];
    settingsService.save({ mcpServers: next });
    try { await require('./mcpService').mcpService.reloadAll(); } catch { /* reload is best effort */ }
    return { status: 'ok', kind: item.kind, name: def.name };
  }
  if (item.kind === 'skill') {
    const { skillsService } = require('./skillsService');
    const installed = skillsService.install({
      id: `ext-${item.source}-${item.title}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 64),
      name: item.title,
      description: item.excerpt,
      body: item.body,
      version: '1.0.0',
      source: item.source,
    });
    return { status: 'ok', kind: item.kind, id: installed.id };
  }
  if (item.kind === 'prompt') {
    const current = settingsService.load().prompts ?? [];
    const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const entry = {
      id,
      title: item.title.slice(0, 60),
      body: String(item.body ?? '').slice(0, 8000),
      createdAt: Date.now(),
    };
    settingsService.save({ prompts: [entry, ...current] });
    return { status: 'ok', kind: item.kind, id };
  }
  return { status: 'error', error: `cannot import ${item.kind}` };
}

module.exports = { ecosystemService: { discover, catalog, importItem, parseToml, SOURCES } };
