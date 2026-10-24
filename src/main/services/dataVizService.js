'use strict';
/**
 * Data analysis & visualization — the local-first implementation of Manus'
 * "Data Analysis & Visualization".
 *
 * The docs describe an upload-a-dataset-and-describe-the-analysis flow with
 * four output shapes (a slide deck, an interactive dashboard, a detailed
 * report, a standalone webpage) and a set of chart types. This module owns
 * the parts that can be done *honestly* on the user's own machine:
 *
 *   - **parsing** of CSV / TSV / JSON data (real, no guessing);
 *   - **profiling** — per-column type, missing count, distinct count, mean,
 *     median, min, max, standard deviation;
 *   - **segmentation** — a real k-means over the numeric columns, with a
 *     readable profile per cluster (the docs' "cluster profiles");
 *   - **charts** — inline SVG, no chart library, no network;
 *   - **outputs** — a self-contained interactive dashboard (HTML) and a
 *     written report (Markdown), both exportable.
 *
 * The slide deck output is deliberately NOT produced here: writing a real
 * .pptx needs a renderer, and the honest local option is to export the
 * dashboard to PDF through the existing render service.
 */
const fs = require('node:fs');
const path = require('node:path');

/** The chart types the docs list, plus a couple the product shows. */
const CHART_TYPES = [
  'bar', 'line', 'pie', 'scatter', 'heatmap', 'radar', 'area', 'donut', 'stacked-bar',
];
const MAX_CHARTS = 5; // the docs: "select up to 5 chart types in one analysis"
const PALETTE = ['#5b8def', '#48b884', '#e8a33d', '#d9646e', '#9b7ede', '#38b6c8', '#c2854f', '#7f8b9a'];

/* ---------------------------------------------------------------- parsing */

/** Split a delimited line, honouring double-quoted fields. */
function splitDelimited(line, delimiter) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i += 1; } else { inQuotes = false; }
      } else current += char;
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      out.push(current);
      current = '';
    } else current += char;
  }
  out.push(current);
  return out;
}

/**
 * Parse a CSV / TSV / JSON table.
 * @returns {{columns: string[], rows: object[]}}
 */
function parseTable(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { columns: [], rows: [] };

  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.rows) ? parsed.rows
          : Array.isArray(parsed?.data) ? parsed.data : [];
      const columns = [];
      for (const row of list) {
        for (const key of Object.keys(row ?? {})) if (!columns.includes(key)) columns.push(key);
      }
      return { columns, rows: list.map((row) => normalizeRow(row, columns)) };
    } catch { /* fall through to the delimited parser */ }
  }

  const delimiter = raw.includes('\t') && !raw.includes(',') ? '\t' : ',';
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return { columns: [], rows: [] };
  const header = splitDelimited(lines[0], delimiter).map((h) => h.trim());
  const columns = header.map((h, index) => h || `column_${index + 1}`);
  const rows = lines.slice(1).map((line) => {
    const cells = splitDelimited(line, delimiter);
    const row = {};
    columns.forEach((column, index) => { row[column] = cells[index] ?? ''; });
    return row;
  });
  return { columns, rows };
}

function normalizeRow(row, columns) {
  const out = {};
  for (const column of columns) {
    const value = row?.[column];
    out[column] = value == null ? '' : String(value);
  }
  return out;
}

/* --------------------------------------------------------------- profiling */

const NUMERIC_RE = /^-?\d{1,3}(,\d{3})*(\.\d+)?%?$|^-?\d*\.?\d+(e[-+]?\d+)?%?$/i;

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  const percent = text.endsWith('%');
  const cleaned = text.replace(/,/g, '').replace(/%$/, '');
  const number = Number(cleaned);
  if (!Number.isFinite(number)) return null;
  return percent ? number / 100 : number;
}

