'use strict';
/* Playback + grace-close smoke test (Cue computer:playback / close-requested
 * patterns): frame extraction from transcripts, playback window creation,
 * playing-sessions registry, fit, gates, and the session-window grace close. */
const Module = require('node:module');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-pb-'));
process.env.QUANSIOX_CLOSE_GRACE_MS = '300';

const created = require('./stub-electron-playback.js').__created;
let nextId = 1;
class FakeBrowserWindow {
  constructor(opts = {}) {
    this.id = nextId++;
    this.opts = opts;
    this.loadedHash = null;
    this.focused = 0;
    this.destroyedFlag = false;
    this.bounds = null;
    this.fullscreen = false;
    this.minimized = false;
    this.handlers = {};
    this.sent = [];
    this.closed = false;
    // Register with the stub so BrowserWindow.getAllWindows() sees us.
    require('./stub-electron-playback.js').__created.push(this);
  }
  loadFile(_p, opts) { this.loadedHash = opts?.hash ?? null; }
  focus() { this.focused += 1; }
  isDestroyed() { return this.destroyedFlag; }
  on(evt, fn) { this.handlers[evt] = fn; }
  setBounds(b) { this.bounds = b; }
  setFullScreen(v) { this.fullscreen = Boolean(v); }
  isFullScreen() { return this.fullscreen; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; }
  show() {}
  close() {
    // Route through the registered 'close' handler like Electron would.
    const fn = this.handlers.close;
    const event = { preventDefault: () => { event.defaultPrevented = true; }, defaultPrevented: false };
    fn?.(event);
    if (!event.defaultPrevented) this._reallyClose();
  }
  _reallyClose() {
    this.closed = true;
    this.destroyedFlag = true;
    this.handlers.closed?.();
  }
  get webContents() {
    const self = this;
    return {
      openDevTools: () => {},
      on: () => {},
      isDestroyed: () => false,
      send: (ch, route, ...args) => self.sent.push([route, ...args]),
      getURL: () => 'file:///Quansiox.app/Contents/Resources/app/src/renderer/index.html',
    };
  }
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-playback.js');
  return origResolve.call(this, req, ...rest);
};
require('./stub-electron-playback.js').__setBrowserWindow(FakeBrowserWindow);

const { windowManager, WindowManager } = require('../src/main/windowManager');
const { playbackService } = require('../src/main/services/playbackService');
const { sessionService } = require('../src/main/services/sessionService');
const { agentService } = require('../src/main/services/agentService');

