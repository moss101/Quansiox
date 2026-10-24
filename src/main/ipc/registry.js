'use strict';
/**
 * Quansiox IPC registry — namespaced handler/event model inspired by
 * Manus Studio's `ipc/registry.ts` pattern:
 *
 *  - Main process registers namespaced handler maps:   { agent: { run, stop, ... } }
 *  - Renderer receives a meta description via sendSync and gets a typed facade
 *  - One invoke channel (`quansiox-ipc-api`) routes `namespace:method` calls
 *  - One event channel (`quansiox-ipc-event`) fans main->renderer events out,
 *    optionally scoped to a single BrowserWindow (emitScopedEvent).
 *
 * Sender verification (Cue's `verify(event)` hardening, agents-desktop):
 * every call on the single invoke/meta channel must originate from
 *  - a BrowserWindow this windowManager created and still tracks, and
 *  - that window's main frame (no iframes / subframes), and
 *  - our own renderer origin (file:// in packaged builds,
 *    http://localhost:5183 in dev).
 * Anything else is rejected before the handler is looked up.
 */

const { ipcMain, BrowserWindow, webContents } = require('electron');
const { emitEvent, emitScopedEvent } = require('./emitEvent');

/** @type {Record<string, Record<string, Function>>} */
const allHandlers = {};

/** Event names per namespace the renderer may subscribe to. */
const allEvents = {};

/** Argument validators per namespace/method: (args) => string | null. */
const allSchemas = {};

/** Dev server origin (windowManager loads localhost:5183 with --dev). */
const DEV_ORIGIN = 'http://localhost:5183';

const TYPES = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v != null && typeof v === 'object' && !Array.isArray(v),
};

/**
 * Declarative argument check. `fields` describes positional/first-object
 * arguments; returns a human-readable problem string or null when valid.
 *   { fields: [{ name: 'sessionId', type: 'string', pattern: /.../, required: true }] }
 */
function checkArgs(schema, args) {
  if (!schema || !Array.isArray(schema.fields)) return null;
  const first = args[0];
  const source = first != null && typeof first === 'object' && !Array.isArray(first) ? first : null;
  for (const field of schema.fields) {
    const lookups = [];
    if (Array.isArray(args)) for (const arg of args) if (arg != null && typeof arg === 'object') lookups.push(arg[field.name]);
    if (source && field.name in source) lookups.push(source[field.name]);
    const value = lookups.find((v) => v !== undefined);
    if (value === undefined || value === null) {
      if (field.required) return `missing required argument "${field.name}"`;
      continue;
    }
    if (field.type && TYPES[field.type] && !TYPES[field.type](value)) {
      return `argument "${field.name}" must be ${field.type}`;
    }
    if (field.enum && !field.enum.includes(value)) {
      return `argument "${field.name}" must be one of ${field.enum.join('|')}`;
    }
    if (field.pattern && !field.pattern.test(String(value))) {
      return `argument "${field.name}" has an invalid format`;
    }
    if (field.max && typeof value === 'string' && value.length > field.max) {
      return `argument "${field.name}" exceeds ${field.max} characters`;
    }
  }
  return null;
}

function registerNamespace(namespace, { handlers = {}, events = [], schemas = {} }) {
  if (allHandlers[namespace]) {
    throw new Error(`IPC namespace already registered: ${namespace}`);
  }
  allHandlers[namespace] = handlers;
  allEvents[namespace] = events;
  allSchemas[namespace] = schemas;
}

function getExposedMeta() {
  return {
    handlers: Object.entries(allHandlers).map(([ns, handlers]) => [
      ns,
      Object.keys(handlers),
    ]),
    events: Object.entries(allEvents).map(([ns, events]) => [ns, events]),
  };
}

/**
 * Cue-style sender verification. Returns a string error reason or null when
 * trusted. Degrades to permissive in non-Electron test contexts where
 * windowManager has never created a window.
 */
