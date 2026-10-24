import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * The Slides surface.
 *
 * A deck is a list of slides; each slide has a layout, a title, bullets and
 * **speaker notes**. The panel lists the decks, lets you pick one, shows
 * its slides, and exports it as an editable `.pptx`, a PDF, an interactive
 * browser deck or a speaker-notes document.
 */
const LAYOUTS = ['title', 'section', 'bullets', 'two-column', 'chart', 'quote', 'closing'];

export function SlidesPanel({ onToast }) {
  const [decks, setDecks] = useState([]);
  const [selected, setSelected] = useState(null);
  const [themes, setThemes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [list, palette] = await Promise.all([api.slides.list(), api.slides.themes()]);
      setDecks(list ?? []);
      setThemes(palette ?? []);
      setSelected((current) => (current && list?.some((d) => d.id === current) ? current : list?.[0]?.id ?? null));
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const deck = decks.find((d) => d.id === selected) ?? null;

  const exportAs = async (format) => {
    if (!deck) return;
    setBusy(true);
    try {
      const result = await api.slides[`export${format[0].toUpperCase()}${format.slice(1)}`]({ id: deck.id });
      onToast?.(`${deck.title} exported as ${format}`, 'ok');
      if (result?.path) {
        try { await api.system.openExternal({ url: `file://${result.path}` }); } catch { /* not fatal */ }
      }
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const newDeck = async () => {
    setBusy(true);
    try {
      const created = await api.slides.create({ title: 'New deck' });
      await refresh();
      setSelected(created?.id ?? null);
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target) => {
    try {
      await api.slides.remove({ id: target.id });
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  return (
    <section className="slides-panel" data-surface="slides-panel" aria-label="Slides">
      <header className="slides-panel-head">
        <span className="surface-label">Slides</span>
        <div className="slides-panel-actions">
          <button type="button" className="btn btn-secondary btn-mini" onClick={newDeck} disabled={busy}>
            <Icon.Plus /> New deck
          </button>
          <button type="button" className="ibtn" title="Reload" onClick={refresh}><Icon.Refresh /></button>
        </div>
      </header>

      {error ? <p className="slides-error" role="alert">{error}</p> : null}

      <ul className="slides-list" role="listbox" aria-label="Decks">
        {decks.map((entry) => (
          <li key={entry.id} className={`slides-row${entry.id === selected ? ' is-active' : ''}`}>
            <button
              type="button"
              className="slides-row-name"
              aria-selected={entry.id === selected}
              onClick={() => setSelected(entry.id)}
            >
              <Icon.File />
              <span className="ellipsis">{entry.title}</span>
              <span className="slides-badge">{entry.slideCount}</span>
            </button>
            <button type="button" className="ibtn" title="Delete deck" aria-label={`Delete ${entry.title}`} onClick={() => remove(entry)}>
              <Icon.Trash />
            </button>
          </li>
        ))}
        {!decks.length ? <li className="slides-empty">No decks yet.</li> : null}
      </ul>

      {deck ? (
        <div className="slides-detail">
          <div className="slides-meta">
            <span className="surface-label">{deck.title}</span>
            <span className="slides-theme">{deck.theme}</span>
            <span className="slides-theme">{deck.language}</span>
          </div>
          <ol className="slides-outline">
            {deck.slides?.map((slide, index) => (
              <li key={slide.id} className="slides-outline-item">
                <span className="slides-outline-index">{index + 1}</span>
                <span className="slides-outline-layout">{slide.layout}</span>
                <span className="ellipsis">{slide.title || '(untitled)'}</span>
                {slide.notes ? <Icon.Check title="has speaker notes" /> : null}
              </li>
            ))}
          </ol>
          <div className="slides-exports">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => exportAs('pptx')}>Export .pptx</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => exportAs('pdf')}>Export PDF</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => exportAs('web')}>Web slides</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => exportAs('notes')}>Speaker notes</button>
          </div>
        </div>
      ) : null}

      <p className="slides-note">
        The agent writes the deck and its speaker notes; this panel exports it.
        A .pptx opens in PowerPoint, Keynote and Google Slides and stays editable.
      </p>
    </section>
  );
}

export default SlidesPanel;
