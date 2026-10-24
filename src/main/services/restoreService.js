'use strict';
/**
 * Restore service — post-restart continuity (GPA G15).
 *
 * Two durable checkpoints under <userData>/restore.json (0600):
 *   - `route`: the last window route (currently a session id) so a relaunch
 *     (including an update relaunch) reopens where the user was.
 *   - `pendingUpdate`: written by the updater immediately before
 *     `app.relaunch()`, consumed on the next boot to tell the renderer which
 *     version replaced which.
 *
 * The renderer consumes the checkpoint on mount (`restore.consume`) and routes
 * itself; this keeps main free of renderer timing/race concerns.
 * Electron-free (honours QUANSIOX_USER_DATA_DIR).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROUTE_TYPES = new Set(['session', 'new', 'settings']);

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'restore.json'); }

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        route: normalizeRoute(parsed.route),
        pendingUpdate: normalizeUpdate(parsed.pendingUpdate),
        bootCount: Math.max(0, Number(parsed.bootCount) || 0),
        lastBootAt: Number(parsed.lastBootAt) || null,
        // The in-flight turn checkpoint (W7.6) survives the round trip.
        turn: normalizeTurn(parsed.turn),
      };
    }
  } catch { /* first boot / unreadable */ }
  return { route: null, pendingUpdate: null, bootCount: 0, lastBootAt: null, turn: null };
}
function save(state) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(state, null, 2), { mode: 0o600 });
}
function normalizeRoute(route) {
  if (!route || typeof route !== 'object') return null;
  const type = String(route.type || '');
  if (!ROUTE_TYPES.has(type)) return null;
  if (type === 'session') {
    const id = String(route.id || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    return { type, id, at: Number(route.at) || Date.now() };
  }
  return { type, at: Number(route.at) || Date.now() };
}
function normalizeTurn(turn) {
  if (!turn || typeof turn !== 'object') return null;
  const sessionId = String(turn.sessionId ?? '').slice(0, 64);
  if (!sessionId) return null;
  return {
    sessionId,
    step: Number(turn.step) || 0,
    model: String(turn.model ?? '').slice(0, 120),
    partialText: String(turn.partialText ?? '').slice(-4000),
    toolCalls: Array.isArray(turn.toolCalls) ? turn.toolCalls.slice(0, 20) : [],
    at: Number(turn.at) || Date.now(),
  };
}

function normalizeUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  const from = String(update.from ?? '').slice(0, 40);
  const to = String(update.to ?? '').slice(0, 40);
  if (!to) return null;
  return { from, to, at: Number(update.at) || Date.now() };
}

/** Remember where the user is (called on session switch / window route changes). */
function checkpoint(route) {
  const normalized = normalizeRoute(route);
  if (!normalized) throw new Error('invalid restore route');
  const state = load();
  state.route = normalized;
  save(state);
  return normalized;
}

/**
 * Checkpoint an in-flight turn.
 *
 * A turn can be long — a model that takes a minute, a tool that takes ten —
 * and a restart in the middle of it loses the work. A turn checkpoint
 * records where the turn was: the session, the step, and what the model had
 * said so far. It is small (the transcript itself is already on disk) and it
 * is what lets a restart resume rather than restart.
 */
function checkpointTurn(turn) {
  if (!turn || typeof turn !== 'object') throw new Error('a turn checkpoint needs an object');
  const sessionId = String(turn.sessionId ?? '').slice(0, 64);
  if (!sessionId) throw new Error('a turn checkpoint needs a session id');
  const state = load();
  state.turn = {
    sessionId,
    step: Number(turn.step) || 0,
    model: String(turn.model ?? '').slice(0, 120),
    partialText: String(turn.partialText ?? '').slice(-4000),
    toolCalls: Array.isArray(turn.toolCalls) ? turn.toolCalls.slice(0, 20) : [],
    at: Date.now(),
  };
  save(state);
  return state.turn;
}

/** The in-flight turn checkpoint, if there is one. */
function peekTurn() {
  return load().turn ?? null;
}

/** Forget the in-flight turn checkpoint. */
function clearTurn() {
  const state = load();
  delete state.turn;
  save(state);
  return true;
}

/** Record the update about to be applied; consumed on the next boot. */
function markUpdate(update) {
  const normalized = normalizeUpdate(update);
  if (!normalized) throw new Error('pending update needs a target version');
  const state = load();
  state.pendingUpdate = normalized;
  save(state);
  return normalized;
}

/**
 * Read-and-clear the boot checkpoint. Every call is a boot observation:
 * increments bootCount and stamps lastBootAt (the first consume per process).
 */
let consumedThisProcess = false;
function consume() {
  const state = load();
  if (!consumedThisProcess) {
    state.bootCount += 1;
    state.lastBootAt = Date.now();
    consumedThisProcess = true;
  }
  const result = {
    route: state.route,
    pendingUpdate: state.pendingUpdate,
    bootCount: state.bootCount,
    lastBootAt: state.lastBootAt,
  };
  state.route = null;
  state.pendingUpdate = null;
  save(state);
  return result;
}

/** Non-destructive view (diagnostics). */
function peek() {
  const state = load();
  return { route: state.route, pendingUpdate: state.pendingUpdate, bootCount: state.bootCount, lastBootAt: state.lastBootAt };
}

function clear() {
  const state = load();
  state.route = null;
  state.pendingUpdate = null;
  save(state);
  return true;
}

module.exports = {
  restoreService: {
    checkpoint, checkpointTurn, peekTurn, clearTurn, markUpdate, consume, peek, clear,
  },
};
