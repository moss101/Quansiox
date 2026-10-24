'use strict';
/* Voice STT test — dictation chain: real `say` synthesis → real afconvert
 * normalization → fake whisper-cli (canned transcript) → parsed text; plus the
 * honest-unavailable paths and voice listing/diagnosis. Node-only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-stt-'));
process.env.QUANSIOX_USER_DATA_DIR = path.join(tmp, 'userdata');

const { voiceService } = require('../src/main/services/voiceService');

async function run() {
  if (!voiceService.sayAvailable()) {
    console.log('voice STT test: SKIP (macOS `say` unavailable)');
    return;
  }

  // 1. diagnose + voice listing are real.
  const diag = voiceService.diagnose();
  assert.strictEqual(diag.tts.available, true, 'tts available');
  assert.strictEqual(diag.tts.provider, 'local-say');
  assert.ok(diag.tts.voices > 0, `installed voices > 0 (got ${diag.tts.voices})`);
  const voices = voiceService.listVoices();
  assert.ok(voices.length > 0, 'voice list parsed');
  assert.ok(voices.every((v) => typeof v.id === 'string' && v.id.length > 0), 'voices have ids');
  assert.ok(voices.every((v) => /^[a-z]{2,3}[_-]/i.test(v.locale)), 'voices have locales');

  // 2. Real synthesis (say) → fake whisper-cli through the full transcribe chain.
  const logFile = path.join(tmp, 'whisper-args.log');
  const fakeWhisper = path.join(tmp, 'whisper-cli');
  fs.writeFileSync(fakeWhisper, `#!/bin/bash
printf '%s\\n' "$@" > ${logFile}
wav=""
while [ $# -gt 0 ]; do
  case "$1" in -f) wav="$2"; shift 2;; *) shift;; esac
done
printf 'hello from fake whisper\\n' > "\${wav}.txt"
`);
  fs.chmodSync(fakeWhisper, 0o755);
  const fakeModel = path.join(tmp, 'ggml-base.en.bin');
  fs.writeFileSync(fakeModel, 'fake');

  const savedBin = process.env.QUANSIOX_WHISPER_BIN;
  const savedModel = process.env.QUANSIOX_WHISPER_MODEL;
  process.env.QUANSIOX_WHISPER_BIN = fakeWhisper;
  process.env.QUANSIOX_WHISPER_MODEL = fakeModel;

  const stt = voiceService.diagnose().stt;
  assert.strictEqual(stt.available, true, 'stt available with fake bin + model');
  assert.strictEqual(stt.bin, fakeWhisper);

  const synth = await voiceService.synthesize({ text: 'Hello from the speech to text chain test.' });
  assert.ok(synth.audioBase64.length > 1000, 'say produced audio');
  assert.strictEqual(synth.mimeType, 'audio/aiff');

  const out = voiceService.transcribe({ audioBase64: synth.audioBase64, mimeType: 'audio/aiff' });
  assert.strictEqual(out.status, 'ok', 'transcription ok');
  assert.strictEqual(out.text, 'hello from fake whisper', 'canned transcript parsed');
  assert.strictEqual(out.provider, 'local-whisper');
  assert.strictEqual(out.model, fakeModel, 'model reported');

  const args = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  assert.ok(args.includes('-m') && args.includes(fakeModel), 'model passed to whisper');
  assert.ok(args.includes('-f') && args.includes('-otxt'), 'wav + txt flags passed');
  const wavArg = args[args.indexOf('-f') + 1];
  assert.match(wavArg, /\.wav$/, 'afconvert normalization produced a .wav input');
  assert.ok(!fs.existsSync(wavArg), 'temp files cleaned up');

  // 3. Payload guards.
  assert.throws(() => voiceService.transcribe({}), /audioBase64 is required/);
  assert.throws(() => voiceService.transcribe({ audioBase64: ' ' }), /empty audio payload/);

  // 4. No provider → honest unavailable (PATH emptied, env cleared).
  delete process.env.QUANSIOX_WHISPER_BIN;
  delete process.env.QUANSIOX_WHISPER_MODEL;
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(tmp, 'empty-bin');
  fs.mkdirSync(process.env.PATH, { recursive: true });
  const none = voiceService.diagnose().stt;
  assert.strictEqual(none.available, false, 'no provider → unavailable');
  assert.match(none.reason, /whisper|speech-to-text/, 'reason is concrete');
  const un = voiceService.transcribe({ audioBase64: Buffer.from('x'.repeat(2048)).toString('base64'), mimeType: 'audio/wav' });
  assert.deepStrictEqual(un.status, 'unavailable', 'transcribe fails closed with status');
  assert.strictEqual(un.scope, 'voice');
  process.env.PATH = savedPath;

  // 5. Bin present but no model (only when no real model is installed).
  process.env.QUANSIOX_WHISPER_BIN = fakeWhisper;
  const noModel = voiceService.diagnose().stt;
  if (noModel.available) {
    console.log('voice STT test: note — real ggml model present, skipping no-model assertion');
  } else {
    assert.match(noModel.reason, /no model file/, 'missing-model reason is concrete');
  }

  if (savedBin === undefined) delete process.env.QUANSIOX_WHISPER_BIN; else process.env.QUANSIOX_WHISPER_BIN = savedBin;
  if (savedModel === undefined) delete process.env.QUANSIOX_WHISPER_MODEL; else process.env.QUANSIOX_WHISPER_MODEL = savedModel;

  console.log('voice STT test: ALL OK (say → afconvert → whisper chain, honest-unavailable paths)');
}
run().catch((error) => { console.error(error); process.exit(1); });
