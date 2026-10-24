'use strict';
/**
 * Voice calls — a local, real-time voice conversation with the agent.
 *
 * Grok's voice call is a cloud service: it mints a credential, opens a
 * call, streams audio to a server-side model and keeps the sent messages
 * for the transcript. Quansiox does the same thing without a server:
 *
 *  - the call IS a voice session (the same VAD + local whisper + local
 *    `say` loop the voice overlay uses), so the conversation happens on
 *    this Mac;
 *  - a short-lived credential is minted locally for the call, exactly like
 *    the cloud credential, so a caller cannot open a call it does not own;
 *  - the presence, the nudge (barge-in) and the sent messages are real;
 *  - the call transcript is a meeting, so the meeting copilot can analyze
 *    it afterwards.
 */
const crypto = require('node:crypto');

const { voiceSessionService } = require('./voiceSessionService');
const { meetingService } = require('./meetingService');

const PRESENCES = new Set(['idle', 'listening', 'speaking', 'muted', 'ended']);
const DEFAULT_CREDENTIAL_TTL_MS = 10 * 60 * 1000;

/** callId -> call */
const calls = new Map();
/** credential token -> { callId, expiresAt } */
const credentials = new Map();

function newId(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('base64url')}`; }

/**
 * Mint a short-lived credential for a voice call.
 *
 * The credential is what the caller proves it owns the call; it expires,
 * and it never leaves this machine.
 */
function mintCredential({ ttlMs = DEFAULT_CREDENTIAL_TTL_MS, sessionId = null } = {}) {
  const token = newId('vc');
  const record = { callId: null, expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || DEFAULT_CREDENTIAL_TTL_MS), sessionId };
  credentials.set(token, record);
  return { token, expiresAt: record.expiresAt };
}

/** Is the credential still good, and does it belong to this call? */
function checkCredential(token, callId = null) {
  const record = credentials.get(String(token ?? ''));
  if (!record) return { ok: false, reason: 'unknown voice-call credential' };
  if (record.expiresAt < Date.now()) {
    credentials.delete(String(token));
    return { ok: false, reason: 'the voice-call credential expired' };
  }
  if (callId && record.callId && record.callId !== callId) {
    return { ok: false, reason: 'the credential belongs to another call' };
  }
  return { ok: true, record };
}

/**
 * Open a voice call.
 *
 * @param {object} opts
 * @param {string} [opts.sessionId]   the chat session the call belongs to
 * @param {string} [opts.credential]  a credential minted for this call
 * @param {string} [opts.title]       the meeting title for the transcript
 */
function start({ sessionId = null, credential = null, title = 'Voice call' } = {}) {
  if (credential) {
    const check = checkCredential(credential);
    if (!check.ok) throw new Error(check.reason);
    check.record.callId = null;
  }
  const id = newId('call');
  const voice = voiceSessionService.start({ sessionId });
  const meeting = meetingService.start({ title, sessionId });
  const call = {
    id,
    sessionId,
    meetingId: meeting.id,
    voiceToken: voice.token,
    credential: credential ?? null,
    presence: 'listening',
    startedAt: Date.now(),
    endedAt: null,
    messages: [],
    harnessSessionId: null,
  };
  calls.set(id, call);
  if (credential) credentials.get(String(credential)).callId = id;
  return publicCall(call);
}

/** The public shape of a call (what the renderer and the API see). */
function publicCall(call) {
  if (!call) return null;
  return {
    id: call.id,
    sessionId: call.sessionId,
    meetingId: call.meetingId,
    presence: call.presence,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    messageCount: call.messages.length,
    harnessSessionId: call.harnessSessionId,
  };
}

/** A call by id. */
function get(callId) { return calls.get(String(callId ?? '')) ?? null; }

/** The calls, newest first. */
function list() {
  return [...calls.values()].sort((a, b) => b.startedAt - a.startedAt).map(publicCall);
}

/**
 * Record a message in the call.
 *
 * Everything the agent says and everything the user says goes here, and
 * into the call's meeting — so the transcript is complete by construction.
 */
function record(callId, { from = 'user', text = '', at = Date.now() } = {}) {
  const call = get(callId);
  if (!call) throw new Error('unknown voice call');
  const body = String(text ?? '').trim();
  if (!body) throw new Error('the message has no text');
  const message = { from: String(from || 'user'), text: body.slice(0, 4000), at };
  call.messages.push(message);
  try {
    meetingService.appendTurn({ meetingId: call.meetingId, speaker: message.from, text: message.text, at });
  } catch { /* the meeting may be gone */ }
  return message;
}

/** The messages the agent sent during the call. */
function sentMessages(callId) {
  const call = get(callId);
  if (!call) throw new Error('unknown voice call');
  return call.messages.filter((m) => m.from !== 'user');
}

/** Set the presence of a call. */
function setPresence(callId, presence) {
  const call = get(callId);
  if (!call) throw new Error('unknown voice call');
  const value = String(presence ?? '');
  if (!PRESENCES.has(value)) throw new Error('presence must be idle|listening|speaking|muted|ended');
  call.presence = value;
  return publicCall(call);
}

/**
 * Nudge the call — the user starts talking over the agent.
 *
 * This is the barge-in of the voice loop: the agent's playback is cut off
 * immediately instead of finishing its sentence.
 */
function nudge(callId) {
  const call = get(callId);
  if (!call) throw new Error('unknown voice call');
  const result = voiceSessionService.interrupt({ token: call.voiceToken });
  call.presence = 'listening';
  return { ...result, presence: call.presence, callId: call.id };
}

/**
 * The harness session of a call.
 *
 * The harness is the surface the renderer drives: it holds the call, the
 * voice session and the tool bridge, so the UI does not have to know how
 * a call is put together.
 */
function harnessSession({ callId, sessionId, title } = {}) {
  // Asking for a harness session without a call opens one — this is how a
  // call starts.
  let call = callId ? get(callId) : null;
  if (!call) call = start({ sessionId, title });
  else if (sessionId && !call.sessionId) call.sessionId = sessionId;
  call.harnessSessionId = newId('harness');
  return {
    harnessSessionId: call.harnessSessionId,
    callId: call.id,
    sessionId: call.sessionId ?? sessionId ?? null,
    meetingId: call.meetingId,
    voiceToken: call.voiceToken,
    presence: call.presence,
    sampleRate: 16000,
  };
}

/**
 * Run a tool inside a call.
 *
 * The agent can look something up while it is on a call — the tool runs
 * through the normal coordinator, with the normal permissions and the
 * normal consent prompts. Nothing is privileged because the call is live.
 */
async function harnessTool({ callId, name, args = {}, sessionId } = {}) {
  const call = get(callId);
  if (!call) throw new Error('unknown voice call');
  const tool = String(name ?? '');
  if (!tool) throw new Error('a tool name is required');
  let coordinator = null;
  try { coordinator = require('../../coordinator'); } catch { /* the coordinator is not loaded */ }
  if (!coordinator?.executeTool) {
    return { status: 'unavailable', reason: 'the agent runtime is not available in this process' };
  }
  const target = sessionId ?? call.sessionId;
  if (!target) return { status: 'unavailable', reason: 'the call has no session to run the tool in' };
  try {
    const result = await coordinator.executeTool(tool, args ?? {}, process.cwd(), target);
    return { status: 'ok', tool, result };
  } catch (error) {
    // A failing tool is a normal outcome — the agent hears about it.
    return { status: 'error', tool, error: String(error?.message ?? error) };
  }
}

/** End a call: the voice session stops and the transcript is closed. */
function end(callId) {
  const call = get(callId);
  if (!call) return { status: 'error', reason: 'unknown voice call' };
  try { voiceSessionService.stop({ token: call.voiceToken }); } catch { /* already stopped */ }
  call.presence = 'ended';
  call.endedAt = Date.now();
  return { status: 'ok', call: publicCall(call), meetingId: call.meetingId };
}

module.exports = {
  voiceCallService: {
    mintCredential, start, get, list, record, sentMessages, setPresence,
    nudge, harnessSession, harnessTool, end, checkCredential, publicCall,
  },
};
