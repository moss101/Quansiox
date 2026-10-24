import React, { useEffect, useRef } from 'react';
import { Icon } from './Icons.jsx';
import { accelToGlyph, groupedForDialog } from './shortcutRegistry.js';

/**
 * ShortcutsDialog (parity plan P1.7) — Grok's keyboard-shortcuts surface.
 *
 * Renders the sand.* registry grouped exactly as Grok groups it
 * (Essentials / Chat / Navigation / Panels / Window), with ⌘/⌥/⇧ glyphs.
 * Every entry shows its local truth: wired shortcuts plainly, approximations
 * with a note, unmapped ones with the missing surface — the same honesty as
 * the tool-contract map. Open: ⌘/ or ⌘⇧/ (or the palette action).
 */
export default function ShortcutsDialog({ open, onClose }) {
  const closeRef = useRef(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  if (!open) return null;
  const groups = groupedForDialog();
  return (
    <div className="dialog-overlay shortcuts-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="dialog-card shortcuts-card" data-surface="shortcuts-dialog">
        <div className="shortcuts-head">
          <strong>Keyboard shortcuts</strong>
          <button type="button" className="ibtn" ref={closeRef} onClick={onClose} title="Close (Esc)" aria-label="Close"><Icon.X /></button>
        </div>
        <div className="shortcuts-body">
          {groups.map(({ group, items }) => (
            <section className="shortcuts-group" key={group} data-group={group}>
              <h3 className="shortcuts-group-title">{group}</h3>
              <ul>
                {items.map((item) => (
                  <li key={item.id} className={`shortcut-row is-${item.status}`} data-surface="shortcut-row" data-status={item.status}>
                    <span className="shortcut-label">
                      {item.label}
                      {item.status === 'approx' ? <em className="shortcut-note" title={item.note}> ≈</em> : null}
                      {item.status === 'unmapped' ? <em className="shortcut-note" title={item.reason}> —</em> : null}
                    </span>
                    {item.status === 'unmapped'
                      ? <span className="shortcut-key is-unmapped" title={item.reason}>{item.reason}</span>
                      : <kbd className="shortcut-key">{accelToGlyph(item.accel)}</kbd>}
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
