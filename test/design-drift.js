'use strict';
/* Design-token drift tripwire.
 *
 * src/renderer/grok-tokens.css is GENERATED from Grok Bot's shipped bundle.
 * If a Grok update lands (new asar extraction, new resolver output) and the
 * generator produces different bytes, this test fails — which is exactly the
 * point: a design re-baseline must be a deliberate commit, never a silent
 * side effect of publishing the extraction.
 *
 * Also pins that the sources the generator reads still exist.
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { findGrokCss, findThemes, main } = require('../scripts/extract-grok-tokens.js');

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

console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nerror: ' + (results.join('\n').match(/FAIL[^]*?$/) ? 'design-drift FAILED' : 'design-drift FAILED'));
  process.exit(1);
}
console.log(`\ndesign drift: ${results.length} checks OK`);
