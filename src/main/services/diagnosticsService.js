'use strict';
/**
 * Diagnostics service — a real local diagnostics store.
 *
 * Several desktop methods are reporting/telemetry-shaped (reportProcessCrash,
 * reportLocalExecSupervisorFailed, reportTransportStage, …). In a local-first
 * app the honest implementation is a durable, inspectable local event log —
 * not a network call and not a silent no-op. Events are appended as JSONL to
 * userData/diagnostics/events.jsonl (0600) with a size cap and rotation.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR) so the coordinator and
 * daemons can record events too.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024; // rotate at 2 MB
const KEEP = 3; // keep events.jsonl + .1 + .2

function userDataDir() {
  return require('./userData').userDataDir();
}

function dir() { return path.join(userDataDir(), 'diagnostics'); }
function file() { return path.join(dir(), 'events.jsonl'); }

function rotateIfNeeded() {
  try {
    const st = fs.statSync(file());
    if (st.size < MAX_BYTES) return;
  } catch { return; }
  for (let i = KEEP - 1; i >= 1; i--) {
    const src = `${file()}.${i}`;
    const dst = `${file()}.${i + 1}`;
    try { fs.renameSync(src, dst); } catch {}
  }
  try { fs.renameSync(file(), `${file()}.1`); } catch {}
}

/** Append one structured event. Returns the stored record. */
function record(kind, detail = {}, source = 'main') {
  const entry = {
    at: new Date().toISOString(),
    ms: Date.now(),
    source: String(source ?? 'main'),
    kind: String(kind ?? 'event'),
    detail: detail && typeof detail === 'object' ? sanitize(detail) : { value: detail },
  };
  try {
    fs.mkdirSync(dir(), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(file(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    try { fs.chmodSync(file(), 0o600); } catch {}
  } catch { /* diagnostics must never break the caller */ }
  return entry;
}

function sanitize(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) out[k] = sanitize(v, depth + 1);
    return out;
  }
  return String(value);
}

/** Recent events, newest first. */
function list({ limit = 200, kind, sinceMs } = {}) {
  let raw = '';
  try { raw = fs.readFileSync(file(), 'utf8'); } catch { return []; }
  const out = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (kind && entry.kind !== kind) continue;
    if (sinceMs && entry.ms < sinceMs) continue;
    out.push(entry);
  }
  return out;
}

function clear() {
  for (let i = 0; i <= KEEP; i++) {
    try { fs.rmSync(i === 0 ? file() : `${file()}.${i}`, { force: true }); } catch {}
  }
  return true;
}

/** Aggregate counts by kind (dashboard-friendly). */
function summary() {
  const events = list({ limit: 5000 });
  const byKind = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return { total: events.length, byKind, file: file() };
}

module.exports = { diagnosticsService: { record, list, clear, summary, file } };
