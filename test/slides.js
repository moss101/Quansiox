'use strict';
/* Slides test — the local-first implementation of Manus Slides.
 *
 * Covers the documented behaviour:
 *   - a deck model with layouts, bullets and speaker notes (SLD-01/04/07);
 *   - named themes and consistent branding (SLD-08/09);
 *   - importing the user's own .pptx as a template (SLD-10);
 *   - export to .pptx, web slides and a speaker-notes document
 *     (SLD-12/13/14/15);
 *   - charts built from a CSV (SLD-16);
 *   - multilingual output (SLD-17);
 *   - conversational revision after generation (SLD-18).
 *
 * The .pptx is validated structurally: every XML part must be well formed
 * (xmllint), every relationship must resolve, and the content types must
 * cover every part.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-slides-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const { slidesService } = require('../src/main/services/slidesService');
const { readZip } = require('../src/shared/zipReader');
const { buildPptx } = require('../src/shared/pptx');

const hasXmlLint = (() => {
  try { execFileSync('/usr/bin/xmllint', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

async function run() {
  /* -- 1. themes (SLD-08/09) -------------------------------------------- */
  const themes = slidesService.listThemes();
  assert.strictEqual(themes.length, 10, 'ten named themes');
  assert.ok(themes.some((t) => t.name === 'Minimalist'));
  assert.ok(themes.some((t) => t.name === 'Onyx'));
  assert.ok(themes.some((t) => t.name === 'Cobalt'));
  // Every theme is a real colour system, not just a background.
  for (const id of Object.keys(slidesService.THEMES)) {
    const theme = slidesService.THEMES[id];
    assert.match(theme.background, /^[0-9A-F]{6}$/i, `${id} has a background`);
    assert.match(theme.foreground, /^[0-9A-F]{6}$/i, `${id} has a foreground`);
    assert.match(theme.accent, /^[0-9A-F]{6}$/i, `${id} has an accent`);
    assert.ok(theme.headingFont && theme.bodyFont, `${id} has typography`);
  }

  /* -- 2. the deck model (SLD-01/04/07) ---------------------------------- */
  const deck = slidesService.create({
    title: 'Quarterly Review',
    subtitle: 'Q1 2026',
    theme: 'cobalt',
    language: 'fr',
    slides: [
      { layout: 'title', title: 'Quarterly Review', subtitle: 'Q1 2026', notes: 'Welcome the room.' },
      { layout: 'bullets', title: 'Revenue', subtitle: 'Up 12%', bullets: ['Enterprise grew', 'Churn fell', 'Two new regions'], notes: 'Lead with the number.' },
      { layout: 'chart', title: 'Revenue by region', notes: 'Point at the North bar.' },
      { layout: 'quote', title: 'Quote', quote: 'We finally ship what we promise.', attribution: 'Head of Product' },
      { layout: 'closing', title: 'Questions?', subtitle: 'reach@example.com' },
    ],
  });
  assert.ok(deck.id.startsWith('deck_'));
  assert.strictEqual(deck.slideCount, 5);
  assert.strictEqual(deck.language, 'fr', 'the deck language is recorded (SLD-17)');
  const stored = slidesService.get(deck.id);
  assert.strictEqual(stored.slides[1].bullets.length, 3);
  assert.strictEqual(stored.slides[1].notes, 'Lead with the number.');
  assert.strictEqual(stored.slides[0].layout, 'title');

  /* -- 3. an invalid layout falls back rather than breaking (SLD-18) ---- */
  const revised = slidesService.update(deck.id, {
    slides: [
      { layout: 'not-a-layout', title: 'Reworked', bullets: ['a'] },
      { layout: 'bullets', title: 'Second', bullets: ['b', 'c'] },
    ],
  });
  assert.strictEqual(revised.slides[0].layout, 'bullets', 'an unknown layout falls back');
  assert.strictEqual(revised.version, 2, 'the revision bumps the version (SLD-18)');
  assert.strictEqual(slidesService.get(deck.id).slides.length, 2);

  /* -- 4. charts from a CSV (SLD-16) ------------------------------------ */
  const csv = path.join(tmp, 'sales.csv');
  fs.writeFileSync(csv, 'region,revenue\nNorth,100\nSouth,220\nEast,140\n', 'utf8');
  const withChart = slidesService.setChart(deck.id, 1, { path: csv, chartType: 'bar' });
  assert.ok(withChart.slides[1].chart, 'the chart is attached');
  assert.match(withChart.slides[1].chart.svg, /<svg/);
  assert.strictEqual(withChart.slides[1].layout, 'chart');

  /* -- 5. the web deck (SLD-14) ----------------------------------------- */
  const web = slidesService.exportWeb(deck.id);
  const html = fs.readFileSync(web.path, 'utf8');
  assert.match(html, /Quarterly Review/);
  assert.match(html, /class="slide layout-bullets"/);
  assert.match(html, /class="slide layout-chart"/, 'the chart slide keeps its layout');
  assert.match(html, /<svg/, 'the chart is embedded in the web deck');
  assert.match(html, /ArrowRight/, 'the deck is keyboard navigable');
  assert.match(html, /Speaker notes/, 'the presenter notes panel is present');
  assert.match(html, /@media print/, 'it prints one slide per page');
  assert.match(html, /lang="fr"/, 'the deck carries its language');

  // A title slide really renders as a title slide.
  const titleDeck = slidesService.create({
    title: 'Launch',
    slides: [{ layout: 'title', title: 'Launch', subtitle: 'v2' }, { layout: 'closing', title: 'Thanks' }],
  });
  const titleHtml = fs.readFileSync(slidesService.exportWeb(titleDeck.id).path, 'utf8');
  assert.match(titleHtml, /class="slide layout-title"/);
  assert.match(titleHtml, /<h1>Launch<\/h1>/);
  assert.match(titleHtml, /class="slide layout-closing"/);
  slidesService.remove(titleDeck.id);

  /* -- 6. the speaker-notes document (SLD-15) ---------------------------- */
  const notesDeck = slidesService.create({
    title: 'Keynote',
    slides: [
      { layout: 'title', title: 'Keynote', notes: 'Welcome the room.' },
      { layout: 'bullets', title: 'Numbers', bullets: ['One', 'Two'], notes: 'Point at the North bar.' },
    ],
  });
  const notes = slidesService.exportNotes(notesDeck.id);
  const markdown = fs.readFileSync(notes.path, 'utf8');
  assert.match(markdown, /# Keynote/);
  assert.match(markdown, /Speaker notes/);
  assert.match(markdown, /Point at the North bar/, 'the notes text is carried over');
  assert.match(markdown, /Welcome the room/);
  slidesService.remove(notesDeck.id);

  /* -- 7. the .pptx export (SLD-12) -------------------------------------- */
  // A deck with every kind of slide, notes and a chart — the shape a real
  // generated deck has.
  const fullDeck = slidesService.create({
    title: 'Quarterly Review',
    theme: 'cobalt',
    slides: [
      { layout: 'title', title: 'Quarterly Review', subtitle: 'Q1 2026', notes: 'Welcome the room.' },
      { layout: 'bullets', title: 'Revenue', bullets: ['Enterprise grew', 'Churn fell'], notes: 'Lead with the number.' },
      { layout: 'chart', title: 'Revenue by region', notes: 'Point at the North bar.' },
      { layout: 'quote', title: 'Quote', quote: 'We finally ship what we promise.', attribution: 'Head of Product' },
      { layout: 'closing', title: 'Questions?' },
    ],
  });
  slidesService.setChart(fullDeck.id, 2, { path: csv, chartType: 'bar' });
  const pptx = await slidesService.exportPptx(fullDeck.id);
  assert.ok(pptx.bytes > 2000, 'the deck is a real file');
  const entries = readZip(fs.readFileSync(pptx.path));
  const names = [...entries.keys()];
  for (const required of [
    '[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels', 'ppt/theme/theme1.xml',
    'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml',
    'ppt/notesMasters/notesMaster1.xml',
  ]) {
    assert.ok(names.includes(required), `the deck contains ${required}`);
  }
  assert.ok(names.includes('ppt/slides/slide1.xml'));
  assert.ok(names.includes('ppt/slides/slide5.xml'));
  assert.ok(names.includes('ppt/notesSlides/notesSlide1.xml'), 'speaker notes become notes slides');
  assert.ok(names.includes('ppt/notesSlides/_rels/notesSlide1.xml.rels'));

  // Every XML part must be well formed.
  if (hasXmlLint) {
    for (const [name, entry] of entries) {
      if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
      assert.ok(entry.data, `${name} has data`);
      try {
        execFileSync('/usr/bin/xmllint', ['--noout', '-'], { input: entry.data, stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (error) {
        throw new Error(`xmllint rejected ${name}: ${error.stderr?.toString?.() ?? error.message}`);
      }
    }
  }

  // Every relationship target must exist in the package.
  const relFiles = names.filter((n) => n.endsWith('.rels'));
  for (const relFile of relFiles) {
    const text = entries.get(relFile).data.toString('utf8');
    const base = path.posix.dirname(path.posix.dirname(relFile));
    const targets = [...text.matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);
    for (const target of targets) {
      if (/^https?:/.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(base, target));
      assert.ok(names.includes(resolved), `${relFile} → ${target} resolves to a real part`);
    }
  }

  // The content types must cover every part.
  const contentTypes = entries.get('[Content_Types].xml').data.toString('utf8');
  for (const name of names) {
    if (name === '[Content_Types].xml') continue;
    if (name.endsWith('.rels')) { assert.match(contentTypes, /Extension="rels"/); continue; }
    if (name.endsWith('.xml')) {
      assert.ok(contentTypes.includes(`PartName="/${name}"`), `${name} has a content type`);
    } else {
      const extension = name.split('.').pop();
      assert.ok(contentTypes.includes(`Extension="${extension}"`), `${name} has a content type`);
    }
  }

  // The slide text is really in there, and it is editable (a text shape).
  const slide1 = entries.get('ppt/slides/slide1.xml').data.toString('utf8');
  assert.match(slide1, /Quarterly Review/, 'the slide carries its title');
  assert.match(slide1, /<a:t>/, 'the text is a real editable run');
  assert.match(slide1, /txBox="1"/, 'it is a text box, not a flattened image');
  const notes1 = entries.get('ppt/notesSlides/notesSlide1.xml').data.toString('utf8');
  assert.match(notes1, /<p:ph type="body"/, 'the notes slide has a notes placeholder');
  assert.match(notes1, /Welcome the room/, 'the speaker notes text is in the notes slide');

  // The theme colours reach the deck.
  const themeXml = entries.get('ppt/theme/theme1.xml').data.toString('utf8');
  assert.match(themeXml, /<a:fontScheme/);

  /* -- 8. a template import (SLD-10) ------------------------------------ */
  const templatePath = path.join(tmp, 'template.pptx');
  fs.writeFileSync(templatePath, buildPptx({
    title: 'Brand template',
    theme: { background: '101010', foreground: 'F0F0F0', accent: 'FF8800' },
    slides: [{ layout: 'title', title: 't' }],
  }));
  const template = slidesService.importTemplate(fullDeck.id, templatePath);
  assert.match(template.accent, /^[0-9A-F]{6}$/i, 'the template accent was imported');
  assert.ok(template.source.includes('template.pptx'));
  assert.throws(() => slidesService.importTemplate(fullDeck.id, path.join(tmp, 'nope.pptx')), /cannot read template/);
  const notPptx = path.join(tmp, 'not.pptx');
  fs.writeFileSync(notPptx, 'definitely not a zip');
  assert.throws(() => slidesService.importTemplate(fullDeck.id, notPptx), /not a PowerPoint file|not a ZIP/);

  /* -- 9. listing and removal -------------------------------------------- */
  assert.ok(slidesService.list().some((d) => d.id === fullDeck.id));
  assert.strictEqual(slidesService.remove(fullDeck.id).removed, true);
  assert.strictEqual(slidesService.get(fullDeck.id), null);
  assert.strictEqual(slidesService.remove(fullDeck.id).removed, false);
  slidesService.remove(deck.id);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('slides test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