(async () => {
  const wm = new WindowManager();
  playbackService.setWindowManager(wm);

  // ---- frames: extract recorded screenshots from a transcript ----
  const sid = 'pb-session-1';
  sessionService.ensure(sid);
  const shot = (n) => sessionService.appendTurn(sid, {
    role: 'user',
    kind: 'screenshot',
    content: [
      { type: 'text', text: 'screenshot note' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,FRAME${n}` } },
    ],
  });
  shot(1);
  sessionService.appendTurn(sid, { role: 'assistant', content: 'thinking' });
  shot(2);
  shot(3);

  const f1 = playbackService.frames(sid);
  assert.strictEqual(f1.total, 3, 'three recorded frames');
  assert.deepStrictEqual(
    f1.frames.map((f) => f.dataUrl),
    ['data:image/png;base64,FRAME1', 'data:image/png;base64,FRAME2', 'data:image/png;base64,FRAME3'],
    'frames in order'
  );
  const f2 = playbackService.frames(sid, 2);
  assert.strictEqual(f2.frames.length, 1, 'from-index slices');
  assert.strictEqual(f2.frames[0].index, 2, 'original index preserved');

  // ---- open: window creation, hash routing, dedupe ----
  assert.strictEqual(playbackService.playingSessions().length, 0, 'nothing playing initially');
  const opened = playbackService.open(sid);
  const win = created.find((w) => w.id === opened.windowId);
  assert.strictEqual(win.loadedHash, 'playback=pb-session-1', 'playback hash routing');
  assert.strictEqual(wm.windows.get(win.id).windowType, 'playback');
  assert.deepStrictEqual(playbackService.playingSessions(), [sid], 'registry lists the session');

  const before = created.length;
  playbackService.open(sid);
  assert.strictEqual(created.length, before, 'dedupe: no second window');
  assert.strictEqual(win.focused, 1, 'existing playback window focused');

  // onChanged broadcast reaches windows via emitEvent.
  const gotBroadcast = win.sent.find(([r]) => r === 'playback:onChanged');
  assert(gotBroadcast, 'onChanged broadcast sent to windows');

  // ---- gates ----
  assert(playbackService.hasActive(), 'hasActive with an open playback window');
  assert.strictEqual(playbackService.focusActive(), sid, 'focusActive returns the session');

  // ---- fit + fullscreen ----
  win.sent.length = 0;
  const fitSender = { id: win.id, isDestroyed: () => false };
  assert.strictEqual(playbackService.fit(fitSender.id, { width: 800, height: 600 }), true);
  assert(win.bounds && win.bounds.width === 800 && win.bounds.height === 664, `fit sizes window: ${JSON.stringify(win.bounds)}`);
  assert.throws(() => playbackService.fit(999999, {}), /not a playback window/);
  assert.strictEqual(playbackService.toggleFullscreen(fitSender.id), true, 'fullscreen toggles on');

  // closing the window updates the registry (Cue publishChanged).
  win._reallyClose();
  assert.strictEqual(playbackService.playingSessions().length, 0, 'registry empty after close');

  // ---- grace close (session windows mid-run) ----
  const sessWin = wm.createSessionWindow('run-1');
  assert.strictEqual(sessWin.loadedHash, 'session=run-1');
  const closeEv = { preventDefault: () => { closeEv.prevented = true; }, prevented: false };

  // Not running: close passes straight through.
  sessWin.handlers.close(closeEv);
  assert(!closeEv.prevented, 'close allowed when the session is idle');

  // Running: first close is deferred, renderer notified, can cancel.
  agentService._testSetRunning('run-1', true);
  const ev2 = { preventDefault: () => { ev2.prevented = true; }, prevented: false };
  sessWin.handlers.close(ev2);
  assert(ev2.prevented, 'close deferred while running');
  const req = sessWin.sent.find(([r]) => r === 'window:onCloseRequested');
  assert(req && req[1].sessionId === 'run-1' && req[1].graceMs > 0, `renderer notified: ${JSON.stringify(req)}`);
  wm.cancelGraceClose(sessWin.id);
  agentService._testSetRunning('run-1', false);

  // Running + no cancel: grace timer force-closes (300ms in tests).
  agentService._testSetRunning('run-1', true);
  const ev3 = { preventDefault: () => { ev3.prevented = true; }, prevented: false };
  sessWin.handlers.close(ev3);
  assert(ev3.prevented, 'second deferred close');
  await new Promise((r) => setTimeout(r, 450));
  assert(sessWin.isDestroyed(), 'grace timer closed the window');
  agentService._testSetRunning('run-1', false);

  // Second close click while deferred bypasses the grace period.
  const w2 = wm.createSessionWindow('run-2');
  agentService._testSetRunning('run-2', true);
  const ev4 = { preventDefault: () => { ev4.prevented = true; }, prevented: false };
  w2.handlers.close(ev4);
  assert(ev4.prevented);
  const ev5 = { preventDefault: () => { ev5.prevented = true; }, prevented: false };
  w2.handlers.close(ev5);
  assert(!ev5.prevented, 'repeat close forces through');
  agentService._testSetRunning('run-2', false);

  console.log('PLAYBACK SMOKE OK — frames, windows, registry, fit, gates, grace close all pass');
})().catch((e) => { console.error(e); process.exit(1); });
