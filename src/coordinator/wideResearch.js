'use strict';
/**
 * Wide Research — the local-first implementation of Manus' "Wide Research".
 *
 * The feature is a fan-out/fan-in engine:
 *
 *   1. **Decompose** the request into independent items.
 *   2. **Fan out**: one dedicated agent per item, each with an ISOLATED
 *      context window (the child never sees a sibling's work — that is the
 *      whole point, and it is what lets the engine stay uniform at scale).
 *   3. **Extract** a fixed set of fields per item, so the results line up
 *      in a matrix instead of a pile of prose.
 *   4. **Fan in**: synthesize into the requested output shape (table,
 *      report, dataset, CSV) and surface the patterns.
 *   5. **Refine**: re-run a subset of items with more detail and merge the
 *      new columns back in.
 *
 * The engine reuses Quansiox' existing child-session machinery
 * (`dispatchTask`), so every item gets a real, isolated, cancellable child
 * task with its own transcript — not a thread pretending to be one.
 *
 * The result matrix is also written out as CSV + Markdown, and can be
 * packaged as a single ZIP (the docs show the output being zipped).
 */
const fs = require('node:fs');
const path = require('node:path');

const { buildZip, toCsv } = require('../shared/zip');

/** The docs claim 250 items work; the cap is here so a bad call cannot
 *  start two hundred and fifty children by accident. */
const MAX_ITEMS = 250;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 12;
/** Fields extracted per item. */
const MAX_FIELDS = 24;
const OUTPUT_FORMATS = ['table', 'report', 'dataset', 'csv'];

/* ------------------------------------------------------------ normalising */

function normalizeItems(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const [index, entry] of list.entries()) {
    if (entry == null) continue;
    if (typeof entry === 'string' || typeof entry === 'number') {
      const text = String(entry).trim();
      if (!text) continue;
      out.push({ id: `item-${index + 1}`, label: text, prompt: text });
      continue;
    }
    const prompt = String(entry.prompt ?? entry.text ?? entry.value ?? entry.description ?? '').trim();
    if (!prompt) continue;
    out.push({
      id: String(entry.id ?? `item-${index + 1}`).slice(0, 64),
      label: String(entry.label ?? entry.name ?? entry.id ?? prompt).slice(0, 200),
      prompt,
    });
  }
  return out.slice(0, MAX_ITEMS);
}

function normalizeFields(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const entry of list) {
    const name = String(entry?.name ?? entry ?? '').trim();
    if (!name) continue;
    out.push(name.slice(0, 80));
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

/* -------------------------------------------------------------- prompting */

/**
 * The prompt for one item. It is self-contained on purpose: the child sees
 * the instruction, its own item, and the field schema — and nothing else.
 */
function itemPrompt(item, { instruction, fields }) {
  const parts = [];
  parts.push(instruction || 'Research this item and report what you find.');
  parts.push(`\nItem:\n"""\n${item.prompt}\n"""`);
  if (fields.length) {
    parts.push(
      `\nExtract exactly these fields: ${fields.join(', ')}.`
      + '\nReply with ONE JSON object and nothing else, in this shape:'
      + `\n{"item": "<the item>", ${fields.map((f) => `"${f}": "<value>"`).join(', ')}}`
      + '\nUse an empty string for a field you could not find. No prose, no code fence.'
    );
  } else {
    parts.push('\nReply with a concise report of what you found. No preamble.');
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------- extraction */

/** Pull a JSON object out of a child answer that may be wrapped in prose. */
function parseFields(text, fields) {
  const raw = String(text ?? '').trim();
  if (!raw) return {};
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced ? fenced[1] : null, raw].filter(Boolean);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next candidate */ }
  }
  // No JSON: fall back to "label: value" lines so a plain answer still lands
  // in the matrix instead of being dropped.
  const fallback = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*[-*]?\s*([^:]{1,80}):\s*(.+)$/);
    if (match) {
      const key = match[1].trim();
      if (fields.length && !fields.includes(key)) continue;
      fallback[key] = match[2].trim();
    }
  }
  return Object.keys(fallback).length ? fallback : { summary: raw.slice(0, 4000) };
}

/* --------------------------------------------------------------- synthesis */

/**
 * The result matrix: one row per item, one column per field.
 * `stats` is the cheap, honest version of "pattern detection": counts,
 * filled/empty ratios and the most common non-empty value per column.
 */
