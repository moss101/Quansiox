#!/usr/bin/env node
'use strict';
/**
 * Generate Quansiox's design-token layer from Grok Bot's SHIPPED design
 * system. Currently sources Grok Bot 0.75.0.
 *
 * Why this exists
 * ---------------
 * Quansiox's stylesheet claimed to carry "exact values extracted from Grok
 * Bot 0.71.2 (sand design system): base palettes CX (light) / EX (dark)
 * neutral+accent scales". They were not. Every colour token in it —
 * `--text-and-icon-primary`, `--background-primary`, `--fill-tsp-gray-main`,
 * `--function-neutral`, `--button-primary` — is **absent from Grok's shipped
 * CSS**. They were a plausible-looking approximation of a design system
 * nobody had read, which is why the app still looked like the old design.
 *
 * What Grok actually ships
 * ------------------------
 *   - a base palette of `--cursor-*` tokens in `:root` blocks
 *   - the product theme of `--sand-*` tokens. Since 0.75.0 the theme is NOT
 *     fully serialized in the CSS: the bundle carries a tone palette +
 *     opacity tables + a recipe table and resolves them at runtime. The
 *     resolver was extracted verbatim and executed to produce the resolved
 *     light/dark tables (light verifies 230/230 against the shipped CSS);
 *     see work/grok-re/case/run-grok-resolver.js
 *   - thousands of hashed StyleX component classes built on top of them
 *
 * The 0.75.0 vocabulary renamed the 0.71.2 roles: `fill-*` became `bg-*-<role>`
 * families, `text-accent/danger/...` became `text-<role>-primary`, and the
 * generic planes (`bg-subtle`) were replaced by `bg-pane/chrome/sidebar/
 * elevated`. The alias layer below is re-pointed at the new names.
 *
 * Usage:
 *   node scripts/extract-grok-tokens.js [--grok-css PATH] [--grok-themes PATH] [--out PATH]
 *
 * The Grok bundle is not vendored. Point `--grok-css` at the extracted
 * `dist/renderer/assets/index-*.css` of an extracted `app.asar`, and
 * `--grok-themes` at the resolved theme table.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'renderer', 'grok-tokens.css');

/** Where the extracted Grok bundle and theme table are looked for by default. */
const DEFAULT_CSS_SEARCH = [
  '/Users/mohsin/manux/quansiox/work/grok-re/asar-extracted/dist/renderer/assets',
  '/Users/mohsin/manux/work/re-2026-10-20/grok-bot/app/dist/renderer/assets',
  '/Users/mohsin/manux/work/parity-2026-10-05/grok-bot/app/dist/renderer/assets',
];
const DEFAULT_THEMES = [
  '/Users/mohsin/manux/quansiox/work/grok-re/case/grok-design-tokens-0.75.0.json',
  '/Users/mohsin/manux/work/parity-2026-10-05/grok-design-tokens.json',
  '/Users/mohsin/manux/work/re-2026-10-20/grok-design-tokens.json',
];

