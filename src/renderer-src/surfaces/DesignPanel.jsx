import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * The Design View surface.
 *
 * A design session is an image with a **version history**. You mark a
 * region, say what should change there, and the agent applies the edit as a
 * new version. The panel shows the original, the modified version and their
 * difference, the way the product does.
 *
 * Marking is done by dragging a rectangle over the picture — the mark is
 * stored with the instruction, and the agent batches the marked regions into
 * one edit.
 */
export function DesignPanel({ onToast }) {
  const [designs, setDesigns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [versionId, setVersionId] = useState(null);
  const [operations, setOperations] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [drag, setDrag] = useState(null);
  const [instruction, setInstruction] = useState('');
  const imageRef = useRef(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await api.design.list();
      setDesigns(list ?? []);
      setSelected((current) => (current && list?.some((d) => d.id === current) ? current : list?.[0]?.id ?? null));
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    api.design.operations?.().then((ops) => setOperations(ops ?? [])).catch(() => setOperations([]));
  }, []);

  const design = designs.find((d) => d.id === selected) ?? null;
  const version = design?.versions?.find((v) => v.id === versionId) ?? design?.versions?.at(-1) ?? null;

  const openImage = async () => {
    setBusy(true);
    try {
      const created = await api.design.pickImage();
      if (created) {
        await refresh();
        setSelected(created.id);
        onToast?.('Design session opened', 'ok');
      }
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  /** Turn a pointer position into image pixels. */
  const toImageCoords = (event) => {
    const element = imageRef.current;
    if (!element || !design?.sourceWidth) return null;
    const rect = element.getBoundingClientRect();
    const scaleX = design.sourceWidth / rect.width;
    const scaleY = (design.sourceHeight || design.sourceWidth) / rect.height;
    return {
      x: Math.round((event.clientX - rect.left) * scaleX),
      y: Math.round((event.clientY - rect.top) * scaleY),
    };
  };

  const onPointerDown = (event) => {
    const point = toImageCoords(event);
    if (!point) return;
    setDrag({ start: point, end: point });
  };

  const onPointerMove = (event) => {
    if (!drag) return;
    const point = toImageCoords(event);
    if (!point) return;
    setDrag({ ...drag, end: point });
  };

  const onPointerUp = async () => {
    if (!drag || !design) { setDrag(null); return; }
    const x = Math.min(drag.start.x, drag.end.x);
    const y = Math.min(drag.start.y, drag.end.y);
    const width = Math.abs(drag.end.x - drag.start.x);
    const height = Math.abs(drag.end.y - drag.start.y);
    setDrag(null);
    if (width < 4 || height < 4) return;
    try {
      await api.design.addMark({ id: design.id, x, y, width, height, instruction });
      await refresh();
      onToast?.('Region marked', 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  const clearMarks = async () => {
    if (!design) return;
    try {
      await api.design.clearMarks({ id: design.id });
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  const remove = async (target) => {
    try {
      await api.design.remove({ id: target.id });
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  const markBox = drag
    ? {
      left: `${(Math.min(drag.start.x, drag.end.x) / (design?.sourceWidth || 1)) * 100}%`,
      top: `${(Math.min(drag.start.y, drag.end.y) / (design?.sourceHeight || 1)) * 100}%`,
      width: `${(Math.abs(drag.end.x - drag.start.x) / (design?.sourceWidth || 1)) * 100}%`,
      height: `${(Math.abs(drag.end.y - drag.start.y) / (design?.sourceHeight || 1)) * 100}%`,
    }
    : null;

  return (
    <section className="design-panel" data-surface="design-panel" aria-label="Design View">
      <header className="design-panel-head">
        <span className="surface-label">Design View</span>
        <div className="design-panel-actions">
          <button type="button" className="btn btn-secondary btn-mini" onClick={openImage} disabled={busy}>
            <Icon.Plus /> Open image
          </button>
          <button type="button" className="ibtn" title="Reload" onClick={refresh}><Icon.Refresh /></button>
        </div>
      </header>

      {error ? <p className="design-error" role="alert">{error}</p> : null}

      <ul className="design-list" role="listbox" aria-label="Design sessions">
        {designs.map((entry) => (
          <li key={entry.id} className={`design-row${entry.id === selected ? ' is-active' : ''}`}>
            <button type="button" className="design-row-name" aria-selected={entry.id === selected} onClick={() => setSelected(entry.id)}>
              <Icon.File />
              <span className="ellipsis">{entry.title}</span>
              <span className="design-badge">{entry.versions?.length ?? 0}</span>
            </button>
            <button type="button" className="ibtn" title="Delete" aria-label={`Delete ${entry.title}`} onClick={() => remove(entry)}>
              <Icon.Trash />
            </button>
          </li>
        ))}
        {!designs.length ? <li className="design-empty">No design sessions yet.</li> : null}
      </ul>

      {design ? (
        <div className="design-detail">
          <div className="design-canvas-wrap">
            {version ? (
              <div className="design-canvas" ref={imageRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                data-surface="design-canvas">
                <img src={`file://${version.path}`} alt={design.title} className="design-image" />
                {design.marks?.map((mark) => (
                  <span
                    key={mark.id}
                    className="design-mark"
                    style={{
                      left: `${(mark.x / (design.sourceWidth || 1)) * 100}%`,
                      top: `${(mark.y / (design.sourceHeight || 1)) * 100}%`,
                      width: `${(mark.width / (design.sourceWidth || 1)) * 100}%`,
                      height: `${(mark.height / (design.sourceHeight || 1)) * 100}%`,
                    }}
                    title={mark.instruction}
                  />
                ))}
                {markBox ? <span className="design-mark design-mark-live" style={markBox} /> : null}
              </div>
            ) : null}
          </div>

          <div className="design-versions" data-surface="design-versions">
            {design.versions?.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`design-version${entry.id === version?.id ? ' is-active' : ''}`}
                onClick={() => setVersionId(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <label className="design-instruction">
            <span>What should change in the marked region?</span>
            <input
              value={instruction}
              placeholder="e.g. change this to muted sage green"
              onChange={(e) => setInstruction(e.target.value)}
            />
          </label>

          <div className="design-actions">
            <button type="button" className="btn btn-secondary btn-mini" onClick={clearMarks} disabled={!design.marks?.length}>
              Clear marks ({design.marks?.length ?? 0})
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-mini"
              onClick={async () => {
                try {
                  const text = await api.design.extractText({ id: design.id });
                  onToast?.(text.ok ? `${text.elements.length} text elements found` : text.reason, text.ok ? 'ok' : 'err');
                  await refresh();
                } catch (failure) {
                  onToast?.(failure?.message ?? String(failure), 'err');
                }
              }}
            >
              Extract text
            </button>
          </div>

          <p className="design-note">
            Drag over the picture to mark a region, say what should change, and the agent applies the
            marked regions as one edit. Every edit becomes a version you can compare against the original.
          </p>
        </div>
      ) : null}
    </section>
  );
}

export default DesignPanel;
