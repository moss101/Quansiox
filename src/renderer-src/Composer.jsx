import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import { Icon } from './Icons.jsx';
import { api, toast, escapeHtml, renderMarkdown } from './lib.js';
import { APP_COMMANDS, findAppCommand, runAppCommand } from './commands.js';
import VoiceMemoBar from './VoiceMemoBar.jsx';
import { hasRevision, wordDiff } from './composerModel.js';

/* Session slash commands (restored v0.9 feature) */
const COMMANDS = [
  { cmd: '/new', title: 'New session', desc: 'start a fresh session', source: 'session' },
  { cmd: '/clear', title: 'Clear', desc: 'empty this session view', source: 'session' },
  { cmd: '/export', title: 'Export', desc: 'save transcript as Markdown', source: 'session' },
  { cmd: '/model', title: 'Model', desc: 'e.g. /model gpt-4o-mini', source: 'session' },
  { cmd: '/attach', title: 'Attach', desc: 'e.g. /attach /path/to/file', source: 'session' },
  { cmd: '/cost', title: 'Cost', desc: 'estimated session cost', source: 'session' },
  { cmd: '/stats', title: 'Stats', desc: 'session statistics', source: 'session' },
  { cmd: '/provider', title: 'Provider', desc: 'list / switch profiles', source: 'session' },
  { cmd: '/help', title: 'Help', desc: 'show all commands', source: 'session' },
];

/* The app's own commands (the menu, the panels, the settings) — offered as
 * slash commands too, so they can be reached without the mouse. */
const APP_ITEMS = APP_COMMANDS.map((c) => ({
  cmd: c.cmd, title: c.title, desc: c.desc, accel: c.accel, id: c.id, source: 'app',
}));

const CMD_ITEMS = [...COMMANDS, ...APP_ITEMS];

/** The count the footer shows: characters, lines, words. */
function measure(text) {
  const value = String(text ?? '');
  const lines = value.split(/\n+/).filter((l) => l.trim()).length;
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return { chars: value.length, lines: Math.max(lines, value.trim() ? 1 : 0), words };
}

