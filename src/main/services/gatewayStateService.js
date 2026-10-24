'use strict';
/**
 * Gateway state service — the local "gateway" control plane for the grok
 * compatibility surface. Grok's renderer talks to a gateway worker that can
 * be paused, reconnected, or put into a dev-induced offline mode; Quansiox's
 * gateway is in-process, so this service tracks that state for real: while
 * paused/offline the dispatcher refuses non-control methods, and the control
 * methods (forceReconnectGateway, setGatewayPaused, setDevGatewayOffline,
 * resolveGatewayConnection, timezone) stay reachable so the state can be
 * cleared again. Dispatch counters feed the diagnostics view.
 *
 * In-memory (like Grok's worker state); Electron-free.
 */
const CONTROL_METHODS = new Set([
  'forceReconnectGateway',
  'setGatewayPaused',
  'setDevGatewayOffline',
  'resolveGatewayConnection',
  'getTimeZone',
  'setTimeZoneOverride',
]);

const state = {
  paused: false,
  devOffline: false,
  dispatches: 0,
  errors: 0,
  lastDispatchAt: null,
  lastDispatchMethod: null,
  lastReconnectAt: null,
  pausedAt: null,
  offlineAt: null,
  lastBackendReturnAt: null,
  lastNetworkReturnAt: null,
  backendReturns: 0,
  networkReturns: 0,
  boxState: null,
  boxStateAt: null,
  traceWindowOpen: false,
  traceparent: null,
};

const TRACE_RING_MAX = 200;
const traceRing = [];
const traceListeners = new Set();

function emit(event, payload) {
  try { require('../ipc/emitEvent').emitEvent('gateway', event, payload); } catch {}
}

function gate(method) {
  if (CONTROL_METHODS.has(method)) return null;
  if (state.paused) return 'gateway paused (setGatewayPaused)';
  if (state.devOffline) return 'gateway offline (dev-induced via setDevGatewayOffline)';
  return null;
}

function noteDispatch(method, status) {
  state.dispatches += 1;
  state.lastDispatchAt = Date.now();
  state.lastDispatchMethod = method;
  if (status && status !== 'ok') state.errors += 1;
}

function reconnect() {
  const wasPaused = state.paused;
  const wasOffline = state.devOffline;
  state.paused = false;
  state.devOffline = false;
  state.lastReconnectAt = Date.now();
  emit('reconnected', { wasPaused, wasOffline, at: state.lastReconnectAt });
  return { reconnected: true, wasPaused, wasOffline, at: state.lastReconnectAt, connected: true };
}

function setPaused(paused) {
  state.paused = Boolean(paused);
  state.pausedAt = state.paused ? Date.now() : null;
  emit('paused', { paused: state.paused });
  return { paused: state.paused };
}

function setDevOffline(induced) {
  state.devOffline = Boolean(induced);
  state.offlineAt = state.devOffline ? Date.now() : null;
  emit('offline', { induced: state.devOffline });
  return { induced: state.devOffline };
}

function noteBackendReturn() {
  state.lastBackendReturnAt = Date.now();
  state.backendReturns += 1;
  emit('backendReturn', { at: state.lastBackendReturnAt, count: state.backendReturns });
  return { noted: true, at: state.lastBackendReturnAt, count: state.backendReturns };
}

function noteNetworkReturn() {
  state.lastNetworkReturnAt = Date.now();
  state.networkReturns += 1;
  emit('networkReturn', { at: state.lastNetworkReturnAt, count: state.networkReturns });
  return { noted: true, at: state.lastNetworkReturnAt, count: state.networkReturns };
}

function noteBoxState(boxState) {
  const next = boxState === 'running' ? 'running' : 'asleep';
  state.boxState = next;
  state.boxStateAt = Date.now();
  emit('boxState', { boxState: next, at: state.boxStateAt });
  return { boxState: next, at: state.boxStateAt };
}

function randomHex(bytes) {
  return require('node:crypto').randomBytes(bytes).toString('hex');
}

function generateTraceparent() {
  // W3C trace context: 00-<32 hex trace id>-<16 hex span id>-01 (sampled).
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

/** Open the RPC trace window (trace context becomes visible to clients). */
function openTraceWindow(traceparent) {
  state.traceWindowOpen = true;
  state.traceparent = traceparent || generateTraceparent();
  return state.traceparent;
}

function closeTraceWindow() {
  state.traceWindowOpen = false;
  state.traceparent = null;
  traceListeners.clear();
}

function getTraceWindowTraceparent() {
  return state.traceWindowOpen ? state.traceparent : null;
}

function onTrace(listener) {
  traceListeners.add(listener);
  return () => traceListeners.delete(listener);
}

function noteTrace(method, status) {
  if (!state.traceWindowOpen) return;
  const entry = { at: Date.now(), method, status, traceparent: state.traceparent };
  traceRing.push(entry);
  if (traceRing.length > TRACE_RING_MAX) traceRing.splice(0, traceRing.length - TRACE_RING_MAX);
  for (const listener of traceListeners) {
    try { listener(entry); } catch {}
  }
}

function traceEntries() {
  return traceRing.slice();
}

function status() {
  return { ...state, connected: !state.paused && !state.devOffline };
}

function resetForTests() {
  state.paused = false;
  state.devOffline = false;
  state.dispatches = 0;
  state.errors = 0;
  state.lastDispatchAt = null;
  state.lastDispatchMethod = null;
  state.lastBackendReturnAt = null;
  state.lastNetworkReturnAt = null;
  state.backendReturns = 0;
  state.networkReturns = 0;
  state.boxState = null;
  state.boxStateAt = null;
  state.traceWindowOpen = false;
  state.traceparent = null;
  traceRing.length = 0;
  traceListeners.clear();
}

module.exports = { gatewayStateService: { controlMethods: CONTROL_METHODS, gate, noteDispatch, reconnect, setPaused, setDevOffline, noteBackendReturn, noteNetworkReturn, noteBoxState, openTraceWindow, closeTraceWindow, getTraceWindowTraceparent, generateTraceparent, onTrace, noteTrace, traceEntries, status, resetForTests } };
