'use strict';
/**
 * Session service — persistent chat transcripts on disk
 * (userData/sessions/<id>.json), Manus storageHelper-style JSON stores.
 * Each session: { id, createdAt, updatedAt, title, turns: [...] }
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Storage layout:
 *   sessions/<id>.json       — compacted snapshot (full session object)
 *   sessions/<id>.wal.jsonl  — append-only turn log, replayed on top of it
 *
 * Appending a turn used to rewrite the entire transcript, which is O(n²) in
 * tokens over a long conversation. The WAL makes appends O(1); snapshots are
 * folded back in on any other mutation (react/rename/rollback/usage) or once
 * the log grows past `WAL_COMPACT_BYTES`.
 */
const WAL_COMPACT_BYTES = 512 * 1024;
const CACHE_MAX = 32;
const cache = new Map();

function userDataDir() {
  return require('./userData').userDataDir();
}

function dir() {
  return path.join(userDataDir(), 'sessions');
}
function fileFor(id) {
  // IDs are ours (uuid) — still, never trust them near path traversal.
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('invalid session id');
  return path.join(dir(), `${id}.json`);
}

function walFor(id) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('invalid session id');
  return path.join(dir(), `${id}.wal.jsonl`);
}

function statSignature(id) {
  const parts = [];
  for (const f of [fileFor(id), walFor(id)]) {
    try {
      const st = fs.statSync(f);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push('-');
    }
  }
  return parts.join('|');
}

function readWal(id) {
  const f = walFor(id);
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const op = JSON.parse(line);
      if (op && typeof op === 'object') out.push(op);
    } catch { /* torn tail from a crashed append: ignore */ }
  }
  return out;
}

function applyOps(session, ops) {
  for (const op of ops) {
    if (op.op === 'turn' && op.turn) {
      session.turns = Array.isArray(session.turns) ? session.turns : [];
      session.turns.push(op.turn);
      if (op.at) session.updatedAt = Math.max(session.updatedAt ?? 0, op.at);
      if (!session.title || session.title === 'New session') {
        if (op.turn.role === 'user' && op.turn.content) {
          session.title = String(op.turn.content).slice(0, 60);
        }
      }
    } else if (op.op === 'patch' && op.patch) {
      Object.assign(session, op.patch);
    } else if (op.op === 'usage') {
      if (!session.usage) session.usage = { promptTokens: 0, completionTokens: 0, requests: 0 };
      session.usage.promptTokens += op.usage?.prompt_tokens ?? 0;
      session.usage.completionTokens += op.usage?.completion_tokens ?? 0;
      session.usage.requests += 1;
      if (op.model) session.lastModel = op.model;
      session.updatedAt = Math.max(session.updatedAt ?? 0, op.at ?? 0);
    }
  }
  return session;
}

