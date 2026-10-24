'use strict';
/**
 * MCP service — manages external Model Context Protocol tool servers
 * (stdio transport, hand-rolled JSON-RPC — no SDK dependency, Manus-style).
 *
 * Config lives in settings.mcpServers: [{ name, command, args: [], env: {} }].
 * Each server is spawned, initialized (initialize -> notifications/initialized
 * -> tools/list) and its tools are exposed to the agent as
 * `mcp__<server>__<tool>` with the server's input schema converted to an
 * OpenAI function parameters spec.
 */
const { spawn } = require('node:child_process');
const { settingsService } = require('./settingsService');

/** @type {Map<string, { proc, pending: Map, nextId, tools: [], status, startedAt }>} */
const servers = new Map();

const PROTOCOL_VERSION = '2024-11-05';
const INIT_TIMEOUT = 10_000;
const CALL_TIMEOUT = 120_000;

function log(server, ...args) {
  console.log(`[mcp:${server}]`, ...args);
}

async function startServer(config) {
  const { name } = config;
  await stopServer(name);
  const entry = {
    proc: null,
    pending: new Map(), // id -> {resolve, reject, timer}
    nextId: 1,
    tools: [],
    status: 'starting',
    startedAt: Date.now(),
  };
  servers.set(name, entry);
  try {
    entry.proc = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    entry.status = `failed: ${error.message}`;
    return entry;
  }

  let buffer = '';
  entry.proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && entry.pending.has(msg.id)) {
        const { resolve, reject, timer } = entry.pending.get(msg.id);
        clearTimeout(timer);
        entry.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
      // Notifications/requests from server (logging etc.) are ignored for now.
    }
  });
  entry.proc.stderr.on('data', (d) => log(name, 'stderr:', d.toString().trim().slice(0, 300)));
  // A command that does not exist fails asynchronously with an 'error' event
  // (spawn does not throw for ENOENT). Without this handler the unhandled
  // event takes the whole app down — one misconfigured MCP server must never
  // be fatal.
  entry.proc.on('error', (error) => {
    entry.status = `failed: ${error.message}`;
    for (const { reject, timer } of entry.pending.values()) {
      clearTimeout(timer);
      reject(new Error(error.message));
    }
    entry.pending.clear();
    log(name, 'spawn failed:', error.message);
  });
  entry.proc.on('exit', (code) => {
    entry.status = `exited (${code ?? 'signal'})`;
    for (const { reject, timer } of entry.pending.values()) {
      clearTimeout(timer);
      reject(new Error('MCP server exited'));
    }
    entry.pending.clear();
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = entry.nextId++;
      const timer = setTimeout(
        () => {
          entry.pending.delete(id);
          reject(new Error(`${method} timed out`));
        },
        method === 'tools/call' ? CALL_TIMEOUT : INIT_TIMEOUT
      );
      entry.pending.set(id, { resolve, reject, timer });
      entry.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  entry.request = request;

  try {
    const init = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'quansiox', version: '0.2.0' },
    });
    entry.proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
    const listResult = await request('tools/list', {});
    entry.tools = (listResult?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
    entry.status = 'ready';
    log(name, `ready with ${entry.tools.length} tools`);
  } catch (error) {
    entry.status = `failed: ${error.message}`;
    log(name, 'init failed:', error.message);
    try { entry.proc.kill(); } catch {}
  }
  return entry;
}

async function stopServer(name) {
  const entry = servers.get(name);
  if (entry?.proc) {
    try { entry.proc.kill(); } catch {}
  }
  servers.delete(name);
}

/** (Re)start every configured server. Returns status snapshot. */
async function reloadAll() {
  const configs = settingsService.load().mcpServers ?? [];
  for (const name of [...servers.keys()]) {
    if (!configs.some((c) => c.name === name)) stopServer(name);
  }
  await Promise.all(configs.filter((c) => c.command).map((c) => startServer(c)));
  return status();
}

function status() {
  return [...servers.entries()].map(([name, e]) => ({
    name,
    status: e.status,
    tools: e.tools.map((t) => t.name),
    pid: e.proc?.pid ?? null,
  }));
}

/** All ready tools as OpenAI function specs, namespaced to avoid collisions.
 *  Tools the user blocked in setMcpToolPermissions are excluded. */
function toolSpecs() {
  const perms = settingsService.load().mcpToolPermissions ?? {};
  const specs = [];
  for (const [server, entry] of servers.entries()) {
    if (entry.status !== 'ready') continue;
    const blocked = perms[server]?.tools ?? {};
    for (const tool of entry.tools) {
      if (blocked[tool.name] === 'blocked') continue;
      specs.push({
        type: 'function',
        function: {
          name: `mcp__${server}__${tool.name}`,
          description: `[${server}] ${tool.description}`,
          parameters: tool.inputSchema,
        },
      });
    }
  }
  return specs;
}

/** Resolve a server by config name, tool namespace, or identifier substring. */
function resolveServer(identifier) {
  const id = String(identifier ?? '');
  if (servers.has(id)) return { name: id, entry: servers.get(id) };
  for (const [name, entry] of servers.entries()) {
    if (name.toLowerCase() === id.toLowerCase()) return { name, entry };
  }
  const cfg = (settingsService.load().mcpServers ?? []).find((s) => s.name === id);
  if (cfg) return { name: cfg.name, entry: servers.get(cfg.name) ?? null };
  return null;
}

