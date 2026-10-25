'use strict';
/**
 * Automation schedule grammar (parity plan P3.5) — pure.
 *
 * Grok's automation composer converts natural-language schedules to cron and
 * back, over a small grammar (interval presets, weekday lists, nth-weekday,
 * yearly dates). The vocabulary below is the extraction's; the translation
 * is quansiox's own and round-trips through the cron validator.
 */

export const PRESETS = [
  { id: 'hour', label: 'Every hour', cron: '0 * * * *' },
  { id: 'day', label: 'Every day', cron: '0 9 * * *' },
  { id: 'weekday', label: 'Every weekday', cron: '0 9 * * 1-5' },
  { id: 'week', label: 'Every week', cron: '0 9 * * 1' },
  { id: 'month', label: 'Every month', cron: '0 9 1 * *' },
  { id: 'custom', label: 'Custom schedule', cron: null },
  { id: 'raw', label: 'Cron…', cron: null },
];

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** NL phrase → cron, or null when the phrase is not in the grammar.
 * Supported: the presets above, "every N hours/minutes", "every <weekday>",
 * "every <weekday> at HH:MM", "<weekday> through <weekday> at HH:MM",
 * comma weekday lists. Cron numbering is 0=Sunday, matching the service. */
export function phraseToCron(phrase) {
  const text = String(phrase ?? '').trim().toLowerCase();
  if (!text) return null;
  const preset = PRESETS.find((p) => p.cron && p.label.toLowerCase() === text);
  if (preset) return preset.cron;
  let m = /^every (\d{1,3}) (minutes?|hours?)$/.exec(text);
  if (m) {
    const n = Math.max(1, Math.min(999, Number(m[1])));
    return m[2].startsWith('minute') ? `*/${n} * * * *` : `0 */${n} * * *`;
  }
  // Weekday tokens: leading word boundary + the three-letter name. No
  // trailing boundary — "monday" must match "mon" mid-word.
  const dayRe = new RegExp(`\\b(${WEEKDAYS.join('|')})(?:[a-z]*)?(?:\\s+(?:through|to|-)\\s+(${WEEKDAYS.join('|')}))[a-z]*`, 'g');
  const dayOnly = new RegExp(`\\b(${WEEKDAYS.join('|')})[a-z]*`, 'g');
  const atM = /\bat\s+(\d{1,2}):(\d{2})/.exec(text);
  const at = atM
    ? { h: Math.min(23, Number(atM[1])), min: Math.min(59, Number(atM[2])) }
    : { h: 9, min: 0 };
  const range = dayRe.exec(text);
  if (range) {
    const from = WEEKDAYS.indexOf(range[1]);
    const to = WEEKDAYS.indexOf(range[2]);
    if (from >= 0 && to >= 0) return `${at.min} ${at.h} * * ${from}-${to}`;
  }
  const singles = [...text.matchAll(dayOnly)].map((s) => WEEKDAYS.indexOf(s[1])).filter((i) => i >= 0);
  if (singles.length) {
    return `${at.min} ${at.h} * * ${[...new Set(singles)].sort((a, b) => a - b).join(',')}`;
  }
  return null;
}

/** Classify a cron expression into Grok's grammar kinds (extraction fact
 * vocabulary: interval / daily / weekday-list / nth-weekday / monthly /
 * yearly-date / custom). */
export function grammarKind(cron) {
  const c = String(cron ?? '').trim();
  const parts = c.split(/\s+/);
  if (parts.length !== 5) return 'invalid';
  const [min, hour, dom, mon, dow] = parts;
  if (min.startsWith('*/')) return 'interval';
  if (/^\d+$/.test(hour) && /^\d+$/.test(min) && dom === '*' && mon === '*' && dow === '*') return 'daily';
  if (/^\d+$/.test(hour) && dom === '*' && mon === '*' && /^(\d+,)*\d+$|^\d+-\d+$/.test(dow)) return 'weekday-list';
  // nth-weekday: e.g. "0 9 * * 2#1" (first Tuesday) or dom-based "0 9 1-7 * 1"
  if (dow.includes('#')) return 'nth-weekday';
  if (/^\d+$/.test(dom) && dow === '*') return mon !== '*' ? 'yearly-date' : 'monthly';
  if (/^\d+$/.test(dom) && /^(\d+,)*\d+$|^\d+-\d+$/.test(dow) && mon === '*') return 'nth-weekday';
  if (hour.startsWith('*/')) return 'interval';
  return 'custom';
}

/** Human summary of a cron expression for the composer ("Weekdays at 9:00"). */
export function cronSummary(cron) {
  const kind = grammarKind(cron);
  const [min, hour, dom, mon, dow] = String(cron ?? '').trim().split(/\s+/);
  const at = `${Number(hour)}:${String(min).padStart(2, '0')}`;
  switch (kind) {
    case 'interval': return min.startsWith('*/') ? `Every ${min.slice(2)} minutes` : `Every ${hour.slice(2)} hours`;
    case 'daily': return `Every day at ${at}`;
    case 'weekday-list': {
      const names = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
      const label = dow.includes('-')
        ? `${names[dow.split('-')[0]]}–${names[dow.split('-')[1]]}`
        : dow.split(',').map((d) => names[d]).join(', ');
      return `${label} at ${at}`;
    }
    case 'nth-weekday': return `Nth weekday at ${at}`;
    case 'monthly': return `Monthly on the ${Number(dom)} at ${at}`;
    case 'yearly-date': return `Yearly on ${Number(mon)}/${Number(dom)}`;
    default: return cron || '';
  }
}
