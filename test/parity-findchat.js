'use strict';
/* Parity (P2.4 remainder): find-in-chat derives correctly and the search
 * backend really finds.
 *
 * 1. findChatModel — match selection (kind filter, case-insensitivity,
 *    transcript order), bidirectional wraparound navigation, index clamping
 *    when the match list shrinks (the "5/2" bug), count labels.
 * 2. sessionService.searchMessages — the backend the palette/bar family
 *    shares — finds seeded turns with snippets and message ids.
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-findchat-'));

const { activeItem, clampIndex, countLabel, matchItems, stepIndex } = require('../src/renderer-src/findChatModel.js');

const results = [];
const checks = [];
function check(name, fn) { checks.push([name, fn]); }
async function run() {
  for (const [name, fn] of checks) {
    try {
      await fn();
      results.push(`  ok   ${name}`);
    } catch (error) {
      results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
      process.exitCode = 1;
    }
  }
}

const ITEMS = [
  { kind: 'user', text: 'ship the release notes', id: 'm1' },
  { kind: 'assistant', text: 'the Release is staged', id: 'm2' },
  { kind: 'tool', text: 'release tarball', id: 'm3' },        // not searchable
  { kind: 'assistant', text: 'nothing relevant', id: 'm4' },
  { kind: 'user', text: 'ok — release it', id: 'm5' },
];

check('matches are user/assistant only, case-insensitive, in transcript order', () => {
  const hits = matchItems(ITEMS, 'release');
  assert.deepEqual(hits.map((h) => h.id), ['m1', 'm2', 'm5']);
  assert.deepEqual(matchItems(ITEMS, ''), []);
  assert.deepEqual(matchItems(ITEMS, null), []);
  assert.deepEqual(matchItems(null, 'x'), []);
});

check('navigation wraps forward and backward', () => {
  assert.equal(stepIndex(0, 3, 1), 1);
  assert.equal(stepIndex(2, 3, 1), 0, 'forward wrap');
  assert.equal(stepIndex(0, 3, -1), 2, 'backward wrap');
  assert.equal(stepIndex(1, 3, -1), 0);
});

check('navigation is safe on an empty or shrunken match list', () => {
  assert.equal(stepIndex(2, 0, 1), 0);
  assert.equal(stepIndex(4, 2, 1), 0, 'idx beyond the list clamps before stepping');
  assert.equal(stepIndex(4, 2, -1), 0, 'backward from the clamped last match');
  assert.equal(stepIndex(null, 3, 1), 0);
});

check('clampIndex and activeItem never claim a match beyond the list', () => {
  assert.equal(clampIndex(7, 3), 2);
  assert.equal(clampIndex(-1, 3), 0);
  assert.equal(clampIndex(null, 3), 0);
  const hits = matchItems(ITEMS, 'release');
  assert.equal(activeItem(hits, 0).id, 'm1');
  assert.equal(activeItem(hits, 99).id, 'm5', 'out-of-range index clamps to the last match');
  assert.equal(activeItem([], 0), null);
  assert.equal(activeItem(null, 0), null);
});

check('count label clamps (never "5/2")', () => {
  assert.equal(countLabel(3, 0), '1/3');
  assert.equal(countLabel(3, 2), '3/3');
  assert.equal(countLabel(3, 99), '3/3', 'clamped');
  assert.equal(countLabel(0, 0), '0/0');
  assert.equal(countLabel([], 4), '0/0');
});

check('searchMessages finds seeded turns with ids and snippets (shared backend)', async () => {
  const { sessionService } = require('../src/main/services/sessionService.js');
  const sid = 'findchat-parity';
  sessionService.appendTurn(sid, { role: 'user', content: 'please ship the release notes tonight' });
  sessionService.appendTurn(sid, { role: 'assistant', content: 'staged; the release notes are ready' });
  sessionService.appendTurn(sid, { role: 'assistant', content: 'unrelated filler turn' });

  const hits = sessionService.searchMessages('release notes');
  const mine = hits.filter((h) => h.sessionId === sid);
  // The session title derives from the first turn, so it matches too —
  // that hit is a session-level entry, not a message jump target.
  const titleHits = mine.filter((h) => String(h.snippet).startsWith('Conversation:'));
  const messageHits = mine.filter((h) => !String(h.snippet).startsWith('Conversation:'));
  assert.equal(titleHits.length, 1, 'the derived session title matches once');
  assert.equal(messageHits.length, 2, 'both matching turns are found');
  for (const hit of messageHits) {
    assert.ok(hit.messageId, 'hit carries a jumpable message id');
    assert.ok(String(hit.snippet).toLowerCase().includes('release'), 'snippet surrounds the match');
  }
  assert.deepEqual(sessionService.searchMessages('zzz-no-such-token'), []);
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-findchat FAILED');
    process.exit(1);
  }
  console.log(`\nparity findchat: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — match derivation, wraparound nav, clamped counts, search backend`);
})();
