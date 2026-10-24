# Renderer fonts — not distributed

The design layer pins the typefaces used by Grok Bot 0.75.0 (`XVF`,
`XVF Mono`, `cursor-icons`). The `.woff2` binaries are proprietary and are
deliberately NOT committed to this public repository.

`grok-fonts.css` still declares the `@font-face` blocks, and every font
stack falls back to system fonts (`-apple-system`, `ui-monospace`, …), so
the app renders — with substitute faces — until the files are restored.

Restoring locally (requires a lawfully obtained copy of the app):

1. Extract `app.asar` from the Grok Bot bundle.
2. Copy the three files from `dist/renderer/assets/` into this directory
   under the names `SHA256SUMS` expects:

       X-VF-*.woff2             -> X-VF.woff2
       XMono-VF-*.woff2         -> XMono-VF.woff2
       cursor-icons-16-*.woff2  -> cursor-icons-16.woff2

3. Verify byte-identity:  `shasum -a 256 -c SHA256SUMS`

Notes for fresh clones:

- `test/design-system.js` asserts the fonts are present and will fail
  until they are restored.
- The token pipeline (`scripts/extract-grok-tokens.js`) and
  `test/design-drift.js` expect an extracted app bundle under
  `work/grok-re/asar-extracted/`, which is likewise not distributed.