function remember(id, session, sig) {
  cache.delete(id);
  cache.set(id, { session, sig });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** Snapshot + WAL replay. This is the cheap read path used by append. */
function load(id) {
  const sig = statSignature(id);
  const hit = cache.get(id);
  if (hit && hit.sig === sig) return hit.session;
  const session = JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
  applyOps(session, readWal(id));
  remember(id, session, sig);
  return session;
}

function appendOp(id, op) {
  fs.mkdirSync(dir(), { recursive: true });
  const line = `${JSON.stringify(op)}\n`;
  fs.appendFileSync(walFor(id), line);
  return load(id);
}

function ensure(id) {
  fs.mkdirSync(dir(), { recursive: true });
  const f = fileFor(id);
  if (!fs.existsSync(f)) {
    fs.writeFileSync(
      f,
      JSON.stringify({
        id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        title: 'New session',
        turns: [],
        usage: { promptTokens: 0, completionTokens: 0, requests: 0 },
      }, null, 2)
    );
  }
  return load(id);
}

function persist(session) {
  fs.mkdirSync(dir(), { recursive: true });
  const f = fileFor(session.id);
  const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(session, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, f);
  // The snapshot now contains every applied op: drop the log.
  fs.rmSync(walFor(session.id), { force: true });
  cache.delete(session.id);
}

function walBytes(id) {
  try { return fs.statSync(walFor(id)).size; } catch { return 0; }
}

function save(session) {
  session.updatedAt = Date.now();
  persist(session);
}

function appendTurn(id, turn) {
  const { randomUUID } = require('node:crypto');
  const at = Date.now();
  // Make sure the snapshot exists before the first WAL line.
  ensure(id);
  const session = load(id);
  // Transcript epoch bookkeeping: every row gets a sequence number within
  // the current generation, and the session's "updated" counter advances so
  // a cursor can ask for "what changed since".
  const generation = session.transcriptGeneration ?? 1;
  const seq = (session.transcriptNextSeq ?? (session.turns?.length ?? 0)) + 1;
  const updatedSeq = (session.transcriptUpdatedSeq ?? 0) + 1;
  const entry = {
    ...turn,
    id: turn.id ?? `msg_${randomUUID()}`,
    at: turn.at ?? at,
    transcriptSeq: seq,
    transcriptUpdatedSeq: updatedSeq,
    transcriptGeneration: generation,
  };
  applyOps(session, [{ op: 'turn', turn: entry, at }]);
  session.updatedAt = at;
  session.transcriptNextSeq = seq;
  session.transcriptUpdatedSeq = updatedSeq;
  session.transcriptGeneration = generation;
  appendOp(id, { op: 'turn', turn: entry, at });
  remember(id, session, statSignature(id));
  // Bound replay cost; snapshots also make reads cheap after long sessions.
  if (walBytes(id) > WAL_COMPACT_BYTES) persist(session);
  return session;
}

/** Append several turns with one fsync-free write (tool-heavy agent steps). */
function appendTurns(id, turns) {
  if (!Array.isArray(turns) || turns.length === 0) return load(id);
  ensure(id);
  let session = null;
  for (const turn of turns) session = appendTurn(id, turn);
  return session;
}

/**
 * The transcript epoch model.
 *
 * A session's transcript is append-only, but "append-only" is not enough
 * when a parent and a child both write to it, or when the transcript is
 * rewound. The reference implementation solves this with two counters:
 *
 *   `generation`  — a hard epoch. When the transcript is reset, the
 *                   generation moves on and every cursor into the old
 *                   transcript is invalid.
 *   `seq`         — the row order within a generation. A cursor is
 *                   `(generation, afterUpdatedSeq)`, and a cursor whose
 *                   generation is behind the current one is TOO OLD: the
 *                   client must re-read the whole transcript rather than
 *                   silently miss rows.
 *
 * We keep the same shape. `appendTurn` assigns the next `seq` and advances
 * `updatedSeq`; a rewind advances the generation.
 */

/** The cursor into a transcript. */
function transcriptCursor(id) {
  const session = load(id);
  return {
    generation: session.transcriptGeneration ?? 1,
    afterUpdatedSeq: session.transcriptUpdatedSeq ?? 0,
    sessionId: String(id),
  };
}

/**
 * The transcript rows after a cursor.
 *
 * @param {string} id
 * @param {object} cursor  { generation, afterUpdatedSeq }
 * @returns {{ entries: Array, generation: number, cursorTooOld: boolean, nextCursor: object }}
 */
function transcriptSince(id, cursor = {}) {
  const session = load(id);
  const generation = session.transcriptGeneration ?? 1;
  const current = session.transcriptUpdatedSeq ?? 0;
  const wanted = Number(cursor.afterUpdatedSeq) || 0;
  const wantedGeneration = Number(cursor.generation) || generation;

  // A cursor from an older generation cannot be used: rows it would have
  // covered are gone, and rows after it are numbered differently.
  if (wantedGeneration < generation) {
    return {
      entries: [],
      generation,
      cursorTooOld: true,
      nextCursor: { generation, afterUpdatedSeq: current, sessionId: String(id) },
    };
  }
  const entries = (session.turns ?? [])
    .filter((t) => (t.transcriptSeq ?? 0) > wanted)
    .map((t) => ({
      seq: t.transcriptSeq ?? 0,
      updatedSeq: t.transcriptUpdatedSeq ?? 0,
      kind: t.kind ?? t.role ?? 'message',
      entryId: t.id ?? null,
      body: t,
    }));
  return {
    entries,
    generation,
    cursorTooOld: false,
    nextCursor: { generation, afterUpdatedSeq: current, sessionId: String(id) },
  };
}

/**
 * Advance the transcript's epoch — the transcript was reset, so every cursor
 * into it is now too old.
 */
function bumpTranscriptGeneration(id) {
  const session = load(id);
  session.transcriptGeneration = (session.transcriptGeneration ?? 1) + 1;
  session.transcriptUpdatedSeq = session.transcriptUpdatedSeq ?? 0;
  save(session);
  return { generation: session.transcriptGeneration, sessionId: String(id) };
}

function listLegacyShape(s) {
  return {
    id: s.id,
    title: s.title ?? s.id,
    updatedAt: s.updatedAt ?? 0,
    turnCount: (s.turns ?? []).length,
    pinned: s.pinned === true,
    hidden: s.hidden === true,
    muted: s.muted === true,
    notifyOnUpdates: s.notifyOnUpdates !== false,
    favorite: s.favorite === true,
    projectId: s.projectId ?? null,
    label: s.label ?? '',
    description: s.description ?? '',
    kind: s.kind ?? 'single',
    memberCount: Array.isArray(s.members) ? s.members.length : 0,
  };
}

function list() {
  fs.mkdirSync(dir(), { recursive: true });
  return fs
    .readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const id = f.slice(0, -'.json'.length);
        const s = load(id);
        return listLegacyShape(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function get(id) {
  const session = load(id);
  // Transcripts written before per-message ids existed get them lazily, so
  // replies/reactions/jump-to-message work across the whole history.
  let changed = false;
  const { randomUUID } = require('node:crypto');
  for (const turn of session.turns ?? []) {
    if (!turn.id) { turn.id = `msg_${randomUUID()}`; changed = true; }
  }
  if (changed) persist(session); // id backfill must not bump updatedAt
  return session;
}

/** Toggle one reaction on one message (docs: react for lightweight ack). */
const REACTION_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

function react(id, messageId, emoji) {
  if (!REACTION_EMOJI.includes(emoji)) throw new Error(`unsupported reaction: ${emoji}`);
  const session = load(id);
  const turn = (session.turns ?? []).find((t) => t.id === messageId);
  if (!turn) throw new Error('message not found');
  const reactions = Array.isArray(turn.reactions) ? turn.reactions : [];
  const index = reactions.indexOf(emoji);
  if (index === -1) reactions.push(emoji);
  else reactions.splice(index, 1);
  turn.reactions = reactions;
  save(session);
  return { messageId, reactions };
}

/** Flatten a turn's content (string or multimodal parts) to searchable text. */
function turnText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part?.type === 'text' ? part.text : `[${part?.type ?? 'part'}]`)).join(' ');
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/** Strip prose punctuation that often trails a pasted URL. */
function trimUrl(raw) {
  return raw.replace(/[.,;:!?)\]}'"]+$/, '');
}

