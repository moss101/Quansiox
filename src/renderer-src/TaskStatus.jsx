import React, { useCallback, useEffect, useState } from 'react';
import { api } from './lib.js';
import { deriveChips, stepLabel } from './taskStatusModel.js';

/**
 * TaskStatus (parity plan P2.4) — the thread status surface.
 *
 * Grok keeps three facts always visible in the thread: what is waiting on
 * the user, what needs approval, and what is still running (with step
 * labels like "Run command"). The approval MODAL (ConfirmCard) stays for
 * the live mid-run prompt; this strip is the persistent summary — which
 * also rescues approvals orphaned by a restart — plus the async-tasks
 * drawer for background work.
 *
 * Data comes from three existing services via their namespaces:
 * asyncTasks, confirmations.list, interactions.pending. No new state.
 */

const POLL_MS = 1500;

function useThreadStatus(sessionId) {
  const [state, setState] = useState({ tasks: [], confirmations: [], interactions: {} });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [tasks, confirmations, interactions] = await Promise.all([
          api.asyncTasks.list({ sessionId, includeFinished: true }).catch(() => []),
          api.confirmations.list().catch(() => []),
          api.interactions.pending().catch(() => ({})),
        ]);
        if (alive) setState({
          tasks: Array.isArray(tasks) ? tasks : [],
          confirmations: Array.isArray(confirmations) ? confirmations : [],
          interactions: interactions ?? {},
        });
      } catch { /* main not ready — next poll */ }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [sessionId]);
  return state;
}

const STATUS_LABEL = { queued: 'Queued', running: 'Running', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

function AsyncTaskRow({ task }) {
  const [open, setOpen] = useState(false);
  const pct = Number.isFinite(task.progress) ? Math.round(Math.max(0, Math.min(1, task.progress)) * 100) : null;
  return (
    <div className="async-task-row" data-status={task.status} data-surface="async-task-row">
      <button type="button" className="async-task-head" onClick={() => setOpen((v) => !v)}>
        <span className="async-task-status" data-status={task.status} aria-label={STATUS_LABEL[task.status] ?? task.status} />
        <span className="async-task-title">{task.title || 'Untitled task'}</span>
        {pct !== null && task.status === 'running'
          ? <span className="async-task-progress">{pct}%</span>
          : <span className="async-task-state">{STATUS_LABEL[task.status] ?? task.status}</span>}
      </button>
      {task.status === 'running' && pct !== null ? (
        <div className="async-task-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="async-task-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {open ? (
        <div className="async-task-body">
          {task.error ? <p className="async-task-error">{task.error}</p> : null}
          {task.outputTail ? <pre className="async-task-tail">{task.outputTail}</pre> : null}
          {!task.error && !task.outputTail ? <p className="async-task-empty">No output yet.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function TaskStatusStrip({ sessionId }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { tasks, confirmations, interactions } = useThreadStatus(sessionId);
  const { chips, runningCount, finishedHint } = deriveChips({ tasks, confirmations, interactions });
  if (chips.length === 0 && !finishedHint) return null;
  return (
    <div className="task-strip" data-surface="task-strip" role="status" aria-label="Thread status">
      {chips.map((chip) => (
        <span key={chip.kind} className={`task-chip is-${chip.kind}`} data-kind={chip.kind}>
          {chip.kind === 'running' && chip.progress !== null ? (
            <span className="task-chip-progress" aria-hidden="true">{Math.round(chip.progress * 100)}%</span>
          ) : null}
          <span className="task-chip-label">{chip.label}</span>
        </span>
      ))}
      <button
        type="button"
        className={`task-strip-toggle${drawerOpen ? ' is-open' : ''}`}
        onClick={() => setDrawerOpen((v) => !v)}
        aria-expanded={drawerOpen}
        title="Async tasks"
      >
        Tasks{runningCount > 0 ? ` · ${runningCount}` : finishedHint ? ` · ${finishedHint}` : ''}
      </button>
      {drawerOpen ? (
        <div className="async-drawer" data-surface="async-tasks" role="region" aria-label="Async tasks">
          <div className="async-drawer-head">
            <span className="surface-label">Async tasks</span>
            <button type="button" className="async-drawer-close" onClick={() => setDrawerOpen(false)} aria-label="Close">×</button>
          </div>
          {tasks.length === 0
            ? <p className="async-drawer-empty">No background tasks in this session.</p>
            : tasks.map((task) => <AsyncTaskRow key={task.id} task={task} />)}
        </div>
      ) : null}
    </div>
  );
}

export default TaskStatusStrip;
