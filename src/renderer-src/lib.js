import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { transcriptItems } from './transcript.mjs';
import { renderMarkdown } from './markdown.js';

/** Bridge to the preload facade: window.quansiox.{api,events}. */
export const { api, events } = window.quansiox;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** "just now" / "5m" / "3h" / "4d" / "Oct 3" style relative time. */
export function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (diff < 45_000) return 'now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d`;
  return new Date(Number(ts)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ---------------- toast system ---------------- */
const toastListeners = new Set();
export function toast(message, kind = 'info', ms = 3200) {
  const t = { id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, message, kind };
  toastListeners.forEach((fn) => fn(t));
  if (ms > 0) setTimeout(() => toastListeners.forEach((fn) => fn({ ...t, close: true })), ms);
  return t.id;
}
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    const fn = (t) => {
      setToasts((prev) => (t.close ? prev.filter((x) => x.id !== t.id) : [...prev, t]));
    };
    toastListeners.add(fn);
    return () => toastListeners.delete(fn);
  }, []);
  return {
    toasts,
    dismiss: (id) => setToasts((prev) => prev.filter((t) => t.id !== id)),
  };
}

// rich markdown (code highlighting, tables, math, diagrams) is imported above
export { renderMarkdown };

/* ---------------- data hooks ---------------- */

export function useSessions() {
  const [sessions, setSessions] = useState([]);
  const refresh = useCallback(async () => {
    try {
      setSessions(await api.sessions.list());
    } catch {
      setSessions([]);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { sessions, refresh };
}

/**
 * Per-session avatars: fetch each session's stored avatar, generating a
 * deterministic one (initials SVG data-URL) the first time. Returns an
 * id → data-URL map for the session list.
 */
export function useSessionAvatars(sessions) {
  const [avatars, setAvatars] = useState({});
  const ensured = useRef(new Set());
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const s of sessions || []) {
        if (ensured.current.has(s.id)) continue;
        ensured.current.add(s.id);
        try {
          let av = await api.avatars.get({ sessionId: s.id });
          if (!av || !av.contentBase64) av = await api.avatars.generate({ sessionId: s.id, label: (s.title || s.id)[0] });
          if (!alive) return;
          if (av && av.contentBase64) {
            setAvatars((prev) => ({ ...prev, [s.id]: `data:${av.mime};base64,${av.contentBase64}` }));
          }
        } catch {
          /* avatar is decorative; ignore failures */
        }
      }
    })();
    return () => { alive = false; };
  }, [sessions]);
  return avatars;
}

export function useSettings() {
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    const load = () => api.settings.get().then(setSettings).catch(() => setSettings(null));
    load();
    window.addEventListener('quansiox-settings', load);
    return () => window.removeEventListener('quansiox-settings', load);
  }, []);
  return settings;
}

