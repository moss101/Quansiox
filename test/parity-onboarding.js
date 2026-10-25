'use strict';
/* Parity (P2.2): the onboarding wizard's model and persistence.
 *
 * 1. onboardingModel — the five-step machine matches the P2.2 narrative
 *    (welcome → workspace → appearance → language & model → first bot);
 *    the appearance vocabulary is fixed (Grok's character shapes, accents
 *    mapped onto role tokens); validation blocks unknown vocabulary instead
 *    of silently coercing; the completion patches carry facts only.
 * 2. settings persistence — accent/botColor/botShape/language/model round-trip
 *    through settingsService (arbitrary-key save, like onboardingSeen).
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-onboard-'));

const {
  ACCENTS, BOT_COLORS, LANGUAGES, SHAPES, STEPS, THEMES,
  botPatch, completionPatch, nextStep, prevStep, validate,
} = require('../src/renderer-src/onboardingModel.js');

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

check('the five steps follow the P2.2 narrative in order', () => {
  assert.deepEqual(STEPS.map((s) => s.id), ['welcome', 'workspace', 'appearance', 'language-model', 'first-bot']);
});

check('Grok\u2019s character shapes are the fixed shape list', () => {
  assert.deepEqual(SHAPES, ['blob', 'egg', 'star', 'pumpkin']);
});

check('appearance vocabulary is closed and mapped to role tokens', () => {
  assert.deepEqual(THEMES, ['system', 'light', 'dark']);
  assert.deepEqual(ACCENTS.map((a) => a.id), ['blue', 'green', 'orange']);
  assert.deepEqual(ACCENTS.map((a) => a.token), ['accent', 'success', 'warn']);
  assert.deepEqual(BOT_COLORS, ACCENTS);
  assert.ok(LANGUAGES.some((l) => l.id === 'system' && l.label === 'Follow System'));
});

check('step navigation is bounded', () => {
  assert.equal(nextStep(0), 1);
  assert.equal(nextStep(4), 4, 'clamped at the last step');
  assert.equal(prevStep(0), 0, 'clamped at the first step');
  assert.equal(prevStep(3), 2);
});

check('validation blocks unknown vocabulary instead of coercing', () => {
  assert.equal(validate({}).canFinish, true, 'defaults are valid');
  assert.equal(validate({ botShape: 'hexagon' }).canFinish, false);
  assert.equal(validate({ botShape: 'hexagon' }).firstInvalid, 'botShape');
  assert.equal(validate({ accent: 'purple' }).canFinish, false);
  assert.equal(validate({ botColor: 'mauve' }).canFinish, false);
  assert.equal(validate({ theme: 'sepia' }).canFinish, false);
  assert.equal(validate({ language: 'klingon' }).canFinish, false);
  assert.equal(validate({ language: 'en' }).canFinish, true);
});

check('completionPatch carries facts only — no secrets, no undefined keys', () => {
  const patch = completionPatch({
    accent: 'green', botColor: 'orange', botShape: 'star',
    language: 'en', model: 'gpt-4o-mini', name: 'ignored here',
  });
  assert.deepEqual(patch, {
    onboardingSeen: true, accent: 'green', botColor: 'orange',
    botShape: 'star', language: 'en', model: 'gpt-4o-mini',
  });
  const empty = completionPatch({});
  assert.deepEqual(empty, { onboardingSeen: true }, 'empty draft persists only the seen flag');
  const long = completionPatch({ model: 'x'.repeat(400) });
  assert.equal(long.model.length, 120, 'model is clamped');
});

check('botPatch maps the wizard draft onto the session profile', () => {
  assert.deepEqual(botPatch({ name: '  Release manager ', label: 'CI/CD', description: 'ships things' }), {
    title: 'Release manager', label: 'CI/CD', description: 'ships things',
  });
  assert.deepEqual(botPatch({ name: '   ' }), {}, 'blank name is skipped, not emptied');
});

check('settings persist the appearance vocabulary (the wizard\u2019s backend)', async () => {
  const { settingsService } = require('../src/main/services/settingsService.js');
  const current = settingsService.load();
  settingsService.save({
    ...current,
    onboardingSeen: true, accent: 'green', botColor: 'star' === 'x' ? 'blue' : 'blue',
    botShape: 'pumpkin', language: 'en', model: 'test-model',
  });
  const after = settingsService.load();
  assert.equal(after.onboardingSeen, true);
  assert.equal(after.accent, 'green');
  assert.equal(after.botShape, 'pumpkin');
  assert.equal(after.language, 'en');
  assert.equal(after.model, 'test-model');
  // redacted() masks a set key and reports an empty one as empty
  settingsService.save({ ...after, apiKey: 'sk-test-1234567890abcdef' });
  const masked = settingsService.redacted(settingsService.load());
  assert.ok(String(masked.apiKey).includes('…'), 'a set apiKey is masked');
  assert.notEqual(masked.apiKey, 'sk-test-1234567890abcdef', 'the raw key never crosses');
  settingsService.save({ ...after, onboardingSeen: false });
  assert.equal(settingsService.load().onboardingSeen, false, 're-runs are possible (skip/finish flags)');
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-onboarding FAILED');
    process.exit(1);
  }
  console.log(`\nparity onboarding: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — step machine, appearance vocabulary, patches, persistence`);
})();
