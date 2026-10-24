import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, toast } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * VaultPanel — the credential vault.
 *
 * The vault stores credentials encrypted at rest. This surface only ever
 * shows the *shape* of what is stored — a name, the field names, a note and
 * the timestamps — never a value. Values are write-only: they go in through
 * the form below and are read back by the agent through a
 * `{{secret:NAME.FIELD}}` reference.
 *
 * It also carries the 1Password bridge (the local `op` CLI, gated by the
 * biometric approver) and the credential requests the agent is waiting on.
 *
 * Props:
 *   - active?: boolean — when false the panel stops polling (default true).
 *   - onToast?: (message: string, kind?: 'ok' | 'err' | 'warn' | 'info') => void
 *     — the notification sink. Falls back to the global toast in lib.js.
 */

/** Format a timestamp the way the rest of the app does. */
function when(ms) {
  if (!ms) return '—';
  try {
    return new Date(Number(ms)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

export function VaultPanel({ active = true, onToast }) {
  const notify = useCallback((message, kind = 'info') => {
    if (onToast) onToast(message, kind);
    else toast(message, kind);
  }, [onToast]);

  const [secrets, setSecrets] = useState([]);
  const [onePassword, setOnePassword] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [vaults, setVaults] = useState([]);
  const [items, setItems] = useState([]);
  const [vaultName, setVaultName] = useState('');
  const [gate, setGate] = useState(null);
  const [pending, setPending] = useState({ forms: [], widgets: [], trays: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: '', field: 'value', value: '', note: '' });
  const [answers, setAnswers] = useState({});

  const refresh = useCallback(async () => {
    setError(null);
    const problems = [];
    const [secretRows, opStatus, accountRows, vaultRows, gateState, pendingRows] = await Promise.all([
      api.secrets.list().catch((failure) => { problems.push(failure?.message ?? String(failure)); return []; }),
      api.onePassword.status().catch((failure) => { problems.push(failure?.message ?? String(failure)); return null; }),
      api.onePassword.accounts().catch(() => []),
      api.onePassword.vaults().catch(() => []),
      api.onePassword.vaultGate().catch(() => null),
      api.interactions.pending().catch(() => null),
    ]);
    setSecrets(Array.isArray(secretRows) ? secretRows : []);
    setOnePassword(opStatus);
    setAccounts(Array.isArray(accountRows) ? accountRows : []);
    setVaults(Array.isArray(vaultRows) ? vaultRows : []);
    setGate(gateState);
    setPending({
      forms: Array.isArray(pendingRows?.forms) ? pendingRows.forms : [],
      widgets: Array.isArray(pendingRows?.widgets) ? pendingRows.widgets : [],
      trays: Array.isArray(pendingRows?.trays) ? pendingRows.trays : [],
    });
    if (problems.length) setError(problems[0]);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    refresh();
    const timer = setInterval(refresh, 8000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  /** Load the items of a 1Password vault (titles only — never the secrets). */
  const openVault = async (name) => {
    setVaultName(name);
    setBusy(true);
    try {
      const rows = await api.onePassword.items({ vault: name });
      setItems(Array.isArray(rows) ? rows : []);
    } catch (failure) {
      setItems([]);
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const storeSecret = async (event) => {
    event.preventDefault();
    const name = draft.name.trim();
    const field = draft.field.trim() || 'value';
    if (!name || !draft.value) return;
    setBusy(true);
    try {
      await api.secrets.set({ name, fields: { [field]: draft.value }, note: draft.note });
      setDraft({ name: '', field: 'value', value: '', note: '' });
      await refresh();
      notify('Secret stored', 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const removeSecret = async (name) => {
    setBusy(true);
    try {
      await api.secrets.remove({ name });
      await refresh();
      notify(`${name} removed`, 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const importItem = async (item) => {
    setBusy(true);
    try {
      const result = await api.onePassword.import({
        item,
        vault: vaultName || undefined,
        credentialId: item,
      });
      if (result?.status === 'ok') notify(`Imported ${item}`, 'ok');
      else if (result?.status === 'denied') notify(result?.reason || 'The release was declined', 'warn');
      else notify(result?.error || 'The import failed', 'err');
      await refresh();
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const toggleGate = async () => {
    setBusy(true);
    try {
      const next = await api.onePassword.setVaultGate({ enabled: !gate?.enabled });
      setGate(next);
      notify(next?.enabled ? 'The biometric gate is on' : 'The biometric gate is off', 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  /** Answer a pending request; `saveToVault` puts the answer in the vault. */
  const answerRequest = async (entry, saveToVault) => {
    const values = answers[entry.id] ?? {};
    const filled = Object.fromEntries(
      (entry.fields ?? [])
        .filter((field) => String(values[field.name] ?? '').length > 0)
        .map((field) => [field.name, String(values[field.name])]),
    );
    if (!Object.keys(filled).length) return;
    setBusy(true);
    try {
      await api.interactions.submitForm({ entryId: entry.id, values: filled, saveToVault: Boolean(saveToVault) });
      setAnswers((prev) => ({ ...prev, [entry.id]: {} }));
      await refresh();
      notify(saveToVault ? 'Answer saved to the vault' : 'Answer submitted', 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const requestCount = pending.forms.length + pending.widgets.length + pending.trays.length;
  const opReady = Boolean(onePassword?.available);
  const opSignedIn = Boolean(onePassword?.signedIn);

  const vaultRows = useMemo(() => vaults.filter((v) => v?.name), [vaults]);

  return (
    <section className="sfx-panel" data-surface="vault">
      <header className="sfx-head">
        <span className="surface-label">Credential vault</span>
        <div className="sfx-head-actions">
          <button type="button" className="ibtn" title="Refresh" disabled={busy} onClick={refresh}>
            <Icon.Refresh />
          </button>
        </div>
      </header>

      <div className="sfx-body">
        {error ? (
          <div className="sfx-error" data-surface="vault-error">
            <Icon.Info />
            <span>{error}</span>
            <button type="button" className="btn btn-secondary btn-mini" onClick={refresh}>Retry</button>
          </div>
        ) : null}

        {loading && secrets.length === 0 ? <div className="sfx-loading">Opening the vault…</div> : null}

        {!loading && secrets.length === 0 && !error ? (
          <div className="sfx-empty" data-surface="vault-empty">
            <p>The vault is empty.</p>
            <p className="sfx-hint">
              Store a credential below, then reference it in a tool as
              {' '}<code className="sfx-mono">{'{{secret:NAME.FIELD}}'}</code>.
            </p>
          </div>
        ) : null}

        <details className="sfx-section" data-surface="vault-secrets" open>
          <summary className="surface-label">Stored credentials ({secrets.length})</summary>
          {secrets.length === 0 ? (
            <p className="sfx-hint">Nothing stored yet.</p>
          ) : secrets.map((secret) => (
            <div key={secret.name} className="sfx-row" data-secret={secret.name}>
              <span className="sfx-title">{secret.name}</span>
              <span className="sfx-mono sfx-muted">{secret.fields.join(', ') || '—'}</span>
              <span className="sfx-desc">{secret.note || ''}</span>
              <span className="sfx-tag">{when(secret.updatedAt ?? secret.createdAt)}</span>
              <button type="button" className="ibtn danger" title="Delete this credential" disabled={busy}
                onClick={() => removeSecret(secret.name)}>
                <Icon.Trash />
              </button>
            </div>
          ))}
          <p className="sfx-hint">
            Values are write-only: they never come back out of the vault, not to this panel and not to
            the agent — the agent gets the reference, resolved at the moment the tool runs.
          </p>
        </details>

        <details className="sfx-section" data-surface="vault-add">
          <summary className="surface-label">Store a credential</summary>
          <form className="sfx-form" onSubmit={storeSecret}>
            <input
              aria-label="Secret name"
              placeholder="name (e.g. github_token)"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <input
              aria-label="Field name"
              placeholder="field"
              value={draft.field}
              onChange={(event) => setDraft({ ...draft, field: event.target.value })}
            />
            <input
              aria-label="Secret value"
              type="password"
              placeholder="value (encrypted at rest)"
              value={draft.value}
              onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            />
            <input
              aria-label="Secret note"
              placeholder="note (optional)"
              value={draft.note}
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            />
            <button className="btn btn-secondary btn-mini" type="submit" disabled={busy}>Store</button>
          </form>
        </details>

        <details className="sfx-section" data-surface="vault-requests" open={requestCount > 0}>
          <summary className="surface-label">Credential requests ({requestCount})</summary>
          {requestCount === 0 ? (
            <p className="sfx-hint">The agent is not waiting for a credential.</p>
          ) : (
            pending.forms.map((entry) => (
              <div key={entry.id} className="sfx-request" data-request={entry.id}>
                <div className="sfx-row">
                  <span className="sfx-title">{entry.title || 'Input requested'}</span>
                  <span className="sfx-tag">{entry.agentId}</span>
                </div>
                {(entry.fields ?? []).map((field) => (
                  <input
                    key={field.name}
                    aria-label={`${entry.title || 'Input'} — ${field.label || field.name}`}
                    type={field.type === 'password' ? 'password' : 'text'}
                    placeholder={field.label || field.name}
                    value={answers[entry.id]?.[field.name] ?? ''}
                    onChange={(event) => setAnswers((prev) => ({
                      ...prev,
                      [entry.id]: { ...(prev[entry.id] ?? {}), [field.name]: event.target.value },
                    }))}
                  />
                ))}
                <div className="sfx-card-actions">
                  <button type="button" className="btn btn-secondary btn-mini" disabled={busy}
                    onClick={() => answerRequest(entry, false)}>
                    Send
                  </button>
                  <button type="button" className="btn btn-primary btn-mini" disabled={busy}
                    onClick={() => answerRequest(entry, true)}>
                    Send and store in the vault
                  </button>
                </div>
              </div>
            ))
          )}
        </details>

        <details className="sfx-section" data-surface="vault-1password" open={!opReady}>
          <summary className="surface-label">1Password</summary>
          {!opReady ? (
            <p className="sfx-hint">
              {onePassword?.reason || 'The 1Password CLI (op) was not found on this machine.'}
            </p>
          ) : (
            <>
              <div className="sfx-row">
                <span className="sfx-title">CLI</span>
                <span className="sfx-mono sfx-muted">{onePassword?.path}</span>
                <span className="sfx-tag">{onePassword?.version || 'unknown version'}</span>
                <span className="sfx-tag" data-status={opSignedIn ? 'ready' : 'idle'}>
                  {opSignedIn ? 'signed in' : 'not signed in'}
                </span>
                <span className="sfx-tag" data-status={onePassword?.approver ? 'ready' : 'idle'}>
                  {onePassword?.approver ? 'approver ready' : 'no approver'}
                </span>
              </div>
              <div className="sfx-row">
                <span className="sfx-title">Biometric gate</span>
                <span className="sfx-tag" data-status={gate?.enabled ? 'ready' : 'idle'}>
                  {gate?.enabled ? 'on' : 'off'}
                </span>
                <button type="button" className="btn btn-secondary btn-mini" disabled={busy || !gate?.available}
                  onClick={toggleGate}>
                  {gate?.enabled ? 'Turn off' : 'Turn on'}
                </button>
              </div>
              {accounts.length ? (
                <div className="sfx-row">
                  <span className="sfx-title">Accounts</span>
                  <span className="sfx-mono sfx-muted">{accounts.map((a) => a.email ?? a.name).join(', ')}</span>
                </div>
              ) : null}
              {vaultRows.length ? (
                <div className="sfx-row">
                  <span className="sfx-title">Vaults</span>
                  {vaultRows.map((vault) => (
                    <button
                      key={vault.id ?? vault.name}
                      type="button"
                      className={`sfx-chip${vaultName === vault.name ? ' is-active' : ''}`}
                      onClick={() => openVault(vault.name)}
                    >{vault.name}</button>
                  ))}
                </div>
              ) : null}
              {vaultName ? (
                <div className="sfx-list" data-surface="vault-1password-items">
                  {items.length === 0 ? (
                    <p className="sfx-hint">No items in this vault, or the vault could not be read.</p>
                  ) : items.map((item) => (
                    <div key={item.id ?? item.title} className="sfx-row" data-item={item.id ?? item.title}>
                      <span className="sfx-title">{item.title}</span>
                      <span className="sfx-tag">{item.category || 'item'}</span>
                      <button type="button" className="btn btn-secondary btn-mini" disabled={busy}
                        onClick={() => importItem(item.title)}>
                        Import
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <p className="sfx-hint">
                Importing reads the item with the biometric approver and stores it in this vault —
                nothing leaves the machine.
              </p>
            </>
          )}
        </details>
      </div>
    </section>
  );
}

export default VaultPanel;