/** Prompt library (★ templates): list/save/remove via the prompts namespace. */
export function usePrompts() {
  const [prompts, setPrompts] = useState([]);
  const refresh = useCallback(async () => {
    try { setPrompts(await api.prompts.list()); } catch { setPrompts([]); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const save = useCallback(async (body, title) => {
    await api.prompts.save({ title, body });
    refresh();
  }, [refresh]);
  const remove = useCallback(async (id) => {
    await api.prompts.remove({ id });
    refresh();
  }, [refresh]);
  return { prompts, refresh, save, remove };
}

/** Workspace file tree with live updates (file:onChange). */
export function useFileTree(active) {
  const [root, setRoot] = useState('');
  const [entries, setEntries] = useState([]);
  const refresh = useCallback(async () => {
    try {
      const r = await api.file.tree();
      setRoot(r.root ?? '');
      setEntries(r.entries ?? []);
    } catch { /* tree unavailable */ }
  }, []);
  useEffect(() => {
    if (!active) return;
    refresh();
    api.file.watch().catch(() => {});
    const off = events.on('file', 'onChange', () => refresh());
    return off;
  }, [active, refresh]);
  return { root, entries, refresh };
}

/** Live PTY terminal session (create once, stream output, ^C support). */
export function useTerminal(active) {
  const [lines, setLines] = useState('');
  const started = useRef(false);
  const bufRef = useRef('');
  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    api.shellSession.create().catch(() => {});
    const off = events.on('shellSession', 'onOutput', (_sid, chunk) => {
      bufRef.current += chunk;
      setLines(bufRef.current.slice(-40_000));
    });
    return off;
  }, [active]);
  const write = useCallback((input) => api.shellSession.write({ input }).catch(() => {}), []);
  const control = useCallback((key) => api.shellSession.control({ key }).catch(() => {}), []);
  return { lines, write, control };
}

/** Git status for the workspace. */
export function useGit(active) {
  const [status, setStatus] = useState(null);
  const refresh = useCallback(async () => {
    try { setStatus(await api.git.status()); } catch { setStatus(null); }
  }, []);
  useEffect(() => { if (active) refresh(); }, [active, refresh]);
  return { status, refresh };
}

/** Central agent-session hook: transcript view + streaming events. */
export function useAgentSession(initialSessionId) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [items, setItems] = useState([]); // rendered items
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  useEffect(() => { runningRef.current = running; }, [running]);
  const [status, setStatus] = useState('ready');
  const [usage, setUsage] = useState(null);
  const [plan, setPlan] = useState(null);
  const rawRef = useRef(''); // live streaming text
  const [liveText, setLiveText] = useState(null); // null = not streaming
  const [subagents, setSubagents] = useState([]);
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const earlierOffsetRef = useRef(0);
  const [confirm, setConfirm] = useState(null); // pending approval { id, tool, args, cwd, timeoutMs }
  useEffect(() => {
    let current = true;
    api.tasks.list({ sessionId }).then((rows) => { if (current) setSubagents(rows); }).catch(() => {});
    return () => { current = false; };
  }, [sessionId]);

  const pushItems = useCallback((newItems) => {
    setItems((prev) => [...prev, ...newItems]);
  }, []);

  const PAGE = 80;
  const load = useCallback(async (id) => {
    setSessionId(id);
    setItems([]);
    setPlan(null);
    setLiveText(null);
    setSubagents([]);
    setHasMoreEarlier(false);
    earlierOffsetRef.current = 0;
    rawRef.current = '';
    try {
      // Tail page (not the whole transcript): long sessions cost O(page).
      const page = await api.sessions.transcript({ id, tail: true, limit: PAGE });
      const restored = transcriptItems(page.turns, page.offset ?? 0);
      setItems(restored.items);
      setPlan(page.plan?.length ? page.plan : restored.plan);
      setUsage(page.usage ?? null);
      earlierOffsetRef.current = page.offset ?? 0;
      setHasMoreEarlier(page.hasMore === true);
    } catch {
      /* new session */
    }
  }, []);

  /** Prepend the previous page of history (scroll-back without full reload). */
  const loadEarlier = useCallback(async () => {
    if (!hasMoreEarlier) return;
    const end = earlierOffsetRef.current;
    const start = Math.max(0, end - PAGE);
    try {
      const page = await api.sessions.transcript({ id: sessionId, offset: start, limit: end - start });
      const restored = transcriptItems(page.turns, page.offset ?? start);
      setItems((prev) => [...restored.items, ...prev]);
      earlierOffsetRef.current = page.offset ?? start;
      setHasMoreEarlier((page.offset ?? start) > 0);
    } catch { setHasMoreEarlier(false); }
  }, [hasMoreEarlier, sessionId]);

  /** Roll back the conversation to a message (truncates the durable session). */
  const rollback = useCallback(async (messageId) => {
    if (!messageId) return null;
    try {
      const result = await api.sessions.rollback({ id: sessionId, toMessageId: messageId });
      await load(sessionId);
      return result;
    } catch (error) {
      return { error: String(error.message ?? error) };
    }
  }, [sessionId, load]);

  // Streaming event wiring (guarded by sessionId).
  useEffect(() => {
    const offs = [];
    const mine = (sid) => sid === sessionId;
    offs.push(events.on('agent', 'onDelta', (sid, delta) => {
      if (!mine(sid)) return;
      rawRef.current += delta;
      setLiveText(rawRef.current);
    }));
    offs.push(events.on('agent', 'onToolCall', (sid, call) => {
      if (!mine(sid)) return;
      setLiveText((t) => {
        if (t !== null) setItems((prev) => [...prev, { kind: 'assistant', key: `a-live-${Date.now()}`, text: rawRef.current }]);
        rawRef.current = '';
        return null;
      });
      setItems((prev) => [...prev, { kind: 'tool', key: call.id, name: call.name, output: null, args: JSON.stringify(call.args) }]);
    }));
    offs.push(events.on('agent', 'onToolResult', (sid, result) => {
      if (!mine(sid)) return;
      setItems((prev) => prev.map((it) => (it.kind === 'tool' && it.key === result.id ? { ...it, output: result.output } : it)));
    }));
    offs.push(events.on('agent', 'onScreenshot', (sid, shot) => {
      if (!mine(sid)) return;
      setItems((prev) => prev.map((it) => (it.kind === 'tool' && it.key === shot.id ? { ...it, image: shot.dataUrl } : it)));
    }));
    offs.push(events.on('agent', 'onPlan', (sid, steps) => {
      if (!mine(sid)) return;
      setPlan(steps);
      setItems((prev) => [...prev, { kind: 'plan', key: `plan-${prev.length}`, steps }]);
    }));
    offs.push(events.on('agent', 'onUsage', (sid, totals) => {
      if (mine(sid)) setUsage(totals);
    }));
    // Run queue (docs: a message sent while the bot is working is answered
    // after the current turn): mark the bubble queued, flip it back on start.
    offs.push(events.on('agent', 'onQueued', (sid, info) => {
      if (!mine(sid) || !info?.messageId) return;
      setStatus('queued…');
      setItems((prev) => prev.map((it) => (
        it.messageId && it.messageId === info.messageId ? { ...it, queued: true, queuedPosition: info.position } : it
      )));
    }));
    offs.push(events.on('agent', 'onRunStart', (sid, info) => {
      if (!mine(sid) || !info?.messageId) return;
      setStatus('agent running…');
      setRunning(true);
      setItems((prev) => prev.map((it) => (
        it.messageId && it.messageId === info.messageId ? { ...it, queued: false } : it
      )));
    }));
    // Reactions sync across windows (docs: lightweight acknowledgement).
    offs.push(events.on('sessions', 'onReaction', (sid, info) => {
      if (!mine(sid) || !info?.messageId) return;
      setItems((prev) => prev.map((it) => (
        it.id && it.id === info.messageId ? { ...it, reactions: info.reactions ?? [] } : it
      )));
    }));
    offs.push(events.on('agent', 'onRetry', (sid, info) => {
      if (mine(sid)) setStatus(`provider ${info.status} — retrying (${info.attempt})…`);
    }));
    offs.push(events.on('agent', 'onCheckpoint', (sid, info) => {
      if (mine(sid)) setStatus(`checkpoint ${info.hash}`);
    }));
    offs.push(events.on('agent', 'onSubagent', (sid, row) => {
      if (!mine(sid) || !row) return;
      setSubagents((prev) => {
        const index = prev.findIndex((item) => item.id === row.id);
        if (index === -1) return [...prev, row];
        const next = prev.slice();
        next[index] = { ...next[index], ...row };
        return next;
      });
    }));
    offs.push(events.on('agent', 'onConfirm', (sid, payload) => {
      if (!mine(sid) || !payload) return;
      setConfirm(payload);
    }));
    offs.push(events.on('agent', 'onDone', (sid, summary) => {
      if (!mine(sid)) return;
      setConfirm(null);
      if (rawRef.current) {
        const text = rawRef.current;
        setItems((prev) => [...prev, { kind: 'assistant', key: `a-${prev.length}`, text, id: summary.assistantId ?? null, reactions: [] }]);
        rawRef.current = '';
      }
      setLiveText(null);
      setRunning(false);
      setStatus(
        summary.ok === true ? `finished in ${summary.steps} steps`
          : summary.ok === 'aborted' ? 'aborted'
            : `error: ${summary.error ?? 'failed'}`
      );
      if (summary.ok === true) toast(`Task finished (${summary.steps} steps)`, 'ok');
      else if (summary.ok !== 'aborted') toast(String(summary.error ?? 'task failed'), 'err');
    }));
    return () => offs.forEach((off) => off());
  }, [sessionId]);

  const send = useCallback(async (text, attachments, replyTo) => {
    if (!text.trim()) return;
    const messageId = crypto.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const queued = runningRef.current; // optimistic; main confirms via onQueued
    setItems((prev) => [...prev, { kind: 'user', key: `u-${prev.length}`, text, at: Date.now(), messageId, id: messageId, replyTo: replyTo ?? null, reactions: [], queued }]);
    setRunning(true);
    setStatus(queued ? 'queued…' : 'agent running…');
    try {
      await api.agent.run({ sessionId, message: text, attachments, messageId, replyTo: replyTo ?? undefined });
    } catch (error) {
      setItems((prev) => [...prev, { kind: 'error', key: `e-${prev.length}`, text: String(error.message ?? error) }]);
      setRunning(false);
      setStatus('failed');
    }
  }, [sessionId]);

  /** Redirect (docs): promote this queued message; the current turn aborts. */
  const steer = useCallback(async (messageId) => {
    if (!messageId) return null;
    setStatus('redirecting…');
    try {
      return await api.agent.steer({ sessionId, messageId });
    } catch (error) {
      setStatus(String(error.message ?? error));
      return null;
    }
  }, [sessionId]);

  /** Toggle a reaction on a message (optimistic; main broadcasts the truth). */
  const react = useCallback((messageId, emoji) => {
    if (!messageId) return;
    setItems((prev) => prev.map((it) => {
      if (!it.id || it.id !== messageId) return it;
      const current = Array.isArray(it.reactions) ? it.reactions : [];
      const next = current.includes(emoji) ? current.filter((e) => e !== emoji) : [...current, emoji];
      return { ...it, reactions: next };
    }));
    api.sessions.react({ id: sessionId, messageId, emoji }).catch(() => {});
  }, [sessionId]);

  const stop = useCallback(() => api.agent.abort({ sessionId }).catch(() => {}), [sessionId]);
  const retry = useCallback(async () => {
    setItems([]);
    setRunning(true);
    setStatus('retrying…');
    try {
      await api.agent.retry({ sessionId });
    } catch (error) {
      setRunning(false);
      setStatus(String(error.message ?? error));
    }
  }, [sessionId]);

  return {
    sessionId, setSessionId, items, liveText, running, status, usage, plan, send, stop, retry, load,
    loadEarlier, hasMoreEarlier, rollback, subagents, steer, react,
    computerActive: items.some((it) => it.kind === 'tool' && it.name?.startsWith('computer_') && it.output == null),
    confirm, setConfirm, answerConfirm: (approved, scope = 'once') => {
      if (confirm) {
        api.confirmations.respond({ id: confirm.id, approved: approved === true, scope })
          .catch(() => {});
      }
      setConfirm(null); // cleared either way; a new onConfirm re-arms the prompt
    },
  };
}

