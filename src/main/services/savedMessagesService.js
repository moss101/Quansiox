'use strict';
/**
 * Saved messages (parity plan P2.4 remainder) — the store behind the
 * Library surface. Grok's "saved messages" pin transcript messages into a
 * personal library; quansiox's is local-first and persisted.
 *
 * Semantics (deliberate):
 *   - one save per message id (re-saving updates the snapshot + bumpedAt);
 *   - a save captures the text at save time (the library shows what you
 *     saved even if the session is later rolled back);
 *   - newest saved first; remove by messageId; clear all is explicit.
 */
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const MAX_SAVED = 500;

function userDataDir() {
  return require('./userData').userDataDir();
}

function file() { return path.join(userDataDir(), 'saved-messages.json'); }

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.saved)) {
      return { version: VERSION, saved: parsed.saved };
    }
  } catch {}
  return { version: VERSION, saved: [] };
}

function writeAll(store) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/** Save (or refresh) one message. Returns the stored entry. */
function save({ sessionId, messageId, text, kind = 'user', author = null } = {}) {
  if (!messageId) throw new Error('messageId is required');
  if (typeof text !== 'string' || !text.trim()) throw new Error('cannot save an empty message');
  const store = readAll();
  const at = Date.now();
  const existing = store.saved.find((s) => s.messageId === messageId);
  if (existing) {
    existing.text = text.slice(0, 4000);
    existing.sessionId = sessionId ?? existing.sessionId;
    existing.kind = kind;
    existing.author = author;
    existing.bumpedAt = at;
  } else {
    if (store.saved.length >= MAX_SAVED) store.saved.splice(MAX_SAVED - 1);
    store.saved.unshift({
      messageId: String(messageId),
      sessionId: sessionId ? String(sessionId) : null,
      text: text.slice(0, 4000),
      kind: String(kind || 'user'),
      author: author ? String(author).slice(0, 120) : null,
      savedAt: at,
      bumpedAt: at,
    });
  }
  writeAll(store);
  return store.saved.find((s) => s.messageId === messageId);
}

/** Newest-saved first. */
function list() {
  return [...readAll().saved].sort((a, b) => (b.bumpedAt ?? 0) - (a.bumpedAt ?? 0));
}

function remove(messageId) {
  const store = readAll();
  const before = store.saved.length;
  store.saved = store.saved.filter((s) => s.messageId !== String(messageId ?? ''));
  writeAll(store);
  return { removed: before - store.saved.length };
}

function clear() {
  writeAll({ version: VERSION, saved: [] });
  return { cleared: true };
}

function isSaved(messageId) {
  return readAll().saved.some((s) => s.messageId === String(messageId ?? ''));
}

module.exports = { savedMessagesService: { save, list, remove, clear, isSaved, MAX_SAVED } };
