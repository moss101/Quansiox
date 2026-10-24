'use strict';
/**
 * Documents & attachments service — Grok Bot's document library + composer
 * attachment staging, local-first.
 *
 *  - **Library docs**: persistent markdown/text docs under userData/library/,
 *    with an 0600 JSON index and a `visibility` flag (private | shared) so the
 *    agent can save, read, list and share artifacts.
 *  - **Attachment staging**: short-lived, addressable blobs (bytes or a confined
 *    local path), resolvable to media info and committable into the library —
 *    the same primitive Grok uses for uploads/compose, kept in-process and
 *    TTL'd.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR) so the coordinator/tests use
 * the same store. Path staging is confined to the workspace root or userData.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const ATTACH_TTL_MS = 60 * 60 * 1000; // 1h, min
const MAX_BYTES = 25 * 1024 * 1024; // 25MB per attachment (Grok-sized)
const VISIBILITY = new Set(['private', 'shared']);

function userDataDir() {
  return require('./userData').userDataDir();
}
function libraryDir() { return path.join(userDataDir(), 'library'); }
function indexPath() { return path.join(libraryDir(), 'index.json'); }
function docPath(id) { return path.join(libraryDir(), `${id}.md`); }

// ---------------- library ----------------
function loadIndex() {
  try { return JSON.parse(fs.readFileSync(indexPath(), 'utf8')); } catch { return {}; }
}
function saveIndex(index) {
  fs.mkdirSync(libraryDir(), { recursive: true });
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2), { mode: 0o600 });
}
function newId() { return 'doc_' + crypto.randomBytes(9).toString('base64url'); }

function saveDocument(input = {}) {
  const index = loadIndex();
  const id = input.id && ID_RE.test(input.id) ? input.id : newId();
  const content = String(input.content ?? input.text ?? '');
  fs.mkdirSync(libraryDir(), { recursive: true });
  fs.writeFileSync(docPath(id), content, 'utf8');
  const now = Date.now();
  index[id] = {
    id, title: String(input.title ?? 'Untitled').slice(0, 160),
    visibility: VISIBILITY.has(input.visibility) ? input.visibility : (index[id]?.visibility || 'private'),
    bytes: Buffer.byteLength(content, 'utf8'),
    createdAt: index[id]?.createdAt ?? now, updatedAt: now,
  };
  saveIndex(index);
  return { ...index[id], path: docPath(id) };
}
function listLibraryDocs() {
  return Object.values(loadIndex()).sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, title, visibility, bytes, createdAt, updatedAt }) => ({ id, title, visibility, bytes, createdAt, updatedAt }));
}
function getDocument(id) {
  if (!ID_RE.test(id || '')) throw new Error('invalid document id');
  const index = loadIndex();
  if (!index[id]) throw new Error('unknown document');
  let content = '';
  try { content = fs.readFileSync(docPath(id), 'utf8'); } catch { content = ''; }
  return { ...index[id], content };
}
function setDocumentVisibility(id, visibility) {
  if (!ID_RE.test(id || '')) throw new Error('invalid document id');
  if (!VISIBILITY.has(visibility)) throw new Error('visibility must be private|shared');
  const index = loadIndex();
  if (!index[id]) throw new Error('unknown document');
  index[id] = { ...index[id], visibility, updatedAt: Date.now() };
  saveIndex(index);
  return index[id];
}
function removeDocument(id) {
  if (!ID_RE.test(id || '')) throw new Error('invalid document id');
  const index = loadIndex();
  if (!index[id]) throw new Error('unknown document');
  delete index[id];
  saveIndex(index);
  try { fs.rmSync(docPath(id), { force: true }); } catch { /* already gone */ }
  return { id, removed: true };
}

function getDocumentAssets(id) { // reserved: no per-doc binary assets locally yet
  if (!ID_RE.test(id || '')) throw new Error('invalid document id');
  return { id, assets: [] };
}
function resolveLibraryPages() {
  return Object.values(loadIndex()).filter((d) => d.visibility === 'shared').map((d) => ({ id: d.id, title: d.title, visibility: d.visibility }));
}

// ---------------- attachment staging ----------------
/** @type {Map<string, {kind:'bytes'|'path', name, mime, size, path?, data?:Buffer, createdAt}>} */
const staged = new Map();
function newToken() { return 'att_' + crypto.randomBytes(12).toString('base64url'); }
function guessMime(name, fallback) {
  if (fallback) return fallback;
  const ext = path.extname(String(name || '')).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.csv': 'text/csv', '.html': 'text/html', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
}
function pruneStaged(now = Date.now()) {
  for (const [token, entry] of staged) if (now - entry.createdAt > ATTACH_TTL_MS) staged.delete(token);
}
function workspaceRoots() {
  const roots = [userDataDir()];
  try { const { settingsService } = require('./settingsService'); const r = settingsService.load().workspaceRoot; if (r) roots.push(r); } catch {}
  return roots.map((r) => path.resolve(r));
}
function confine(p) {
  const abs = path.resolve(String(p ?? ''));
  return workspaceRoots().some((root) => abs === root || abs.startsWith(root + path.sep));
}
const reduced = (e, token) => ({ id: token, name: e.name, mime: e.mime, size: e.size, kind: e.kind });