/* ---------------- attention states (docs: sidebar Needs attention / Unread
 * activity / working, dock badge, OS notifications when a Bot finishes or
 * needs input while the app is unfocused) ---------------- */

const UNREAD_KEY = 'qx-unread';

function loadUnread() {
  try {
    const rows = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? '[]');
    return new Set(Array.isArray(rows) ? rows.filter((id) => typeof id === 'string') : []);
  } catch { return new Set(); }
}

function storeUnread(set) {
  try { localStorage.setItem(UNREAD_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

export function useAttention(activeSessionId) {
  const [unread, setUnread] = useState(loadUnread);
  const [working, setWorking] = useState(() => new Set());
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  // Per-conversation notification mute (session.muted), synced from the
  // sessions list by the caller. Unread dots are unaffected.
  const mutedRef = useRef(new Set());
  const setMuted = useCallback((ids) => { mutedRef.current = new Set(ids ?? []); }, []);
  // Per-conversation notify-on-updates opt-out (P3.10, Grok's
  // setAgentNotifyOnUpdates): unread dots still accrue, but no OS
  // notification fires for opted-out sessions. Synced by the caller.
  const notifyOffRef = useRef(new Set());
  const setNotifyOff = useCallback((ids) => { notifyOffRef.current = new Set(ids ?? []); }, []);

  const markRead = useCallback((id) => {
    setUnread((prev) => {
      if (!id || !prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);
  const markUnread = useCallback((id) => {
    if (!id) return;
    setUnread((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  const markAllRead = useCallback(() => {
    setUnread((prev) => (prev.size ? new Set() : prev));
  }, []);

  // Persist unread + keep the dock badge in sync with the count.
  useEffect(() => {
    storeUnread(unread);
    api.system?.setBadge?.({ count: unread.size }).catch?.(() => {});
  }, [unread]);

  // Switching to (or focusing) a conversation marks its activity as read.
  useEffect(() => { markRead(activeSessionId); }, [activeSessionId, markRead]);
  useEffect(() => {
    const onFocus = () => markRead(activeRef.current);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [markRead]);

  // Global agent events: busy states for every session, unread + OS
  // notification when a turn finishes or needs input off-screen.
  useEffect(() => {
    const offs = [];
    const busy = (sid) => {
      setWorking((prev) => (prev.has(sid) ? prev : new Set(prev).add(sid)));
    };
    const idle = (sid) => {
      setWorking((prev) => {
        if (!prev.has(sid)) return prev;
        const next = new Set(prev);
        next.delete(sid);
        return next;
      });
    };
    const attention = (sid, body) => {
      if (!sid) return;
      const offscreen = sid !== activeRef.current || !document.hasFocus();
      if (!offscreen) return;
      markUnread(sid);
      if (!document.hasFocus() && !mutedRef.current.has(sid) && !notifyOffRef.current.has(sid)) {
        api.system?.notify?.({ title: 'Quansiox', body, sessionId: sid }).catch?.(() => {});
      }
    };
    offs.push(events.on('agent', 'onDelta', (sid) => busy(sid)));
    offs.push(events.on('agent', 'onToolCall', (sid) => busy(sid)));
    offs.push(events.on('agent', 'onRunStart', (sid) => busy(sid)));
    offs.push(events.on('agent', 'onDone', (sid, summary) => {
      idle(sid);
      const ok = summary?.ok;
      const body = ok === true ? `Task finished (${summary?.steps ?? '?'} steps)`
        : ok === 'aborted' ? 'Run aborted'
          : ok === 'max_steps' ? `Stopped after ${summary?.steps ?? '?'} steps`
            : `Run failed: ${String(summary?.error ?? 'error')}`;
      attention(sid, body);
    }));
    offs.push(events.on('agent', 'onConfirm', (sid) => {
      attention(sid, 'Waiting for your approval');
    }));
    return () => offs.forEach((off) => off());
  }, [markUnread]);

  return { unread, working, markRead, markUnread, markAllRead, setMuted, setNotifyOff };
}

/* ---- voice memos (bot messages read aloud via local TTS) ----
 * One shared Audio element; assistant messages (and voice mode) subscribe via
 * onVoiceMemo so exactly one memo plays at a time. */
let voiceMemoAudio = null;
let voiceMemoKey = null;
let voiceMemoState = 'idle'; // idle | loading | playing
const voiceMemoSubs = new Set();

function emitVoiceMemo() {
  const snapshot = { state: voiceMemoState, key: voiceMemoKey };
  for (const fn of voiceMemoSubs) {
    try { fn(snapshot); } catch { /* subscriber gone */ }
  }
}

export function onVoiceMemo(fn) {
  voiceMemoSubs.add(fn);
  fn({ state: voiceMemoState, key: voiceMemoKey });
  return () => voiceMemoSubs.delete(fn);
}

export function stopVoiceMemo() {
  if (voiceMemoAudio) {
    try { voiceMemoAudio.pause(); } catch { /* already stopped */ }
    voiceMemoAudio = null;
  }
  voiceMemoState = 'idle';
  voiceMemoKey = null;
  emitVoiceMemo();
}

export async function playVoiceMemo({ key, text, sessionId, onError }) {
  if (voiceMemoState !== 'idle' && voiceMemoKey === key) return stopVoiceMemo();
  stopVoiceMemo();
  voiceMemoKey = key ?? null;
  voiceMemoState = 'loading';
  emitVoiceMemo();
  try {
    const r = await api.voice.synthesize({ text, sessionId });
    if (voiceMemoState !== 'loading' || voiceMemoKey !== key) return undefined;
    const bytes = Uint8Array.from(atob(r.audioBase64 ?? ''), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: r.mimeType || 'audio/aiff' }));
    const audio = new Audio(url);
    voiceMemoAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (voiceMemoAudio === audio) {
        voiceMemoAudio = null;
        voiceMemoState = 'idle';
        voiceMemoKey = null;
        emitVoiceMemo();
      }
    };
    await audio.play();
    if (voiceMemoState !== 'loading' || voiceMemoKey !== key) {
      try { audio.pause(); } catch { /* mid-stop */ }
      URL.revokeObjectURL(url);
      return undefined;
    }
    voiceMemoState = 'playing';
    emitVoiceMemo();
    return r;
  } catch (error) {
    stopVoiceMemo();
    onError?.(error);
    return undefined;
  }
}