function buildMatrix(rows, fields) {
  const columns = fields.length
    ? fields
    : [...new Set(rows.flatMap((row) => Object.keys(row.values ?? {})))].slice(0, MAX_FIELDS);
  const stats = {};
  for (const column of columns) {
    const values = rows.map((row) => String(row.values?.[column] ?? '').trim());
    const filled = values.filter(Boolean);
    const counts = new Map();
    for (const value of filled) counts.set(value, (counts.get(value) ?? 0) + 1);
    let top = null;
    for (const [value, count] of counts) {
      if (!top || count > top.count) top = { value, count };
    }
    stats[column] = {
      filled: filled.length,
      empty: values.length - filled.length,
      unique: counts.size,
      top: top && top.count > 1 ? top.value : null,
    };
  }
  return { columns, rows, stats };
}

function renderTable(matrix) {
  // The item label is the row key — without it the table is just a pile of
  // values with no way to tell which item produced which row.
  const header = ['item', ...matrix.columns].join(' | ');
  const rule = ['---', ...matrix.columns.map(() => '---')].join(' | ');
  const body = matrix.rows.map((row) =>
    [String(row.label ?? '').replace(/\s*\n\s*/g, ' '),
      ...matrix.columns.map((column) => String(row.values?.[column] ?? '').replace(/\s*\n\s*/g, ' '))]
      .join(' | ')
  );
  return [header, rule, ...body].join('\n');
}

function renderReport(matrix, { instruction, fields }) {
  const lines = [];
  lines.push(`# Wide Research result`);
  lines.push('');
  lines.push(`Instruction: ${instruction || '(none given)'}`);
  lines.push(`Items processed: ${matrix.rows.length} (${matrix.rows.filter((r) => r.ok).length} succeeded)`);
  if (fields.length) lines.push(`Fields: ${fields.join(', ')}`);
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  for (const row of matrix.rows) {
    lines.push(`### ${row.label}`);
    for (const column of matrix.columns) {
      const value = String(row.values?.[column] ?? '').trim();
      if (value) lines.push(`- **${column}**: ${value}`);
    }
    if (!row.ok && row.error) lines.push(`- _failed: ${row.error}_`);
    lines.push('');
  }
  lines.push('## Column profile');
  lines.push('');
  for (const [column, stat] of Object.entries(matrix.stats)) {
    lines.push(
      `- **${column}**: ${stat.filled}/${matrix.rows.length} filled, ${stat.unique} distinct`
      + (stat.top ? `, most common: ${stat.top}` : '')
    );
  }
  return lines.join('\n');
}

function renderCsv(matrix) {
  const header = ['item', ...matrix.columns];
  const rows = matrix.rows.map((row) => [row.label, ...matrix.columns.map((c) => row.values?.[c] ?? '')]);
  return toCsv([header, ...rows]);
}

/* ------------------------------------------------------------------- run */

/**
 * Run the fan-out.
 *
 * @param {object} args   the tool arguments (items, fields, instruction, …)
 * @param {object} ctx    the coordinator context (sessionId, policy, …)
 * @param {function} dispatch  the child's dispatch function (dispatchTask)
 * @returns {Promise<object>} the result matrix + artifacts
 */
