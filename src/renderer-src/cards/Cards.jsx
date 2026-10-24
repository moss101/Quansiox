import React, { useMemo, useState } from 'react';
import { api } from '../lib.js';
import { Icon } from '../Icons.jsx';
import { KIND, RESOLUTION, RENDER, describeCard, isPending } from './registry.js';

/**
 * The card components.
 *
 * Every card kind the agent can emit is rendered here, from one registry.
 * The components are deliberately plain: a card is a small surface with a
 * title, some fields and (sometimes) a decision.
 */

function Field({ label, value }) {
  if (value == null || value === '') return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (
    <div className="card-field" data-field={label}>
      <span className="card-field-label">{label}</span>
      <span className="card-field-value">{text.slice(0, 600)}</span>
    </div>
  );
}

/** The approve/deny row every approval card shares. */
function Decision({ entry, onDone, children }) {
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(null);
  const pending = isPending(describeCard(entry.kind, entry.type), entry.resolution);

  const answer = async (approved, scope = 'once') => {
    setBusy(true);
    try {
      if (entry.resolutionId) {
        await api.confirmations.respond({ id: entry.resolutionId, approved, scope });
      } else if (entry.interactionId) {
        if (approved) await api.interactions.submitForm({ entryId: entry.interactionId, values: entry.values ?? {} });
        else await api.interactions.dismissForm({ entryId: entry.interactionId, mode: 'denied' });
      }
      setDecided(approved ? 'allowed' : 'denied');
      onDone?.(approved);
    } catch (error) {
      setDecided('error');
    } finally {
      setBusy(false);
    }
  };

  if (decided) {
    return (
      <div className="card-outcome" data-outcome={decided}>
        <span className="card-outcome-icon">{decided === 'allowed' ? <Icon.Check /> : <Icon.X />}</span>
        <span>{decided === 'allowed' ? 'Allowed' : decided === 'denied' ? 'Denied' : 'Could not be answered'}</span>
      </div>
    );
  }
  if (!pending) {
    // A settled card shows WHAT happened, not the buttons that would have
    // produced a different outcome.
    const text = entry.resolution?.text
      ?? entry.resolution?.reason
      ?? (entry.resolution?.state ? `Settled — ${entry.resolution.state}` : 'Settled');
    return (
      <div className="card-outcome" data-outcome="settled">
        <span>{text}</span>
      </div>
    );
  }
  return (
    <div className="card-actions">
      {children}
      <button className="btn btn-primary" disabled={busy} onClick={() => answer(true, 'once')}>Allow once</button>
      <button className="btn btn-secondary" disabled={busy} onClick={() => answer(true, 'always')}>Always allow</button>
      <button className="btn btn-danger" disabled={busy} onClick={() => answer(false, 'once')}>Deny</button>
    </div>
  );
}

/** A multiple-choice widget. */
function Widget({ entry, onDone }) {
  const [busy, setBusy] = useState(false);
  const widget = entry.payload?.widget ?? {};
  const options = Array.isArray(widget.options) ? widget.options : [];
  if (!options.length) return null;
  const answer = async (option) => {
    setBusy(true);
    try {
      await api.interactions.respondWidget({ id: entry.interactionId, value: option.value ?? option });
      onDone?.();
    } catch { /* the card stays pending */ } finally { setBusy(false); }
  };
  return (
    <div className="card-actions" data-surface="widget-options">
      {options.map((option) => (
        <button key={String(option.value ?? option)} className="btn btn-secondary" disabled={busy}
          onClick={() => answer(option)}>
          {option.label ?? option.title ?? String(option.value ?? option)}
        </button>
      ))}
    </div>
  );
}

/** A structured form. */
function Form({ entry, onDone }) {
  const request = entry.payload?.formRequest ?? {};
  const fields = Array.isArray(request.fields) ? request.fields : [];
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  if (!fields.length) return null;
  const submit = async () => {
    setBusy(true);
    try {
      await api.interactions.submitForm({ entryId: entry.interactionId, values });
      onDone?.();
    } catch { /* the card stays pending */ } finally { setBusy(false); }
  };
  return (
    <div className="card-form" data-surface="card-form">
      {fields.map((field) => (
        <label key={field.name} className="card-form-field">
          <span>{field.label ?? field.name}</span>
          {field.type === 'checkbox' ? (
            <input type="checkbox" checked={Boolean(values[field.name])} onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.checked }))} />
          ) : (
            <input
              type={field.type === 'password' ? 'password' : 'text'}
              value={values[field.name] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
            />
          )}
        </label>
      ))}
      <div className="card-actions">
        <button className="btn btn-primary" disabled={busy} onClick={submit}>Send</button>
        <button className="btn btn-danger" disabled={busy}
          onClick={() => api.interactions.dismissForm({ entryId: entry.interactionId, mode: 'dismissed' }).then(() => onDone?.())}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** A draft the user edits and sends. */
