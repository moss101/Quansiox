'use strict';
/**
 * Attachment service — Grok 0.71 path/chunk attachment API, local-first.
 *
 * Real semantics:
 *  - uploadAttachment / uploadAttachmentChunk → chunked ingest with strict
 *    offset verification, fsync at completion, content-addressed storage.
 *  - preuploadStagedAttachment / releaseStagedAttachmentPreupload → the
 *    composer's staged file is ingested (sha256-addressed copy) before send.
 *  - readAttachmentChunk / readAttachmentImage / readAttachmentText → byte
 *    range reads and image renditions for the transcript renderer, with real
 *    image dimension probing and (in Electron) nativeImage preview downscale.
 *  - precaptionStagedAttachment → provider vision caption when an LLM provider
 *    is configured; honest `available:false` otherwise.
 *  - downloadAttachment → real HTTP(S) download into the content store.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { settingsService } = require('./settingsService');

const MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json', 'text/csv': 'csv' };

function userDataDir() {
  return require('./userData').userDataDir();
}
function root() { return path.join(userDataDir(), 'attachments'); }
function objectsDir() { return path.join(root(), 'objects'); }
function uploadsDir() { return path.join(root(), 'uploads'); }
function preuploadIndexPath() { return path.join(root(), 'preuploads.json'); }

function loadPreuploads() {
  try { return JSON.parse(fs.readFileSync(preuploadIndexPath(), 'utf8')); } catch { return {}; }
}
function savePreuploads(index) {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(preuploadIndexPath(), JSON.stringify(index, null, 2), { mode: 0o600 });
}

function guessMime(name) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return IMAGE_MIME[ext] || ({ pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html', js: 'text/javascript', ts: 'text/plain', py: 'text/plain', sh: 'text/plain' })[ext] || 'application/octet-stream';
}
function mediaKind(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || /json|csv|xml|javascript/.test(mime)) return 'text';
  return 'file';
}

function confine(p) {
  const abs = path.resolve(String(p ?? ''));
  const roots = [userDataDir()];
  try { const r = settingsService.load().workspaceRoot; if (r) roots.push(r); } catch {}
  return roots.map((x) => path.resolve(x)).some((r) => abs === r || abs.startsWith(r + path.sep));
}
/** Paths the user explicitly staged/ingested are allowed even outside workspace. */
function allowedPath(p) {
  if (confine(p)) return true;
  const abs = path.resolve(String(p ?? ''));
  const pre = loadPreuploads();
  if (pre[abs]) return true;
  for (const rec of Object.values(pre)) if (rec.path === abs) return true;
  return false;
}
function assertAllowed(p) {
  if (!allowedPath(p)) throw new Error('attachment path is outside the workspace/userData (stage it first)');
}

