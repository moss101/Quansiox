import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * The Collaboration surface.
 *
 * A collaborative task is one other people can join and prompt. The owner
 * invites by email; a collaborator's prompt is **queued**, and the queue
 * runs the prompts one after another so two people typing at once never
 * interleave.
 */
export function CollabPanel({ onToast, sessionId: sessionIdProp }) {
  // The panel is mounted outside the main React tree (in the settings
  // dialog), so the active task comes from the session rail.
  const [sessionId, setSessionId] = useState(sessionIdProp ?? null);
  const [state, setState] = useState(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!sessionId) { setState(null); return; }
    try {
      const result = await api.collab.get({ sessionId });
      setState(result);
      setError(null);
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    }
  }, [sessionId]);

  useEffect(() => {
    if (sessionIdProp) { setSessionId(sessionIdProp); return; }
    const read = () => {
      const active = document.querySelector('.session-card.active');
      const id = active?.getAttribute('data-session') ?? null;
      setSessionId((current) => (current === id ? current : id));
    };
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, [sessionIdProp]);

  useEffect(() => { refresh(); }, [refresh]);

  const enable = async () => {
    setBusy(true);
    try {
      await api.collab.enable({ sessionId });
      await refresh();
      onToast?.('Collaboration is on for this task', 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const invite = async () => {
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    try {
      const result = await api.collab.invite({ sessionId, email: address });
      setEmail('');
      await refresh();
      onToast?.(`Invite link: ${result.link ?? result.token}`, 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (member) => {
    try {
      await api.collab.removeMember({ sessionId, email: member.email });
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  if (!sessionId) {
    return (
      <section className="collab-panel" data-surface="collab-panel" aria-label="Collaboration">
        <header className="collab-panel-head"><span className="surface-label">Collaboration</span></header>
        <p className="collab-empty">Open a task to collaborate on it.</p>
      </section>
    );
  }

  return (
    <section className="collab-panel" data-surface="collab-panel" aria-label="Collaboration">
      <header className="collab-panel-head">
        <span className="surface-label">Collaboration</span>
        <button type="button" className="ibtn" title="Reload" onClick={refresh}><Icon.Refresh /></button>
      </header>

      {error ? <p className="collab-error" role="alert">{error}</p> : null}

      {!state?.enabled ? (
        <>
          <p className="collab-empty">This task is not collaborative yet.</p>
          <button type="button" className="btn btn-primary" onClick={enable} disabled={busy}>Turn collaboration on</button>
        </>
      ) : (
        <>
          <div className="collab-invite">
            <input
              value={email}
              placeholder="collaborator@example.com"
              aria-label="Collaborator email"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') invite(); }}
            />
            <button type="button" className="btn btn-secondary btn-mini" onClick={invite} disabled={busy || !email.trim()}>
              Invite
            </button>
          </div>

          <div className="collab-members" data-surface="collab-members">
            <h4 className="surface-label">Collaborators</h4>
            <ul>
              {state.members?.map((member) => (
                <li key={member.email} className="collab-member">
                  <span className="ellipsis">{member.email}</span>
                  <button type="button" className="ibtn" title="Remove" aria-label={`Remove ${member.email}`} onClick={() => removeMember(member)}>
                    <Icon.X />
                  </button>
                </li>
              ))}
              {!state.members?.length ? <li className="collab-empty">Nobody yet.</li> : null}
            </ul>
          </div>

          {state.queue?.length ? (
            <div className="collab-queue" data-surface="collab-queue">
              <h4 className="surface-label">Queued prompts ({state.queue.length})</h4>
              <ul>
                {state.queue.map((entry) => (
                  <li key={entry.id} className="collab-queue-item">
                    <span className="collab-queue-who">{entry.identity}</span>
                    <span className="ellipsis">{entry.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="collab-note">
            Only you control the invitations, and a collaborator&apos;s prompt runs on this task — so it uses
            your model, not theirs. Two prompts never interleave: they queue.
          </p>
        </>
      )}
    </section>
  );
}

export default CollabPanel;
