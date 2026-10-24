'use strict';
/**
 * Workspace search service — dependency-free grep-style code search over the
 * workspace, plus media-file listing and session-title search. Used by the
 * agent's `search_code` tool and surfaced as real Grok-compat methods
 * (searchMedia / searchAgents). Electron-free (QUANSIOX_USER_DATA_DIR / cwd).
 */
const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'release', '.next', '.cache', '.venv', 'out']);
const MAX_FILES = 2000;
const MAX_RESULTS = 120;

const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.mp4', '.mov', '.webm', '.mkv', '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.pdf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac']);
function mediaKind(ext) {
  const e = (ext || '').toLowerCase();
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  return 'document';
}

function isText(file) {
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|mp4|mov|webm|mkv|mp3|wav|m4a|ogg|flac|pdf|zip|gz|tar|7z|woff2?|ttf|otf|wasm|icns|app)$/i.test(file)) return false;
  return true;
}

/** Recursive line search. Returns { results, truncated, filesScanned }. */
function searchFiles(query, cwd, { regex = false, context = 0, maxResults = MAX_RESULTS } = {}) {
  if (!query || !cwd || !fs.existsSync(cwd)) return { results: [], truncated: false, filesScanned: 0 };
  let matcher;
  try { matcher = regex ? new RegExp(query) : null; } catch (e) { return { results: [], error: `bad regex: ${e.message}`, filesScanned: 0 }; }
  const needle = regex ? null : String(query);
  const results = [];
  let filesScanned = 0;
  const stack = [path.resolve(cwd)];
  outer: while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || !isText(entry.name)) continue;
      if (filesScanned >= MAX_FILES) break outer;
      filesScanned += 1;
      let content;
      try {
        const stat = fs.statSync(full);
        if (stat.size > 512 * 1024) continue;
        content = fs.readFileSync(full, 'utf8');
      } catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const hit = matcher ? matcher.test(line) : line.includes(needle);
        if (!hit) continue;
        let chunk = line;
        if (context > 0) chunk = lines.slice(Math.max(0, i - context), i + context + 1).join(' | ');
        results.push({ path: path.relative(cwd, full) || full, line: i + 1, text: chunk.trim().slice(0, 300) });
        if (results.length >= maxResults) break outer;
      }
    }
  }
  return { results, truncated: results.length >= maxResults, filesScanned };
}

/** Media files under cwd whose name matches query (case-insensitive substring). */
function listMedia(query, cwd, { limit = 100, kinds } = {}) {
  if (!cwd || !fs.existsSync(cwd)) return [];
  const q = String(query ?? '').toLowerCase();
  const wantKinds = kinds ? new Set((Array.isArray(kinds) ? kinds : [kinds]).map((k) => String(k).toLowerCase())) : null;
  const out = [];
  const stack = [path.resolve(cwd)];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) stack.push(full); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!MEDIA_EXT.has(ext)) continue;
      if (q && !entry.name.toLowerCase().includes(q)) continue;
      const kind = mediaKind(ext);
      if (wantKinds && !wantKinds.has(kind)) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch {}
      out.push({ path: path.relative(cwd, full) || full, name: entry.name, kind, ext: ext.slice(1), size });
      if (out.length >= limit) break;
    }
  }
  return out;
}

function searchAgents(query, list) {
  const q = String(query ?? '').toLowerCase();
  return (Array.isArray(list) ? list : []).filter((a) => !q || `${a.title ?? ''} ${a.id ?? ''}`.toLowerCase().includes(q));
}

module.exports = { searchService: { searchFiles, listMedia, searchAgents } };
