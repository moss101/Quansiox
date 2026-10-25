import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from './Icons.jsx';
import { collectMedia, stepIndex, stripLabel } from './mediaModel.js';

/**
 * MediaStrip (parity plan P2.6) — Grok's sand-media filmstrip.
 * Every image of the conversation (agent screenshots + attached images) in
 * one strip above the composer; click → the fullscreen lightbox with
 * prev/next (wraparound), origin caption, and a local download. HTML
 * artifacts open in their own sandboxed artifact window via the existing
 * artifacts service rather than this lightbox (they are documents, not
 * media).
 */
export default function MediaStrip({ items }) {
  const media = useMemo(() => collectMedia(items), [items]);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const go = useCallback((dir) => setIdx((i) => stepIndex(i, media.length, dir)), [media.length]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); setOpen(false); }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); go(1); }
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, go]);

  if (media.length === 0) return null;
  const current = media[Math.min(idx, media.length - 1)];
  return (
    <div className="media-strip" data-surface="media-strip" role="region" aria-label="Conversation media">
      {media.slice(0, 8).map((m, i) => (
        <button type="button" key={m.id} className={`media-thumb${i === idx ? ' on' : ''}`} data-surface="media-thumb"
          title={`Open media ${i + 1} of ${media.length}`} aria-label={`Open media ${i + 1}`}
          onClick={() => { setIdx(i); setOpen(true); }}>
          <img src={m.src} alt="" loading="lazy" />
        </button>
      ))}
      {media.length > 8 ? <span className="media-more">+{media.length - 8}</span> : null}
      {open ? (
        <div className="media-lightbox" data-surface="media-lightbox" role="dialog" aria-modal="true" aria-label="Media viewer">
          <div className="media-lightbox-bar">
            <span className="media-caption" data-surface="media-caption">{stripLabel(media, idx)}</span>
            <a className="ibtn" title="Download" aria-label="Download"
              href={current.src} download={`quansiox-media-${idx + 1}.png`}><Icon.Popout /></a>
            <button type="button" className="ibtn" title="Previous (←)" aria-label="Previous" data-surface="media-prev" onClick={() => go(-1)}><Icon.ChevronLeft /></button>
            <button type="button" className="ibtn" title="Next (→)" aria-label="Next" data-surface="media-next" onClick={() => go(1)}><Icon.ChevronRight /></button>
            <button type="button" className="ibtn" title="Close (Esc)" aria-label="Close" onClick={() => setOpen(false)}><Icon.X /></button>
          </div>
          <img className="media-full" src={current.src} alt={`media ${idx + 1}`} />
        </div>
      ) : null}
    </div>
  );
}
