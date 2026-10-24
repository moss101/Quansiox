'use strict';
/**
 * Desktop panel service — the floating "companion" window.
 *
 * Grok Bot mounts a small always-on-top agent bubble on the desktop
 * (`desktop-mount/panel/panel.html`): it shows the agent's mark, lets the
 * user type a prompt without leaving their current app, and offers the
 * agent's quick choices.
 *
 * Quansiox now does the same with a real frameless, transparent,
 * always-on-top BrowserWindow. The panel is a first-class window, so it
 * takes real input and can be dragged anywhere on the screen.
 *
 * State (which agent is mounted, the quick choices, the geometry) stays in
 * the settings store so the panel can be reopened exactly where the user
 * left it. The window is a *view* of that state.
 *
 * Electron-free where it matters: the state machine works in plain Node
 * (tests), and the window is only touched when Electron is available.
 */

function settings() { return require('./settingsService').settingsService; }
function emit(event, payload) {
  try { require('../ipc/emitEvent').emitEvent('panel', event, payload); } catch {}
}
function record(action, detail) {
  try { require('./diagnosticsService').diagnosticsService.record('panel', { action, ...detail }); } catch {}
}

const DEFAULT_WIDTH = 380;
const MAX_CHOICES = 12;
const PANEL_HEIGHT = 176;

function blankState() {
  return {
    mounted: false, agentId: null, name: null, markSvgDataUrl: null,
    mountedAt: null, unmountedAt: null, geometry: { x: null, y: null },
    heightPx: null, width: DEFAULT_WIDTH, choices: [], choicesUpdatedAt: null,
    agentStatus: 'idle', lastMessage: null,
  };
}
function state() {
  const stored = settings().load().desktopPanel;
  return stored && typeof stored === 'object'
    ? { ...blankState(), ...stored, geometry: { ...blankState().geometry, ...(stored.geometry ?? {}) } }
    : blankState();
}
function saveState(next) { settings().save({ desktopPanel: next }); }
function publicState() {
  const s = state();
  return {
    mounted: s.mounted,
    agent: s.agentId ? { id: s.agentId, name: s.name, markSvgDataUrl: s.markSvgDataUrl } : null,
    geometry: s.geometry,
    heightPx: s.heightPx,
    width: s.width ?? DEFAULT_WIDTH,
    agentStatus: s.agentStatus ?? 'idle',
    lastMessage: s.lastMessage ?? null,
  };
}

/* ---------------- the real window ---------------- */

/** The live companion window, or null (Electron-free contexts return null). */
function panelWindow() {
  try { return require('../windowManager').windowManager.getPanelWindow(); } catch { return null; }
}

/** Push the current state to the panel renderer (if it is open). */
function pushState() {
  const win = panelWindow();
  if (!win || win.isDestroyed()) return false;
  try {
    win.webContents.send('panel:state', {
      ...publicState(),
      choices: state().choices ?? [],
      choicesUpdatedAt: state().choicesUpdatedAt,
    });
    return true;
  } catch { return false; }
}

/** Create + show the companion window (idempotent). */
function showWindow() {
  const win = panelWindow();
  if (!win) return false;
  const s = state();
  const { x, y } = s.geometry ?? {};
  if (x != null && y != null) {
    try { win.setPosition(Math.round(x), Math.round(y)); } catch { /* offscreen */ }
  }
  try { win.showInactive(); } catch { /* some platforms lack showInactive */ }
  try { win.setAlwaysOnTop(true, 'floating'); } catch { /* best effort */ }
  pushState();
  return true;
}

/** Hide the companion window without unmounting the agent. */
function hideWindow() {
  const win = panelWindow();
  if (!win) return false;
  try { win.hide(); } catch { /* best effort */ }
  return true;
}

/** Destroy the companion window (the agent stays mounted). */
function destroyWindow() {
  const win = panelWindow();
  if (!win) return false;
  try { win.destroy(); } catch { /* already gone */ }
  return true;
}

function mount({ agentId, name, markSvgDataUrl } = {}) {
  const id = String(agentId ?? '').trim();
  if (!id) throw new Error('agentId is required');
  const prev = state();
  const next = {
    ...blankState(),
    mounted: true,
    agentId: id,
    name: name ? String(name).slice(0, 120) : null,
    markSvgDataUrl: typeof markSvgDataUrl === 'string' && markSvgDataUrl.startsWith('data:') ? markSvgDataUrl.slice(0, 128 * 1024) : null,
    mountedAt: Date.now(),
    geometry: prev.agentId === id ? prev.geometry : { x: null, y: null },
    width: prev.width ?? DEFAULT_WIDTH,
  };
  saveState(next);
  emit('mounted', publicState());
  record('mount', { agentId: id });
  // The window is created lazily by the main process; ask it to appear.
  try {
    const { windowManager } = require('../windowManager');
    windowManager.createPanelWindow();
    showWindow();
  } catch { /* Electron-free context: state only */ }
  return publicState();
}

function unmount() {
  const s = state();
  if (!s.mounted) return { ...publicState(), alreadyUnmounted: true };
  const next = { ...s, mounted: false, unmountedAt: Date.now(), choices: [], agentStatus: 'idle' };
  saveState(next);
  emit('unmounted', { agentId: s.agentId });
  record('unmount', { agentId: s.agentId });
  destroyWindow();
  return { ...publicState(), alreadyUnmounted: false };
}

