import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * The Mail Manus surface.
 *
 * The bot address is an address that delivers into your own mailbox; a
 * **workflow address** is an alias on it with a default prompt attached.
 * Only the **approved senders** may start a task.
 */
export function MailPanel({ onToast }) {
  const [state, setState] = useState(null);
  const [address, setAddress] = useState('');
  const [alias, setAlias] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.mailManus.state();
      setState(result);
      setError(null);
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const configure = async (patch) => {
    try {
      await api.mailManus.configure(patch);
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  const approve = async () => {
    const value = address.trim();
    if (!value) return;
    try {
      await api.mailManus.approveSender({ email: value });
      setAddress('');
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  const addWorkflow = async () => {
    if (!alias.trim()) return;
    try {
      await api.mailManus.addWorkflow({ alias: alias.trim(), prompt });
      setAlias(''); setPrompt('');
      await refresh();
      onToast?.('Workflow address added', 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  const poll = async () => {
    setBusy(true);
    try {
      const result = await api.mailManus.poll({ limit: 5 });
      if (!result.ok) { onToast?.(result.reason, 'err'); return; }
      onToast?.(`Checked ${result.checked} message(s)`, 'ok');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mail-panel" data-surface="mail-panel" aria-label="Mail Manus">
      <header className="mail-panel-head">
        <span className="surface-label">Mail Manus</span>
        <button type="button" className="ibtn" title="Reload" onClick={refresh}><Icon.Refresh /></button>
      </header>

      {error ? <p className="mail-error" role="alert">{error}</p> : null}

      <div className="mail-toggle">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={state?.enabled === true}
            onChange={(e) => configure({ enabled: e.target.checked })}
          />
          Accept tasks from email
        </label>
        <div className="mail-address">
          <span className="surface-label">Bot address</span>
          <code>{state?.botAddress ?? 'set an IMAP mailbox first'}</code>
        </div>
      </div>

      <div className="mail-senders" data-surface="mail-approved-senders">
        <h4 className="surface-label">Approved senders</h4>
        <div className="mail-invite">
          <input
            value={address}
            placeholder="sender@example.com"
            aria-label="Approved sender"
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') approve(); }}
          />
          <button type="button" className="btn btn-secondary btn-mini" onClick={approve} disabled={!address.trim()}>Add</button>
        </div>
        <ul>
          {state?.approvedSenders?.map((sender) => (
            <li key={sender} className="mail-sender">
              <span className="ellipsis">{sender}</span>
              <button
                type="button"
                className="ibtn"
                title="Remove"
                aria-label={`Remove ${sender}`}
                onClick={async () => { await api.mailManus.removeSender({ email: sender }); await refresh(); }}
              >
                <Icon.X />
              </button>
            </li>
          ))}
          {!state?.approvedSenders?.length ? <li className="mail-empty">Nobody yet — every sender is allowed.</li> : null}
        </ul>
      </div>

      <div className="mail-workflows" data-surface="mail-workflows">
        <h4 className="surface-label">Workflow addresses</h4>
        <div className="mail-workflow-form">
          <input value={alias} placeholder="travel" aria-label="Workflow alias" onChange={(e) => setAlias(e.target.value)} />
          <input value={prompt} placeholder="The default prompt for this address" aria-label="Workflow prompt" onChange={(e) => setPrompt(e.target.value)} />
          <button type="button" className="btn btn-secondary btn-mini" onClick={addWorkflow} disabled={!alias.trim()}>Add</button>
        </div>
        <ul>
          {state?.workflows?.map((workflow) => (
            <li key={workflow.alias} className="mail-workflow">
              <code>{workflow.address}</code>
              <span className="ellipsis">{workflow.prompt}</span>
              <button
                type="button"
                className="ibtn"
                title="Remove"
                aria-label={`Remove ${workflow.alias}`}
                onClick={async () => { await api.mailManus.removeWorkflow({ alias: workflow.alias }); await refresh(); }}
              >
                <Icon.X />
              </button>
            </li>
          ))}
          {!state?.workflows?.length ? <li className="mail-empty">No workflow addresses yet.</li> : null}
        </ul>
      </div>

      <button type="button" className="btn btn-secondary" onClick={poll} disabled={busy}>Check the mailbox</button>

      <p className="mail-note">
        The address lives in your own mailbox, so forwarding a message to it starts a task. Reply
        &quot;cancel&quot; to the status email to stop it.
      </p>
    </section>
  );
}

export default MailPanel;
