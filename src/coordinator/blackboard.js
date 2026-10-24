'use strict';
/**
 * Subagent blackboard — a per-run shared scratchpad so parallel siblings can
 * publish findings and read each other's, instead of each rediscovering the
 * same facts or waiting on a serial hand-off. One board per root run session.
 *
 * Values are JSON-normalized and length-capped so a runaway child cannot blow
 * up the parent context. Boards are optional-persistence: when a directory is
 * given they are written to `<dir>/blackboard.json` (0600), otherwise they are
 * memory-only (tests, headless runs).
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_KEYS = 200;
const MAX_ENTRIES = 200; // per append-key history
const MAX_VALUE_CHARS = 4000;
const MAX_DEPTH = 6;

function normalizeValue(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[too deep]';
  if (value == null) return value;
  const type = typeof value;
  if (type === 'string') return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…[truncated]` : value;
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return String(value);
  if (type === 'function' || type === 'symbol') return undefined;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => normalizeValue(item, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const normalized = normalizeValue(v, depth + 1);
    if (normalized !== undefined) out[String(k).slice(0, 120)] = normalized;
  }
  return out;
}

class Blackboard {
  /**
   * @param {{ sessionId?: string, dir?: string, clock?: Function }} [opts]
   */
  constructor(opts = {}) {
    this.sessionId = String(opts.sessionId ?? 'run');
    this.dir = opts.dir ? String(opts.dir) : null;
    this.clock = opts.clock ?? (() => Date.now());
    this.entries = new Map(); // key -> { key, mode, value, rev, author, at, history? }
    this.events = []; // append-only audit trail (capped)
    this._writeTimer = null;
    if (this.dir) this.load();
  }

  _file() { return path.join(this.dir, 'blackboard.json'); }

  /** Read a persisted board if one exists (never throws). */
  load() {
    if (!this.dir) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this._file(), 'utf8'));
      for (const entry of raw?.entries ?? []) {
        if (entry && entry.key) this.entries.set(String(entry.key), entry);
      }
      this.events = Array.isArray(raw?.events) ? raw.events.slice(-MAX_ENTRIES) : [];
    } catch { /* first run */ }
    return this;
  }

  _persist() {
    if (!this.dir) return;
    if (this._writeTimer) return;
    // Defer so a burst of writes does one atomic file write.
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const payload = JSON.stringify({ sessionId: this.sessionId, entries: [...this.entries.values()], events: this.events.slice(-MAX_ENTRIES) }, null, 2);
        const tmp = `${this._file()}.tmp`;
        fs.writeFileSync(tmp, payload, { mode: 0o600 });
        fs.renameSync(tmp, this._file());
      } catch { /* best effort: the board is a coordination aid, not durable state */ }
    }, 50);
    if (this._writeTimer.unref) this._writeTimer.unref();
  }

  _record(action, key, author) {
    this.events.push({ action, key, author: String(author ?? 'unknown'), at: this.clock() });
    if (this.events.length > MAX_ENTRIES) this.events = this.events.slice(-MAX_ENTRIES);
  }

  get(key) {
    const entry = this.entries.get(String(key));
    if (!entry) return null;
    return {
      key: entry.key, mode: entry.mode, value: entry.value, rev: entry.rev, author: entry.author, at: entry.at,
      ...(entry.mode === 'append' ? { history: entry.history, count: entry.count ?? entry.history?.length ?? 0 } : {}),
    };
  }

  /**
   * Write a value.
   *
   * The writer may pass the `rev` it read. If the board has moved on since
   * then the write is REFUSED with a conflict, and the loser is told what the
   * current value is — a silent last-writer-wins loses a sibling's work
   * without either of them knowing.
   *
   * Passing no `rev` keeps the old behaviour (overwrite), which is what a
   * single writer wants.
   */
  set(key, value, author = 'unknown', { rev } = {}) {
    const k = String(key ?? '').trim();
    if (!k) throw new Error('board key is required');
    if (k.length > 120) throw new Error('board key too long (max 120)');
    if (!this.entries.has(k) && this.entries.size >= MAX_KEYS) throw new Error(`board is full (max ${MAX_KEYS} keys)`);
    const prev = this.entries.get(k);
    if (rev != null && Number(rev) !== (prev?.rev ?? 0)) {
      const conflict = {
        key: k,
        conflict: true,
        reason: 'the value changed since you read it',
        yourRev: Number(rev),
        currentRev: prev?.rev ?? 0,
        current: this.get(k),
      };
      this._record('conflict', k, author);
      return conflict;
    }
    const entry = {
      key: k,
      mode: 'set',
      value: normalizeValue(value),
      rev: (prev?.rev ?? 0) + 1,
      author: String(author ?? 'unknown'),
      at: this.clock(),
    };
    this.entries.set(k, entry);
    this._record('set', k, author);
    this._persist();
    return this.get(k);
  }

  /**
   * Append to a key. Appends never conflict: two siblings appending to the
   * same key both keep their entry.
   */
  append(key, value, author = 'unknown') {
    const k = String(key ?? '').trim();
    if (!k) throw new Error('board key is required');
    const prev = this.entries.get(k);
    const history = Array.isArray(prev?.mode === 'append' ? prev.history : null) ? prev.history.slice() : (prev ? [prev.value] : []);
    history.push(normalizeValue(value));
    const trimmed = history.slice(-MAX_ENTRIES);
    const entry = {
      key: k,
      mode: 'append',
      value: trimmed[trimmed.length - 1],
      history: trimmed,
      count: trimmed.length,
      rev: (prev?.rev ?? 0) + 1,
      author: String(author ?? 'unknown'),
      at: this.clock(),
    };
    this.entries.set(k, entry);
    this._record('append', k, author);
    this._persist();
    return this.get(k);
  }

  delete(key, author = 'unknown') {
    const k = String(key);
    const existed = this.entries.delete(k);
    if (existed) { this._record('delete', k, author); this._persist(); }
    return existed;
  }

  list() {
    return [...this.entries.values()].map((entry) => ({
      key: entry.key,
      mode: entry.mode,
      rev: entry.rev,
      author: entry.author,
      at: entry.at,
      ...(entry.mode === 'append' ? { count: entry.count ?? entry.history?.length ?? 0 } : {}),
      preview: typeof entry.value === 'string' ? entry.value.slice(0, 160) : JSON.stringify(entry.value ?? null).slice(0, 160),
    }));
  }

  snapshot() {
    return { sessionId: this.sessionId, entries: [...this.entries.values()], events: this.events.slice(-MAX_ENTRIES) };
  }

  clear() {
    this.entries.clear();
    this.events = [];
    this._persist();
  }

  /**
   * Compact text digest for a child's system prompt: what siblings have already
   * published, so a new agent starts with shared context.
   */
  digest({ limit = 12, maxChars = 1200 } = {}) {
    const rows = this.list().slice(-limit);
    if (!rows.length) return '';
    const lines = rows.map((row) => {
      const body = row.mode === 'append' ? `(${row.count} entries) ${row.preview}` : row.preview;
      return `- ${row.key} [${row.author}]: ${body}`;
    });
    let text = `Shared blackboard (use board_read/board_list to see full values):\n${lines.join('\n')}`;
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
    return text;
  }
}

