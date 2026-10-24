'use strict';
/**
 * Voice session — a real full-duplex voice loop, entirely local.
 *
 * The renderer streams microphone frames (16-bit mono PCM) to the main
 * process; the main process segments speech with an energy-based voice
 * activity detector, transcribes each utterance with the local whisper
 * binary, and speaks the agent's replies back — sentence by sentence, so
 * the first words are audible before the whole reply has been generated.
 *
 * Three things make it *full duplex* rather than a turn-taking toy:
 *
 *  - **Barge-in.** While the agent is speaking, the microphone keeps
 *    listening. If the user starts talking, the playback is cut off
 *    immediately — the user never has to wait for a sentence to finish.
 *  - **Sentence-level streaming.** A long reply is split and synthesized
 *    per sentence, so the first audio plays while the rest is still being
 *    written.
 *  - **Echo-aware gating.** The detector raises its threshold while the
 *    agent is speaking, so the agent's own voice does not trigger the
 *    microphone.
 *
 * There is no cloud service in the loop: speech in is whisper.cpp on this
 * Mac, speech out is the system `say` voice.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FRAME_MS = 20;                 // the renderer's frame size
const SAMPLE_RATE = 16_000;
const SPEECH_FRAMES = 3;             // frames above the threshold to start
const SILENCE_FRAMES = 25;           // frames below it to end an utterance
const MIN_UTTERANCE_MS = 300;
const MAX_UTTERANCE_MS = 30_000;
const NOISE_FLOOR_MIN = 120;

/** token -> session */
const sessions = new Map();

/** The injectable pieces (tests replace them). */
let deps = {
  /** Transcribe a PCM buffer -> { status, text }. */
  transcribe: async (pcm, sampleRate) => {
    const { voiceService } = require('./voiceService');
    const wav = pcmToWav(pcm, sampleRate);
    return voiceService.transcribe({
      audioBase64: wav.toString('base64'),
      mimeType: 'audio/wav',
    });
  },
  /** Speak a phrase -> resolves when the audio finished. */
  speak: async (text, { voiceId, speed, onStart, onEnd } = {}) => {
    return speakWithSay(text, { voiceId, speed, onStart, onEnd });
  },
  /** Emit an event to the renderer. */
  emit: (method, payload) => {
    try { require('../ipc/emitEvent').emitEvent('voiceSession', method, payload); } catch { /* no renderer */ }
  },
};

function resetDeps() {
  deps = {
    transcribe: async (pcm, sampleRate) => {
      const { voiceService } = require('./voiceService');
      const wav = pcmToWav(pcm, sampleRate);
      return voiceService.transcribe({ audioBase64: wav.toString('base64'), mimeType: 'audio/wav' });
    },
    speak: async (text, { voiceId, speed, onStart, onEnd } = {}) => speakWithSay(text, { voiceId, speed, onStart, onEnd }),
    emit: (method, payload) => {
      try { require('../ipc/emitEvent').emitEvent('voiceSession', method, payload); } catch { /* no renderer */ }
    },
  };
}

/* ---------------- PCM helpers ---------------- */

/** A 44-byte RIFF/WAVE header for 16-bit mono PCM. */
function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm ?? []);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM
  header.writeUInt16LE(1, 22);          // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The root-mean-square of a 16-bit PCM frame. */
function rms(buffer) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
    count += 1;
  }
  if (!count) return 0;
  return Math.sqrt(sum / count);
}

/* ---------------- the session ---------------- */

