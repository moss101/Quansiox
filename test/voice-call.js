'use strict';
/* The local voice call — a real-time conversation with the agent.
 *
 *  - a credential is minted, and it expires
 *  - opening a call creates a voice session and a meeting
 *  - messages are recorded into the call and into the meeting
 *  - the sent messages are only the agent's
 *  - the presence can be set
 *  - a nudge interrupts the agent
 *  - the harness session describes the call
 *  - the harness tool refuses to run without a session
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-call-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { voiceCallService } = require('../src/main/services/voiceCallService');
const { meetingService } = require('../src/main/services/meetingService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  // 1. a credential is minted
  const credential = voiceCallService.mintCredential({ ttlMs: 60_000 });
  assert.ok(credential.token);
  assert.ok(credential.expiresAt > Date.now());
  assert.equal(voiceCallService.checkCredential(credential.token).ok, true);
  assert.equal(voiceCallService.checkCredential('nope').ok, false);

  // an expired credential is refused (the floor for a credential is a second)
  const expired = voiceCallService.mintCredential({ ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(voiceCallService.checkCredential(expired.token).ok, false);

  // 2. the call opens: a voice session and a meeting
  const call = voiceCallService.start({ sessionId: 'sess-1', credential: credential.token, title: 'Standup' });
  assert.ok(call.id);
  assert.equal(call.presence, 'listening');
  assert.ok(call.meetingId, 'the call has a meeting for its transcript');
  assert.equal(voiceCallService.get(call.id).voiceToken !== undefined, true);

  // 3. messages are recorded into the call and the meeting
  voiceCallService.record(call.id, { from: 'user', text: 'What is the status of the migration?' });
  voiceCallService.record(call.id, { from: 'assistant', text: 'The migration finished an hour ago.' });
  const sent = voiceCallService.sentMessages(call.id);
  assert.equal(sent.length, 1, 'only the agent messages are "sent"');
  assert.equal(sent[0].text, 'The migration finished an hour ago.');
  const transcript = meetingService.transcript(call.meetingId);
  assert.ok(transcript.includes('user: What is the status of the migration?'));
  assert.ok(transcript.includes('assistant: The migration finished an hour ago.'));

  // 4. the presence can be set
  assert.equal(voiceCallService.setPresence(call.id, 'speaking').presence, 'speaking');
  assert.throws(() => voiceCallService.setPresence(call.id, 'dancing'), /presence must be/);

  // 5. a nudge interrupts the agent
  const nudged = voiceCallService.nudge(call.id);
  assert.equal(nudged.ok, true);
  assert.equal(voiceCallService.get(call.id).presence, 'listening');

  // 6. the harness session
  const harness = voiceCallService.harnessSession({ callId: call.id });
  assert.ok(harness.harnessSessionId);
  assert.equal(harness.callId, call.id);
  assert.equal(harness.sampleRate, 16000);
  assert.equal(harness.meetingId, call.meetingId);

  // 7. the harness tool runs through the normal coordinator — a live call
  //    is not a privileged one
  const tool = await voiceCallService.harnessTool({ callId: call.id, name: 'read_file', args: { path: 'does-not-exist.txt' } });
  assert.equal(tool.status, 'error', 'the tool really ran (and failed)');
  assert.equal(tool.tool, 'read_file');
  assert.ok(tool.error, 'the failure is reported, not thrown');

  // a call without a session cannot run a tool
  const noSession = voiceCallService.start({ title: 'No session' });
  const refused = await voiceCallService.harnessTool({ callId: noSession.id, name: 'read_file', args: {} });
  assert.equal(refused.status, 'unavailable');
  assert.ok(refused.reason.includes('session'));
  await assert.rejects(() => voiceCallService.harnessTool({ callId: 'nope', name: 'x' }), /unknown voice call/);

  // 8. the Grok-compatible surface answers
  const viaApi = await grokCompatService.dispatch('mintVoiceCallCredential', { ttlMs: 60_000 });
  assert.equal(viaApi.status, 'ok');
  assert.ok(viaApi.token);

  // the harness session is how a call opens
  const harnessViaApi = await grokCompatService.dispatch('voiceCallHarnessSession', { sessionId: 'sess-2' });
  assert.equal(harnessViaApi.status, 'ok');
  assert.ok(harnessViaApi.harnessSessionId);
  const started = { call: { id: harnessViaApi.callId } };

  const got = await grokCompatService.dispatch('getVoiceCall', { callId: started.call.id });
  assert.equal(got.status, 'ok');
  assert.equal(got.call.id, started.call.id);

  const recorded = await grokCompatService.dispatch('recordVoiceCall', { callId: started.call.id, from: 'assistant', text: 'Hello there' });
  assert.equal(recorded.status, 'ok');
  const read = await grokCompatService.dispatch('readVoiceCallSentMessages', { callId: started.call.id });
  assert.equal(read.messages.length, 1);

  const presence = await grokCompatService.dispatch('setVoiceCallPresence', { callId: started.call.id, presence: 'listening' });
  assert.equal(presence.call.presence, 'listening');

  const nudgeViaApi = await grokCompatService.dispatch('nudgeVoiceCall', { callId: started.call.id });
  assert.equal(nudgeViaApi.status, 'ok');

  // 9. ending the call closes it
  assert.equal(voiceCallService.end(call.id).status, 'ok');
  assert.equal(voiceCallService.get(call.id).presence, 'ended');
  assert.equal(voiceCallService.end('nope').status, 'error');

  console.log('voice-call test: ALL OK (credential/expiry/call/meeting/record/sent/presence/nudge/harness/tool)');
})().catch((e) => { console.error(e); process.exit(1); });
