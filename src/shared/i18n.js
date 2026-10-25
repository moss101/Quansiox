'use strict';
/**
 * The i18n layer (parity plan P2.1) — pure, shared main/renderer.
 *
 * Facts from the 0.75.0 extraction (index.eager-common bundle):
 *   - the 36-locale table Grok ships;
 *   - "Follow System" as the system entry;
 *   - per-locale direction (rtl: ar, he, ur);
 *   - the preference resolver's language-family mapping (zh-Hans→zh-CN,
 *     yue→zh-TW, iw→he, in→id, no/nn→nb; default en).
 * The endonyms below are the languages' own names for themselves (standard
 * CLDR facts, authored here — no Lingui/Grok catalogs are imported, per
 * docs/asset-policy.md). Catalogs are authored per message id, Lingui-shaped
 * ({ [id]: '…{param}…' }), with the fallback chain locale → base → en.
 */

/** Grok's 36-locale table (extraction fact; endonyms + direction added). */
const LOCALES = [
  { tag: 'en', endonym: 'English' },
  { tag: 'hi', endonym: 'हिन्दी' },
  { tag: 'zh-CN', endonym: '简体中文' },
  { tag: 'zh-TW', endonym: '繁體中文' },
  { tag: 'pl', endonym: 'Polski' },
  { tag: 'es', endonym: 'Español' },
  { tag: 'pt', endonym: 'Português' },
  { tag: 'ja', endonym: '日本語' },
  { tag: 'fr', endonym: 'Français' },
  { tag: 'ko', endonym: '한국어' },
  { tag: 'de', endonym: 'Deutsch' },
  { tag: 'ru', endonym: 'Русский' },
  { tag: 'tr', endonym: 'Türkçe' },
  { tag: 'ar', endonym: 'العربية', direction: 'rtl' },
  { tag: 'it', endonym: 'Italiano' },
  { tag: 'sv', endonym: 'Svenska' },
  { tag: 'uk', endonym: 'Українська' },
  { tag: 'nl', endonym: 'Nederlands' },
  { tag: 'el', endonym: 'Ελληνικά' },
  { tag: 'af', endonym: 'Afrikaans' },
  { tag: 'he', endonym: 'עברית', direction: 'rtl' },
  { tag: 'vi', endonym: 'Tiếng Việt' },
  { tag: 'id', endonym: 'Bahasa Indonesia' },
  { tag: 'ur', endonym: 'اردو', direction: 'rtl' },
  { tag: 'th', endonym: 'ไทย' },
  { tag: 'bn', endonym: 'বাংলা' },
  { tag: 'cs', endonym: 'Čeština' },
  { tag: 'hu', endonym: 'Magyar' },
  { tag: 'nb', endonym: 'Norsk bokmål' },
  { tag: 'da', endonym: 'Dansk' },
  { tag: 'fi', endonym: 'Suomi' },
  { tag: 'mr', endonym: 'मराठी' },
  { tag: 'te', endonym: 'తెలుగు' },
  { tag: 'sw', endonym: 'Kiswahili' },
  { tag: 'ha', endonym: 'Hausa' },
  { tag: 'ta', endonym: 'தமிழ்' },
];

const FOLLOW_SYSTEM = 'Follow System';
const DEFAULT_LOCALE = 'en';
const RTL_LOCALES = LOCALES.filter((l) => l.direction === 'rtl').map((l) => l.tag);

const BY_TAG = new Map(LOCALES.map((l) => [l.tag, l]));

/** Port of Grok's preference resolver (extraction fact, incl. legacy codes). */
function resolvePreference(candidates) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const raw of list) {
    const e = String(raw ?? '').toLowerCase();
    const starts = (p) => e.startsWith(p);
    if (e === 'zh' || e === 'zh-cn' || e === 'zh-sg' || e === 'zh-hans' || starts('zh-hans-')
      || e === 'yue-cn' || e === 'yue-hans' || starts('yue-hans-')) return 'zh-CN';
    if (e === 'zh-tw' || e === 'zh-hk' || e === 'zh-mo' || e === 'zh-hant' || starts('zh-hant-')
      || e === 'yue' || e === 'yue-hk' || e === 'yue-mo' || e === 'yue-hant' || starts('yue-hant-')) return 'zh-TW';
    for (const tag of ['pl', 'es', 'hi', 'pt', 'ja', 'fr', 'ko', 'de', 'ru', 'tr', 'ar', 'it',
      'sv', 'uk', 'nl', 'el', 'af', 'vi', 'ur', 'th', 'bn', 'cs', 'hu', 'da', 'fi', 'mr', 'te',
      'sw', 'ha', 'ta', 'en']) {
      if (e === tag || starts(`${tag}-`)) return tag;
    }
    if (e === 'he' || starts('he-') || e === 'iw' || starts('iw-')) return 'he';
    if (e === 'id' || starts('id-') || e === 'in' || starts('in-')) return 'id';
    if (e === 'nb' || starts('nb-') || e === 'no' || starts('no-') || e === 'nn' || starts('nn-')) return 'nb';
  }
  return DEFAULT_LOCALE;
}

/** The language menu: Follow System first, then the endonym table. */
function languageMenu() {
  return [
    { id: 'system', label: FOLLOW_SYSTEM },
    ...LOCALES.map((l) => ({ id: l.tag, label: l.endonym, direction: l.direction ?? 'ltr' })),
  ];
}

function isLocale(tag) {
  return typeof tag === 'string' && BY_TAG.has(tag);
}

function directionOf(tag) {
  return BY_TAG.get(String(tag ?? ''))?.direction ?? 'ltr';
}

// ---- catalogs (authored; Lingui-shaped message maps) ----

const catalogs = new Map(); // tag -> { [id]: template }

/** Register a catalog for a locale tag (merges). */
function registerCatalog(tag, messages) {
  if (!isLocale(tag) || !messages || typeof messages !== 'object') return false;
  const merged = { ...(catalogs.get(tag) ?? {}), ...messages };
  catalogs.set(tag, merged);
  return true;
}

/** The fallback chain: exact → base language → en. */
function chainFor(tag) {
  const t = isLocale(tag) ? tag : DEFAULT_LOCALE;
  const base = t.split('-')[0];
  const chain = [t];
  if (base !== t && BY_TAG.has(base)) chain.push(base);
  if (!chain.includes(DEFAULT_LOCALE)) chain.push(DEFAULT_LOCALE);
  return chain;
}

/** Translate `id` in `tag` with `{param}` interpolation. Falls through the
 * chain; the id itself is the last resort (untranslated ids stay visible). */
function t(tag, id, params) {
  for (const locale of chainFor(tag)) {
    const template = catalogs.get(locale)?.[id];
    if (typeof template === 'string') {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (m, key) => (key in params ? String(params[key]) : m));
    }
  }
  return id;
}

module.exports = {
  LOCALES,
  FOLLOW_SYSTEM,
  DEFAULT_LOCALE,
  RTL_LOCALES,
  BY_TAG,
  resolvePreference,
  languageMenu,
  isLocale,
  directionOf,
  registerCatalog,
  chainFor,
  t,
};
