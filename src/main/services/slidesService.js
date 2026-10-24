'use strict';
/**
 * Slides — the local-first implementation of Manus' "Manus Slides".
 *
 * The docs describe a deck generator that researches, structures a
 * narrative, designs the layouts, writes **speaker notes for every slide**,
 * applies consistent branding, uses pre-built themes, imports a user's own
 * `.pptx` as a template, and exports to `.pptx`, PDF, interactive web slides
 * and a standalone speaker-notes document — with conversational revision
 * afterwards.
 *
 * What is genuinely local (and therefore what this module owns):
 *
 *   - the **deck model** — slides, layouts, bullets, notes, visuals;
 *   - the **themes** — a named set with a real colour/typography system;
 *   - the **exports**:
 *       · `.pptx` — real Open XML, editable in PowerPoint/Keynote/Slides;
 *       · `.pdf`  — through the existing offscreen render service;
 *       · web slides — a self-contained interactive HTML deck;
 *       · speaker notes — a standalone document;
 *   - the **template import** — reading the theme out of a user's `.pptx`;
 *   - **charts** from a CSV, rendered as real SVG by `dataVizService`.
 *
 * What is NOT local: the research and the writing. Those are the agent's
 * job — it fills the deck model through the `slides` tool, and this module
 * renders and stores what the agent produced.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { buildPptx, buildSlideShapes } = require('../../shared/pptx');
const { readZip, readText } = require('../../shared/zipReader');

/* ------------------------------------------------------------------ themes */

/**
 * The named themes. The names match the ones the product shows in its
 * "Select a theme" strip; each one is a real colour and typography system,
 * not just a background colour.
 */
const THEMES = {
  minimalist: {
    name: 'Minimalist', background: 'FFFFFF', foreground: '16181D', accent: '2F6FEB',
    secondary: '8A93A5', headingFont: 'Calibri Light', bodyFont: 'Calibri',
  },
  onyx: {
    name: 'Onyx', background: '101317', foreground: 'F2F4F8', accent: '7AA2F7',
    secondary: '5C6472', headingFont: 'Calibri Light', bodyFont: 'Calibri',
  },
  ginkgo: {
    name: 'Ginkgo', background: 'F4F8F1', foreground: '1E2B1C', accent: '2F8F5B',
    secondary: '86A883', headingFont: 'Calibri Light', bodyFont: 'Calibri',
  },
  basalt: {
    name: 'Basalt', background: '1C1F24', foreground: 'EDEFF3', accent: 'E2833C',
    secondary: '6C7178', headingFont: 'Calibri Light', bodyFont: 'Calibri',
  },
  patina: {
    name: 'Patina', background: 'EAF2F0', foreground: '17322E', accent: '1F8A7A',
    secondary: '84A9A3', headingFont: 'Calibri Light', bodyFont: 'Calibri',
  },
  emerald: {
    name: 'Emerald', background: '06231C', foreground: 'E8FFF7', accent: '34D399',
    secondary: '2E6F5E', headingFont: 'Calibri Light', bodyFont: 'Calibri',
  },
  amber: {
    name: 'Amber', background: '2A1F0B', foreground: 'FFF6E6', accent: 'F5B944',
    secondary: '8A6E3C', headingFont: 'Calibri Light', bodyFont: 'Calibri',
  },
  alabaster: {
    name: 'Alabaster', background: 'FAF7F0', foreground: '2B2721', accent: 'B08968',
    secondary: 'A79E92', headingFont: 'Calibri Light', bodyFont: 'Calibri',
  },
  cobalt: {
    name: 'Cobalt', background: '0B1E3D', foreground: 'EAF1FF', accent: '4F8EF7',
    secondary: '35548C', headingFont: 'Calibri Light', bodyFont: 'Calibri',
  },
  sand: {
    name: 'Sand', background: 'F5EFE3', foreground: '3A3227', accent: 'C98A3C',
    secondary: 'A9997F', headingFont: 'Calibri Light', bodyFont: 'Calibri',
  },
};

const LAYOUTS = ['title', 'section', 'bullets', 'two-column', 'chart', 'quote', 'closing'];

/* ------------------------------------------------------------------ store */

