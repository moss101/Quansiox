'use strict';
/**
 * Agent-workflow recorder — a local, self-contained record→replay pipeline
 * (the local analog of Grok's "recorded workflow skills"). While a recording is
 * active for a session, the computer_* actions the AGENT performs are captured
 * into a SkillRecorder and finalized into a replayable artifact (`writeArtifact`)
 * that `replay_skill` can re-drive. Gated: nothing is recorded unless start() was
 * called, so live computer use is unchanged.
 *
 * Note: this records the *agent's own* GUI actions (no native taps). Capturing
 * a human's demonstration requires a CGEventTap — see docs/unified-computer-runtime.md.
 */
const { SkillRecorder, writeArtifact } = require('./skill-recording');

/** sessionId -> { rec: SkillRecorder, startedAt } */
const recorders = new Map();

const STEP_MAP = {
  computer_click: (a) => ({ kind: 'click', x: a.x, y: a.y }),
  computer_type: (a) => ({ kind: 'type', text: String(a.text ?? '') }),
  computer_key: (a) => ({ kind: 'key', key: a.key, modifiers: a.modifiers || [] }),
  computer_scroll: (a) => ({ kind: 'scroll', x: a.x, y: a.y, deltaY: a.deltaY }),
  computer_set_value: (a) => ({ kind: 'set_value', role: a.role, name: a.name, value: a.value }),
  computer_open_app: (a) => ({ kind: 'open_app', name: String(a.name ?? '') }),
};

function isRecording(sessionId) { return recorders.has(String(sessionId || '')); }

function start(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) throw new Error('a session is required to record');
  if (recorders.has(sid)) throw new Error('this session already has a recording in progress');
  const rec = new SkillRecorder();
  rec.prepare();
  rec.begin();
  recorders.set(sid, { rec, startedAt: Date.now() });
  return { sessionId: sid, state: rec.state };
}

/** Capture one computer action; returns true if it was recorded. Never throws. */
function noteStep(sessionId, toolName, args) {
  const entry = recorders.get(String(sessionId || ''));
  if (!entry) return false;
  const build = STEP_MAP[toolName];
  if (!build) return false; // screenshot/ax/find/list_apps are not replayed as steps
  try {
    entry.rec.note(build(args || {}));
    return true;
  } catch {
    return false;
  }
}

function stop(sessionId) {
  const sid = String(sessionId || '');
  const entry = recorders.get(sid);
  if (!entry) throw new Error('this session is not recording');
  recorders.delete(sid);
  const steps = entry.rec.steps.length;
  entry.rec.stop(); // recording → processing
  const artifact = entry.rec.complete(); // processing → completed
  const stored = writeArtifact(artifact);
  return { id: stored.id, steps, state: 'completed' };
}

function cancel(sessionId) {
  const sid = String(sessionId || '');
  const entry = recorders.get(sid);
  if (!entry) throw new Error('this session is not recording');
  recorders.delete(sid);
  entry.rec.cancel();
  return { sessionId: sid, cancelled: true };
}

function status(sessionId) {
  const entry = recorders.get(String(sessionId || ''));
  return entry ? { recording: true, steps: entry.rec.steps.length, startedAt: entry.startedAt } : { recording: false, steps: 0 };
}

module.exports = { agentRecorder: { isRecording, start, noteStep, stop, cancel, status } };
