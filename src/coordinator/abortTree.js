'use strict';
/**
 * The abort tree — one place that knows how to stop a run and everything
 * under it.
 *
 * Stopping a subagent has to reach the child's own process, not just the
 * bookkeeping that says it stopped. The reference implementation sends a
 * `StopSubagent` message; locally, the child's abort controller is the thing
 * that has to be signalled, and the child's children have to be signalled
 * too.
 *
 * The registry lives in its own module so that the agent-lifecycle tools
 * (`stop_subagent`) can reach it without importing the coordinator's main
 * module — which would be a cycle.
 */

/** sessionId -> the scheduler that runs it. */
const schedulers = new Map();
/** root sessionId -> the set of child run session ids under it. */
const nestedChildren = new Map();

/** Register a session's scheduler. */
function registerScheduler(sessionId, scheduler) {
  const id = String(sessionId ?? '');
  if (!id) return null;
  schedulers.set(id, scheduler);
  return scheduler;
}

/** The scheduler for a session, if it has one. */
function schedulerFor(sessionId) {
  return schedulers.get(String(sessionId ?? '')) ?? null;
}

/** Forget a session's scheduler. */
function forgetScheduler(sessionId) {
  return schedulers.delete(String(sessionId ?? ''));
}

/** Record that `sessionId` is a child of `root`. */
function registerNested(root, sessionId) {
  if (!root || !sessionId || root === sessionId) return;
  const set = nestedChildren.get(root) || new Set();
  set.add(sessionId);
  nestedChildren.set(root, set);
}

/** The children of a root. */
function childrenOf(root) {
  return [...(nestedChildren.get(String(root ?? '')) ?? [])];
}

/**
 * Abort a run and everything under it.
 * @returns {{ aborted: string[] }} the sessions that were signalled
 */
function abortTree(sessionId) {
  const id = String(sessionId ?? '');
  if (!id) return { aborted: [] };
  const aborted = [];
  const scheduler = schedulers.get(id);
  if (scheduler) {
    try { scheduler.abortAll(); aborted.push(id); } catch { /* already stopped */ }
  }
  const kids = nestedChildren.get(id);
  if (kids) {
    for (const kid of kids) aborted.push(...abortTree(kid).aborted);
    nestedChildren.delete(id);
  }
  return { aborted };
}

module.exports = {
  abortTree,
  childrenOf,
  forgetScheduler,
  nestedChildren,
  registerNested,
  registerScheduler,
  schedulerFor,
  schedulers,
};
