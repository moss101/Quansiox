'use strict';
/**
 * Session conveniences — a cluster of Grok coordinator features mapped to real
 * local behavior: conversation outlines, workspace media search, per-session
 * avatars, draft persistence, and conversation naming. Electron-free.
 *
 * Storage under userData:
 *   sessions/<id>.json   (existing transcripts)
 *   drafts/<id>.txt      (composer draft; 0600)
 *   avatars/<id>.bin     (avatar bytes; 0600)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MEDIA_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
};
const AVATAR_MAX = 512 * 1024; // 512KB
const MEDIA_LIMIT = 500; // cap files scanned/listed

function userDataDir() {
  return require('./userData').userDataDir();
}
function draftsDir() { return path.join(userDataDir(), 'drafts'); }
function avatarsDir() { return path.join(userDataDir(), 'avatars'); }
function id(sessionId) {
  const s = String(sessionId ?? '');
  if (!ID_RE.test(s)) throw new Error('invalid session id');
  return s;
}
const preview = (text, n = 90) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------- conversation outline ----------------
function outline(sessionId) {
  id(sessionId);
  const { sessionService } = require('./sessionService');
  let session;
  try { session = sessionService.get(sessionId); } catch { return { sessionId, outline: [] }; }
  const items = [];
  for (const turn of session.turns ?? []) {
    if (turn.__plan) { for (const step of turn.__plan) items.push({ kind: 'step', status: step.status, text: preview(step.title) }); continue; }
    if (turn.role === 'user') { items.push({ kind: 'user', text: preview(turn.content, 120) }); continue; }
    if (turn.role === 'assistant') {
      if (turn.tool_calls?.length) for (const call of turn.tool_calls) items.push({ kind: 'tool', name: call.function?.name, args: preview(call.function?.arguments, 120) });
      if (turn.content) items.push({ kind: 'assistant', text: preview(turn.content) });
      continue;
    }
    if (turn.role === 'tool') { items.push({ kind: 'result', name: turn.name, text: preview(turn.content, 100) }); continue; }
  }
  return { sessionId, title: session.title, outline: items.slice(0, 400) };
}

function seedConversationName(sessionId, message) {
  id(sessionId);
  const text = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('no message to name from');
  const title = preview(text, 48);
  const { sessionService } = require('./sessionService');
  try { sessionService.rename(sessionId, title); } catch { /* session may not exist */ }
  return { sessionId, title };
}

// ---------------- media search ----------------
function workspaceRoot() {
  try { const { settingsService } = require('./settingsService'); return settingsService.load().workspaceRoot || ''; } catch { return ''; }
}
function searchMedia(query, { kinds } = {}) {
  const root = workspaceRoot();
  if (!root || !fs.existsSync(root)) return { root: '', results: [] };
  const want = kinds ? new Set(kinds.map((k) => String(k).toLowerCase())) : null;
  const q = String(query ?? '').toLowerCase();
  const results = [];
  const stack = [root];
  let scanned = 0;
  while (stack.length && scanned < 5000 && results.length < MEDIA_LIMIT) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git' && !e.name.startsWith('.')) stack.push(p); continue; }
      const mime = MEDIA_EXT[path.extname(e.name).toLowerCase()];
      if (!mime) continue;
      scanned += 1;
      const kind = mime.split('/')[0];
      if (want && !want.has(kind)) continue;
      if (q && !e.name.toLowerCase().includes(q)) continue;
      let size = 0;
      try { size = fs.statSync(p).size; } catch {}
      results.push({ path: p, name: e.name, mime, kind, size });
    }
  }
  return { root, results };
}