function logToolCall(server, tool) {
  try {
    const { diagnosticsService } = require('./diagnosticsService');
    diagnosticsService.record('mcp_tool_call', { server, tool });
  } catch {}
}

/** Execute a namespaced tool call. Returns the text result (legacy contract). */
/**
 * Expand symbolic path arguments.
 *
 * A large file should not have to be inlined into a tool call: the model
 * writes `$file:/abs/path` and the executor substitutes the content at the
 * boundary, so the transcript only ever holds the reference.
 *
 * The reference implementation caps an expanded argument at 16 MiB.
 */
const SYMBOLIC_MAX_BYTES = 16 * 1024 * 1024;
const SYMBOLIC_PATTERN = /^\$file:(.+)$/s;

/**
 * @param {object} args
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @returns {{ args: object, expanded: Array<{ path, bytes, sha256 }>, skipped: Array<{ path, reason }> }}
 */
function expandSymbolicPaths(args, { maxBytes = SYMBOLIC_MAX_BYTES } = {}) {
  const expanded = [];
  const skipped = [];
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value !== 'string') { out[key] = value; continue; }
    const match = value.match(SYMBOLIC_PATTERN);
    if (!match) { out[key] = value; continue; }
    const filePath = match[1];
    try {
      const stat = require('node:fs').statSync(filePath);
      if (!stat.isFile()) { skipped.push({ path: filePath, reason: 'not a file' }); out[key] = value; continue; }
      if (stat.size > maxBytes) {
        skipped.push({ path: filePath, reason: `too large (${stat.size} bytes, max ${maxBytes})` });
        out[key] = value;
        continue;
      }
      const content = require('node:fs').readFileSync(filePath);
      const sha256 = require('node:crypto').createHash('sha256').update(content).digest('hex');
      out[key] = content.toString('utf8');
      expanded.push({ path: filePath, bytes: stat.size, sha256 });
    } catch (error) {
      skipped.push({ path: filePath, reason: String(error?.message ?? error).slice(0, 200) });
      out[key] = value;
    }
  }
  return { args: out, expanded, skipped };
}

async function callTool(namespacedName, args) {
  const match = /^mcp__(.+?)__(.+)$/.exec(namespacedName);
  if (!match) throw new Error(`not an MCP tool: ${namespacedName}`);
  const [, server, tool] = match;
  // Symbolic path arguments are expanded HERE, at the executor boundary, so
  // the file content never has to travel through the model.
  const { args: expandedArgs } = expandSymbolicPaths(args ?? {});
  return (await callToolOnServer(server, tool, expandedArgs)).text;
}

/** Execute `<tool>` on `<serverIdentifier>` (Grok callMcpAppTool / wire calls). */
async function callToolOnServer(serverIdentifier, toolName, args) {
  await ensureLoaded();
  const resolved = resolveServer(serverIdentifier);
  if (!resolved?.entry || resolved.entry.status !== 'ready') throw new Error(`MCP server not ready: ${serverIdentifier}`);
  const perms = settingsService.load().mcpToolPermissions ?? {};
  if (perms[resolved.name]?.tools?.[toolName] === 'blocked') throw new Error(`MCP tool blocked by permissions: ${resolved.name}/${toolName}`);
  const available = resolved.entry.tools.some((t) => t.name === toolName);
  if (!available) throw new Error(`unknown tool ${toolName} on ${resolved.name}`);
  logToolCall(resolved.name, toolName);
  const result = await resolved.entry.request('tools/call', { name: toolName, arguments: args ?? {} });
  const text = (result?.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
    .join('\n');
  return { text: text || JSON.stringify(result), raw: result, server: resolved.name, tool: toolName };
}

/** List resources exposed by a server (resources/list). */
async function listResources(serverIdentifier) {
  await ensureLoaded();
  const resolved = resolveServer(serverIdentifier);
  if (!resolved?.entry || resolved.entry.status !== 'ready') throw new Error(`MCP server not ready: ${serverIdentifier}`);
  const result = await resolved.entry.request('resources/list', {});
  return { server: resolved.name, resources: result?.resources ?? [] };
}

/** Read a resource (resources/read) — Grok readMcpAppResource. */
async function readResource(serverIdentifier, resourceUri) {
  await ensureLoaded();
  const resolved = resolveServer(serverIdentifier);
  if (!resolved?.entry || resolved.entry.status !== 'ready') throw new Error(`MCP server not ready: ${serverIdentifier}`);
  const result = await resolved.entry.request('resources/read', { uri: String(resourceUri) });
  return { server: resolved.name, uri: String(resourceUri), contents: result?.contents ?? [] };
}

/** Reload only when the configured server list differs from what's running. */
async function ensureLoaded() {
  const configs = settingsService.load().mcpServers ?? [];
  const current = [...servers.entries()].map(([name, e]) => ({
    name,
    command: e.proc?.spawnargs?.[0] ?? '',
  }));
  const same =
    configs.length === current.length &&
    configs.every((c) => servers.has(c.name) && servers.get(c.name).status === 'ready');
  if (!same) await reloadAll();
}

module.exports = {
  mcpService: {
    reloadAll, status, toolSpecs, callTool, callToolOnServer, listResources, readResource,
    resolveServer, stopServer, ensureLoaded, expandSymbolicPaths,
  },
  SYMBOLIC_MAX_BYTES,
};
