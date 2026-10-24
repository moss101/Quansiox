'use strict';
/**
 * The flat tool family — `pi_bash`, `pi_edit`, `pi_find`, `pi_grep`, `pi_ls`,
 * `pi_read`, `pi_write`.
 *
 * The reference implementation ships two tool families side by side. The rich
 * one (`Shell`, `Read`, `Write`, `Grep`, `Ls`) carries a lot of IDE-specific
 * machinery: sandbox policy objects, permission gating, background shells,
 * conversation ids. Beside it sits a **flat** family — `piBash`, `piEdit`,
 * `piFind`, `piGrep`, `piLs`, `piRead`, `piWrite` — with one job: do the
 * deterministic file work and report precisely what happened.
 *
 * Two details of that family are worth copying, because they are the
 * difference between a tool the model can trust and one it has to guess about:
 *
 *  1. **Truncation is explicit.** Every result carries a `truncation` block:
 *     whether it was truncated, by what, the total line and byte counts, and
 *     whether the first or last line was cut. A model that gets half a file
 *     with no marker will assume it read the whole file.
 *
 *  2. **Write-shaped tools can be *rejected*.** `pi_edit` and `pi_write`
 *     return a `rejected` outcome with a reason; the read-shaped ones do
 *     not, because a read cannot be refused.
 *
 * Pure module — no Electron. The tools run through the coordinator's exec
 * path so the sandbox still applies.
 */
const fs = require('node:fs');
const path = require('node:path');

/** The truncation limits. */
const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 1000;
const MAX_MATCHES = 500;

/**
 * Truncate a block of text and describe exactly what was cut.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxLines]
 * @param {number} [opts.maxBytes]
 * @returns {{ text: string, truncation: object }}
 */
function truncate(text, opts = {}) {
  const maxLines = Math.max(1, Number(opts.maxLines) || MAX_LINES);
  const maxBytes = Math.max(1, Number(opts.maxBytes) || MAX_BYTES);
  const source = String(text ?? '');
  const totalLines = source ? source.split('\n').length : 0;
  const totalBytes = Buffer.byteLength(source, 'utf8');

  let out = source;
  let truncatedBy = null;
  let firstLineExceedsLimit = false;
  let lastLinePartial = false;

  const lines = source ? source.split('\n') : [];
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join('\n');
    truncatedBy = 'lines';
    lastLinePartial = true;
  }
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    const buf = Buffer.from(out, 'utf8');
    out = buf.subarray(0, maxBytes).toString('utf8');
    truncatedBy = truncatedBy ? `${truncatedBy}+bytes` : 'bytes';
    lastLinePartial = true;
  }
  if (out && Buffer.byteLength(out, 'utf8') >= maxBytes) firstLineExceedsLimit = true;

  const outputLines = out ? out.split('\n').length : 0;
  return {
    text: out,
    truncation: {
      truncated: truncatedBy !== null,
      truncated_by: truncatedBy,
      total_lines: totalLines,
      output_lines: outputLines,
      output_bytes: Buffer.byteLength(out, 'utf8'),
      max_lines: maxLines,
      max_bytes: maxBytes,
      first_line_exceeds_limit: firstLineExceedsLimit,
      last_line_partial: lastLinePartial,
    },
  };
}

/** A read-shaped result. */
function readResult(text, opts = {}) {
  const { text: out, truncation } = truncate(text, opts);
  return { ok: true, output: out, truncation };
}

/** A write-shaped result. */
function writeResult(output, opts = {}) {
  return { ok: true, output: String(output ?? ''), truncation: null };
}

/** A write-shaped refusal. */
function rejected(reason) {
  return { ok: false, rejected: true, reason: String(reason ?? 'rejected') };
}

/* ------------------------------------------------------------------ pi_read */

/**
 * Read a file, with a line range.
 */