/**
 * Cross-conversation link search (docs: the palette finds prior links too).
 * Extracts http(s) URLs from user/assistant text, deduped globally by URL
 * (newest mention wins) so a link shared across conversations appears once.
 */
function searchLinks(query, { limit = 20, maxSessions = 200, minChars = 2 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < minChars) return [];
  const sessions = list().slice(0, maxSessions);
  const seen = new Map();
  for (const entry of sessions) {
    if (seen.size >= limit * 3) break;
    let session;
    try { session = get(entry.id); } catch { continue; }
    for (const turn of session.turns ?? []) {
      if (turn.role !== 'user' && turn.role !== 'assistant') continue;
      const text = turnText(turn.content);
      if (!text) continue;
      URL_RE.lastIndex = 0;
      let m;
      while ((m = URL_RE.exec(text)) !== null) {
        const url = trimUrl(m[0]);
        if (!/^https?:\/\/\S+$/i.test(url)) continue;
        if (seen.has(url)) continue;
        seen.set(url, {
          url, sessionId: entry.id, title: session.title ?? entry.id,
          messageId: turn.id ?? null, at: turn.at ?? session.updatedAt ?? 0,
        });
      }
      if (seen.size >= limit * 3) break;
    }
  }
  return [...seen.values()]
    .filter((hit) => hit.url.toLowerCase().includes(q))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/**
 * Cross-conversation message search (docs: "Find prior messages... jump back
 * to the matching place in a conversation"). Case-insensitive substring over
 * titles + user/assistant text; newest sessions first; bounded scan. Returns
 * { sessionId, title, messageId, role, snippet, at, score }.
 */
function searchMessages(query, { limit = 30, maxSessions = 200, minChars = 2 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length < minChars) return [];
  const sessions = list().slice(0, maxSessions);
  const hits = [];
  for (const entry of sessions) {
    if (hits.length >= limit * 3) break;
    let session;
    try { session = get(entry.id); } catch { continue; }
    const title = session.title ?? entry.id;
    const titleHit = String(title).toLowerCase().includes(q);
    if (titleHit) {
      const last = [...(session.turns ?? [])].reverse().find((t) => t.role === 'assistant' || t.role === 'user');
      hits.push({
        sessionId: entry.id, title, messageId: last?.id ?? null,
        role: last?.role ?? 'session', snippet: `Conversation: ${title}`,
        at: session.updatedAt ?? 0, score: 2,
      });
    }
    for (const turn of session.turns ?? []) {
      if (turn.role !== 'user' && turn.role !== 'assistant') continue;
      const text = turnText(turn.content);
      if (!text) continue;
      const index = text.toLowerCase().indexOf(q);
      if (index === -1) continue;
      const start = Math.max(0, index - 60);
      const end = Math.min(text.length, index + q.length + 60);
      hits.push({
        sessionId: entry.id, title, messageId: turn.id ?? null,
        role: turn.role,
        snippet: `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`,
        at: turn.at ?? session.updatedAt ?? 0,
        score: 3 + (titleHit ? 1 : 0),
      });
      if (hits.length >= limit * 3) break;
    }
  }
  return hits
    .sort((a, b) => (b.score - a.score) || (b.at - a.at))
    .slice(0, limit);
}

function remove(id) {
  fs.rmSync(fileFor(id), { force: true });
  fs.rmSync(walFor(id), { force: true });
  cache.delete(id);
  return true;
}

/** Fold the WAL into the snapshot (maintenance/export path). */
function compact(id) {
  const session = load(id);
  persist(session);
  return session;
}

/** Page a transcript without materializing the whole session in the caller. */
function page(id, { offset = 0, limit = 50 } = {}) {
  const session = load(id);
  const turns = Array.isArray(session.turns) ? session.turns : [];
  const start = Math.max(0, Number(offset) || 0);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return {
    id: session.id,
    title: session.title ?? session.id,
    total: turns.length,
    offset: start,
    hasMore: start + n < turns.length,
    turns: turns.slice(start, start + n),
  };
}


/** Replies to a message, flattened newest-last (docs: threads). */
function thread(id, messageId) {
  const session = load(id);
  const turns = session.turns ?? [];
  const root = turns.find((t) => t.id === messageId);
  if (!root) throw new Error('message not found in this session');
  const ids = new Set([messageId]);
  const out = [{ ...root, threadRoot: true }];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (!turn.replyTo?.messageId || !ids.has(turn.replyTo.messageId)) continue;
    out.push({ ...turn });
    if (turn.id) ids.add(turn.id);
    // Attach the assistant answer that directly follows a reply turn.
    const next = turns[i + 1];
    if (turn.role === 'user' && next?.role === 'assistant' && !next.replyTo) {
      out.push({ ...next, threadReply: true });
      i += 1;
    }
  }
  return { rootId: messageId, turns: out, count: Math.max(0, out.length - 1) };
}

