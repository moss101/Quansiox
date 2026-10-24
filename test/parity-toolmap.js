'use strict';
/* Parity: the Grok ActionName tool contract is completely translated.
 *
 * src/coordinator/grokActionMap.js must cover every ActionName Grok Bot
 * 0.75.0 ships (156, extracted enum). Local entries must route to tools
 * that really exist in the coordinator registry; stub entries must name a
 * family reason and produce an honest refusal (never a faked success).
 *
 * When the local extraction (work/grok-re/case/grok-tools.txt) is present
 * it is used as ground truth (set equality). On machines without work/
 * (fresh clones), the committed count is asserted instead.
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GROK_ACTIONS, translate, manifest } = require('../src/coordinator/grokActionMap.js');
const coordinator = require('../src/coordinator/index.js');

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

const EXPECTED_ACTIONS = 156;
const registry = new Set(coordinator.allTools().map((t) => t.function?.name).filter(Boolean));

check(`every Grok ActionName is translated (${EXPECTED_ACTIONS} entries)`, () => {
  assert.equal(Object.keys(GROK_ACTIONS).length, EXPECTED_ACTIONS,
    `expected ${EXPECTED_ACTIONS} ActionName entries — the Grok enum changed; re-derive from the extraction`);
});

check('every local mapping routes to a tool that exists in the registry', () => {
  const missing = [];
  for (const [action, entry] of Object.entries(GROK_ACTIONS)) {
    if (entry.kind !== 'local') continue;
    assert.ok(Array.isArray(entry.to) && entry.to.length, `${action}: local entry has no target tool`);
    for (const tool of entry.to) if (!registry.has(tool)) missing.push(`${action} -> ${tool}`);
  }
  assert.deepEqual(missing, [], 'local mappings point at non-existent tools:\n  ' + missing.join('\n  '));
});

check('every stub names a family reason and refuses honestly', () => {
  for (const [action, entry] of Object.entries(GROK_ACTIONS)) {
    if (entry.kind !== 'stub') continue;
    assert.ok(entry.reason, `${action}: stub without reason`);
    const out = translate(action);
    assert.equal(out.kind, 'stub', `${action}: translate() disagrees with the map`);
    assert.match(out.message, /refused|blocked|not available/i, `${action}: stub message must be a refusal, not a success`);
    assert.doesNotMatch(out.message, /\bsuccess\b|\bdone\b/i, `${action}: stub message must never claim success`);
  }
});

check('translate() round-trips locals and rejects unknowns', () => {
  assert.equal(translate('Shell').to[0], 'shell');
  assert.equal(translate('SendEmail').to[0], 'email_send');
  assert.equal(translate('NoSuchAction'), null);
});

const extractionList = path.join(__dirname, '..', 'work', 'grok-re', 'case', 'grok-tools.txt');
if (fs.existsSync(extractionList)) {
  check('the map covers the extracted enum exactly (ground truth present)', () => {
    const extracted = fs.readFileSync(extractionList, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    assert.equal(extracted.length, EXPECTED_ACTIONS, 'extraction list size drifted');
    const onlyInMap = Object.keys(GROK_ACTIONS).filter((n) => !extracted.includes(n));
    const onlyInExtraction = extracted.filter((n) => !GROK_ACTIONS[n]);
    assert.deepEqual({ onlyInMap, onlyInExtraction }, { onlyInMap: [], onlyInExtraction: [] },
      'map and extraction disagree');
  });
} else {
  results.push('  ·    extraction list absent (fresh clone) — committed count asserted only');
}

const m = manifest();
results.push(`  ·    coverage: ${m.total} actions — ${m.local} local (${m.nameEqual} name-equal + ${m.semantic} semantic), ${m.stub} honest stubs`);
results.push(`  ·    top stub families: ${Object.entries(m.stubsByReason).slice(0, 5).map(([r, n]) => `${r} ${n}`).join(', ')}`);

console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\nerror: parity-toolmap FAILED');
  process.exit(1);
}
console.log(`\nparity toolmap: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — ${m.local}/${m.total} actions execute locally, ${m.stub} fail honestly`);
