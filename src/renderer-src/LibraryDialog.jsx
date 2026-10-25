import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { api } from './lib.js';
import { groupByKind, hoverCard, messageEntry } from './libraryModel.js';
import { snippet } from './savedMessagesModel.js';

/**
 * LibraryDialog (P2.4 saved messages + P2.5 library v2) — Grok's library:
 * one collection typed by kind. Saved messages (the P2.4 store) render with
 * jump; content pins (media/page/document/sheet/deck — the libraryService
 * store) render with a hover card and open-in-place. Newest first within
 * each kind; kind sections in Grok's taxonomy order.
 */
export default function LibraryDialog({ open, onClose, onJump, activeSessionId }) {
  const [saved, setSaved] = useState([]);
  const [pins, setPins] = useState([]);
  const closeRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [rows, pinned] = await Promise.all([
        api.savedMessages.list().catch(() => []),
        api.libraryPins.list().catch(() => []),
      ]);
      setSaved(Array.isArray(rows) ? rows : []);
      setPins(Array.isArray(pinned) ? pinned : []);
    } catch { /* store not ready */ }
  }, []);

  useEffect(() => {
    if (open) { load(); closeRef.current?.focus(); }
  }, [open, load]);

  if (!open) return null;
  const groups = groupByKind([
    ...saved.map(messageEntry),
    ...pins.map((p) => ({ ...p, text: p.note || p.title })),
  ]);
  const removeMessage = async (messageId) => {
    try {
      await api.savedMessages.remove({ messageId });
      setSaved((rows) => rows.filter((r) => r.messageId !== messageId));
    } catch { /* next load re-syncs */ }
  };
  const unpin = async (pin) => {
    try {
      await api.libraryPins.unpin({ kind: pin.kind, refId: pin.refId });
      setPins((rows) => rows.filter((r) => !(r.kind === pin.kind && r.refId === pin.refId)));
    } catch { /* next load re-syncs */ }
  };
  const openPin = async (pin) => {
    try {
      await api.artifacts.open({ id: pin.refId });
      onClose?.();
    } catch (e) {
      try { await api.savedMessages.isSaved({ messageId: pin.refId }); } catch { /* already surfaced */ }
      onClose?.();
      // Non-artifact pins (documents/sheets/decks) have no dedicated window
      // yet — the library says so instead of failing silently.
      console.warn('library: no viewer for', pin.kind, pin.refId, e?.message ?? '');
    }
  };

  return (
    <div className="dialog-overlay library-overlay" role="dialog" aria-modal="true" aria-label="Library">
      <div className="dialog-card library-card" data-surface="library-dialog">
        <div className="shortcuts-head">
          <strong>Library <span className="library-count">{saved.length + pins.length}</span></strong>
          <button type="button" className="ibtn" ref={closeRef} onClick={onClose} title="Close (Esc)" aria-label="Close"><Icon.X /></button>
        </div>
        <div className="library-body">
          {groups.length === 0
            ? <p className="library-empty" data-surface="library-empty">Nothing here yet — ★ a message, or pin an artifact from the Artifacts panel.</p>
            : groups.map((group) => (
              <section className="library-group" key={group.kind} data-surface="library-group" data-kind={group.kind}>
                <h3 className="shortcuts-group-title">{group.label} <span className="library-count">{group.items.length}</span></h3>
                <ul>
                  {group.items.map((entry) => {
                    const card = hoverCard(entry);
                    return (
                      <li key={`${entry.kind}:${entry.refId}`} className="library-row" data-surface="library-row">
                        <button type="button"
                          className={entry.kind === 'message' ? 'library-jump' : 'library-jump has-hover-card'}
                          title={entry.kind === 'message' ? 'Jump to this message' : card.headline}
                          onClick={() => (entry.kind === 'message'
                            ? (onJump?.(entry), onClose?.())
                            : openPin(entry))}>
                          <span className="library-kind" data-kind={entry.kind}>{entry.kind === 'message' ? (entry.authorKind === 'assistant' ? 'A' : 'You') : entry.kind.slice(0, 2)}</span>
                          <span className="library-text">{entry.kind === 'message' ? snippet(entry.text) : entry.title}</span>
                          {entry.kind !== 'message' ? (
                            <span className="hover-card" data-surface="hover-card" role="tooltip">
                              <strong>{card.headline}</strong>
                              <span className="hover-kind">{card.kindLabel}</span>
                              <span className="hover-origin">{card.origin}</span>
                              {card.hasNote ? <em className="hover-note">has note</em> : null}
                            </span>
                          ) : null}
                        </button>
                        {entry.kind === 'message' && entry.sessionId === activeSessionId
                          ? <span className="library-current" title="Saved from this chat">·</span> : null}
                        <button type="button" className="ibtn"
                          title={entry.kind === 'message' ? 'Remove from saved' : 'Unpin'}
                          aria-label={entry.kind === 'message' ? 'Remove from saved' : 'Unpin'}
                          onClick={() => (entry.kind === 'message' ? removeMessage(entry.refId) : unpin(entry))}><Icon.Trash /></button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
        </div>
      </div>
    </div>
  );
}