function verifySender(event) {
  let windowManager;
  try {
    windowManager = require('../windowManager').windowManager;
  } catch {
    return null; // no window manager in this context (plain-node tests)
  }
  const tracked = windowManager.getWindowById(event.sender?.id);
  const hasAnyWindows = windowManager.windowsOfType?.('main').length > 0
    || windowManager.windows.size > 0;
  if (tracked == null) {
    // Untracked sender is fatal only when real windows exist (test stubs
    // call handlers directly with bare sender objects).
    return hasAnyWindows ? 'untrusted sender (window not tracked)' : null;
  }
  if (event.sender.isDestroyed?.()) return 'sender destroyed';
  // Main frame only — subframes/iframes never speak to the API.
  if (event.senderFrame && event.sender.mainFrame
    && event.senderFrame !== event.sender.mainFrame) {
    return 'untrusted sender (subframe)';
  }
  // Origin check: our file:// renderer or the dev server.
  const url = event.senderFrame?.url ?? event.sender.getURL?.() ?? '';
  if (url && !url.startsWith('file://') && !url.startsWith(DEV_ORIGIN)) {
    return `untrusted sender origin: ${url}`;
  }
  return null;
}

function setupIpc() {
  // Renderer asks once at preload time for the API surface description.
  ipcMain.on('quansiox-ipc-meta', (event) => {
    const reason = verifySender(event);
    if (reason) {
      event.returnValue = { error: reason };
      return;
    }
    event.returnValue = getExposedMeta();
  });

  // Single routed invoke channel.
  ipcMain.handle('quansiox-ipc-api', async (event, route, ...args) => {
    const reason = verifySender(event);
    if (reason) {
      return { ok: false, error: `IPC rejected: ${reason}` };
    }
    const separator = route.indexOf(':');
    const namespace = route.slice(0, separator);
    const method = route.slice(separator + 1);
    const handlers = allHandlers[namespace];
    const fn = handlers && handlers[method];
    if (typeof fn !== 'function') {
      throw new Error(`Unknown IPC route: ${route}`);
    }
    const schema = allSchemas[namespace]?.[method];
    if (schema) {
      const problem = typeof schema === 'function' ? schema(args) : checkArgs(schema, args);
      if (problem) return { ok: false, error: `IPC rejected (${route}): ${problem}` };
    }
    try {
      return { ok: true, result: await fn(event, ...args) };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  // The edge-aware channel (W2.1). The same handlers, routed through a named
  // edge, with the reference's failure envelope and idempotency support.
  ipcMain.handle('quansiox-ipc-edge', async (event, payload) => {
    const reason = verifySender(event);
    if (reason) {
      return { ok: false, failure: { code: 'edge/rejected', detail: `IPC rejected: ${reason}` } };
    }
    try {
      const { call } = require('./edges');
      return await call(payload?.edge, payload?.route, payload?.args ?? {}, {
        nonce: payload?.nonce ?? null,
        event,
      });
    } catch (error) {
      return {
        ok: false,
        failure: { code: 'edge/transport-failed', detail: String(error?.message ?? error) },
      };
    }
  });

  // What the app can do, and what it decided (W2.8). The renderer asks
  // before it offers a feature, so a missing capability is explained rather
  // than discovered by a failing click.
  ipcMain.handle('quansiox-ipc-capabilities', async (event) => {
    const reason = verifySender(event);
    if (reason) return { ok: false, error: `IPC rejected: ${reason}` };
    try {
      const { capabilitiesService } = require('../services/capabilitiesService');
      return { ok: true, result: capabilitiesService.snapshot() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });

  // The event cursor and replay (W2.3): after a reload the renderer asks
  // "what did I miss?" and gets the retained events it did not see.
  ipcMain.on('quansiox-ipc-event-cursor', (event) => {
    const reason = verifySender(event);
    if (reason) { event.returnValue = 0; return; }
    try {
      const eventBus = require('./eventBus');
      event.returnValue = eventBus.cursor();
    } catch {
      event.returnValue = 0;
    }
  });

  ipcMain.handle('quansiox-ipc-event-replay', async (event, payload) => {
    const reason = verifySender(event);
    if (reason) return { ok: false, error: `IPC rejected: ${reason}` };
    try {
      const eventBus = require('./eventBus');
      return { ok: true, result: eventBus.replay(payload?.channel, payload?.afterSeq ?? 0) };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });
}

module.exports = {
  registerNamespace,
  setupIpc,
  getExposedMeta,
  verifySender,
  checkArgs,
  emitEvent,
  emitScopedEvent,
  allHandlers,
  allEvents,
  allSchemas,
};
