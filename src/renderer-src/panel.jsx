import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Floating companion panel (the desktop "pet").
 *
 * A frameless, transparent, always-on-top window that floats above every
 * other application, so the user can talk to the agent without leaving the
 * app they are working in. It shows:
 *   - the mounted agent's mark and name
 *   - a one-line prompt box (Enter sends)
 *   - the agent's quick choices
 *   - a status line (working / idle)
 *
 * The panel is a *view* of `panelService` state in the main process; every
 * mutation goes back over the `panel` IPC namespace.
 */

const { api, events } = window.quansiox;

function Panel() {
  const [state, setState] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const refresh = useCallback(() => {
    api.panel?.state?.().then((s) => setState(s)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // The main process pushes state changes (choices, status, mount).
    const off = window.addEventListener('message', (ev) => {
      const data = ev?.data;
      if (data && typeof data === 'object' && data.type === 'panel:state') setState(data.state ?? data);
    });
    const offEvents = events?.on?.('panel', 'onStatus', () => refresh());
    return () => { off?.(); offEvents?.(); };
  }, [refresh]);

  const send = useCallback(async () => {
    const prompt = text.trim();
    if (!prompt) return;
    setBusy(true);
    try {
      await api.panel.submit({ prompt });
      setText('');
    } catch (error) {
      console.error('[panel] submit failed', error);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [text]);

  const pick = useCallback(async (value) => {
    setBusy(true);
    try {
      await api.panel.submit({ prompt: value });
    } catch (error) {
      console.error('[panel] choice failed', error);
    } finally {
      setBusy(false);
    }
  }, []);

  const agent = state?.agent ?? null;
  const choices = state?.choices ?? [];
  const status = state?.agentStatus ?? 'idle';

  return (
    <div className="qx-panel" data-surface="desktop-panel" data-status={status}>
      <header className="qx-panel-head">
        {agent?.markSvgDataUrl
          ? <img className="qx-panel-mark" src={agent.markSvgDataUrl} alt="" />
          : <span className="qx-panel-mark qx-panel-mark-fallback">Q</span>}
        <span className="qx-panel-name">{agent?.name ?? 'Quansiox'}</span>
        <span className={`qx-panel-status qx-panel-status-${status}`}>
          {status === 'working' ? 'working…' : status}
        </span>
      </header>

      {choices.length > 0 && (
        <div className="qx-panel-choices" role="menu" aria-label="Suggestions">
          {choices.map((c) => (
            <button key={c.id} type="button" role="menuitem" className="qx-panel-choice"
              onClick={() => pick(c.value ?? c.label)} disabled={busy}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      <form className="qx-panel-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Ask the agent…" aria-label="Prompt" disabled={busy} />
        <button type="submit" aria-label="Send" disabled={busy || !text.trim()}>↵</button>
      </form>
    </div>
  );
}

const root = document.getElementById('panel');
if (root) createRoot(root).render(<Panel />);