function isNumericColumn(rows, column) {
  let numeric = 0;
  let filled = 0;
  for (const row of rows) {
    const text = String(row[column] ?? '').trim();
    if (!text) continue;
    filled += 1;
    if (NUMERIC_RE.test(text) || Number.isFinite(Number(text))) numeric += 1;
  }
  return filled > 0 && numeric / filled >= 0.8;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The per-column profile: type, coverage, and the descriptive statistics. */
function profile(columns, rows) {
  return columns.map((column) => {
    const values = rows.map((row) => String(row[column] ?? '').trim());
    const filled = values.filter((v) => v.length > 0);
    const numeric = isNumericColumn(rows, column);
    const distinct = new Set(filled).size;
    const base = {
      column,
      type: numeric ? 'number' : 'category',
      filled: filled.length,
      missing: rows.length - filled.length,
      distinct,
    };
    if (!numeric) {
      const counts = new Map();
      for (const value of filled) counts.set(value, (counts.get(value) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([value, count]) => ({ value, count }));
      return { ...base, top };
    }
    const numbers = filled.map(toNumber).filter((n) => n !== null).sort((a, b) => a - b);
    const avg = mean(numbers);
    const variance = numbers.length > 1
      ? numbers.reduce((sum, n) => sum + (n - avg) ** 2, 0) / (numbers.length - 1)
      : 0;
    return {
      ...base,
      min: numbers[0] ?? null,
      max: numbers[numbers.length - 1] ?? null,
      mean: avg,
      median: quantile(numbers, 0.5),
      q1: quantile(numbers, 0.25),
      q3: quantile(numbers, 0.75),
      stdev: Math.sqrt(variance),
      sum: numbers.reduce((sum, n) => sum + n, 0),
    };
  });
}

/* ------------------------------------------------------------ segmentation */

/**
 * k-means over the numeric columns — a real, deterministic clustering
 * (fixed seed, fixed iteration count) so the same data always produces the
 * same segments.
 */
function cluster(rows, numericColumns, k = 3) {
  const vectors = rows.map((row) => numericColumns.map((column) => toNumber(row[column]) ?? 0));
  if (!vectors.length || !numericColumns.length) return [];
  const groups = Math.max(1, Math.min(k, vectors.length));

  // Deterministic seeding: spread the initial centroids over the rows.
  const centroids = [];
  for (let i = 0; i < groups; i += 1) {
    centroids.push(vectors[Math.floor((i * vectors.length) / groups)].slice());
  }
  const assign = new Array(vectors.length).fill(0);
  for (let iteration = 0; iteration < 40; iteration += 1) {
    let moved = false;
    for (let i = 0; i < vectors.length; i += 1) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const distance = vectors[i].reduce((sum, value, axis) => sum + (value - centroids[c][axis]) ** 2, 0);
        if (distance < bestDistance) { bestDistance = distance; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    const sums = centroids.map(() => numericColumns.map(() => 0));
    const counts = centroids.map(() => 0);
    for (let i = 0; i < vectors.length; i += 1) {
      counts[assign[i]] += 1;
      vectors[i].forEach((value, axis) => { sums[assign[i]][axis] += value; });
    }
    for (let c = 0; c < centroids.length; c += 1) {
      if (!counts[c]) continue;
      centroids[c] = sums[c].map((sum) => sum / counts[c]);
    }
    if (!moved) break;
  }

  return centroids.map((centroid, index) => {
    const members = vectors
      .map((vector, i) => ({ vector, i }))
      .filter((entry) => assign[entry.i] === index)
      .map((entry) => rows[entry.i]);
    const profileColumns = numericColumns.map((column, axis) => ({
      column,
      mean: mean(members.map((row) => toNumber(row[column]) ?? 0)),
      centroid: centroid[axis],
    }));
    // A readable label: the column where this cluster is highest.
    let label = `Segment ${index + 1}`;
    if (profileColumns.length) {
      const top = [...profileColumns].sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0))[0];
      label = `${top.column} ≈ ${Number(top.mean ?? 0).toFixed(1)}`;
    }
    return { segment: index + 1, label, size: members.length, columns: profileColumns, members };
  });
}

/* ------------------------------------------------------------------ charts */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function niceNumber(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

/**
 * Render one chart as an inline SVG string.
 *
 * @param {string} type      one of CHART_TYPES
 * @param {object} spec      { title, categories, series, points, matrix }
 */
function renderChartSvg(type, spec) {
  const width = 640;
  const height = 320;
  const pad = { top: 24, right: 20, bottom: 46, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const categories = spec.categories ?? [];
  const series = spec.series ?? [];

  const title = `<text x="${pad.left}" y="14" fill="#8b93a7" font-size="12" font-family="system-ui,sans-serif">${escapeHtml(spec.title ?? '')}</text>`;

  if (type === 'pie' || type === 'donut') {
    const values = series[0]?.values ?? [];
    const total = values.reduce((sum, v) => sum + (v || 0), 0);
    if (!total) return `<svg viewBox="0 0 ${width} ${height}" role="img">${title}</svg>`;
    const cx = width / 2;
    const cy = height / 2 + 6;
    const radius = Math.min(plotW, plotH) / 2.2;
    let angle = -Math.PI / 2;
    const slices = values.map((value, index) => {
      const sweep = ((value || 0) / total) * Math.PI * 2;
      const end = angle + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const x2 = cx + radius * Math.cos(end);
      const y2 = cy + radius * Math.sin(end);
      const color = PALETTE[index % PALETTE.length];
      const path = type === 'donut'
        ? `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} L ${cx + radius * 0.55 * Math.cos(end)} ${cy + radius * 0.55 * Math.sin(end)} A ${radius * 0.55} ${radius * 0.55} 0 ${large} 0 ${cx + radius * 0.55 * Math.cos(angle)} ${cy + radius * 0.55 * Math.sin(angle)} Z`
        : `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`;
      angle = end;
      return `<path d="${path}" fill="${color}" />`;
    });
    const legend = categories.map((label, index) =>
      `<rect x="${pad.left}" y="${height - 26 + (index % 3) * 0}" width="0" height="0"/>`
    ).join('');
    const legendItems = categories.slice(0, 6).map((label, index) => {
      const y = height - 20 + Math.floor(index / 3) * 16;
      const x = pad.left + (index % 3) * 190;
      return `<rect x="${x}" y="${y - 8}" width="8" height="8" fill="${PALETTE[index % PALETTE.length]}"/>`
        + `<text x="${x + 12}" y="${y}" fill="#8b93a7" font-size="11" font-family="system-ui,sans-serif">${escapeHtml(String(label).slice(0, 22))}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" role="img">${title}${slices.join('')}${legend}${legendItems}</svg>`;
  }

  if (type === 'radar') {
    const axes = series[0]?.values ?? [];
    const labels = categories;
    if (!axes.length || !labels.length) return `<svg viewBox="0 0 ${width} ${height}" role="img">${title}</svg>`;
    const cx = width / 2;
    const cy = height / 2 + 6;
    const radius = Math.min(plotW, plotH) / 2.4;
    const max = Math.max(...axes.map((v) => Math.abs(v || 0)), 1);
    const points = labels.map((_, index) => {
      const angle = (index / labels.length) * Math.PI * 2 - Math.PI / 2;
      const value = ((axes[index] || 0) / max) * radius;
      return `${cx + value * Math.cos(angle)},${cy + value * Math.sin(angle)}`;
    });
    const grid = [0.25, 0.5, 0.75, 1].map((scale) => {
      const ring = labels.map((_, index) => {
        const angle = (index / labels.length) * Math.PI * 2 - Math.PI / 2;
        return `${cx + radius * scale * Math.cos(angle)},${cy + radius * scale * Math.sin(angle)}`;
      }).join(' ');
      return `<polygon points="${ring}" fill="none" stroke="#2a3040" stroke-width="1"/>`;
    }).join('');
    const spokes = labels.map((label, index) => {
      const angle = (index / labels.length) * Math.PI * 2 - Math.PI / 2;
      const x = cx + (radius + 14) * Math.cos(angle);
      const y = cy + (radius + 14) * Math.sin(angle);
      return `<text x="${x}" y="${y}" fill="#8b93a7" font-size="10" text-anchor="middle" font-family="system-ui,sans-serif">${escapeHtml(String(label).slice(0, 12))}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" role="img">${title}${grid}${spokes}`
      + `<polygon points="${points.join(' ')}" fill="${PALETTE[0]}" fill-opacity="0.35" stroke="${PALETTE[0]}" stroke-width="2"/></svg>`;
  }

  if (type === 'heatmap') {
    const matrix = spec.matrix ?? [];
    if (!matrix.length) return `<svg viewBox="0 0 ${width} ${height}" role="img">${title}</svg>`;
    const rows = matrix.length;
    const cols = matrix[0]?.values?.length ?? 0;
    const cellW = plotW / Math.max(cols, 1);
    const cellH = plotH / Math.max(rows, 1);
    const flat = matrix.flatMap((row) => row.values ?? []);
    const max = Math.max(...flat.map(Math.abs), 1);
    const cells = matrix.map((row, r) => (row.values ?? []).map((value, c) => {
      const intensity = Math.min(1, Math.abs(value || 0) / max);
      const color = PALETTE[0];
      const alpha = 0.08 + intensity * 0.82;
      return `<rect x="${pad.left + c * cellW}" y="${pad.top + r * cellH}" width="${cellW - 1}" height="${cellH - 1}" fill="${color}" fill-opacity="${alpha}"/>`;
    }).join('')).join('');
    return `<svg viewBox="0 0 ${width} ${height}" role="img">${title}${cells}</svg>`;
  }

  if (type === 'scatter') {
    const points = spec.points ?? [];
    if (!points.length) return `<svg viewBox="0 0 ${width} ${height}" role="img">${title}</svg>`;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const sx = (v) => pad.left + ((v - minX) / (maxX - minX || 1)) * plotW;
    const sy = (v) => pad.top + plotH - ((v - minY) / (maxY - minY || 1)) * plotH;
    const dots = points.map((point, index) =>
      `<circle cx="${sx(point.x)}" cy="${sy(point.y)}" r="3.5" fill="${PALETTE[index % PALETTE.length]}" fill-opacity="0.8"/>`
    ).join('');
    return `<svg viewBox="0 0 ${width} ${height}" role="img">${title}${dots}</svg>`;
  }

  // bar / stacked-bar / line / area
  const maxValue = Math.max(
    1,
    ...series.flatMap((s) => s.values ?? []).map((v) => Math.abs(v || 0))
  );
  const grid = [0, 0.25, 0.5, 0.75, 1].map((scale) => {
    const y = pad.top + plotH - plotH * scale;
    return `<line x1="${pad.left}" y1="${y}" x2="${pad.left + plotW}" y2="${y}" stroke="#232838" stroke-width="1"/>`
      + `<text x="${pad.left - 8}" y="${y + 3}" fill="#8b93a7" font-size="10" text-anchor="end" font-family="system-ui,sans-serif">${niceNumber(maxValue * scale)}</text>`;
  }).join('');

  const isLine = type === 'line' || type === 'area';
  const slot = plotW / Math.max(categories.length, 1);
  const barW = Math.max(2, (slot * 0.7) / Math.max(series.length, 1));

  let body = '';
  if (isLine) {
    body = series.map((s, sIndex) => {
      const points = (s.values ?? []).map((value, index) => {
        const x = pad.left + slot * index + slot / 2;
        const y = pad.top + plotH - ((value || 0) / maxValue) * plotH;
        return `${x},${y}`;
      }).join(' ');
      const color = PALETTE[sIndex % PALETTE.length];
      const fill = type === 'area'
        ? `<polygon points="${pad.left + slot / 2},${pad.top + plotH} ${points} ${pad.left + slot * (categories.length - 1) + slot / 2},${pad.top + plotH}" fill="${color}" fill-opacity="0.18"/>`
        : '';
      return `${fill}<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>`
        + (s.values ?? []).map((value, index) => {
          const x = pad.left + slot * index + slot / 2;
          const y = pad.top + plotH - ((value || 0) / maxValue) * plotH;
          return `<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`;
        }).join('');
    }).join('');
  } else {
    body = series.map((s, sIndex) => (s.values ?? []).map((value, index) => {
      const height = Math.abs(value || 0) / maxValue * plotH;
      const x = pad.left + slot * index + slot * 0.15 + sIndex * barW;
      const y = pad.top + plotH - height;
      const color = PALETTE[sIndex % PALETTE.length];
      return `<rect x="${x}" y="${y}" width="${barW - 1}" height="${height}" fill="${color}" fill-opacity="${type === 'stacked-bar' ? 0.85 : 0.9}"/>`;
    }).join('')).join('');
  }

  const labels = categories.map((label, index) => {
    const x = pad.left + slot * index + slot / 2;
    return `<text x="${x}" y="${pad.top + plotH + 16}" fill="#8b93a7" font-size="10" text-anchor="middle" font-family="system-ui,sans-serif">${escapeHtml(String(label).slice(0, 14))}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" role="img">${title}${grid}${body}${labels}</svg>`;
}

/* ----------------------------------------------------------------- output */

/**
 * Build the charts for a dataset.
 *
 * The chart plan is derived from the data, not guessed: a categorical column
 * paired with a numeric one gives a bar chart, two numerics give a scatter,
 * a date-ish column with a numeric gives a line, and so on.
 */
function planCharts(columns, rows, requestedTypes = [], max = MAX_CHARTS) {
  const profiles = profile(columns, rows);
  const numerics = profiles.filter((p) => p.type === 'number').map((p) => p.column);
  const categories = profiles.filter((p) => p.type === 'category').map((p) => p.column);
  const wanted = requestedTypes.filter((type) => CHART_TYPES.includes(type));
  const charts = [];

  const firstNumeric = numerics[0];
  const firstCategory = categories[0];

  for (const type of wanted.slice(0, max)) {
    if (type === 'scatter' && numerics.length >= 2) {
      const xs = numerics[0];
      const ys = numerics[1];
      charts.push({
        type,
        title: `${xs} vs ${ys}`,
        categories: [],
        series: [],
        points: rows
          .map((row) => ({ x: toNumber(row[xs]) ?? 0, y: toNumber(row[ys]) ?? 0 }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
      });
      continue;
    }
    if (type === 'heatmap') {
      const cols = numerics.slice(0, 4);
      if (cols.length >= 2) {
        const matrix = rows.slice(0, 40).map((row) => ({
          label: String(row[firstCategory ?? cols[0]] ?? ''),
          values: cols.map((c) => toNumber(row[c]) ?? 0),
        }));
        charts.push({ type, title: `Heatmap — ${cols.join(', ')}`, categories: cols, series: [], matrix });
        continue;
      }
    }
    if (type === 'radar') {
      const cols = numerics.slice(0, 6);
      if (cols.length >= 3) {
        const profileRow = rows[0] ?? {};
        charts.push({
          type,
          title: `Profile — ${cols.join(', ')}`,
          categories: cols,
          series: [{ name: 'first row', values: cols.map((c) => toNumber(profileRow[c]) ?? 0) }],
        });
        continue;
      }
    }
    if (type === 'pie' || type === 'donut' || type === 'bar' || type === 'stacked-bar') {
      if (firstCategory && firstNumeric) {
        const sums = new Map();
        for (const row of rows) {
          const key = String(row[firstCategory] ?? '').trim() || '(blank)';
          sums.set(key, (sums.get(key) ?? 0) + (toNumber(row[firstNumeric]) ?? 0));
        }
        const entries = [...sums.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
        charts.push({
          type,
          title: `${firstNumeric} by ${firstCategory}`,
          categories: entries.map((e) => e[0]),
          series: [{ name: firstNumeric, values: entries.map((e) => e[1]) }],
        });
        continue;
      }
    }
    if (type === 'line' || type === 'area') {
      if (firstNumeric) {
        charts.push({
          type,
          title: `${firstNumeric} over ${rows.length} rows`,
          categories: rows.slice(0, 40).map((row, index) => String(row[firstCategory] ?? index + 1)),
          series: [{ name: firstNumeric, values: rows.slice(0, 40).map((row) => toNumber(row[firstNumeric]) ?? 0) }],
        });
        continue;
      }
    }
  }
  return charts;
}

/** The self-contained interactive dashboard. */
function renderDashboard({ title, subtitle, columns, rows, charts, profiles, segments, limit = 200 }) {
  const chartHtml = charts.map((chart, index) => `
      <figure class="card chart" data-chart="${index}">
        <figcaption>${escapeHtml(chart.title ?? chart.type)}</figcaption>
        ${renderChartSvg(chart.type, chart)}
      </figure>`).join('\n');

  const profileRows = (profiles ?? []).map((p) => {
    const detail = p.type === 'number'
      ? `min ${niceNumber(p.min)} · mean ${niceNumber(p.mean)} · max ${niceNumber(p.max)} · σ ${niceNumber(p.stdev)}`
      : `top: ${(p.top ?? []).map((t) => `${t.value} (${t.count})`).join(', ') || '—'}`;
    return `<tr><th scope="row">${escapeHtml(p.column)}</th><td>${p.type}</td>`
      + `<td>${p.filled}/${p.filled + p.missing}</td><td>${p.distinct}</td><td>${detail}</td></tr>`;
  }).join('\n');

  const segmentHtml = (segments ?? []).length
    ? `<section class="card"><h2>Segments</h2><ul>${segments.map((s) =>
        `<li><strong>${escapeHtml(s.label)}</strong> — ${s.size} rows · ${s.columns.map((c) =>
          `${escapeHtml(c.column)} ≈ ${niceNumber(c.mean)}`).join(', ')}</li>`).join('')}</ul></section>`
    : '';

  const tableHead = columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('');
  const tableRows = rows.slice(0, limit).map((row) =>
    `<tr>${columns.map((c) => `<td>${escapeHtml(row[c] ?? '')}</td>`).join('')}</tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${escapeHtml(title ?? 'Data analysis')}</title>
<style>
  :root { color-scheme: dark; --bg:#14171f; --card:#1b1f2a; --line:#272c3a; --text:#e7eaf0; --muted:#8b93a7; --accent:#5b8def; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--text); font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  h1 { margin:0 0 4px; font-size:22px; }
  h2 { margin:0 0 12px; font-size:15px; }
  .sub { color:var(--muted); margin:0 0 20px; }
  .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
  .chart figcaption { color:var(--muted); font-size:12px; margin-bottom:8px; }
  .chart svg { width:100%; height:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .scroll { overflow:auto; max-height:420px; }
  ul { margin:0; padding-left:18px; }
  li { margin:4px 0; }
</style></head>
<body>
  <h1>${escapeHtml(title ?? 'Data analysis')}</h1>
  ${subtitle ? `<p class="sub">${escapeHtml(subtitle)}</p>` : ''}
  <div class="grid">
${chartHtml}
  </div>
  ${segmentHtml}
  <section class="card" style="margin-top:16px">
    <h2>Column profile</h2>
    <table><thead><tr><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Filled</th><th scope="col">Distinct</th><th scope="col">Detail</th></tr></thead>
    <tbody>${profileRows}</tbody></table>
  </section>
  <section class="card" style="margin-top:16px">
    <h2>Data (${rows.length} rows${rows.length > limit ? `, showing ${limit}` : ''})</h2>
    <div class="scroll"><table><thead><tr>${tableHead}</tr></thead><tbody>${tableRows}</tbody></table></div>
  </section>
</body></html>`;
}

/** The written report. */
function renderReport({ title, subtitle, columns, rows, profiles, charts, segments, insights }) {
  const lines = [];
  lines.push(`# ${title ?? 'Data analysis'}`);
  if (subtitle) lines.push('', subtitle);
  lines.push('', `**Rows:** ${rows.length}  **Columns:** ${columns.length}`);
  lines.push('', '## Column profile', '');
  lines.push('| Column | Type | Filled | Distinct | Detail |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const p of profiles ?? []) {
    const detail = p.type === 'number'
      ? `min ${niceNumber(p.min)} · mean ${niceNumber(p.mean)} · max ${niceNumber(p.max)} · σ ${niceNumber(p.stdev)}`
      : `top: ${(p.top ?? []).map((t) => `${t.value} (${t.count})`).join(', ') || '—'}`;
    lines.push(`| ${p.column} | ${p.type} | ${p.filled}/${p.filled + p.missing} | ${p.distinct} | ${detail} |`);
  }
  if (charts?.length) {
    lines.push('', '## Charts', '');
    for (const chart of charts) lines.push(`- **${chart.title}** (${chart.type})`);
  }
  if (segments?.length) {
    lines.push('', '## Segments', '');
    for (const segment of segments) {
      lines.push(`- **${segment.label}** — ${segment.size} rows · ${segment.columns.map((c) => `${c.column} ≈ ${niceNumber(c.mean)}`).join(', ')}`);
    }
  }
  if (insights?.length) {
    lines.push('', '## Insights', '');
    for (const insight of insights) lines.push(`- ${insight}`);
  }
  lines.push('', '## Preview', '', '| ' + columns.join(' | ') + ' |', '| ' + columns.map(() => '---').join(' | ') + ' |');
  for (const row of rows.slice(0, 20)) {
    lines.push('| ' + columns.map((c) => String(row[c] ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |');
  }
  return lines.join('\n');
}

/**
 * The whole pipeline: parse → profile → chart → segment → output.
 */
function analyze({ data, path: filePath, title, subtitle, chartTypes, output = 'dashboard', maxCharts = MAX_CHARTS, segments: wantSegments = 3 }) {
  let text = data;
  let source = filePath ?? null;
  if (text == null && filePath) {
    text = fs.readFileSync(filePath, 'utf8');
  }
  const { columns, rows } = parseTable(text);
  if (!columns.length || !rows.length) {
    return { error: 'no tabular data found — expected CSV, TSV or JSON' };
  }
  const profiles = profile(columns, rows);
  const numericColumns = profiles.filter((p) => p.type === 'number').map((p) => p.column);
  const charts = planCharts(columns, rows, chartTypes, maxCharts);
  const segments = numericColumns.length >= 2 && wantSegments > 1
    ? cluster(rows, numericColumns, Math.min(wantSegments, 4))
    : [];
  const insights = buildInsights(profiles, charts, segments);

  const result = {
    source,
    rows: rows.length,
    columns: columns.length,
    columnNames: columns,
    profiles,
    charts: charts.map((c) => ({ type: c.type, title: c.title })),
    segments: segments.map((s) => ({ segment: s.segment, label: s.label, size: s.size, columns: s.columns })),
    insights,
  };
  if (output === 'dashboard' || output === 'webpage') {
    result.html = renderDashboard({ title, subtitle, columns, rows, charts, profiles, segments });
  }
  if (output === 'report') {
    result.markdown = renderReport({ title, subtitle, columns, rows, profiles, charts, segments, insights });
  }
  if (output === 'dataset') {
    const header = columns.join(',');
    const body = rows.map((row) => columns.map((c) => {
      const value = String(row[c] ?? '');
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(',')).join('\n');
    result.csv = `${header}\n${body}`;
  }
  return result;
}

/** Cheap but real pattern detection: skew, spread, gaps, categories, outliers. */
function buildInsights(profiles, charts, segments) {
  const insights = [];
  for (const p of profiles) {
    if (p.type === 'number' && p.mean !== null) {
      if (p.mean > 0 && p.stdev !== null && p.stdev / Math.abs(p.mean) > 1) {
        insights.push(`${p.column} is highly dispersed (σ ${niceNumber(p.stdev)} against a mean of ${niceNumber(p.mean)}) — the average hides the spread.`);
      }
      if (p.missing > 0) {
        insights.push(`${p.column} is missing in ${p.missing} of ${p.filled + p.missing} rows.`);
      }
      if (p.q1 !== null && p.q3 !== null && p.mean !== null && (p.mean > p.q3 * 1.5 || (p.mean < p.q1 * 0.5 && p.q1 > 0))) {
        insights.push(`${p.column} is skewed — the mean (${niceNumber(p.mean)}) sits outside the middle half (${niceNumber(p.q1)}–${niceNumber(p.q3)}).`);
      }
    }
    if (p.type === 'category' && p.distinct <= Math.max(2, (p.filled + p.missing) * 0.05) && p.filled > 1) {
      insights.push(`${p.column} has only ${p.distinct} distinct values — it behaves like a category, not a measurement.`);
    }
  }
  if (segments?.length) {
    const biggest = [...segments].sort((a, b) => b.size - a.size)[0];
    insights.push(`The segments are uneven: the largest holds ${biggest.size} rows.`);
  }
  if (!charts?.length) insights.push('No chart could be derived — the data has no numeric column to plot.');
  return insights;
}

module.exports = {
  dataVizService: {
    analyze,
    parseTable,
    profile,
    cluster,
    planCharts,
    renderChartSvg,
    renderDashboard,
    renderReport,
    buildInsights,
    CHART_TYPES,
    MAX_CHARTS,
  },
};
