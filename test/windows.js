'use strict';
/* Window-manager smoke test — verifies session pop-out windows:
 * creation, hash routing, and one-per-session dedup. */
const Module = require('node:module');
const assert = require('node:assert');

// Fake BrowserWindow before anything requires electron.
const created = [];
let nextId = 1;
class FakeBrowserWindow {
  constructor(opts = {}) {
    this.id = nextId++;
    this.opts = opts;
    this.loadedHash = null;
    this.focused = 0;
    this.destroyedFlag = false;
    this.handlers = {};
    created.push(this);
  }
  loadFile(_p, opts) {
    this.loadedHash = opts?.hash ?? null;
  }
  focus() {
    this.focused += 1;
  }
  isDestroyed() {
    return this.destroyedFlag;
  }
  on(evt, fn) {
    this.handlers[evt] = fn;
  }
  webContents = { openDevTools: () => {}, on: () => {} };
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-window.js');
  return origResolve.call(this, req, ...rest);
};
require('./stub-electron-window.js').__setBrowserWindow(FakeBrowserWindow);

const { windowManager, WindowManager } = require('../src/main/windowManager');

// Fresh manager (the module exports a singleton too — test the class).
const wm = new WindowManager();
wm.createMainWindow();
assert.strictEqual(created[0].loadedHash, null, 'main window: no hash');

wm.createSessionWindow('abc-123');
assert.strictEqual(created[1].loadedHash, 'session=abc-123', 'session window hash routing');
assert.strictEqual(wm.windows.get(created[1].id).windowType, 'session');
assert.strictEqual(wm.windows.get(created[1].id).sessionId, 'abc-123');

// Dedup: same session focuses the existing window instead of a new one.
const before = created.length;
wm.createSessionWindow('abc-123');
assert.strictEqual(created.length, before, 'no duplicate window for same session');
assert.strictEqual(created[1].focused, 1, 'existing window focused');

// A different session gets its own window.
wm.createSessionWindow('def-456');
assert.strictEqual(created.length, before + 1);
assert.strictEqual(created[2].loadedHash, 'session=def-456');

// Closed windows are dropped from the registry.
created[1].handlers.closed();
assert.strictEqual(wm.getWindowById(created[1].id), null);
wm.createSessionWindow('abc-123'); // recreatable after close
assert.strictEqual(created.length, before + 2);

console.log('WINDOWS SMOKE OK — pop-out creation, hash routing, dedup, close all pass');
process.exit(0);