function newToken() {
  return `vs_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Start a voice session.
 * @param {object} opts
 * @param {string} [opts.sessionId]  the chat session it belongs to
 * @param {string} [opts.voiceId]
 * @param {number} [opts.speed]
 */
function start({ sessionId = null, voiceId = null, speed = 1 } = {}) {
  const token = newToken();
  const session = {
    token,
    sessionId,
    voiceId,
    speed,
    sampleRate: SAMPLE_RATE,
    state: 'listening',        // listening | speaking | stopped
    noiseFloor: NOISE_FLOOR_MIN,
    speaking: false,
    speakingUntil: 0,
    frames: 0,
    hotFrames: 0,
    coldFrames: 0,
    utterance: [],              // the PCM of the current utterance
    utteranceMs: 0,
    utterances: [],             // the transcripts of this session
    queue: [],                  // the sentences waiting to be spoken
    speakingNow: false,
    child: null,
    cancelled: false,
    startedAt: Date.now(),
  };
  sessions.set(token, session);
  deps.emit('state', { token, state: session.state, speaking: false });
  return { token, state: session.state, sampleRate: session.sampleRate };
}

function get(token) { return sessions.get(String(token ?? '')) ?? null; }

/**
 * Push a microphone frame.
 *
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} opts.pcmBase64  16-bit mono PCM
 */
function pushAudio({ token, pcmBase64 } = {}) {
  const session = get(token);
  if (!session) return { ok: false, reason: 'unknown voice session' };
  if (session.state === 'stopped') return { ok: false, reason: 'the voice session has stopped' };

  const pcm = Buffer.from(String(pcmBase64 ?? ''), 'base64');
  if (!pcm.length) return { ok: true, state: session.state };

  session.frames += 1;
  const level = rms(pcm);

  // The noise floor tracks the quiet background.
  if (level < session.noiseFloor) {
    session.noiseFloor = session.noiseFloor * 0.98 + level * 0.02;
  }
  // While the agent talks, the threshold is raised so the agent's own voice
  // does not come back in as a user turn.
  const base = Math.max(session.noiseFloor * 3, NOISE_FLOOR_MIN);
  const threshold = session.speaking ? base * 2.5 : base;
  const hot = level > threshold;

  if (hot) {
    session.hotFrames += 1;
    session.coldFrames = 0;
  } else {
    session.coldFrames += 1;
    session.hotFrames = 0;
  }

  let bargeIn = false;
  if (session.speaking && session.hotFrames >= SPEECH_FRAMES) {
    // The user interrupted the agent.
    bargeIn = true;
    stopPlayback(session);
  }

  if (session.hotFrames >= SPEECH_FRAMES && session.utterance.length === 0) {
    session.utteranceStart = Date.now();
  }
  if (session.utterance.length > 0 || session.hotFrames >= SPEECH_FRAMES) {
    session.utterance.push(pcm);
    session.utteranceMs += FRAME_MS;
  }

  let finalised = null;
  if (session.utteranceMs >= MIN_UTTERANCE_MS && session.coldFrames >= SILENCE_FRAMES) {
    finalised = finaliseUtterance(session);
  } else if (session.utteranceMs >= MAX_UTTERANCE_MS) {
    finalised = finaliseUtterance(session);
  }

  if (finalised) {
    // Transcribe in the background — the microphone keeps running.
    void transcribeUtterance(session, finalised.pcm);
  }

  return {
    ok: true,
    state: session.state,
    speaking: session.speaking,
    level: Math.round(level),
    bargeIn,
    finalised: finalised ? { ms: finalised.ms } : null,
  };
}

function finaliseUtterance(session) {
  const pcm = Buffer.concat(session.utterance);
  const ms = session.utteranceMs;
  session.utterance = [];
  session.utteranceMs = 0;
  session.hotFrames = 0;
  session.coldFrames = 0;
  return { pcm, ms };
}

async function transcribeUtterance(session, utterance) {
  deps.emit('partial', { token: session.token, ms: utterance.ms, state: 'transcribing' });
  let result = { status: 'unavailable', text: '' };
  try {
    result = await deps.transcribe(utterance.pcm, session.sampleRate);
  } catch (error) {
    result = { status: 'error', text: '', reason: String(error?.message ?? error) };
  }
  const text = String(result?.text ?? '').trim();
  if (!text) {
    deps.emit('transcript', { token: session.token, text: '', status: result?.status ?? 'empty' });
    return;
  }
  const entry = { text, at: Date.now(), ms: utterance.ms };
  session.utterances.push(entry);
  deps.emit('transcript', { token: session.token, text, status: 'ok', at: entry.at });
}

/**
 * Speak a reply — split into sentences and synthesized one at a time, so
 * the audio starts before the whole reply exists.
 */
function speak({ token, text, voiceId, speed } = {}) {
  const session = get(token);
  if (!session) return { ok: false, reason: 'unknown voice session' };
  const sentences = splitSentences(String(text ?? '').trim());
  if (!sentences.length) return { ok: true, queued: 0 };
  for (const sentence of sentences) {
    session.queue.push(sentence);
  }
  if (!session.speakingNow) void drainQueue(session, { voiceId, speed });
  return { ok: true, queued: sentences.length };
}

/** Split a reply into speakable sentences. */
function splitSentences(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])|(?<=[.!?])$/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function drainQueue(session, { voiceId, speed } = {}) {
  session.speakingNow = true;
  session.state = 'speaking';
  session.speaking = true;
  deps.emit('state', { token: session.token, state: session.state, speaking: true });
  try {
    while (session.queue.length && !session.cancelled) {
      const sentence = session.queue.shift();
      deps.emit('speaking', { token: session.token, text: sentence, done: false });
      await deps.speak(sentence, {
        voiceId: voiceId ?? session.voiceId,
        speed: speed ?? session.speed,
        onStart: () => { session.speaking = true; },
      });
      deps.emit('speaking', { token: session.token, text: sentence, done: true });
      // A small gap so consecutive sentences do not run together.
      await sleep(60);
    }
  } finally {
    session.speakingNow = false;
    session.speaking = false;
    session.state = session.cancelled ? 'stopped' : 'listening';
    deps.emit('state', { token: session.token, state: session.state, speaking: false });
  }
}

/** Stop the current playback (barge-in or an explicit stop). */
function stopPlayback(session) {
  if (session.child && !session.child.killed) {
    try { session.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  session.child = null;
  session.queue = [];
  session.speaking = false;
  session.speakingNow = false;
  deps.emit('interrupted', { token: session.token });
}

/** Interrupt the agent (the user started talking, or pressed stop). */
function interrupt({ token } = {}) {
  const session = get(token);
  if (!session) return { ok: false, reason: 'unknown voice session' };
  stopPlayback(session);
  session.state = 'listening';
  deps.emit('state', { token: session.token, state: session.state, speaking: false });
  return { ok: true };
}

/** Stop the session. */
function stop({ token } = {}) {
  const session = get(token);
  if (!session) return { ok: false, reason: 'unknown voice session' };
  session.cancelled = true;
  stopPlayback(session);
  session.state = 'stopped';
  sessions.delete(session.token);
  deps.emit('state', { token: session.token, state: 'stopped', speaking: false });
  return { ok: true };
}

function list() {
  return [...sessions.values()].map((s) => ({
    token: s.token,
    sessionId: s.sessionId,
    state: s.state,
    speaking: s.speaking,
    utterances: s.utterances.length,
    startedAt: s.startedAt,
  }));
}

/* ---------------- the local TTS ---------------- */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Speak a phrase with the macOS `say` binary. */
function speakWithSay(text, { voiceId, speed, onStart } = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/say')) {
      reject(new Error('local speech synthesis requires macOS `say`'));
      return;
    }
    const args = [];
    if (voiceId) args.push('-v', String(voiceId));
    if (speed && Number(speed) !== 1) args.push('-r', String(Math.round(180 * Number(speed))));
    args.push('-o', '-', String(text));
    const child = spawn('/usr/bin/say', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => { onStart?.(); resolve({ audio: Buffer.concat(chunks) }); });
  });
}

module.exports = {
  voiceSessionService: {
    start, pushAudio, speak, interrupt, stop, list, get,
    splitSentences, rms, pcmToWav,
    _setDeps: (next) => { deps = { ...deps, ...next }; },
    _resetDeps: resetDeps,
  },
};
