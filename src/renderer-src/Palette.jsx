import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { api, toast } from './lib.js';
import { TOOLS } from './tools.js';

/* Command palette (docs: "Press Cmd/Ctrl+K for the search palette... switch
 *  * between Bots and groups, find prior messages, files and routines, open
 *  * settings and common actions"). mode 'sessions' is the ⌘⇧F bots search.
 *
 *  Every registry in the app is reachable from here: sessions, agents,
 *  messages, files, links, routines, tools, skills, plugins, the settings
 *  surfaces and the actions. Every result carries the registry it came from
 *  (the source badge), so the list never looks like one flat pile. */

function score(q, text) {
  if (!q) return 1;
  const t = String(text).toLowerCase();
  const s = q.toLowerCase();
  if (t.startsWith(s)) return 3;
  if (t.includes(s)) return 2;
  let i = 0;
  for (const ch of s) {
    i = t.indexOf(ch, i);
    if (i === -1) return 0;
    i += 1;
  }
  return 1;
}

/** The best score of a result over all of its texts. */
function best(q, ...texts) {
  let top = 0;
  for (const text of texts) top = Math.max(top, score(q, text) || 0);
  return top;
}

/** Highlight the first case-insensitive match of q inside text. */
function Highlight({ text, q }) {
  const needle = String(q ?? '').trim();
  if (!needle) return <>{text}</>;
  const index = String(text).toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="palette-mark">{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

/** Scroll a surface into view and flash it — the "here it is" gesture. */
function reveal(selector) {
  const node = document.querySelector(selector);
  if (!node) return false;
  const details = node.closest?.('details');
  if (details) details.open = true;
  node.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1600);
  return true;
}

export default function Palette({
  mode = 'all', sessions, activeSessionId, avatars = {}, actions = [],
  messageResults = [], fileResults = [], linkResults = [], routineResults = [],
  searching = false, onQueryChange,
  onClose, onSelectSession, onSelectMessage, onSelectFile, onSelectLink, onSelectRoutine, onAction,
  onSelectAgent, onSelectTool, onSelectSkill, onSelectPlugin, onSelectSetting,
}) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // The registries the palette reaches beyond the session list. Every load
  // degrades to an empty list: the palette is still useful without them.
  const [registry, setRegistry] = useState({ agents: [], skills: [], plugins: [], mode: null, secrets: 0, matrix: {} });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [agents, skills, plugins, perm, secrets] = await Promise.all([
        api.agents.list().catch(() => []),
        api.skills.list().catch(() => []),
        api.marketplace.list().catch(() => []),
        api.permissions.state().catch(() => null),
        api.secrets.list().catch(() => []),
      ]);
      if (!alive) return;
      setRegistry({
        agents: Array.isArray(agents) ? agents : [],
        skills: Array.isArray(skills) ? skills : [],
        plugins: Array.isArray(plugins) ? plugins : [],
        mode: perm?.mode ?? null,
        secrets: Array.isArray(secrets) ? secrets.length : 0,
        matrix: perm?.matrix?.matrix?.tools ?? {},
      });
    };
    load();
    return () => { alive = false; };
  }, [tick]);

  const sessionItems = useMemo(() => {
    if (mode === 'actions') return [];
    return (sessions ?? [])
      .map((s) => ({ ...s, _score: Math.max(score(q, s.title ?? '') || 0, score(q, s.id) || 0) }))
      .filter((s) => s._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 8);
  }, [mode, q, sessions]);

  // The agents of this install (docs: switch between bots and groups).
  const agentItems = useMemo(() => {
    if (mode === 'sessions' || mode === 'actions') return [];
    return (registry.agents ?? [])
      .map((a) => ({ ...a, _score: best(q, a.name, a.description) }))
      .filter((a) => a._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 6);
  }, [mode, q, registry.agents]);

  // Cross-conversation message hits (docs: find prior messages + jump back).
  const messageItems = useMemo(() => {
    if (mode === 'sessions' || mode === 'actions') return [];
    return (messageResults ?? []).slice(0, 8);
  }, [mode, messageResults]);

  // Workspace files matching the query (docs: find files).
  const fileItems = useMemo(() => {
    if (mode === 'sessions' || mode === 'actions' || !q.trim()) return [];
    const needle = q.trim().toLowerCase();
    return (fileResults ?? [])
      .map((f) => ({ path: f, _score: score(needle, f) }))
      .filter((f) => f._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 6);
  }, [mode, q, fileResults]);

  // Prior links shared in conversations (docs: palette finds links too).
  const linkItems = useMemo(() => {
    if (mode === 'sessions' || mode === 'actions') return [];
    return (linkResults ?? []).slice(0, 6);
  }, [mode, linkResults]);

  // Routines / scheduled automations (docs: palette finds routines).
  const routineItems = useMemo(() => {
    if (mode === 'sessions' || mode === 'actions' || !q.trim()) return [];
    const needle = q.trim().toLowerCase();
    return (routineResults ?? [])
      .filter((r) => r.id !== 'none')
      .map((r) => ({ ...r, _score: score(needle, r.name ?? '') }))
      .filter((r) => r._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 6);
  }, [mode, q, routineResults]);

  // The tools the agent can call — with the level the matrix gives them.
  const toolItems = useMemo(() => {
    if (mode === 'sessions' || mode === 'actions' || !q.trim()) return [];
    const needle = q.trim().toLowerCase();
    return TOOLS
      .map((t) => ({ ...t, _score: score(needle, t.name) }))
      .filter((t) => t._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 8);
  }, [mode, q]);

  // The installed skills.
  const skillItems = useMemo(() => {
    if (mode === 'sessions' || mode === 'actions') return [];
    return (registry.skills ?? [])
      .map((s) => ({ ...s, _score: best(q, s.name, s.description) }))
      .filter((s) => s._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 6);
  }, [mode, q, registry.skills]);

  // The marketplace catalogue (skills + MCP servers).
  const pluginItems = useMemo(() => {
    if (mode === 'sessions' || mode === 'actions') return [];
    return (registry.plugins ?? [])
      .map((p) => ({ ...p, _score: best(q, p.name, p.description) }))
      .filter((p) => p._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 6);
  }, [mode, q, registry.plugins]);

  // The settings surfaces: the permission mode, the vault, the updates page.
  const settingItems = useMemo(() => {
    if (mode === 'sessions' || mode === 'actions') return [];
    const rows = [
      {
        id: 'permission-mode',
        title: 'Permission mode',
        hint: registry.mode ?? '—',
        _score: best(q, 'permission mode', 'permissions', 'mode'),
      },
      {
        id: 'vault',
        title: 'Secrets vault',
        hint: registry.secrets ? `${registry.secrets} secret${registry.secrets === 1 ? '' : 's'}` : 'empty',
        _score: best(q, 'secrets vault', 'vault', 'secrets'),
      },
      {
        id: 'updates',
        title: 'Updates',
        hint: 'check for a new version',
        _score: best(q, 'updates', 'update', 'version'),
      },
    ];
    return rows.filter((r) => r._score > 0).sort((a, b) => b._score - a._score);
  }, [mode, q, registry.mode, registry.secrets]);

  const actionItems = useMemo(() => {
    if (mode === 'sessions') return [];
    const rows = actions.map((a) => ({ ...a, _score: score(q, a.title) })).filter((a) => a._score > 0);
    if (q.trim() && mode === 'all') {
      rows.unshift({ id: 'find-session', title: `Find “${q.trim()}” in this session`, hint: '⌘F', extra: { q: q.trim() }, _score: 4 });
    }
    return rows.sort((a, b) => b._score - a._score).slice(0, 8);
  }, [mode, q, actions]);

  // Every result, grouped by the registry it came from. The order of the
  // groups is the order they are shown in, and the order of the items in a
  // group is the order they are ranked in.
  const groups = useMemo(() => ([
    { key: 'session', title: 'Sessions', items: sessionItems },
    { key: 'agent', title: 'Agents', items: agentItems },
    { key: 'message', title: 'Messages', items: messageItems },
    { key: 'file', title: 'Files', items: fileItems },
    { key: 'link', title: 'Links', items: linkItems },
    { key: 'routine', title: 'Routines', items: routineItems },
    { key: 'tool', title: 'Tools', items: toolItems },
    { key: 'skill', title: 'Skills', items: skillItems },
    { key: 'plugin', title: 'Plugins', items: pluginItems },
    { key: 'setting', title: 'Settings', items: settingItems },
    { key: 'action', title: 'Actions', items: actionItems },
  ]), [sessionItems, agentItems, messageItems, fileItems, linkItems, routineItems, toolItems, skillItems, pluginItems, settingItems, actionItems]);

  // The flat list the keyboard walks: one entry per result, in the order
  // the results are shown.
  const flat = useMemo(() => groups.flatMap((g) => g.items.map((item) => ({ kind: g.key, item }))), [groups]);

  useEffect(() => { setIdx(0); }, [q, messageItems.length, linkItems.length]);

  const openAgent = async (agent) => {
    if (onSelectAgent) { onSelectAgent(agent); return; }
    const sessionsOf = agent.sessionIds ?? [];
    const last = sessionsOf[sessionsOf.length - 1];
    if (last) { onSelectSession?.(last); return; }
    try {
      const created = await api.sessions.create({ title: agent.name ?? 'New bot' });
      await api.agents.attachSession({ agentId: agent.id, sessionId: created.id });
      onSelectSession?.(created.id);
    } catch (error) {
      toast(error?.message ?? String(error), 'err');
    }
  };

  const openTool = (tool) => {
    if (onSelectTool) { onSelectTool(tool); return; }
    if (!reveal(`.permission-row[data-tool="${tool.name}"]`)) {
      toast(`The ${tool.name} tool is not on screen — open Permissions`, 'warn');
    }
  };

  const toggleSkill = async (skill) => {
    if (onSelectSkill) { onSelectSkill(skill); return; }
    try {
      await api.skills.setEnabled({ id: skill.id, enabled: skill.enabled !== true });
      toast(`${skill.name} ${skill.enabled === true ? 'disabled' : 'enabled'}`, 'ok');
      setTick((t) => t + 1);
    } catch (error) {
      toast(error?.message ?? String(error), 'err');
    }
  };

  const togglePlugin = async (plugin) => {
    if (onSelectPlugin) { onSelectPlugin(plugin); return; }
    try {
      if (plugin.installed) {
        await api.marketplace.uninstall({ id: plugin.id });
        toast(`${plugin.name} removed`, 'ok');
      } else {
        await api.marketplace.install({ id: plugin.id });
        toast(`${plugin.name} installed`, 'ok');
      }
      setTick((t) => t + 1);
    } catch (error) {
      toast(error?.message ?? String(error), 'err');
    }
  };

  const openSetting = (setting) => {
    if (onSelectSetting) { onSelectSetting(setting); return; }
    if (setting.id === 'permission-mode') {
      if (!reveal('[data-surface="permissions-manager"]')) toast('Permissions are not on screen', 'warn');
      return;
    }
    if (setting.id === 'vault') {
      if (!reveal('[data-surface="secrets"]')) toast('The secrets vault is not on screen', 'warn');
      return;
    }
    window.quansioxUI?.openSettings?.('updates');
  };

  const run = (entry) => {
    if (!entry) return;
    const value = entry.item;
    if (entry.kind === 'session') onSelectSession?.(value.id);
    else if (entry.kind === 'message') onSelectMessage?.(value);
    else if (entry.kind === 'file') onSelectFile?.(value.path);
    else if (entry.kind === 'link') onSelectLink?.(value.url, value);
    else if (entry.kind === 'routine') onSelectRoutine?.(value);
    else if (entry.kind === 'action') onAction?.(value.id, value.extra);
    else if (entry.kind === 'agent') openAgent(value);
    else if (entry.kind === 'tool') openTool(value);
    else if (entry.kind === 'skill') toggleSkill(value);
    else if (entry.kind === 'plugin') togglePlugin(value);
    else if (entry.kind === 'setting') openSetting(value);
    onClose?.();
  };

  const onKeyDown = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); onClose?.(); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setIdx((i) => (flat.length ? (i + 1) % flat.length : 0)); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); setIdx((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); run(flat[idx]); }
  };

  let flatIndex = -1;
  return (
    <div className="palette-overlay" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon.Search />
          <input ref={inputRef} value={q}
            onChange={(e) => { setQ(e.target.value); onQueryChange?.(e.target.value); }}
            onKeyDown={onKeyDown}
            placeholder={mode === 'sessions' ? 'Search sessions…' : 'Search sessions, agents, tools, skills, actions…'}
            aria-label="Search sessions, agents, tools, skills and actions" />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" role="listbox" aria-label="Results">
          {groups.map((group) => (group.items.length > 0 ? (
            <div className="palette-group-block" key={group.key} role="group" aria-label={group.title}>
              <div className="palette-group">{group.title}</div>
              {group.items.map((item, n) => {
                flatIndex += 1;
                const i = flatIndex;
                const select = () => run({ kind: group.key, item });
                if (group.key === 'message') {
                  const m = item;
                  return (
                    <button key={`m-${m.sessionId}-${m.messageId ?? n}`} type="button" role="option" aria-selected={i === idx}
                      className={`palette-row palette-msg${i === idx ? ' active' : ''}`}
                      data-surface="palette-message"
                      data-message-id={m.messageId ?? undefined}
                      data-session-id={m.sessionId}
                      onMouseEnter={() => setIdx(i)} onClick={select}>
                      <span className="palette-icon">{m.role === 'assistant' ? <Icon.Sparkle /> : <Icon.Search />}</span>
                      <span className="palette-msg-main">
                        <span className="palette-msg-snippet"><Highlight text={m.snippet} q={q} /></span>
                        <span className="palette-msg-meta">{m.title}</span>
                      </span>
                      <span className="palette-badge" data-source="message">message</span>
                      <span className="palette-hint">{m.sessionId === activeSessionId ? 'here' : ''}</span>
                    </button>
                  );
                }
                if (group.key === 'link') {
                  const l = item;
                  return (
                    <button key={`l-${l.url}-${n}`} type="button" role="option" aria-selected={i === idx}
                      className={`palette-row palette-msg${i === idx ? ' active' : ''}`}
                      data-surface="palette-link" data-url={l.url} data-session-id={l.sessionId}
                      onMouseEnter={() => setIdx(i)} onClick={select}>
                      <span className="palette-icon"><Icon.Link /></span>
                      <span className="palette-msg-main">
                        <span className="palette-msg-snippet mono"><Highlight text={l.url} q={q} /></span>
                        <span className="palette-msg-meta">{l.title}</span>
                      </span>
                      <span className="palette-badge" data-source="link">link</span>
                    </button>
                  );
                }
                if (group.key === 'session') {
                  const s = item;
                  return (
                    <button key={`s-${s.id}`} type="button" role="option" aria-selected={i === idx}
                      className={`palette-row${i === idx ? ' active' : ''}${s.id === activeSessionId ? ' current' : ''}`}
                      onMouseEnter={() => setIdx(i)} onClick={select}>
                      {avatars[s.id]
                        ? <img className="palette-avatar" alt="" src={avatars[s.id]} width="20" height="20" />
                        : <span className="palette-avatar palette-avatar-fallback" aria-hidden="true">Q</span>}
                      <span className="palette-title">{s.title || 'New session'}</span>
                      <span className="palette-badge" data-source="session">session</span>
                      <span className="palette-hint">{s.id === activeSessionId ? 'current' : ''}</span>
                    </button>
                  );
                }
                if (group.key === 'routine') {
                  const r = item;
                  return (
                    <button key={`r-${r.id}-${n}`} type="button" role="option" aria-selected={i === idx}
                      className={`palette-row${i === idx ? ' active' : ''}`}
                      data-surface="palette-routine" data-routine={r.id}
                      onMouseEnter={() => setIdx(i)} onClick={select}>
                      <span className="palette-icon"><Icon.Clock /></span>
                      <span className="palette-title"><Highlight text={r.name ?? ''} q={q} /></span>
                      <span className="palette-badge" data-source="routine">routine</span>
                      <span className="palette-hint">{r.enabled ? (r.lastStatus ?? r.kind) : 'off'}</span>
                    </button>
                  );
                }
                if (group.key === 'file') {
                  const f = item;
                  return (
                    <button key={`f-${f.path}-${n}`} type="button" role="option" aria-selected={i === idx}
                      className={`palette-row${i === idx ? ' active' : ''}`}
                      onMouseEnter={() => setIdx(i)} onClick={select}>
                      <span className="palette-icon"><Icon.File /></span>
                      <span className="palette-title mono"><Highlight text={f.path} q={q} /></span>
                      <span className="palette-badge" data-source="file">file</span>
                    </button>
                  );
                }
                if (group.key === 'agent') {
                  const a = item;
                  return (
                    <button key={`ag-${a.id}`} type="button" role="option" aria-selected={i === idx}
                      className={`palette-row${i === idx ? ' active' : ''}`}
                      data-surface="palette-agent" data-agent={a.id}
                      onMouseEnter={() => setIdx(i)} onClick={select}>
                      <span className="palette-icon"><Icon.Sparkle /></span>
                      <span className="palette-title"><Highlight text={a.name ?? ''} q={q} /></span>
                      <span className="palette-badge" data-source="agent">agent</span>
                      <span className="palette-hint">{a.primary ? 'primary' : (a.scope ?? 'agent')}</span>
                    </button>
                  );
                }
                if (group.key === 'tool') {
                  const t = item;
                  const level = registry.matrix?.[t.name];
                  return (
                    <button key={`t-${t.name}`} type="button" role="option" aria-selected={i === idx}
                      className={`palette-row${i === idx ? ' active' : ''}`}
                      data-surface="palette-tool" data-tool={t.name}
                      onMouseEnter={() => setIdx(i)} onClick={select}>
                      <span className="palette-icon"><Icon.Zap /></span>
                      <span className="palette-title mono"><Highlight text={t.name} q={q} /></span>
                      <span className="palette-badge" data-source="tool">tool</span>
                      <span className="palette-hint">{level ?? t.group}</span>
                    </button>
                  );
                }
                if (group.key === 'skill') {
                  const s = item;
                  return (
                    <button key={`sk-${s.id}`} type="button" role="option" aria-selected={i === idx}
                      className={`palette-row${i === idx ? ' active' : ''}`}
                      data-surface="palette-skill" data-skill={s.id}
                      onMouseEnter={() => setIdx(i)} onClick={select}>
                      <span className="palette-icon"><Icon.ListChecks /></span>
                      <span className="palette-title"><Highlight text={s.name ?? ''} q={q} /></span>
                      <span className="palette-badge" data-source="skill">skill</span>
                      <span className="palette-hint">{s.enabled === true ? 'on · enter disables' : 'off · enter enables'}</span>
                    </button>
                  );
                }
                if (group.key === 'plugin') {
                  const p = item;
                  return (
                    <button key={`p-${p.id}`} type="button" role="option" aria-selected={i === idx}
                      className={`palette-row${i === idx ? ' active' : ''}`}
                      data-surface="palette-plugin" data-plugin={p.id}
                      onMouseEnter={() => setIdx(i)} onClick={select}>
                      <span className="palette-icon"><Icon.Globe /></span>
                      <span className="palette-title"><Highlight text={p.name ?? ''} q={q} /></span>
                      <span className="palette-badge" data-source="plugin">plugin</span>
                      <span className="palette-hint">{p.installed ? 'installed · enter removes' : (p.kind ?? 'plugin')}</span>
                    </button>
                  );
                }
                if (group.key === 'setting') {
                  const st = item;
                  return (
                    <button key={`st-${st.id}`} type="button" role="option" aria-selected={i === idx}
                      className={`palette-row${i === idx ? ' active' : ''}`}
                      data-surface="palette-setting" data-setting={st.id}
                      onMouseEnter={() => setIdx(i)} onClick={select}>
                      <span className="palette-icon"><Icon.Settings /></span>
                      <span className="palette-title"><Highlight text={st.title} q={q} /></span>
                      <span className="palette-badge" data-source="setting">setting</span>
                      <span className="palette-hint">{st.hint}</span>
                    </button>
                  );
                }
                const a = item;
                return (
                  <button key={`a-${a.id}-${a.extra?.q ?? ''}`} type="button" role="option" aria-selected={i === idx}
                    className={`palette-row${i === idx ? ' active' : ''}`}
                    onMouseEnter={() => setIdx(i)} onClick={select}>
                    <span className="palette-icon">{a.icon ?? null}</span>
                    <span className="palette-title">{a.title}</span>
                    <span className="palette-badge" data-source="action">action</span>
                    {a.hint ? <span className="palette-hint">{a.hint}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null))}
          {flat.length === 0 && <div className="palette-empty">{searching ? 'Searching…' : 'No matches'}</div>}
        </div>
      </div>
    </div>
  );
}
