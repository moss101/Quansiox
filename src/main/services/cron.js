'use strict';
/**
 * Minimal, correct-enough 5-field cron (minute hour day-of-month month day-of-week)
 * with star, numbers, ranges (a-b), lists (a,b,c) and steps (star over n, a-b over n).
 * Sunday is 0 or 7. `next(expr, from)` returns the next matching Date. Pure + tiny.
 */
function parseRange(s, min, max) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) throw new Error(`cron: bad segment "${s}"`);
  const lo = Number(m[1]);
  const hi = m[2] !== undefined ? Number(m[2]) : lo;
  if (lo < min || hi > max || lo > hi) throw new Error(`cron: ${s} out of [${min},${max}]`);
  return [lo, hi];
}

function parseField(field, min, max) {
  if (field === undefined || field === '') throw new Error('cron: empty field');
  const set = new Set();
  for (const part of field.split(',')) {
    let range; let step = 1;
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    let base = part;
    if (stepMatch) { base = stepMatch[1]; step = Number(stepMatch[2]); if (step < 1) throw new Error('cron: step < 1'); }
    if (base === '*') range = [min, max];
    else range = parseRange(base, min, max);
    for (let v = range[0]; v <= range[1]; v += step) set.add(v);
  }
  if (!set.size) throw new Error('cron: empty field');
  return set;
}

function parse(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron: needs 5 fields "min hour dom month dow"');
  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12),
    dow: parseField(f[4], 0, 7), // 0 and 7 are both Sunday
  };
}

function dowOk(date, f) {
  const dow = date.getDay();
  return f.dow.has(dow) || (f.dow.has(7) && dow === 0);
}
function matches(date, f) {
  return f.minute.has(date.getMinutes())
    && f.hour.has(date.getHours())
    && f.dom.has(date.getDate())
    && f.month.has(date.getMonth() + 1)
    && dowOk(date, f);
}

/** Next matching time, advanced by month/day/hour (fast even years out). */
function next(expr, from = new Date()) {
  const f = typeof expr === 'string' ? parse(expr) : expr;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0); d.setMilliseconds(0);
  d.setMinutes(d.getMinutes() + 1);
  const maxYear = from.getFullYear() + 12;
  for (let guard = 0; guard < 200_000 && d.getFullYear() <= maxYear; guard += 1) {
    if (!f.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!f.dom.has(d.getDate()) || !dowOk(d, f)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!f.hour.has(d.getHours())) { d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); continue; }
    if (!f.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue; }
    return d;
  }
  return null;
}

function validate(expr) { parse(expr); return true; }

module.exports = { parse, next, matches, validate };
