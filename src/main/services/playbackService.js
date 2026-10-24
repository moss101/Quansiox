'use strict';
/**
 * Playback service — Cue's `computer:playback` pattern, mapped onto
 * Quansiox's local recordings:
 *
 *  - Every agent `computer_screenshot` is already persisted in the session
 *    transcript (user turns with kind 'screenshot' carrying image_url data).
 *    This service turns those frames into a watchable "run recording".
 *  - One playback window per session (dedup + focus, like Cue's
 *    ComputerWindows.open), hash-routed `#playback=<sessionId>`.
 *  - A playing-sessions registry is broadcast to every window on
 *    open/close (Cue's publishPlayback -> agents:computer:playing-sessions).
 *  - Fit-to-content and fullscreen controls (Cue's computer:fit/fullscreen).
 *  - Recording-active gates: hasActive()/focusActive() block staged update
 *    installs and intercept quit while a recording is being watched.
 */
const { sessionService } = require('./sessionService');
const { emitEvent } = require('../ipc/emitEvent');

/** windowManager is injected at boot (avoids a require cycle). */
let windowManagerRef = null;
function setWindowManager(wm) {
  windowManagerRef = wm;
}

function wm() {
  if (!windowManagerRef) throw new Error('playbackService not wired to windowManager');
  return windowManagerRef;
}

/** Extract the recorded screenshot frames from a session transcript. */
function frames(sessionId, from = 0) {
  const session = sessionService.get(sessionId);
  const out = [];
  let index = 0;
  for (const turn of session.turns ?? []) {
    if (turn.kind !== 'screenshot' || !Array.isArray(turn.content)) continue;
    const image = turn.content.find((p) => p.type === 'image_url' && p.image_url?.url);
    if (!image) continue;
    if (index >= from) out.push({ index, at: turn.at ?? null, dataUrl: image.image_url.url });
    index += 1;
  }
  return { sessionId, total: index, frames: out };
}

/** Open (or focus) the playback window for a session. */
function open(sessionId) {
  const win = wm().createPlaybackWindow(sessionId);
  publishChanged();
  return { windowId: win.id };
}

/** Session ids that currently have an open playback window. */
function playingSessions() {
  return wm().windowsOfType('playback')
    .map((entry) => entry.sessionId)
    .filter(Boolean);
}

/** Cue pattern: broadcast the registry to every renderer on change. */
function publishChanged() {
  emitEvent('playback', 'onChanged', playingSessions());
}

function onChanged() {
  publishChanged();
}

/** Gate: any playback window open? (Cue's hasActiveRecordings.) */
function hasActive() {
  return playingSessions().length > 0;
}

/** Focus the first playback window (Cue's focusRecording on quit). */
function focusActive() {
  for (const entry of wm().windowsOfType('playback')) {
    if (!entry.win || entry.win.isDestroyed()) continue;
    if (entry.win.isMinimized?.()) entry.win.restore();
    entry.win.show();
    entry.win.focus();
    return entry.sessionId;
  }
  return null;
}

/** Cue's computer:fit — size the window to the content's aspect box. */
function fit(senderWindowId, { width, height } = {}) {
  const entry = wm().getWindowById(senderWindowId);
  if (!entry || entry.windowType !== 'playback') throw new Error('not a playback window');
  const w = Math.max(320, Math.min(3840, Math.round(Number(width) || 1280)));
  const h = Math.max(240, Math.min(2160, Math.round(Number(height) || 800)));
  entry.win.setBounds({ width: w, height: h + 64 }); // + player chrome
  return true;
}

/** Cue's computer:fullscreen. */
function toggleFullscreen(senderWindowId) {
  const entry = wm().getWindowById(senderWindowId);
  if (!entry || entry.windowType !== 'playback') throw new Error('not a playback window');
  entry.win.setFullScreen(!entry.win.isFullScreen());
  return entry.win.isFullScreen();
}

module.exports = {
  playbackService: {
    setWindowManager,
    frames,
    open,
    playingSessions,
    onChanged,
    hasActive,
    focusActive,
    fit,
    toggleFullscreen,
  },
};