function stageAttachmentBytes(input = {}) {
  pruneStaged();
  const name = String(input.name || 'attachment');
  const b64 = input.contentBase64 ?? input.content ?? input.base64;
  let data;
  if (Buffer.isBuffer(b64)) data = b64;
  else if (typeof b64 === 'string') data = Buffer.from(b64, 'base64');
  else if (input.text != null) data = Buffer.from(String(input.text), 'utf8');
  else throw new Error('attachment bytes required (contentBase64 | text)');
  if (data.length > MAX_BYTES) throw new Error(`attachment too large (${data.length} > ${MAX_BYTES})`);
  const token = newToken();
  staged.set(token, { kind: 'bytes', name, mime: guessMime(name, input.mime), size: data.length, data, createdAt: Date.now() });
  return reduced(staged.get(token), token);
}
function stageAttachmentPath(input = {}) {
  pruneStaged();
  const p = String(input.path ?? '');
  if (!confine(p)) throw new Error('attachment path is outside the workspace/userData');
  let stat;
  try { stat = fs.statSync(p); } catch { throw new Error('attachment path does not exist'); }
  const filePath = path.resolve(p);
  if (!stat.isFile()) throw new Error('attachment path is not a file');
  if (stat.size > MAX_BYTES) throw new Error(`attachment too large (${stat.size} > ${MAX_BYTES})`);
  const token = newToken();
  const name = path.basename(filePath);
  staged.set(token, { kind: 'path', name, mime: guessMime(name, input.mime), size: stat.size, path: filePath, createdAt: Date.now() });
  return reduced(staged.get(token), token);
}
function readAttachmentText(token) {
  pruneStaged();
  const e = staged.get(String(token || ''));
  if (!e) throw new Error('unknown or expired attachment');
  const data = e.kind === 'bytes' ? e.data : fs.readFileSync(e.path);
  return data.length > 400_000 ? data.slice(0, 400_000).toString('utf8') : data.toString('utf8');
}
function readAttachmentBytes(token) {
  pruneStaged();
  const e = staged.get(String(token || ''));
  if (!e) throw new Error('unknown or expired attachment');
  const data = e.kind === 'bytes' ? e.data : fs.readFileSync(e.path);
  if (data.length > MAX_BYTES) throw new Error('attachment too large');
  return { name: e.name, mime: e.mime, size: data.length, contentBase64: data.toString('base64') };
}
function resolveAttachmentMedia(token) {
  pruneStaged();
  const e = staged.get(String(token || ''));
  if (!e) throw new Error('unknown or expired attachment');
  const kind = e.mime.startsWith('image/') ? 'image' : (e.mime.startsWith('text/') || /json|csv|xml/.test(e.mime) ? 'text' : 'file');
  return { id: token, name: e.name, mime: e.mime, size: e.size, kind };
}
function discardStagedAttachment(token) { return { discarded: staged.delete(String(token || '')) }; }
function commitStagedAttachments(input = {}) {
  pruneStaged();
  const tokens = (Array.isArray(input.ids) ? input.ids : [input.id]).filter(Boolean);
  const docs = [];
  for (const token of tokens) {
    const e = staged.get(String(token));
    if (!e) throw new Error(`unknown or expired attachment: ${token}`);
    const data = e.kind === 'bytes' ? e.data : fs.readFileSync(e.path);
    const isText = /text\/|json|csv|xml|markdown/.test(e.mime);
    const doc = isText
      ? saveDocument({ title: e.name, content: data.toString('utf8'), visibility: input.visibility || 'private' })
      : (() => { // store binary attachments beside the library with their mime
          const id = 'doc_' + crypto.randomBytes(9).toString('base64url');
          fs.mkdirSync(libraryDir(), { recursive: true });
          fs.writeFileSync(path.join(libraryDir(), `${id}`), data);
          const index = loadIndex();
          const now = Date.now();
          index[id] = { id, title: e.name, visibility: input.visibility || 'private', bytes: data.length, createdAt: now, updatedAt: now, mime: e.mime };
          saveIndex(index);
          return index[id];
        })();
    docs.push({ ...doc, attachmentId: token });
    staged.delete(String(token));
  }
  return { committed: docs.length, docs };
}

module.exports = {
  documentsService: {
    saveDocument, getDocument, listLibraryDocs, setDocumentVisibility, removeDocument, getDocumentAssets, resolveLibraryPages,
    stageAttachmentBytes, stageAttachmentPath, readAttachmentText, readAttachmentBytes,
    resolveAttachmentMedia, discardStagedAttachment, commitStagedAttachments,
  },
  ATTACH_TTL_MS, MAX_BYTES,
};
