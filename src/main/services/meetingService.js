'use strict';
/**
 * Meeting copilot — a local record of what was said and what it means.
 *
 * A meeting is a transcript plus an analysis:
 *
 *  - the transcript is a list of turns (speaker, text, timestamp), which
 *    can come from the voice session, from a dictation, or from a file the
 *    user drops in;
 *  - the analysis is produced by the model the user already configured
 *    (nothing is sent anywhere else): a summary, the decisions, the action
 *    items with their owners, and the open questions;
 *  - everything stays on this Mac, in the user data directory.
 *
 * The analysis itself lives in the coordinator (it needs the model
 * settings); this service owns the storage.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function userDataDir() {
  return require('./userData').userDataDir();
}
function meetingsDir() { return path.join(userDataDir(), 'meetings'); }
function meetingsFile() { return path.join(meetingsDir(), 'meetings.json'); }

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(meetingsFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(entries) {
  fs.mkdirSync(meetingsDir(), { recursive: true });
  fs.writeFileSync(meetingsFile(), JSON.stringify(entries, null, 2), { mode: 0o700 });
}

const MAX_TURNS = 5000;
const MAX_TEXT = 4000;

/** Start a meeting. */
function start({ title, sessionId = null, participants = [] } = {}) {
  const entries = load();
  const meeting = {
    id: `mtg_${crypto.randomBytes(6).toString('base64url')}`,
    title: String(title || 'Untitled meeting').slice(0, 160),
    sessionId,
    participants: (Array.isArray(participants) ? participants : []).map(String).slice(0, 50),
    startedAt: Date.now(),
    endedAt: null,
    turns: [],
    analysis: null,
  };
  entries.push(meeting);
  save(entries);
  return meeting;
}

/** Append a turn to a meeting. */
function appendTurn({ meetingId, speaker = 'Speaker', text, at = Date.now() } = {}) {
  const entries = load();
  const meeting = entries.find((m) => m.id === meetingId);
  if (!meeting) throw new Error(`unknown meeting: ${meetingId}`);
  const body = String(text ?? '').trim();
  if (!body) throw new Error('the turn has no text');
  if (meeting.turns.length >= MAX_TURNS) throw new Error('the meeting has too many turns');
  const turn = {
    speaker: String(speaker || 'Speaker').slice(0, 80),
    text: body.slice(0, MAX_TEXT),
    at,
  };
  meeting.turns.push(turn);
  meeting.endedAt = Date.now();
  save(entries);
  return turn;
}

/** The meetings, newest first. */
function list() {
  return load()
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((m) => ({
      id: m.id,
      title: m.title,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      turns: m.turns.length,
      participants: m.participants,
      analyzed: Boolean(m.analysis),
    }));
}

/** A meeting with its transcript. */
function get(meetingId) {
  return load().find((m) => m.id === meetingId) ?? null;
}

/** The transcript as plain text (what the model sees). */
function transcript(meetingId) {
  const meeting = get(meetingId);
  if (!meeting) throw new Error(`unknown meeting: ${meetingId}`);
  return meeting.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
}

/** Store an analysis produced by the model. */
function setAnalysis(meetingId, analysis) {
  const entries = load();
  const meeting = entries.find((m) => m.id === meetingId);
  if (!meeting) throw new Error(`unknown meeting: ${meetingId}`);
  meeting.analysis = {
    summary: String(analysis?.summary ?? '').slice(0, 8000),
    decisions: normaliseList(analysis?.decisions),
    actions: normaliseList(analysis?.actions).map((a) => ({
      text: a.text,
      owner: a.owner ?? null,
      due: a.due ?? null,
    })),
    questions: normaliseList(analysis?.questions),
    topics: normaliseList(analysis?.topics),
    createdAt: Date.now(),
  };
  save(entries);
  return meeting.analysis;
}

function normaliseList(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => {
      if (typeof item === 'string') return { text: String(item).slice(0, 500) };
      if (item && typeof item === 'object') {
        return {
          text: String(item.text ?? item.action ?? item.title ?? '').slice(0, 500),
          owner: item.owner ? String(item.owner).slice(0, 80) : null,
          due: item.due ? String(item.due).slice(0, 80) : null,
        };
      }
      return { text: String(item).slice(0, 500) };
    })
    .filter((item) => item.text)
    .slice(0, 50);
}

/** Remove a meeting. */
function remove(meetingId) {
  const entries = load();
  const next = entries.filter((m) => m.id !== meetingId);
  if (next.length === entries.length) return { removed: false, id: meetingId };
  save(next);
  return { removed: true, id: meetingId };
}

/**
 * Parse the model's answer into the analysis shape.
 *
 * The model is asked for JSON, but a chatty model may wrap it in prose or
 * a code fence — so the JSON is dug out rather than assumed.
 */
function parseAnalysis(raw) {
  const text = String(raw ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* fall through to the text shape */ }
  }
  // A plain-text fallback: the first paragraph is the summary.
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return { summary: paragraphs[0] ?? body.slice(0, 2000), decisions: [], actions: [], questions: [], topics: [] };
}

module.exports = {
  meetingService: {
    start, appendTurn, list, get, transcript, setAnalysis, remove, parseAnalysis,
  },
};
