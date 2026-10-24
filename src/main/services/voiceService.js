'use strict';
/**
 * Voice service — local text-to-speech on macOS via the system `say` binary
 * (no cloud voice service). Synthesizes to audio files (AIFF) and can play
 * previews aloud. Per-agent voice settings persist in the session record /
 * agent-voice store. Speech-to-text (dictation) uses a local whisper.cpp
 * binary when installed (honest-unavailable otherwise). No cloud fallback.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_TEXT = 2000;
const SYNTH_TIMEOUT_MS = 30_000;
const STT_MAX_BYTES = 25 * 1024 * 1024;
const STT_TIMEOUT_MS = 120_000;

function sayAvailable() {
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/say');
}
function sanitizeVoice(voiceId) {
  const v = String(voiceId ?? '').trim();
  if (!v) return null;
  if (!/^[A-Za-z0-9 ._()'-]{1,64}$/.test(v)) throw new Error('invalid voice id');
  return v;
}
function clampSpeed(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s)) return null;
  return Math.min(4, Math.max(0.5, s));
}

/** All installed system voices (`say -v ?`), name + locale + sample line. */
function listVoices() {
  if (!sayAvailable()) throw new Error('voice listing requires macOS `say`');
  const run = spawnSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8', timeout: 10_000 });
  if (run.status !== 0) throw new Error(`say -v ? exited ${run.status}`);
  const out = [];
  for (const line of String(run.stdout ?? '').split('\n')) {
    const m = /^(.+?)\s{2,}([a-zA-Z]{2,3}[_-][a-zA-Z0-9]{2,7})\s+#\s?(.*)$/.exec(line);
    if (m) out.push({ id: m[1].trim(), locale: m[2], sample: m[3].trim() });
  }
  return out;
}

/** Duration via afinfo when available; byte-based fallback (22050 Hz 16-bit mono). */
function probeDurationMs(file, buf) {
  try {
    const { execFileSync } = require('node:child_process');
    const info = execFileSync('/usr/bin/afinfo', [file], { encoding: 'utf8', timeout: 5000 });
    const m = info.match(/estimated duration:\s*([\d.]+)\s*sec/i);
    if (m) return Math.round(Number(m[1]) * 1000);
  } catch {}
  return Math.round((buf.length / (22050 * 2)) * 1000);
}

