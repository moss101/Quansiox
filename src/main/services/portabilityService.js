'use strict';
/**
 * Portability (parity plan P4.3) — Quansiox's canonical open formats.
 *
 * Grok has partial export (bot share JSON); Quansiox makes the open format
 * canonical: every export is a versioned JSON manifest with a sha256 over
 * the canonical payload — tamper-evident, self-describing, importable.
 * Nothing leaves the machine: exports are strings (renderer saves them) or
 * files under userData/exports/.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMAT_SESSION = 'quansiox.session-share';
const FORMAT_LIBRARY = 'quansiox.library-export';
const VERSION = 1;

function userDataDir() {
  return require('./userData').userDataDir();
}

/** Canonical JSON: sorted keys, no insignificant whitespace — the bytes the
 * checksum is computed over are deterministic for the same payload. */
function canonical(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

function envelope(format, payload) {
  const body = canonical(payload);
  return {
    format,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    payload,
  };
}

/** Verify an envelope: format, version, checksum over the canonical payload. */
function verify(envelopeIn) {
  const e = envelopeIn && typeof envelopeIn === 'object' ? envelopeIn : null;
  if (!e || typeof e.format !== 'string') throw new Error('not a quansiox manifest');
  if (e.version !== VERSION) throw new Error(`unsupported manifest version ${e.version}`);
  const digest = crypto.createHash('sha256').update(canonical(e.payload)).digest('hex');
  if (digest !== e.sha256) throw new Error('checksum mismatch — the manifest was modified');
  return true;
}

/** The session share (Grok CreateBotShareJson analog, open format): the
 * bot's profile + transcript, secrets stripped (no API keys ever ride). */
function sessionShare(sessionService, sessionId) {
  const session = sessionService.get(sessionId);
  const { sessionService: _drop, ...payload } = session; // never a service ref
  return envelope(FORMAT_SESSION, {
    id: session.id,
    title: session.title,
    label: session.label ?? '',
    description: session.description ?? '',
    kind: session.kind ?? 'single',
    pinned: session.pinned === true,
    notifyOnUpdates: session.notifyOnUpdates !== false,
    turns: session.turns ?? [],
  });
}

/** The library export: saved messages + pins in one manifest. */
function libraryShare(savedMessagesService, libraryService) {
  return envelope(FORMAT_LIBRARY, {
    savedMessages: savedMessagesService.list(),
    pins: libraryService.list(),
  });
}

/** Import a verified session share as a NEW session (ids re-minted so a
 * share can be imported many times). Returns the new session id. */
function importSessionShare(sessionService, envelopeIn) {
  verify(envelopeIn);
  if (envelopeIn.format !== FORMAT_SESSION) throw new Error(`expected ${FORMAT_SESSION}`);
  const p = envelopeIn.payload;
  const { randomUUID } = crypto;
  const id = `share-${randomUUID().slice(0, 8)}`;
  sessionService.create({
    id,
    title: `${p.title ?? 'Imported bot'} (imported)`,
    label: p.label ?? '',
    description: p.description ?? '',
  });
  if (Array.isArray(p.turns) && p.turns.length) sessionService.appendTurns(id, p.turns);
  sessionService.update(id, { pinned: p.pinned === true, notifyOnUpdates: p.notifyOnUpdates !== false });
  return { id, turns: p.turns?.length ?? 0 };
}

/** Write an export to userData/exports/<name>.json; returns the path. */
function writeFile(name, envelopeIn) {
  const dir = path.join(userDataDir(), 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
  const file = path.join(dir, `${safe}.json`);
  fs.writeFileSync(file, `${JSON.stringify(envelopeIn, null, 2)}\n`, { mode: 0o600 });
  return file;
}

module.exports = {
  portabilityService: {
    FORMAT_SESSION, FORMAT_LIBRARY, VERSION,
    canonical, envelope, verify, sessionShare, libraryShare, importSessionShare, writeFile,
  },
};
