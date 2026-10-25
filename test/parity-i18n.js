'use strict';
/* Parity (P2.1): the i18n layer — locale table, resolver, direction, catalog
 * fallback. All facts verified against the 0.75.0 extraction. */
const assert = require('node:assert/strict');
const i18n = require('../src/shared/i18n.js');

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

check('the locale table is exactly Grok\u2019s 36 shipped locales', () => {
  assert.equal(i18n.LOCALES.length, 36);
  assert.deepEqual(i18n.LOCALES.map((l) => l.tag), [
    'en', 'hi', 'zh-CN', 'zh-TW', 'pl', 'es', 'pt', 'ja', 'fr', 'ko', 'de', 'ru',
    'tr', 'ar', 'it', 'sv', 'uk', 'nl', 'el', 'af', 'he', 'vi', 'id', 'ur',
    'th', 'bn', 'cs', 'hu', 'nb', 'da', 'fi', 'mr', 'te', 'sw', 'ha', 'ta',
  ]);
});

check('every locale carries a non-empty endonym', () => {
  for (const locale of i18n.LOCALES) {
    assert.ok(String(locale.endonym ?? '').trim(), `${locale.tag} has no endonym`);
  }
});

check('RTL is exactly ar, he, ur (extraction fact)', () => {
  assert.deepEqual(i18n.RTL_LOCALES, ['ar', 'he', 'ur']);
  assert.equal(i18n.directionOf('ar'), 'rtl');
  assert.equal(i18n.directionOf('he'), 'rtl');
  assert.equal(i18n.directionOf('ur'), 'rtl');
  assert.equal(i18n.directionOf('en'), 'ltr');
  assert.equal(i18n.directionOf('zh-CN'), 'ltr');
  assert.equal(i18n.directionOf('not-a-locale'), 'ltr');
});

check('the language menu is Follow System + the endonym table', () => {
  const menu = i18n.languageMenu();
  assert.equal(menu.length, 37);
  assert.equal(menu[0].id, 'system');
  assert.equal(menu[0].label, 'Follow System');
  assert.equal(menu.find((m) => m.id === 'ja').label, '日本語');
  assert.equal(menu.find((m) => m.id === 'ar').direction, 'rtl');
});

check('the preference resolver matches Grok\u2019s language-family mapping', () => {
  const r = i18n.resolvePreference;
  assert.equal(r(['zh']), 'zh-CN');
  assert.equal(r(['zh-SG']), 'zh-CN');
  assert.equal(r(['zh-Hant-HK']), 'zh-TW');
  assert.equal(r(['yue']), 'zh-TW', 'yue resolves to Traditional — the extraction\u2019s mapping');
  assert.equal(r(['yue-Hans']), 'zh-CN');
  assert.equal(r(['iw']), 'he', 'legacy Hebrew code');
  assert.equal(r(['in']), 'id', 'legacy Indonesian code');
  assert.equal(r(['nn-NO']), 'nb', 'Norwegian nynorsk → bokmål row');
  assert.equal(r(['es-MX']), 'es');
  assert.equal(r(['pt-BR']), 'pt');
  assert.equal(r(['fr-CA']), 'fr');
  assert.equal(r(['xx-YY']), 'en', 'unknown falls back to English');
  assert.equal(r([]), 'en');
  // the list is ordered: first match wins
  assert.equal(r(['xx', 'de-AT']), 'de');
});

check('catalog fallback chain: exact → base → en', () => {
  assert.equal(i18n.registerCatalog('en', { greet: 'Hello', count: '{n} items' }), true);
  assert.equal(i18n.registerCatalog('zh-CN', { greet: '你好' }), true);
  assert.equal(i18n.t('zh-CN', 'greet'), '你好');
  assert.equal(i18n.t('zh-CN', 'count', { n: 3 }), '3 items', 'missing in zh-CN falls back to en');
  assert.equal(i18n.t('en', 'greet'), 'Hello');
  assert.equal(i18n.t('fr', 'greet'), 'Hello', 'untranslated locale falls back to en');
  assert.equal(i18n.t('fr', 'untranslated.id'), 'untranslated.id', 'the id itself is the last resort');
  assert.equal(i18n.registerCatalog('klingon', {}), false, 'unknown locale tags are refused');
});

check('interpolation leaves unknown params visible instead of dropping them', () => {
  i18n.registerCatalog('en', { hello: 'hi {name}' });
  assert.equal(i18n.t('en', 'hello', { name: 'Ada' }), 'hi Ada');
  assert.equal(i18n.t('en', 'hello'), 'hi {name}');
  assert.equal(i18n.t('en', 'hello', { other: 1 }), 'hi {name}');
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-i18n FAILED');
    process.exit(1);
  }
  console.log(`\nparity i18n: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — 36-locale table, resolver, RTL, catalog fallback`);
})();
