import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * The Website surface.
 *
 * The local part of the Website Builder: the projects, their files, the SEO
 * audit, who may see them, the local analytics and the published preview.
 */
export function WebsitePanel({ onToast }) {
  const [sites, setSites] = useState([]);
  const [selected, setSelected] = useState(null);
  const [files, setFiles] = useState([]);
  const [audit, setAudit] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await api.website.list();
      setSites(list ?? []);
      setSelected((current) => (current && list?.some((s) => s.id === current) ? current : list?.[0]?.id ?? null));
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const site = sites.find((s) => s.id === selected) ?? null;

  const refreshSite = useCallback(async () => {
    if (!selected) { setFiles([]); setAudit(null); setAnalytics(null); return; }
    try {
      const [fileList, seo, stats] = await Promise.all([
        api.website.files({ id: selected }),
        api.website.seoAudit({ id: selected }),
        api.website.analytics({ id: selected }),
      ]);
      setFiles(fileList ?? []);
      setAudit(seo ?? null);
      setAnalytics(stats ?? null);
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    }
  }, [selected]);

  useEffect(() => { refreshSite(); }, [refreshSite]);

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.website.create({ name: 'New site' });
      await refresh();
      setSelected(created?.id ?? null);
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!site) return;
    setBusy(true);
    try {
      const result = await api.website.publish({ id: site.id, domain: site.domain });
      onToast?.(`Published — preview at ${result.previewUrl}`, 'ok');
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target) => {
    try {
      await api.website.remove({ id: target.id });
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  return (
    <section className="website-panel" data-surface="website-panel" aria-label="Websites">
      <header className="website-panel-head">
        <span className="surface-label">Websites</span>
        <div className="website-panel-actions">
          <button type="button" className="btn btn-secondary btn-mini" onClick={create} disabled={busy}>
            <Icon.Plus /> New site
          </button>
          <button type="button" className="ibtn" title="Reload" onClick={refresh}><Icon.Refresh /></button>
        </div>
      </header>

      {error ? <p className="website-error" role="alert">{error}</p> : null}

      <ul className="website-list" role="listbox" aria-label="Sites">
        {sites.map((entry) => (
          <li key={entry.id} className={`website-row${entry.id === selected ? ' is-active' : ''}`}>
            <button type="button" className="website-row-name" aria-selected={entry.id === selected} onClick={() => setSelected(entry.id)}>
              <Icon.Globe />
              <span className="ellipsis">{entry.name}</span>
              <span className="website-badge">{entry.files?.length ?? 0}</span>
            </button>
            <button type="button" className="ibtn" title="Delete" aria-label={`Delete ${entry.name}`} onClick={() => remove(entry)}>
              <Icon.Trash />
            </button>
          </li>
        ))}
        {!sites.length ? <li className="website-empty">No sites yet.</li> : null}
      </ul>

      {site ? (
        <div className="website-detail">
          <div className="website-meta">
            <span className="surface-label">{site.name}</span>
            <span className="website-path ellipsis">{site.directory}</span>
          </div>

          <div className="website-stats" data-surface="website-stats">
            <div className="website-stat">
              <span className="website-stat-value">{audit?.score ?? '—'}</span>
              <span className="website-stat-label">SEO score</span>
            </div>
            <div className="website-stat">
              <span className="website-stat-value">{analytics?.views ?? 0}</span>
              <span className="website-stat-label">views</span>
            </div>
            <div className="website-stat">
              <span className="website-stat-value">{site.access?.mode ?? 'public'}</span>
              <span className="website-stat-label">access</span>
            </div>
          </div>

          {audit?.suggestions?.length ? (
            <div className="website-suggestions" data-surface="website-seo-suggestions">
              <h4 className="surface-label">SEO</h4>
              <ul>
                {audit.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}
              </ul>
              <button
                type="button"
                className="btn btn-secondary btn-mini"
                onClick={async () => {
                  try {
                    await api.website.applySeo({ id: site.id, description: site.description, canonical: site.seo?.canonical ?? null });
                    await refreshSite();
                    onToast?.('SEO metadata applied', 'ok');
                  } catch (failure) {
                    onToast?.(failure?.message ?? String(failure), 'err');
                  }
                }}
              >
                Apply the metadata
              </button>
            </div>
          ) : null}

          <div className="website-files" data-surface="website-files">
            <h4 className="surface-label">Files</h4>
            <ul>
              {files.map((file) => (
                <li key={file.path} className="website-file">
                  <Icon.File />
                  <span className="ellipsis">{file.path}</span>
                  <span className="website-file-size">{file.bytes}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="website-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={publish}>Publish locally</button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                try {
                  const control = await api.website.codeControl({ id: site.id });
                  onToast?.(`${control.files.length} files · bundle at ${control.zipPath}`, 'ok');
                } catch (failure) {
                  onToast?.(failure?.message ?? String(failure), 'err');
                }
              }}
            >
              Code control
            </button>
            {site.previewUrl ? (
              <a className="btn btn-secondary" href={site.previewUrl} target="_blank" rel="noreferrer">Open preview</a>
            ) : null}
          </div>

          <p className="website-note">
            Publishing produces a static bundle on this Mac and a local preview URL. Host the bundle on
            any static host, or use the preview.
          </p>
        </div>
      ) : null}
    </section>
  );
}

export default WebsitePanel;
