'use strict';
const { BrowserWindow } = require('electron');

/**
 * Broadcast an event to every live renderer.
 * Mirrors Manus `emitEvent`: payload lands on the single event channel as
 * `namespace:method` plus args.
 */
function emitEvent(namespace, method, ...args) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('quansiox-ipc-event', `${namespace}:${method}`, ...args);
    }
  }
}

/**
 * Emit only to the window owning `target` webContents (or pass a BrowserWindow).
 * Mirrors Manus `emitScopedEvent` — keeps per-session streams (agent deltas,
 * terminal output) isolated to the window that owns the session.
 */
function emitScopedEvent(target, namespace, method, ...args) {
  const wc = target instanceof BrowserWindow ? target.webContents : target;
  if (wc && !wc.isDestroyed()) {
    wc.send('quansiox-ipc-event', `${namespace}:${method}`, ...args);
  }
}

module.exports = { emitEvent, emitScopedEvent };
