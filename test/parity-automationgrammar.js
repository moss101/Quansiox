'use strict';
/* Parity (P3.5): the automation grammar + trigger catalog.
 *
 * 1. Phrase → cron translation for Grok's composer vocabulary, validated
 *    against the REAL cron validator (never emits an invalid expression).
 * 2. Grammar-kind classification (interval/daily/weekday-list/nth-weekday/
 *    monthly/yearly-date — the extraction's grammar kinds).
 * 3. Cron summaries for the composer.
 * 4. The trigger catalog is honest: schedule + webhook local (the service
 *    already runs them), connector-fed kinds stubbed with reasons. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-agrammar-'));

const { validate: cronValidate } = require('../src/main/services/cron.js');
const grammar = require('../src/renderer-src/automationGrammarModel.js');
const catalog = require('../src/shared/triggerCatalog.js');

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

check('every translated phrase produces a cron the validator accepts', () => {
  const phrases = [
    'Every hour', 'Every day', 'Every weekday', 'Every week', 'Every month',
    'every 15 minutes', 'every 6 hours', 'every monday', 'every friday at 14:30',
    'monday through friday at 9:00', 'mon,tue,wed at 8:15',
  ];
  for (const phrase of phrases) {
    const cron = grammar.phraseToCron(phrase);
    assert.ok(cron, `phrase not translated: ${phrase}`);
    cronValidate(cron); // throws when invalid
  }
});

check('phrase translation values are the expected crons', () => {
  assert.equal(grammar.phraseToCron('Every weekday'), '0 9 * * 1-5');
  assert.equal(grammar.phraseToCron('every 15 minutes'), '*/15 * * * *');
  assert.equal(grammar.phraseToCron('every 6 hours'), '0 */6 * * *');
  assert.equal(grammar.phraseToCron('every friday at 14:30'), '30 14 * * 5');
  assert.equal(grammar.phraseToCron('monday through friday at 9:00'), '0 9 * * 1-5');
  assert.equal(grammar.phraseToCron('nonsense phrase'), null);
  assert.equal(grammar.phraseToCron(''), null);
});

check('grammar kinds classify the extraction\u2019s vocabulary', () => {
  assert.equal(grammar.grammarKind('*/15 * * * *'), 'interval');
  assert.equal(grammar.grammarKind('0 */6 * * *'), 'interval');
  assert.equal(grammar.grammarKind('0 9 * * *'), 'daily');
  assert.equal(grammar.grammarKind('0 9 * * 1-5'), 'weekday-list');
  assert.equal(grammar.grammarKind('0 9 * * 1,3,5'), 'weekday-list');
  assert.equal(grammar.grammarKind('0 9 * * 2#1'), 'nth-weekday');
  assert.equal(grammar.grammarKind('0 9 1 * *'), 'monthly');
  assert.equal(grammar.grammarKind('0 9 1 3 *'), 'yearly-date');
  assert.equal(grammar.grammarKind('17 * * 3-7 *'), 'custom');
  assert.equal(grammar.grammarKind('not cron'), 'invalid');
  assert.equal(grammar.grammarKind(''), 'invalid');
});

check('cron summaries read naturally for the composer', () => {
  assert.equal(grammar.cronSummary('*/15 * * * *'), 'Every 15 minutes');
  assert.equal(grammar.cronSummary('0 */6 * * *'), 'Every 6 hours');
  assert.equal(grammar.cronSummary('0 9 * * *'), 'Every day at 9:00');
  assert.equal(grammar.cronSummary('0 9 * * 1-5'), 'Mon–Fri at 9:00');
  assert.equal(grammar.cronSummary('0 9 * * 1,3,5'), 'Mon, Wed, Fri at 9:00');
  assert.equal(grammar.cronSummary('30 14 * * 5'), 'Fri at 14:30');
  assert.equal(grammar.cronSummary('0 9 1 * *'), 'Monthly on the 1 at 9:00');
});

check('the trigger catalog is honest: schedule + webhook local, connectors stubbed with reasons', () => {
  const m = catalog.manifest();
  assert.equal(m.total, 9);
  assert.equal(m.local, 2);
  assert.ok(m.stub >= 5);
  for (const trigger of catalog.TRIGGERS) {
    if (trigger.status === 'stub') assert.ok(trigger.reason, `${trigger.id}: stub without reason`);
  }
  assert.equal(catalog.triggerById('webhook').status, 'local');
  assert.ok(catalog.triggerById('webhook').fields.some((f) => f.name === 'key'));
  assert.equal(catalog.triggerById('pr').events.includes('review-request'), true);
  assert.equal(catalog.triggerById('nope'), null);
  assert.deepEqual(catalog.COMPOSER_STATES, ['Every hour', 'Every day', 'Every weekday', 'Custom schedule', 'Cron…']);
});

check('the automation service still round-trips a grammar-produced cron', () => {
  const { automationService } = require('../src/main/services/automationService.js');
  const cron = grammar.phraseToCron('every monday at 8:30');
  assert.equal(cron, '30 8 * * 1');
  const a = automationService.create({ name: 'grammar-parity', prompt: 'ping', cron, sessionId: 'automations' });
  assert.equal(a.cron, '30 8 * * 1');
  assert.throws(() => automationService.create({ name: 'bad', prompt: 'x', cron: '99 * * * *', sessionId: 'automations' }), /cron/i);
  automationService.remove(a.id);
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-automationgrammar FAILED');
    process.exit(1);
  }
  console.log(`\nparity automationgrammar: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — NL grammar, kind classification, summaries, trigger catalog`);
})();
