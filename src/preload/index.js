'use strict';
/**
 * Quansiox preload — meta-driven dynamic facade over a single invoke channel,
 * directly modeled on Manus Studio's preload. Renderer gets `window.quansiox`
 * with per-namespace API objects plus an `on(namespace, method, listener)`
 * subscription helper for main->renderer events.
 *
 * On top of that it exposes the newer protocol surface (W2):
 *
 *   `edge(edge, route, args, opts)`  — the edge-aware RPC channel, with the
 *                                      reference's `{ok, value}` /
 *                                      `{ok, failure}` envelope and nonce
 *                                      idempotency;
 *   `capabilities()`                 — what this install can do;
 *   `events.cursor()` / `events.replay(channel, afterSeq)` — the resumable
 *                                      event cursor.
 */
const { contextBridge, ipcRenderer } = require('electron');

const API_CHANNEL = 'quansiox-ipc-api';
const EDGE_CHANNEL = 'quansiox-ipc-edge';
const CAPABILITIES_CHANNEL = 'quansiox-ipc-capabilities';
const EVENT_CHANNEL = 'quansiox-ipc-event';
const META_CHANNEL = 'quansiox-ipc-meta';

const meta = ipcRenderer.sendSync(META_CHANNEL);
if (!meta) {
  console.error('[quansiox-preload] meta unavailable');
}

const api = {};
for (const [namespace, methods] of meta?.handlers ?? []) {
  api[namespace] = Object.fromEntries(
    methods.map((method) => [
      method,
      async (...args) => {
        const response = await ipcRenderer.invoke(API_CHANNEL, `${namespace}:${method}`, ...args);
        if (!response || typeof response !== 'object' || !('ok' in response)) {
          throw new Error('malformed IPC response');
        }
        if (!response.ok) throw new Error(response.error);
        return response.result;
      },
    ])
  );
}

const listeners = new Map(); // "ns:method" -> Set<fn>

function dispatch(namespace, method, args) {
  const route = `${namespace}:${method}`;
  for (const fn of listeners.get(route) ?? []) {
    try { fn(...args); } catch (error) { console.error('[quansiox-preload] listener error', error); }
  }
}

ipcRenderer.on(EVENT_CHANNEL, (_event, route, ...args) => {
  const index = route.indexOf(':');
  if (index === -1) return;
  dispatch(route.slice(0, index), route.slice(index + 1), args);
});

// Fast-path data plane: a dedicated MessagePort for hot agent traffic.
ipcRenderer.on('quansiox-ipc-port', (event) => {
  const port = event.ports?.[0];
  if (!port) return;
  port.onmessage = (messageEvent) => {
    const data = messageEvent.data;
    if (!Array.isArray(data) || data.length < 3) return;
    const [tag, namespace, method, ...args] = data;
    if (tag !== 'port') return;
    dispatch(namespace, method, args);
  };
  port.start();
});

const events = {
  on(namespace, method, listener) {
    const route = `${namespace}:${method}`;
    if (!listeners.has(route)) listeners.set(route, new Set());
    listeners.get(route).add(listener);
    return () => listeners.get(route)?.delete(listener);
  },
  /**
   * The current event cursor — store it and pass it back to `replay` after a
   * reload to catch up on what was missed.
   */
  cursor() {
    return ipcRenderer.sendSync('quansiox-ipc-event-cursor') ?? 0;
  },
  /**
   * The retained events of a channel after a sequence number.
   * @param {string} channel
   * @param {number} afterSeq
   */
  async replay(channel, afterSeq = 0) {
    const response = await ipcRenderer.invoke('quansiox-ipc-event-replay', { channel, afterSeq });
    if (!response?.ok) return [];
    return response.result ?? [];
  },
};

const edge = async (edgeName, route, args = {}, opts = {}) => {
  const response = await ipcRenderer.invoke(EDGE_CHANNEL, {
    edge: edgeName, route, args, nonce: opts.nonce ?? null,
  });
  if (!response || typeof response !== 'object' || !('ok' in response)) {
    throw new Error('malformed edge response');
  }
  return response;
};

const capabilities = async () => {
  const response = await ipcRenderer.invoke(CAPABILITIES_CHANNEL);
  return response?.ok ? response.result : null;
};

contextBridge.exposeInMainWorld('quansiox', { api, events, meta, edge, capabilities });
