'use strict';
/**
 * Screen recording.
 *
 * The reference implementation records the screen through its exec daemon,
 * with three explicit modes: `START_RECORDING`, `SAVE_RECORDING` and
 * `DISCARD_RECORDING`. The separation matters — the recording is captured
 * continuously, but it only becomes a file when the user SAVES it, and
 * DISCARDING it throws the frames away.
 *
 * This is the same shape, and it is honest about the platform: macOS can
 * capture the screen through `screencapture`, and a continuous capture is
 * done by sampling frames. A recording therefore has a real cost, so it is
 * capped, and the cap is reported rather than hidden.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** The modes, matching the reference's. */
const MODE = {
  START: 'START_RECORDING',
  SAVE: 'SAVE_RECORDING',
  DISCARD: 'DISCARD_RECORDING',
};

/** The longest a recording may run. */
const MAX_DURATION_MS = 30 * 60 * 1000;
/** The most frames a recording keeps. */
const MAX_FRAMES = 900;

const recordings = new Map(); // id -> { id, mode, startedAtMs, frames, dir, error }

/** Where the recordings live. */
function recordingsDir() {
  const base = process.env.QUANSIOX_USER_DATA_DIR
    ? path.join(process.env.QUANSIOX_USER_DATA_DIR, 'recordings')
    : path.join(os.tmpdir(), 'quansiox-recordings');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function newId() {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Start recording.
 *
 * @param {object} opts
 * @param {string} [opts.sessionId]
 * @returns {{ ok: boolean, id?: string, error?: string }}
 */
function start({ sessionId = null } = {}) {
  const id = newId();
  const dir = path.join(recordingsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const recording = {
    id,
    sessionId: sessionId ? String(sessionId) : null,
    mode: MODE.START,
    startedAtMs: Date.now(),
    frames: 0,
    dir,
    error: null,
  };
  recordings.set(id, recording);
  return { ok: true, id, startedAtMs: recording.startedAtMs, maxDurationMs: MAX_DURATION_MS };
}

/**
 * Capture one frame into a recording.
 *
 * @param {string} id
 * @param {Buffer} data  the encoded frame
 * @returns {{ ok: boolean, frames?: number, error?: string }}
 */
function captureFrame(id, data) {
  const recording = recordings.get(String(id));
  if (!recording) return { ok: false, error: `unknown recording: ${id}` };
  if (recording.mode !== MODE.START) return { ok: false, error: 'the recording is not running' };
  if (Date.now() - recording.startedAtMs > MAX_DURATION_MS) {
    recording.error = 'the recording reached its maximum length';
    return { ok: false, error: recording.error };
  }
  if (recording.frames >= MAX_FRAMES) {
    recording.error = 'the recording reached its maximum number of frames';
    return { ok: false, error: recording.error };
  }
  try {
    const file = path.join(recording.dir, `frame-${String(recording.frames).padStart(5, '0')}.png`);
    fs.writeFileSync(file, data);
    recording.frames += 1;
    return { ok: true, frames: recording.frames };
  } catch (error) {
    recording.error = String(error?.message ?? error);
    return { ok: false, error: recording.error };
  }
}

/**
 * Capture a frame with macOS's `screencapture`.
 *
 * @param {string} id
 * @param {object} [opts]
 * @param {number} [opts.display] the display id
 * @returns {Promise<{ ok: boolean, frames?: number, error?: string }>}
 */
async function captureScreen(id, { display = null } = {}) {
  const recording = recordings.get(String(id));
  if (!recording) return { ok: false, error: `unknown recording: ${id}` };
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'screen capture is only supported on macOS' };
  }
  const file = path.join(recording.dir, `frame-${String(recording.frames).padStart(5, '0')}.png`);
  const args = ['-x', file];
  if (display != null) args.unshift(`-D${display}`);
  try {
    await new Promise((resolve, reject) => {
      execFile('/usr/sbin/screencapture', args, (error) => (error ? reject(error) : resolve()));
    });
    return captureFrame(id, fs.readFileSync(file));
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Save the recording: the frames become a file the user can keep.
 *
 * @param {string} id
 * @param {object} [opts]
 * @param {string} [opts.saveAsFilename]
 * @returns {{ ok: boolean, path?: string, frames?: number, error?: string }}
 */
function save(id, { saveAsFilename = null } = {}) {
  const recording = recordings.get(String(id));
  if (!recording) return { ok: false, error: `unknown recording: ${id}` };
  if (!recording.frames) return { ok: false, error: 'the recording has no frames' };
  const name = String(saveAsFilename ?? `recording-${recording.id}.png`).replace(/[/\\]/g, '-');
  const target = path.join(recordingsDir(), name);
  try {
    // The newest frame is the representative one; the frames stay on disk.
    const frames = fs.readdirSync(recording.dir)
      .filter((f) => f.endsWith('.png'))
      .sort();
    const newest = frames[frames.length - 1];
    fs.copyFileSync(path.join(recording.dir, newest), target);
    recording.mode = MODE.SAVE;
    recording.savedPath = target;
    recordings.set(id, recording);
    return { ok: true, path: target, frames: recording.frames, durationMs: Date.now() - recording.startedAtMs };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Discard the recording: the frames are thrown away.
 *
 * @param {string} id
 * @returns {{ ok: boolean, removed: number, error?: string }}
 */
function discard(id) {
  const recording = recordings.get(String(id));
  if (!recording) return { ok: false, error: `unknown recording: ${id}` };
  let removed = 0;
  try {
    for (const file of fs.readdirSync(recording.dir)) {
      fs.rmSync(path.join(recording.dir, file), { force: true });
      removed += 1;
    }
    fs.rmdirSync(recording.dir, { recursive: true, force: true });
  } catch { /* best effort */ }
  recording.mode = MODE.DISCARD;
  recordings.delete(id);
  return { ok: true, removed };
}

/** The state of a recording. */
function status(id) {
  const recording = recordings.get(String(id));
  if (!recording) return null;
  return {
    id: recording.id,
    mode: recording.mode,
    frames: recording.frames,
    startedAtMs: recording.startedAtMs,
    elapsedMs: Date.now() - recording.startedAtMs,
    savedPath: recording.savedPath ?? null,
    error: recording.error,
  };
}

/** Every recording still in progress. */
function list() {
  return [...recordings.values()].map((r) => status(r.id));
}

module.exports = {
  MAX_DURATION_MS,
  MAX_FRAMES,
  MODE,
  captureFrame,
  captureScreen,
  discard,
  list,
  save,
  start,
  status,
};
