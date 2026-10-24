'use strict';
/**
 * File service — workspace tree listing + fs.watch live updates
 * (Manus localFileService pattern: validated watching, bounded results).
 * Emits file:onChange (scoped) so the renderer's explorer refreshes itself.
 */
const fs = require('node:fs');
const path = require('node:path');
const { emitScopedEvent } = require('../ipc/emitEvent');
const { settingsService } = require('./settingsService');

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store', 'dist', '.next', 'build']);
const MAX_ENTRIES = 2000;
let watcher = null;
let watcherRoot = null;

function listTree(root, rel = '', depth = 0, out = []) {
  if (out.length >= MAX_ENTRIES || depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  entries
    .filter((e) => !IGNORED.has(e.name))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    .forEach((e) => {
      if (out.length >= MAX_ENTRIES) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      let size = 0;
      try {
        size = e.isDirectory() ? 0 : fs.statSync(path.join(root, childRel)).size;
      } catch {}
      out.push({ path: childRel, dir: e.isDirectory(), size });
      if (e.isDirectory() && !e.isSymbolicLink()) {
        listTree(root, childRel, depth + 1, out);
      }
    });
  return out;
}

function resolveInRoot(rel) {
  const root = settingsService.load().workspaceRoot || process.cwd();
  const p = path.resolve(root, rel || '.');
  if (!p.startsWith(path.resolve(root))) throw new Error('path escapes workspace');
  return p;
}

function read(rel) {
  const p = resolveInRoot(rel);
  const stat = fs.statSync(p);
  if (stat.size > 500_000) throw new Error(`file too large (${stat.size} bytes)`);
  return fs.readFileSync(p, 'utf8');
}

// Rich file viewer (GPA G7): bounded in-band media for image/PDF preview.
const MEDIA_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
function readMedia(rel) {
  const p = resolveInRoot(rel);
  const stat = fs.statSync(p);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > MAX_MEDIA_BYTES) throw new Error(`media too large (${stat.size} bytes, max ${MAX_MEDIA_BYTES})`);
  const mime = MEDIA_MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
  return { path: rel, mime, size: stat.size, base64: fs.readFileSync(p).toString('base64') };
}

/** Write a workspace file (used by the in-app editor). */
function write(rel, content) {
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (content.length > 2_000_000) throw new Error('content too large');
  const p = resolveInRoot(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return { bytes: Buffer.byteLength(content), path: rel };
}

function watch(sender) {
  const root = settingsService.load().workspaceRoot || process.cwd();
  if (watcher && watcherRoot === root) return;
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  watcherRoot = root;
  try {
    watcher = fs.watch(root, { recursive: true }, (_kind, filename) => {
      const rel = String(filename ?? '');
      if (rel.split(path.sep).some((seg) => IGNORED.has(seg))) return;
      emitScopedEvent(sender, 'file', 'onChange', { root, changed: rel });
    });
  } catch {
    // Directory watching can fail on some filesystems; degrade gracefully.
  }
}

function tree() {
  const root = settingsService.load().workspaceRoot || process.cwd();
  return { root, entries: listTree(root) };
}

module.exports = { fileService: { tree, read, readMedia, write, watch }, MEDIA_MIME, MAX_MEDIA_BYTES };
