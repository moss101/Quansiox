import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, toast } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * McpPanel — the Model Context Protocol server surface.
 *
 * An MCP server is an external tool provider: it runs as a child process,
 * publishes a tool list, and the agent may call those tools. This panel
 * shows what is installed, whether each server is running, which tools it
 * publishes, and what the user allows per tool (allow / ask / blocked).
 *
 * It also owns the three ways a server comes and goes: install one from the
 * marketplace, add one by hand, and remove one. "Authenticate" edits the
 * server's environment — a value may be a vault reference such as
 * `{{secret:github.token}}`; a raw secret is never rendered here.
 *
 * Props:
 *   - active?: boolean — when false the panel stops polling (default true).
 *   - onToast?: (message: string, kind?: 'ok' | 'err' | 'warn' | 'info') => void
 *     — the notification sink. Falls back to the global toast in lib.js.
 */

/** The three per-tool levels, in the order the panel shows them. */
const LEVELS = [
  { id: 'allow', label: 'allow', title: 'The agent may call this tool without asking.' },
  { id: 'ask', label: 'ask', title: 'The tool stays available, marked as one to confirm.' },
  { id: 'blocked', label: 'block', title: 'The tool is withheld from the agent entirely.' },
];

/** Normalise the stored level ('allowed' is the legacy spelling). */
function levelOf(perms, server, tool) {
  const raw = perms?.[server]?.tools?.[tool];
  if (raw === 'blocked') return 'blocked';
  if (raw === 'allow' || raw === 'allowed') return 'allow';
  return 'ask';
}

/** Collapse the runtime status into a badge state. */
function statusKind(status) {
  if (!status) return 'idle';
  if (status === 'ready') return 'ready';
  if (status === 'starting') return 'starting';
  return 'failed';
}

/** The commands of a server, for the one-line summary. */
function commandOf(cfg) {
  const args = Array.isArray(cfg?.args) ? cfg.args.join(' ') : '';
  return [cfg?.command ?? '', args].filter(Boolean).join(' ');
}

