'use strict';
/* Voice session + meeting copilot.
 *
 *  - the voice activity detector segments speech out of a silence
 *  - an utterance is transcribed once it ends
 *  - the reply is split into sentences and spoken one at a time
 *  - talking while the agent speaks cuts the playback off (barge-in)
 *  - the reply text survives the round trip
 *  - a meeting keeps its transcript, and the analysis is parsed out of a
 *    model's answer (JSON, fenced JSON, or plain prose)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-voice-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { voiceSessionService } = require('../src/main/services/voiceSessionService');
const { meetingService } = require('../src/main/services/meetingService');

/** A PCM frame of a given amplitude. */
function frame(amplitude, samples = 800) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeInt16LE(Math.round(amplitude * 32767 * Math.sin(i / 4)), i * 2);
  }
  return buffer.toString('base64');
}

const SILENCE = frame(0.001);
const SPEECH = frame(0.6);

(async () => {
  // 1. the detector segments speech
  const transcripts = [];
  const states = [];
  voiceSessionService._setDeps({
    transcribe: async () => ({ status: 'ok', text: 'hello there' }),
    speak: async () => ({ ok: true }),
    emit: (method, payload) => {
      if (method === 'transcript') transcripts.push(payload);
      if (method === 'state') states.push(payload);
    },
  });

  const started = voiceSessionService.start({ sessionId: 'sess-1' });
  assert.ok(started.token);
  assert.equal(started.sampleRate, 16000);

  // 30 silent frames (the noise floor settles)
  for (let i = 0; i < 30; i += 1) voiceSessionService.pushAudio({ token: started.token, pcmBase64: SILENCE });
  // 40 loud frames (800 ms of speech)
  for (let i = 0; i < 40; i += 1) voiceSessionService.pushAudio({ token: started.token, pcmBase64: SPEECH });
  // 30 silent frames — the utterance ends
  for (let i = 0; i < 30; i += 1) voiceSessionService.pushAudio({ token: started.token, pcmBase64: SILENCE });

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(transcripts.length, 1, 'the utterance was transcribed once');
  assert.equal(transcripts[0].text, 'hello there');

  // 2. the reply is split into sentences
  const sentences = voiceSessionService.splitSentences('First point. Second point! Third question?');
  assert.deepEqual(sentences, ['First point.', 'Second point!', 'Third question?']);

  // 3. the sentences are spoken one at a time
  const spoken = [];
  voiceSessionService._setDeps({
    speak: async (text) => { spoken.push(text); return { ok: true }; },
    emit: () => {},
  });
  const spoke = voiceSessionService.speak({ token: started.token, text: 'One. Two.' });
  assert.equal(spoke.queued, 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(spoken, ['One.', 'Two.'], 'each sentence was spoken separately');

  // 4. barge-in: talking while the agent speaks stops the playback
  let resolveSpeak;
  const interrupts = [];
  voiceSessionService._setDeps({
    speak: () => new Promise((resolve) => { resolveSpeak = resolve; }),
    emit: (method, payload) => { if (method === 'interrupted') interrupts.push(payload); },
  });
  voiceSessionService.speak({ token: started.token, text: 'A long sentence that never ends.' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(voiceSessionService.get(started.token).speaking, true, 'the agent is speaking');
  // the agent is speaking — now the user talks
  for (let i = 0; i < 30; i += 1) voiceSessionService.pushAudio({ token: started.token, pcmBase64: SILENCE });
  let barged = false;
  for (let i = 0; i < 5; i += 1) {
    const frameResult = voiceSessionService.pushAudio({ token: started.token, pcmBase64: SPEECH });
    barged = barged || frameResult.bargeIn;
  }
  assert.equal(interrupts.length, 1, 'the playback was cut off when the user started talking');
  assert.equal(barged, true, 'the frame is reported as a barge-in');
  assert.equal(voiceSessionService.get(started.token).speaking, false, 'the agent stopped talking');
  resolveSpeak?.({ ok: true });

  // 5. an explicit interrupt stops everything
  voiceSessionService.speak({ token: started.token, text: 'More.' });
  await new Promise((r) => setTimeout(r, 20));
  const interrupted = voiceSessionService.interrupt({ token: started.token });
  assert.equal(interrupted.ok, true);
  assert.equal(voiceSessionService.get(started.token).speaking, false);

  // 6. an unknown token is refused honestly
  assert.equal(voiceSessionService.pushAudio({ token: 'nope', pcmBase64: SILENCE }).ok, false);
  assert.equal(voiceSessionService.speak({ token: 'nope', text: 'x' }).ok, false);

  // 7. stopping removes the session
  voiceSessionService.stop({ token: started.token });
  assert.equal(voiceSessionService.get(started.token), null);

  // 8. the meeting keeps its transcript
  const meeting = meetingService.start({ title: 'Planning', sessionId: 'sess-1', participants: ['Ann', 'Bo'] });
  meetingService.appendTurn({ meetingId: meeting.id, speaker: 'Ann', text: 'We should ship on Friday.' });
  meetingService.appendTurn({ meetingId: meeting.id, speaker: 'Bo', text: 'I will write the release notes.' });
  const transcript = meetingService.transcript(meeting.id);
  assert.ok(transcript.includes('Ann: We should ship on Friday.'));
  assert.ok(transcript.includes('Bo: I will write the release notes.'));
  assert.equal(meetingService.list()[0].turns, 2);

  // 9. the analysis is stored
  meetingService.setAnalysis(meeting.id, {
    summary: 'They agreed to ship Friday.',
    decisions: ['Ship on Friday'],
    actions: [{ text: 'Write the release notes', owner: 'Bo', due: 'Thursday' }],
    questions: ['Who runs the smoke test?'],
  });
  const stored = meetingService.get(meeting.id);
  assert.equal(stored.analysis.summary, 'They agreed to ship Friday.');
  assert.equal(stored.analysis.actions[0].owner, 'Bo');
  assert.equal(stored.analysis.actions[0].due, 'Thursday');

  // 10. the model's answer is parsed, whatever shape it comes in
  const plain = meetingService.parseAnalysis('{"summary":"S","decisions":["D"],"actions":[{"text":"A","owner":"Ann"}],"questions":[]}');
  assert.equal(plain.summary, 'S');
  assert.equal(plain.actions[0].owner, 'Ann');
  const fenced = meetingService.parseAnalysis('Here you go:\n```json\n{"summary":"F","topics":["t"]}\n```');
  assert.equal(fenced.summary, 'F');
  assert.deepEqual(fenced.topics, ['t']);
  const prose = meetingService.parseAnalysis('They met and agreed on the plan.\n\nThe next step is the migration.');
  assert.ok(prose.summary.includes('They met'));
  assert.deepEqual(prose.decisions, []);

  // 11. invalid input is refused
  assert.throws(() => meetingService.appendTurn({ meetingId: 'nope', text: 'x' }), /unknown meeting/);
  assert.throws(() => meetingService.appendTurn({ meetingId: meeting.id, text: '   ' }), /no text/);
  assert.throws(() => meetingService.transcript('nope'), /unknown meeting/);

  voiceSessionService._resetDeps();
  console.log('voice test: ALL OK (vad/segment/transcribe/sentences/barge-in/interrupt/meeting/transcript/analysis parse)');
})().catch((e) => { console.error(e); process.exit(1); });
