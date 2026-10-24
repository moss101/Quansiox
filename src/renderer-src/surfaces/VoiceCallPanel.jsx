import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * The voice-call surface.
 *
 * A call is a real conversation: it has a credential, a presence, a nudge
 * (the "mm-hm" that makes the other side speak again), a transcript of what
 * was said, and an end. The transcript matters more than the call: it is what
 * the agent reads afterwards, and what the user re-reads.
 */
export function VoiceCallPanel({ onToast, sessionId = null }) {
  const [calls, setCalls] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await api.voiceCall.list();
      setCalls(list ?? []);
      if (selected) {
        const one = await api.voiceCall.get({ callId: selected });
        setDetail(one ?? null);
        const said = await api.voiceCall.sentMessages({ callId: selected });
        setMessages(said ?? []);
      }
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    }
  }, [selected]);

  useEffect(() => { refresh(); }, [refresh]);

  const start = async () => {
    setBusy(true);
    try {
      const credential = await api.voiceCall.mint({ ttlMs: 120_000 });
      const call = await api.voiceCall.start({ sessionId, credential, title: 'Voice call' });
      onToast?.('Call started', 'ok');
      await refresh();
      if (call?.id) setSelected(call.id);
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.voiceCall.end({ callId: selected });
      onToast?.('Call ended', 'ok');
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const nudge = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.voiceCall.nudge({ callId: selected });
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="voice-call-panel" data-surface="voice-call-panel" aria-label="Voice calls">
      <header className="voice-call-panel-head">
        <span className="surface-label">Voice calls</span>
        <div className="voice-call-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={start}>Start a call</button>
          {selected ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={nudge}>Nudge</button> : null}
          {selected ? <button type="button" className="btn btn-danger" disabled={busy} onClick={end}>End</button> : null}
        </div>
      </header>

      {error ? <p className="voice-call-error" role="alert">{error}</p> : null}
      {!calls.length && !error ? <p className="voice-call-empty">No calls yet.</p> : null}

      {calls.length ? (
        <div className="voice-call-list" role="listbox" aria-label="Calls">
          {calls.map((call) => (
            <button
              key={call.id}
              type="button"
              role="option"
              aria-selected={call.id === selected}
              className={`voice-call-row${call.id === selected ? ' is-active' : ''}`}
              data-call={call.id}
              onClick={() => setSelected(call.id)}
            >
              <Icon.Command />
              <span className="voice-call-title">{call.title ?? call.id}</span>
              <span className="voice-call-state">{call.state ?? call.status ?? 'unknown'}</span>
            </button>
          ))}
        </div>
      ) : null}

      {selected ? (
        <div className="voice-call-transcript" data-surface="voice-call-transcript">
          {detail?.state ? <p className="voice-call-detail">state: {detail.state}</p> : null}
          {messages.length ? messages.map((message, index) => (
            <p key={index} className={`voice-call-message from-${message.from ?? 'unknown'}`}>
              <strong>{message.from ?? 'unknown'}</strong> {message.text}
            </p>
          )) : <p className="voice-call-empty">Nothing was said yet.</p>}
        </div>
      ) : null}
    </section>
  );
}

export default VoiceCallPanel;
