'use strict';
/**
 * Thread-status model (parity plan P2.4) — pure, electron-free.
 *
 * Grok's thread surface keeps three facts always visible: what is waiting on
 * the user, what needs approval, and what is still running. This module
 * derives those from the three existing services (no new state):
 *
 *   asyncTasks.list/active   → running / queued background tasks
 *   confirmations.list       → pending tool approvals
 *   interactions.pending     → pending forms / trays / widgets
 *
 * The renderer component renders whatever this returns; tests assert the
 * derivation directly. */

/** Grok-style step label for a running task ("Run command", "Reading a file"). */
export function stepLabel(task) {
  const title = String(task?.title ?? '').trim();
  if (!title) return task?.status === 'queued' ? 'Queued' : 'Working';
  const verb = title.split(/\s+—\s+|\s+-\s+/)[0];
  return verb.length > 2 && verb.length <= 32 ? verb : title.slice(0, 32);
}

/**
 * @param {{tasks?: Array, confirmations?: Array, interactions?: {forms?: Array, trays?: Array, widgets?: Array}}} input
 * @returns {{chips: Array<{kind: string, count: number, label: string, title?: string, progress?: number}>, runningCount: number, finishedHint?: string}}
 */
export function deriveChips(input = {}) {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const confirmations = Array.isArray(input.confirmations) ? input.confirmations : [];
  const interactions = input.interactions ?? {};
  const waitingCount = (interactions.forms?.length ?? 0)
    + (interactions.trays?.length ?? 0)
    + (interactions.widgets?.length ?? 0);

  const running = tasks.filter((t) => t?.status === 'running');
  const queued = tasks.filter((t) => t?.status === 'queued');
  const active = [...running, ...queued];
  const failed = tasks.filter((t) => t?.status === 'failed');

  const chips = [];
  if (waitingCount > 0) {
    chips.push({ kind: 'waiting', count: waitingCount, label: waitingCount === 1 ? 'Waiting on you' : `Waiting on you · ${waitingCount}` });
  }
  if (confirmations.length > 0) {
    chips.push({ kind: 'approval', count: confirmations.length, label: confirmations.length === 1 ? 'Needs approval' : `Needs approval · ${confirmations.length}` });
  }
  if (active.length > 0) {
    const head = running[0] ?? queued[0];
    const others = active.length - 1;
    chips.push({
      kind: 'running',
      count: active.length,
      label: others > 0 ? `${stepLabel(head)} · +${others}` : stepLabel(head),
      title: String(head?.title ?? ''),
      progress: Number.isFinite(head?.progress) ? head.progress : null,
    });
  }
  if (failed.length > 0) {
    chips.push({ kind: 'failed', count: failed.length, label: failed.length === 1 ? '1 task failed' : `${failed.length} tasks failed` });
  }
  return {
    chips,
    runningCount: active.length,
    finishedHint: tasks.length > active.length ? `${tasks.length - active.length} finished` : undefined,
  };
}
