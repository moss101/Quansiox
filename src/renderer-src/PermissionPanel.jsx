import React, { useCallback, useEffect, useState } from 'react';
import { api } from './lib.js';
import { TOOL_GROUPS } from './tools.js';

/**
 * PermissionPanel — the control surface for the permission model (W1.10).
 *
 * The permission model is always on: a turn has a mode, and a per-tool
 * matrix refines it. This panel is where the user sees and changes that:
 *
 *   1. the mode ladder — read-only → workspace → computer;
 *   2. the per-tool matrix — always allow / needs approval / blocked;
 *   3. the standing grants — "always allow this exact action", with revoke;
 *   4. the auto-review rules — what the reviewer blocks and allows;
 *   5. the governance log — why did it refuse that?
 *
 * Every control takes effect on the next tool call; nothing needs a restart.
 */

const MODES = [
  {
    id: 'read-only',
    label: 'Read-only',
    blurb: 'The agent can look but not change anything: no file writes, no shell side effects, no screen control.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    blurb: 'The agent can change files inside this workspace (in the sandbox) and run read-only commands. Anything that leaves the machine still asks.',
  },
  {
    id: 'computer',
    label: 'Computer',
    blurb: 'The agent may drive the screen and the browser. Sending anything outward still asks.',
  },
];

const LEVELS = [
  { id: 'always_allow', label: 'Always allow' },
  { id: 'needs_approval', label: 'Ask each time' },
  { id: 'blocked', label: 'Blocked' },
];

function levelFor(matrix, tool) {
  const explicit = matrix?.tools?.[tool];
  if (explicit) return explicit;
  return null;
}

/**
 * The compact form, for the 320px sidebar column.
 *
 * A full tool matrix does not belong in a column that narrow: the rows
 * collide and the labels become unreadable. The sidebar gets the mode and
 * what it means; the matrix, the grants and the review live on the
 * Settings → Permissions page.
 */
