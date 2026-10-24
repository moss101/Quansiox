'use strict';
/**
 * Per-bot computer runtime.
 *
 * Grok Bot gives every Bot (agent) one persistent "box": a Linux machine with
 * a live screen (VNC), shell/files and a browser, which its subagents drive.
 * Quansiox had the primitives (boot desktop VM, screenBridge, guest input,
 * RFB screenshots) but only behind a manual "Display" button, and nothing tied
 * them to a session. This service is that tie:
 *
 *   sessionId (bot) → { phase, url, rfbSock, cdpSock, input }
 *
 * The first computer tool call (or the UI asking to watch) lazily boots the
 * session's VM, waits until the guest answers RFB (not merely until the socket
 * file exists), attaches the WebSocket screen bridge + RFB input client, and
 * publishes state so the renderer can show "starting → live". Boot is
 * single-flight per session; repeated calls share one promise. Every dependency
 * is injectable so the lifecycle is unit-tested without VZ.
 *
 * Honest fallback: when the host cannot run VZ (or the image is missing),
 * `ensure` throws COMPUTER_UNAVAILABLE and callers keep the host-Mac path.
 */
const { desktopVmService } = require('./desktopVmService');
const { screenBridge } = require('./screenBridge');
const { guestComputerBridge } = require('./guestComputerBridge');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function defaultDeps() {
  return {
    available: () => desktopVmService.available(),
    boot: (opts) => desktopVmService.boot(opts),
    stopVm: (sessionId) => desktopVmService.stop(sessionId),
    attachScreen: (sessionId, target) => screenBridge.attach(sessionId, target),
    closeScreen: (sessionId) => screenBridge.close(sessionId),
    screenUrl: (sessionId) => screenBridge.url(sessionId),
    attachInput: (sessionId, sock) => guestComputerBridge.attach(sessionId, sock),
    detachInput: (sessionId) => guestComputerBridge.detach(sessionId),
    sandboxRoot: (sessionId) => {
      try { return require('./sandboxService').sandboxService.sandboxRoot(sessionId); } catch { return null; }
    },
    workspaceRoot: () => {
      try { return require('./settingsService').settingsService.load().workspaceRoot; } catch { return null; }
    },
    emit: (state) => {
      try { require('../ipc/emitEvent').emitEvent('computer', 'onState', state); } catch { /* non-Electron/test context */ }
    },
    now: () => Date.now(),
  };
}

let deps = defaultDeps();

/** sessionId -> public state (serializable, renderer-safe). */
const states = new Map();
/** sessionId -> in-flight ensure promise. */
const inflight = new Map();
/** sessionId -> epoch; Stop during a boot bumps it so the boot cannot win. */
const epochs = new Map();

function epochOf(sessionId) { return epochs.get(String(sessionId)) || 0; }
function bumpEpoch(sessionId) { epochs.set(String(sessionId), epochOf(sessionId) + 1); }
function cancelled(sessionId) {
  const error = new Error('COMPUTER_CANCELLED — the computer was stopped while starting');
  error.code = 'COMPUTER_CANCELLED';
  error.sessionId = String(sessionId);
  return error;
}

function setDeps(next = {}) {
  deps = { ...defaultDeps(), ...next };
}
function resetDeps() { deps = defaultDeps(); }

function blank(sessionId) {
  return {
    sessionId,
    phase: 'off',
    url: null,
    rfbSock: null,
    cdpSock: null,
    input: false,
    display: true,
    runtimeKind: 'linux-desktop',
    available: safeAvailable(),
    startedAt: null,
    error: null,
  };
}

function safeAvailable() {
  try { return deps.available() === true; } catch { return false; }
}

function publish(state) {
  states.set(state.sessionId, state);
  try { deps.emit({ ...state }); } catch { /* events are best-effort */ }
  return state;
}

function validate(sessionId) {
  const sid = String(sessionId ?? '');
  if (!ID_RE.test(sid)) throw new Error('invalid session id');
  return sid;
}

function status(sessionId) {
  const sid = validate(sessionId);
  const state = states.get(sid);
  if (!state) return { ...blank(sid), available: safeAvailable() };
  return { ...state, available: safeAvailable() };
}

function screen(sessionId) {
  const state = status(sessionId);
  return { sessionId: state.sessionId, phase: state.phase, url: state.url, ready: state.phase === 'ready' };
}

function canProvide() { return safeAvailable(); }

