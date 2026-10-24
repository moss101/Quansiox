'use strict';
/* Design-token drift tripwire + vocabulary-coverage baseline.
 *
 * Two facts are pinned here, both regenerable — no session notes:
 *
 * 1. Byte drift: src/renderer/grok-tokens.css is GENERATED from Grok Bot's
 *    shipped bundle. If a Grok update lands (new asar extraction, new
 *    resolver output) and the generator produces different bytes, this test
 *    fails — a design re-baseline must be a deliberate commit, never a
 *    silent side effect of publishing the extraction.
 *
 * 2. Vocabulary coverage: which custom properties Grok's shipped CSS
 *    defines vs which Quansiox's renderer CSS defines. The numbers quoted
 *    in docs/parity come from the committed baseline
 *    (test/fixtures/vocabulary-baseline.json); this check proves they are
 *    still true on every run and prints them.
 *
 * Vocabulary methodology (recorded here AND inside the baseline file):
 *   - Grok side: every custom-property DEFINITION (`--name:`) in the
 *     shipped CSS bundle that scripts/extract-grok-tokens.js reads (i.e.
 *     findGrokCss()). Definition sites anywhere count: :root, hashed
 *     selectors, keyframes.
 *   - Quansiox side: every custom-property definition in any *.css under
 *     src/renderer/ (recursive).
 *   - Tiers:
 *       required — `--sand-*` and `--cursor-*`: the token namespaces the
 *                  generated token layer owns. Every Grok-defined name must
 *                  be defined by Quansiox (minus explicit waivers, none
 *                  currently).
 *       tracked  — every other name Grok defines (app-level component
 *                  knobs: --conversation-*, --agent-transcript-*, …).
 *                  Counted, not required; the baseline is the burn-down
 *                  ledger.
 *       extra    — names Quansiox defines that Grok does not (approximation
 *                  leftovers). Counted, pinned, burned down deliberately.
 *   - A Grok bundle change (new hashed filename) fails this check too —
 *     re-extraction is a re-baseline event.
 *
 * Update the baseline deliberately:
 *   node test/design-drift.js --update-vocabulary-baseline
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { findGrokCss, findThemes, main } = require('../scripts/extract-grok-tokens.js');

const BASELINE = path.join(__dirname, 'fixtures', 'vocabulary-baseline.json');
const RENDERER_CSS_DIR = path.join(ROOT, 'src', 'renderer');
const TOKEN_PREFIXES = ['--sand-', '--cursor-'];
const DEF_RE = /--[A-Za-z][\w-]*\s*:/g;

function definedNames(cssText) {
  const names = new Set();
  for (const match of cssText.matchAll(DEF_RE)) {
    names.add(match[0].replace(/\s*:$/, ''));
  }
  return names;
}

function grokVocabulary() {
  const cssPath = findGrokCss();
  assert.ok(cssPath && fs.existsSync(cssPath), 'shipped Grok CSS not findable — re-extract app.asar');
  return { source: path.basename(cssPath), names: definedNames(fs.readFileSync(cssPath, 'utf8')) };
}

function quansioxVocabulary() {
  const names = new Set();
  const stack = [RENDERER_CSS_DIR];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.css')) {
        for (const name of definedNames(fs.readFileSync(full, 'utf8'))) names.add(name);
      }
    }
  }
  return names;
}

function computeVocabularyCoverage() {
  const grok = grokVocabulary();
  const ours = quansioxVocabulary();
  const missing = [...grok.names].filter((n) => !ours.has(n)).sort();
  const extra = [...ours].filter((n) => !grok.names.has(n)).sort();
  const requiredMissing = missing.filter((n) => TOKEN_PREFIXES.some((p) => n.startsWith(p)));
  return {
    methodology:
      'Custom-property DEFINITIONS (`--name:`) in the Grok shipped CSS bundle read by ' +
      'scripts/extract-grok-tokens.js vs definitions in every src/renderer/**/*.css. ' +
      'required = --sand-*/--cursor-* (must exist in Quansiox); tracked = other Grok-defined ' +
      'names (burn-down ledger); extra = Quansiox-defined names Grok does not have. ' +
      'Full methodology: header of test/design-drift.js.',
    grokSource: grok.source,
    counts: {
      grokDefined: grok.names.size,
      quansioxDefined: ours.size,
      requiredMissing: requiredMissing.length,
      trackedMissing: missing.length - requiredMissing.length,
      extra: extra.length,
    },
    requiredMissing,
    trackedMissing: missing.filter((n) => !TOKEN_PREFIXES.some((p) => n.startsWith(p))),
    extra,
  };
}

if (process.argv.includes('--update-vocabulary-baseline')) {
  const coverage = computeVocabularyCoverage();
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(coverage, null, 2) + '\n');
  console.log(`vocabulary baseline updated → ${path.relative(ROOT, BASELINE)}`);
  console.log(
    `  grok ${coverage.counts.grokDefined} defined / quansiox ${coverage.counts.quansioxDefined};` +
    ` required-missing ${coverage.counts.requiredMissing},` +
    ` tracked-missing ${coverage.counts.trackedMissing}, extra ${coverage.counts.extra}`,
  );
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

check('the generator\'s sources exist (Grok CSS + resolved themes)', () => {
  const css = findGrokCss();
  assert.ok(css && fs.existsSync(css), 'shipped Grok CSS not findable — re-extract app.asar');
  const themes = findThemes();
  assert.ok(themes && fs.existsSync(themes), 'resolved theme table not findable — run work/grok-re/case/run-grok-resolver.js');
});

check('the committed token layer equals what the generator produces', () => {
  const committed = path.join(ROOT, 'src', 'renderer', 'grok-tokens.css');
  assert.ok(fs.existsSync(committed), 'grok-tokens.css missing');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-drift-'));
  const produced = main({ out: path.join(tmp, 'produced.css'), quiet: true });
  const a = fs.readFileSync(committed, 'utf8');
  const b = fs.readFileSync(produced, 'utf8');
  assert.equal(b, a, 'token drift detected — run `node scripts/extract-grok-tokens.js` and commit the diff deliberately');
  fs.rmSync(tmp, { recursive: true, force: true });
});

check('vocabulary coverage matches the committed baseline (methodology: this file\'s header)', () => {
  const current = computeVocabularyCoverage();
  const c = current.counts;
  console.log(`  ·    vocabulary: grok ${c.grokDefined} defined, quansiox ${c.quansioxDefined} — required-missing ${c.requiredMissing}, tracked-missing ${c.trackedMissing}, extra ${c.extra}`);
  assert.ok(fs.existsSync(BASELINE), 'vocabulary baseline missing — run `node test/design-drift.js --update-vocabulary-baseline` once and commit test/fixtures/vocabulary-baseline.json');
  const committed = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  assert.deepEqual(current, committed,
    'vocabulary drift — the coverage numbers recorded for docs/parity are stale. ' +
    'Run `node test/design-drift.js --update-vocabulary-baseline`, review the baseline diff ' +
    '(it lists every added/removed name), and commit it deliberately.');
});

console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nerror: design-drift FAILED');
  process.exit(1);
}
console.log(`\ndesign drift: ${results.length} checks OK`);
