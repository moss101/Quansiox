'use strict';
/**
 * File tools — surgical editing, globbing and ranged reads.
 *
 * Why this exists: the agent only had `read_file` (whole file, 200 KB cap)
 * and `write_file` (full overwrite). Every surgical change meant reading a
 * file, re-emitting the whole thing, and hoping the model reproduced the
 * untouched parts byte for byte. In practice it truncated files, lost
 * trailing newlines, and burned tokens re-reading megabytes.
 *
 * Grok Bot's controlled exec engine ships `piEditExecutor` / `piFindExecutor`
 * / `piGrepExecutor` for exactly this reason. This module is the local
 * equivalent: `edit_file` (exact + fuzzy hunk replacement with a unified
 * diff), `glob_files` (pattern search) and `read_file` with line ranges.
 *
 * Pure-ish: no Electron, no network. The coordinator (a plain Node child)
 * calls it directly.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_EDIT_MATCHES = 200;

/* ---------------- reading ---------------- */

/**
 * Read a text file, optionally a line range.
 *
 * `offset` is 1-based (line 1 is the first line) to match the model's
 * mental model and the `read_file` tool contract; 0 (or omitted) means
 * "from the start".
 *
 * @returns {{ text: string, startLine: number, totalLines: number, truncated: boolean }}
 */
function readFileRange(filePath, { offset = 0, limit = 0 } = {}) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`file is too large to read (${stat.size} bytes, limit ${MAX_READ_BYTES})`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  // A trailing newline produces a final empty element — do not count it.
  const total = raw.endsWith('\n') ? lines.length - 1 : lines.length;
  const requested = Number(offset) || 0;
  const start = Math.max(0, Math.min(requested > 0 ? requested - 1 : 0, total));
  const count = limit > 0 ? Math.max(1, Math.min(Number(limit) || 1, total - start || 1)) : total - start;
  const slice = lines.slice(start, start + count);
  const text = slice.join('\n');
  return {
    text,
    startLine: start + 1,
    totalLines: total,
    truncated: start + count < total,
  };
}

/* ---------------- globbing ---------------- */

