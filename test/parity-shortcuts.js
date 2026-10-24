'use strict';
/* Parity (P1.7): the sand.* shortcut registry is complete, verbatim, and
 * honest.
 *
 * 1. Every documented Grok action is registered with its verbatim
 *    accelerator (the keymap from the 0.75.0 extraction).
 * 2. Accelerators are well-formed and unique; the focusAgent1..9 family is
 *    generated for all nine slots.
 * 3. Every entry carries a truthful status: wired / approx (with note) /
 *    unmapped (with reason) — no silent gaps.
 * 4. The dialog model groups every action under Grok's five groups, in
 *    order, with no orphans.
 * 5. eventToAccel + matchAction round-trip the key bindings. */
const assert = require('node:assert/strict');

const {
  SAND_ACTIONS, SHORTCUT_GROUPS, accelToGlyph, eventToAccel, groupedForDialog, manifest, matchAction,
} = require('../src/renderer-src/shortcutRegistry.js');

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

/** The verbatim Grok keymap (extraction, docs/parity P1.7). */
const VERBATIM = {
  'sand.commandPalette': 'mod+k',
  'sand.focusSearch': 'mod+shift+f',
  'sand.newAgent': 'mod+n',
  'sand.newGroupChat': 'mod+shift+n',
  'sand.send': 'mod+enter',
  'sand.previousAgent': 'alt+ArrowUp',
  'sand.nextAgent': 'alt+ArrowDown',
  'sand.navigateBack': 'mod+[',
  'sand.navigateForward': 'mod+]',
  'sand.openSettings': 'mod+,',
  'sand.keyboardShortcuts': 'mod+/',
  'sand.openTools': 'mod+shift+m',
  'sand.openSkills': 'mod+shift+w',
  'sand.toggleAgentSettings': 'mod+shift+,',
  'sand.toggleSidebar': 'mod+b',
  'sand.focusInput': 'mod+i',
  'sand.findInChat': 'mod+f',
  'sand.addSelectionToPrompt': 'mod+l',
};

check('every documented sand.* action is registered with its verbatim accelerator', () => {
  for (const [id, accel] of Object.entries(VERBATIM)) {
    const entry = SAND_ACTIONS.find((a) => a.id === id);
    assert.ok(entry, `${id} missing from the registry`);
    assert.equal(entry.accel, accel, `${id}: expected ${accel}, got ${entry.accel}`);
  }
});

check('the focusAgent1..9 family exists for all nine slots', () => {
  for (let i = 1; i <= 9; i += 1) {
    const entry = SAND_ACTIONS.find((a) => a.id === `sand.focusAgent${i}`);
    assert.ok(entry, `sand.focusAgent${i} missing`);
    assert.equal(entry.accel, `mod+${i}`);
  }
});

check('accelerators are unique — no binding shadowing', () => {
  const seen = new Map();
  for (const a of SAND_ACTIONS) {
    assert.ok(!seen.has(a.accel), `duplicate accelerator ${a.accel} (${seen.get(a.accel)} and ${a.id})`);
    seen.set(a.accel, a.id);
  }
});

check('every action group is one of Grok\u2019s five, in dialog order', () => {
  const groups = [...new Set(SAND_ACTIONS.map((a) => a.group))];
  assert.deepEqual(groups, SHORTCUT_GROUPS);
  assert.deepEqual(SHORTCUT_GROUPS, ['Essentials', 'Chat', 'Navigation', 'Panels', 'Window']);
});

check('every entry is honestly accounted: wired / approx+note / unmapped+reason', () => {
  for (const a of SAND_ACTIONS) {
    assert.ok(['wired', 'approx', 'unmapped'].includes(a.status), `${a.id}: bad status ${a.status}`);
    if (a.status === 'approx') assert.ok(a.note, `${a.id}: approx without note`);
    if (a.status === 'unmapped') assert.ok(a.reason, `${a.id}: unmapped without reason`);
    assert.equal(typeof a.label, 'string');
  }
  const m = manifest();
  assert.equal(m.total, SAND_ACTIONS.length);
  assert.equal(m.wired + m.approx + m.unmapped, m.total);
});

check('the dialog model has no orphans — every action appears exactly once', () => {
  const groups = groupedForDialog();
  const shown = groups.flatMap((g) => g.items.map((i) => i.id));
  assert.equal(shown.length, SAND_ACTIONS.length);
  assert.deepEqual([...shown].sort(), [...SAND_ACTIONS.map((a) => a.id)].sort());
  assert.ok(groups.every((g) => g.items.length > 0), 'no empty groups');
});

check('eventToAccel + matchAction resolve the canonical bindings', () => {
  const cases = [
    [{ metaKey: true, key: 'k' }, 'mod+k'],
    [{ metaKey: true, shiftKey: true, key: 'f' }, 'mod+shift+f'],
    [{ metaKey: true, key: ',' }, 'mod+,'],
    [{ metaKey: true, key: '/' }, 'mod+/'],
    [{ altKey: true, key: 'ArrowUp' }, 'alt+ArrowUp'],
    [{ ctrlKey: true, key: '3' }, 'mod+3'],
    [{ metaKey: true, key: 'b' }, 'mod+b'],
  ];
  for (const [ev, accel] of cases) {
    assert.equal(eventToAccel(ev), accel, JSON.stringify(ev));
    const hit = matchAction(accel);
    assert.ok(hit, `${accel} resolves to an action`);
  }
  assert.equal(eventToAccel({ metaKey: true, key: 'Meta' }), null, 'bare modifier is not an accelerator');
  assert.equal(matchAction('mod+zzz'), null);
});

check('glyph rendering covers the modifier vocabulary', () => {
  assert.equal(accelToGlyph('mod+shift+/'), '⌘⇧/');
  assert.equal(accelToGlyph('alt+ArrowUp'), '⌥↑');
  assert.equal(accelToGlyph('mod+enter'), '⌘↵');
});

(async () => {
  await run();
  console.log(results.join('\n'));
  const m = manifest();
  results.push(`  ·    coverage: ${m.total} actions — ${m.wired} wired, ${m.approx} approx, ${m.unmapped} unmapped (${m.unmappedReasons.join('; ')})`);
  console.log(`  ·    coverage: ${m.total} actions — ${m.wired} wired, ${m.approx} approx, ${m.unmapped} unmapped`);
  if (process.exitCode) {
    console.error('\nerror: parity-shortcuts FAILED');
    process.exit(1);
  }
  console.log(`\nparity shortcuts: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — sand.* registry verbatim + honest`);
})();
