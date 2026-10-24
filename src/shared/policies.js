'use strict';
/**
 * Policy kit — deadlines, retries, backoff and watchdogs.
 *
 * The reference implementation (Grok Bot's coordinator) names every timeout
 * and every retry policy, which makes the reliability behaviour of a call
 * visible in the code rather than buried in ad-hoc `setTimeout`s. We keep that
 * discipline: a call that crosses a process boundary declares its deadline
 * policy by name, so a log line can say exactly which policy it was under.
 *
 * Pure module — no Electron, no timers of its own beyond the ones it creates.
 */

/** How long a call may take before it is abandoned. */
function deadline(name, timeoutMs) {
  const ms = Math.max(1, Number(timeoutMs) || 0);
  return {
    name,
    timeoutMs: ms,
    /** A promise that rejects with a DeadlineError after the timeout. */
    guard() {
      let timer = null;
      const promise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${name} timed out after ${ms}ms`);
          error.code = 'DEADLINE_EXCEEDED';
          error.policy = name;
          reject(error);
        }, ms);
        // NOT unref'd: the work this deadline guards is what keeps the
        // process alive, and a deadline that lets the process exit early is
        // not a deadline.
      });
      return {
        promise,
        cancel: () => { if (timer) { clearTimeout(timer); timer = null; } },
      };
    },
  };
}

/**
 * A retry policy.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {number} [opts.maxAttempts]  total attempts, including the first
 * @param {number} [opts.initialDelayMs]
 * @param {number} [opts.maxDelayMs]
 * @param {number} [opts.backoffFactor]
 * @param {'fixed'|'until-signal'} [opts.mode]
 * @param {Function} [opts.shouldRetry]  (error, attempt) => boolean
 * @param {Function} [opts.onRetry]      (attempt, delayMs, error) => void
 */
function retry(opts = {}) {
  const name = String(opts.name || 'retry');
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 1);
  const initialDelayMs = Math.max(0, Number(opts.initialDelayMs) || 0);
  const maxDelayMs = Math.max(initialDelayMs, Number(opts.maxDelayMs) || Infinity);
  const backoffFactor = Math.max(1, Number(opts.backoffFactor) || 1);
  const shouldRetry = typeof opts.shouldRetry === 'function'
    ? opts.shouldRetry
    : () => true;
  return {
    name,
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoffFactor,
    mode: opts.mode === 'until-signal' ? 'until-signal' : 'bounded',
    shouldRetry,
    onRetry: typeof opts.onRetry === 'function' ? opts.onRetry : null,
    /** The delay before attempt `attempt` (1-based). */
    delayFor(attempt) {
      const raw = initialDelayMs * (backoffFactor ** Math.max(0, attempt - 1));
      return Math.min(maxDelayMs, raw);
    },
    /**
     * Run `fn`, retrying according to this policy.
     * @param {Function} fn  async (attempt) => result
     * @param {object} [runtime]
     * @param {AbortSignal} [runtime.signal]
     */
    async run(fn, runtime = {}) {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          return await fn(attempt);
        } catch (error) {
          const canRetry = attempt < maxAttempts
            && shouldRetry(error, attempt)
            && !(runtime.signal?.aborted);
          if (!canRetry) throw error;
          const delay = this.delayFor(attempt);
          if (this.onRetry) {
            try { this.onRetry(attempt, delay, error); } catch { /* reporting is best-effort */ }
          }
          if (delay > 0) await sleep(delay, runtime.signal);
        }
      }
    },
  };
}

/**
 * An idle watchdog: fires when nothing has happened for `idleMs`.
 * Used for streams that must not hang silently.
 */
function idleWatchdog(opts = {}) {
  const name = String(opts.name || 'watchdog');
  const idleMs = Math.max(1, Number(opts.idleMs) || 30_000);
  let timer = null;
  let onIdle = opts.onIdle ?? null;
  return {
    name,
    idleMs,
    /** Mark activity — resets the countdown. */
    touch() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try { onIdle?.(new Error(`${name} stalled for ${idleMs}ms`)); } catch { /* best effort */ }
      }, idleMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearTimeout(timer); timer = null; } },
  };
}

/** A repeating interval, used for heartbeats. */
function interval(opts = {}) {
  const name = String(opts.name || 'interval');
  const intervalMs = Math.max(1, Number(opts.intervalMs) || 10_000);
  let timer = null;
  return {
    name,
    intervalMs,
    start(fn) {
      this.stop();
      timer = setInterval(() => {
        try { fn(); } catch { /* the body owns its errors */ }
      }, intervalMs);
      if (timer.unref) timer.unref();
      return this;
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

/** A one-shot delay that can be aborted. */
function delay(opts = {}) {
  const name = String(opts.name || 'delay');
  const ms = Math.max(0, Number(opts.timeoutMs) || 0);
  return {
    name,
    timeoutMs: ms,
    async wait(signal) {
      if (ms <= 0) return;
      await sleep(ms, signal);
    },
  };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); resolve(); };
      if (signal.aborted) { clearTimeout(timer); resolve(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // NOT unref'd: a retry backoff is the thing keeping the process alive
    // between attempts. An unref'd sleep lets the process exit mid-retry.
  });
}

/**
 * The named policies the app uses, so a call site can say which one it is
 * under and a log line can be matched against it.
 */
const POLICIES = {
  // A provider request: bounded, with backoff.
  providerRequest: () => retry({
    name: 'provider-request',
    maxAttempts: 3,
    initialDelayMs: 500,
    maxDelayMs: 8_000,
    backoffFactor: 2,
    shouldRetry: (error) => {
      const status = Number(error?.status ?? error?.response?.status ?? 0);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
      return true;
    },
  }),
  // A command sent to the sandbox: it may take a while, but not forever.
  sandboxCommand: () => deadline('sandbox-command', 120_000),
  // A tool call that must not outlive the turn.
  toolCall: () => deadline('tool-call', 300_000),
  // A turn's total budget.
  turn: () => deadline('turn', 1_800_000),
  // A heartbeat to the local exec daemon.
  localExecHeartbeat: () => interval({ name: 'local-exec-heartbeat', intervalMs: 10_000 }),
  // An idle stream must not hang.
  streamIdle: () => idleWatchdog({ name: 'stream-idle', idleMs: 35_000 }),
};

module.exports = {
  POLICIES,
  deadline,
  delay,
  idleWatchdog,
  interval,
  retry,
  sleep,
};