function userDataDir() {
  return require('./userData').userDataDir();
}
function decksDir() { return path.join(userDataDir(), 'slides'); }
function deckFile(id) {
  if (!/^deck_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('invalid deck id');
  return path.join(decksDir(), `${id}.json`);
}
function exportsDir(id) { return path.join(decksDir(), id, 'exports'); }

function newId() { return `deck_${crypto.randomBytes(9).toString('base64url')}`; }

function load(id) {
  try {
    return JSON.parse(fs.readFileSync(deckFile(id), 'utf8'));
  } catch {
    return null;
  }
}
function save(deck) {
  fs.mkdirSync(decksDir(), { recursive: true });
  fs.writeFileSync(deckFile(deck.id), JSON.stringify(deck, null, 2), { mode: 0o600 });
  return deck;
}

/** The public shape of a deck — the export paths are not included. */
function reduced(deck) {
  if (!deck) return null;
  const { exports, ...rest } = deck;
  return { ...rest, exports: exports ?? {}, slideCount: (deck.slides ?? []).length };
}

/* ------------------------------------------------------------------ model */

function normalizeSlide(input = {}, index = 0) {
  const layout = LAYOUTS.includes(input.layout) ? input.layout : 'bullets';
  const bullets = (Array.isArray(input.bullets) ? input.bullets : [])
    .map((b) => String(b ?? '').trim())
    .filter(Boolean)
    .slice(0, 24);
  return {
    id: String(input.id ?? `slide_${index + 1}`).slice(0, 64),
    layout,
    title: String(input.title ?? '').slice(0, 300),
    subtitle: input.subtitle ? String(input.subtitle).slice(0, 400) : '',
    bullets,
    quote: input.quote ? String(input.quote).slice(0, 800) : '',
    attribution: input.attribution ? String(input.attribution).slice(0, 200) : '',
    notes: input.notes ? String(input.notes).slice(0, 8000) : '',
    chartTitle: input.chartTitle ? String(input.chartTitle).slice(0, 200) : '',
    chart: input.chart ?? null,
    image: input.image ?? null,
    imageName: input.imageName ?? null,
  };
}

/**
 * Create a deck.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} spec.subtitle
 * @param {string} spec.theme       a theme id from THEMES
 * @param {string} spec.language    a BCP-47 tag, for multilingual output
 * @param {Array}  spec.slides
 */
function create(spec = {}) {
  const themeId = THEMES[spec.theme] ? spec.theme : 'minimalist';
  const now = Date.now();
  const deck = {
    id: spec.id && /^deck_[A-Za-z0-9_-]{1,64}$/.test(String(spec.id)) ? String(spec.id) : newId(),
    title: String(spec.title ?? 'Untitled deck').slice(0, 200),
    subtitle: spec.subtitle ? String(spec.subtitle).slice(0, 400) : '',
    theme: themeId,
    language: String(spec.language ?? 'en').slice(0, 16),
    author: spec.author ? String(spec.author).slice(0, 120) : 'Quansiox',
    slides: (Array.isArray(spec.slides) ? spec.slides : []).map(normalizeSlide),
    template: spec.template ?? null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    exports: {},
  };
  save(deck);
  return reduced(deck);
}

function get(id) {
  return reduced(load(id));
}

function list() {
  try {
    return fs.readdirSync(decksDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => reduced(load(f.slice(0, -5))))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  } catch {
    return [];
  }
}

/**
 * Update a deck — this is the conversational-revision path (SLD-18): the
 * agent changes the model and re-renders, rather than regenerating from
 * scratch.
 */
function update(id, patch = {}) {
  const deck = load(id);
  if (!deck) throw new Error('deck not found');
  if (patch.title !== undefined) deck.title = String(patch.title).slice(0, 200);
  if (patch.subtitle !== undefined) deck.subtitle = String(patch.subtitle).slice(0, 400);
  if (patch.theme !== undefined && THEMES[patch.theme]) deck.theme = patch.theme;
  if (patch.language !== undefined) deck.language = String(patch.language).slice(0, 16);
  if (Array.isArray(patch.slides)) deck.slides = patch.slides.map(normalizeSlide);
  deck.updatedAt = Date.now();
  deck.version = (deck.version ?? 1) + 1;
  // A changed deck invalidates its exports — they are re-rendered on demand.
  deck.exports = {};
  save(deck);
  return reduced(deck);
}

function remove(id) {
  const deck = load(id);
  if (!deck) return { removed: false };
  try { fs.rmSync(path.join(decksDir(), id), { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(deckFile(id), { force: true }); } catch { /* best effort */ }
  return { removed: true, id };
}

/* --------------------------------------------------------------- exports */

/** The effective theme object for a deck. */
function themeFor(deck) {
  return { ...(THEMES[deck.theme] ?? THEMES.minimalist), ...(deck.template ?? {}) };
}

function safeFileName(text) {
  return String(text ?? 'deck').replace(/[^A-Za-z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'deck';
}

/**
 * Export a deck as a `.pptx`.
 *
 * Charts are rasterised to PNG through the offscreen render service first:
 * PowerPoint's support for a bare SVG picture part is unreliable, and a PNG
 * is what every reader handles. When no renderer is available (a headless
 * test, for example) the picture is simply left out and the slide keeps its
 * title — the deck is still valid.
 *
 * @returns {Promise<{path: string, bytes: number}>}
 */
async function exportPptx(id) {
  const deck = load(id);
  if (!deck) throw new Error('deck not found');
  const theme = themeFor(deck);
  const images = [];
  const slides = [];
  for (const slide of deck.slides ?? []) {
    const shapes = buildSlideShapes(slide, theme);
    const names = [];
    if (slide.chart?.svg) {
      const png = await rasterizeChart(slide);
      if (png) {
        const name = `${slide.id}.png`;
        images.push({ name, data: png, extension: 'png' });
        names.push(name);
        shapes.push(pictureXmlFor(slide, name, names));
      }
    }
    if (slide.image?.data && slide.imageName) {
      images.push({ name: slide.imageName, data: Buffer.from(slide.image.data), extension: slide.imageName.split('.').pop() });
      names.push(slide.imageName);
      shapes.push(pictureXmlFor(slide, slide.imageName, names));
    }
    slides.push({ ...slide, shapes, images: names, notes: slide.notes });
  }
  const buffer = buildPptx({
    title: deck.title,
    author: deck.author,
    theme,
    slides,
    images,
  });
  const dir = exportsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeFileName(deck.title)}.pptx`);
  fs.writeFileSync(file, buffer);
  const result = { path: file, bytes: buffer.length };
  recordExport(deck, 'pptx', result);
  return result;
}

/**
 * Rasterise a chart SVG to PNG through the offscreen renderer.
 * @returns {Promise<Buffer|null>}
 */
async function rasterizeChart(slide) {
  try {
    const { renderService } = require('./renderService');
    const dir = exportsDir('tmp');
    fs.mkdirSync(dir, { recursive: true });
    const svgPath = path.join(dir, `${slide.id}.svg`);
    const pngPath = path.join(dir, `${slide.id}.png`);
    fs.writeFileSync(svgPath, slide.chart.svg, 'utf8');
    const result = await renderService.renderPng({ input: svgPath, output: pngPath, scale: 2 });
    const file = result?.path ?? pngPath;
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}

/** A picture shape for a slide's visual. */
function pictureXmlFor(slide, imageName, names) {
  const { pictureXml } = require('../../shared/pptx');
  const index = (names ?? []).indexOf(imageName);
  return pictureXml({
    id: 900 + index,
    name: imageName,
    x: 1.2,
    y: 1.8,
    w: 11,
    h: 4.6,
    relId: `rId${2 + index}`,
  });
}

/** The interactive web slides: one self-contained HTML file. */
function exportWeb(id) {
  const deck = load(id);
  if (!deck) throw new Error('deck not found');
  const theme = themeFor(deck);
  const html = renderWebDeck(deck, theme);
  const dir = exportsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeFileName(deck.title)}-slides.html`);
  fs.writeFileSync(file, html, 'utf8');
  const result = { path: file, bytes: Buffer.byteLength(html) };
  recordExport(deck, 'web', result);
  return result;
}

/** The standalone speaker-notes document. */
function exportNotes(id) {
  const deck = load(id);
  if (!deck) throw new Error('deck not found');
  const theme = themeFor(deck);
  const lines = [`# ${deck.title}`, ''];
  if (deck.subtitle) lines.push(`_${deck.subtitle}_`, '');
  (deck.slides ?? []).forEach((slide, index) => {
    lines.push(`## ${index + 1}. ${slide.title || '(untitled slide)'}`);
    if (slide.subtitle) lines.push(`*${slide.subtitle}*`);
    if (slide.bullets?.length) {
      lines.push('');
      for (const bullet of slide.bullets) lines.push(`- ${bullet}`);
    }
    lines.push('');
    lines.push('**Speaker notes**');
    lines.push('');
    lines.push(slide.notes?.trim() || '_No notes for this slide._');
    lines.push('');
  });
  const markdown = lines.join('\n');
  const dir = exportsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeFileName(deck.title)}-notes.md`);
  fs.writeFileSync(file, markdown, 'utf8');
  const result = { path: file, bytes: Buffer.byteLength(markdown) };
  recordExport(deck, 'notes', result);
  return result;
}

/**
 * Export a deck as PDF. The PDF is produced from the *web* deck through the
 * existing offscreen render service, so the PDF and the browser deck are the
 * same design.
 */
async function exportPdf(id, { cwd } = {}) {
  const deck = load(id);
  if (!deck) throw new Error('deck not found');
  const web = exportWeb(id);
  const { renderService } = require('./renderService');
  const dir = exportsDir(id);
  const output = path.join(dir, `${safeFileName(deck.title)}.pdf`);
  const result = await renderService.renderPdf({
    input: web.path,
    output,
    cwd: cwd ?? process.cwd(),
    landscape: true,
  });
  const out = { path: result?.path ?? output, bytes: result?.bytes ?? 0 };
  recordExport(deck, 'pdf', out);
  return out;
}

function recordExport(deck, kind, result) {
  deck.exports = { ...(deck.exports ?? {}), [kind]: result };
  deck.updatedAt = Date.now();
  save(deck);
}

/* ------------------------------------------------------------ web slides */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** One slide as HTML, following the same layout logic as the PPTX. */
function slideHtml(slide, theme, index, total) {
  const bg = theme.background ?? 'FFFFFF';
  const fg = theme.foreground ?? '1B2030';
  const accent = theme.accent ?? '5B8DEF';
  let content = '';
  if (slide.layout === 'title') {
    content = `<div class="rule"></div><h1>${escapeHtml(slide.title)}</h1>`
      + (slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : '');
  } else if (slide.layout === 'section') {
    content = `<h1 class="section">${escapeHtml(slide.title)}</h1>`;
  } else if (slide.layout === 'quote') {
    content = `<blockquote>“${escapeHtml(slide.quote || slide.title)}”</blockquote>`
      + (slide.attribution ? `<p class="attribution">— ${escapeHtml(slide.attribution)}</p>` : '');
  } else if (slide.layout === 'closing') {
    content = `<h1>${escapeHtml(slide.title)}</h1>`
      + (slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : '');
  } else if (slide.layout === 'chart') {
    content = `<h2>${escapeHtml(slide.title)}</h2>`
      + (slide.chart?.svg ? `<div class="chart">${slide.chart.svg}</div>` : '<div class="chart empty"></div>')
      + (slide.chartTitle ? `<p class="chart-title">${escapeHtml(slide.chartTitle)}</p>` : '');
  } else {
    const bullets = (slide.bullets ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join('');
    content = `<h2>${escapeHtml(slide.title)}</h2>`
      + (slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : '')
      + `<ul>${bullets}</ul>`;
  }
  return `<section class="slide layout-${escapeHtml(slide.layout ?? 'bullets')}" data-index="${index}">
  <div class="slide-inner">${content}</div>
  <footer><span class="counter">${index + 1} / ${total}</span><span class="deck-title">${escapeHtml(slide.title ?? '')}</span></footer>
</section>`;
}

/**
 * The interactive web deck: arrow-key navigation, a slide counter, a
 * presenter-notes panel (toggled with `n`), and a print stylesheet so
 * "export to PDF" from the browser gives one slide per page.
 */
function renderWebDeck(deck, theme) {
  const slides = deck.slides ?? [];
  const total = slides.length;
  const sections = slides.map((slide, index) => slideHtml(slide, theme, index, total)).join('\n');
  const notes = slides.map((slide, index) =>
    `<div class="note" data-note="${index}"><strong>${index + 1}. ${escapeHtml(slide.title ?? '')}</strong><p>${escapeHtml(slide.notes ?? 'No notes.')}</p></div>`
  ).join('\n');

  return `<!doctype html>
<html lang="${escapeHtml(deck.language ?? 'en')}"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(deck.title)}</title>
<style>
  :root {
    --bg: ${theme.background}; --fg: ${theme.foreground}; --accent: ${theme.accent};
    --secondary: ${theme.secondary};
    --heading: ${theme.headingFont ?? 'system-ui'}, system-ui, sans-serif;
    --body: ${theme.bodyFont ?? 'system-ui'}, system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background:#0b0e14; color:var(--fg); font-family:var(--body); }
  .deck { height:100%; display:grid; place-items:center; }
  .slide {
    width:min(100vw, calc(100vh * 16 / 9)); aspect-ratio:16/9;
    background:var(--bg); color:var(--fg); position:relative; overflow:hidden;
    display:none; padding:6% 7%;
  }
  .slide.is-active { display:block; }
  h1 { font-family:var(--heading); font-size:clamp(28px, 4.4vw, 60px); margin:0 0 .4em; font-weight:300; }
  h2 { font-family:var(--heading); font-size:clamp(22px, 3vw, 40px); margin:0 0 .6em; font-weight:400; }
  h1.section { color:var(--accent); margin-top:28%; }
  .subtitle { color:var(--accent); font-size:clamp(14px,1.6vw,22px); margin:0; }
  .rule { width:12%; height:5px; background:var(--accent); margin:0 0 24px; }
  ul { margin:.6em 0 0; padding-left:1.2em; font-size:clamp(14px,1.7vw,24px); line-height:1.7; }
  blockquote { font-size:clamp(20px,2.8vw,40px); font-style:italic; margin:18% 0 0; line-height:1.4; }
  .attribution { color:var(--accent); margin-top:1em; }
  .chart { margin-top:1em; }
  .chart svg { width:100%; height:auto; }
  .chart.empty { height:50%; border:1px dashed var(--secondary); border-radius:12px; }
  .chart-title { color:var(--accent); font-size:14px; margin-top:.6em; }
  footer { position:absolute; left:0; right:0; bottom:3%; display:flex; justify-content:space-between; color:var(--secondary); font-size:13px; }
  .notes { position:fixed; right:0; top:0; bottom:0; width:360px; background:#11141c; color:#e7eaf0; padding:18px; overflow:auto; display:none; border-left:1px solid #232838; }
  .notes.is-open { display:block; }
  .notes p { color:#8b93a7; line-height:1.6; }
  .notes strong { color:#e7eaf0; }
  .hint { position:fixed; left:14px; bottom:12px; color:#5c6472; font-size:12px; }
  @media print {
    @page { size: 1280px 720px; margin:0; }
    html, body { background:#fff; }
    .deck { display:block; height:auto; }
    .slide { display:block !important; page-break-after:always; width:1280px; height:720px; }
    .notes, .hint { display:none !important; }
  }
</style></head>
<body>
<div class="deck" id="deck">
${sections}
</div>
<aside class="notes" id="notes">
  <h3>Speaker notes</h3>
  ${notes}
</aside>
<p class="hint">← → navigate · N notes · F fullscreen</p>
<script>
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var notes = document.getElementById('notes');
  var current = 0;
  function show(i) {
    current = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach(function (s, n) { s.classList.toggle('is-active', n === current); });
    var note = notes.querySelector('[data-note="' + current + '"]');
    if (note) note.scrollIntoView({ block: 'nearest' });
    try { history.replaceState(null, '', '#' + (current + 1)); } catch (e) {}
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { show(current + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { show(current - 1); e.preventDefault(); }
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(slides.length - 1);
    else if (e.key === 'n' || e.key === 'N') notes.classList.toggle('is-open');
    else if (e.key === 'f' || e.key === 'F') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); }
  });
  var start = parseInt((location.hash || '#1').slice(1), 10);
  show(isNaN(start) ? 0 : start - 1);
})();
</script>
</body></html>`;
}

/* ------------------------------------------------------- template import */

/**
 * Import a user's own `.pptx` as a template: read its theme colours and
 * fonts out of `ppt/theme/theme1.xml` and use them for the deck.
 *
 * Only the theme is imported — the layouts of an arbitrary third-party deck
 * are a much larger surface, and the docs' requirement is that the template's
 * "layouts, colors and fonts" are applied, which the theme covers for
 * colour and type.
 */
function importTemplate(id, pptxPath) {
  const deck = load(id);
  if (!deck) throw new Error('deck not found');
  let buffer;
  try {
    buffer = fs.readFileSync(pptxPath);
  } catch {
    throw new Error(`cannot read template: ${pptxPath}`);
  }
  const entries = readZip(buffer);
  const themeXmlText = readText(entries, 'ppt/theme/theme1.xml');
  if (!themeXmlText) throw new Error('not a PowerPoint file (no ppt/theme/theme1.xml)');

  const colours = {};
  const colourRe = /<a:(dk1|lt1|dk2|lt2|accent[1-6])>(?:<a:(?:srgbClr|sysClr)[^>]*?(?:val|lastClr)="([0-9A-Fa-f]{6})")/g;
  let match;
  while ((match = colourRe.exec(themeXmlText)) !== null) {
    colours[match[1]] = match[2].toUpperCase();
  }
  const fontRe = /<a:(majorFont|minorFont)><a:latin typeface="([^"]*)"/g;
  const fonts = {};
  while ((match = fontRe.exec(themeXmlText)) !== null) fonts[match[1]] = match[2];

  const base = THEMES[deck.theme] ?? THEMES.minimalist;
  deck.template = {
    name: path.basename(pptxPath),
    background: colours.dk2 ?? colours.lt2 ?? base.background,
    foreground: colours.lt1 ?? base.foreground,
    accent: colours.accent1 ?? base.accent,
    secondary: colours.accent2 ?? base.secondary,
    headingFont: fonts.majorFont || base.headingFont,
    bodyFont: fonts.minorFont || base.bodyFont,
    source: pptxPath,
    importedAt: Date.now(),
  };
  deck.updatedAt = Date.now();
  save(deck);
  return deck.template;
}

/* -------------------------------------------------------------- charts */

/**
 * Attach a chart to a slide, built from a CSV/TSV dataset.
 * The chart is a real SVG, produced by the data-visualization service.
 */
function setChart(id, slideIndex, { data, path: dataPath, chartType = 'bar', title } = {}) {
  const deck = load(id);
  if (!deck) throw new Error('deck not found');
  const slide = deck.slides?.[slideIndex];
  if (!slide) throw new Error('slide not found');
  const { dataVizService } = require('./dataVizService');
  const analysis = dataVizService.analyze({
    data,
    path: dataPath,
    chartTypes: [chartType],
    output: 'dashboard',
  });
  if (analysis.error) throw new Error(analysis.error);
  const chart = analysis.charts?.[0];
  if (!chart) throw new Error('no chart could be built from that data');
  // Rebuild the single chart as SVG.
  const { columns, rows } = dataVizService.parseTable(
    data ?? fs.readFileSync(dataPath, 'utf8')
  );
  const planned = dataVizService.planCharts(columns, rows, [chartType], 1);
  const svg = planned[0]
    ? dataVizService.renderChartSvg(planned[0].type, planned[0])
    : '';
  slide.chart = { type: chartType, title: title ?? chart.title, svg };
  slide.chartTitle = title ?? chart.title;
  slide.layout = 'chart';
  deck.updatedAt = Date.now();
  save(deck);
  return reduced(deck);
}

module.exports = {
  slidesService: {
    THEMES,
    LAYOUTS,
    listThemes: () => Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name })),
    create,
    get,
    list,
    update,
    remove,
    exportPptx,
    exportWeb,
    exportNotes,
    exportPdf,
    importTemplate,
    setChart,
    renderWebDeck,
    themeFor,
    // exported for tests
    _load: load,
    _reduced: reduced,
  },
};