// ---------------- avatars ----------------
function setAvatarBytes(sessionId, { contentBase64, mime } = {}) {
  id(sessionId);
  const data = Buffer.from(String(contentBase64 ?? ''), 'base64');
  if (!data.length) throw new Error('empty avatar');
  if (data.length > AVATAR_MAX) throw new Error('avatar too large');
  fs.mkdirSync(avatarsDir(), { recursive: true });
  fs.writeFileSync(path.join(avatarsDir(), `${sessionId}.bin`), data, { mode: 0o600 });
  fs.writeFileSync(path.join(avatarsDir(), `${sessionId}.meta.json`), JSON.stringify({ mime: String(mime || 'image/png'), bytes: data.length }), { mode: 0o600 });
  return { sessionId, bytes: data.length, mime: String(mime || 'image/png') };
}
function getAvatar(sessionId) {
  id(sessionId);
  const bin = path.join(avatarsDir(), `${sessionId}.bin`);
  const meta = path.join(avatarsDir(), `${sessionId}.meta.json`);
  if (!fs.existsSync(bin)) return null;
  let mime = 'image/png';
  try { mime = JSON.parse(fs.readFileSync(meta, 'utf8')).mime || mime; } catch {}
  return { sessionId, mime, contentBase64: fs.readFileSync(bin).toString('base64') };
}
/** Deterministic initials avatar as an inline SVG data URL (no image deps). */
function generateAgentImage(sessionId, { label } = {}) {
  id(sessionId);
  const seed = crypto.createHash('sha256').update(String(sessionId)).digest('hex');
  const hue = parseInt(seed.slice(0, 2), 16);
  const text = preview(label || sessionId, 2).toUpperCase() || 'Q';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="hsl(${hue} 55% 32%)"/><text x="32" y="42" font-family="system-ui" font-size="30" fill="#fff" text-anchor="middle">${text.replace(/[<>&]/g, '')}</text></svg>`;
  const contentBase64 = Buffer.from(svg, 'utf8').toString('base64');
  setAvatarBytes(sessionId, { contentBase64, mime: 'image/svg+xml' });
  return { sessionId, mime: 'image/svg+xml', dataUrl: `data:image/svg+xml;base64,${contentBase64}` };
}

// ---------------- drafts ----------------
function draftFile(sessionId) { return path.join(draftsDir(), `${sessionId}.txt`); }
function saveDraft(sessionId, text) {
  id(sessionId);
  if (fs.existsSync(path.join(draftsDir(), `${sessionId}.off`))) return { sessionId, length: 0, draftingDisabled: true, saved: false };
  fs.mkdirSync(draftsDir(), { recursive: true });
  fs.writeFileSync(draftFile(sessionId), String(text ?? ''));
  return { sessionId, length: String(text ?? '').length, saved: true };
}
function getDraft(sessionId) { id(sessionId); try { return { sessionId, text: fs.readFileSync(draftFile(sessionId), 'utf8') }; } catch { return { sessionId, text: '' }; } }
function discardDraft(sessionId) { id(sessionId); try { fs.unlinkSync(draftFile(sessionId)); } catch {} return { sessionId, discarded: true }; }
function setDraftingDisabled(sessionId, disabled) { id(sessionId); const f = path.join(draftsDir(), `${sessionId}.off`); if (disabled) { fs.mkdirSync(draftsDir(), { recursive: true }); fs.writeFileSync(f, ''); } else { try { fs.unlinkSync(f); } catch {} } return { sessionId, draftingDisabled: !!disabled }; }
function draftingDisabled(sessionId) { id(sessionId); return { sessionId, draftingDisabled: fs.existsSync(path.join(draftsDir(), `${sessionId}.off`)) }; }

// ---------------- agent-suggestion dismissals ----------------
// Grok's host keeps proactive agent suggestions server-side and tracks the
// dismissed ones per agent (`dismissAgentSuggestions`, reasons hidden|acted).
// Locally the dismissal ledger lives alongside the agent's other extras.
const SUGGESTION_REASONS = new Set(['hidden', 'acted']);

function suggestionsFile(agentId) { return path.join(draftsDir(), `${agentId}.suggestions.json`); }

function dismissSuggestions(agentId, suggestionIds, reason = 'hidden') {
  id(agentId);
  const ids = [...new Set((Array.isArray(suggestionIds) ? suggestionIds : [suggestionIds])
    .map((s) => String(s ?? '')).filter(Boolean))];
  if (!ids.length) throw new Error('dismissAgentSuggestions needs suggestionIds');
  if (!SUGGESTION_REASONS.has(reason)) throw new Error('reason must be hidden|acted');
  fs.mkdirSync(draftsDir(), { recursive: true });
  let ledger = {};
  try { ledger = JSON.parse(fs.readFileSync(suggestionsFile(agentId), 'utf8')); } catch { /* first dismissal */ }
  const at = Date.now();
  const dismissed = ledger.dismissed ?? (ledger.dismissed = {});
  for (const suggestionId of ids) dismissed[suggestionId] = { reason, at };
  fs.writeFileSync(suggestionsFile(agentId), JSON.stringify(ledger), { mode: 0o600 });
  return { agentId, dismissed: ids, reason, ledgerSize: Object.keys(dismissed).length };
}

function listDismissedSuggestions(agentId) {
  id(agentId);
  try {
    const ledger = JSON.parse(fs.readFileSync(suggestionsFile(agentId), 'utf8'));
    return { agentId, dismissed: Object.keys(ledger.dismissed ?? {}) };
  } catch { return { agentId, dismissed: [] }; }
}

module.exports = {
  sessionExtrasService: {
    outline, seedConversationName, searchMedia,
    setAvatarBytes, getAvatar, generateAgentImage,
    saveDraft, getDraft, discardDraft, setDraftingDisabled, draftingDisabled,
    dismissSuggestions, listDismissedSuggestions,
  },
};
