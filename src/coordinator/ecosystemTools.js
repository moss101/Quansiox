'use strict';
/**
 * Ecosystem tools — the model can manage the app's own extensions.
 *
 * The reference implementation gives the model a plugin-management surface:
 * `InstallPlugin`, `UninstallPlugin`, `GetPlugin`, `SearchPlugins`,
 * `AddMcpServer`, `RemoveMcpAccount`, `RenameMcpAccount`,
 * `AuthenticateMcpServer`, `GetMcpServerStatus`, `SetMcpInstructions`,
 * `RestartMcpServers`, `UninstallMcpServer`.
 *
 * Locally, "installing a plugin" means one of three real things:
 *
 *   - a **skill** from the local catalogue (`skillsService`);
 *   - an **MCP server** from the local registry (`mcpService`);
 *   - a **signed addon** — a bundle with an Ed25519 signature, which is
 *     published to the workspace and can be carried to another agent.
 *
 * The rules are the user's: the model may propose and install, but a
 * **signed** addon is the only thing that may be published, and nothing
 * unsigned is ever installed.
 */
const { marketplaceService } = require('../main/services/marketplaceService');
const { mcpService } = require('../main/services/mcpService');
const { skillsService } = require('../main/services/skillsService');
const { agentPluginsService } = require('../main/services/agentPluginsService');
const { addonService } = require('../main/services/addonService');

/* ------------------------------------------------------------------ tools */

const ECOSYSTEM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_plugins',
      description: 'Search the plugin, skill and MCP catalogue. Use this before installing anything.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'what to look for' },
          kind: { type: 'string', enum: ['skill', 'mcp', 'addon'], description: 'restrict to one kind' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install_plugin',
      description: 'Install a skill, an MCP server or a signed addon from the catalogue.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'the catalogue id' },
          kind: { type: 'string', enum: ['skill', 'mcp', 'addon'] },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'uninstall_plugin',
      description: 'Remove an installed skill, MCP server or addon.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['skill', 'mcp', 'addon'] },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_installed_plugins',
      description: 'List what is installed: skills, MCP servers and addons, with their state.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_mcp_server_status',
      description: 'The state of an MCP server: ready, failed, restarting, and the tools it exposes.',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string', description: 'the server name' } },
        required: ['server'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_mcp_instructions',
      description: 'Set the custom instructions for an MCP server — the notes that tell the model how to use it.',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          instructions: { type: 'string' },
        },
        required: ['server', 'instructions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restart_mcp_servers',
      description: 'Restart the MCP servers — after changing a configuration, or when a server is stuck.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_skill',
      description: 'Propose a new skill from what this conversation established. A skill is a short procedure the agent can reuse.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'the skill\'s name' },
          description: { type: 'string', description: 'what it is for' },
          body: { type: 'string', description: 'the procedure itself, in markdown' },
        },
        required: ['name', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_carry_over',
      description: 'Carry a setup over to another agent — the skills, plugins and instructions it should start with.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'the agent to carry the setup over to' },
          skills: { type: 'array', items: { type: 'string' } },
          plugins: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_canvas',
      description:
        'Create or replace a CANVAS — a live JavaScript application the user can open. '
        + 'The canvas is an ES module: export a default function that receives the canvas API '
        + '(data, state, theme, render(el), el(tag, props, ...children)) and renders into the page. '
        + 'It runs sandboxed with no network and no access to the app.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'what the canvas shows' },
          userModule: {
            type: 'string',
            description:
              'The ES module source. It must export a default function (or a mount() function) '
              + 'that takes the canvas API.',
          },
          data: { type: 'object', description: 'data the canvas reads (available as api.data)' },
          state: { type: 'object', description: 'initial state (available as api.state)' },
          canvasId: { type: 'string', description: 'the canvas to replace; omit to create a new one' },
        },
        required: ['userModule'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_canvases',
      description: 'List the canvases: their ids, titles and when they changed.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL and return its text. The URL must be on the egress allow-list.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          maxBytes: { type: 'number' },
        },
        required: ['url'],
      },
    },
  },
];

