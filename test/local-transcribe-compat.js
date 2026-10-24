'use strict';
/* transcribeAudio compat method → local whisper (honest-unavailable if absent). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-transcribe-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { voiceService } = require('../src/main/services/voiceService');

(async () => {
  let env = await grokCompatService.dispatch('transcribeAudio', {});
  assert.equal(env.status, 'error');
  assert.match(env.error, /audioBase64 is required/);

  // A tiny fake WAV payload: either the local whisper chain transcribes it
  // (when installed) or the method reports honest-unavailable — never a fake text.
  const fake = Buffer.from('RIFF0000WAVEfmt ').toString('base64');
  env = await grokCompatService.dispatch('transcribeAudio', { audioBase64: fake, mimeType: 'audio/wav' });
  if (env.status === 'ok') {
    assert.equal(typeof env.text, 'string');
    assert.equal(env.provider, 'local-whisper');
  } else {
    assert.equal(env.status, 'unavailable');
    assert.equal(env.scope, 'voice');
    assert.match(env.reason, /whisper|speech-to-text|model/i);
    assert.equal(voiceService.diagnose().stt.available, false);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('local-transcribe-compat test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
