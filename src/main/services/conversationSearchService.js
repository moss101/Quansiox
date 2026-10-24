'use strict';
/**
 * Conversation search — an index over the transcripts, with an honest
 * "rebuilding" state.
 *
 * The reference implementation's conversation search returns
 * `{hits, truncated, partial, rebuilding}`. The `rebuilding` flag is the
 * interesting part: a search over a live corpus is never complete, and
 * telling the caller that the index is mid-rebuild is the difference
 * between "here are the results" and "here are the results so far".
 *
 * The index is rebuilt in the background when it is stale, and a search
 * during a rebuild says so rather than pretending to be complete.
 *
 * Electron-free.
 */
const fs = require('node:fs');
const path = require('node:path');

/** How long an index stays fresh. */
const STALE_MS = 60 * 1000;
/** The most hits one search returns. */
const MAX_HITS = 200;

let index = { builtAt: 0, entries: [], building: false, generation: 0 };
let rebuildPromise = null;

function userDataDir() {
  return require('./userData').userDataDir();
}

function sessionsDir() {
  return path.join(userDataDir(), 'sessions');
}

/** The text of a turn, flattened. */
function turnText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return String(part.text ?? '');
      return '';
    }).join(' ');
  }
  return '';
}

/** Build the index from the session store. */
function build() {
  const entries = [];
  // The session store keeps recent turns in a write-ahead log and only
  // folds them into the snapshot file later, so the index has to read
  // through the store — reading the files directly would miss the newest
  // turns.
  let sessions = [];
  try {
    const { sessionService } = require('./sessionService');
    sessions = sessionService.list() ?? [];
  } catch {
    sessions = [];
  }
  for (const session of sessions) {
    const id = session.id;
    let turns = [];
    try {
      const { sessionService } = require('./sessionService');
      turns = sessionService.get(id)?.turns ?? [];
    } catch { continue; }
    if (!Array.isArray(turns)) continue;
    turns.forEach((turn, index) => {
      const text = turnText(turn.content);
      if (!text) return;
      entries.push({
        sessionId: id,
        turnIndex: index,
        messageId: turn.id ?? null,
        role: turn.role ?? 'user',
        at: turn.at ?? session.updatedAt ?? 0,
        text: text.slice(0, 4000),
        lower: text.toLowerCase(),
      });
    });
  }
  index = {
    builtAt: Date.now(),
    entries,
    building: false,
    generation: index.generation + 1,
  };
  return index;
}

/**
 * The index, rebuilt if it is stale.
 * @returns {{ entries: Array, building: boolean, generation: number }}
 */
function ensureIndex({ force = false } = {}) {
  // The FIRST index has to be built synchronously: a search that runs against
  // an empty index would report "nothing found" when it should report
  // "everything".
  if (!index.builtAt) return build();
  const stale = Date.now() - index.builtAt > STALE_MS;
  if (force || stale) {
    if (!rebuildPromise) {
      index.building = true;
      rebuildPromise = Promise.resolve()
        .then(() => build())
        .finally(() => { rebuildPromise = null; });
    }
  }
  return index;
}

/**
 * Search the conversations.
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.sessionId]  restrict to one conversation
 * @param {number} [opts.limit]
 * @returns {{ hits: Array, truncated: boolean, partial: boolean, rebuilding: boolean }}
 */
function search({ query, sessionId, limit = 50 } = {}) {
  const state = ensureIndex();
  const needle = String(query ?? '').trim().toLowerCase();
  const cap = Math.max(1, Math.min(Number(limit) || 50, MAX_HITS));
  if (!needle) {
    return { hits: [], truncated: false, partial: state.building, rebuilding: state.building };
  }
  const hits = [];
  let truncated = false;
  for (const entry of state.entries) {
    if (sessionId && entry.sessionId !== String(sessionId)) continue;
    const at = entry.lower.indexOf(needle);
    if (at < 0) continue;
    if (hits.length >= cap) { truncated = true; break; }
    const start = Math.max(0, at - 80);
    hits.push({
      sessionId: entry.sessionId,
      turnIndex: entry.turnIndex,
      messageId: entry.messageId,
      role: entry.role,
      at: entry.at,
      preview: `${start > 0 ? '…' : ''}${entry.text.slice(start, start + 240)}`,
    });
  }
  return {
    hits,
    truncated,
    // The index may be mid-rebuild, so the result set may be incomplete.
    partial: state.building,
    rebuilding: state.building,
  };
}

/** The index state, for the UI. */
function status() {
  return {
    entries: index.entries.length,
    builtAt: index.builtAt,
    building: index.building,
    generation: index.generation,
  };
}

/** Force a rebuild. */
function rebuild() {
  index.building = true;
  rebuildPromise = Promise.resolve()
    .then(() => build())
    .finally(() => { rebuildPromise = null; });
  return rebuildPromise;
}

module.exports = {
  MAX_HITS,
  STALE_MS,
  build,
  ensureIndex,
  rebuild,
  search,
  status,
};