/** Content-addressed store: objects/<ab>/<sha256><ext>. */
function storeBuffer(data, name) {
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const mime = guessMime(name);
  const ext = MIME_EXT[mime] || path.extname(String(name || '')).slice(1).toLowerCase() || 'bin';
  const dir = path.join(objectsDir(), sha256.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${sha256}.${ext}`);
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, data, { mode: 0o600 });
    const fd = fs.openSync(dest, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return { path: dest, sha256, size: data.length, mime, name: String(name || `${sha256.slice(0, 12)}.${ext}`) };
}

function describeStored(stored, extra = {}) {
  return { path: stored.path, name: stored.name, size: stored.size, mime: stored.mime, sha256: stored.sha256, mediaKind: mediaKind(stored.mime), ...extra };
}

// ---------------- image probing ----------------
function probeImageDimensions(buf) {
  try {
    if (buf.length >= 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && (buf.toString('ascii', 0, 3) === 'GIF')) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) { // JPEG
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
        }
        off += 2 + len;
      }
    }
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (fourcc === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (fourcc === 'VP8L') {
        const bits = buf.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
    }
  } catch {}
  return null;
}

/** Electron nativeImage preview downscale (real app); passthrough when headless. */
function previewRendition(absPath, buf, mime) {
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(absPath);
    if (img && !img.isEmpty()) {
      const size = img.getSize();
      const max = 1024;
      const scale = Math.max(size.width, size.height) > max ? max / Math.max(size.width, size.height) : 1;
      const out = scale < 1 ? img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'good' }) : img;
      const jpeg = out.toJPEG(82);
      if (jpeg?.length) return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, mime: 'image/jpeg', bytes: jpeg.length, resized: scale < 1, width: out.getSize().width, height: out.getSize().height };
    }
  } catch {}
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length, resized: false };
}

// ---------------- chunked uploads ----------------
function uploadStatePath(uploadId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(uploadId)) throw new Error('invalid uploadId');
  return path.join(uploadsDir(), `${uploadId}.json`);
}
function loadUpload(uploadId) {
  try { return JSON.parse(fs.readFileSync(uploadStatePath(uploadId), 'utf8')); } catch { return null; }
}
function saveUpload(state) {
  fs.mkdirSync(uploadsDir(), { recursive: true });
  fs.writeFileSync(uploadStatePath(state.uploadId), JSON.stringify(state), { mode: 0o600 });
}

function uploadAttachment({ agentId, filename, bytesBase64 } = {}) {
  const data = Buffer.from(String(bytesBase64 ?? ''), 'base64');
  if (!data.length) throw new Error('bytesBase64 is required');
  if (data.length > MAX_BYTES) throw new Error(`attachment too large (${data.length} > ${MAX_BYTES})`);
  const stored = storeBuffer(data, filename);
  return describeStored(stored, { uploadId: `up-${crypto.randomBytes(9).toString('base64url')}`, agentId: agentId ?? null, complete: true });
}

function uploadAttachmentChunk({ agentId, uploadId, filename, offset, totalSize, bytesBase64 } = {}) {
  const id = String(uploadId ?? '');
  if (!id) throw new Error('uploadId is required');
  const off = Number(offset);
  const total = Number(totalSize);
  if (!Number.isInteger(off) || off < 0) throw new Error('invalid offset');
  if (!Number.isInteger(total) || total <= 0 || total > MAX_BYTES) throw new Error('invalid totalSize');
  const chunk = Buffer.from(String(bytesBase64 ?? ''), 'base64');
  if (!chunk.length) throw new Error('empty chunk');

  let state = loadUpload(id);
  const partPath = path.join(uploadsDir(), `${id}.part`);
  if (off === 0) {
    fs.mkdirSync(uploadsDir(), { recursive: true });
    fs.writeFileSync(partPath, Buffer.alloc(0), { mode: 0o600 });
    state = { uploadId: id, filename: String(filename ?? 'attachment'), totalSize: total, received: 0, createdAt: Date.now() };
  }
  if (!state) throw new Error('unknown uploadId (send offset 0 first)');
  if (state.received !== off) throw new Error(`offset mismatch: have ${state.received}, got ${off}`);
  if (state.received + chunk.length > state.totalSize) throw new Error('chunk exceeds totalSize');

  const fd = fs.openSync(partPath, 'r+');
  try {
    fs.writeSync(fd, chunk, 0, chunk.length, state.received);
    state.received += chunk.length;
    if (state.received === state.totalSize) {
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      const data = fs.readFileSync(partPath);
      const stored = storeBuffer(data, state.filename);
      fs.rmSync(partPath, { force: true });
      fs.rmSync(uploadStatePath(id), { force: true });
      return describeStored(stored, { uploadId: id, agentId: agentId ?? null, complete: true });
    }
  } finally { try { fs.closeSync(fd); } catch {} }
  saveUpload(state);
  return { uploadId: id, filename: state.filename, received: state.received, totalSize: state.totalSize, complete: false };
}

// ---------------- staged preupload ----------------
function preuploadStagedAttachment({ agentId, sessionId, path: srcPath, filename } = {}) {
  const abs = path.resolve(String(srcPath ?? ''));
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('staged path is not a file');
  if (st.size > MAX_BYTES) throw new Error(`attachment too large (${st.size} > ${MAX_BYTES})`);
  const data = fs.readFileSync(abs);
  const stored = storeBuffer(data, filename || path.basename(abs));
  const pre = loadPreuploads();
  pre[abs] = { ...stored, path: stored.path, stagedPath: abs, agentId: agentId ?? null, sessionId: sessionId ?? null, at: Date.now() };
  savePreuploads(pre);
  return describeStored(stored, { stagedPath: abs, agentId: agentId ?? null, sessionId: sessionId ?? null, preuploaded: true });
}

function releaseStagedAttachmentPreupload({ path: srcPath } = {}) {
  const abs = path.resolve(String(srcPath ?? ''));
  const pre = loadPreuploads();
  const rec = pre[abs];
  if (!rec) return { released: false, stagedPath: abs };
  delete pre[abs];
  savePreuploads(pre);
  let removed = false;
  const stillReferenced = Object.values(pre).some((r) => r.path === rec.path);
  if (!stillReferenced) { try { fs.rmSync(rec.path, { force: true }); removed = true; } catch {} }
  return { released: true, stagedPath: abs, removed };
}

// ---------------- reads ----------------
function readAttachmentChunk({ path: p, offset = 0, length = 0 } = {}) {
  const abs = path.resolve(String(p ?? ''));
  assertAllowed(abs);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file');
  const off = Math.max(0, Math.min(Number(offset) || 0, st.size));
  const len = length > 0 ? Math.min(Number(length), st.size - off, MAX_BYTES) : st.size - off;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(abs, 'r');
  try { fs.readSync(fd, buf, 0, len, off); } finally { fs.closeSync(fd); }
  const mime = guessMime(abs);
  return { path: abs, offset: off, length: len, totalSize: st.size, eof: off + len >= st.size, bytesBase64: buf.toString('base64'), mime, mediaKind: mediaKind(mime) };
}

function readAttachmentImage({ path: p, rendition } = {}) {
  const abs = path.resolve(String(p ?? ''));
  assertAllowed(abs);
  const st = fs.statSync(abs);
  if (st.size > MAX_BYTES) throw new Error('image too large');
  const buf = fs.readFileSync(abs);
  const mime = guessMime(abs);
  if (!mime.startsWith('image/')) throw new Error('not an image');
  const dims = probeImageDimensions(buf);
  const base = { path: abs, mime, totalSize: st.size, rendition: rendition === 'preview' ? 'preview' : 'original', ...(dims ? { width: dims.width, height: dims.height } : {}) };
  if (rendition === 'preview') {
    const prev = previewRendition(abs, buf, mime);
    return { ...base, ...prev };
  }
  return { ...base, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length, resized: false };
}

function readAttachmentText({ path: p } = {}) {
  const abs = path.resolve(String(p ?? ''));
  assertAllowed(abs);
  const st = fs.statSync(abs);
  const data = fs.readFileSync(abs);
  return { path: abs, totalSize: st.size, text: data.slice(0, 400_000).toString('utf8'), truncated: st.size > 400_000 };
}

// ---------------- caption (provider vision) ----------------
async function precaptionStagedAttachment({ path: p, draftText, priorUserMessages } = {}) {
  const abs = path.resolve(String(p ?? ''));
  assertAllowed(abs);
  const settings = settingsService.load();
  if (!settings.apiKey || !settings.baseUrl) {
    return { caption: null, available: false, reason: 'no LLM provider configured' };
  }
  const buf = fs.readFileSync(abs);
  const mime = guessMime(abs);
  if (!mime.startsWith('image/')) return { caption: null, available: false, reason: 'not an image' };
  const ctx = [draftText, ...(Array.isArray(priorUserMessages) ? priorUserMessages.slice(-3) : [])].filter(Boolean).join('\n');
  const body = {
    model: settings.model,
    max_tokens: 120,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `${ctx ? `Draft context:\n${ctx}\n\n` : ''}Describe this image for an attachment chip in one short sentence.` },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
      ],
    }],
  };
  const res = await fetch(`${String(settings.baseUrl).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { caption: null, available: false, reason: `provider ${res.status}` };
  const json = await res.json();
  const caption = json?.choices?.[0]?.message?.content?.trim() || null;
  return { caption, available: true };
}

// ---------------- download ----------------
async function downloadAttachment({ url, filename } = {}) {
  const u = new URL(String(url ?? ''));
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs can be downloaded');
  const res = await fetch(u);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`attachment too large (${buf.length} > ${MAX_BYTES})`);
  const name = filename || decodeURIComponent(path.basename(u.pathname)) || 'download';
  return describeStored(storeBuffer(buf, name), { sourceUrl: u.href, complete: true });
}

module.exports = {
  attachmentService: {
    guessMime, mediaKind, probeImageDimensions, storeBuffer,
    uploadAttachment, uploadAttachmentChunk,
    preuploadStagedAttachment, releaseStagedAttachmentPreupload,
    readAttachmentChunk, readAttachmentImage, readAttachmentText,
    precaptionStagedAttachment, downloadAttachment,
    paths: { root, objectsDir, uploadsDir },
  },
};