function synthesize({ text, voiceId, sessionId, speed } = {}) {
  if (!sayAvailable()) throw new Error('local speech synthesis requires macOS `say`');
  const spoken = String(text ?? '').trim();
  if (!spoken) throw new Error('text is required');
  if (spoken.length > MAX_TEXT) throw new Error(`text too long (max ${MAX_TEXT} chars)`);
  // Per-bot voice: explicit args win; otherwise the session's stored voice.
  let voice = sanitizeVoice(voiceId);
  let rate = null;
  const sessionSpeed = clampSpeed(speed);
  if (sessionSpeed) rate = Math.min(700, Math.max(90, Math.round(175 * sessionSpeed)));
  if ((!voice || !rate) && sessionId) {
    try {
      const { sessionService } = require('./sessionService');
      const stored = sessionService.get(String(sessionId))?.voice ?? {};
      if (!voice) voice = sanitizeVoice(stored.voiceId);
      if (!rate) {
        const s = clampSpeed(stored.voiceSpeed);
        if (s) rate = Math.min(700, Math.max(90, Math.round(175 * s)));
      }
    } catch { /* no stored voice */ }
  }
  const out = path.join(os.tmpdir(), `qx-tts-${process.pid}-${Date.now()}.aiff`);
  const args = ['-o', out];
  if (voice) args.push('-v', voice);
  if (rate) args.push('-r', String(rate));
  args.push(spoken);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/say', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('synthesis timed out')); }, SYNTH_TIMEOUT_MS);
    child.once('error', (e) => { clearTimeout(timer); reject(new Error(`say failed: ${e.message}`)); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) return reject(new Error(`say exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
        const buf = fs.readFileSync(out);
        const durationMs = probeDurationMs(out, buf);
        fs.rmSync(out, { force: true });
        resolve({
          audioBase64: buf.toString('base64'),
          mimeType: 'audio/aiff',
          durationMs,
          voice,
          speed: rate ? rate / 175 : 1,
          provider: 'local-say',
          bytes: buf.length,
        });
      } catch (e) { reject(e); }
    });
  });
}

function preview({ voiceId, greeting } = {}) {
  if (!sayAvailable()) throw new Error('voice preview requires macOS `say`');
  const voice = sanitizeVoice(voiceId);
  if (!voice) throw new Error('voiceId is required');
  const text = String(greeting ?? "Hi, I'm Quansiox. This is how I sound.").slice(0, 200);
  const child = spawn('/usr/bin/say', ['-v', voice, text], { stdio: 'ignore', detached: true });
  child.unref();
  return { played: true, voice, text };
}

/** Per-agent voice settings (session record store). */
function setAgentVoice({ id, voiceId, voiceSpeed, voiceLanguage } = {}) {
  const agentId = String(id ?? '');
  if (!agentId) throw new Error('id is required');
  const voice = {
    voiceId: voiceId === undefined ? undefined : (voiceId === null ? null : sanitizeVoice(voiceId)),
    voiceSpeed: voiceSpeed === undefined ? undefined : clampSpeed(voiceSpeed),
    voiceLanguage: voiceLanguage === undefined ? undefined : String(voiceLanguage).slice(0, 16),
    updatedAt: Date.now(),
  };
  try {
    const { sessionService } = require('./sessionService');
    const session = sessionService.get(agentId);
    session.voice = { ...(session.voice ?? {}), ...Object.fromEntries(Object.entries(voice).filter(([, v]) => v !== undefined)) };
    sessionService.save(session);
    return { id: agentId, voice: session.voice };
  } catch (e) {
    throw new Error(`no agent ${agentId} to set a voice on`);
  }
}

/* ---- speech-to-text (dictation) ----
 * Local whisper.cpp only — no cloud fallback. Honest-unavailable with a
 * concrete reason when no provider/model is installed. */

function findWhisperBin() {
  const env = String(process.env.QUANSIOX_WHISPER_BIN ?? '').trim();
  if (env) return env;
  for (const bin of ['whisper-cli', 'whisper-cpp', 'whisper']) {
    try {
      const found = spawnSync('/usr/bin/which', [bin], { encoding: 'utf8', timeout: 5000 }).stdout?.trim();
      if (found) return found;
    } catch { /* not on PATH */ }
  }
  return null;
}

function findWhisperModel() {
  const env = String(process.env.QUANSIOX_WHISPER_MODEL ?? '').trim();
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    path.join(os.homedir(), '.cache', 'whisper', 'ggml-base.en.bin'),
    path.join(os.homedir(), '.cache', 'whisper', 'ggml-base.bin'),
    '/opt/homebrew/share/whisper.cpp/models/ggml-base.en.bin',
    '/opt/homebrew/share/whisper.cpp/models/ggml-base.bin',
    '/usr/local/share/whisper.cpp/models/ggml-base.en.bin',
    path.join(os.homedir(), '.local', 'share', 'whisper-cpp', 'ggml-base.en.bin'),
  ];
  return candidates.find((f) => { try { return fs.existsSync(f); } catch { return false; } }) ?? null;
}

/** Dictation availability (honest reasons when missing). */
function sttStatus() {
  const bin = findWhisperBin();
  if (!bin) {
    return {
      available: false,
      provider: null,
      reason: 'no local speech-to-text provider — install whisper.cpp (whisper-cli) to enable dictation',
    };
  }
  const isPythonWhisper = path.basename(bin) === 'whisper';
  const model = isPythonWhisper ? null : findWhisperModel();
  if (!isPythonWhisper && !model) {
    return {
      available: false,
      provider: 'local-whisper',
      bin,
      reason: 'whisper binary found but no model file — set QUANSIOX_WHISPER_MODEL or install a ggml model',
    };
  }
  return { available: true, provider: 'local-whisper', bin, model };
}

function diagnose() {
  const stt = sttStatus();
  let tts;
  if (sayAvailable()) {
    let voiceCount = 0;
    try { voiceCount = listVoices().length; } catch { /* list failed; still usable */ }
    tts = { available: true, provider: 'local-say', voices: voiceCount };
  } else {
    tts = { available: false, provider: null, reason: 'local speech synthesis requires macOS `say`' };
  }
  return { tts, stt };
}

function pickAudioExt(mimeType) {
  const mime = String(mimeType ?? '').toLowerCase();
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('aiff')) return 'aiff';
  return 'audio';
}

/** Transcribe recorded audio (base64) with the local whisper binary. */
function transcribe({ audioBase64, mimeType } = {}) {
  const b64 = String(audioBase64 ?? '');
  if (!b64) throw new Error('audioBase64 is required');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('empty audio payload');
  if (buf.length > STT_MAX_BYTES) throw new Error('audio too large (max 25 MB)');
  const status = sttStatus();
  if (!status.available) return { status: 'unavailable', scope: 'voice', reason: status.reason };

  const stamp = `${process.pid}-${Date.now()}`;
  const inFile = path.join(os.tmpdir(), `qx-stt-${stamp}.${pickAudioExt(mimeType)}`);
  const wavFile = path.join(os.tmpdir(), `qx-stt-${stamp}.wav`);
  const cleanup = new Set([inFile, wavFile]);
  fs.writeFileSync(inFile, buf);
  try {
    // Normalize to 16 kHz mono WAV for whisper (macOS afconvert; raw file if absent).
    let source = inFile;
    const conv = spawnSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', inFile, wavFile], { timeout: 30_000 });
    if (conv.status === 0 && fs.existsSync(wavFile)) source = wavFile;

    const isPythonWhisper = path.basename(status.bin) === 'whisper';
    const args = isPythonWhisper
      ? [source, '--model', 'base.en', '--output_format', 'txt', '--output_dir', os.tmpdir(), '--fp16', 'False']
      : ['-m', status.model, '-f', source, '-otxt', '-nt'];
    const run = spawnSync(status.bin, args, { encoding: 'utf8', timeout: STT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
    if (run.error) throw new Error(`whisper failed to start: ${run.error.message}`);
    if (run.status !== 0) {
      const detail = String(run.stderr ?? '').trim().slice(0, 200);
      throw new Error(`whisper exited ${run.status}${detail ? `: ${detail}` : ''}`);
    }
    const txtFile = isPythonWhisper
      ? path.join(os.tmpdir(), `${path.basename(source).replace(/\.[^.]+$/, '')}.txt`)
      : `${source}.txt`;
    cleanup.add(txtFile);
    let text = '';
    if (fs.existsSync(txtFile)) text = fs.readFileSync(txtFile, 'utf8');
    else if (run.stdout) text = run.stdout;
    text = String(text).replace(/\[[\d:.\->\s]+\]/g, ' ').replace(/\s+/g, ' ').trim();
    return { status: 'ok', text, provider: 'local-whisper', model: status.model ?? 'base.en' };
  } finally {
    for (const f of cleanup) { try { fs.rmSync(f, { force: true }); } catch { /* tmp */ } }
  }
}

module.exports = { voiceService: { synthesize, preview, setAgentVoice, sayAvailable, listVoices, diagnose, transcribe } };