function capacity() {
  const n = Number(process.env.QUANSIOX_MAX_COMPUTERS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}

function liveCount() {
  return [...states.values()].filter((s) => s.phase === 'starting' || s.phase === 'ready').length;
}

/**
 * Boot (once) and attach the session's computer. Resolves with the public state
 * when the screen + input are live; rejects with a code-bearing error otherwise.
 */
async function ensure(sessionId, options = {}) {
  const sid = validate(sessionId);
  const current = states.get(sid);
  if (current?.phase === 'ready') return { ...current };
  if (inflight.has(sid)) return inflight.get(sid);
  if (!safeAvailable()) {
    const error = new Error('COMPUTER_UNAVAILABLE — this host cannot run the Linux guest (VZ or desktop image missing)');
    error.code = 'COMPUTER_UNAVAILABLE';
    throw error;
  }
  // Bounded fleet: each guest is a real VM. Do not let a fan-out of isolated
  // children exhaust memory; callers get an honest capacity error.
  if (liveCount() >= capacity()) {
    const error = new Error(`COMPUTER_CAPACITY — ${capacity()} bots already have a live computer; stop one first`);
    error.code = 'COMPUTER_CAPACITY';
    throw error;
  }

  const starting = publish({
    ...blank(sid),
    phase: 'starting',
    startedAt: deps.now(),
    reason: options.reason ? String(options.reason) : undefined,
  });
  const epoch = epochOf(sid);

  const run = (async () => {
    await Promise.resolve(); // always yield so inflight is set before any throw
    let entry = null;
    try {
      const shareDir = options.shareDir || deps.sandboxRoot(sid) || deps.workspaceRoot() || process.cwd();
      entry = await deps.boot({
        sessionId: sid,
        shareDir,
        memMB: options.memMB,
        timeoutMs: options.timeoutMs,
      });
      // A Stop (or Reset) during boot wins: tear the fresh guest down instead of
      // resurrecting a computer the user just closed.
      if (epochOf(sid) !== epoch) throw cancelled(sid);
      await deps.attachScreen(sid, { path: entry.rfbSock });
      let input = false;
      try {
        await deps.attachInput(sid, entry.rfbSock);
        input = true;
      } catch { /* screen-only: agent input falls back honestly */ }
      if (epochOf(sid) !== epoch) throw cancelled(sid);
      const ready = publish({
        ...starting,
        phase: 'ready',
        url: deps.screenUrl(sid) || null,
        rfbSock: entry.rfbSock || null,
        cdpSock: entry.cdpSock || null,
        input,
        readyAt: deps.now(),
      });
      return { ...ready };
    } catch (error) {
      try { deps.detachInput(sid); } catch {}
      try { deps.closeScreen(sid); } catch {}
      if (entry) { try { deps.stopVm(sid); } catch {} }
      if (error?.code === 'COMPUTER_CANCELLED') throw error; // Stop already published off
      const failed = publish({
        ...starting,
        phase: 'error',
        error: String(error?.message ?? error),
        input: false,
      });
      const wrapped = new Error(failed.error);
      wrapped.code = error?.code || 'COMPUTER_BOOT_FAILED';
      wrapped.state = failed;
      throw wrapped;
    } finally {
      inflight.delete(sid);
    }
  })();

  inflight.set(sid, run);
  return run;
}

function stop(sessionId) {
  const sid = validate(sessionId);
  bumpEpoch(sid); // invalidate an in-flight boot so it cannot publish ready after Stop
  const current = states.get(sid);
  try { deps.closeScreen(sid); } catch {}
  try { deps.detachInput(sid); } catch {}
  try { deps.stopVm(sid); } catch {}
  const state = publish({
    ...(current || blank(sid)),
    phase: 'off',
    url: null,
    rfbSock: null,
    cdpSock: null,
    input: false,
    error: null,
    stoppedAt: deps.now(),
  });
  return { ...state };
}

async function recover(sessionId) {
  const sid = validate(sessionId);
  stop(sid);
  return ensure(sid, { reason: 'recover' });
}

function reset(sessionId) {
  const sid = validate(sessionId);
  stop(sid);
  states.delete(sid);
  return { sessionId: sid, phase: 'off' };
}

function list() {
  return [...states.values()].map((state) => ({ ...state, available: safeAvailable() }));
}

function reapAll() {
  for (const sid of [...states.keys()]) {
    try { stop(sid); } catch {}
  }
}

module.exports = {
  computerRuntimeService: {
    ensure, status, screen, stop, recover, reset, list, reapAll, canProvide,
    setDeps, resetDeps,
  },
};
