'use strict';
/* IPC sender-verification smoke test (Cue's verify(event) pattern):
 * calls on the single invoke/meta channel must come from a tracked window's
 * main frame at our own origin; anything else is rejected. */
const Module = require('node:module');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-ipc-'));

// Capturing ipcMain + injectable BrowserWindow.
const handlers = {};
class FakeBrowserWindow {
  constructor() { this.id = ++FakeBrowserWindow.nextId; }
  static nextId = 0;
  isDestroyed() { return false; }
  on() {}
  loadFile() {}
  loadURL() {}
  webContents = { openDevTools: () => {}, on: () => {}, send: () => {}, getURL: () => 'file:///app/renderer/index.html' };
}
const stub = {
  app: { getPath: (k) => path.join(process.env.QUANSIOX_TEST_USERDATA, k) },
  get BrowserWindow() { return FakeBrowserWindow; },
  ipcMain: {
    on: (ch, fn) => { handlers[ch] = fn; },
    handle: (ch, fn) => { handlers[ch] = fn; },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-playback.js');
  return origResolve.call(this, req, ...rest);
};
// Reuse the playback stub shape but swap in our capturing ipcMain.
const realStub = require('./stub-electron-playback.js');
realStub.ipcMain = stub.ipcMain;
realStub.__setBrowserWindow(FakeBrowserWindow);

const { windowManager, WindowManager } = require('../src/main/windowManager');
const { setupIpc, registerNamespace } = require('../src/main/ipc/registry');

const wm = new WindowManager();
// Replace the singleton the registry verifies against.
const singleton = require('../src/main/windowManager').windowManager;
singleton.windows = wm.windows;

registerNamespace('probe', { handlers: { ping: () => 'pong' }, events: [] });
setupIpc();

function fakeEvent(win, { subframe = false, url = 'file:///app/renderer/index.html', mainUrl } = {}) {
  const mainFrame = { url: mainUrl ?? 'file:///app/renderer/index.html' };
  return {
    sender: {
      id: win.id,
      isDestroyed: () => false,
      mainFrame,
      getURL: () => (subframe ? url : mainFrame.url),
    },
    senderFrame: subframe ? { url } : mainFrame,
  };
}

(async () => {
  const win = wm.createMainWindow();

  // Trusted: tracked window, main frame, file:// origin.
  const ok = await handlers['quansiox-ipc-api'](fakeEvent(win), 'probe:ping');
  assert.deepStrictEqual(ok, { ok: true, result: 'pong' }, 'trusted sender passes');

  // Untracked window id.
  const ghost = { sender: { id: 424242, isDestroyed: () => false } };
  const bad1 = await handlers['quansiox-ipc-api'](ghost, 'probe:ping');
  assert(!bad1.ok && /untrusted sender/.test(bad1.error), `untracked rejected: ${JSON.stringify(bad1)}`);

  // Subframe (iframe) — Cue rejects anything not from the main frame.
  const bad2 = await handlers['quansiox-ipc-api'](fakeEvent(win, { subframe: true }), 'probe:ping');
  assert(!bad2.ok && /subframe/.test(bad2.error), `subframe rejected: ${JSON.stringify(bad2)}`);

  // Foreign origin (packaged renderer is file://; dev is localhost:5183).
  const bad3 = await handlers['quansiox-ipc-api'](
    fakeEvent(win, { mainUrl: 'https://evil.example.com/x', url: 'https://evil.example.com/x' }), 'probe:ping');
  assert(!bad3.ok && /origin/.test(bad3.error), `foreign origin rejected: ${JSON.stringify(bad3)}`);

  // Dev origin is allowed.
  const dev = await handlers['quansiox-ipc-api'](
    fakeEvent(win, { mainUrl: 'http://localhost:5183/index.html', url: 'http://localhost:5183/index.html' }), 'probe:ping');
  assert(dev.ok, 'dev origin allowed');

  // The meta (sendSync) channel applies the same checks.
  const metaOk = {};
  handlers['quansiox-ipc-meta']({ ...fakeEvent(win), returnValue: undefined });
  // returnValue was set on the event object; re-run to capture it.
  const metaEvent = fakeEvent(win);
  metaEvent.returnValue = null;
  handlers['quansiox-ipc-meta'](metaEvent);
  assert(metaEvent.returnValue.handlers.some(([ns]) => ns === 'probe'), 'meta served to trusted sender');
  const metaGhost = { sender: { id: 424242 }, returnValue: null };
  handlers['quansiox-ipc-meta'](metaGhost);
  assert(metaGhost.returnValue?.error && /untrusted/.test(metaGhost.returnValue.error), 'meta denied to untracked sender');

  console.log('IPC-VERIFY SMOKE OK — tracked/main-frame/origin checks all pass');
})().catch((e) => { console.error(e); process.exit(1); });
