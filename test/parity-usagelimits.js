'use strict';
/* Parity (P3.12): usage spend-limit cards — local math only.
 *
 * 1. weekKey buckets by ISO week (Monday anchor).
 * 2. weekToDate sums estimated session costs in the current week only.
 * 3. limitState thresholds (80% warning, ≥100% exceeded) and the off state.
 * 4. cardModel's copy is honest: no billing integration, top-up fail-closed.
 * 5. The settings field round-trips (the card's backend). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-ulimits-'));

const { cardModel, limitState, weekKey, weekToDate } = require('../src/renderer-src/usageLimitsModel.js');

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

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0); // Friday, 2026-10-23

check('weekKey buckets by the Monday of the ISO week', () => {
  assert.equal(weekKey(NOW, NOW), '2026-10-19', 'Friday buckets to Monday');
  assert.equal(weekKey(Date.UTC(2026, 9, 19, 1, 0, 0), NOW), '2026-10-19', 'Monday itself');
  assert.equal(weekKey(Date.UTC(2026, 9, 18, 23, 0, 0), NOW), '2026-10-12', 'Sunday belongs to the previous week');
});

check('weekToDate sums only this week\u2019s estimated costs', () => {
  const rows = [
    { estimatedCost: 1.25, updatedAt: NOW },
    { estimatedCost: 0.5, updatedAt: Date.UTC(2026, 9, 20, 9, 0, 0) }, // Tuesday, same week
    { estimatedCost: 99, updatedAt: Date.UTC(2026, 9, 15, 9, 0, 0) }, // last week — excluded
    { estimatedCost: -3, updatedAt: NOW }, // junk — excluded
    { estimatedCost: null, updatedAt: NOW },
    { updatedAt: NOW }, // no cost
  ];
  const wtd = weekToDate(rows, NOW);
  assert.equal(wtd.week, '2026-10-19');
  assert.equal(wtd.spend, 1.75);
  assert.equal(wtd.sessions, 2);
  assert.deepEqual(weekToDate([], NOW).spend, 0);
});

check('limit states: off, ok, warning at 80%, exceeded at 100%', () => {
  assert.deepEqual(limitState({}, { spend: 5 }), { enabled: false, limit: null, pct: 0, state: 'off', remaining: null });
  assert.equal(limitState({ spendLimitWeekly: 10 }, { spend: 1 }).state, 'ok');
  assert.equal(limitState({ spendLimitWeekly: 10 }, { spend: 8 }).state, 'warning', '80% warns');
  assert.equal(limitState({ spendLimitWeekly: 10 }, { spend: 8 }).pct, 80);
  assert.equal(limitState({ spendLimitWeekly: 10 }, { spend: 10 }).state, 'exceeded');
  assert.equal(limitState({ spendLimitWeekly: 10 }, { spend: 1 }).remaining, 9);
  assert.equal(limitState({ spendLimitWeekly: -5 }, { spend: 1 }).state, 'off', 'nonsense limits read as off');
});

check('the card copy stays honest: local math, no billing, top-up fail-closed', () => {
  const card = cardModel({ spendLimitWeekly: 10 }, { spend: 4 });
  assert.equal(card.title, 'Weekly spend limit');
  assert.ok(card.spentLabel.includes('$4.00 this week of $10.00'));
  assert.match(card.note, /no billing/i);
  assert.equal(card.topUp.status, 'off');
  assert.match(card.topUp.note, /fail-closed/i);
  const off = cardModel({}, { spend: 0 });
  assert.equal(off.state, 'off');
  assert.match(off.note, /no billing/i);
});

check('spendLimitWeekly round-trips through settings (the card\u2019s backend)', async () => {
  const { settingsService } = require('../src/main/services/settingsService.js');
  const current = settingsService.load();
  settingsService.save({ ...current, spendLimitWeekly: 12.5 });
  assert.equal(settingsService.load().spendLimitWeekly, 12.5);
  settingsService.save({ ...settingsService.load(), spendLimitWeekly: null });
  assert.ok(settingsService.load().spendLimitWeekly == null, 'null clears the limit');
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-usagelimits FAILED');
    process.exit(1);
  }
  console.log(`\nparity usagelimits: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — week bucketing, thresholds, honest copy, settings round-trip`);
})();