// One board per scope, created lazily. The scope is the run session, the
// team, or anything else the caller names — a board belongs to the group
// that shares it, not to one conversation.
const boards = new Map();

/**
 * The board for a scope.
 *
 * The scope is the key: a team gets one board that outlives any of its
 * conversations. `dir` is where it is persisted (0600); without it the board
 * is memory-only (tests, headless runs).
 */
function getBoard(sessionId, { dir } = {}) {
  const id = String(sessionId ?? 'run');
  let board = boards.get(id);
  if (!board) {
    board = new Blackboard({ sessionId: id, dir });
    boards.set(id, board);
  }
  return board;
}

/** The board for a team, persisted under the team's own directory. */
function getTeamBoard(teamId, { root } = {}) {
  const id = `team:${String(teamId)}`;
  let board = boards.get(id);
  if (!board) {
    board = new Blackboard({ sessionId: id, dir: root ? path.join(root, `team-${id}`) : null });
    boards.set(id, board);
  }
  return board;
}

function resetBoard(sessionId) {
  const id = String(sessionId ?? 'run');
  const board = boards.get(id);
  if (board) boards.delete(id);
  return board ?? null;
}

/** The scope of every live board — for the UI's "shared state" view. */
function listScopes() {
  return [...boards.keys()].sort();
}

module.exports = {
  Blackboard, getBoard, getTeamBoard, listScopes, resetBoard, normalizeValue,
  MAX_KEYS, MAX_VALUE_CHARS,
};