const VERSION_FALLBACK = '0.71.2';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function findGrokCss() {
  const explicit = arg('grok-css', null);
  if (explicit) return explicit;
  for (const dir of DEFAULT_CSS_SEARCH) {
    if (!fs.existsSync(dir)) continue;
    const hit = fs.readdirSync(dir).find((f) => /^index-.*\.css$/.test(f));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

function findThemes() {
  const explicit = arg('grok-themes', null);
  if (explicit) return explicit;
  for (const file of DEFAULT_THEMES) if (fs.existsSync(file)) return file;
  return null;
}

/** Extract a top-level block's body by brace matching. */
function blockBody(css, marker) {
  const at = css.indexOf(marker);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/** The custom properties of a block, in order. */
function propsOf(body) {
  const out = [];
  const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push([m[1], m[2].trim()]);
  return out;
}

/** The Grok Bot version the sources were extracted from, when detectable. */
function grokVersion(cssPath) {
  const explicit = arg('version', null);
  if (explicit) return explicit;
  for (let dir = path.dirname(cssPath); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg)) continue;
    try {
      const v = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
      if (v) return v;
    } catch { /* fall through */ }
  }
  return VERSION_FALLBACK;
}

/**
 * Quansiox's semantic aliases, and the Grok token each one resolves to.
 *
 * The left-hand names are the ones the component rules already use, so this
 * layer is a re-pointing, not a rewrite. The right-hand names are Grok 0.75.0's.
 */
const ALIASES = [
  // planes: pane = main content, chrome = bars, elevated = dialogs/popovers
  ['--canvas', '--sand-bg-pane'],
  ['--sidebar', '--sand-bg-sidebar'],
  ['--surface', '--sand-bg-elevated'],
  ['--surface-2', '--sand-bg-elevated-hover'],
  ['--field', '--sand-bg-pane'],
  ['--bg-2', '--sand-bg-elevated'],
  ['--bg-3', '--sand-bg-elevated-hover'],
  ['--bg-overlay', '--sand-bg-elevated'],
  ['--bg-hover', '--sand-bg-hover'],
  ['--bg-active', '--sand-bg-active'],
  ['--bg-input', '--sand-bg-secondary'],
  ['--bg-code', '--sand-bg-elevated'],
  // ink
  ['--fg', '--sand-text-primary'],
  ['--muted', '--sand-text-secondary'],
  ['--faint', '--sand-text-tertiary'],
  ['--text-1', '--sand-text-primary'],
  ['--text-2', '--sand-text-secondary'],
  ['--text-3', '--sand-text-tertiary'],
  ['--text-disabled', '--sand-text-quaternary'],
  // lines: translucent ink hairlines, faintest to strongest
  ['--line', '--sand-border-tertiary-translucent'],
  ['--line-strong', '--sand-border-secondary-translucent'],
  ['--stroke-1', '--sand-border-quaternary-translucent'],
  ['--stroke-2', '--sand-border-tertiary-translucent'],
  ['--stroke-3', '--sand-border-primary-translucent'],
  // accent
  ['--accent', '--sand-bg-accent-primary'],
  ['--accent-strong', '--sand-bg-accent-primary-hover'],
  ['--accent-soft', '--sand-bg-accent-secondary'],
  ['--accent-contrast', '--sand-text-on-primary'],
  ['--accent-ink', '--sand-text-accent-primary'],
  ['--logo-color', '--sand-bg-accent-primary'],
  // buttons
  ['--button-primary', '--sand-bg-accent-primary'],
  ['--button-primary-foreground', '--sand-text-on-primary'],
  ['--button-secondary', '--sand-bg-secondary'],
  ['--button-destructive', '--sand-bg-danger-primary'],
  // The names the component rules still reference. Grok has no --function-*
  // or --button-* names of its own, so these map onto the same Grok roles
  // rather than being invented colours again.
  ['--function-neutral', '--sand-text-accent-primary'],
  ['--function-error', '--sand-text-danger-primary'],
  ['--function-success', '--sand-text-success-primary'],
  ['--function-warning', '--sand-text-warn-primary'],
  // status
  ['--success', '--sand-text-success-primary'],
  ['--warn', '--sand-text-warn-primary'],
  ['--danger', '--sand-text-danger-primary'],
  ['--info', '--sand-text-accent-primary'],
  ['--bg-success', '--sand-bg-success-secondary'],
  ['--bg-warning', '--sand-bg-warn-secondary'],
  ['--bg-danger', '--sand-bg-danger-secondary'],
  ['--bg-accent', '--sand-bg-accent-primary'],
  ['--bg-scrim', '--sand-bg-scrim'],
  // The names the component rules still reference that the old theme layer
  // used to define. Each maps onto a Grok role, not onto an invented colour.
  ['--bg', '--sand-bg-pane'],
  ['--bg-1', '--sand-bg-pane'],
  ['--bg-base', '--sand-bg-pane'],
  ['--bg-deep', '--sand-bg-sidebar'],
  ['--bg-inset', '--sand-bg-secondary'],
  ['--bg-raised', '--sand-bg-elevated'],
  ['--border-main', '--sand-border-secondary-translucent'],
  ['--border-secondary', '--sand-border-tertiary-translucent'],
  ['--border-dark', '--sand-border-primary-translucent'],
  ['--border-input-active', '--sand-border-accent-primary'],
  // The component rules use --fill-primary as a SUBTLE surface (the model
  // badge, the composer's round buttons), not as the ink button. Grok's
  // role for that is the secondary fill.
  ['--fill-primary', '--sand-bg-secondary'],
  ['--message-agent', '--sand-fill-bubble-agent'],
  ['--message-user', '--sand-fill-bubble-user'],
  ['--message-user-fg', '--sand-text-on-primary'],
  ['--background-menu-white', '--sand-bg-elevated'],
  // The guest desktop is a REMOTE SCREEN: it is dark in both themes, because
  // it shows a Linux desktop, not this app's surface. Its contents are
  // white-on-dark for the same reason.
  ['--background-agent-computer-frame', '#0d0d0d'],
  ['--background-agent-computer-placeholder', 'linear-gradient(180deg, #1a1a1a, #272727)'],
  ['--ok', '--sand-text-success-primary'],
  ['--ok-bg', '--sand-bg-success-secondary'],
  ['--danger-bg', '--sand-bg-danger-secondary'],
  ['--warning', '--sand-text-warn-primary'],
  // shadows
  ['--shadow-card', '--sand-shadow-popover'],
  ['--shadow-md', '--sand-shadow-popover'],
  ['--shadow-lg', '--sand-shadow-modal'],
  ['--shadow-agent-recommendation', '--sand-shadow-popover-ambient'],
  // Easings: Grok 0.75.0 no longer ships named easing tokens; these are the
  // curves its shipped CSS actually uses, kept as aliases for the recipes.
  ['--cursor-easing-default', 'cubic-bezier(.2,0,0,1)'],
  ['--cursor-easing-out', 'cubic-bezier(.23,1,.32,1)'],
  ['--cursor-easing-out-quint', 'cubic-bezier(.22,1,.36,1)'],
  // Radius ramp: Quansiox's --r-* names re-pointed VALUE-FAITHFULLY.
  // Grok's runtime injects a :root override at boot (zun template,
  // index.eager-app): base 8 / lg 10 / xl 14 / 2xl 16 / 3xl 18 — the
  // CSS-serialized values (6/8/12/14/16) never render. Quansiox authored
  // its components against xs 4 / sm 6 / md 8 / lg 10 / xl 12, so:
  // r-xs(4)=cursor-radius-sm, r-sm(6)=literal (6px is not on the runtime
  // ramp), r-md(8)=cursor-radius-base, r-lg(10)=cursor-radius-lg,
  // r-xl(12)=literal, r-full=full.
  ['--r-xs', '--cursor-radius-sm'],
  ['--r-sm', '6px'],
  ['--r-md', '--cursor-radius-base'],
  ['--r-lg', '--cursor-radius-lg'],
  ['--r-xl', '12px'],
  ['--r-full', '--cursor-radius-full'],
  // Motion: durations carry Grok's real values via the base palette; the
  // recipes' shorthand mirrors the original Quansiox pairing (--fast was
  // 120ms var(--ease)).
  ['--ease', '--cursor-easing-default'],
  ['--fast', '120ms var(--cursor-easing-default)'],
  // Compound elevation: Grok's runtime assembles the bare shadow COLORS
  // (ambient/key, serialized in CSS) into real box-shadows in the theme
  // assembly (f8 table, index.eager-app): ambient + key + a 1px ring.
  // The CSS layer never serializes these compounds, so alias them here.
  ['--sand-shadow-inline',
    '0 4px 12px -1px var(--sand-shadow-inline-ambient), 0 2px 4px -2px var(--sand-shadow-inline-key), 0 0 0 1px var(--sand-shadow-ring)'],
  ['--sand-shadow-popover',
    '0 10px 20px -3px var(--sand-shadow-popover-ambient), 0 4px 6px -4px var(--sand-shadow-popover-key), 0 0 0 1px var(--sand-shadow-ring)'],
  ['--sand-shadow-modal',
    '0 20px 32px -5px var(--sand-shadow-modal-ambient), 0 8px 12px -6px var(--sand-shadow-modal-key), 0 0 0 1px var(--sand-shadow-ring)'],
  ['--sand-shadow-window',
    '0 22px 70px 4px var(--sand-shadow-window-ambient), 0 0 0 0.5px var(--sand-shadow-window-edge)'],
  // Runtime component metrics: Grok injects these :root values at boot
  // (zun/Bun/Vun templates, index.eager-app ~3451k) — the CSS layer never
  // serializes them, but this is what the app actually renders. The radius
  // overrides REPLACE the bake values above them in the cascade, exactly as
  // Grok's own injection does.
  ['--cursor-radius-base', '8px'],
  ['--cursor-radius-lg', '10px'],
  ['--cursor-radius-xl', '14px'],
  ['--cursor-radius-2xl', '16px'],
  ['--cursor-radius-3xl', '18px'],
  ['--sand-menu-radius', '16px'],
  ['--sand-menu-row-radius', '10px'],
  ['--sand-menu-row-gap', '6px'],
  ['--sand-menu-row-height', '32px'],
  ['--sand-new-chat-menu-radius', '16px'],
  ['--sand-new-chat-menu-row-radius', '10px'],
  ['--sand-command-palette-radius', '18px'],
  ['--sand-command-palette-row-gap', '10px'],
  ['--sand-agent-item-radius', '12px'],
  ['--sand-agent-item-avatar-gap', '10px'],
  ['--sand-agent-item-title-gap', '1px'],
  ['--sand-transcript-prose-block-padding', '7px'],
];

function formatProps(pairs) {
  return pairs.map(([name, value]) => `  ${name}: ${value};`).join('\n');
}

/** CLI/programmatic options: `--out PATH`, `quiet`. */
/** Names Grok defines OUTSIDE the serialized theme blocks (hashed selectors,
 * Monaco/StyleX interop). The base-palette pass drops them as dangling
 * references — Grok's own CSS leaves them pointing at runtime-injected names
 * (--vscode-, --x- prefixed). This layer still must define Grok's full
 * sand/cursor vocabulary, so they are emitted with the value verbatim
 * and, where the value is a bare reference, an appended fallback: Grok's own
 * documented usage fallback where one exists (--sand-sidebar-width to 280px,
 * titlebar to 38px), otherwise an inert fallback (initial, currentColor,
 * transparent) so nothing dangles. Sources: shipped index CSS declarations
 * plus usage fallbacks in grok75-atoms.json (0.75.0 extraction, 2026-10-24). */
const SUPPLEMENT = [
  ['--cursor-box-shadow-workbench', '0 0 8px 2px color-mix(in srgb, var(--vscode-widget-shadow, transparent) 40%, transparent)'],
  ['--cursor-button-background', 'var(--vscode-button-background, initial)'],
  ['--cursor-button-foreground', 'var(--vscode-button-foreground, initial)'],
  ['--cursor-button-hover-background', 'var(--vscode-button-hoverBackground, initial)'],
  ['--cursor-font-family-mono', 'var(--monaco-monospace-font, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace)'],
  ['--cursor-font-family-sans', 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)'],
  ['--cursor-scrollbar-horizontal-size', 'var(--vscode-scrollbar-horizontal-size, 12px)'],
  ['--cursor-scrollbar-vertical-size', 'var(--vscode-scrollbar-vertical-size, 14px)'],
  ['--sand-activity-mark-ink', 'var(--x---sand-activity-mark-ink, currentColor)'],
  ['--sand-pin-row-cap', 'var(--x---sand-pin-row-cap, initial)'],
  ['--sand-shimmer-dim', 'var(--sand-text-tertiary)'],
  ['--sand-sidebar-width', 'var(--x---sand-sidebar-width, 280px)'],
  ['--sand-status-dot-ring', 'var(--sand-bg-elevated)'],
  ['--sand-titlebar-collapsed-block', 'var(--sand-titlebar-block,38px)'],
  ['--sand-toolbar-height', 'var(--sand-titlebar-block,38px)'],
];

function main(opts) {
  const options = opts ?? {};
  const cssPath = findGrokCss();
  const themesPath = findThemes();
  const out = options.out ?? arg('out', null);
  if (!cssPath || !fs.existsSync(cssPath)) {
    console.error('Could not find Grok Bot\'s shipped CSS.');
    console.error('Extract app.asar and pass --grok-css <path to index-*.css>.');
    process.exit(1);
  }
  if (!themesPath || !fs.existsSync(themesPath)) {
    console.error('Could not find Grok Bot\'s resolved theme table (light/dark).');
    console.error('Pass --grok-themes <path to grok-design-tokens.json>.');
    process.exit(1);
  }

  const css = fs.readFileSync(cssPath, 'utf8');
  const themes = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
  const version = grokVersion(cssPath);

  // The base palette.
  //
  // StyleX emits ONE `:root` block per component's variables, so the palette
  // is spread across many blocks — and a block may forward-reference a token
  // declared in another one. Taking only the largest block leaves dangling
  // references, so every `:root` block is merged.
  const merged = new Map();
  let baseName = '';
  const re = /:root[^{]*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const body = blockBody(css, m[0].slice(0, -1));
    if (!body) continue;
    const pairs = propsOf(body);
    if (!pairs.length) continue;
    if (!baseName) baseName = m[0].trim();
    for (const [name, value] of pairs) {
      if (!merged.has(name)) merged.set(name, value);
    }
  }
  // Resolve the palette completely: some tokens forward-reference a token
  // declared outside a `:root` block. Any such token whose value is a literal
  // is pulled in, so the generated layer has no dangling references.
  const literalRe = /(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+)/g;
  let scan = literalRe;
  let hit;
  while ((hit = scan.exec(css)) !== null) {
    const [, name, value] = hit;
    if (merged.has(name)) continue;
    const v = value.trim();
    // Only a literal: a var() would just move the dangling reference.
    if (v.includes('var(')) continue;
    if (v.length > 120) continue;
    merged.set(name, v);
  }
  // Drop the tokens whose value forwards to a token that does not exist.
  // Grok's own CSS has a few of these (`--cursor-button-background` points at
  // `--vscode-button-background`, which Grok never declares); carrying them
  // would just move the dangling reference into our file.
  const dangling = [];
  for (const [name, value] of [...merged.entries()]) {
    for (const ref of String(value).matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      if (!merged.has(ref[1])) { dangling.push(`${name} -> ${ref[1]}`); break; }
    }
  }
  for (const entry of dangling) {
    const name = entry.split(' -> ')[0];
    merged.delete(name);
  }

  const base = [...merged.entries()];
  if (base.length < 100) {
    console.error('Grok Bot\'s base token blocks were not found in the CSS.');
    process.exit(1);
  }

  const light = Object.entries(themes.light ?? {});
  const dark = Object.entries(themes.dark ?? {});
  if (!light.length || !dark.length) {
    console.error('the theme table has no light/dark palettes');
    process.exit(1);
  }

  // Every alias must point at a token that exists in the theme — or at
  // another alias in this layer (chaining, e.g. --ease -> --cursor-easing-*).
  const known = new Set([...base.map(([n]) => n), ...light.map(([n]) => n), ...dark.map(([n]) => n), ...ALIASES.map(([a]) => a), ...SUPPLEMENT.map(([n]) => n)]);
  const broken = ALIASES.filter(([, target]) => target.startsWith('--') && !known.has(target));
  if (broken.length) {
    console.error('These aliases point at tokens Grok does not have:');
    for (const [alias, target] of broken) console.error(`  ${alias} -> ${target}`);
    process.exit(1);
  }

  // A target that is not a token name is used verbatim (a gradient, say).
  const aliasPairs = ALIASES.map(([alias, target]) => [
    alias,
    target.startsWith('--') ? `var(${target})` : target,
  ]);

  // P1.4 adoption: every remaining name Grok's shipped CSS defines, taken
  // verbatim, in dependency-closure order. A name is adoptable only when all
  // of its var() references resolve inside the emitted set — otherwise it
  // chains to a runtime-injected value (StyleX --x--- / Monaco) the shipped
  // CSS never serializes, and adopting it would plant a dangling reference.
  // The closure iterates because an adoptable name may reference another
  // candidate that only becomes adoptable once its own deps are emitted.
  const emittedNames = new Set([
    ...base.map(([n]) => n), ...light.map(([n]) => n), ...dark.map(([n]) => n),
    ...aliasPairs.map(([n]) => n), ...SUPPLEMENT.map(([n]) => n),
  ]);
  const candidateDefs = new Map();
  {
    const anyDef = /(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+)/g;
    let hit;
    while ((hit = anyDef.exec(css)) !== null) {
      const name = hit[1];
      const value = hit[2].trim();
      if (emittedNames.has(name) || candidateDefs.has(name)) continue;
      if (value.length > 300) continue; // serialized junk (data URLs etc.)
      candidateDefs.set(name, value);
    }
  }
  const adopted = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, value] of [...candidateDefs]) {
      const refs = [...value.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]);
      if (refs.every((r) => emittedNames.has(r))) {
        adopted.push([name, value]);
        emittedNames.add(name);
        candidateDefs.delete(name);
        grew = true;
      }
    }
  }
  const unresolvable = [...candidateDefs.keys()].sort();

  const outText = `/* ============================================================
   Grok Bot ${version} — the SHIPPED design system.
   GENERATED by scripts/extract-grok-tokens.js. Do not edit by hand.

   Source CSS:   ${cssPath}
   Source theme: ${themesPath}

   This replaces Quansiox's previous token layer, whose colour
   names (--text-and-icon-primary, --background-primary,
   --fill-tsp-gray-main, --function-neutral, --button-primary)
   do not exist anywhere in Grok Bot's shipped CSS. Those were an
   approximation of a design system that had never been read, and
   they are why the app still looked like the old design.

   Since 0.75.0 the theme is resolved at runtime from tone, opacity,
   and recipe tables; the resolved light/dark tables here were
   produced by executing Grok's own resolver
   (work/grok-re/case/run-grok-resolver.js). The light table
   verifies token-for-token against the shipped CSS.

   Grok's real vocabulary:
     --cursor-*   the base palette (${base.length} tokens)
     --sand-*     the product theme (${light.length} light / ${dark.length} dark)
   ============================================================ */

:root {
  /* ---- the base palette, verbatim from Grok Bot ---- */
${formatProps(base)}

  /* ---- the "sand" product theme: light ---- */
${formatProps(light)}

  /* ---- Quansiox's semantic aliases, resolved to Grok's tokens ---- */
${formatProps(aliasPairs)}

  /* ---- supplemented: names Grok defines outside the theme blocks ----
     Verbatim values; bare references to runtime-injected names carry an
     appended fallback (Grok's documented one where it exists: sidebar 280px,
     titlebar 38px; otherwise inert). See SUPPLEMENT in this script. */
${formatProps(SUPPLEMENT)}

  /* ---- Grok app-level constants, adopted verbatim (P1.4) ----
     Every remaining name Grok's shipped CSS defines, taken verbatim in
     dependency-closure order — geometry, pane/scale-layer, conversation,
     editor, dataviz and control knobs. Only names whose var() references
     all resolve inside this layer are adopted; the rest reference
     runtime-injected values (StyleX --x--- interop, Monaco) that the
     shipped CSS never serializes and are recorded in the drift baseline
     as the honest residual. */
${formatProps(adopted)}
}

html[data-theme='dark'] {
  /* ---- the "sand" product theme: dark ---- */
${formatProps(dark)}
}

/* The system appearance, when the user has not chosen one. Grok follows the
   system by default; Quansiox should too. */
@media (prefers-color-scheme: dark) {
  html:not([data-theme='light']) {
${formatProps(dark)}
  }
}
`;

  const target = out ?? OUT;
  fs.writeFileSync(target, outText);
  if (options.quiet) return target;
  console.log(`wrote ${path.relative(ROOT, target)}`);
  console.log(`  base palette:   ${base.length} tokens (from ${baseName})`);
  console.log(`  sand light:     ${light.length} tokens`);
  console.log(`  sand dark:      ${dark.length} tokens`);
  console.log(`  aliases:        ${aliasPairs.length}, all resolved`);
  if (dangling.length) console.log(`  pruned:         ${dangling.length} tokens with dangling references`);
  console.log(`  adopted (P1.4): ${adopted.length} app-level constants verbatim`);
  console.log(`  unresolvable:   ${unresolvable.length} names blocked on runtime-injected values (kept out; see baseline)`);
  return target;
}

if (require.main === module) main();

module.exports = { ALIASES, findGrokCss, findThemes, grokVersion, main };
