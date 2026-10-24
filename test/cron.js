'use strict';
/* Cron test — 5-field cron: validation (bad field count/out-of-range/range),
 * matches for steps / weekday-hours / month-day, Sunday as 0 and 7, and next()
 * from a fixed local time. Node-only. */
const assert = require('node:assert/strict');
const cron = require('../src/main/services/cron');

// validation
assert.throws(() => cron.parse('* *'), /5 fields/);
assert.throws(() => cron.parse('60 * * * *'), /out of/);
assert.throws(() => cron.parse('* 24 * * *'), /out of/);
assert.throws(() => cron.parse('* * * * 8'), /out of/); // dow max 7
assert.throws(() => cron.parse('* * * * 3-1'), /out of/); // reversed range
assert.strictEqual(cron.validate('*/5 9-17 * * 1-5'), true);

// matches: step
const step = cron.parse('*/5 * * * *');
for (const m of [0, 5, 10, 55]) assert.ok(cron.matches(new Date(2026, 0, 1, 10, m, 0), step), `:${m} matches */5`);
assert.ok(!cron.matches(new Date(2026, 0, 1, 10, 3, 0), step), ':03 not */5');

// weekday 09:00 (2026-01-05 = Monday, 2026-01-04 = Sunday)
const weekday9 = cron.parse('0 9 * * 1-5');
assert.ok(cron.matches(new Date(2026, 0, 5, 9, 0, 0), weekday9), 'Mon 09:00');
assert.ok(!cron.matches(new Date(2026, 0, 5, 10, 0, 0), weekday9), 'Mon 10:00 no');
assert.ok(!cron.matches(new Date(2026, 0, 4, 9, 0, 0), weekday9), 'Sun 09:00 excluded by dow 1-5');

// first of the month + Sunday via 7
assert.ok(cron.matches(new Date(2026, 2, 1, 0, 0, 0), cron.parse('0 0 1 * *')), '1st of month');
assert.ok(cron.matches(new Date(2026, 0, 4, 0, 0, 0), cron.parse('0 0 * * 7')), 'Sunday via 7');
assert.ok(cron.matches(new Date(2026, 0, 4, 0, 0, 0), cron.parse('0 0 * * 0')), 'Sunday via 0');

// next() from a fixed time
const n1 = cron.next('*/5 * * * *', new Date(2026, 0, 1, 10, 2, 30));
assert.strictEqual(`${n1.getHours()}:${n1.getMinutes()}`, '10:5', 'next */5 after 10:02:30');
const n2 = cron.next('0 9 * * *', new Date(2026, 0, 1, 10, 2, 0));
assert.strictEqual(`${n2.getMonth() + 1}-${n2.getDate()} ${n2.getHours()}:${n2.getMinutes()}`, '1-2 9:0', 'next 09:00 rolls to tomorrow');
// Feb 29 lands on a real leap day
const n3 = cron.next('0 0 29 2 *', new Date(2026, 0, 1, 0, 0, 0));
assert.strictEqual(n3.getFullYear(), 2028, 'next Feb 29 is 2028');

console.log('cron test: ALL OK');