export function McpPanel({ active = true, onToast }) {
  const notify = useCallback((message, kind = 'info') => {
    if (onToast) onToast(message, kind);
    else toast(message, kind);
  }, [onToast]);

  const [servers, setServers] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [perms, setPerms] = useState({});
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [open, setOpen] = useState(null);        // the server being inspected
  const [tab, setTab] = useState('tools');        // tools | env | notes
  const [envDraft, setEnvDraft] = useState({ key: '', value: '' });
  const [notesDraft, setNotesDraft] = useState('');
  const [vaultNames, setVaultNames] = useState([]);
  const [newServer, setNewServer] = useState({ name: '', command: '', args: '' });

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [status, settings, packages] = await Promise.all([
        api.mcp.status(),
        api.settings.get(),
        api.marketplace.list({ kind: 'mcp' }),
      ]);
      setServers(Array.isArray(status) ? status : []);
      setConfigs(Array.isArray(settings?.mcpServers) ? settings.mcpServers : []);
      setPerms(settings?.mcpToolPermissions && typeof settings.mcpToolPermissions === 'object'
        ? settings.mcpToolPermissions
        : {});
      setCatalog(Array.isArray(packages) ? packages : []);
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    refresh();
    const timer = setInterval(refresh, 6000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  /** The installed servers, configured ones first, then any stray runtime. */
  const rows = useMemo(() => {
    const merged = new Map();
    for (const cfg of configs) merged.set(cfg.name, { name: cfg.name, cfg, runtime: null });
    for (const server of servers) {
      const existing = merged.get(server.name);
      merged.set(server.name, {
        name: server.name,
        cfg: existing?.cfg ?? null,
        runtime: server,
      });
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [configs, servers]);

  const selected = useMemo(
    () => rows.find((row) => row.name === open) ?? null,
    [rows, open],
  );

  const tools = selected?.runtime?.tools ?? [];

  /** Persist the whole mcpServers array (a field we own, never the rest). */
  const saveServers = useCallback(async (next) => {
    await api.settings.save({ mcpServers: next });
  }, []);

  const setToolLevel = async (serverName, tool, level) => {
    setBusy(true);
    try {
      const current = perms?.[serverName]?.tools ?? {};
      const next = {
        ...perms,
        [serverName]: { ...(perms?.[serverName] ?? {}), tools: { ...current, [tool]: level } },
      };
      await api.settings.save({ mcpToolPermissions: next });
      await refresh();
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const reloadServers = async () => {
    setBusy(true);
    try {
      await api.mcp.reload();
      await refresh();
      notify('MCP servers reloaded', 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const installPackage = async (id) => {
    setBusy(true);
    try {
      await api.marketplace.install({ id });
      await api.mcp.reload();
      await refresh();
      notify(`${id} installed`, 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const removeServer = async (name) => {
    setBusy(true);
    try {
      if (catalog.some((pkg) => pkg.id === name)) {
        await api.marketplace.uninstall({ id: name });
      } else {
        await saveServers(configs.filter((cfg) => cfg.name !== name));
      }
      await api.mcp.reload();
      if (open === name) setOpen(null);
      await refresh();
      notify(`${name} removed`, 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const addServer = async (event) => {
    event.preventDefault();
    const name = newServer.name.trim();
    const command = newServer.command.trim();
    if (!name || !command) return;
    setBusy(true);
    try {
      await saveServers([...configs, { name, command, args: newServer.args.trim() ? newServer.args.trim().split(/\s+/) : [] }]);
      await api.mcp.reload();
      setNewServer({ name: '', command: '', args: '' });
      await refresh();
      notify(`${name} added`, 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  /** Open the environment tab and load the vault names for the picker. */
  const openEnvironment = async (name) => {
    setOpen(name);
    setTab('env');
    setEnvDraft({ key: '', value: '' });
    try {
      const rowsOfSecrets = await api.secrets.list();
      setVaultNames((rowsOfSecrets ?? []).map((s) => s.name));
    } catch {
      setVaultNames([]);
    }
  };

  const openNotes = (name) => {
    setOpen(name);
    setTab('notes');
    const cfg = configs.find((c) => c.name === name);
    setNotesDraft(String(cfg?.instructions ?? ''));
  };

  const saveEnvironment = async (event) => {
    event.preventDefault();
    if (!selected) return;
    const key = envDraft.key.trim();
    if (!key) return;
    setBusy(true);
    try {
      const value = envDraft.value.trim() || `{{secret:${key}}}`;
      const next = configs.map((cfg) => (
        cfg.name === selected.name
          ? { ...cfg, env: { ...(cfg.env ?? {}), [key]: value } }
          : cfg
      ));
      await saveServers(next);
      await api.mcp.reload();
      setEnvDraft({ key: '', value: '' });
      await refresh();
      notify(`${key} set for ${selected.name}`, 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const removeEnvironmentKey = async (key) => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = configs.map((cfg) => {
        if (cfg.name !== selected.name) return cfg;
        const env = { ...(cfg.env ?? {}) };
        delete env[key];
        return { ...cfg, env };
      });
      await saveServers(next);
      await api.mcp.reload();
      await refresh();
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const saveNotes = async (event) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      const next = configs.map((cfg) => (
        cfg.name === selected.name ? { ...cfg, instructions: notesDraft } : cfg
      ));
      await saveServers(next);
      await refresh();
      notify('Instructions saved', 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const installedIds = useMemo(() => new Set(rows.map((row) => row.name)), [rows]);

  return (
    <section className="sfx-panel" data-surface="mcp">
      <header className="sfx-head">
        <span className="surface-label">MCP servers</span>
        <div className="sfx-head-actions">
          <button type="button" className="ibtn" title="Restart every server" disabled={busy} onClick={reloadServers}>
            <Icon.Zap />
          </button>
          <button type="button" className="ibtn" title="Refresh" disabled={busy} onClick={refresh}>
            <Icon.Refresh />
          </button>
        </div>
      </header>

      <div className="sfx-body">
        {error ? (
          <div className="sfx-error" data-surface="mcp-error">
            <Icon.Info />
            <span>{error}</span>
            <button type="button" className="btn btn-secondary btn-mini" onClick={refresh}>Retry</button>
          </div>
        ) : null}

        {loading && rows.length === 0 ? <div className="sfx-loading">Loading the MCP servers…</div> : null}

        {!loading && rows.length === 0 && !error ? (
          <div className="sfx-empty" data-surface="mcp-empty">
            <p>No MCP servers are installed.</p>
            <p className="sfx-hint">
              An MCP server gives the agent extra tools. Install one from the marketplace below,
              or add one by hand.
            </p>
          </div>
        ) : null}

        {rows.map((row) => {
          const cfg = row.cfg ?? {};
          const runtime = row.runtime;
          const kind = statusKind(runtime?.status);
          const isOpen = open === row.name;
          const env = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
          return (
            <article key={row.name} className="sfx-card" data-server={row.name} data-status={kind}>
              <div className="sfx-card-head">
                <span className="sfx-title">{row.name}</span>
                <span className="sfx-badge" data-status={kind}>{runtime?.status ?? 'not started'}</span>
                <button type="button" className="ibtn" title={isOpen ? 'Hide the tools' : 'Show the tools'}
                  onClick={() => { setOpen(isOpen ? null : row.name); setTab('tools'); }}>
                  <Icon.ChevronDown />
                </button>
              </div>
              <div className="sfx-meta">
                <code className="sfx-mono">{commandOf(cfg) || '—'}</code>
                {runtime?.pid ? <span className="sfx-tag">pid {runtime.pid}</span> : null}
                <span className="sfx-tag">{tools.length} tools</span>
              </div>

              {isOpen && tab === 'tools' ? (
                <div className="sfx-tools" data-surface="mcp-tools">
                  {tools.length === 0 ? (
                    <p className="sfx-hint">This server publishes no tools yet.</p>
                  ) : tools.map((tool) => {
                    const level = levelOf(perms, row.name, tool);
                    return (
                      <div key={tool} className="sfx-tool" data-tool={tool} data-level={level}>
                        <span className="sfx-tool-name">{tool}</span>
                        <span className="sfx-levels">
                          {LEVELS.map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              className={`sfx-level${level === option.id ? ' is-active' : ''}`}
                              data-level={option.id}
                              title={option.title}
                              disabled={busy}
                              aria-pressed={level === option.id}
                              onClick={() => setToolLevel(row.name, tool, option.id)}
                            >{option.label}</button>
                          ))}
                        </span>
                      </div>
                    );
                  })}
                  <p className="sfx-hint">
                    A blocked tool is withheld from the agent. Allow and ask keep the tool in reach —
                    the approval gate itself reads the global tool matrix in Settings → Permissions.
                  </p>
                </div>
              ) : null}

              {isOpen && tab === 'env' ? (
                <div className="sfx-env" data-surface="mcp-env">
                  {Object.keys(env).length === 0 ? (
                    <p className="sfx-hint">This server has no environment yet.</p>
                  ) : Object.entries(env).map(([key]) => (
                    <div key={key} className="sfx-env-row" data-env-key={key}>
                      <span className="sfx-mono">{key}</span>
                      <span className="sfx-tag">set</span>
                      <button type="button" className="ibtn danger" title="Remove this variable"
                        disabled={busy} onClick={() => removeEnvironmentKey(key)}>
                        <Icon.Trash />
                      </button>
                    </div>
                  ))}
                  <form className="sfx-form" onSubmit={saveEnvironment}>
                    <input
                      aria-label="Environment variable name"
                      placeholder="e.g. GITHUB_TOKEN"
                      value={envDraft.key}
                      onChange={(event) => setEnvDraft({ ...envDraft, key: event.target.value })}
                    />
                    <input
                      aria-label="Environment variable value"
                      placeholder="value, or pick a vault secret below"
                      value={envDraft.value}
                      onChange={(event) => setEnvDraft({ ...envDraft, value: event.target.value })}
                    />
                    <button className="btn btn-secondary btn-mini" type="submit" disabled={busy}>Set</button>
                  </form>
                  {vaultNames.length ? (
                    <div className="sfx-vault-picker">
                      <span className="sfx-hint">Use a vault secret:</span>
                      {vaultNames.map((name) => (
                        <button
                          key={name}
                          type="button"
                          className="sfx-chip"
                          title={`{{secret:${name}}}`}
                          onClick={() => setEnvDraft({ key: envDraft.key || name.toUpperCase(), value: `{{secret:${name}}}` })}
                        >{name}</button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {isOpen && tab === 'notes' ? (
                <div className="sfx-notes" data-surface="mcp-notes">
                  <textarea
                    aria-label="Custom instructions for this server"
                    placeholder="Custom instructions for this server…"
                    value={notesDraft}
                    onChange={(event) => setNotesDraft(event.target.value)}
                  />
                  <button type="button" className="btn btn-secondary btn-mini" disabled={busy} onClick={saveNotes}>
                    Save instructions
                  </button>
                  <p className="sfx-hint">
                    Kept with the server's configuration in your settings — notes for you, next to the server.
                  </p>
                </div>
              ) : null}

              <div className="sfx-card-actions">
                <button type="button" className="btn btn-secondary btn-mini" disabled={busy}
                  onClick={() => openEnvironment(row.name)}>
                  Authenticate
                </button>
                <button type="button" className="btn btn-secondary btn-mini" disabled={busy}
                  onClick={() => openNotes(row.name)}>
                  Instructions
                </button>
                <button type="button" className="btn btn-danger btn-mini" disabled={busy}
                  onClick={() => removeServer(row.name)}>
                  Remove
                </button>
              </div>
            </article>
          );
        })}

        <details className="sfx-section" data-surface="mcp-marketplace">
          <summary className="surface-label">Marketplace ({catalog.length})</summary>
          {catalog.length === 0 ? (
            <p className="sfx-hint">The catalogue has no MCP packages.</p>
          ) : catalog.map((pkg) => (
            <div key={pkg.id} className="sfx-row" data-package={pkg.id} data-installed={pkg.installed ? '1' : '0'}>
              <span className="sfx-title">{pkg.name}</span>
              <span className="sfx-mono sfx-muted">{pkg.id}</span>
              <span className="sfx-desc">{pkg.description}</span>
              {pkg.installed || installedIds.has(pkg.id) ? (
                <span className="sfx-tag" data-status="ready">installed</span>
              ) : (
                <button type="button" className="btn btn-secondary btn-mini" disabled={busy}
                  onClick={() => installPackage(pkg.id)}>
                  Install
                </button>
              )}
            </div>
          ))}
        </details>

        <details className="sfx-section" data-surface="mcp-add">
          <summary className="surface-label">Add a server by hand</summary>
          <form className="sfx-form" onSubmit={addServer}>
            <input
              aria-label="Server name"
              placeholder="name (e.g. my-tools)"
              value={newServer.name}
              onChange={(event) => setNewServer({ ...newServer, name: event.target.value })}
            />
            <input
              aria-label="Server command"
              placeholder="command (e.g. npx)"
              value={newServer.command}
              onChange={(event) => setNewServer({ ...newServer, command: event.target.value })}
            />
            <input
              aria-label="Server arguments"
              placeholder="arguments (e.g. -y my-mcp-server)"
              value={newServer.args}
              onChange={(event) => setNewServer({ ...newServer, args: event.target.value })}
            />
            <button className="btn btn-secondary btn-mini" type="submit" disabled={busy}>Add</button>
          </form>
          <p className="sfx-hint">
            The command runs on this machine with your account. Add an environment variable afterwards
            to point it at a vault secret.
          </p>
        </details>
      </div>
    </section>
  );
}

export default McpPanel;
