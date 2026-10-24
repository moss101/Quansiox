'use strict';
/**
 * Window manager — simplified take on Manus Studio's WindowManager:
 * typed windows (main + about), persistence of bounds, single main window.
 */
const path = require('node:path');
// Outside Electron (the coordinator, the tests, the CLI) there are no
// windows — the import must not throw a confusing "not a constructor".
let BrowserWindow = null;
try { ({ BrowserWindow } = require('electron')); } catch { /* not in the desktop app */ }

const isDev = process.argv.includes('--dev');

class WindowManager {
  constructor() {
    /** @type {Map<number, { id: number, windowType: string, win: BrowserWindow }>} */
    this.windows = new Map();
  }

  _createWindow(windowType, extra = {}) {
    if (!BrowserWindow) throw new Error('windows need the Quansiox desktop app');
    const win = new BrowserWindow({
      width: 1080,
      height: 760,
      minWidth: 700,
      minHeight: 480,
      title: 'Quansiox',
      trafficLightPosition: { x: 16, y: 18 },
      backgroundColor: '#070707',
      titleBarStyle: 'hiddenInset',
      ...extra,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Full renderer sandbox: the preload only needs ipcRenderer +
        // contextBridge, both available in sandboxed preloads.
        sandbox: true,
        spellcheck: false,
      },
    });
    this.windows.set(win.id, { id: win.id, windowType, win });
    win.on('closed', () => {
      const entry = this.windows.get(win.id);
      try { entry?.dataPort?.close?.(); } catch { /* already gone */ }
      this.windows.delete(win.id);
    });
    this._attachDataPort(win);
    return win;
  }

  /**
   * Fast-path data plane: a dedicated MessagePort per window for high-frequency
   * agent traffic (token deltas, tool results, screenshots). Falls back to the
   * scoped invoke/event channel when MessageChannelMain is unavailable (older
   * Electron, plain-node tests).
   */
  _attachDataPort(win) {
    try {
      const { MessageChannelMain } = require('electron');
      if (typeof MessageChannelMain !== 'function') return;
      const { port1, port2 } = new MessageChannelMain();
      const entry = this.windows.get(win.id);
      if (!entry) return;
      entry.dataPort = port1;
      port1.on('message', () => { /* renderer -> main ACKs are best-effort */ });
      port1.start();
      win.webContents.on('did-finish-load', () => {
        try { win.webContents.postMessage('quansiox-ipc-port', null, [port2]); } catch { /* reload race */ }
      });
    } catch { /* feature absent → invoke/event channel only */ }
  }

  /** The data port for a window's webContents, or null. */
  dataPortFor(contents) {
    for (const entry of this.windows.values()) {
      if (entry.win?.webContents === contents) return entry.dataPort ?? null;
    }
    return null;
  }

  _load(win, hash = '') {
    if (isDev) {
      win.loadURL(`http://localhost:5183/index.html#${hash}`);
    } else {
      // loadFile's opts.hash must NOT include the leading '#'.
      win.loadFile(
        path.join(__dirname, '..', 'renderer', 'index.html'),
        hash ? { hash } : undefined
      );
    }
    return win;
  }

  createMainWindow() {
    const win = this._createWindow('main', { width: 1280, height: 840, minWidth: 900, minHeight: 600 });
    this._load(win);
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
    return win;
  }

  /** Pop-out: one window per session id (Manus TaskWindow pattern). */
  createSessionWindow(sessionId) {
    for (const entry of this.windows.values()) {
      if (entry.windowType === 'session' && entry.sessionId === sessionId && !entry.win.isDestroyed()) {
        entry.win.focus();
        return entry.win;
      }
    }
    const win = this._createWindow('session');
    const entry = this.windows.get(win.id);
    entry.sessionId = sessionId;
    this._load(win, `session=${encodeURIComponent(sessionId)}`);
    this._armGraceClose(entry);
    return win;
  }

  /**
   * Grace close (Cue's close-requested pattern): a session pop-out that is
   * still streaming a run gets one delayed close — the renderer is told
   * (window:onCloseRequested) and has `graceMs` to cancel; after that (or a
   * second close click) the window really closes.
   */
  _armGraceClose(entry) {
    const GRACE_MS = Number(process.env.QUANSIOX_CLOSE_GRACE_MS) || 5000;
    entry.win.on('close', (event) => {
      if (entry.closeForced || entry.closeForcing) return; // second click / timeout: allow
      let running = false;
      try {
        const { agentService } = require('./services/agentService');
        running = agentService.isRunning(entry.sessionId);
      } catch { /* agent service unavailable — close normally */ }
      if (!running) return;
      event.preventDefault();
      entry.closeForcing = true;
      const { emitScopedEvent } = require('./ipc/emitEvent');
      emitScopedEvent(entry.win, 'window', 'onCloseRequested', {
        sessionId: entry.sessionId, graceMs: GRACE_MS,
      });
      entry.closeTimer = setTimeout(() => {
        entry.closeForced = true;
        if (!entry.win.isDestroyed()) entry.win.close();
      }, GRACE_MS);
    });
  }

  /** Renderer cancelled the grace close (or the run finished). */
  cancelGraceClose(windowId) {
    const entry = this.windows.get(windowId);
    if (!entry) return false;
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer);
      entry.closeTimer = null;
    }
    entry.closeForcing = false;
    return true;
  }

  /** Playback window: one per session (Cue's ComputerWindows.open pattern). */
  createPlaybackWindow(sessionId) {
    for (const entry of this.windows.values()) {
      if (entry.windowType === 'playback' && entry.sessionId === sessionId && !entry.win.isDestroyed()) {
        entry.win.focus();
        return entry.win;
      }
    }
    const win = this._createWindow('playback', {
      width: 1100, height: 760, minWidth: 480, minHeight: 360,
      backgroundColor: '#05070c',
    });
    const entry = this.windows.get(win.id);
    entry.sessionId = sessionId;
    this._load(win, `playback=${encodeURIComponent(sessionId)}`);
    const { playbackService } = require('./services/playbackService');
    win.on('closed', () => playbackService.onChanged());
    return win;
  }

  /**
   * Desktop companion panel ("pet").
   *
   * A frameless, transparent, always-on-top window that floats over every
   * other app, so the agent is reachable while the user works in another
   * application. It is a first-class window (not a settings blob) so it can
   * receive real mouse/keyboard input and be dragged around the screen.
   */
  createPanelWindow() {
    for (const entry of this.windows.values()) {
      if (entry.windowType === 'panel' && !entry.win.isDestroyed()) return entry.win;
    }
    const win = this._createWindow('panel', {
      width: 380,
      height: 176,
      minWidth: 260,
      minHeight: 120,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'Quansiox Companion',
      backgroundColor: '#00000000',
    });
    // Float above fullscreen apps and follow the user across Spaces.
    try {
      win.setAlwaysOnTop(true, 'floating');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch { /* not supported on every platform */ }
    const entry = this.windows.get(win.id);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));
    win.on('closed', () => {
      const current = this.windows.get(win.id);
      if (current) {
        try { current.persist?.(); } catch { /* best effort */ }
      }
    });
    return win;
  }

  /** The live companion panel window, or null. */
  /**
   * Artifact window — a sandboxed window for an interactive artifact.
   *
   * It has NO preload (the artifact gets no `window.quansiox` API at all),
   * no node integration, and it lives in its own session partition so it
   * shares no cookies or storage with the app. The document itself is
   * served from `qx-artifact://` with a CSP that forbids all network
   * access.
   */
  createArtifactWindow({ url, title = 'Artifact', width = 1000, height = 720 } = {}) {
    if (!BrowserWindow) throw new Error('artifact windows need the Quansiox desktop app');
    const win = new BrowserWindow({
      width,
      height,
      minWidth: 420,
      minHeight: 320,
      title,
      backgroundColor: '#0b0b0c',
      autoHideMenuBar: true,
      webPreferences: {
        // No preload: the artifact cannot call the app.
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        partition: 'qx-artifact',
      },
    });
    this.windows.set(win.id, { id: win.id, windowType: 'artifact', win });

    // An artifact may not navigate away or spawn windows.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, target) => {
      if (!String(target).startsWith('qx-artifact://')) event.preventDefault();
    });
    win.on('closed', () => {
      this.windows.delete(win.id);
    });
    if (url) win.loadURL(url).catch(() => { /* the window stays empty */ });
    return win;
  }

  /** The artifact windows, by artifact id. */
  getArtifactWindow(id) {
    for (const entry of this.windows.values()) {
      if (entry.windowType === 'artifact' && !entry.win.isDestroyed()) {
        const target = entry.win.webContents.getURL();
        if (!id || target.includes(`qx-artifact://${id}/`)) return entry.win;
      }
    }
    return null;
  }

  getPanelWindow() {
    for (const entry of this.windows.values()) {
      if (entry.windowType === 'panel' && !entry.win.isDestroyed()) return entry.win;
    }
    return null;
  }

  /**
   * Agent browser window (Manus BrowserWindow pattern): one per session,
   * hosting the session's WebContentsView browser. Closing the window keeps
   * the browser alive headless — the view is detached, not destroyed.
   */
  createBrowserWindow(sessionId) {
    for (const entry of this.windows.values()) {
      if (entry.windowType === 'browser' && entry.sessionId === sessionId && !entry.win.isDestroyed()) {
        entry.win.show();
        entry.win.focus();
        return entry.win;
      }
    }
    const win = this._createWindow('browser', {
      width: 1180, height: 800, minWidth: 480, minHeight: 360,
      backgroundColor: '#05070c',
    });
    const entry = this.windows.get(win.id);
    entry.sessionId = sessionId;
    // Minimal dark host page — the real content is the session's
    // WebContentsView browser attached by browserService.
    win.loadFile(path.join(__dirname, '..', 'renderer', 'browser-host.html'));
    win.on('ready-to-show', () => {
      try {
        const { browserService } = require('./services/browserService');
        browserService.attachWindow(sessionId, win);
      } catch { /* browser service unavailable — plain window */ }
    });
    const sync = () => {
      try {
        const { browserService } = require('./services/browserService');
        browserService.syncBounds(sessionId);
      } catch { /* best-effort */ }
    };
    win.on('resize', sync);
    win.on('maximize', sync);
    win.on('unmaximize', sync);
    win.on('enter-full-screen', sync);
    win.on('leave-full-screen', sync);
    win.on('closed', () => {
      try {
        const { browserService } = require('./services/browserService');
        browserService.detachWindow(sessionId);
      } catch { /* best-effort */ }
    });
    return win;
  }

  /** All live window entries of a type. */
  windowsOfType(windowType) {
    return [...this.windows.values()].filter(
      (entry) => entry.windowType === windowType && !entry.win.isDestroyed()
    );
  }

  getMainWindow() {
    for (const entry of this.windows.values()) {
      if (entry.windowType === 'main' && !entry.win.isDestroyed()) return entry.win;
    }
    return null;
  }

  /** Show-or-create the main window (tray/shortcut/deep-link target). */
  focusMainWindow() {
    const win = this.getMainWindow() ?? this.createMainWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  getWindowById(id) {
    return this.windows.get(id) ?? null;
  }

  /** Toggle maximize on the main window (Grok toggleMaximizeWindow). */
  toggleMaximizeMainWindow() {
    const win = this.getMainWindow();
    if (!win) return { maximized: false, reason: 'no main window' };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { maximized: win.isMaximized() };
  }

  /** Apply spell-checker state to every live window session. */
  applySpellChecker(enabled) {
    let applied = 0;
    for (const entry of this.windows.values()) {
      if (entry.win.isDestroyed()) continue;
      try { entry.win.webContents.session.setSpellCheckerEnabled(Boolean(enabled)); applied += 1; } catch {}
    }
    return { applied };
  }

  /**
   * RPC trace window (devtool): shows live gateway dispatches with the trace
   * context. The traceparent is handed to clients via
   * getRpcTraceWindowTraceparent while the window is open.
   */
  startRpcTraceWindow() {
    const { gatewayStateService } = require('./services/gatewayStateService');
    if (this._traceWin && !this._traceWin.isDestroyed()) {
      try { this._traceWin.focus(); } catch {}
      return { opened: true, reused: true, traceparent: gatewayStateService.getTraceWindowTraceparent() };
    }
    const traceparent = gatewayStateService.openTraceWindow();
    let win = null;
    try {
      win = new BrowserWindow({
        width: 760,
        height: 440,
        title: 'RPC Trace',
        backgroundColor: '#070707',
      });
    } catch (e) {
      return { opened: false, traceparent, reason: String(e?.message ?? e) };
    }
    this._traceWin = win;
    this.windows.set(win.id, { id: win.id, windowType: 'rpc-trace', win });
    const page = `<!doctype html><meta charset="utf-8"><title>RPC Trace</title>
<body style="margin:0;background:#070707;color:#ddd;font:12px/1.5 ui-monospace,monospace">
<div style="padding:10px 14px;border-bottom:1px solid #222">RPC trace window — listening. Context: <span id="tp">${traceparent}</span></div>
<div id="rows" style="padding:8px 14px"></div>
<script>
window.__pushTrace = (e) => {
  const el = document.createElement('div');
  el.textContent = new Date(e.at).toISOString().slice(11, 23) + '  ' + e.method + '  ' + e.status;
  document.getElementById('rows').prepend(el);
  while (document.getElementById('rows').childElementCount > 300) document.getElementById('rows').lastChild.remove();
};
</script></body>`;
    try { win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page)); } catch {}
    this._traceUnsubscribe = gatewayStateService.onTrace((entry) => {
      try { win.webContents.executeJavaScript(`window.__pushTrace(${JSON.stringify(entry)})`); } catch {}
    });
    win.on('closed', () => {
      this.windows.delete(win.id);
      if (this._traceWin === win) this._traceWin = null;
      if (this._traceUnsubscribe) { this._traceUnsubscribe(); this._traceUnsubscribe = null; }
      gatewayStateService.closeTraceWindow();
    });
    return { opened: true, reused: false, traceparent };
  }

  getRpcTraceWindowTraceparent() {
    try {
      const { gatewayStateService } = require('./services/gatewayStateService');
      const win = this._traceWin;
      if (!win || win.isDestroyed()) return null;
      return gatewayStateService.getTraceWindowTraceparent();
    } catch {
      return null;
    }
  }

  /** Title-bar overlay tone (Windows/Linux overlay controls; no-op elsewhere). */
  setTitleBarOverlayTone(isOverlayTone) {
    const win = this.getMainWindow();
    if (!win) return { applied: false, reason: 'no main window' };
    try {
      win.setTitleBarOverlay({
        color: isOverlayTone ? '#101010' : '#070707',
        symbolColor: '#f5f5f5',
      });
      return { applied: true, isOverlayTone: Boolean(isOverlayTone) };
    } catch (e) {
      return { applied: false, reason: String(e?.message ?? e) };
    }
  }
}

module.exports = { windowManager: new WindowManager(), WindowManager, isDev };
