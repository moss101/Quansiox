'use strict';
/**
 * Feedback service — real local product-feedback sink matching Grok's
 * submitFeedback / voteFeedback surface. Entries are appended as JSON lines
 * to `userData/feedback.jsonl` (0600) and are fully readable locally; nothing
 * leaves the machine in local-first mode.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRY_BYTES = 8 * 1024;

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'feedback.jsonl'); }

function append(kind, payload) {
  const entry = {
    id: `fb_${crypto.randomBytes(8).toString('base64url')}`,
    kind,
    createdAt: Date.now(),
    payload: sanitize(payload),
  };
  const line = JSON.stringify(entry);
  if (Buffer.byteLength(line) > MAX_ENTRY_BYTES) throw new Error('feedback entry too large');
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.appendFileSync(file(), line + '\n', { mode: 0o600 });
  return entry;
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') return value.slice(0, 4000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) out[String(k).slice(0, 120)] = sanitize(v, depth + 1);
    return out;
  }
  return String(value).slice(0, 400);
}

function list({ limit = 50 } = {}) {
  let text = '';
  try { text = fs.readFileSync(file(), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows.slice(-Math.max(1, Math.min(500, Number(limit) || 50)));
}

module.exports = { feedbackService: { append, list, file } };