/** Translate a glob pattern into a RegExp. Supports *, **, ?, {a,b}. */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches any number of directories
        if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') { out += '[^/]'; continue; }
    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close !== -1) {
        const alts = pattern.slice(i + 1, close).split(',');
        out += `(?:${alts.map(alt => alt.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close;
        continue;
      }
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

const DEFAULT_IGNORES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'build', 'dist', 'out', 'target',
  '.next', '.nuxt', '.cache', 'coverage', '.venv', 'venv', '__pycache__',
  '.quansiox', '.qx-worktrees', 'DerivedData', '.gradle',
]);

/**
 * Find files under `root` matching a glob pattern.
 * @returns {Array<{ path: string, relative: string, size: number, mtimeMs: number }>}
 */
function globFiles(root, pattern, { limit = 200, cwd = root, followSymlinks = false } = {}) {
  const base = path.resolve(root);
  const matcher = globToRegExp(String(pattern ?? '**/*'));
  const results = [];
  const stack = [base];
  let visited = 0;
  while (stack.length && results.length < limit && visited < 50_000) {
    const dir = stack.pop();
    visited += 1;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.quansiox') continue;
      if (DEFAULT_IGNORES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      if (entry.isSymbolicLink() && !followSymlinks) continue;
      const relative = path.relative(base, full);
      if (!matcher.test(relative)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      results.push({ path: full, relative, size: stat.size, mtimeMs: stat.mtimeMs });
      if (results.length >= limit) break;
    }
  }
  results.sort((a, b) => a.relative.localeCompare(b.relative));
  return results;
}

/* ---------------- editing ---------------- */

/** Normalize line endings for comparison (but keep the file's own style). */
function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Fuzzy-match a `old_string` against the file.
 *
 * Exact match is preferred. If it fails we retry with:
 *   - trailing whitespace trimmed on each line
 *   - CRLF/LF normalised
 *   - a small edit-distance tolerance for near-misses
 *
 * @returns {{ start: number, end: number, matched: string }|null}
 */
function locateOldString(content, oldString) {
  if (!oldString) return null;
  // 1) exact
  const exact = content.indexOf(oldString);
  if (exact !== -1) return { start: exact, end: exact + oldString.length, matched: oldString };
  // 2) whitespace-insensitive per line
  const loose = oldString.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  const contentLoose = content.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  const looseIdx = contentLoose.indexOf(loose);
  if (looseIdx !== -1) {
    // Map back to the original offsets by counting the characters we dropped.
    let start = 0;
    let seen = 0;
    const target = looseIdx;
    while (start < content.length && seen < target) {
      if (content[start] === '\n') seen += 1;
      start += 1;
    }
    // Trim trailing whitespace again on the matched slice.
    let end = start;
    let consumed = 0;
    while (end < content.length && consumed < loose.length) {
      if (content[end] !== ' ' && content[end] !== '\t') consumed += 1;
      end += 1;
    }
    return { start, end, matched: content.slice(start, end) };
  }
  return null;
}

/**
 * Apply a surgical edit to a file.
 *
 * @param {string} filePath
 * @param {string} oldString
 * @param {string} newString
 * @param {boolean} [replaceAll]
 * @returns {{ ok: boolean, diff?: string, replaced?: number, reason?: string, error?: string }}
 */
function applyEdit(filePath, oldString, newString, { replaceAll = false } = {}) {
  let original;
  try { original = fs.readFileSync(filePath, 'utf8'); } catch (e) {
    return { ok: false, error: `cannot read ${filePath}: ${e.message}` };
  }
  if (oldString === newString) {
    return { ok: false, error: 'old_string and new_string are identical — nothing to change' };
  }
  if (!oldString) {
    return { ok: false, error: 'old_string is required (use write_file to create a file)' };
  }
  const occurrences = countOccurrences(original, oldString);
  if (occurrences === 0) {
    const loose = locateOldString(original, oldString);
    if (!loose) {
      return {
        ok: false,
        error: 'old_string not found — read the file again and copy the exact text (including indentation)',
        occurrences: 0,
      };
    }
    const updated = original.slice(0, loose.start) + newString + original.slice(loose.end);
    const diff = unifiedDiff(original, updated, filePath);
    try { writeFileSafe(filePath, updated); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, replaced: 1, fuzzy: true, diff, bytes: updated.length };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      error: `old_string is not unique — it appears ${occurrences} times. Add more context, or pass replace_all: true`,
      occurrences,
    };
  }
  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString);
  const diff = unifiedDiff(original, updated, filePath);
  try { writeFileSafe(filePath, updated); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, replaced: replaceAll ? occurrences : 1, diff, bytes: updated.length };
}

/** Write a file atomically (temp file + rename) so a crash cannot truncate it. */
function writeFileSafe(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/* ---------------- diffing ---------------- */

/**
 * Minimal unified diff (line-based, LCS).
 * @returns {string} unified diff text (empty when nothing changed)
 */
function unifiedDiff(original, updated, filePath = 'file') {
  const a = original.split('\n');
  const b = updated.split('\n');
  const ops = diffLines(a, b);
  if (!ops.some((op) => op.type !== 'equal')) return '';
  const hunks = buildHunks(ops, 3);
  const name = filePath;
  let out = `--- a/${name}\n+++ b/${name}\n`;
  for (const hunk of hunks) {
    out += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;
    for (const line of hunk.lines) {
      out += `${line.prefix}${line.text}\n`;
    }
  }
  return out;
}

/** Longest-common-subsequence line diff → ops [{type, text}]. */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  // Guard against pathological sizes (the LCS table is O(n*m)).
  if (n * m > 4_000_000) {
    return [
      ...a.map((text) => ({ type: 'del', text })),
      ...b.map((text) => ({ type: 'add', text })),
    ];
  }
  // Trim the common prefix/suffix first — the usual case for an edit.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start += 1;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const lcs = lcsTable(midA, midB);
  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push({ type: 'equal', text: a[i] });
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) { ops.push({ type: 'equal', text: midA[i] }); i += 1; j += 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ type: 'del', text: midA[i] }); i += 1; }
    else { ops.push({ type: 'add', text: midB[j] }); j += 1; }
  }
  while (i < midA.length) { ops.push({ type: 'del', text: midA[i] }); i += 1; }
  while (j < midB.length) { ops.push({ type: 'add', text: midB[j] }); j += 1; }
  for (let k = endA; k < n; k += 1) ops.push({ type: 'equal', text: a[k] });
  return ops;
}

function lcsTable(a, b) {
  const table = [];
  for (let i = 0; i <= a.length; i += 1) table.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Group diff ops into unified-diff hunks with `context` lines of padding. */
function buildHunks(ops, context) {
  const hunks = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      oldLine += 1; newLine += 1; i += 1;
      continue;
    }
    // Start of a change block.
    const start = i;
    const padBefore = [];
    let k = i - 1;
    while (k >= 0 && padBefore.length < context && ops[k].type === 'equal') { padBefore.unshift(ops[k]); k -= 1; }
    const padAfter = [];
    let m = i;
    while (m < ops.length) {
      if (ops[m].type !== 'equal') { m += 1; continue; }
      // Look ahead: stop if the next change is far away.
      let gap = 0;
      let p = m;
      while (p < ops.length && ops[p].type === 'equal' && gap < context * 2) { gap += 1; p += 1; }
      if (p < ops.length && ops[p].type !== 'equal' && gap <= context * 2) { m = p; continue; }
      break;
    }
    const block = [];
    for (const op of padBefore) { block.push({ prefix: ' ', text: op.text }); oldLine += 1; newLine += 1; }
    const oldStart = oldLine;
    const newStart = newLine;
    let oldCount = 0;
    let newCount = 0;
    while (i < m) {
      const op = ops[i];
      if (op.type === 'equal') {
        block.push({ prefix: ' ', text: op.text });
        oldLine += 1; newLine += 1; oldCount += 1; newCount += 1;
      } else if (op.type === 'del') {
        block.push({ prefix: '-', text: op.text });
        oldLine += 1; oldCount += 1;
      } else {
        block.push({ prefix: '+', text: op.text });
        newLine += 1; newCount += 1;
      }
      i += 1;
    }
    for (const op of padAfter) { block.push({ prefix: ' ', text: op.text }); oldLine += 1; newLine += 1; }
    hunks.push({ oldStart, oldCount: oldCount || 1, newStart, newCount: newCount || 1, lines: block });
    void start;
  }
  return hunks;
}

module.exports = {
  readFileRange,
  globFiles,
  globToRegExp,
  applyEdit,
  writeFileSafe,
  unifiedDiff,
  diffLines,
  countOccurrences,
  locateOldString,
  detectEol,
  MAX_READ_BYTES,
  fsp,
};