function CompactPermissions({ state, mode, modeInfo, busy, onSetMode }) {
  const matrix = state.matrix?.matrix ?? { tools: {} };
  const overridden = Object.keys(matrix.tools ?? {}).length;
  const grants = state.grants?.grants?.length ?? 0;
  return (
    <div className="permission-panel is-compact" data-surface="permissions">
      <div className="permission-head">
        <span className="surface-label">Permission mode</span>
        <span className="permission-mode-badge" data-mode={mode}>{mode}</span>
      </div>
      <p className="permission-hint">{modeInfo.blurb}</p>
      <dl className="permission-summary">
        <div><dt>Tool overrides</dt><dd>{overridden}</dd></div>
        <div><dt>Standing grants</dt><dd>{grants}</dd></div>
        <div><dt>Safety review</dt><dd>{state.autoReviewEnabled ? 'on' : 'off'}</dd></div>
      </dl>
      <div className="permission-actions">
        {MODES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`permission-mode-chip${mode === entry.id ? ' is-active' : ''}`}
            data-mode={entry.id}
            aria-pressed={mode === entry.id}
            disabled={busy}
            title={entry.blurb}
            onClick={() => onSetMode(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <p className="permission-hint">
        The tool matrix, the standing grants and the safety review are under
        Settings → Permissions.
      </p>
    </div>
  );
}

export default function PermissionPanel({ onToast, compact = false }) {
  const [state, setState] = useState(null);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [allowDraft, setAllowDraft] = useState('');
  const [blockDraft, setBlockDraft] = useState('');

  const refresh = useCallback(async () => {
    try {
      const next = await api.permissions.state();
      setState(next);
      const entries = await api.permissions.governanceLog({ limit: 40 });
      setLog(entries?.entries ?? []);
    } catch (error) {
      onToast?.(error.message ?? String(error), 'err');
    }
  }, [onToast]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!state) {
    return <div className="permission-panel" data-surface="permissions">Loading permissions…</div>;
  }

  const matrix = state.matrix?.matrix ?? { tools: {}, reads: 'always_allow', writes: 'always_allow' };
  const mode = state.mode;
  const modeInfo = MODES.find((m) => m.id === mode) ?? MODES[1];


  const setMode = async (next) => {
    setBusy(true);
    try {
      await api.permissions.setMode({ mode: next });
      await refresh();
      onToast?.(`Permission mode: ${next}`, 'ok');
    } catch (error) {
      onToast?.(error.message ?? String(error), 'err');
    } finally {
      setBusy(false);
    }
  };

  const setTool = async (tool, level) => {
    setBusy(true);
    try {
      await api.permissions.setTool({ tool, level });
      await refresh();
    } catch (error) {
      onToast?.(error.message ?? String(error), 'err');
    } finally {
      setBusy(false);
    }
  };

  const clearMatrix = async () => {
    setBusy(true);
    try {
      await api.permissions.clearMatrix({ scope: 'global' });
      await refresh();
      onToast?.('Tool overrides cleared', 'ok');
    } catch (error) {
      onToast?.(error.message ?? String(error), 'err');
    } finally {
      setBusy(false);
    }
  };

  const revokeGrant = async (id) => {
    try {
      await api.permissions.revokeGrant({ id });
      await refresh();
    } catch (error) {
      onToast?.(error.message ?? String(error), 'err');
    }
  };

  const addRule = async (kind) => {
    const text = kind === 'allow' ? allowDraft.trim() : blockDraft.trim();
    if (!text) return;
    const instructions = {
      isEnabled: true,
      allowInstructions: [...(state.autoReviewInstructions?.allowInstructions ?? [])],
      blockInstructions: [...(state.autoReviewInstructions?.blockInstructions ?? [])],
    };
    if (kind === 'allow') instructions.allowInstructions.push(text);
    else instructions.blockInstructions.push(text);
    try {
      await api.permissions.setAutoReview({ enabled: true, instructions });
      if (kind === 'allow') setAllowDraft('');
      else setBlockDraft('');
      await refresh();
    } catch (error) {
      onToast?.(error.message ?? String(error), 'err');
    }
  };

  const removeRule = async (kind, text) => {
    const instructions = {
      isEnabled: state.autoReviewInstructions?.isEnabled === true,
      allowInstructions: [...(state.autoReviewInstructions?.allowInstructions ?? [])],
      blockInstructions: [...(state.autoReviewInstructions?.blockInstructions ?? [])],
    };
    if (kind === 'allow') instructions.allowInstructions = instructions.allowInstructions.filter((r) => r !== text);
    else instructions.blockInstructions = instructions.blockInstructions.filter((r) => r !== text);
    try {
      await api.permissions.setAutoReview({ instructions });
      await refresh();
    } catch (error) {
      onToast?.(error.message ?? String(error), 'err');
    }
  };

  const grants = state.grants?.grants ?? [];

  if (compact) {
    return (
      <CompactPermissions
        state={state}
        mode={mode}
        modeInfo={modeInfo}
        busy={busy}
        onSetMode={setMode}
      />
    );
  }

  return (
    <section className="permission-panel" data-surface="permissions" aria-label="Permissions">
      <header className="permission-head">
        <span className="surface-label">Permissions</span>
        <span className="permission-mode-badge" data-mode={mode}>{mode}</span>
      </header>

      {/* 1. the mode ladder */}
      <div className="permission-modes" data-surface="permission-modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`permission-mode${mode === m.id ? ' is-active' : ''}`}
            data-mode={m.id}
            aria-pressed={mode === m.id}
            disabled={busy}
            title={m.blurb}
            onClick={() => setMode(m.id)}
          >
            <strong className="permission-mode-title">{m.label}</strong>
            <em className="permission-mode-blurb">{m.blurb}</em>
          </button>
        ))}
      </div>

      {/* 2. the per-tool matrix */}
      <details className="permission-matrix" data-surface="permission-matrix">
        <summary className="surface-label">Tool matrix</summary>
        <p className="permission-hint">
          Overrides the mode for one tool. A tool left unset follows the mode.
        </p>
        {TOOL_GROUPS.map((group) => (
          <div key={group.label} className="permission-group">
            <h4 className="permission-group-label">{group.label}</h4>
            {group.tools.map((tool) => {
              const explicit = levelFor(matrix, tool);
              return (
                <div key={tool} className="permission-row" data-tool={tool} data-level={explicit ?? 'inherit'}>
                  <span className="permission-tool">{tool}</span>
                  <span className="permission-levels">
                    <button
                      type="button"
                      className={`permission-level${explicit === 'always_allow' ? ' is-active' : ''}`}
                      disabled={busy}
                      onClick={() => setTool(tool, 'always_allow')}
                    >always allow</button>
                    <button
                      type="button"
                      className={`permission-level${explicit === 'needs_approval' ? ' is-active' : ''}`}
                      disabled={busy}
                      onClick={() => setTool(tool, 'needs_approval')}
                    >ask</button>
                    <button
                      type="button"
                      className={`permission-level${explicit === 'blocked' ? ' is-active' : ''}`}
                      disabled={busy}
                      onClick={() => setTool(tool, 'blocked')}
                    >block</button>
                    {explicit ? (
                      <button type="button" className="ibtn" title="Follow the mode again" onClick={() => setTool(tool, 'needs_approval').then(() => clearMatrix())}>reset</button>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={clearMatrix}>Clear all overrides</button>
      </details>

      {/* 3. standing grants */}
      <details className="permission-grants" data-surface="permission-grants">
        <summary className="surface-label">Standing grants ({grants.length})</summary>
        {grants.length ? grants.map((g) => (
          <div key={g.id} className="permission-grant" data-grant={g.id}>
            <span className="permission-grant-action">{g.action}</span>
            {g.target ? <span className="permission-grant-target">{String(g.target).slice(0, 120)}</span> : null}
            <span className="permission-grant-expiry">
              {g.expiresAtMs ? `until ${new Date(g.expiresAtMs).toLocaleDateString()}` : ''}
            </span>
            <button type="button" className="ibtn danger" title="Revoke this grant" onClick={() => revokeGrant(g.id)}>revoke</button>
          </div>
        )) : <p className="permission-hint">No standing grants. “Always allow this action” on an approval card creates one.</p>}
      </details>

      {/* 4. auto-review rules */}
      <details className="permission-review" data-surface="permission-review">
        <summary className="surface-label">
          Safety review
          {' '}
          <span className="permission-mode-badge" data-mode={state.autoReviewEnabled ? 'on' : 'off'}>
            {state.autoReviewEnabled ? 'on' : 'off'}
          </span>
        </summary>
        <p className="permission-hint">
          A rule is plain text (a substring match) or /a regular expression/. Block wins over allow.
        </p>
        <div className="permission-rules">
          <strong>Always allow</strong>
          {(state.autoReviewInstructions?.allowInstructions ?? []).map((r) => (
            <div key={r} className="permission-rule" data-rule={r}>
              <code>{r}</code>
              <button type="button" className="ibtn danger" onClick={() => removeRule('allow', r)}>remove</button>
            </div>
          ))}
          <form className="permission-rule-form" onSubmit={(e) => { e.preventDefault(); addRule('allow'); }}>
            <input aria-label="New allow rule" placeholder="e.g. /git (status|diff)$/" value={allowDraft}
              onChange={(e) => setAllowDraft(e.target.value)} />
            <button className="btn btn-secondary" type="submit">Add</button>
          </form>
        </div>
        <div className="permission-rules">
          <strong>Always block</strong>
          {(state.autoReviewInstructions?.blockInstructions ?? []).map((r) => (
            <div key={r} className="permission-rule" data-rule={r}>
              <code>{r}</code>
              <button type="button" className="ibtn danger" onClick={() => removeRule('block', r)}>remove</button>
            </div>
          ))}
          <form className="permission-rule-form" onSubmit={(e) => { e.preventDefault(); addRule('block'); }}>
            <input aria-label="New block rule" placeholder="e.g. rm -rf" value={blockDraft}
              onChange={(e) => setBlockDraft(e.target.value)} />
            <button className="btn btn-secondary" type="submit">Add</button>
          </form>
        </div>
      </details>

      {/* 5. the governance log */}
      <details className="permission-log" data-surface="permission-log">
        <summary className="surface-label">Decision log ({log.length})</summary>
        {log.length ? log.slice().reverse().map((entry) => (
          <div key={entry.seq} className="permission-log-row" data-decision={entry.decision} data-gate={entry.gate}>
            <span className="permission-log-decision">{entry.decision}</span>
            <span className="permission-log-tool">{entry.tool}</span>
            <span className="permission-log-gate">{entry.gate}</span>
            <span className="permission-log-reason">{String(entry.reason ?? '').slice(0, 200)}</span>
          </div>
        )) : <p className="permission-hint">No decisions recorded yet.</p>}
      </details>
    </section>
  );
}
