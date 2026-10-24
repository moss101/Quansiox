'use strict';
/**
 * Trust overlays (Grok-Bot pattern, Electron-native): while the agent uses
 * computer tools, a pulsing border glow frames the screen and a stop pill
 * offers a one-click kill switch. The glow is click-through; the pill floats.
 */
const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

let glowWin = null;
let pillWin = null;
let hideTimer = null;

function glowHtml() {
  return `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
<div style="position:fixed;inset:0;border:5px solid rgba(79,110,247,0.9);
 box-shadow:0 0 24px 6px rgba(79,110,247,0.55), inset 0 0 24px 6px rgba(79,110,247,0.35);
 border-radius:14px;animation:pulse 1.2s ease-in-out infinite"></div>
<style>@keyframes pulse{0%,100%{opacity:.45}50%{opacity:1}}</style>
</body></html>`;
}

function pillHtml() {
  return `<!doctype html><html><head><style>
body{margin:0;background:transparent;overflow:hidden;font:-apple-system 13px}
button{margin:6px;padding:8px 18px;border:0;border-radius:999px;cursor:pointer;
 background:linear-gradient(160deg,#e5534b,#b33a34);color:#fff;font-weight:600;font-size:13px;
 box-shadow:0 6px 20px rgba(0,0,0,.45)}
</style></head><body>
<button id="stop">⏹ Quansiox is controlling this Mac — Stop</button>
<script>
document.getElementById('stop').addEventListener('click', () => {
  window.quansiox?.events // preload may be absent; guard
  location.hash = '#stopped';
  document.title = 'stopped';
});
</script></body></html>`;
}

/** Show overlays (idempotent). onStop fires when the pill is clicked. */
function show(onStop) {
  hideTimer && clearTimeout(hideTimer);
  if (!glowWin || glowWin.isDestroyed()) {
    const workArea = screen.getPrimaryDisplay().workArea;
    glowWin = new BrowserWindow({
      x: workArea.x + 6,
      y: workArea.y + 6,
      width: workArea.width - 12,
      height: workArea.height - 12,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    glowWin.setIgnoreMouseEvents(true, { forward: true });
    glowWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    glowWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(glowHtml())}`);
    glowWin.on('closed', () => (glowWin = null));
  } else {
    glowWin.show();
  }

  if (!pillWin || pillWin.isDestroyed()) {
    const workArea = screen.getPrimaryDisplay().workArea;
    const w = 320;
    pillWin = new BrowserWindow({
      x: workArea.x + Math.round((workArea.width - w) / 2),
      y: workArea.y + workArea.height - 64,
      width: w,
      height: 44,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    pillWin.setVisibleOnAllWorkspaces(true, { visibleOnFullscreen: true });
    pillWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pillHtml())}`);
    // The pill page signals a stop via title change (no preload bridge).
    pillWin.on('page-title-updated', (e) => {
      e.preventDefault();
      if (pillWin.webContents.getTitle() === 'stopped') onStop?.();
    });
    pillWin.on('closed', () => (pillWin = null));
  } else {
    pillWin.show();
  }
}

/** Hide (debounced — computer calls arrive in bursts). */
function hide() {
  hideTimer && clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    try { glowWin?.hide(); } catch {}
    try { pillWin?.hide(); } catch {}
  }, 400);
}

function dispose() {
  try { glowWin?.destroy(); } catch {}
  try { pillWin?.destroy(); } catch {}
  glowWin = pillWin = null;
}

module.exports = { trustOverlayService: { show, hide, dispose } };
