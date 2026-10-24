'use strict';
/**
 * Per-session FIFO run queue (docs: a message sent while the bot is working
 * is answered after the current turn). The head task starts immediately; every
 * further task queues behind it and starts when the previous run settles.
 * Pure logic — the caller supplies `start(sessionId, task, meta)` returning
 * the run promise — so it is unit-testable without the coordinator.
 */

function createRunQueue(start) {
  const sessions = new Map(); // sessionId -> { items: [{ task, resolve, reject }] }

  function begin(sessionId, state, task, dequeued) {
    let result;
    try {
      result = start(sessionId, task, { dequeued });
    } catch (error) {
      result = Promise.reject(error);
    }
    return Promise.resolve(result)
      .finally(() => {
        const next = state.items.shift();
        if (next) begin(sessionId, state, next.task, true).then(next.resolve, next.reject);
        else sessions.delete(sessionId);
      });
  }

  function run(sessionId, task, onQueued) {
    let state = sessions.get(sessionId);
    if (state) {
      return new Promise((resolve, reject) => {
        state.items.push({ task, resolve, reject });
        if (onQueued) {
          try { onQueued(state.items.length); } catch { /* reporting is best-effort */ }
        }
      });
    }
    state = { items: [] };
    sessions.set(sessionId, state);
    return begin(sessionId, state, task, false);
  }

  /**
   * Redirect (docs: a direct message takes priority): move a queued task to
   * the front so it starts the moment the current run settles. Returns false
   * when the queue does not hold that messageId.
   */
  function promote(sessionId, messageId) {
    const state = sessions.get(sessionId);
    if (!state || !messageId) return false;
    const index = state.items.findIndex((it) => it.task?.opts?.messageId === messageId);
    if (index === -1) return false;
    if (index > 0) {
      const [item] = state.items.splice(index, 1);
      state.items.unshift(item);
    }
    return true;
  }

  return {
    run,
    promote,
    depth: (sessionId) => sessions.get(sessionId)?.items.length ?? 0,
    busy: (sessionId) => sessions.has(sessionId),
  };
}

module.exports = { createRunQueue };
