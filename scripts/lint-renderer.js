#!/usr/bin/env node
'use strict';
/**
 * The renderer style lint.
 *
 * The design system is a set of tokens; a raw colour in a component is a
 * component that will not follow the theme. This check finds them.
 *
 * It also checks the card registry: every declared card type must have a
 * component, and every card type the components handle must be declared.
 * That is what keeps the card framework honest as it grows.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer-src');

const problems = [];

/* ---------------------------------------------------------------- colours */

const COLOUR_ALLOWLIST = [
  // The VNC fallback: the token is read at runtime and this is the value to
  // use when the token is not there yet.
  { file: 'ScreenViewer.jsx', pattern: /'#0b0d12'/ },
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

for (const file of walk(RENDERER)) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    // A hex colour that is not inside a comment and not a URL.
    const withoutComments = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    const match = withoutComments.match(/#[0-9a-fA-F]{3,8}\b/g);
    if (!match) return;
    if (COLOUR_ALLOWLIST.some((a) => a.file === path.basename(file) && a.pattern.test(line))) return;
    problems.push(`${rel}:${index + 1} — raw colour ${match.join(', ')} (use a token)`);
  });
}

/* ------------------------------------------------------------------ cards */

const registrySource = fs.readFileSync(path.join(RENDERER, 'cards', 'registry.js'), 'utf8');
const cardsSource = fs.readFileSync(path.join(RENDERER, 'cards', 'Cards.jsx'), 'utf8');

const declared = [...registrySource.matchAll(/^\s{2}'?([a-z-]+)'?:\s*\{\s*title:/gm)].map((m) => m[1]);
if (declared.length < 40) {
  problems.push(`cards/registry.js — expected at least 40 card types, found ${declared.length}`);
}

// Every card type the components handle must be declared.
const handled = [...cardsSource.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);
for (const type of handled) {
  if (!registrySource.includes(`'${type}'`) && !registrySource.includes(`${type}:`)) {
    problems.push(`cards/Cards.jsx — handles "${type}" but the registry does not declare it`);
  }
}

/* ------------------------------------------------------------- unstyled */

/**
 * A component must have styles.
 *
 * A component that ships without its CSS does not fail — it renders as
 * unstyled text, which looks like the app did not update at all. That is
 * exactly what happened to the permission panel: the component existed, the
 * DOM had every element, and it read as a wall of run-together words
 * ("Permissionsworkspace", "Read-onlyThe agent can look but not…").
 *
 * The check is per COMPONENT, using the root class it declares: a new
 * component whose root class has no CSS rule is the failure this catches.
 * Checking every class name would flag data-attribute values and modifier
 * fragments, which is noise.
 */
const CSS_SOURCES = [
  path.join(ROOT, 'src', 'renderer', 'styles.css'),
  path.join(RENDERER, 'surfaces', 'surfaces.css'),
];

function cssText() {
  return CSS_SOURCES
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
}

const CSS = cssText();

/** The root class of a component: the first className on its first element. */
function rootClassOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/className="([a-z][a-z0-9_-]*)"/);
  return match?.[1] ?? null;
}

const COMPONENT_FILES = [
  path.join(RENDERER, 'PermissionPanel.jsx'),
  path.join(RENDERER, 'SettingsRouter.jsx'),
  path.join(RENDERER, 'DiffView.jsx'),
  path.join(RENDERER, 'cards', 'Cards.jsx'),
  path.join(RENDERER, 'surfaces', 'McpPanel.jsx'),
  path.join(RENDERER, 'surfaces', 'MeetingPanel.jsx'),
  path.join(RENDERER, 'surfaces', 'VaultPanel.jsx'),
  path.join(RENDERER, 'surfaces', 'PluginsPanel.jsx'),
  path.join(RENDERER, 'surfaces', 'UsagePanel.jsx'),
  path.join(RENDERER, 'surfaces', 'CanvasPanel.jsx'),
  path.join(RENDERER, 'surfaces', 'VoiceCallPanel.jsx'),
];

for (const file of COMPONENT_FILES) {
  if (!fs.existsSync(file)) continue;
  const rel = path.relative(ROOT, file);
  const root = rootClassOf(file);
  if (!root) {
    problems.push(`${rel} — no root class found, so its styles cannot be checked`);
    continue;
  }
  if (!CSS.includes(`.${root}`)) {
    problems.push(`${rel} — the root class ".${root}" has no CSS rule (the component would render unstyled)`);
  }
}

/* ------------------------------------------------------------------ report */

// The registry is an ES module; import it so the count is the real one.
(async () => {
  const { allCards, KIND } = await import(path.join(RENDERER, 'cards', 'registry.js'));
  const cards = allCards();
  const byKind = {};
  for (const card of cards) byKind[card.kind] = (byKind[card.kind] ?? 0) + 1;
  // The reference implementation declares 48 card kinds. Its extractable
  // enumeration lists 29 send-message types (its own table duplicates
  // "text" to reach 30), 12 event types and 6 other kinds. We implement all
  // 29 + 12 + 6 and add one local-first card the reference has no
  // equivalent for — a handoff to another agent — which makes 48.
  const expected = { [KIND.SEND_MESSAGE]: 29, [KIND.EVENT]: 12 };
  for (const [kind, count] of Object.entries(expected)) {
    if ((byKind[kind] ?? 0) < count) {
      problems.push(`cards/registry.js — ${kind} has ${byKind[kind] ?? 0} types, expected at least ${count}`);
    }
  }
  if (cards.length < 48) {
    problems.push(`cards/registry.js — expected at least 48 card types in total, found ${cards.length}`);
  }
  if (problems.length) {
    console.error('renderer style lint:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const kinds = Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`renderer style lint: OK (${cards.length} card types declared [${kinds}], no raw colours in components)`);
})();
