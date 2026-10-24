'use strict';
/**
 * Human demonstration capture (GPA G3) — the native half of teach-by-demo.
 *
 * A small listen-only CGEventTap helper (`native/QuansioxCapture.swift`,
 * compiled to `build/QuansioxCapture`) streams real human mouse/keyboard
 * actions as NDJSON over a Unix socket. This service supervises that helper,
 * converts events into SkillRecorder steps, and finalizes a replayable
 * artifact with the same format the agent recorder uses.
 *
 * Permission model: macOS Accessibility (and Input Monitoring where required)
 * is mandatory. Without it the helper reports the reason and this service
 * fails the start — it never records a fake step.
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SkillRecorder, writeArtifact } = require('../../coordinator/skill-recording');

const SPECIAL_KEYS = {
  36: 'Return', 48: 'Tab', 51: 'Backspace', 53: 'Escape', 117: 'Delete',
  123: 'ArrowLeft', 124: 'ArrowRight', 125: 'ArrowDown', 126: 'ArrowUp',
  115: 'Home', 119: 'End', 116: 'PageUp', 121: 'PageDown',
};

function candidates() {
  const out = [];
  if (process.env.QUANSIOX_CAPTURE_HELPER) out.push(process.env.QUANSIOX_CAPTURE_HELPER);
  // Packaged: <app>/src/main/services → <app>/native/.
  out.push(path.join(__dirname, '..', '..', '..', 'native', 'QuansioxCapture'));
  // Dev checkout.
  out.push(path.join(__dirname, '..', '..', '..', 'build', 'QuansioxCapture'));
  return out;
}
function helperPath() {
  return candidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

let active = null; // { sessionId, rec, server, child, socketPath, buffer, text }

function cleanup(state) {
  try { state.child?.kill('SIGTERM'); } catch { /* already gone */ }
  try { state.server?.close(); } catch { /* already closed */ }
  try { fs.rmSync(state.socketPath, { force: true }); } catch { /* best-effort */ }
}

function flushText(state) {
  const text = state.text;
  state.text = '';
  if (!text) return;
  try { state.rec.note({ kind: 'type', text: text.slice(0, 2000) }); } catch { /* recording stopped */ }
}

/** Convert one helper event into a recorder step. Exported for tests. */
function applyEvent(state, event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'click') {
    flushText(state);
    state.rec.note({
      kind: 'click',
      x: Math.round(Number(event.x) || 0),
      y: Math.round(Number(event.y) || 0),
      clickCount: Math.max(1, Number(event.clickCount) || 1),
    });
    return true;
  }
  if (event.type === 'scroll') {
    flushText(state);
    state.rec.note({
      kind: 'scroll',
      x: Math.round(Number(event.x) || 0),
      y: Math.round(Number(event.y) || 0),
      deltaY: Number(event.deltaY) || 0,
    });
    return true;
  }
  if (event.type === 'key') {
    const modifiers = Array.isArray(event.modifiers) ? event.modifiers.map(String) : [];
    const special = SPECIAL_KEYS[Number(event.keyCode)];
    const text = String(event.text ?? '');
    const commandish = modifiers.includes('cmd') || modifiers.includes('ctrl') || modifiers.includes('alt');
    if (special || commandish) {
      flushText(state);
      state.rec.note({ kind: 'key', key: special || text || String(event.keyCode), modifiers });
      return true;
    }
    if (text && !/[\u0000-\u001f\u007f]/.test(text)) {
      state.text += text;
      if (state.text.length >= 2000) flushText(state);
      return true;
    }
  }
  return false;
}

function start({ sessionId } = {}) {
  const sid = String(sessionId || '');
  if (!sid) return Promise.reject(new Error('a session is required to capture a demonstration'));
  if (active) return Promise.reject(new Error('a demonstration is already being captured'));
  const helper = helperPath();
  if (!helper) return Promise.reject(new Error('capture helper is not installed (build/QuansioxCapture)'));

  const socketPath = path.join(os.tmpdir(), `qx-capture-${process.pid}-${Date.now().toString(36)}.sock`);
  fs.rmSync(socketPath, { force: true });
  const state = {
    sessionId: sid,
    rec: new SkillRecorder(),
    server: null,
    child: null,
    socketPath,
    text: '',
    stderr: '',
    startedAt: Date.now(),
  };
  active = state;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup(state);
      active = null;
      reject(error);
    };
    const ready = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'ready') {
        if (settled) return;
        settled = true;
        state.rec.prepare();
        state.rec.begin();
        resolve({ sessionId: sid, state: state.rec.state, startedAt: state.startedAt, helper });
        return;
      }
      if (event.type === 'error') { fail(new Error(String(event.error || 'capture helper failed'))); return; }
      try { applyEvent(state, event); } catch { /* malformed/duplicate events are ignored */ }
    };

    state.server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) ready(line);
        }
      });
      socket.on('error', () => { /* helper went away; stop() reports the artifact */ });
    });
    state.server.on('error', (error) => fail(new Error(`capture socket: ${error.message}`)));
    state.server.listen(socketPath, () => {
      // Tests (and scriptable helpers) may point at a Node .js helper.
      const isJs = helper.endsWith('.js');
      const command = isJs ? process.execPath : helper;
      const args = isJs ? [helper, socketPath] : [socketPath];
      state.child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      state.child.stderr.on('data', (chunk) => { state.stderr += String(chunk).slice(0, 2000); });
      state.child.on('error', (error) => fail(new Error(`capture helper: ${error.message}`)));
      state.child.on('exit', (code, signal) => {
        if (settled) return;
        const detail = state.stderr.trim() || (signal ? `signal ${signal}` : `exit ${code}`);
        fail(new Error(`capture helper exited before ready (${detail})`));
      });
    });
    setTimeout(() => fail(new Error('capture helper did not become ready (permission prompt?)')), 10_000).unref?.();
  });
}

function status() {
  return active
    ? { recording: true, sessionId: active.sessionId, steps: active.rec.steps.length, startedAt: active.startedAt }
    : { recording: false, steps: 0 };
}

function stop() {
  if (!active) throw new Error('no demonstration is being captured');
  const state = active;
  active = null;
  cleanup(state);
  flushText(state);
  state.rec.stop();
  const artifact = state.rec.complete();
  const stored = writeArtifact(artifact);
  return { id: stored.id, steps: stored.steps.length, state: 'completed' };
}

function cancel() {
  if (!active) return { cancelled: false };
  const state = active;
  active = null;
  cleanup(state);
  try { state.rec.cancel(); } catch { /* already stopped */ }
  return { cancelled: true };
}

module.exports = { humanCaptureService: { start, stop, cancel, status, applyEvent, helperPath } };
