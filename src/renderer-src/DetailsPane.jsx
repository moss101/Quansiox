import { useEffect, useState } from 'react';
import { api, toast } from './lib.js';
import { Icon } from './Icons.jsx';

/**
 * Conversation details drawer (docs: ⌘⇧I) — session metadata, activity
 * stats, token usage + cost estimate, per-conversation notifications, and the
 * bot voice (local `say` voices; dictation availability shown honestly).
 */
export function DetailsPane({ sessionId, muted, language, timezone, onToggleMuted, onClose, onChanged }) {
  const [session, setSession] = useState(null);
  const [stats, setStats] = useState(null);
  const [cost, setCost] = useState(null);
  const [error, setError] = useState(null);
  const [voiceInfo, setVoiceInfo] = useState(null);
  const [voices, setVoices] = useState([]);
  const [voiceId, setVoiceId] = useState('');
  const [voiceSpeed, setVoiceSpeed] = useState('1');

  useEffect(() => {
    if (!sessionId) return undefined;
    let alive = true;
    setSession(null); setStats(null); setCost(null); setError(null);
    Promise.all([
      api.sessions.get({ id: sessionId }),
      api.sessions.stats({ id: sessionId }).catch(() => null),
      api.sessions.cost({ id: sessionId }).catch(() => null),
    ]).then(([s, st, c]) => {
      if (!alive) return;
      setSession(s); setStats(st); setCost(c);
    }).catch((err) => { if (alive) setError(err.message ?? String(err)); });
    return () => { alive = false; };
  }, [sessionId]);

  // Voice: availability + installed system voices (local `say` only).
  useEffect(() => {
    let alive = true;
    api.voice.status().then((r) => { if (alive) setVoiceInfo(r); }).catch(() => {});
    api.voice.listVoices().then((list) => { if (alive) setVoices(Array.isArray(list) ? list : []); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!session) return;
    setVoiceId(session.voice?.voiceId ?? '');
    setVoiceSpeed(String(session.voice?.voiceSpeed ?? '1'));
  }, [session]);

  const saveVoice = (patch) => {
    api.voice.setAgentVoice({ id: sessionId, ...patch })
      .then(() => onChanged?.())
      .catch((err) => toast(err?.message ?? String(err), 'err'));
  };
  const previewVoice = () => {
    if (!voiceId) { toast('Pick a voice first', 'err'); return; }
    api.voice.preview({ voiceId, greeting: `Hi, I'm ${session?.title ?? 'Quansiox'}.` })
      .catch((err) => toast(err?.message ?? String(err), 'err'));
  };

  const fmtTime = (ts) => {
    if (!ts) return '—';
    try {
      return new Intl.DateTimeFormat(language || undefined, {
        dateStyle: 'medium', timeStyle: 'short',
        timeZone: timezone && timezone !== 'auto' ? timezone : undefined,
      }).format(new Date(Number(ts)));
    } catch { return new Date(Number(ts)).toLocaleString(); }
  };
  const usage = session?.usage ?? {};
  const fmtUsd = (v) => (v == null ? '—' : `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`);

  return (
    <aside className="details-drawer" data-surface="conversation-details" aria-label="Conversation details">
      <div className="details-head">
        <span className="details-title"><Icon.Info /> Conversation details</span>
        <button className="ibtn" title="Close (Esc)" aria-label="Close details" onClick={onClose}><Icon.X /></button>
      </div>
      <div className="details-body">
        {error && <div className="details-error">{error}</div>}
        {!session && !error && <div className="details-loading">loading…</div>}
        {session && (
          <>
            <section className="details-section">
              <div className="surface-label">Session</div>
              <div className="details-row"><span>Title</span><span className="ellipsis">{session.title ?? 'Untitled'}</span></div>
              {session.label ? <div className="details-row"><span>Label</span><span className="ellipsis">{session.label}</span></div> : null}
              {session.description ? <div className="details-row"><span>About</span><span className="ellipsis">{session.description}</span></div> : null}
              <div className="details-row"><span>ID</span><span className="mono ellipsis">{session.id}</span></div>
              <div className="details-row"><span>Created</span><span>{fmtTime(session.createdAt)}</span></div>
              <div className="details-row"><span>Updated</span><span>{fmtTime(session.updatedAt)}</span></div>
              <div className="details-row"><span>Model</span><span>{session.lastModel ?? '—'}</span></div>
            </section>

            <section className="details-section">
              <div className="surface-label">Activity</div>
              <div className="details-row"><span>Messages</span><span>{stats ? `${stats.userMessages ?? 0} from you · ${stats.assistantMessages ?? 0} from the bot` : '—'}</span></div>
              <div className="details-row"><span>Tool calls</span><span>{stats?.toolCalls ?? '—'}</span></div>
              {(stats?.filesTouched?.length ?? 0) > 0 && (
                <div className="details-row"><span>Files touched</span><span>{stats.filesTouched.length}</span></div>
              )}
              {!stats && <div className="details-row"><span>Activity</span><span>no transcript yet</span></div>}
            </section>

            <section className="details-section">
              <div className="surface-label">Usage</div>
              <div className="details-row"><span>Prompt tokens</span><span>{(usage.promptTokens ?? 0).toLocaleString()}</span></div>
              <div className="details-row"><span>Completion tokens</span><span>{(usage.completionTokens ?? 0).toLocaleString()}</span></div>
              <div className="details-row"><span>Requests</span><span>{usage.requests ?? 0}</span></div>
              <div className="details-row"><span>Estimated cost</span><span>{cost ? fmtUsd(cost.cost) : '—'}</span></div>
            </section>

            <section className="details-section">
              <div className="surface-label">Notifications</div>
              <label className="details-toggle">
                <input type="checkbox" checked={!muted}
                  onChange={() => onToggleMuted?.(sessionId, !muted)} />
                <span>Notify me when this conversation finishes in the background</span>
              </label>
            </section>

            <section className="details-section details-voice">
              <div className="surface-label">Voice</div>
              {voiceInfo && !voiceInfo.tts?.available ? (
                <div className="details-note">{voiceInfo.tts?.reason ?? 'local speech synthesis is unavailable'}</div>
              ) : (
                <>
                  <div className="details-row">
                    <span>Bot voice</span>
                    <select data-surface="voice-select" value={voiceId}
                      onChange={(e) => { setVoiceId(e.target.value); saveVoice({ voiceId: e.target.value || null }); }}>
                      <option value="">System default</option>
                      {voices.map((v) => <option key={v.id} value={v.id}>{v.id} ({v.locale})</option>)}
                    </select>
                  </div>
                  <div className="details-row">
                    <span>Speed</span>
                    <select data-surface="voice-speed" value={voiceSpeed}
                      onChange={(e) => { setVoiceSpeed(e.target.value); saveVoice({ voiceSpeed: Number(e.target.value) }); }}>
                      {['0.75', '1', '1.25', '1.5', '2'].map((s) => <option key={s} value={s}>{s}×</option>)}
                    </select>
                  </div>
                  <div className="details-row">
                    <span />
                    <button type="button" className="mini-btn" data-surface="voice-preview" onClick={previewVoice}>Preview voice</button>
                  </div>
                </>
              )}
              <div className="details-row">
                <span>Dictation</span>
                <span>{voiceInfo?.stt?.available ? 'local whisper.cpp' : (voiceInfo?.stt?.reason ?? '—')}</span>
              </div>
            </section>

            <section className="details-section details-actions">
              <button type="button" className="mini-btn" onClick={() => api.sessions.export({ id: sessionId }).then(onChanged).catch(() => {})}>
                Export conversation
              </button>
              <button type="button" className="mini-btn" onClick={() => api.sessions.duplicate({ id: sessionId }).then(onChanged).catch(() => {})}>
                Duplicate
              </button>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
