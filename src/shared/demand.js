'use strict';
/**
 * Demand scheduling — priority for work that crosses a boundary.
 *
 * The reference implementation tags every RPC `person` or `background`: a
 * request from a person in front of the agent outranks background reads, and
 * background work may be dropped entirely when the connection is busy.
 *
 * The same shape is useful here. The renderer asks for a transcript tail
 * (a person is waiting) while the app refreshes avatars, presence and
 * telemetry in the background. Without a priority, the background work can
 * delay the thing a human is looking at.
 *
 * Pure module — the caller supplies the concurrency.
 */

/** The two demand classes. */
const DEMAND = {
  /** A person is waiting for this. It is never dropped. */
  PERSON: 'person',
  /** Nobody is waiting. It may be dropped under pressure. */
  BACKGROUND: 'background',
};

const RANK = { [DEMAND.PERSON]: 0, [DEMAND.BACKGROUND]: 1 };

/**
 * A priority queue with a concurrency cap.
 *
 * Work is dispatched highest-demand-first; within a class, FIFO. When the
 * queue is over its soft limit, BACKGROUND work is dropped rather than
 * queued — a dropped background read is invisible to the user, a dropped
 * foreground read is not.
 */
class DemandScheduler {
  /**
   * @param {object} [opts]
   * @param {number} [opts.concurrency] how many run at once
   * @param {number} [opts.softLimit]  queue length above which background work is dropped
   * @param {Function} [opts.onDrop]    (task) => void
   */
  constructor(opts = {}) {
    this.concurrency = Math.max(1, Number(opts.concurrency) || 4);
    this.softLimit = Math.max(this.concurrency, Number(opts.softLimit) || 64);
    this.onDrop = typeof opts.onDrop === 'function' ? opts.onDrop : null;
    this.queues = { [DEMAND.PERSON]: [], [DEMAND.BACKGROUND]: [] };
    this.running = 0;
    this.dropped = 0;
    this.completed = 0;
  }

  /**
   * Submit work.
   * @param {Function} fn       async () => result
   * @param {object} [opts]
   * @param {string} [opts.demand] 'person' | 'background'
   * @param {*} [opts.label]
   * @returns {Promise<*>}
   */
  submit(fn, opts = {}) {
    const demand = opts.demand === DEMAND.BACKGROUND ? DEMAND.BACKGROUND : DEMAND.PERSON;
    if (demand === DEMAND.BACKGROUND && this.pending() >= this.softLimit) {
      this.dropped += 1;
      if (this.onDrop) { try { this.onDrop(opts.label ?? null); } catch { /* best effort */ } }
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      this.queues[demand].push({ fn, resolve, reject, label: opts.label ?? null });
      this.pump();
    });
  }

  pending() {
    return this.queues[DEMAND.PERSON].length + this.queues[DEMAND.BACKGROUND].length;
  }

  async pump() {
    while (this.running < this.concurrency) {
      const task = this.take();
      if (!task) return;
      this.running += 1;
      Promise.resolve()
        .then(() => task.fn())
        .then(
          (value) => { this.running -= 1; this.completed += 1; task.resolve(value); this.pump(); },
          (error) => { this.running -= 1; task.reject(error); this.pump(); },
        );
    }
  }

  take() {
    for (const demand of [DEMAND.PERSON, DEMAND.BACKGROUND]) {
      const queue = this.queues[demand];
      if (queue.length) return queue.shift();
    }
    return null;
  }

  stats() {
    return {
      running: this.running,
      person: this.queues[DEMAND.PERSON].length,
      background: this.queues[DEMAND.BACKGROUND].length,
      dropped: this.dropped,
      completed: this.completed,
      concurrency: this.concurrency,
    };
  }
}

/**
 * Tag a function as background work — the shorthand the call sites use.
 */
function background(fn, label) {
  return { fn, demand: DEMAND.BACKGROUND, label };
}

module.exports = { DEMAND, DemandScheduler, RANK, background };
