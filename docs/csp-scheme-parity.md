# CSP + custom-scheme parity map (P1.5)

Grok Bot 0.75.0 registers seven custom schemes and allows them in its CSP
(evidence: extracted `renderer/index.html`, see `compare-codebases.md` §1).
Quansiox's CSP is intentionally stricter (`default-src 'self'` with no remote
origins — local-first) and uses `qx-*` naming. This map is the contract: every
Grok scheme has a named Quansiox equivalent and a status; nothing in this
table may weaken the CSP (no new remote origins, no `unsafe-eval`).

| Grok scheme | Purpose | Quansiox equivalent | Status |
|---|---|---|---|
| `sand-media:` | message media (filmstrip, `image/<32hex>`) | `qx-artifact://` (media artifacts are artifacts) | implemented — `qx-artifact` serves session artifacts incl. media |
| `sand-avatar:` | avatars without origin round-trips | `data:`/`qx-artifact://` | implemented via data URLs + artifacts |
| `sand-favicon:` | fetched site icons, origin-isolated | `qx-artifact://` (cached fetch) | partial — favicons served as artifacts |
| `sand-html-preview:` | sandboxed HTML preview iframes | `qx-artifact://` in sandboxed `BrowserWindow` partition `qx-artifact` | implemented (windowManager artifact windows; CSP forbids network) |
| `sand-canvas:` | canvas app documents | `qx-artifact://` | partial — canvas runtime loads artifact documents |
| `sand-mcp-app:` | MCP app surfaces | — | pending (MCP apps surface, P2.9) |
| `sand-visualization:` | per-message visualization sandboxes | — | pending (`qx-visualization:` design reserved, P2.7) |
| `https://grok.com` (CSP) | vendor origin | none — deliberately absent | by design: no remote vendor origin in Quansiox's CSP |

Loopback connections: Quansiox allows `connect-src 'self' ws://127.0.0.1:*`
for the per-session screen/computer bridges (verified by
`test/renderer-check-main.js`); Grok allows its vendor origin instead.

## Rules of change

1. A new `qx-*` scheme is registered in `src/main/index.js`
   (`registerSchemesAsPrivileged`) and added to this table in the same
   commit — never a bare CSP string edit.
2. The CSP in `src/renderer/index.html` is only widened for registered
   `qx-*` schemes; remote origins require a permission-boundary review
   (governance: no new network egress).
3. `test/parity-bootshell.js` asserts this file exists and covers all seven
   Grok schemes, so the map cannot silently rot.