/* ---------------------------------------------------------------- handlers */

function json(value) {
  return JSON.stringify(value, null, 2);
}

/** The catalogue, filtered by a query and a kind. */
function searchCatalogue(query, kind) {
  const entries = marketplaceService.list({ kind: kind || undefined, query: query || undefined }) ?? [];
  return entries.map(({ id, kind, name, description, category, version, installed }) => ({
    id, kind, name, description, category, version, installed: Boolean(installed),
  }));
}

/**
 * Handle an ecosystem tool call.
 * @returns {Promise<string|null>} the result, or null when the tool is not ours.
 */
async function executeEcosystemTool(name, args = {}, ctx = {}) {
  switch (name) {
    case 'search_plugins': {
      const entries = searchCatalogue(args.query, args.kind);
      if (!entries.length) return 'nothing in the catalogue matches';
      return entries.map((e) => `- ${e.id} [${e.kind}] ${e.name ?? ''} — ${String(e.description ?? '').slice(0, 160)}`).join('\n');
    }

    case 'install_plugin': {
      const kind = args.kind ?? 'skill';
      if (kind === 'addon') {
        // An addon is a signed bundle. The signature is verified by the
        // addon service; an unsigned bundle is refused.
        const entry = (marketplaceService.CATALOG ?? []).find((e) => e.id === args.id);
        if (!entry) return `no catalogue entry "${args.id}"`;
        const installedAddon = addonService.installFromManifest({
          id: entry.id,
          name: entry.name,
          description: entry.description,
          version: entry.version ?? '1.0.0',
          skills: entry.skills ?? [],
          mcpServers: entry.mcpServers ?? [],
        }, { signature: entry.signature ?? null });
        return `installed the addon "${args.id}"`;
      }
      // Skills and MCP servers come from the local catalogue.
      const result = marketplaceService.install(args.id);
      if (result?.already) return `"${args.id}" is already installed`;
      if (result?.kind === 'mcp') {
        mcpService.reloadAll();
        return `registered the MCP server "${result.id}" — it starts with the next run`;
      }
      return `installed the skill "${result?.id ?? args.id}"`;
    }

    case 'uninstall_plugin': {
      const kind = args.kind ?? 'skill';
      if (kind === 'addon') {
        addonService.uninstall({ id: args.id });
        return `removed the addon "${args.id}"`;
      }
      if (kind === 'mcp') {
        return 'MCP servers are removed in Settings → MCP servers, not by the agent';
      }
      marketplaceService.uninstall(args.id);
      return `removed the skill "${args.id}"`;
    }

    case 'list_installed_plugins': {
      const skills = skillsService.list() ?? [];
      const mcp = mcpService.status() ?? {};
      const addons = addonService.list() ?? {};
      const mcpNames = Object.keys(mcp.servers ?? {});
      return [
        `skills: ${skills.length ? skills.map((s) => `${s.id}${s.enabled ? '' : ' (off)'}`).join(', ') : '(none)'}`,
        `mcp servers: ${mcpNames.length ? mcpNames.join(', ') : '(none)'}`,
        `addons: ${addons.length ? addons.map((a) => `${a.id}${a.enabled ? '' : ' (off)'}`).join(', ') : '(none)'}`,
      ].join('\n');
    }

    case 'get_mcp_server_status': {
      const status = mcpService.status() ?? {};
      const server = status.servers?.[args.server];
      if (!server) {
        const known = Object.keys(status.servers ?? {});
        return known.length
          ? `unknown MCP server "${args.server}" — known: ${known.join(', ')}`
          : 'no MCP servers are configured';
      }
      return json({
        name: server.name,
        status: server.status,
        tools: (server.tools ?? []).map((t) => t.name),
        error: server.error ?? null,
      });
    }

    case 'set_mcp_instructions': {
      const servers = mcpService.status()?.servers ?? {};
      const server = servers[args.server];
      if (!server) return `unknown MCP server "${args.server}"`;
      // The instructions live with the server's configuration.
      server.instructions = String(args.instructions ?? '').slice(0, 4000);
      mcpService.reloadAll();
      return `set the instructions for "${args.server}"`;
    }

    case 'restart_mcp_servers': {
      const result = mcpService.reloadAll();
      return `restarted the MCP servers (${result?.servers ?? 'unknown'} configured)`;
    }

    case 'propose_skill': {
      const name = String(args.name ?? '').trim();
      const body = String(args.body ?? '').trim();
      if (!name || !body) return 'a proposed skill needs a name and a body';
      // A proposed skill is installed locally and enabled — it is a real
      // skill the agent can use from the next turn on.
      skillsService.install({ id: name, name, description: String(args.description ?? ''), body });
      return `proposed the skill "${name}" — it is installed and enabled`;
    }

    case 'propose_carry_over': {
      const agentId = String(args.agentId ?? '');
      const current = agentPluginsService.getPlugins({ agentId }) ?? { plugins: [] };
      const skills = Array.isArray(args.skills) ? args.skills.map(String) : [];
      const plugins = Array.isArray(args.plugins) ? args.plugins.map(String) : [];
      const merged = [...new Set([...(current.plugins ?? []), ...plugins])];
      agentPluginsService.setPlugins({ agentId, plugins: merged });
      for (const skill of skills) {
        try { skillsService.install({ id: skill, name: skill }); } catch { /* already installed */ }
      }
      return `carried over to the agent: ${skills.length} skill(s), ${plugins.length} plugin(s)`
        + (args.note ? ` — ${args.note}` : '');
    }

    case 'edit_canvas': {
      const { canvasBundleService } = require('../main/services/canvasBundleService');
      const record = canvasBundleService.save({
        id: args.canvasId,
        title: args.title,
        userModule: args.userModule,
        data: args.data,
        state: args.state,
      });
      return `saved the canvas "${record.title}" [${record.id}] — open it at ${canvasBundleService.urlFor(record.id)}`;
    }

    case 'list_canvases': {
      const { canvasBundleService } = require('../main/services/canvasBundleService');
      const rows = canvasBundleService.list();
      if (!rows.length) return 'no canvases yet — create one with edit_canvas';
      return rows.map((c) => `- ${c.title} [${c.id}] — ${c.userModuleBytes} bytes of module`).join('\n');
    }

    case 'web_fetch': {
      const url = String(args.url ?? '').trim();
      if (!url) return 'web_fetch needs a url';
      // The egress policy decides: a host that is not on the allow-list is
      // refused before a socket is opened.
      const { hostAllowed } = require('../coordinator/egressPolicy');
      const { normalizePolicy } = require('../coordinator/egressPolicy');
      const settings = require('../main/services/settingsService').settingsService.load();
      const policy = normalizePolicy(settings.egressPolicy ?? {});
      const host = (() => { try { return new URL(url).hostname; } catch { return null; } })();
      if (!host) return `web_fetch: "${url}" is not a valid URL`;
      const verdict = hostAllowed(policy, host);
      if (!verdict.allowed) {
        return `web_fetch refused: ${verdict.reason}. Add the host to the egress allow-list if it should be reachable.`;
      }
      const maxBytes = Math.max(1000, Math.min(Number(args.maxBytes) || 200_000, 2_000_000));
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        clearTimeout(timer);
        if (!response.ok) return `web_fetch: ${response.status} ${response.statusText}`;
        const type = response.headers.get('content-type') ?? '';
        if (!/text|json|xml/i.test(type)) {
          return `web_fetch: ${type || 'a binary response'} — only text is returned`;
        }
        const text = await response.text();
        return text.slice(0, maxBytes);
      } catch (error) {
        return `web_fetch failed: ${String(error?.message ?? error).slice(0, 200)}`;
      }
    }

    default:
      return null;
  }
}

module.exports = { ECOSYSTEM_TOOLS, executeEcosystemTool, searchCatalogue };