/** Direct reply counts keyed by parent message id (cheap transcript scan). */
function threadCounts(id) {
  const turns = load(id).turns ?? [];
  const counts = {};
  for (const turn of turns) {
    const parent = turn.replyTo?.messageId;
    if (!parent) continue;
    counts[parent] = (counts[parent] || 0) + 1;
  }
  return counts;
}

function rename(id, title) {
  const session = load(id);
  session.title = String(title).slice(0, 80) || 'Untitled';
  save(session);
  return session;
}

/**
 * Create a named Bot (Grok's Create New Bot dialog). A session is the bot's
 * identity here, so creating one up front (not on the first message) is what
 * makes it appear in the sidebar with its chosen name.
 */
function create({ id, title, label = '', description = '', projectId = null } = {}) {
  const { randomUUID } = require('node:crypto');
  const sid = id != null ? String(id) : randomUUID();
  ensure(sid);
  const result = update(sid, {
    title: String(title || 'New Bot').slice(0, 80) || 'New Bot',
    label: String(label || '').slice(0, 60),
    description: String(description || '').slice(0, 400),
  });
  if (projectId) assignProject(sid, projectId);
  return { ...result, ...(projectId ? { projectId } : {}) };
}

/**
 * Put a task inside a project (or take it out again).
 *
 * Joining a project freezes the project's *file* set for this task: a
 * knowledge-base file uploaded later must not change what this task can
 * already see (Manus: "File updates only take effect in new tasks created
 * after the update"). The project's *instruction* is deliberately NOT
 * frozen — it is read live on every turn, so an instruction edit applies to
 * the next message in this very task.
 */