function Draft({ entry, onDone, kind }) {
  const draft = entry.payload?.draft ?? {};
  const [text, setText] = useState(draft.body ?? '');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.interactions.sendDraft?.({ id: entry.interactionId, draft: { ...draft, body: text } });
      onDone?.();
    } catch { /* the card stays pending */ } finally { setBusy(false); }
  };
  return (
    <div className="card-draft" data-surface={`card-draft-${kind}`}>
      <Field label="to" value={draft.to ?? draft.target ?? draft.workspace} />
      <Field label="subject" value={draft.subject ?? draft.thread} />
      <textarea className="card-draft-body" value={text} onChange={(e) => setText(e.target.value)} rows={6} />
      <div className="card-actions">
        <button className="btn btn-primary" disabled={busy} onClick={send}>Send</button>
        <button className="btn btn-danger" disabled={busy}
          onClick={() => api.interactions.dismissDraft?.({ id: entry.interactionId }).then(() => onDone?.())}>
          Discard
        </button>
      </div>
    </div>
  );
}

/** A secret the user is asked to provide. */
function SecretRequest({ entry, onDone }) {
  const request = entry.payload?.secretRequest ?? {};
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.interactions.submitSecret?.({ id: entry.interactionId, value, name: request.label });
      onDone?.();
    } catch { /* the card stays pending */ } finally { setBusy(false); }
  };
  return (
    <div className="card-secret" data-surface="card-secret">
      <p>{request.description ?? request.label ?? 'The agent needs a secret.'}</p>
      <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" />
      <div className="card-actions">
        <button className="btn btn-primary" disabled={busy || !value} onClick={submit}>Provide</button>
        <button className="btn btn-danger" disabled={busy}
          onClick={() => api.interactions.dismissSecret?.({ id: entry.interactionId }).then(() => onDone?.())}>
          Skip
        </button>
      </div>
    </div>
  );
}

/** The calendar event card. */
function CalendarEvent({ entry, onDone }) {
  const event = entry.payload?.event ?? {};
  const when = event.startMs
    ? new Date(Number(event.startMs)).toLocaleString()
    : (event.subject ?? '');
  return (
    <>
      <Field label="subject" value={event.subject} />
      <Field label="when" value={when} />
      <Field label="guests" value={event.guests} />
      <Field label="location" value={event.location?.name ?? event.location?.address} />
      <Decision entry={entry} onDone={onDone} />
    </>
  );
}

/** The voice call card. */
function VoiceCall({ payload }) {
  const call = payload?.call ?? {};
  const minutes = Math.floor((Number(call.durationMs) || 0) / 60000);
  const seconds = Math.floor(((Number(call.durationMs) || 0) % 60000) / 1000);
  return (
    <div className="card-voice-call" data-surface="card-voice-call">
      <Icon.Command />
      <span>{minutes}:{String(seconds).padStart(2, '0')}</span>
      {call.ending ? <span className="card-voice-ending">{call.ending}</span> : null}
    </div>
  );
}

/** The feedback card. */
function Feedback({ payload }) {
  return (
    <div className="card-feedback" data-surface="card-feedback">
      <Field label="state" value={payload?.state} />
      <Field label="sentiment" value={payload?.sentiment} />
    </div>
  );
}

/** The MCP app card: an embedded application frame. */
function McpApp({ payload }) {
  const uri = payload?.resourceUri ?? '';
  if (!uri) return null;
  return (
    <div className="card-mcp-app" data-surface="card-mcp-app">
      <iframe className="card-mcp-frame" title="app" src={uri} sandbox="allow-scripts allow-same-origin" />
    </div>
  );
}

/** The user attachment card. */
function UserAttachment({ payload }) {
  const file = payload?.file_path ?? '';
  if (!file) return null;
  return (
    <div className="card-attachment" data-surface="card-attachment">
      <Icon.File />
      <span>{file.split('/').pop()}</span>
    </div>
  );
}

/** The bot template share card. */
function BotTemplateShare({ entry, payload, onDone }) {
  return (
    <>
      <Field label="name" value={payload?.name} />
      <p className="card-body">{String(payload?.body ?? '').slice(0, 600)}</p>
      <Decision entry={entry} onDone={onDone} />
    </>
  );
}

/** The auto-review approval card: it can offer the rule it would add. */
function AutoReviewApproval({ entry, payload, onDone }) {
  const approval = payload?.approval ?? {};
  const rule = approval.proposedAllowRule ?? approval.command ?? null;
  return (
    <>
      <Field label="surface" value={approval.surface} />
      <Field label="action" value={approval.command ?? approval.action} />
      {rule ? <p className="card-hint">Approving also allows: <code>{rule}</code></p> : null}
      <Decision entry={entry} onDone={onDone} />
    </>
  );
}

