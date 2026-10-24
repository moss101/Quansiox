# Asset policy — output parity, not artifact parity

Decision date: 2026-10-24. Decided by: engineering lead directive (this repo).
Supersedes: any task wording in `docs/parity/parity-task-list.md` that says
"verbatim", "adopt … verbatim", or "license-consistent" about Grok-derived
assets. Gated items (P1.3, P2.1) are rewritten in that file to comply.

## The decision

Quansiox pursues **rendered-output parity** with Grok Bot's design, never
**artifact parity**. The parity gate is what the app renders — pixels,
geometry, computed styles — never byte-identical copies of Grok's assets.

## The rule: facts are free, artifacts are not

**Facts** — measured values and identifiers — may be extracted, recorded,
and re-expressed:

- token values (colors, opacities, radii, durations, easings, shadows);
- geometry and metrics (rail widths, row heights, padding, font stacks);
- names and identifiers (host-API method names, ActionName enums,
  keybindings, scheme names);
- structural observations (component inventories, behavior taxonomies).

**Artifacts** — creative works — are never committed to this repository and
never redistributed:

- font binaries (XVF, XMono, cursor-icons — vendored locally only, never
  committed; `src/renderer/fonts/SHA256SUMS` documents the lawful restore
  path);
- Grok's stylesheet source, including hashed StyleX class CSS;
- translated catalogs (Lingui `.po` files), marketing copy, plan-ladder
  text, connector catalog text, role-template prose;
- screenshots/captures of the Grok app (local reference material under
  `work/` only — `work/` is gitignored).

## How Grok data enters the repo

Only through the generator, as **values re-expressed in Quansiox's own
vocabulary**:

1. `scripts/extract-grok-tokens.js` emits measured token values as
   `--cursor-*` / `--sand-*` properties plus Quansiox's alias layer
   (`--r-*`, `--shadow-*`, semantic recipes in `grok-components.css`
   authored here).
2. Component recipes are derived from the extracted atoms database
   (facts: geometry, fills, radii) and hand-authored as Quansiox classes.
   Quansiox JSX never emits Grok's hashed class names.
3. The runtime-resolved theme subsystem is executed locally to produce
   theme tables; its output (values) is committed, its source (Grok's
   minified code) is not.

## Enforcement

- `test/design-drift.js` — pins generated tokens to Grok's bundle and pins
  the vocabulary-coverage numbers (required / tracked / extra) to
  `test/fixtures/vocabulary-baseline.json`. Numbers quoted in docs must
  come from that baseline.
- `test/design-system.js` — accepts the system-font fallback stacks; the
  exact faces are a local-only verification concern.
- `test/visual-diff.js` (P1.6 harness) — the compliance-friendly parity
  gate: surfaces must match *our own committed baselines* within declared
  tolerances, and may be compared against local Grok captures
  (`QUANSIOX_GROK_REF_DIR`) report-only. No Grok bytes are distributed.
- Review rule: any PR adding a file whose bytes originate from the Grok
  bundle (fonts, CSS, catalogs, screenshots) is rejected by default;
  derived values must arrive via the generator.

## Why

This repository is public and MIT-licensed. Redistributing proprietary
binaries or stylesheet source under it is infringement regardless of
provenance notes, while measured facts and output parity are both defensible
and sufficient for the "looks exactly like Grok" goal. Provenance hashes
remain useful — but only as local restore verification, never as a license.