function assignProject(id, projectId) {
  const session = load(id);
  const next = projectId ? String(projectId) : null;
  if (next && !/^[a-zA-Z0-9_-]{3,64}$/.test(next)) throw new Error('invalid project id');
  if (next) {
    const { projectService } = require('./projectService');
    if (!projectService.get(next)) throw new Error('project not found');
    session.projectId = next;
    session.projectConfigSnapshot = projectService.snapshotFor(next);
  } else {
    delete session.projectId;
    delete session.projectConfigSnapshot;
  }
  save(session);
  return { id, projectId: next ?? null };
}

/** Merge sidebar flags (title, pinned, hidden, muted) into a session. */
function update(id, patch = {}) {
  const session = load(id);
  if (patch.title !== undefined) {
    session.title = String(patch.title).slice(0, 80) || 'Untitled';
  }
  if (patch.pinned !== undefined) session.pinned = patch.pinned === true;
  if (patch.hidden !== undefined) session.hidden = patch.hidden === true;
  if (patch.muted !== undefined) session.muted = patch.muted === true;
  // Per-agent notify-on-updates (P3.10, Grok setAgentNotifyOnUpdates):
  // default true; false mutes OS notifications but not unread dots.
  if (patch.notifyOnUpdates !== undefined) session.notifyOnUpdates = patch.notifyOnUpdates !== false;
  if (patch.favorite !== undefined) session.favorite = patch.favorite === true;
  if (patch.label !== undefined) session.label = String(patch.label).slice(0, 60);
  if (patch.description !== undefined) session.description = String(patch.description).slice(0, 400);
  save(session);
  return {
    id: session.id,
    title: session.title,
    pinned: session.pinned === true,
    hidden: session.hidden === true,
    muted: session.muted === true,
    notifyOnUpdates: session.notifyOnUpdates !== false,
    favorite: session.favorite === true,
    projectId: session.projectId ?? null,
    label: session.label ?? '',
    description: session.description ?? '',
  };
}

