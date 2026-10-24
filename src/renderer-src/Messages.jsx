import { useEffect, useState } from 'react';
import { renderMarkdown, relTime, playVoiceMemo, stopVoiceMemo, onVoiceMemo, toast } from './lib.js';
import { Icon } from './Icons.jsx';

function CopyBtn({ getText, title = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button className="ibtn" title={title} onClick={async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(getText()); } catch {}
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    }}>
      {done ? <Icon.Check /> : <Icon.Copy />}
    </button>
  );
}

/** Voice memo: read a bot message aloud with the session's local TTS voice. */
function SpeakBtn({ text, sessionId, memoKey }) {
  const [memo, setMemo] = useState({ state: 'idle', key: null });
  useEffect(() => onVoiceMemo(setMemo), []);
  const active = memo.key === memoKey && memo.state !== 'idle';
  const busy = active && memo.state === 'loading';
  return (
    <button className={`ibtn msg-speak${active ? ' active' : ''}`} data-surface="voice-memo"
      aria-pressed={active}
      title={active ? 'Stop voice memo' : 'Play as voice memo (local TTS)'}
      onClick={(e) => {
        e.stopPropagation();
        if (active) { stopVoiceMemo(); return; }
        playVoiceMemo({ key: memoKey, text, sessionId, onError: (err) => toast(err?.message ?? String(err), 'err') });
      }}>
      {busy ? <Icon.Dot /> : active ? <Icon.Stop /> : <Icon.Speaker />}
    </button>
  );
}

const AVATAR = { user: 'Y', assistant: 'Q', error: '!' };
const AUTHOR = { user: 'You', assistant: 'Quansiox', error: 'Error' };

/** Docs reaction set (lightweight acknowledgement). */
export const REACTION_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

/** Hover picker: react with one emoji (single-user app → toggle semantics). */
function ReactBtn({ my = [], onReact }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  return (
    <span className="react-wrap">
      <button type="button" className={`ibtn msg-react${my.length ? ' active' : ''}`} data-surface="msg-react"
        title="React to this message" aria-label="React"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <Icon.Smile />
      </button>
      {open && (
        <span className="reaction-picker" data-surface="reaction-picker" onClick={(e) => e.stopPropagation()}>
          {REACTION_EMOJI.map((emoji) => (
            <button type="button" key={emoji} className={`reaction-pick${my.includes(emoji) ? ' on' : ''}`}
              onClick={(e) => { e.stopPropagation(); onReact(emoji); setOpen(false); }}>{emoji}</button>
          ))}
        </span>
      )}
    </span>
  );
}

export function MessageRow({
  kind, text, at, onRetry, search = '', trailing, speak, author, activeMatch = null,
  id, replyTo, reactions = [], onReply, onReact, onJumpTo, onSteer, onRollback, threadCount = 0, onOpenThread, onEdit,
}) {
  const highlighted = Boolean(search) && text.toLowerCase().includes(search.toLowerCase());
  const isActiveMatch = highlighted && id != null && id === activeMatch;
  const canReact = Boolean(id && onReact);
  const displayAuthor = author || AUTHOR[kind] || kind;
  return (
    <div className={`msg-row ${kind}${highlighted ? ' highlight' : ''}${isActiveMatch ? ' is-active-match' : ''}`} data-message-id={id || undefined}>
      <div className="msg-avatar">{(author ? String(author)[0] : AVATAR[kind]) ?? '?'}</div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-author">{displayAuthor}</span>
          <span className="msg-time">{relTime(at)}</span>
        </div>
        {replyTo && (
          <button type="button" className="msg-quote" data-surface="msg-quote"
            title="Go to the message this replies to"
            onClick={(e) => { e.stopPropagation(); onJumpTo?.(replyTo.messageId); }}>
            <Icon.Reply />
            <span className="msg-quote-author">{replyTo.author || 'Message'}</span>
            <span className="msg-quote-text">{replyTo.preview}</span>
          </button>
        )}
        <div className="msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        {reactions.length > 0 && (
          <div className="msg-reactions">
            {reactions.map((emoji) => (
              <button type="button" key={emoji} className="reaction-chip" data-surface="reaction-chip"
                title="Toggle reaction" aria-pressed="true"
                onClick={(e) => { e.stopPropagation(); onReact?.(emoji); }}>{emoji}</button>
            ))}
          </div>
        )}
        {trailing}
      </div>
      <div className="msg-actions">
        {threadCount > 0 && (
          <button type="button" className="ibtn msg-thread-btn" data-surface="msg-thread"
            title={`${threadCount} ${threadCount === 1 ? 'reply' : 'replies'} in this thread`}
            onClick={(e) => { e.stopPropagation(); onOpenThread?.(); }}>
            <Icon.Reply /> {threadCount}
          </button>
        )}
        {canReact && <ReactBtn my={reactions} onReact={(emoji) => onReact(emoji)} />}
        {id && onReply && (
          <button type="button" className="ibtn msg-reply-btn" data-surface="msg-reply"
            title="Reply to this message" aria-label="Reply"
            onClick={(e) => { e.stopPropagation(); onReply(); }}><Icon.Reply /></button>
        )}
        {speak && <SpeakBtn text={text} sessionId={speak.sessionId} memoKey={speak.memoKey} />}
        <CopyBtn getText={() => text} />
        {id && onRollback && (
          <button className="ibtn msg-rollback-btn" data-surface="msg-rollback"
            title="Roll back: remove this message and everything after it"
            aria-label="Roll back to here"
            onClick={(e) => { e.stopPropagation(); onRollback(); }}><Icon.Undo /></button>
        )}
        {kind === 'user' && onEdit && (
          <button type="button" className="ibtn msg-edit-btn" data-surface="msg-edit"
            title="Edit: load this message into the composer with revision highlighting"
            aria-label="Edit message"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}><Icon.Undo /></button>
        )}
        {kind === 'user' && onRetry && (
          <button className="ibtn" title="Retry this turn" onClick={onRetry}><Icon.Refresh /></button>
        )}
      </div>
    </div>
  );
}