/** The local-tool permission card: it names the action and the target. */
function LocalToolPermission({ entry, payload, onDone }) {
  const ask = payload?.ask ?? {};
  return (
    <>
      <Field label="action" value={ask.action} />
      <Field label="target" value={ask.target} />
      <Field label="description" value={ask.description} />
      <Field label="on" value={ask.recipientName ?? ask.machineLabel} />
      <Decision entry={entry} onDone={onDone} />
    </>
  );
}

/** The app-secrets request card. */
function AppSecrets({ entry, payload, onDone }) {
  const request = payload?.request ?? {};
  const secrets = Array.isArray(request.secrets) ? request.secrets : [];
  return (
    <>
      <p className="card-body">This app needs {secrets.length} secret{secrets.length === 1 ? '' : 's'}.</p>
      {secrets.map((s) => <Field key={s.name} label={s.name} value={s.description} />)}
      <Decision entry={entry} onDone={onDone} />
    </>
  );
}

/** The handoff card: the agent is handing the conversation over. */
function Handoff({ entry, payload, onDone }) {
  const handoff = payload?.handoff ?? {};
  return (
    <>
      <Field label="to" value={handoff.agentName ?? handoff.agentId} />
      <Field label="why" value={handoff.reason} />
      <Decision entry={entry} onDone={onDone} />
    </>
  );
}

/**
 * The card renderer.
 *
 * @param {object} props
 * @param {string} props.kind
 * @param {string} props.type
 * @param {object} props.payload
 * @param {string} [props.resolutionId]
 * @param {string} [props.interactionId]
 * @param {object} [props.resolution]
 */
export function Card({ kind, type, payload, resolutionId, interactionId, resolution, onDone }) {
  const descriptor = useMemo(() => describeCard(kind, type), [kind, type]);
  if (!descriptor) {
    // An unknown card is shown as its raw payload rather than swallowed.
    return (
      <div className="card unknown" data-surface="card-unknown" data-card={`${kind}:${type}`}>
        <pre>{JSON.stringify(payload ?? {}, null, 2).slice(0, 2000)}</pre>
      </div>
    );
  }
  const entry = { kind, type, payload, resolutionId, interactionId, resolution };

  const body = () => {
    switch (type) {
      case 'text':
        return <p className="card-body">{String(payload?.content ?? '').slice(0, 4000)}</p>;
      case 'attachment':
        return (
          <div className="card-attachment">
            <Icon.File />
            <span>{payload?.file_name ?? payload?.url}</span>
          </div>
        );
      case 'widget':
        return <Widget entry={entry} onDone={onDone} />;
      case 'user-form':
        return <Form entry={entry} onDone={onDone} />;
      case 'email-draft':
      case 'slack-draft':
      case 'meeting-chat-draft':
        return <Draft entry={entry} onDone={onDone} kind={type} />;
      case 'secret-request':
        return <SecretRequest entry={entry} onDone={onDone} />;
      case 'calendar-event':
        return <CalendarEvent entry={entry} onDone={onDone} />;
      case 'auto-review-approval':
        return <AutoReviewApproval entry={entry} payload={payload} onDone={onDone} />;
      case 'local-tool-permission':
      case 'mobile-tool-permission':
        return <LocalToolPermission entry={entry} payload={payload} onDone={onDone} />;
      case 'app-secrets-request':
        return <AppSecrets entry={entry} payload={payload} onDone={onDone} />;
      case 'bot-template-share':
        return <BotTemplateShare entry={entry} payload={payload} onDone={onDone} />;
      case 'handoff':
        return <Handoff entry={entry} payload={payload} onDone={onDone} />;
      case 'voice-call':
        return <VoiceCall payload={payload} />;
      case 'feedback':
        return <Feedback payload={payload} />;
      case 'mcp-app':
        return <McpApp payload={payload} />;
      case 'user-attachment':
        return <UserAttachment payload={payload} />;
      case 'notice':
        return <p className="card-body">{String(payload?.text ?? '')}</p>;
      default:
        break;
    }
    // The generic card: the descriptor's fields, then the decision.
    const fields = (descriptor.fields ?? []).map((field) => (
      <Field key={field} label={field} value={payload?.[field]} />
    ));
    return (
      <>
        {fields}
        {descriptor.resolution === RESOLUTION.CONFIRM ? <Decision entry={entry} onDone={onDone} /> : null}
      </>
    );
  };

  return (
    <div className="card" data-surface="card" data-card={`${kind}:${type}`} data-kind={kind} data-type={type}>
      <div className="card-header">
        <span className="card-title">{descriptor.title}</span>
      </div>
      {body()}
    </div>
  );
}

export default Card;
