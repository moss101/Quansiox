'use strict';
/* Parity (P2.3): the composer parity pieces derive correctly and persist.
 *
 * 1. composerModel — voice-memo state machine (guarded transitions),
 *    waveform downsampling, memo clock, and the word-diff revision
 *    highlighter are pure and correct.
 * 2. sessionExtras draft lifecycle — saveDraft / getDraft / discardDraft
 *    round-trip (the discard button's backend).
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-composer-'));

const { downsample, hasRevision, memoClock, voiceMemoReducer, wordDiff } = require('../src/renderer-src/composerModel.js');

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

check('voice memo machine follows the legal lifecycle', () => {
  assert.equal(voiceMemoReducer('idle', 'start'), 'recording');
  assert.equal(voiceMemoReducer('recording', 'pause'), 'paused');
  assert.equal(voiceMemoReducer('paused', 'resume'), 'recording');
  assert.equal(voiceMemoReducer('paused', 'stop'), 'stopped');
  assert.equal(voiceMemoReducer('stopped', 'reset'), 'idle');
  assert.equal(voiceMemoReducer('error', 'reset'), 'idle');
});

check('voice memo machine ignores illegal events instead of corrupting a take', () => {
  assert.equal(voiceMemoReducer('idle', 'pause'), 'idle', 'cannot pause before starting');
  assert.equal(voiceMemoReducer('idle', 'stop'), 'idle', 'cannot stop from idle');
  assert.equal(voiceMemoReducer('stopped', 'resume'), 'stopped', 'cannot resume a finished take');
  assert.equal(voiceMemoReducer('paused', 'start'), 'paused', 'start is not resume');
  assert.equal(voiceMemoReducer('recording', 'nonsense'), 'recording');
});

check('waveform downsampling is stable and bucketed', () => {
  assert.deepEqual(downsample([], 4), [0, 0, 0, 0]);
  assert.deepEqual(downsample([0.5], 3), [0.5, 0, 0]);
  const bars = downsample(Array.from({ length: 100 }, (_, i) => (i % 2) / 2 + 0.25), 10);
  assert.equal(bars.length, 10);
  for (const bar of bars) {
    assert.ok(bar > 0 && bar <= 1, `bar out of range: ${bar}`);
  }
});

check('memo clock formats as m:ss', () => {
  assert.equal(memoClock(0), '0:00');
  assert.equal(memoClock(7_000), '0:07');
  assert.equal(memoClock(65_000), '1:05');
  assert.equal(memoClock(-5), '0:00');
});

check('word diff marks substitutions, insertions and deletions', () => {
  const same = wordDiff('ship the release', 'ship the release');
  assert.equal(same.length, 1);
  assert.equal(same[0].type, 'same');

  const sub = wordDiff('ship the release now', 'ship the launch now');
  assert.equal(sub.filter((r) => r.type === 'del').map((r) => r.text).join(' '), 'release');
  assert.equal(sub.filter((r) => r.type === 'ins').map((r) => r.text).join(' '), 'launch');

  const ins = wordDiff('ship it', 'ship it today please');
  assert.equal(ins.filter((r) => r.type === 'ins').map((r) => r.text).join(' '), 'today please');
  assert.equal(ins.filter((r) => r.type === 'del').length, 0);

  const del = wordDiff('ship it today', 'ship it');
  assert.equal(del.filter((r) => r.type === 'del').map((r) => r.text).join(' '), 'today');
});

check('word diff coalesces adjacent runs of the same kind', () => {
  const runs = wordDiff('a b c', 'a x y c');
  const types = runs.map((r) => r.type).join(',');
  assert.equal(types, 'same,del,ins,same');
  assert.equal(runs.find((r) => r.type === 'del').text, 'b');
  assert.equal(runs.find((r) => r.type === 'ins').text, 'x y');
});

check('revision highlighting only when a differing base exists', () => {
  assert.equal(hasRevision('', 'draft'), false, 'no base');
  assert.equal(hasRevision('same text', 'same text'), false, 'unchanged');
  assert.equal(hasRevision('old', 'new'), true);
  assert.equal(hasRevision('  spaced  ', 'spaced'), false, 'whitespace-normalized equality is not a revision');
});

check('draft lifecycle: save → get → discard → get (backend of the discard button)', async () => {
  const { sessionExtrasService } = require('../src/main/services/sessionExtrasService.js');
  const sid = 'composer-parity';
  await sessionExtrasService.saveDraft(sid, 'Draft with **markdown** and a revision');
  let got = await sessionExtrasService.getDraft(sid);
  assert.equal(got?.text, 'Draft with **markdown** and a revision');
  await sessionExtrasService.saveDraft(sid, 'Edited draft');
  got = await sessionExtrasService.getDraft(sid);
  assert.equal(got.text, 'Edited draft', 'save overwrites');
  await sessionExtrasService.discardDraft(sid);
  got = await sessionExtrasService.getDraft(sid);
  assert.ok(!got?.text, 'discard clears the persisted draft');
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-composer FAILED');
    process.exit(1);
  }
  console.log(`\nparity composer: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — memo machine, waveform, revision diff, draft lifecycle`);
})();