export const UserMessage = ({ text, at, onRetry, search, activeMatch, queued, id, replyTo, reactions, onReply, onReact, onJumpTo, onSteer, onRollback, threadCount, onOpenThread, onEdit }) => (
  <MessageRow kind="user" text={text} at={at} onRetry={onRetry} search={search} activeMatch={activeMatch}
    id={id} replyTo={replyTo} reactions={reactions} onReply={onReply} onReact={onReact} onJumpTo={onJumpTo}
    onRollback={onRollback} threadCount={threadCount} onOpenThread={onOpenThread} onEdit={onEdit}
    trailing={queued
      ? (
        <span className="msg-queued-wrap">
          <span className="msg-queued" data-surface="msg-queued">Queued</span>
          {onSteer && (
            <button type="button" className="msg-steer" data-surface="msg-steer"
              title="Redirect: stop the current turn and run this message now"
              onClick={(e) => { e.stopPropagation(); onSteer(); }}>Send now</button>
          )}
        </span>
      )
      : null} />
);
export const AssistantMessage = ({ text, at, search, activeMatch, sessionId, memoKey, id, reactions, author, onReply, onReact, onJumpTo, threadCount, onOpenThread }) => (
  <MessageRow kind="assistant" text={text} at={at} search={search} author={author} activeMatch={activeMatch}
    id={id} reactions={reactions} onReply={onReply} onReact={onReact} onJumpTo={onJumpTo}
    threadCount={threadCount} onOpenThread={onOpenThread}
    speak={sessionId ? { sessionId, memoKey: memoKey ?? `msg:${at}:${text.slice(0, 24)}` } : undefined} />
);
export const ErrorMessage = ({ text }) => <MessageRow kind="error" text={text} at={Date.now()} />;

export function StreamingMessage({ text }) {
  return (
    <div className="msg-row assistant streaming">
      <div className="msg-avatar">Q</div>
      <div className="msg-body">
        <div className="msg-head"><span className="msg-author">Quansiox</span><span className="msg-time">writing…</span></div>
        <div className="msg-text"><span dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} /><span className="cursor-blink" /></div>
      </div>
    </div>
  );
}

/* tool metadata: icon + friendly label */
const TOOL_META = {
  shell: { icon: Icon.Terminal, label: 'Shell' },
  read_file: { icon: Icon.File, label: 'Read' },
  write_file: { icon: Icon.Edit, label: 'Write' },
  list_dir: { icon: Icon.Folder, label: 'List' },
  update_plan: { icon: Icon.ListChecks, label: 'Plan' },
  computer_screenshot: { icon: Icon.Camera, label: 'Screenshot' },
  computer_ax_tree: { icon: Icon.ListChecks, label: 'AX tree' },
  computer_click: { icon: Icon.Zap, label: 'Click' },
  computer_type: { icon: Icon.Edit, label: 'Type' },
  computer_key: { icon: Icon.Command, label: 'Key' },
  computer_open_app: { icon: Icon.Popout, label: 'Open app' },
  computer_list_apps: { icon: Icon.Globe, label: 'Apps' },
};

export function ToolCard({ name, args, output, image }) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[name] ?? { icon: Icon.Terminal, label: name };
  const ToolIcon = meta.icon;
  const isCu = name.startsWith('computer_');
  const completed = output !== null && output !== undefined;
  const err = typeof output === 'string' && /^error:/i.test(output.trim());
  return (
    <div className={`tool-call${completed ? '' : ' running'}${isCu ? ' cu-tool' : ''}${err ? ' err' : ''}`}>
      <header onClick={() => setOpen(!open)}>
        <span className="tool-icon"><ToolIcon /></span>
        <span className="tool-name">{meta.label ?? name}</span>
        <span className="tool-args">{args}</span>
        {completed
          ? <span className={`tool-status${err ? ' fail' : ' ok'}`}>{err ? '✕ failed' : '✓ done'}</span>
          : <span className="tool-status"><span className="spinner" /> running</span>}
        <span style={{ color: 'var(--text-3)', display: 'grid', placeItems: 'center' }}>
          {open ? <Icon.ChevronDown /> : <Icon.ChevronRight />}
        </span>
      </header>
      {image && <img className="tool-screenshot" src={image} alt="agent screenshot" />}
      {completed && open && <pre>{output || '(No output)'}</pre>}
    </div>
  );
}

export function PlanCard({ steps }) {
  return (
    <div className="plan-card">
      <div className="plan-title"><Icon.ListChecks /> Plan</div>
      {steps.map((step, i) => (
        <div key={i} className={`plan-step ${step.status ?? 'pending'}`}>
          <span className="mark">{step.status === 'done' ? <Icon.Check /> : null}</span>
          <span>{step.title}</span>
        </div>
      ))}
    </div>
  );
}
