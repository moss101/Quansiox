#!/usr/bin/env node
'use strict';
/**
 * Verify that every custom property the component layer references is
 * actually DEFINED somewhere in the shipped token layer or in
 * Quansiox's own stylesheet.
 *
 *   node scripts/check-component-tokens.js
 *
 * A `var(--x)` that resolves to nothing is a silent hole: the property
 * falls back to its initial value (or, worse, to an inherited one), and
 * the component renders as if the token did not exist. This is the same
 * invariant `test/design-system.js` pins for the rest of the app.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMPONENTS = path.join(ROOT, 'src', 'renderer', 'grok-components.css');
const TOKENS = path.join(ROOT, 'src', 'renderer', 'grok-tokens.css');
const STYLES = path.join(ROOT, 'src', 'renderer', 'styles.css');
const SURFACES = path.join(ROOT, 'src', 'renderer-src', 'surfaces', 'surfaces.css');

const componentCss = fs.readFileSync(COMPONENTS, 'utf8');

const defined = new Set();
for (const file of [TOKENS, STYLES, SURFACES]) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
}

const used = new Map();
for (const m of componentCss.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
  const name = m[1];
  if (!used.has(name)) used.set(name, 0);
  used.set(name, used.get(name) + 1);
}

const missing = [...used.keys()].filter((name) => !defined.has(name)).sort();

/* A literal colour in the component layer is a component that will not
   follow the theme. `transparent` and `currentColor` are not colours
   in that sense — they are keywords that follow the cascade. `black`
   inside color-mix() is Provenance-OK: Grok 0.75.0 ships literal
   `black` there (button/primaryRed hover mixes 12% black). Comments
   are stripped first so the prose that documents a recipe is not
   mistaken for a declaration. */
const code = componentCss.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/color-mix\((?:[^()]|\((?:[^()]|\([^)]*\))*\))*\)/gi, 'color-mix()');
const literals = [];
for (const m of code.matchAll(
  /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|(?:^|[\s:,])(?:black|white|red|green|blue|gray|grey|orange|yellow|purple|pink|cyan|magenta)(?=[\s,)])/g,
)) {
  literals.push(m[0].trim());
}

const rules = (componentCss.match(/\{/g) || []).length;
const lines = componentCss.split('\n').length;
const topLevel = (() => {
  let depth = 0;
  let count = 0;
  for (const ch of componentCss.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') { if (depth === 0) count++; depth++; } else if (ch === '}') depth--;
  }
  return count;
})();

console.log(`grok-components.css: ${lines} lines, ${topLevel} top-level blocks (${rules} braces), ${used.size} distinct tokens referenced`);
if (missing.length) {
  console.error(`\n  FAIL ${missing.length} token(s) are used but never defined:`);
  for (const name of missing) console.error(`    ${name}  (used ${used.get(name)}x)`);
} else {
  console.log('  ok   every var(--x) resolves to a defined custom property');
}
if (literals.length) {
  console.error(`\n  FAIL ${literals.length} literal colour(s) in the component layer:`);
  for (const lit of [...new Set(literals)]) console.error(`    ${lit}`);
} else {
  console.log('  ok   no literal colours');
}

if (missing.length || literals.length) process.exit(1);
console.log('\ncomponent tokens: OK');
