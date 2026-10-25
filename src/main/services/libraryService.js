'use strict';
/**
 * Library pins (parity plan P2.5) — Grok's library v2 types messages AND
 * content (media/page/document/sheet/deck) into one collection. Quansiox's
 * saved messages (P2.4) hold the message kind; this store holds the content
 * kinds. One pin per (kind, refId); a pin captures the title at pin time
 * (the library shows what you pinned even if the source is renamed later);
 * bounded; persisted; 0600.
 */
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const MAX_PINS = 500;

/** Grok's library v2 content kinds (extraction fact). */
const KINDS = new Set(['media', 'page', 'document', 'sheet', 'deck']);

function userDataDir() {
  return require('./userData').userDataDir();
}

function file() { return path.join(userDataDir(), 'library-pins.json'); }

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.pins)) {
      return { version: VERSION, pins: parsed.pins };
    }
  } catch {}
  return { version: VERSION, pins: [] };
}

function writeAll(store) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Pin content. `refId` names the source (artifact id, document id, …);
 * `title` is captured at pin time; `note` is optional.
 * @returns the stored pin.
 */
function pin({ kind, refId, title, note = '', sessionId = null, origin = null } = {}) {
  if (!KINDS.has(kind)) throw new Error(`unknown library kind: ${kind}`);
  if (!refId) throw new Error('refId is required');
  if (!String(title ?? '').trim()) throw new Error('a pin needs a title');
  const store = readAll();
  const at = Date.now();
  const existing = store.pins.find((p) => p.kind === kind && p.refId === String(refId));
  if (existing) {
    existing.note = String(note ?? '').slice(0, 500);
    existing.sessionId = sessionId ?? existing.sessionId;
    existing.bumpedAt = at;
  } else {
    if (store.pins.length >= MAX_PINS) store.pins.splice(MAX_PINS - 1);
    store.pins.unshift({
      id: `pin_${at}_${Math.random().toString(36).slice(2, 8)}`,
      kind: String(kind),
      refId: String(refId),
      title: String(title).trim().slice(0, 300),
      note: String(note ?? '').slice(0, 500),
      sessionId: sessionId ? String(sessionId) : null,
      origin: origin ? String(origin).slice(0, 120) : null,
      savedAt: at,
      bumpedAt: at,
    });
  }
  writeAll(store);
  return store.pins.find((p) => p.kind === kind && p.refId === String(refId));
}

/** Newest-pinned first. */
function list() {
  return [...readAll().pins].sort((a, b) => (b.bumpedAt ?? 0) - (a.bumpedAt ?? 0));
}

function unpin(kind, refId) {
  const store = readAll();
  const before = store.pins.length;
  store.pins = store.pins.filter((p) => !(p.kind === kind && p.refId === String(refId ?? '')));
  writeAll(store);
  return { removed: before - store.pins.length };
}

function isPinned(kind, refId) {
  return readAll().pins.some((p) => p.kind === kind && p.refId === String(refId ?? ''));
}

function clear() {
  writeAll({ version: VERSION, pins: [] });
  return { cleared: true };
}

module.exports = { libraryService: { pin, list, unpin, isPinned, clear, KINDS, MAX_PINS } };