async function runWideResearch(args, ctx, dispatch) {
  const items = normalizeItems(args?.items);
  const fields = normalizeFields(args?.fields);
  const instruction = String(args?.instruction ?? args?.task ?? '').trim();
  const output = OUTPUT_FORMATS.includes(args?.output) ? args.output : 'table';
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Number(args?.concurrency) || DEFAULT_CONCURRENCY)
  );

  if (!items.length) {
    return { error: 'wide_research needs at least one item', items: 0 };
  }
  if (items.length < 2) {
    return { error: 'wide_research needs at least two items — use task for a single item', items: items.length };
  }

  // A refinement pass re-runs a subset of items and merges the new values
  // back into the matrix (the docs' "re-research items 20-30 with more
  // detail").
  const refine = args?.refine && typeof args.refine === 'object' ? args.refine : null;
  const refineIds = new Set(
    (Array.isArray(refine?.items) ? refine.items : []).map((v) => String(v))
  );
  const refineInstruction = String(refine?.instruction ?? '').trim();

  const results = new Map();
  const errors = [];
  let completed = 0;

  for (let start = 0; start < items.length; start += concurrency) {
    const wave = items.slice(start, start + concurrency);
    const pending = wave.map(async (item) => {
      const isRefinement = refineIds.size > 0 && refineIds.has(item.id);
      const prompt = itemPrompt(item, {
        instruction: isRefinement && refineInstruction ? refineInstruction : instruction,
        fields,
      });
      let raw;
      try {
        raw = await dispatch({
          description: item.label.slice(0, 80),
          prompt,
          subagent_type: args?.subagent_type || 'general',
          model: args?.model,
        }, { ...ctx, team: 'wide-research' });
      } catch (error) {
        raw = JSON.stringify({ summary: '', error: String(error?.message ?? error), errored: true });
      }
      completed += 1;
      let parsed = {};
      let summary = String(raw ?? '');
      try {
        parsed = JSON.parse(raw);
        summary = String(parsed.summary ?? summary);
      } catch { /* the child answered in prose */ }
      const values = fields.length
        ? parseFields(parsed?.values ? JSON.stringify(parsed.values) : summary, fields)
        : { summary: summary.slice(0, 4000) };
      if (parsed?.error || parsed?.errored) {
        errors.push(`${item.id}: ${parsed.error ?? 'child failed'}`);
      }
      results.set(item.id, {
        id: item.id,
        label: item.label,
        values,
        ok: !(parsed?.error || parsed?.errored),
        error: parsed?.error ?? null,
        refined: isRefinement,
      });
    });
    await Promise.all(pending);
  }

  const rows = items.map((item) => results.get(item.id) ?? {
    id: item.id, label: item.label, values: {}, ok: false, error: 'no result', refined: false,
  });
  const matrix = buildMatrix(rows, fields);

  const result = {
    instruction,
    output,
    fields: matrix.columns,
    items: matrix.rows.length,
    succeeded: matrix.rows.filter((row) => row.ok).length,
    failed: matrix.rows.filter((row) => !row.ok).length,
    concurrency,
    matrix: matrix.rows.map((row) => ({ item: row.id, label: row.label, ...row.values, _ok: row.ok })),
    stats: matrix.stats,
  };
  if (errors.length) result.errors = errors;

  // The rendered shapes.
  if (output === 'report') result.report = renderReport(matrix, { instruction, fields });
  else if (output === 'dataset') result.dataset = renderCsv(matrix);
  else if (output === 'csv') result.csv = renderCsv(matrix);
  else result.table = renderTable(matrix);

  // Persist the matrix next to the workspace, and optionally package it.
  const artifacts = writeArtifacts({ matrix, fields, instruction, output, args, ctx });
  if (artifacts) result.artifacts = artifacts;

  return result;
}

/**
 * Write the matrix out (CSV + Markdown) and, when asked, package it as a
 * single ZIP next to the other files.
 */
function writeArtifacts({ matrix, fields, instruction, output, args, ctx }) {
  try {
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    const { settingsService } = require('../main/services/settingsService');
    const root = settingsService.load().workspaceRoot || process.cwd();
    const dir = path2.join(root, 'wide-research');
    fs2.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = `wide-research-${stamp}`;
    const csvPath = path2.join(dir, `${base}.csv`);
    const mdPath = path2.join(dir, `${base}.md`);
    const csv = renderCsv(matrix);
    const markdown = renderReport(matrix, { instruction, fields });
    fs2.writeFileSync(csvPath, csv, 'utf8');
    fs2.writeFileSync(mdPath, markdown, 'utf8');
    const files = [csvPath, mdPath];

    if (args?.package === true || args?.zip === true) {
      const zipPath = path2.join(dir, `${base}.zip`);
      const zip = buildZip([
        { name: `${base}.csv`, data: csv },
        { name: `${base}.md`, data: markdown },
        { name: 'results.json', data: JSON.stringify({ fields, rows: matrix.rows }, null, 2) },
      ]);
      fs2.writeFileSync(zipPath, zip);
      files.push(zipPath);
    }
    return { files, directory: dir };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

module.exports = {
  runWideResearch,
  // exported for tests
  normalizeItems,
  normalizeFields,
  parseFields,
  buildMatrix,
  renderTable,
  renderReport,
  renderCsv,
  MAX_ITEMS,
  MAX_CONCURRENCY,
  OUTPUT_FORMATS,
};