function read() {
  const pub = publicState();
  return {
    ...pub,
    layout: { width: pub.width, dropUpMenu: true, height: pub.heightPx ?? PANEL_HEIGHT },
    choices: state().choices,
    choicesUpdatedAt: state().choicesUpdatedAt,
  };
}

function move({ dx, dy } = {}) {
  const s = state();
  if (!s.mounted) return { moved: false, reason: 'no panel mounted' };
  const nx = Math.round((s.geometry.x ?? 0) + (Number(dx) || 0));
  const ny = Math.round((s.geometry.y ?? 0) + (Number(dy) || 0));
  const next = { ...s, geometry: { ...s.geometry, x: nx, y: ny } };
  saveState(next);
  const win = panelWindow();
  if (win && !win.isDestroyed()) { try { win.setPosition(nx, ny); } catch { /* offscreen */ } }
  return { moved: true, geometry: next.geometry };
}

function endMove() {
  const s = state();
  if (!s.mounted) return { ended: false, reason: 'no panel mounted' };
  record('end-move', { agentId: s.agentId, geometry: s.geometry });
  return { ended: true, geometry: s.geometry };
}

function normalizeChoices(choices) {
  if (!Array.isArray(choices)) throw new Error('choices must be an array');
  return choices.slice(0, MAX_CHOICES).flatMap((c, i) => {
    if (typeof c === 'string') {
      const v = c.trim();
      return v ? [{ id: `choice-${i}`, label: v.slice(0, 200), value: v.slice(0, 400) }] : [];
    }
    if (c && typeof c === 'object') {
      const label = String(c.label ?? c.title ?? c.value ?? '').trim();
      if (!label) return [];
      return [{ id: String(c.id ?? `choice-${i}`).slice(0, 120), label: label.slice(0, 200), value: String(c.value ?? label).slice(0, 400) }];
    }
    return [];
  });
}

function offerChoices({ choices } = {}) {
  const s = state();
  if (!s.mounted) throw new Error('no panel mounted');
  const normalized = normalizeChoices(choices);
  const next = { ...s, choices: normalized, choicesUpdatedAt: Date.now() };
  saveState(next);
  emit('choices', { agentId: s.agentId, choices: normalized });
  pushState();
  return { agentId: s.agentId, choices: normalized, count: normalized.length };
}

function readChoices() {
  const s = state();
  return { agentId: s.agentId, choices: s.choices ?? [], pending: (s.choices ?? []).length > 0, choicesUpdatedAt: s.choicesUpdatedAt };
}

function submitPrompt({ prompt } = {}) {
  const s = state();
  if (!s.mounted || !s.agentId) throw new Error('no panel mounted');
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('prompt must be a non-empty string');
  return { agentId: s.agentId, prompt: text.slice(0, 32 * 1024) };
}

function switchTo({ agentId } = {}) {
  const id = String(agentId ?? '').trim();
  if (!id) throw new Error('agentId is required');
  settings().save({ viewingAgentId: id });
  emit('switchedTo', { agentId: id });
  return { agentId: id };
}

function readLayout() {
  const s = state();
  return {
    layout: {
      width: s.width ?? DEFAULT_WIDTH,
      heightPx: s.heightPx,
      x: s.geometry.x,
      y: s.geometry.y,
      dropUpMenu: true,
      mounted: s.mounted,
    },
  };
}

/** The panel's own agent dismissed the view (Grok: switchTo(null)). */
function unmountSelf() {
  settings().save({ viewingAgentId: null });
  emit('unmountedSelf', {});
  record('unmount-self', { agentId: state().agentId });
  return { selfUnmounted: true, agentId: null };
}

function reachForMenu({ heightPx } = {}) {
  const s = state();
  const h = Math.max(0, Math.round(Number(heightPx) || 0));
  if (!s.mounted) return { anchor: null, reason: 'no panel mounted' };
  const next = { ...s, heightPx: h };
  saveState(next);
  if (s.geometry.x == null || s.geometry.y == null) return { anchor: null, reason: 'panel geometry unknown', heightPx: h };
  const width = s.width ?? DEFAULT_WIDTH;
  const anchor = {
    x: s.geometry.x,
    y: Math.max(0, s.geometry.y - h),
    width,
    height: h,
    dropUp: true,
  };
  emit('menuAnchor', anchor);
  return { anchor, heightPx: h };
}

/** Transient status shown on the panel (working / idle / done). */
function setStatus({ status, message } = {}) {
  const s = state();
  const next = {
    ...s,
    agentStatus: String(status ?? 'idle').slice(0, 32),
    lastMessage: message ? String(message).slice(0, 400) : null,
  };
  saveState(next);
  emit('status', { agentStatus: next.agentStatus, lastMessage: next.lastMessage });
  pushState();
  return { agentStatus: next.agentStatus, lastMessage: next.lastMessage };
}

module.exports = {
  panelService: {
    state, mount, unmount, read, readLayout, unmountSelf, move, endMove,
    offerChoices, readChoices, submitPrompt, switchTo, reachForMenu, setStatus,
    showWindow, hideWindow, destroyWindow, pushState, publicState,
  },
};
