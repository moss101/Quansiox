'use strict';
/**
 * Harnesses — where a session's work actually runs.
 *
 * The reference implementation routes every agent to one of two places: a
 * remote Kubernetes "forever box" or Cursor's cloud ("temporal"). That
 * routing is not a detail — it is the reason the reference is a *client*: the
 * client decides nothing about where the work happens.
 *
 * Quansiox is local-first, and it already runs work in three places: the
 * host process (a sandboxed shell), the per-session Linux guest (a kernel-
 * isolated desktop), and a forked coordinator child. What it lacks is a
 * single abstraction over "where does this session's work run", which is
 * what stops a remote box from ever being added without touching the UI.
 *
 * So: a **harness** is the answer to "given this session, where do shell,
 * computer and browser calls go?". There are two implementations today
 * (`local` and `guest`), and the registry is the seam a third one (`remote`)
 * would slot into.
 *
 * Pure-ish: the implementations are injected, so the routing is testable
 * without a VM.
 */

/** The harness kinds. */
const KIND = {
  /** The host process: a sandboxed shell, the host Mac, the embedded browser. */
  LOCAL: 'local',
  /** The per-session Linux guest: an isolated desktop and its own Chromium. */
  GUEST: 'guest',
  /** A separate worker process. */
  WORKER: 'worker',
  /** A remote machine. Not implemented — the registry is the seam. */
  REMOTE: 'remote',
};

/** The capability vocabulary a harness advertises. */
const CAPABILITY = {
  SHELL: 'shell',
  FILES: 'files',
  COMPUTER: 'computer',
  BROWSER: 'browser',
  NETWORK: 'network',
  PERSISTENT: 'persistent',
};

/**
 * The harness registry.
 *
 * A harness is `{ id, kind, capabilities, route }` where `route` answers the
 * one question the coordinator asks: which implementation handles a given
 * kind of call for a given session.
 */
class HarnessRegistry {
  constructor() {
    /** sessionId -> harness id */
    this.bySession = new Map();
    /** harness id -> harness */
    this.harnesses = new Map();
    this.defaultId = KIND.LOCAL;
  }

  /** Register a harness implementation. */
  register(harness) {
    if (!harness?.id) throw new Error('a harness needs an id');
    this.harnesses.set(harness.id, harness);
    return harness;
  }

  /** Pin a session to a harness. */
  assign(sessionId, harnessId) {
    const id = String(sessionId ?? '');
    if (!id) throw new Error('a harness assignment needs a session id');
    if (!this.harnesses.has(harnessId)) throw new Error(`unknown harness: ${harnessId}`);
    this.bySession.set(id, harnessId);
    return harnessId;
  }

  /** Release a session's harness. */
  release(sessionId) {
    const id = String(sessionId ?? '');
    const previous = this.bySession.get(id) ?? null;
    this.bySession.delete(id);
    return previous;
  }

  /** The harness for a session (the default when it has none). */
  for(sessionId) {
    const id = this.bySession.get(String(sessionId ?? '')) ?? this.defaultId;
    const harness = this.harnesses.get(id);
    if (!harness) throw new Error(`unknown harness: ${id}`);
    return harness;
  }

  /** The harness id for a session. */
  idFor(sessionId) {
    return this.bySession.get(String(sessionId ?? '')) ?? this.defaultId;
  }

  /** Every registered harness, described. */
  describe() {
    return [...this.harnesses.values()].map((h) => ({
      id: h.id,
      kind: h.kind,
      description: h.description ?? '',
      capabilities: [...(h.capabilities ?? [])],
      persistent: Boolean(h.capabilities?.includes(CAPABILITY.PERSISTENT)),
    }));
  }

  /** The routing table the UI can read to explain where work runs. */
  routing() {
    const out = {};
    for (const [sessionId, id] of this.bySession) out[sessionId] = id;
    return { default: this.defaultId, sessions: out, harnesses: this.describe() };
  }
}

const registry = new HarnessRegistry();

/**
 * The local harness — the host process.
 *
 * The shell runs in the per-session sandbox (a seatbelt-confined daemon, or
 * the Linux guest when `sandboxMode` says so); the computer and the browser
 * are the host's own.
 */
registry.register({
  id: KIND.LOCAL,
  kind: KIND.LOCAL,
  description: 'this Mac — a seatbelt-confined sandbox, the host display, the embedded browser',
  capabilities: [CAPABILITY.SHELL, CAPABILITY.FILES, CAPABILITY.COMPUTER, CAPABILITY.BROWSER, CAPABILITY.NETWORK],
  /**
   * Where a call of this kind goes.
   * @returns {'sandbox'|'guest'|'host'|'embedded'}
   */
  route(kind, ctx = {}) {
    if (kind === CAPABILITY.SHELL || kind === CAPABILITY.FILES) {
      const mode = ctx.sandboxMode ?? 'sandboxed';
      if (mode === 'vm' || mode === 'guest') return 'guest';
      return 'sandbox';
    }
    if (kind === CAPABILITY.COMPUTER) return ctx.computerTarget === 'host' ? 'host' : 'guest';
    if (kind === CAPABILITY.BROWSER) return ctx.browserTarget === 'host' ? 'embedded' : 'guest';
    return 'host';
  },
});

/**
 * The guest harness — the per-session Linux desktop.
 *
 * Everything runs inside the guest: the shell, the browser, the screen. The
 * user's real machine is not touched at all.
 */
registry.register({
  id: KIND.GUEST,
  kind: KIND.GUEST,
  description: 'the session\'s own Linux guest — kernel-isolated desktop, browser and shell',
  capabilities: [CAPABILITY.SHELL, CAPABILITY.FILES, CAPABILITY.COMPUTER, CAPABILITY.BROWSER, CAPABILITY.PERSISTENT],
  route(kind) {
    if (kind === CAPABILITY.BROWSER) return 'guest';
    return 'guest';
  },
});

/**
 * The worker harness — a separate process.
 *
 * Registered so the seam exists and can be exercised, but the process pool
 * itself is not built yet: `available` is false and the reason says so.
 */
registry.register({
  id: KIND.WORKER,
  kind: KIND.WORKER,
  description: 'a separate worker process (not implemented yet)',
  capabilities: [CAPABILITY.SHELL, CAPABILITY.FILES],
  available: false,
  reason: 'the worker process pool is not implemented yet',
  route() { return 'sandbox'; },
});

module.exports = {
  CAPABILITY,
  HarnessRegistry,
  KIND,
  registry,
};
