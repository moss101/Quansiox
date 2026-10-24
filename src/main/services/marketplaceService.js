'use strict';
/**
 * Marketplace service — a Quansiox-owned, local install marketplace that unifies
 * the skill catalog (skillsService) and stdio MCP servers (settings.mcpServers).
 * No backend: the catalog is bundled/curated, install dispatches by kind, and an
 * MCP install just records the server config (the coordinator MCP-syncs before
 * each run). "Publish" to the marketplace = install into your local catalog.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR) → testable; install writes
 * skills/ (via skillsService) or settings.mcpServers, never spawns processes here.
 */
const fs = require('node:fs');
const path = require('node:path');

// Curated bundle. kind: 'skill' → skillsService.install; 'mcp' → settings.mcpServers.
const CATALOG = [
  { id: 'code-review', kind: 'skill', name: 'Code Review', description: 'Review diffs/PRs for bugs, security, and clarity; propose fixes.', category: 'dev', author: 'quansiox', version: '1.0.0', body: 'You are a rigorous code reviewer. For the given diff or files: list concrete bugs and risks (with file:line), then prioritized fixes. Prefer safe, minimal changes; never rewrite large sections unprompted.' },
  { id: 'write-docs', kind: 'skill', name: 'Write Docs', description: 'Produce clear README/API docs with examples from the codebase.', category: 'dev', author: 'quansiox', version: '1.0.0', body: 'You write developer documentation. Read the code first, then document: purpose, quickstart, API with examples, and gotchas. Match the repo tone; keep it concise and accurate.' },
  { id: 'commit-message', kind: 'skill', name: 'Commit Message', description: 'Draft a Conventional Commits message from the staged diff.', category: 'dev', author: 'quansiox', version: '1.0.0', body: 'Write a Conventional Commits message for the staged changes. Summarize the why in the body; respect scope; do not describe the diff line by line.' },
  { id: 'mcp-filesystem', kind: 'mcp', name: 'Filesystem MCP', description: 'Read/write local files via the Model Context Protocol filesystem server.', category: 'mcp', author: '@modelcontextprotocol', version: '1.0.0', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
  { id: 'mcp-fetch', kind: 'mcp', name: 'Fetch MCP', description: 'Fetch and convert web pages to markdown for the agent.', category: 'mcp', author: '@modelcontextprotocol', version: '1.0.0', command: 'npx', args: ['-y', 'mcp-server-fetch'] },
  { id: 'mcp-memory', kind: 'mcp', name: 'Memory MCP', description: 'Persistent knowledge-graph memory server (entities/relations).', category: 'mcp', author: '@modelcontextprotocol', version: '1.0.0', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { id: 'mcp-github', kind: 'mcp', name: 'GitHub MCP', description: 'GitHub repos, issues, and PRs (requires GITHUB_TOKEN env).', category: 'mcp', author: '@modelcontextprotocol', version: '1.0.0', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '{{secret:github.token}}' } },
  { id: 'mcp-sqlite', kind: 'mcp', name: 'SQLite MCP', description: 'Query and inspect a local SQLite database.', category: 'mcp', author: '@modelcontextprotocol', version: '1.0.0', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', 'app.db'] },
];

function settings() { return require('./settingsService').settingsService; }
function skills() { return require('./skillsService').skillsService; }
function idv(id) { return CATALOG.find((p) => p.id === String(id)); }

function installed(id) {
  const pkg = idv(id);
  if (!pkg) return false;
  if (pkg.kind === 'skill') return Boolean(skills().get(pkg.id));
  return (settings().load().mcpServers ?? []).some((s) => s.name === pkg.id);
}

function list({ kind, query } = {}) {
  const q = String(query ?? '').toLowerCase();
  return CATALOG
    .filter((p) => !kind || p.kind === kind)
    .filter((p) => !q || `${p.name} ${p.description} ${p.id} ${p.category}`.toLowerCase().includes(q))
    .map(({ body, command, args, env, ...meta }) => ({ ...meta, installed: installed(meta.id) }));
}

function install(id) {
  const pkg = idv(id);
  if (!pkg) throw new Error(`package not in catalog: ${id}`);
  if (installed(pkg.id)) return { id: pkg.id, kind: pkg.kind, already: true };
  if (pkg.kind === 'skill') {
    skills().install({ id: pkg.id, name: pkg.name, description: pkg.description, body: pkg.body, author: pkg.author, version: pkg.version });
    return { id: pkg.id, kind: 'skill', installed: true };
  }
  const cfg = settings().load();
  const entry = { name: pkg.id, command: pkg.command, args: pkg.args ?? [], ...(pkg.env ? { env: { ...pkg.env } } : {}) };
  settings().save({ mcpServers: [...(cfg.mcpServers ?? []), entry] });
  return { id: pkg.id, kind: 'mcp', installed: true, server: entry };
}

function uninstall(id) {
  const pkg = idv(id);
  if (!pkg) throw new Error(`package not in catalog: ${id}`);
  if (pkg.kind === 'skill') { skills().uninstall(pkg.id); return { id: pkg.id, kind: 'skill', removed: true }; }
  const cfg = settings().load();
  settings().save({ mcpServers: (cfg.mcpServers ?? []).filter((s) => s.name !== pkg.id) });
  return { id: pkg.id, kind: 'mcp', removed: true };
}

/** Install from an external manifest (JSON package object). No network here. */
function installFromManifest(pkg = {}) {
  if (!pkg || typeof pkg !== 'object') throw new Error('manifest required');
  const kind = pkg.kind === 'mcp' ? 'mcp' : 'skill';
  const id = String(pkg.id ?? pkg.name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) throw new Error('manifest needs an id/name');
  if (kind === 'skill') { skills().install({ id, name: pkg.name, description: pkg.description, body: pkg.body, version: pkg.version, tools: pkg.tools }); return { id, kind, installed: true }; }
  if (!pkg.command) throw new Error('mcp manifest needs a command');
  const entry = { name: id, command: pkg.command, args: pkg.args ?? [], ...(pkg.env ? { env: { ...pkg.env } } : {}) };
  const cfg = settings().load();
  settings().save({ mcpServers: [...(cfg.mcpServers ?? []), entry] });
  return { id, kind: 'mcp', installed: true, server: entry };
}

module.exports = { marketplaceService: { list, install, uninstall, installed, installFromManifest, CATALOG } };