export default function Composer({
  onSend, running, onStop, onAttach, attachments, onRemoveAttachment, onSnap,
  onCommand, fileEntries, onOpenPrompts, editorRef, suppressSaveRef, onDraftChange,
  dictating = false, onToggleDictation, voiceMode = false, onToggleVoiceMode, liveVoice = false, onToggleLiveVoice,
  replyTo = null, onClearReply,
  onDropFiles, onDiscard, onMemo, onTranscript,
  memoOpen = false, onToggleMemo, previewOpen = false, onTogglePreview,
  revisingOf = null, onClearRevision,
}) {
  const [popup, setPopup] = useState(null); // { kind:'cmd'|'mention', query, sel }
  const [files, setFiles] = useState([]);
  const [agents, setAgents] = useState([]);
  const [text, setText] = useState('');
  const [lastSent, setLastSent] = useState('');
  const [dragDepth, setDragDepth] = useState(0);
  const popupRef = useRef(null);
  popupRef.current = popup;

  // Fuzzy-matchable file list for @mentions.
  useEffect(() => {
    setFiles((fileEntries ?? []).map((en) => en.path).filter((p) => typeof p === 'string' && !p.endsWith('/')).slice(0, 400));
  }, [fileEntries]);

  // The agents of this install are mentionable too. A missing bridge (or an
  // install without agents) is not an error — the list is simply empty.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const rows = await api.agents.list();
        if (alive) setAgents(Array.isArray(rows) ? rows : []);
      } catch {
        if (alive) setAgents([]);
      }
    };
    load();
    return () => { alive = false; };
  }, []);

  // The mention candidates: the agents first, then the workspace files.
  const mentionItems = useMemo(() => {
    const q = String(popup?.query ?? '').toLowerCase();
    if (popup?.kind !== 'mention') return [];
    const agentRows = agents
      .filter((a) => !q || `${a.name ?? ''} ${a.description ?? ''}`.toLowerCase().includes(q))
      .slice(0, 6)
      .map((a) => ({
        kind: 'agent',
        id: a.id,
        label: a.name ?? a.id,
        detail: a.primary ? 'primary agent' : (a.description || 'agent'),
      }));
    const fileRows = files
      .filter((f) => !q || f.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({ kind: 'file', id: f, label: f, detail: 'file' }));
    return [...agentRows, ...fileRows];
  }, [agents, files, popup]);

  const matches = (p) => {
    if (!p) return [];
    if (p.kind === 'cmd') {
      const q = (p.query ?? '').toLowerCase();
      const base = q.split(' ')[0];
      return CMD_ITEMS.filter((c) => c.cmd.slice(1).startsWith(base) || c.title.toLowerCase().includes(q));
    }
    return mentionItems;
  };
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const e = useEditor({
    extensions: [
      StarterKit.configure({ heading: false }),
      Placeholder.configure({ placeholder: 'Message Quansiox…' }),
      // A mention is a real inline node, not a piece of text: the popup
      // below is the only suggestion UI (the extension's own renderer is
      // left empty on purpose).
      Mention.configure({
        HTMLAttributes: { class: 'mention-token' },
        suggestion: { char: '@', items: () => [], decorationClass: 'mention-query' },
      }),
    ],
    onCreate: ({ editor }) => { if (editorRef) editorRef.current = editor; },
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submitRef.current();
          return true;
        }
        const p = popupRef.current;
        if (p && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
          if (event.key === 'Escape') { setPopup(null); return true; }
          if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickRef.current(p.sel); return true; }
          event.preventDefault();
          const len = matchesRef.current(p).length;
          setPopup((cur) => (cur && { ...cur, sel: Math.max(0, Math.min(len - 1, cur.sel + (event.key === 'ArrowDown' ? 1 : -1))) }));
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const $pos = ed.state.selection.$from;
      const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, undefined, '\ufffc');
      const m = /(^|\s)([/@])([\w./-]*)$/.exec(textBefore);
      if (m) {
        const kind = m[2] === '/' ? 'cmd' : 'mention';
        setPopup((cur) => (cur && cur.kind === kind && cur.query === m[3]
          ? cur
          : { kind, query: m[3], sel: 0 }));
      } else {
        // Unconditional: popupRef can be stale during chained programmatic
        // commands, so a null-check could skip clearing a just-opened popup.
        setPopup(null);
      }
      setText(ed.getText());
      // Draft persistence: emit the current text for an autosave, unless this
      // update is the tail of a programmatic restore (suppressed once).
      if (suppressSaveRef?.current) { suppressSaveRef.current = false; return; }
      onDraftChange?.(ed.getText());
    },
  });

  const submit = () => {
    if (!e) return;
    const body = e.getText().trim();
    if (!body) return;
    e.commands.clearContent();
    setPopup(null);
    setText('');
    if (body.startsWith('/')) {
      // The app's own commands run here; the session commands go to the
      // host, which owns their behaviour. A command is not a draft, so it
      // does not become the revision baseline.
      const app = findAppCommand(body);
      if (app) {
        const ok = runAppCommand(app.id);
        if (!ok) toast(`${app.title} is not available right now`, 'warn');
        return;
      }
      onCommand?.(body);
      return;
    }
    setLastSent(body);
    onClearRevision?.();
    onSend(body, attachments, replyTo ?? undefined);
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const pick = (idx) => {
    const p = popupRef.current;
    if (!e || !p) return;
    const list = matchesRef.current(p);
    const item = list[idx] ?? list[0];
    if (!item) return;
    const caret = e.state.selection.from;
    const from = Math.max(0, caret - (p.query?.length ?? 0) - 1);
    const chain = e.chain().focus().deleteRange({ from, to: caret });
    if (p.kind === 'cmd') {
      chain.insertContent(`${item.cmd} `).run();
    } else {
      // The mention replaces the trigger text with an inline token.
      chain.insertContent([
        { type: 'mention', attrs: { id: item.id, label: item.label } },
        { type: 'text', text: ' ' },
      ]).run();
    }
    setPopup(null);
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const list = popup ? matches(popup) : [];
  const counts = measure(text);
  // The draft was revised: it no longer matches the last thing we sent.
  // Nothing is marked before the first send — there is no draft to revise.
  const revised = lastSent !== '' && text.trim() !== '' && text !== lastSent;
  const canSend = text.trim() !== '';

  // Drag-and-drop attach (P2.3): a depth counter survives enter/leave of
  // child elements; files go through the same ingestion as the picker.
  const dragging = dragDepth > 0;
  const onDragEnter = (ev) => {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    setDragDepth((d) => d + 1);
  };
  const onDragLeave = () => setDragDepth((d) => Math.max(0, d - 1));
  const onDragOver = (ev) => { if (ev.dataTransfer?.types?.includes('Files')) ev.preventDefault(); };
  const onDrop = (ev) => {
    if (!ev.dataTransfer?.files?.length) { setDragDepth(0); return; }
    ev.preventDefault();
    setDragDepth(0);
    onDropFiles?.(Array.from(ev.dataTransfer.files));
  };

  // The markdown preview. When revising a sent message, changed words are
  // highlighted (ins/del) against the original — Grok's draft-revision
  // highlighter, word-level by design.
  const revision = hasRevision(revisingOf, text);
  const previewHtml = useMemo(() => {
    if (!previewOpen) return '';
    if (revision) {
      const runs = wordDiff(revisingOf, text)
        .map((r) => r.type === 'ins' ? `<ins>${escapeHtml(r.text)}</ins>`
          : r.type === 'del' ? `<del>${escapeHtml(r.text)}</del>`
          : escapeHtml(r.text))
        .join('\n');
      return `<p class="diff-line">${runs}</p>`;
    }
    return renderMarkdown(text);
  }, [previewOpen, revision, revisingOf, text]);

  const discard = () => {
    if (!e) return;
    e.commands.clearContent();
    setPopup(null);
    onClearRevision?.();
    onDiscard?.();
  };

  return (
    <div className="composer-wrap">
      {replyTo && (
        <div className="composer-reply" data-surface="composer-reply">
          <span className="composer-reply-icon"><Icon.Reply /></span>
          <span className="composer-reply-main">
            <span className="composer-reply-author">Replying to {replyTo.author}</span>
            <span className="composer-reply-text">{replyTo.preview}</span>
          </span>
          <button type="button" className="ibtn" title="Cancel reply (Esc)" aria-label="Cancel reply"
            onClick={onClearReply}><Icon.X /></button>
        </div>
      )}
      <div className="attachments" data-surface="composer-attachments">
        {attachments.map((a, i) => (
          <span className="attachment-chip" key={`${a.name}-${i}`} title={a.path ?? a.name}>
            <span>{a.name}</span>
            {a.size ? <span className="attachment-size">{Math.max(1, Math.round(a.size / 1024))} KB</span> : null}
            <button type="button" title="Remove attachment" aria-label={`Remove ${a.name}`}
              onClick={() => onRemoveAttachment(i)}>✕</button>
          </span>
        ))}
      </div>
      {revisingOf !== null && (
        <div className="composer-reply composer-revision" data-surface="composer-revision">
          <span className="composer-reply-icon"><Icon.Undo /></span>
          <span className="composer-reply-main">
            <span className="composer-reply-author">Editing a sent message</span>
            <span className="composer-reply-text">changed words are highlighted in the preview</span>
          </span>
          <button type="button" className="ibtn" title="Stop editing (keep the text)" aria-label="Stop editing"
            onClick={onClearRevision}><Icon.X /></button>
        </div>
      )}
      {memoOpen ? (
        <VoiceMemoBar onMemo={onMemo} onTranscript={onTranscript} onClose={onToggleMemo} />
      ) : null}
      <div className="composer-box"
        onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
        {dragging ? (
          <div className="drop-overlay" data-surface="drop-overlay" aria-live="polite">
            <Icon.Paperclip />
            <span>Drop to attach</span>
          </div>
        ) : null}
        {popup && list.length > 0 && (
          <div className="cmd-popup" role="listbox"
            aria-label={popup.kind === 'cmd' ? 'Commands' : 'Mentions'}
            aria-activedescendant={`composer-option-${popup.sel}`}>
            {list.map((item, i) => (
              <div key={item.id ?? item.cmd ?? item.label ?? String(i)} id={`composer-option-${i}`}
                role="option" aria-selected={i === popup.sel}
                className={`cmd-item${i === popup.sel ? ' sel' : ''}`}
                onMouseEnter={() => setPopup((p) => ({ ...p, sel: i }))}
                onMouseDown={(ev) => { ev.preventDefault(); pick(i); }}>
                <span className="ci-icon">
                  {popup.kind === 'cmd' ? <Icon.Command /> : (item.kind === 'agent' ? <Icon.Sparkle /> : <Icon.File />)}
                </span>
                <span className="ci-main">
                  <span className="ci-title">
                    {popup.kind === 'cmd'
                      ? <><span className="mono">{item.cmd}</span>{item.title}</>
                      : <span className="mono">{item.label}</span>}
                  </span>
                  {popup.kind === 'cmd'
                    ? <span className="ci-desc">{item.desc}</span>
                    : <span className="ci-desc">{item.detail}</span>}
                </span>
                {popup.kind === 'cmd' && item.accel ? <span className="ci-accel">{item.accel}</span> : null}
                {popup.kind === 'cmd' && item.source === 'app' ? <span className="ci-badge">app</span> : null}
              </div>
            ))}
          </div>
        )}
        <div className="composer-box-inner">
          <button type="button" className="cbtn composer-plus" onClick={onAttach} title="Attach files"
            aria-label="Attach files"><Icon.Plus /></button>
          <div className={`composer editor${previewOpen ? ' is-previewing' : ''}`}>
            <EditorContent editor={e} />
          </div>
          {previewOpen ? (
            <div className="composer-preview" data-surface="composer-preview"
              aria-label="Draft preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          ) : null}
          <div className="composer-bar">
            <button type="button" className={`cbtn composer-mic${dictating ? ' recording' : ''}`} data-surface="composer-mic"
              onClick={onToggleDictation} aria-pressed={dictating}
              title={dictating ? 'Stop dictation (⌘D)' : 'Dictate (⌘D)'} aria-label="Dictate">
              {dictating ? <Icon.Dot /> : <Icon.Mic />}
            </button>
            <button type="button" className={`cbtn composer-live-voice${liveVoice ? ' active' : ''}`} data-surface="composer-live-voice"
              onClick={onToggleLiveVoice} aria-pressed={liveVoice}
              title={liveVoice ? 'Live voice loop on — talk to the agent (click to stop)' : 'Live voice loop — talk to the agent'}
              aria-label="Live voice">
              <Icon.Mic />
            </button>
            <button type="button" className={`cbtn composer-voice${voiceMode ? ' active' : ''}`} data-surface="composer-voice"
              onClick={onToggleVoiceMode} aria-pressed={voiceMode}
              title={voiceMode ? 'Voice chat on — replies play aloud (click to turn off)' : 'Voice chat — play replies aloud after each turn'}
              aria-label="Voice chat">
              <Icon.Speaker />
            </button>
            <button type="button" className="cbtn" onClick={onSnap} title="Screenshot → attach"
              aria-label="Screenshot"><Icon.Camera /></button>
            <button type="button" className={`cbtn composer-memo${memoOpen ? ' active' : ''}`} data-surface="composer-memo"
              onClick={onToggleMemo} aria-pressed={memoOpen}
              title={memoOpen ? 'Hide voice memo bar' : 'Record a voice memo'}
              aria-label="Voice memo"><Icon.Mic /></button>
            <button type="button" className={`cbtn composer-preview-btn${previewOpen ? ' active' : ''}`} data-surface="composer-preview-toggle"
              onClick={onTogglePreview} aria-pressed={previewOpen} disabled={!text.trim()}
              title={revision ? 'Preview markdown — edited words are highlighted' : 'Preview markdown'}
              aria-label="Preview markdown"><Icon.File /></button>
            {revisingOf !== null && text.trim() !== '' ? (
              <button type="button" className="cbtn" data-surface="composer-discard" onClick={discard}
                title="Discard draft (editor + saved copy)" aria-label="Discard draft"><Icon.Trash /></button>
            ) : null}
            <button type="button" className="cbtn" onClick={onOpenPrompts} title="Prompt library (save / insert templates)"
              aria-label="Prompt library"><Icon.Star /></button>
            {running
              ? (
                <>
                  <button type="button" className="send-btn" onClick={submit}
                    title="Send — queues behind the current turn (⌘↵)"><Icon.Send /></button>
                  <button type="button" className="stop-btn" onClick={onStop} title="Stop"><Icon.Stop /></button>
                </>
              )
              : <button type="button" className="send-btn" onClick={submit} title="Send (⌘↵)"><Icon.Send /></button>}
          </div>
        </div>
      </div>
      <div className="composer-hint">
        <span className="composer-hint-keys">
          <kbd>⌘↵</kbd> send · <kbd>/</kbd> commands · <kbd>@</kbd> mentions · <kbd>⌘D</kbd> dictate · <kbd>⌘.</kbd> panels
        </span>
        <span className="composer-hint-stats">
          {revised ? (
            <span className="composer-revised" data-surface="composer-revised"
              title="This draft differs from the last one you sent">● edited</span>
          ) : null}
          <span className="composer-count" data-surface="composer-count"
            title="Characters · lines · words in this draft">
            {counts.chars} chars · {counts.lines} {counts.lines === 1 ? 'line' : 'lines'} · {counts.words} words
          </span>
          <span className="composer-send-hint">
            {canSend ? '⌘↵ to send' : 'write something to send'}
          </span>
        </span>
      </div>
    </div>
  );
}