function piRead({ path: filePath, offset = 0, limit = 400 } = {}) {
  if (!filePath) return rejected('pi_read needs a path');
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return rejected(`pi_read: ${error.code === 'ENOENT' ? 'no such file' : error.message}`);
  }
  // A trailing newline does not start a new line.
  const lines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n');
  const start = Math.max(0, Number(offset) || 0);
  const count = Math.max(1, Math.min(Number(limit) || 400, MAX_LINES));
  const slice = lines.slice(start, start + count);
  const result = readResult(slice.join('\n'), { maxLines: count });
  result.totalLines = lines.length;
  result.offset = start;
  return result;
}

/* ------------------------------------------------------------------- pi_ls */

/**
 * List a directory.
 */
function piLs({ path: dirPath = '.', limit = 200 } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    return rejected(`pi_ls: ${error.code === 'ENOENT' ? 'no such directory' : error.message}`);
  }
  const cap = Math.max(1, Math.min(Number(limit) || 200, MAX_ENTRIES));
  const sorted = entries
    .map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`)
    .sort();
  const result = readResult(sorted.slice(0, cap).join('\n'));
  result.entryLimitReached = sorted.length > cap;
  result.totalEntries = sorted.length;
  return result;
}

/* ----------------------------------------------------------------- pi_find */

/**
 * Find files by name.
 */
function piFind({ pattern, path: root = '.', limit = 100 } = {}) {
  if (!pattern) return rejected('pi_find needs a pattern');
  const cap = Math.max(1, Math.min(Number(limit) || 100, MAX_ENTRIES));
  const needle = String(pattern).toLowerCase();
  const matches = [];
  const SKIP = new Set(['node_modules', '.git', 'build', 'dist', 'release', '.quansiox']);
  const walk = (dir, depth) => {
    if (depth > 12 || matches.length >= cap) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (matches.length >= cap) return;
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (entry.name.toLowerCase().includes(needle)) matches.push(full);
    }
  };
  walk(root, 0);
  const result = readResult(matches.join('\n'));
  result.resultLimitReached = matches.length >= cap;
  result.totalMatches = matches.length;
  return result;
}

/* ----------------------------------------------------------------- pi_grep */

/**
 * Search inside files.
 */
function piGrep({ pattern, path: root = '.', glob, ignoreCase = false, literal = false, context = 0, limit = 200 } = {}) {
  if (!pattern) return rejected('pi_grep needs a pattern');
  const cap = Math.max(1, Math.min(Number(limit) || 200, MAX_MATCHES));
  const ctx = Math.max(0, Math.min(Number(context) || 0, 20));
  let matcher;
  try {
    matcher = literal
      ? new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'i' : '')
      : new RegExp(String(pattern), ignoreCase ? 'i' : '');
  } catch (error) {
    return rejected(`pi_grep: invalid pattern (${error.message})`);
  }
  const globRe = glob ? globToRegExp(String(glob)) : null;
  const SKIP = new Set(['node_modules', '.git', 'build', 'dist', 'release', '.quansiox']);
  const hits = [];
  let linesTruncated = false;
  const walk = (dir, depth) => {
    if (depth > 12 || hits.length >= cap) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (hits.length >= cap) return;
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (globRe && !globRe.test(entry.name)) continue;
      let content;
      try {
        if (fs.statSync(full).size > 4 * 1024 * 1024) continue;
        content = fs.readFileSync(full, 'utf8');
      } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!matcher.test(lines[i])) continue;
        if (hits.length >= cap) { linesTruncated = true; return; }
        const from = Math.max(0, i - ctx);
        const to = Math.min(lines.length - 1, i + ctx);
        hits.push(`${full}:${i + 1}: ${lines.slice(from, to + 1).join('\n')}`);
      }
    }
  };
  walk(root, 0);
  const result = readResult(hits.join('\n'));
  result.matchLimitReached = hits.length >= cap;
  result.linesTruncated = linesTruncated;
  result.totalMatches = hits.length;
  return result;
}

/* ---------------------------------------------------------------- pi_write */

/**
 * Write a file.
 */
function piWrite({ path: filePath, content } = {}) {
  if (!filePath) return rejected('pi_write needs a path');
  if (content == null) return rejected('pi_write needs content');
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Atomic: temp + rename, so a crash cannot truncate the file.
    const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (error) {
    return rejected(`pi_write: ${error.message}`);
  }
  return writeResult(`wrote ${Buffer.byteLength(text, 'utf8')} bytes to ${filePath}`);
}

/* ----------------------------------------------------------------- pi_edit */

/**
 * Apply edits to a file.
 *
 * `edits` is a list of `{ old_string, new_string, replace_all? }` — the same
 * shape the rich `edit_file` tool uses, so the model does not have to learn
 * two dialects.
 */
function piEdit({ path: filePath, edits } = {}) {
  if (!filePath) return rejected('pi_edit needs a path');
  if (!Array.isArray(edits) || !edits.length) return rejected('pi_edit needs at least one edit');
  let original;
  try {
    original = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return rejected(`pi_edit: ${error.code === 'ENOENT' ? 'no such file' : error.message}`);
  }
  let updated = original;
  let firstChangedLine = null;
  for (const edit of edits) {
    const oldString = String(edit?.old_string ?? '');
    const newString = String(edit?.new_string ?? '');
    if (!oldString) return rejected('pi_edit: an edit needs an old_string');
    const occurrences = updated.split(oldString).length - 1;
    if (!occurrences) return rejected('pi_edit: old_string was not found');
    if (occurrences > 1 && edit?.replace_all !== true) {
      return rejected(`pi_edit: old_string is not unique — it appears ${occurrences} times`);
    }
    if (firstChangedLine === null) {
      firstChangedLine = updated.slice(0, updated.indexOf(oldString)).split('\n').length;
    }
    updated = edit?.replace_all === true
      ? updated.split(oldString).join(newString)
      : updated.replace(oldString, newString);
  }
  try {
    const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, updated, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (error) {
    return rejected(`pi_edit: ${error.message}`);
  }
  return {
    ok: true,
    output: `edited ${filePath}`,
    diff: diffLines(original, updated),
    patch: null,
    first_changed_line: firstChangedLine,
    truncation: null,
  };
}

/* ----------------------------------------------------------------- pi_bash */

/**
 * Run a shell command.
 *
 * The command is handed to the coordinator's exec path, so the sandbox and
 * the permission ladder still apply — the flat family is a *shape*, not a
 * way around the rules. This function is the pure part; the coordinator
 * supplies the runner.
 */
async function piBash({ command, timeout, run } = {}) {
  if (!command) return rejected('pi_bash needs a command');
  if (typeof run !== 'function') return rejected('pi_bash needs a runner');
  const output = await run(command, { timeout });
  const result = readResult(String(output ?? ''));
  return result;
}

/* ------------------------------------------------------------------ diffing */

/** A minimal unified diff (line based). */
function diffLines(original, updated) {
  const a = String(original ?? '').split('\n');
  const b = String(updated ?? '').split('\n');
  const out = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1; }
  if (endA < start && endB < start) return '';
  out.push(`@@ -${start + 1},${endA - start + 1} +${start + 1},${endB - start + 1} @@`);
  for (let i = start; i <= endA; i += 1) out.push(`-${a[i]}`);
  for (let i = start; i <= endB; i += 1) out.push(`+${b[i]}`);
  return out.join('\n');
}

/** A glob → regex, for `pi_grep`'s glob filter. */
function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*\*/g, ' ').replace(/\*/g, '[^/]*').replace(/ /g, '.*');
  return new RegExp(`^${pattern}$`);
}

module.exports = {
  MAX_BYTES,
  MAX_ENTRIES,
  MAX_LINES,
  MAX_MATCHES,
  diffLines,
  globToRegExp,
  piBash,
  piEdit,
  piFind,
  piGrep,
  piLs,
  piRead,
  piWrite,
  readResult,
  rejected,
  truncate,
  writeResult,
};
