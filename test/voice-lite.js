'use strict';
/* Local voice + desktop bits — real macOS `say` synthesis/preview, per-agent
 * voice settings, computer-view state, box host phase, sidebar hidden agents. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-voice-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { settingsService } = require('../src/main/services/settingsService');
const { sessionService } = require('../src/main/services/sessionService');
const { voiceService } = require('../src/main/services/voiceService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  const hasSay = voiceService.sayAvailable();

  // 1. synthesizeSpeech — real local TTS on macOS
  const synth = await grokCompatService.dispatch('synthesizeSpeech', { text: 'Hello, Quansiox.', voiceId: 'Samantha' });
  if (hasSay) {
    assert.strictEqual(synth.status, 'ok');
    assert.strictEqual(synth.provider, 'local-say');
    assert.strictEqual(synth.mimeType, 'audio/aiff');
    assert.ok(synth.audioBase64.length > 1000, 'audio payload');
    assert.ok(synth.durationMs > 200, `duration ${synth.durationMs}`);
    assert.strictEqual(synth.voice, 'Samantha');
  } else {
    assert.strictEqual(synth.status, 'error', 'honest failure without say');
  }
  const empty = await grokCompatService.dispatch('synthesizeSpeech', { text: '   ' });
  assert.strictEqual(empty.status, 'error');
  const tooLong = await grokCompatService.dispatch('synthesizeSpeech', { text: 'x'.repeat(2001) });
  assert.strictEqual(tooLong.status, 'error');
  const badVoice = await grokCompatService.dispatch('synthesizeSpeech', { text: 'hi', voiceId: '$(rm -rf /)' });
  assert.strictEqual(badVoice.status, 'error');

  // 2. previewVoice — real playback, one short utterance
  const preview = await grokCompatService.dispatch('previewVoice', { voiceId: 'Samantha', greeting: 'hi', greetingId: 'g1' });
  if (hasSay) {
    assert.strictEqual(preview.played, true);
    assert.strictEqual(preview.greetingId, 'g1');
  } else {
    assert.strictEqual(preview.status, 'error');
  }
  const previewNoVoice = await grokCompatService.dispatch('previewVoice', {});
  assert.strictEqual(previewNoVoice.status, 'error');

  // 3. per-agent voice — persisted on the session
  sessionService.ensure('sess-v');
  const v1 = await grokCompatService.dispatch('setAgentVoice', { id: 'sess-v', voiceId: 'Daniel', voiceSpeed: 1.25, voiceLanguage: 'en-GB' });
  assert.strictEqual(v1.voice.voiceId, 'Daniel');
  assert.strictEqual(v1.voice.voiceSpeed, 1.25);
  assert.strictEqual(sessionService.get('sess-v').voice.voiceId, 'Daniel');
  const v2 = await grokCompatService.dispatch('setGrokBotAgentVoice', { agentId: 'sess-v', voiceId: null });
  assert.strictEqual(v2.voice.voiceId, null, 'clearing the voice is allowed');
  assert.strictEqual(v2.voice.voiceSpeed, 1.25, 'unspecified fields keep stored values');
  const v3 = await grokCompatService.dispatch('setAgentVoice', { id: 'no-such', voiceId: 'Daniel' });
  assert.strictEqual(v3.status, 'error');

  // 4. computer view + box host phase
  assert.strictEqual((await grokCompatService.dispatch('setComputerViewOpen', { isOpen: true })).isOpen, true);
  assert.strictEqual(settingsService.load().computerViewOpen, true);
  const phase = await grokCompatService.dispatch('getBoxHostPhase', {});
  assert.strictEqual(phase.phase, 'idle');
  assert.strictEqual(phase.sandboxes, 0);

  // 5. hidden agents in the sidebar
  const hide = await grokCompatService.dispatch('setAgentHiddenFromSidebar', { id: 'sess-v', isHidden: true });
  assert.strictEqual(hide.isHidden, true);
  assert.deepStrictEqual(settingsService.load().hiddenAgents, ['sess-v']);
  await grokCompatService.dispatch('setAgentHiddenFromSidebar', { id: 'sess-v', isHidden: false });
  assert.deepStrictEqual(settingsService.load().hiddenAgents, []);
  assert.strictEqual((await grokCompatService.dispatch('setAgentHiddenFromSidebar', {})).status, 'error');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('voice-lite test: ALL OK (say synthesis/preview, agent voice, computer view, box phase, sidebar)');
})().catch((e) => { console.error(e); process.exit(1); });
