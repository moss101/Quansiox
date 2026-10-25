import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileTree, useTerminal, useGit, api, toast, events } from './lib.js';
import { renderMarkdown } from './markdown.js';
import { Icon } from './Icons.jsx';
import { libraryKindForArtifact } from './libraryModel.js';

/** Pin-to-library toggle on an artifact row (P2.5): the artifact's kind maps
 * onto Grok's library taxonomy (charts → sheets, the interactive html family
 * → pages); the pin captures the title at pin time. */
function PinBtn({ row }) {
  const [pinned, setPinned] = useState(null); // null = unknown yet
  const kind = libraryKindForArtifact(row.kind);
  useEffect(() => {
    let alive = true;
    api.libraryPins.isPinned({ kind, refId: row.id })
      .then((r) => { if (alive) setPinned(Boolean(r?.pinned)); })
      .catch(() => { if (alive) setPinned(false); });
    return () => { alive = false; };
  }, [kind, row.id]);
  const toggle = async () => {
    try {
      if (pinned) {
        await api.libraryPins.unpin({ kind, refId: row.id });
        setPinned(false);
        toast('unpinned from library', 'ok');
      } else {
        await api.libraryPins.pin({ kind, refId: row.id, title: row.title, origin: `artifact:${row.kind}` });
        setPinned(true);
        toast(`pinned to library as ${kind}`, 'ok');
      }
    } catch (failure) { toast(failure.message, 'err'); }
  };
  return (
    <button type="button" className={`ibtn msg-save${pinned ? ' on' : ''}`} data-surface="pin-artifact"
      title={pinned ? 'Unpin from library' : 'Pin to library'} aria-label={pinned ? 'Unpin from library' : 'Pin to library'}
      aria-pressed={pinned === true} onClick={toggle}><Icon.Star /></button>
  );
}

/* ============ Files panel: live tree + viewer with edit mode ============ */

