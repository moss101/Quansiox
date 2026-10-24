import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, toast } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * PluginsPanel — the catalogue and the installed plugin surface.
 *
 * Three kinds of thing can be installed:
 *
 *   - a **skill** — instructions the model follows (a local catalogue);
 *   - an **mcp** server — external tools, installed as a server config;
 *   - an **addon** — a signed bundle that contributes skills and MCP servers,
 *     installed from a folder on this machine.
 *
 * The panel also owns the per-agent bindings: which MCP server an agent may
 * reach, and which variables that server is given.
 *
 * Props:
 *   - active?: boolean — when false the panel stops polling (default true).
 *   - agentId?: string — the agent whose plugin bindings are shown. When it
 *     is not given the panel lets the user pick one.
 *   - onToast?: (message: string, kind?: 'ok' | 'err' | 'warn' | 'info') => void
 *     — the notification sink. Falls back to the global toast in lib.js.
 */

const KINDS = [
  { id: 'all', label: 'all' },
  { id: 'skill', label: 'skill' },
  { id: 'mcp', label: 'mcp' },
  { id: 'addon', label: 'addon' },
];

export function PluginsPanel({ active = true, agentId: agentIdProp, onToast }) {
  const notify = useCallback((message, kind = 'info') => {
    if (onToast) onToast(message, kind);
    else toast(message, kind);
  }, [onToast]);

  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [skills, setSkills] = useState([]);
  const [addons, setAddons] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [agents, setAgents] = useState([]);
  const [agentId, setAgentId] = useState(agentIdProp ?? '');
  const [bindings, setBindings] = useState([]);
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (agentIdProp) setAgentId(agentIdProp);
  }, [agentIdProp]);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const catalogueKind = kind === 'addon' ? '' : kind === 'all' ? '' : kind;
      const [packages, skillRows, addonRows, addonPolicy, agentRows, settings] = await Promise.all([
        api.marketplace.list({ kind: catalogueKind, query: query.trim() || undefined }),
        api.skills.list(),
        api.addons.list(),
        api.addons.policy(),
        api.agents.list(),
        api.settings.get(),
      ]);
      setCatalog(Array.isArray(packages) ? packages : []);
      setSkills(Array.isArray(skillRows) ? skillRows : []);
      setAddons(Array.isArray(addonRows) ? addonRows : []);
      setPolicy(addonPolicy ?? null);
      setAgents(Array.isArray(agentRows) ? agentRows : []);
      setServers(Array.isArray(settings?.mcpServers) ? settings.mcpServers : []);
      if (!agentIdProp && !agentId && agentRows?.length) setAgentId(agentRows[0].id);
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    } finally {
      setLoading(false);
    }
  }, [kind, query, agentId, agentIdProp]);

  useEffect(() => {
    if (!active) return undefined;
    refresh();
    const timer = setInterval(refresh, 8000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const refreshBindings = useCallback(async () => {
    if (!agentId) { setBindings([]); return; }
    try {
      const result = await api.agentPlugins.get({ agentId });
      setBindings(Array.isArray(result?.plugins) ? result.plugins : []);
    } catch (failure) {
      setBindings([]);
      setError(failure?.message ?? String(failure));
    }
  }, [agentId]);

  useEffect(() => {
    refreshBindings();
  }, [refreshBindings]);

  const install = async (id) => {
    setBusy(true);
    try {
      await api.marketplace.install({ id });
      await refresh();
      notify(`${id} installed`, 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async (id) => {
    setBusy(true);
    try {
      await api.marketplace.uninstall({ id });
      await refresh();
      notify(`${id} removed`, 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const toggleSkill = async (skill) => {
    setBusy(true);
    try {
      await api.skills.setEnabled({ id: skill.id, enabled: !skill.enabled });
      await refresh();
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const removeSkill = async (id) => {
    setBusy(true);
    try {
      await api.skills.uninstall({ id });
      await refresh();
      notify(`${id} removed`, 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const toggleAddon = async (addon) => {
    setBusy(true);
    try {
      await (addon.enabled ? api.addons.disable({ id: addon.id }) : api.addons.enable({ id: addon.id }));
      await refresh();
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const removeAddon = async (id) => {
    setBusy(true);
    try {
      await api.addons.uninstall({ id });
      await refresh();
      notify(`${id} removed`, 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const installAddon = async () => {
    setBusy(true);
    try {
      const installed = await api.addons.install();
      if (installed) {
        notify(`Installed ${installed.name}`, 'ok');
        await refresh();
      }
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const verifyAddon = async (id) => {
    setBusy(true);
    try {
      const verdict = await api.addons.verify({ id });
      if (verdict?.ok) notify(`${id} is signed by a trusted publisher`, 'ok');
      else notify(verdict?.reason || 'The signature did not verify', 'warn');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const setRequireSignature = async (requireSignature) => {
    setBusy(true);
    try {
      const next = await api.addons.setPolicy({ requireSignature });
      setPolicy(next ?? null);
      notify(requireSignature ? 'Signed addons only' : 'Unsigned addons are allowed again', 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const setPluginList = async (plugins) => {
    if (!agentId) return;
    setBusy(true);
    try {
      const result = await api.agentPlugins.set({ agentId, plugins });
      setBindings(Array.isArray(result?.plugins) ? result.plugins : []);
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const bindPlugin = async (pluginId) => {
    if (bindings.some((binding) => binding.pluginId === pluginId)) return;
    await setPluginList([...bindings, { kind: 'plugin', pluginId, name: pluginId }]);
  };

  const unbindPlugin = async (binding) => {
    await setPluginList(bindings.filter((item) => item !== binding));
  };

  const boundIds = useMemo(() => new Set(bindings.map((b) => b.pluginId).filter(Boolean)), [bindings]);
  const bindable = useMemo(() => {
    const rows = servers.map((server) => ({ id: server.name, installed: true }));
    for (const pkg of catalog) {
      if (pkg.kind !== 'mcp') continue;
      if (!rows.some((row) => row.id === pkg.id)) rows.push({ id: pkg.id, installed: Boolean(pkg.installed) });
    }
    return rows;
  }, [servers, catalog]);

  const showCatalogue = kind === 'all' || kind === 'skill' || kind === 'mcp';
  const showSkills = kind === 'all' || kind === 'skill';
  const showServers = kind === 'all' || kind === 'mcp';
  const showAddons = kind === 'all' || kind === 'addon';

  return (
    <section className="sfx-panel" data-surface="plugins">
      <header className="sfx-head">
        <span className="surface-label">Plugins</span>
        <div className="sfx-head-actions">
          <button type="button" className="ibtn" title="Refresh" disabled={busy} onClick={refresh}>
            <Icon.Refresh />
          </button>
        </div>
      </header>

      <div className="sfx-body">
        {error ? (
          <div className="sfx-error" data-surface="plugins-error">
            <Icon.Info />
            <span>{error}</span>
            <button type="button" className="btn btn-secondary btn-mini" onClick={refresh}>Retry</button>
          </div>
        ) : null}

        <div className="sfx-filters" data-surface="plugins-filter">
          {KINDS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`sfx-chip${kind === option.id ? ' is-active' : ''}`}
              aria-pressed={kind === option.id}
              onClick={() => setKind(option.id)}
            >{option.label}</button>
          ))}
          <input
            aria-label="Search the catalogue"
            placeholder="search…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {loading && catalog.length === 0 && skills.length === 0 && addons.length === 0 ? (
          <div className="sfx-loading">Loading the plugins…</div>
        ) : null}

        {showCatalogue ? (
          <details className="sfx-section" data-surface="plugins-catalogue" open>
            <summary className="surface-label">Marketplace ({catalog.length})</summary>
            {catalog.length === 0 ? (
              <p className="sfx-hint">Nothing in the catalogue matches this filter.</p>
            ) : catalog.map((pkg) => (
              <div key={pkg.id} className="sfx-row" data-package={pkg.id} data-kind={pkg.kind}>
                <span className="sfx-title">{pkg.name}</span>
                <span className="sfx-tag">{pkg.kind}</span>
                <span className="sfx-desc">{pkg.description}</span>
                {pkg.installed ? (
                  <button type="button" className="btn btn-secondary btn-mini" disabled={busy}
                    onClick={() => uninstall(pkg.id)}>
                    Uninstall
                  </button>
                ) : (
                  <button type="button" className="btn btn-secondary btn-mini" disabled={busy}
                    onClick={() => install(pkg.id)}>
                    Install
                  </button>
                )}
              </div>
            ))}
          </details>
        ) : null}

        {showSkills ? (
          <details className="sfx-section" data-surface="plugins-skills" open>
            <summary className="surface-label">Installed skills ({skills.length})</summary>
            {skills.length === 0 ? (
              <p className="sfx-hint">No skills installed — pick one from the marketplace above.</p>
            ) : skills.map((skill) => (
              <div key={skill.id} className="sfx-row" data-skill={skill.id} data-enabled={skill.enabled ? '1' : '0'}>
                <span className="sfx-title">{skill.name}</span>
                <span className="sfx-desc">{skill.description}</span>
                <span className="sfx-tag">{skill.enabled ? 'on' : 'off'}</span>
                <button type="button" className="ibtn" title={skill.enabled ? 'Disable' : 'Enable'} disabled={busy}
                  onClick={() => toggleSkill(skill)}>
                  {skill.enabled ? <Icon.Pause /> : <Icon.Play />}
                </button>
                <button type="button" className="ibtn danger" title="Uninstall" disabled={busy}
                  onClick={() => removeSkill(skill.id)}>
                  <Icon.Trash />
                </button>
              </div>
            ))}
          </details>
        ) : null}

        {showServers ? (
          <details className="sfx-section" data-surface="plugins-servers" open>
            <summary className="surface-label">Installed MCP servers ({servers.length})</summary>
            {servers.length === 0 ? (
              <p className="sfx-hint">No MCP servers installed.</p>
            ) : servers.map((server) => (
              <div key={server.name} className="sfx-row" data-server={server.name}>
                <span className="sfx-title">{server.name}</span>
                <span className="sfx-mono sfx-muted">{server.command}</span>
              </div>
            ))}
          </details>
        ) : null}

        {showAddons ? (
          <details className="sfx-section" data-surface="plugins-addons" open={kind === 'addon'}>
            <summary className="surface-label">Addons ({addons.length})</summary>
            {addons.length === 0 ? (
              <p className="sfx-hint">No addons installed — install one from a folder on this machine.</p>
            ) : addons.map((addon) => (
              <div key={addon.id} className="sfx-row" data-addon={addon.id} data-enabled={addon.enabled ? '1' : '0'}>
                <span className="sfx-title">{addon.name}</span>
                <span className="sfx-tag">v{addon.version}</span>
                <span className="sfx-tag" data-status={addon.trust === 'verified' ? 'ready' : 'idle'}>{addon.trust}</span>
                <span className="sfx-desc">{addon.description || `${addon.skills} skills · ${addon.mcpServers} MCP`}</span>
                <button type="button" className="ibtn" title={addon.enabled ? 'Disable' : 'Enable'} disabled={busy}
                  onClick={() => toggleAddon(addon)}>
                  {addon.enabled ? <Icon.Pause /> : <Icon.Play />}
                </button>
                <button type="button" className="ibtn" title="Verify the signature" disabled={busy}
                  onClick={() => verifyAddon(addon.id)}>
                  <Icon.Check />
                </button>
                <button type="button" className="ibtn danger" title="Uninstall" disabled={busy}
                  onClick={() => removeAddon(addon.id)}>
                  <Icon.Trash />
                </button>
              </div>
            ))}
            <div className="sfx-card-actions">
              <button type="button" className="btn btn-secondary btn-mini" disabled={busy} onClick={installAddon}>
                Install addon folder…
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-mini"
                disabled={busy || !policy}
                onClick={() => setRequireSignature(!policy?.requireSignature)}
              >
                {policy?.requireSignature ? 'Allow unsigned addons' : 'Require a signature'}
              </button>
            </div>
          </details>
        ) : null}

        <details className="sfx-section" data-surface="plugins-bindings" open>
          <summary className="surface-label">Per-agent bindings</summary>
          {agents.length ? (
            <div className="sfx-row">
              <span className="sfx-title">Agent</span>
              <select
                aria-label="Agent"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <p className="sfx-hint">No agents yet — create one to bind a plugin to it.</p>
          )}
          {!agentId ? (
            <p className="sfx-hint">Pick an agent to see its plugin bindings.</p>
          ) : (
            <>
              {bindings.length === 0 ? (
                <p className="sfx-hint">This agent has no plugins bound.</p>
              ) : bindings.map((binding) => (
                <div key={binding.pluginId ?? binding.name} className="sfx-row" data-binding={binding.pluginId ?? binding.name}>
                  <span className="sfx-title">{binding.displayName || binding.name}</span>
                  <span className="sfx-tag">{binding.kind}</span>
                  <span className="sfx-tag" data-status={binding.installed ? 'ready' : 'idle'}>
                    {binding.installed ? 'installed' : 'not installed'}
                  </span>
                  {Object.keys(binding.variables ?? {}).length ? (
                    <span className="sfx-mono sfx-muted">{Object.keys(binding.variables).join(', ')}</span>
                  ) : null}
                  <button type="button" className="ibtn danger" title="Unbind" disabled={busy}
                    onClick={() => unbindPlugin(binding)}>
                    <Icon.X />
                  </button>
                </div>
              ))}
              <div className="sfx-list" data-surface="plugins-bindable">
                {bindable.length === 0 ? (
                  <p className="sfx-hint">Install an MCP server to bind it to an agent.</p>
                ) : bindable.map((row) => (
                  <div key={row.id} className="sfx-row" data-bindable={row.id}>
                    <span className="sfx-title">{row.id}</span>
                    <span className="sfx-tag" data-status={row.installed ? 'ready' : 'idle'}>
                      {row.installed ? 'installed' : 'catalogue'}
                    </span>
                    <button type="button" className="btn btn-secondary btn-mini" disabled={busy || boundIds.has(row.id)}
                      onClick={() => bindPlugin(row.id)}>
                      Bind
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </details>
      </div>
    </section>
  );
}

export default PluginsPanel;