/** Mark a session as a local multi-bot group (docs: group chats). */
function setGroup(id, { name, members }) {
  const session = load(id);
  if (!Array.isArray(members) || members.length < 2 || members.length > 6) {
    throw new Error('a group needs 2–6 bots');
  }
  session.kind = 'group';
  session.title = String(name || session.title || 'Group chat').slice(0, 80);
  session.members = members.map((m) => ({
    id: String(m.id),
    title: String(m.title || m.id).slice(0, 80),
    label: String(m.label || '').slice(0, 60),
  }));
  save(session);
  return { id: session.id, title: session.title, kind: session.kind, members: session.members };
}

/** Copy a session (transcript + usage) under a new id. */
function duplicate(id) {
  const { randomUUID } = require('node:crypto');
  const source = load(id);
  const newId = randomUUID();
  const copy = {
    ...source,
    id: newId,
    title: `${source.title ?? 'Session'} (copy)`.slice(0, 80),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: false,
    hidden: false,
    turns: source.turns ?? [],
  };
  // A duplicate is a NEW task, so it follows the project's current file set
  // (Manus: "Any new tasks started after the update will follow the new
  // project configuration").
  if (copy.projectId) {
    try {
      const { projectService } = require('./projectService');
      copy.projectConfigSnapshot = projectService.snapshotFor(copy.projectId);
    } catch { /* project gone — keep the inherited snapshot */ }
  }
  save(copy);
  return { id: copy.id, title: copy.title };
}

/**
 * Remove the last user turn (and everything after it) and return its text
 * content — used by agent.retry to re-run the last message.
 */
function popLastUserTurn(id) {
  const session = load(id);
  const turns = session.turns;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'user') {
      const [popped] = turns.splice(i);
      save(session);
      return popped.content;
    }
  }
  return null;
}

/** Render a session transcript to Markdown. */
function toMarkdown(id) {
  const s = load(id);
  const lines = [`# ${s.title ?? 'Session'}`, '', `_Exported ${new Date().toISOString()}_`, ''];
  for (const t of s.turns ?? []) {
    if (t.role === 'user') {
      const text = Array.isArray(t.content)
        ? t.content.map((p) => (p.type === 'text' ? p.text : `_[${p.type} attachment]_`)).join('\n')
        : t.content;
      lines.push('## 🧑 You', '', String(text), '');
    } else if (t.role === 'assistant' && t.tool_calls) {
      for (const call of t.tool_calls) {
        lines.push(`<details><summary>🔧 <code>${call.function.name}</code></summary>`, '',
          '```', String(call.function.arguments), '```', '');
      }
    } else if (t.role === 'tool') {
      lines.push('```', String(t.content).slice(0, 2000), '```', '');
    } else if (t.role === 'assistant' && t.content) {
      lines.push('## 🤖 Quansiox', '', String(t.content), '');
    }
  }
  return lines.join('\n');
}

/** Accumulate provider usage stats into the session (tracks model too). */
function addUsage(id, usage, model) {
  const session = load(id);
  if (!session.usage) {
    session.usage = { promptTokens: 0, completionTokens: 0, requests: 0 };
  }
  session.usage.promptTokens += usage.prompt_tokens ?? 0;
  session.usage.completionTokens += usage.completion_tokens ?? 0;
  session.usage.requests += 1;
  if (model) session.lastModel = model;
  save(session);
  return session.usage;
}

/** Store a compaction record (summary replacing turns[:cutoff]). */
function saveCompaction(id, compaction) {
  const session = load(id);
  session.compaction = compaction;
  save(session);
  return session;
}

module.exports = {
  sessionService: {
    ensure, get, list, remove, appendTurn, appendTurns, page, compact, rename, update,
    create, duplicate, setGroup, popLastUserTurn, toMarkdown, addUsage, saveCompaction,
    save, react, searchMessages, searchLinks, thread, threadCounts,
    transcriptCursor, transcriptSince, bumpTranscriptGeneration, assignProject,
  },
};
