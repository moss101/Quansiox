'use strict';
/**
 * Transcript service — structured, paginated access to session transcripts
 * (Grok 0.71's getAgentTranscript / page / window / thread / todos + rollback).
 *
 * Real semantics:
 *  - Every turn gets a stable address (`t<index>`) and a preview.
 *  - Pages are real slices; windows are addressable by index range.
 *  - The thread groups each user turn with the assistant/tool turns it caused.
 *  - Todos come from the live `update_plan` tool calls in the transcript.
 *  - Rollback truncates the transcript (and drops a compaction that no longer
 *    applies) — the on-disk session is the source of truth.
 */
const { sessionService } = require('./sessionService');

const MAX_PAGE = 200;

function loadTurns(sessionId) {
  const session = sessionService.get(sessionId);
  return { session, turns: Array.isArray(session.turns) ? session.turns : [] };
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === 'text' ? part.text : part?.type === 'image_url' ? '[image]' : `[${part?.type ?? 'part'}]`))
      .join(' ');
  }
  return String(content);
}

function previewOf(text, n = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** Normalize one stored turn into an addressable transcript entry. */
function entry(turn, index) {
  const out = {
    id: `t${index}`,
    index,
    role: turn.role,
    at: turn.at ?? null,
    preview: previewOf(textOf(turn.content)),
  };
  if (turn.role === 'assistant' && Array.isArray(turn.tool_calls) && turn.tool_calls.length) {
    out.toolCalls = turn.tool_calls.map((call) => ({
      id: call.id ?? null,
      name: call.function?.name ?? call.name ?? 'tool',
      arguments: call.function?.arguments ?? call.arguments ?? '',
    }));
    out.preview = out.preview || `→ ${out.toolCalls.map((c) => c.name).join(', ')}`;
  }
  if (turn.role === 'tool') {
    out.name = turn.name ?? null;
    out.toolCallId = turn.tool_call_id ?? null;
  }
  if (turn.images?.length) out.images = turn.images.length;
  if (typeof turn.content === 'string' || Array.isArray(turn.content)) out.content = turn.content;
  return out;
}

function all(sessionId) {
  const { session, turns } = loadTurns(sessionId);
  return { session, entries: turns.map(entry) };
}

function info(sessionId) {
  const { session, entries } = all(sessionId);
  return {
    sessionId: session.id,
    title: session.title ?? session.id,
    updatedAt: session.updatedAt ?? null,
    total: entries.length,
    usage: session.usage ?? null,
    compaction: session.compaction ? { cutoff: session.compaction.cutoff } : null,
  };
}

/** Real paging: page 0 = the OLDEST page (transcripts read forward). */
function page(sessionId, { page = 0, pageSize = 40 } = {}) {
  const { entries } = all(sessionId);
  const size = Math.min(Math.max(Number(pageSize) || 40, 1), MAX_PAGE);
  const totalPages = Math.max(1, Math.ceil(entries.length / size));
  const p = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const start = p * size;
  return {
    sessionId,
    page: p,
    pageSize: size,
    total: entries.length,
    totalPages,
    hasMore: p < totalPages - 1,
    turns: entries.slice(start, start + size),
  };
}

/** Window by absolute turn-index range [start, end) — newest-first friendly. */
function window_(sessionId, { start, end, limit = 50, newestFirst = false } = {}) {
  const { entries } = all(sessionId);
  let s = start == null ? (newestFirst ? Math.max(0, entries.length - (Number(limit) || 50)) : 0) : Math.max(0, Number(start));
  let e = end == null ? (newestFirst ? entries.length : Math.min(entries.length, s + (Number(limit) || 50))) : Math.min(entries.length, Number(end));
  if (e < s) [s, e] = [e, s];
  const slice = entries.slice(s, e);
  return { sessionId, start: s, end: e, total: entries.length, turns: newestFirst ? slice.reverse() : slice };
}

/** Tail convenience (Grok getAgentTranscriptTail). */
function tail(sessionId, { limit = 20 } = {}) {
  const { entries } = all(sessionId);
  const n = Math.min(Math.max(Number(limit) || 20, 1), MAX_PAGE);
  return { sessionId, total: entries.length, turns: entries.slice(-n) };
}

/** Group into a thread: each user turn + the assistant/tool turns it caused. */
function thread(sessionId) {
  const { session, entries } = all(sessionId);
  const groups = [];
  let current = null;
  for (const t of entries) {
    if (t.role === 'user') {
      current = { user: t, replies: [] };
      groups.push(current);
    } else if (current) {
      current.replies.push(t);
    } else {
      groups.push({ user: null, replies: [t] });
    }
  }
  return { sessionId, title: session.title ?? sessionId, groups, total: entries.length };
}

/** Live plan from `update_plan` tool calls (latest call wins). */
function todos(sessionId) {
  const { turns } = loadTurns(sessionId);
  let latest = null;
  let updatedAt = null;
  let updateCount = 0;
  turns.forEach((turn, i) => {
    if (turn.role !== 'assistant' || !Array.isArray(turn.tool_calls)) return;
    for (const call of turn.tool_calls) {
      const name = call?.function?.name ?? call?.name;
      if (name !== 'update_plan') continue;
      let args;
      try { args = JSON.parse(call.function?.arguments ?? call.arguments ?? '{}'); } catch { continue; }
      const steps = Array.isArray(args?.steps) ? args.steps : [];
      latest = steps.slice(0, 20).map((s, idx) => ({
        index: idx,
        title: String(s?.title ?? '').slice(0, 120),
        status: ['pending', 'in_progress', 'done'].includes(s?.status) ? s.status : 'pending',
      }));
      updatedAt = turn.at ?? null;
      updateCount += 1;
      void i;
    }
  });
  const counts = { pending: 0, in_progress: 0, done: 0 };
  for (const s of latest ?? []) counts[s.status] += 1;
  return { sessionId, steps: latest ?? [], counts, updatedAt, updateCount };
}

/**
 * Roll back the conversation: truncate at an address (t<index>), turn index,
 * or the last user turn. Returns what was removed. Real disk mutation.
 */
function rollback(sessionId, { toMessageId, toTurnIndex, lastUser = false } = {}) {
  const session = sessionService.get(sessionId);
  const turns = Array.isArray(session.turns) ? session.turns : [];
  let cut = null;
  if (toMessageId != null) {
    const m = /^t(\d+)$/.exec(String(toMessageId));
    if (!m) throw new Error('invalid message id');
    cut = Number(m[1]); // keep turns [0, cut)
  } else if (toTurnIndex != null) {
    cut = Number(toTurnIndex);
  } else if (lastUser) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'user') { cut = i; break; }
    }
    if (cut === null) cut = 0;
  } else {
    throw new Error('provide toMessageId, toTurnIndex or lastUser');
  }
  if (!Number.isInteger(cut) || cut < 0) throw new Error('invalid rollback target');
  cut = Math.min(cut, turns.length);
  const removed = turns.length - cut;
  session.turns = turns.slice(0, cut);
  if (session.compaction && Number(session.compaction.cutoff) > cut) delete session.compaction;
  // A rewind makes every cursor into the old transcript invalid: the rows
  // after the cut are gone and the numbering restarts. Bump the epoch.
  const generation = (session.transcriptGeneration ?? 1) + 1;
  session.transcriptGeneration = generation;
  session.transcriptNextSeq = cut;
  session.transcriptUpdatedSeq = session.transcriptUpdatedSeq ?? 0;
  sessionService.save(session);
  return { sessionId, removed, total: session.turns.length, cut, generation };
}

module.exports = {
  transcriptService: { info, all, page, window: window_, tail, thread, todos, rollback },
};
