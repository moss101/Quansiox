import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * The canvas surface.
 *
 * A canvas is an editable HTML artifact with a share state: a visibility, a
 * list of principals who may see it, and a page address it can be reached
 * at. The backend has always had this; the surface is what makes it usable.
 *
 * A canvas renders in a sandboxed frame — it is agent-written HTML, so it
 * gets no app access and no network, exactly like the artifact window.
 */
export function CanvasPanel({ onToast, canvasId = null }) {
  const [canvases, setCanvases] = useState([]);
  const [bundles, setBundles] = useState([]);
  const [selected, setSelected] = useState(canvasId);
  const [html, setHtml] = useState('');
  const [share, setShare] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [slug, setSlug] = useState('');

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await api.artifacts.list();
      const canvasesOnly = (list ?? []).filter((a) => a.kind === 'canvas' || a.canvasId);
      setCanvases(canvasesOnly);
      // The live canvases: a canvas is a JavaScript application, not a
      // document, so it is served from its own origin.
      try {
        const live = await api.canvasBundles.list();
        setBundles(live ?? []);
      } catch { setBundles([]); }
      const target = canvasId ?? selected ?? canvasesOnly[0]?.id;
      if (!target) { setHtml(''); setShare(null); return; }
      setSelected(target);
      const read = await api.artifacts.read({ id: target });
      setHtml(read?.html ?? '');
      const state = await api.artifacts.share({ id: target });
      setShare(state ?? null);
      setSlug(state?.pageAddress ?? state?.slug ?? '');
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    }
  }, [canvasId, selected]);

  useEffect(() => { refresh(); }, [refresh]);

  const setVisibility = async (visibility) => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await api.artifacts.setVisibility({ id: selected, visibility });
      setShare(next ?? share);
      onToast?.(`Canvas is now ${visibility}`, 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const saveAddress = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await api.artifacts.setAddress({ id: selected, slug });
      setShare(next ?? share);
      onToast?.('Address updated', 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const exportHtml = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const file = await api.artifacts.export({ id: selected });
      onToast?.(`Exported to ${file?.path ?? 'a file'}`, 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="canvas-panel" data-surface="canvas-panel" aria-label="Canvas">
      <header className="canvas-panel-head">
        <span className="surface-label">Canvas</span>
        <button type="button" className="ibtn" title="Reload" onClick={refresh}><Icon.Popout /></button>
      </header>

      {error ? <p className="canvas-error" role="alert">{error}</p> : null}

      {!canvases.length && !error ? (
        <p className="canvas-empty">No canvas yet. The agent creates one when it needs a page you can open in a window.</p>
      ) : null}

      {canvases.length ? (
        <div className="canvas-list" role="listbox" aria-label="Canvases">
          {canvases.map((canvas) => (
            <button
              key={canvas.id}
              type="button"
              role="option"
              aria-selected={canvas.id === selected}
              className={`canvas-row${canvas.id === selected ? ' is-active' : ''}`}
              data-canvas={canvas.id}
              onClick={() => setSelected(canvas.id)}
            >
              <span className="canvas-row-title">{canvas.title ?? canvas.id}</span>
            </button>
          ))}
        </div>
      ) : null}

      {bundles.length ? (
        <div className="canvas-bundles" data-surface="canvas-bundles">
          <h4 className="surface-label">Live canvases (JavaScript)</h4>
          {bundles.map((bundle) => (
            <div key={bundle.id} className="canvas-bundle" data-canvas={bundle.id}>
              <span className="canvas-bundle-title">{bundle.title}</span>
              <button
                type="button"
                className="btn btn-secondary btn-mini"
                onClick={() => { window.open(api.canvasBundles.urlFor({ id: bundle.id }).url, '_blank', 'noopener'); }}
              >Open</button>
            </div>
          ))}
        </div>
      ) : null}

      {selected ? (
        <>
          <div className="canvas-actions">
            <button type="button" className="btn btn-secondary" disabled={busy}
              onClick={() => setVisibility(share?.visibility === 'private' ? 'shared' : 'private')}>
              {share?.visibility === 'private' ? 'Share' : 'Make private'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={exportHtml}>Export HTML</button>
            <input
              className="canvas-slug"
              aria-label="Page address"
              placeholder="page address"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            <button type="button" className="btn btn-primary" disabled={busy} onClick={saveAddress}>Save address</button>
          </div>
          <div className="canvas-frame-wrap" data-surface="canvas-frame">
            <iframe
              className="canvas-frame"
              title="canvas"
              srcDoc={html}
              sandbox="allow-scripts"
            />
          </div>
        </>
      ) : null}
    </section>
  );
}

export default CanvasPanel;
