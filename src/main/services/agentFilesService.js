'use strict';
/**
 * Agent-files service — real per-agent uploaded files (Grok Bot agent "files"
 * parity). Files are stored on disk under `userData/agent-files/<agentId>/`
 * with an index; uploads come in as bytes over IPC, deletes are real, and the
 * same files are mirrored into the agent's workspace folder when one exists so
 * the model can read them like any workspace document.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_AGENT = 100;

function userDataDir() {
  return require('./userData').userDataDir();
}
function safeId(id) { return String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120); }
function agentDir(agentId) { return path.join(userDataDir(), 'agent-files', safeId(agentId)); }
function indexPath(agentId) { return path.join(agentDir(agentId), 'index.json'); }
function safeName(name) {
  const base = path.basename(String(name ?? '')).replace(/[^A-Za-z0-9._ -]/g, '_').trim();
  if (!base || base === '.' || base === '..') throw new Error('invalid file name');
  return base.slice(0, 200);
}

/** Coerce rpcUint8Array-ish payloads (Buffer/ArrayBuffer/typed array/array/object) to a Buffer. */
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Array.isArray(bytes)) return Buffer.from(bytes);
  if (bytes && typeof bytes === 'object') {
    const values = Object.keys(bytes).filter((k) => /^\d+$/.test(k)).sort((a, b) => a - b).map((k) => bytes[k]);
    if (values.length) return Buffer.from(values);
  }
  if (typeof bytes === 'string') return Buffer.from(bytes, 'base64');
  throw new Error('bytes must be a Uint8Array');
}

function loadIndex(agentId) {
  try { return JSON.parse(fs.readFileSync(indexPath(agentId), 'utf8')); } catch { return { files: [] }; }
}
function saveIndex(agentId, index) {
  fs.mkdirSync(agentDir(agentId), { recursive: true });
  fs.writeFileSync(indexPath(agentId), JSON.stringify(index, null, 2), { mode: 0o600 });
}

function listGrokBotAgentFiles({ agentId } = {}) {
  const id = safeId(agentId);
  if (!id) throw new Error('agentId is required');
  const index = loadIndex(id);
  return {
    agentId: id,
    files: index.files.map((f) => {
      let size = f.size;
      try { size = fs.statSync(path.join(agentDir(id), f.storedName)).size; } catch {}
      return { name: f.name, contentType: f.contentType, size, updatedAt: f.updatedAt, sha256: f.sha256 };
    }),
  };
}

function uploadGrokBotAgentFile({ agentId, fileName, contentType, bytes } = {}) {
  const id = safeId(agentId);
  if (!id) throw new Error('agentId is required');
  const name = safeName(fileName);
  const buf = toBuffer(bytes);
  if (!buf.length) throw new Error('file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new Error(`file too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
  const dir = agentDir(id);
  const index = loadIndex(id);
  if (index.files.length >= MAX_FILES_PER_AGENT && !index.files.some((f) => f.name === name)) throw new Error('too many files for this agent');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const storedName = `${sha256.slice(0, 16)}-${name}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, storedName), buf, { mode: 0o600 });
  const previous = index.files.find((f) => f.name === name);
  if (previous && previous.storedName !== storedName) {
    try { fs.rmSync(path.join(dir, previous.storedName), { force: true }); } catch {}
  }
  index.files = index.files.filter((f) => f.name !== name);
  index.files.push({ name, storedName, contentType: String(contentType || 'application/octet-stream').slice(0, 120), size: buf.length, sha256, updatedAt: Date.now() });
  saveIndex(id, index);
  mirrorToWorkspace(id, name, buf);
  return { agentId: id, name, size: buf.length, sha256, updated: true };
}

/** Best-effort: mirror uploaded files into the agent's existing sandbox workspace. */
function mirrorToWorkspace(agentId, name, buf) {
  try {
    const { sandboxService } = require('./sandboxService');
    const root = sandboxService.sandboxRoot(agentId);
    if (!fs.existsSync(root)) return;
    const target = path.join(root, 'agent-files');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, name), buf);
  } catch {}
}

function deleteGrokBotAgentFile({ agentId, name } = {}) {
  const id = safeId(agentId);
  if (!id) throw new Error('agentId is required');
  const index = loadIndex(id);
  const rec = index.files.find((f) => f.name === name);
  if (!rec) return { deleted: false, agentId: id, name: name ?? null };
  index.files = index.files.filter((f) => f !== rec);
  saveIndex(id, index);
  try { fs.rmSync(path.join(agentDir(id), rec.storedName), { force: true }); } catch {}
  return { deleted: true, agentId: id, name: rec.name };
}

module.exports = { agentFilesService: { listGrokBotAgentFiles, uploadGrokBotAgentFile, deleteGrokBotAgentFile, toBuffer } };