function TreeNode({ entry, entries, depth, selected, onSelect }) {
  const [open, setOpen] = useState(depth < 1);
  const isDir = entry.path.endsWith('/');
  const children = useMemo(
    () => (isDir ? entries.filter((e) => e.path.startsWith(entry.path) && e.path.slice(entry.path.length).indexOf('/') === (e.path.endsWith('/') ? e.path.slice(entry.path.length).length - 1 : -1)) : []),
    [entries, entry, isDir]
  );
  return (
    <>
      <div className={`tree-row${selected === entry.path ? ' selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => (isDir ? setOpen(!open) : onSelect(entry.path))}>
        {isDir
          ? <span className={`twisty${open ? ' open' : ''}`}>▶</span>
          : <span className="twisty" />}
        {isDir ? <Icon.Folder /> : <Icon.File />}
        <span className="fname">{entry.name}</span>
      </div>
      {isDir && open && children.map((c) => (
        <TreeNode key={c.path} entry={c} entries={entries} depth={depth + 1} selected={selected} onSelect={onSelect} />
      ))}
    </>
  );
}

export function FilesPanel({ active }) {
  const { root, entries, refresh } = useFileTree(active);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState('');
  const [media, setMedia] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [rawView, setRawView] = useState(false);

  const openFile = async (path) => {
    setSelected(path);
    setEditing(false);
    setMedia(null);
    setContent('');
    setRawView(false);
    const ext = (path.split('.').pop() || '').toLowerCase();
    const mediaExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'pdf', 'mp3', 'wav', 'm4a', 'mp4', 'webm'];
    if (mediaExts.includes(ext)) {
      try {
        setMedia(await api.file.readMedia({ path }));
      } catch (err) {
        setContent(`(cannot preview: ${err.message})`);
      }
      return;
    }
    try {
      const r = await api.file.read({ path });
      setContent(r.content ?? String(r));
    } catch (err) {
      setContent(`(cannot read: ${err.message})`);
    }
  };

  const mediaUrl = useMemo(() => {
    if (!media) return '';
    if (media.mime.startsWith('image/')) return `data:${media.mime};base64,${media.base64}`;
    const bytes = Uint8Array.from(atob(media.base64), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: media.mime }));
  }, [media]);
  useEffect(() => () => { if (mediaUrl.startsWith('blob:')) URL.revokeObjectURL(mediaUrl); }, [mediaUrl]);
  const previewKind = media?.mime?.startsWith('image/') ? 'image'
    : media?.mime === 'application/pdf' ? 'pdf'
      : media?.mime?.startsWith('audio/') ? 'audio'
        : media?.mime?.startsWith('video/') ? 'video' : null;

  const save = async () => {
    try {
      await api.file.write({ path: selected, content: draft });
      setContent(draft);
      setEditing(false);
      toast('File saved', 'ok');
      refresh();
    } catch (err) { toast(`save failed: ${err.message}`, 'err'); }
  };

  const isMarkdown = /\.(md|markdown|mdown)$/i.test(selected ?? '');
  const tops = entries.filter((e) => !e.path.slice(0, -1).includes('/'));

  return (
    <div className="dock-tabpane">
      <div className="file-tree">
        {tops.length === 0 && <div style={{ color: 'var(--text-3)', padding: 8, fontSize: 11 }}>workspace empty</div>}
        {tops.map((e) => (
          <TreeNode key={e.path} entry={e} entries={entries} depth={0} selected={selected} onSelect={openFile} />
        ))}
      </div>
      {selected && (
        <div className="file-viewer">
          <div className="file-viewer-head">
            <span className="fv-path ellipsis">{selected}</span>
            <button className="ibtn" title="Reveal in Finder" onClick={() => api.workspace.reveal({ path: selected }).catch(() => {})}>
              <Icon.Popout />
            </button>
            <button className="ibtn" title="Open in default app" onClick={() => api.workspace.open({ path: selected }).catch((error) => toast(error.message, 'err'))}>
              <Icon.File />
            </button>
            {isMarkdown && !editing && (
              <button className="ibtn" title={rawView ? 'Preview' : 'Raw text'} onClick={() => setRawView((v) => !v)}>
                {rawView ? <Icon.Eye /> : <Icon.Edit />}
              </button>
            )}
            {editing
              ? <>
                <button className="ibtn" title="Save" onClick={save}><Icon.Check /></button>
                <button className="ibtn" title="Cancel" onClick={() => setEditing(false)}><Icon.X /></button>
              </>
              : <button className="ibtn" title="Edit" onClick={() => { setDraft(content); setEditing(true); }}><Icon.Edit /></button>}
          </div>
          {editing
            ? <textarea value={draft} onChange={(ev) => setDraft(ev.target.value)} spellCheck={false} />
            : previewKind === 'image'
              ? <img className="fv-media" src={mediaUrl} alt={selected} />
              : previewKind === 'pdf'
                ? <iframe className="fv-frame" src={mediaUrl} title={selected} />
                : previewKind === 'audio'
                  ? <audio className="fv-audio" controls src={mediaUrl} />
                  : previewKind === 'video'
                    ? <video className="fv-video" controls src={mediaUrl} />
                    : isMarkdown && !rawView
                      ? <div className="fv-markdown md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
                      : <pre>{content}</pre>}
        </div>
      )}
    </div>
  );
}

/* ============ Terminal panel: live PTY ============ */

export function TerminalPanel({ active }) {
  const { lines, write, control } = useTerminal(active);
  const [input, setInput] = useState('');
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView(); }, [lines]);
  return (
    <div className="terminal-pane">
      <div className="term-output">
        {lines}
        <span ref={endRef} />
      </div>
      <div className="term-input-row">
        <span className="prompt-sym">❯</span>
        <input value={input} spellCheck={false}
          onChange={(ev) => setInput(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') { write(`${input}\n`); setInput(''); }
            else if (ev.key === 'c' && ev.ctrlKey) { control('\x03'); setInput(''); }
          }} />
        <button className="ibtn" title="Send Ctrl-C" onClick={() => control('\x03')}><Icon.X /></button>
      </div>
    </div>
  );
}

/* ============ Git panel ============ */

const GIT_CODE = { M: 'modified', A: 'added', D: 'deleted', '?': 'untracked', R: 'renamed', U: 'conflict' };

export function GitPanel({ active }) {
  const { status, refresh } = useGit(active);
  const [diff, setDiff] = useState('');
  const [commitMsg, setCommitMsg] = useState('');
  if (!status) return <div className="git-panel"><div className="git-empty">git unavailable</div></div>;
  if (!status.repo) return <div className="git-panel"><div className="git-empty">not a git repository</div></div>;

  const act = async (kind, path) => {
    try {
      if (kind === 'diff') setDiff((await api.git.diff({ pathspec: path })) || '(no unstaged diff)');
      else if (kind === 'stage') { await api.git.stage({ paths: [path] }); refresh(); }
      else if (kind === 'discard') {
        if (path.endsWith('/')) await api.git.discard({ paths: [] }); // guard: never bulk-discard dirs here
        else { await api.git.discard({ paths: [path] }); refresh(); }
      }
    } catch (err) { toast(err.message, 'err'); }
  };

  const commit = async () => {
    if (!commitMsg.trim()) return;
    try {
      const r = await api.git.commit(commitMsg);
      toast(r?.hash ? `committed ${String(r.hash).slice(0, 7)}` : 'committed', 'ok');
      setCommitMsg('');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  };

  return (
    <div className="git-panel">
      <div className="git-branch"><Icon.Git /> {status.branch}</div>
      {status.entries.length === 0 && <div className="git-empty">working tree clean</div>}
      {status.entries.map((en) => {
        const code = en.worktree === '?' || en.index === '?' ? '?' : (en.index ?? en.worktree);
        return (
          <div key={en.path} className="git-row">
            <span className={`git-code${code === '?' ? ' untracked' : ' changed'}`}>{code}</span>
            <span className="gpath">{en.path}</span>
            <span className="git-actions">
              <button className="ibtn" title="Diff" onClick={() => act('diff', en.path)}><Icon.File /></button>
              <button className="ibtn" title="Stage" onClick={() => act('stage', en.path)}><Icon.Plus /></button>
              <button className="ibtn danger" title="Discard" onClick={() => act('discard', en.path)}><Icon.Refresh /></button>
            </span>
          </div>
        );
      })}
      {status.entries.length > 0 && (
        <>
          <div className="git-commit-box">
            <input placeholder="commit message…" value={commitMsg}
              onChange={(ev) => setCommitMsg(ev.target.value)}
              onKeyDown={(ev) => ev.key === 'Enter' && commit()} />
            <button className="btn btn-primary btn-mini" onClick={commit}>Commit</button>
          </div>
          <button className="btn btn-secondary btn-mini" onClick={async () => {
            try { await api.git.stage({ paths: status.entries.map((x) => x.path) }); refresh(); } catch (err) { toast(err.message, 'err'); }
          }}>Stage all</button>
        </>
      )}
      {diff && <pre className="git-diff">{diff}</pre>}
    </div>
  );
}

/* ============ Prompt library dialog (★) ============ */

export function PromptLibrary({ composerText, onInsert, onClose }) {
  const [prompts, setPrompts] = useState(null);
  const refresh = async () => setPrompts(await api.prompts.list().catch(() => []));
  useEffect(() => { refresh(); }, []);
  const saveCurrent = async () => {
    if (!composerText?.trim()) { toast('composer is empty — type a prompt first', 'warn'); return; }
    await api.prompts.save({ body: composerText }).catch(() => {});
    toast('template saved', 'ok');
    refresh();
  };
  return (
    <div className="prompt-overlay" onClick={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="prompt-dialog">
        <header>
          <span>★ Prompt library</span>
          <button className="ibtn" title="Close" onClick={onClose}><Icon.X /></button>
        </header>
        <div className="prompt-list">
          {prompts === null && <div className="prompt-empty">loading…</div>}
          {prompts?.length === 0 && <div className="prompt-empty">No templates yet — write one in the composer and hit “Save current”.</div>}
          {prompts?.map((p) => (
            <div key={p.id} className="prompt-item" onClick={() => { onInsert(p.body); onClose(); }}>
              <div className="p-title"><span className="ellipsis">{p.title}</span>
                <button className="ibtn danger" title="Delete" onClick={(ev) => {
                  ev.stopPropagation();
                  api.prompts.remove({ id: p.id }).then(refresh).catch(() => {});
                }}><Icon.Trash /></button>
              </div>
              <div className="p-body">{p.body}</div>
            </div>
          ))}
        </div>
        <div style={{ padding: 12, borderTop: '1px solid var(--stroke-1)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary btn-mini" onClick={saveCurrent}>Save current composer text</button>
        </div>
      </div>
    </div>
  );
}


/* ============ Downloads panel: tracked browser downloads (GPA G7) ============ */

function fmtBytes(n) {
  const num = Number(n) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / 1024 / 1024).toFixed(1)} MB`;
  return `${(num / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function LibraryPanel({ active, sessionId }) {
  const [docs, setDocs] = useState([]);
  const [open, setOpen] = useState(null); // { id, title, visibility, content, dirty }
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setDocs(await api.library.list()); } catch { /* store not ready */ }
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const openDoc = async (row) => {
    try {
      const doc = await api.libraryPins.get({ id: row.id });
      setOpen({ ...doc, dirty: false });
    } catch (failure) { toast(failure.message, 'err'); }
  };
  const save = async () => {
    if (!open) return;
    setBusy(true);
    try {
      const saved = await api.libraryPins.save({ id: open.id, title: open.title, content: open.content, visibility: open.visibility });
      setOpen({ ...open, ...saved, dirty: false });
      await refresh();
      toast('document saved', 'ok');
    } catch (failure) { toast(failure.message, 'err'); }
    finally { setBusy(false); }
  };
  const createDoc = async () => {
    try {
      const saved = await api.libraryPins.save({ title: 'Untitled', content: '', visibility: 'private' });
      await refresh();
      setOpen({ ...saved, content: '', dirty: false });
    } catch (failure) { toast(failure.message, 'err'); }
  };
  const remove = async (row) => {
    try { await api.libraryPins.remove({ id: row.id }); if (open?.id === row.id) setOpen(null); await refresh(); }
    catch (failure) { toast(failure.message, 'err'); }
  };
  const toggleVisibility = async (row) => {
    try { await api.libraryPins.setVisibility({ id: row.id, visibility: row.visibility === 'shared' ? 'private' : 'shared' }); await refresh(); }
    catch (failure) { toast(failure.message, 'err'); }
  };

  if (open) {
    return (
      <div className="dock-tabpane library-pane" data-surface="library-editor">
        <div className="downloads-head">
          <button className="ibtn" title="Back" onClick={() => setOpen(null)}><Icon.ChevronRight /></button>
          <input className="lib-title" value={open.title} onChange={(e) => setOpen({ ...open, title: e.target.value, dirty: true })} />
          <button className="ibtn" title="Save" disabled={busy} onClick={save}><Icon.Check /></button>
        </div>
        <textarea className="lib-editor" value={open.content}
          onChange={(e) => setOpen({ ...open, content: e.target.value, dirty: true })} spellCheck={false} />
        {sessionId && null}
      </div>
    );
  }

  return (
    <div className="dock-tabpane library-pane" data-surface="library">
      <div className="downloads-head">
        <span className="surface-label">Library</span>
        <button className="ibtn" title="New document" onClick={createDoc}><Icon.Plus /></button>
      </div>
      {docs.length === 0 && <div className="downloads-empty">No documents yet. Ask the agent to save one, or create your own.</div>}
      {docs.map((d) => (
        <div className="download-row" key={d.id}>
          <button type="button" className="lib-name" title={d.id} onClick={() => openDoc(d)}>{d.title}</button>
          <span className="download-state">{d.visibility}</span>
          <button className="ibtn" title={d.visibility === 'shared' ? 'Make private' : 'Mark shareable'} onClick={() => toggleVisibility(d)}>
            {d.visibility === 'shared' ? <Icon.Eye /> : <Icon.EyeOff />}
          </button>
          <button className="ibtn" title="Delete" onClick={() => remove(d)}><Icon.Trash /></button>
        </div>
      ))}
    </div>
  );
}

/**
 * Artifacts — the interactive documents the agent built.
 *
 * Opening one hands it to the main process, which shows it in a sandboxed
 * window of its own (no app access, no network).
 */
export function ArtifactsPanel({ sessionId, active }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(null);   // { id, title, visibility, stateToken }

  const refresh = useCallback(async () => {
    try { setRows(await api.artifacts.list({ sessionId })); } catch { /* store not ready */ }
  }, [sessionId]);
  useEffect(() => {
    if (!active) return undefined;
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const open = async (row) => {
    setBusy(true);
    try { await api.artifacts.open({ id: row.id }); }
    catch (failure) { toast(failure.message, 'err'); }
    finally { setBusy(false); }
  };
  const remove = async (row) => {
    try { await api.artifacts.remove({ id: row.id }); setSharing(null); await refresh(); }
    catch (failure) { toast(failure.message, 'err'); }
  };
  const startShare = async (row) => {
    try {
      const share = await api.artifacts.share({ id: row.id });
      setSharing({ id: row.id, title: row.title, visibility: share?.access?.visibility ?? 'private', stateToken: share?.access?.stateToken ?? null });
    } catch (failure) { toast(failure.message, 'err'); }
  };
  const setVisibility = async (visibility) => {
    if (!sharing) return;
    try {
      await api.artifacts.setVisibility({ id: sharing.id, visibility });
      setSharing({ ...sharing, visibility });
      toast(`the artifact is now ${visibility}`, 'ok');
    } catch (failure) { toast(failure.message, 'err'); }
  };
  const exportShare = async () => {
    if (!sharing) return;
    try {
      const result = await api.artifacts.export({ id: sharing.id });
      await navigator.clipboard.writeText(result.path);
      toast('the share file was written — its path is on the clipboard', 'ok');
    } catch (failure) { toast(failure.message, 'err'); }
  };

  return (
    <div className="dock-tabpane artifacts-pane" data-surface="artifacts">
      <div className="downloads-head">
        <span className="surface-label">Artifacts</span>
        <button className="ibtn" title="Refresh" onClick={refresh}><Icon.Refresh /></button>
      </div>
      {rows.length === 0 && (
        <div className="downloads-empty">
          No artifacts yet. Ask the agent for something interactive — a chart, a calculator, a small tool.
        </div>
      )}
      {rows.map((row) => (
        <div className="download-row" key={row.id}>
          <button type="button" className="lib-name" title={row.id} onClick={() => open(row)}>{row.title}</button>
          <span className="download-state">{row.kind}</span>
          <PinBtn row={row} />
          <button className="ibtn" title="Share" onClick={() => startShare(row)}><Icon.Link /></button>
          <button className="ibtn" title="Open" disabled={busy} onClick={() => open(row)}><Icon.Popout /></button>
          <button className="ibtn" title="Delete" onClick={() => remove(row)}><Icon.Trash /></button>
        </div>
      ))}
      {sharing && (
        <div className="artifact-share" data-surface="artifact-share">
          <div className="artifact-share-head">
            <span className="artifact-share-title">{sharing.title}</span>
            <span style={{ flex: 1 }} />
            <button className="ibtn" title="Close" onClick={() => setSharing(null)}><Icon.X /></button>
          </div>
          <div className="artifact-share-row">
            <span className="artifact-share-label">Visible to</span>
            {['private', 'team-view', 'public'].map((visibility) => (
              <button
                key={visibility}
                type="button"
                className={`artifact-visibility${sharing.visibility === visibility ? ' active' : ''}`}
                onClick={() => setVisibility(visibility)}
              >{visibility}</button>
            ))}
          </div>
          <div className="artifact-share-row">
            <button className="btn" onClick={exportShare}>Write the share file</button>
            <span className="artifact-share-hint">one self-contained HTML file — no account, no server</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function DownloadsPanel({ sessionId, active }) {
  const [downloads, setDownloads] = useState([]);
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    const load = () => api.browser.downloads({ sessionId })
      .then((rows) => { if (alive) setDownloads(Array.isArray(rows) ? rows : []); })
      .catch(() => {});
    load();
    const off = events.on('browser', 'onDownload', ({ sessionId: sid, download }) => {
      if (!alive || sid !== sessionId || !download?.id) return;
      setDownloads((prev) => [download, ...prev.filter((d) => d.id !== download.id)]);
    });
    const timer = setInterval(load, 3000);
    return () => { alive = false; off(); clearInterval(timer); };
  }, [sessionId, active]);

  const clearDone = async () => {
    try { setDownloads(await api.browser.clearDownloads({ sessionId })); }
    catch (failure) { toast(failure.message, 'err'); }
  };

  return (
    <div className="dock-tabpane downloads-pane" data-surface="downloads">
      <div className="downloads-head">
        <span className="surface-label">Downloads</span>
        {downloads.some((d) => d.state !== 'progressing') && (
          <button className="ibtn" title="Clear finished downloads" onClick={clearDone}><Icon.Trash /></button>
        )}
      </div>
      {downloads.length === 0 && <div className="downloads-empty">No downloads yet. Files the browser saves land here.</div>}
      {downloads.map((d) => {
        const pct = d.totalBytes > 0 ? Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100)) : null;
        return (
          <div className="download-row" key={d.id} data-download={d.id} data-state={d.state}>
            <span className="download-name" title={d.savePath}>{d.filename}</span>
            <span className="download-state">
              {d.state === 'progressing' ? (pct == null ? fmtBytes(d.receivedBytes) : `${pct}%`) : d.state}
            </span>
            {d.state === 'progressing' && (
              <span className="download-bar"><span style={{ width: `${pct ?? 8}%` }} /></span>
            )}
            {d.state === 'completed' && (
              <>
                <button className="ibtn" title="Open" onClick={() => api.browser.openDownload({ sessionId, id: d.id }).catch((error) => toast(error.message, 'err'))}><Icon.File /></button>
                <button className="ibtn" title="Reveal in Finder" onClick={() => api.browser.revealDownload({ sessionId, id: d.id }).catch((error) => toast(error.message, 'err'))}><Icon.Popout /></button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
