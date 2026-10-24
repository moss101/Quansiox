import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { api } from './lib.js';
import { groupBySession, groupLabel, snippet } from './savedMessagesModel.js';

/**
 * LibraryDialog (parity plan P2.4 remainder) — saved messages.
 *
 * Grok's library pins transcript messages into a personal collection,
 * grouped by conversation. Quansiox's is the same shape, local-first:
 * Save on any message row → this dialog lists them newest-saved first,
 * grouped by session, each row jumping back to the message (switching
 * sessions when needed) with the same flash treatment as find-in-chat.
 */
export default function LibraryDialog({ open, onClose, onJump, activeSessionId }) {
  const [saved, setSaved] = useState([]);
  const closeRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const rows = await api.savedMessages.list();
      setSaved(Array.isArray(rows) ? rows : []);
    } catch { setSaved([]); }
  }, []);

  useEffect(() => {
    if (open) { load(); closeRef.current?.focus(); }
  }, [open, load]);

  if (!open) return null;
  const groups = groupBySession(saved);
  const remove = async (messageId) => {
    try {
      await api.savedMessages.remove({ messageId });
      setSaved((rows) => rows.filter((r) => r.messageId !== messageId));
    } catch { /* next load re-syncs */ }
  };
  return (
    <div className="dialog-overlay library-overlay" role="dialog" aria-modal="true" aria-label="Saved messages">
      <div className="dialog-card library-card" data-surface="library-dialog">
        <div className="shortcuts-head">
          <strong>Saved messages <span className="library-count">{saved.length}</span></strong>
          <button type="button" className="ibtn" ref={closeRef} onClick={onClose} title="Close (Esc)" aria-label="Close"><Icon.X /></button>
        </div>
        <div className="library-body">
          {groups.length === 0
            ? <p className="library-empty" data-surface="library-empty">Nothing saved yet — use ★ on a message to keep it here.</p>
            : groups.map((group) => (
              <section className="library-group" key={group.sessionId ?? 'none'} data-surface="library-group">
                <h3 className="shortcuts-group-title">
                  {groupLabel(group.sessionId)}
                  {group.sessionId === activeSessionId ? <span className="library-current"> · this chat</span> : null}
                </h3>
                <ul>
                  {group.items.map((entry) => (
                    <li key={entry.messageId} className="library-row" data-surface="library-row">
                      <button type="button" className="library-jump" title="Jump to this message"
                        onClick={() => { onJump?.(entry); onClose?.(); }}>
                        <span className="library-kind" data-kind={entry.kind}>{entry.kind === 'assistant' ? 'A' : 'You'}</span>
                        <span className="library-text">{snippet(entry.text)}</span>
                      </button>
                      <button type="button" className="ibtn" title="Remove from saved" aria-label="Remove from saved"
                        onClick={() => remove(entry.messageId)}><Icon.Trash /></button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      </div>
    </div>
  );
}
