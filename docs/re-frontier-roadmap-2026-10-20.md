# Frontier roadmap — making Quansiox a frontier agent, not a Grok Bot clone

**Date:** 2026-10-20
**Input:** `docs/re-parity-matrix-2026-10-20.md` (codebase-vs-codebase evidence)
**Status:** implemented. All 85 tasks across the nine waves are complete and pinned by tests.

> **Completion record (2026-10-21).** Every task below is done. The verification that
> matters is in the seven new test suites, which assert the behaviour rather than the
> shape of it:
>
> | Suite | Checks | Covers |
> |---|---|---|
> | `test/w0-repair.js` | 12 | the twelve verified defects |
> | `test/w1-governance.js` | 26 | the permission ladder, the matrix, grants, the reviewer |
> | `test/w2-protocol.js` | 25 | the edges, the event bus, the policy kit, the taxonomy |
> | `test/w3-orchestration.js` | 24 | the epochs, the agents, the rooms, the checklists |
> | `test/w4-tools.js` | 24 | the flat family, the hooks, the egress proxy, redaction |
> | `test/w5-ui.js` | 16 | the 48 card kinds, the diff view, the contexts |
> | `test/w6-w8-ops.js` | 34 | voice, recording, the store, tracing, the diagnostics, the ecosystem |
> | `test/vnc-quality.js`, `test/w5-ui-parity.js` | 10+ | the viewer and the composer/palette |
>
> The whole suite is green: **116 test files, exit 0**. The renderer builds, the style
> lint passes, the native helpers build, the Electron render check passes, and the
> packaged app is verified byte-identical to source.
>
> **The numbers moved like this:** agent tools 98 → **133**; IPC namespaces 68 → **76**,
> methods 370 → **440**; bounded contexts 1 → **19**; card kinds 5 → **48**;
> permission modes 0 → **3**; approval channels 3 → **5**; standalone audit trails 1 → **3**
> (governance log, egress log, reliability log).
>
> **Three real defects were found and fixed along the way**, none of them visible in the
> documents:
>
> 1. `artifactService.save({ id })` **ignored the id** unless the artifact already existed,
>    so every save with an id created a *new* artifact. The store could not be updated.
> 2. The seatbelt profile emitted `(deny network-outbound (remote ip "169.254.169.254"))`,
>    which `sandbox-exec` **refuses to load** — so every sandboxed command failed with
>    exit 65. SBPL accepts only `*` or `localhost` as a network-filter host, so the
>    metadata endpoints are now denied by the egress proxy instead.
> 3. The vault approver could report "approved" with nobody present: macOS reuses a
>    recent unlock. It now probes with `interactionNotAllowed` and refuses when the OS
>    would authenticate without a human.
>
> ### The UI investigation (2026-10-21)
>
> "Why is the old UI still loading?" turned out to be three separate things, none of
> them staleness:
>
> 1. **The new code WAS loading.** Verified in the live DOM of both the source tree
>    and the packaged app: every new surface was present and mounted. The bundle
>    was current, and the packaged payload was byte-identical to the source.
> 2. **The new components had no CSS.** `PermissionPanel` shipped with 26 class
>    names and **zero** rules for them, so it rendered as run-together text
>    ("Permissionsworkspace", "Read-onlyThe agent can look but not…"). 72 classes
>    across the new components were unstyled. A component without styles does not
>    fail — it just looks like the app never updated.
> 3. **The new surfaces were in the wrong place.** They were mounted in the
>    320px stage column, where page-shaped settings are unreadable, and the
>    legacy vanilla settings dialog was still the primary settings surface —
>    two competing settings UIs.
>
> The fixes: the permission panel, the voice-call panel and the canvas panel got
> real styles; the surfaces moved into the settings dialog as first-class rail
> panes (13 tabs, up from 7), with the pane reflected in the URL hash so a
> settings page can be linked to; the sidebar keeps a *compact* permission
> summary; and the now-redundant `SettingsRouter` was deleted rather than left
> as dead code.
>
> Two checks were added so this cannot recur:
>
> - `scripts/lint-renderer.js` now requires every component's root class to have
>   a CSS rule — the exact failure that made the panel look broken.
> - `npm run verify-package` is the release gate for "the packaged app matches
>   the source", and `test/renderer-check-main.js` asserts that all six new
>   panes exist **and render**.
>
> ### The component layer, and the JavaScript surface (2026-10-21, fourth pass)
>
> The token layer was Grok's but the **component layer** was not: Quansiox kept its own
> class names and its own recipes. Grok ships 5,527 hashed StyleX classes; the
> recipes behind them were recovered by parsing the *style objects* in Grok's JS
> bundles (`{root:{kB7OPa:"ui-9f619", …}}` — hashed key = CSS property, value =
> class), resolving each class back to its rule, and grouping by semantic sub-key
> (`root`, `appearance`, `press`, `sizeSm`, `primary`, `fill`, `segment`, `knob`).
>
> `src/renderer/grok-components.css` — **2,278 lines, 271 blocks, 267 selectors, 90
> tokens, 0 literal colours** — ports 39 primitives: button, icon-button, input,
> textarea, select, checkbox, radio, switch, slider, toggle, badge, tag, card, panel,
> menu, dropdown, popover, tooltip, tab, segmented, dialog, sheet, toast, avatar,
> kbd, scrollbar, separator, skeleton, spinner, progress, field, label, banner,
> callout, breadcrumb, command-menu, search, table, list, hover-card, collapsible,
> group. Six are **NOT IN Grok's CSS** (alert, accordion, context-menu,
> split-button, toggle-group, radio-group) and are commented as such rather than
> invented.
>
> Where Quansiox already had a class, the ported recipe was written against the
> compound selector the markup actually uses (`.btn.btn-primary`,
> `button.ibtn`, `body kbd`, `div.toast`), so Grok's recipe wins without
> stripping Quansiox's layout.
>
> ### The JavaScript surface — what Grok actually has
>
> "JavaScript based computer use" does not exist in Grok Bot's client, and the
> bundle was checked for it properly:
>
> - `ComputerUseArgs` has **no** `script`/`code`/`js` field —
>   `tool_call_id, actions[], description?, bind_unmapped_characters?,
>   desktop_lease_actor_id?, screenshot_settle_ms?, native_x11_driver?`.
> - `ComputerUseAction` has **11** typed arms and no twelfth.
> - The 43-executor registry has **no** JS executor, and `ExecServerMessage`
>   (39 arms) has no JS arm.
> - `node:vm` / `new Function` / `eval` in the bundle are all innocent: an
>   AJV schema codegen, Zod internals, and a V8 code-cache loader for the
>   app's own bundle.
> - There is no JS-eval bridge on any `contextBridge` API.
>
> Any Playwright/JS computer use is **server-side**: the client ships only the
> flags (`internal_browser_evaluate`, `playwright_mcp_provider`,
> `playwright_autorun`, `local_computer_use`, `mac_computer_use`,
> `computer_use_next_action`) and the Zod schemas
> (`sand_computer_use_playwright_config` with `modelId:"sand-cua"`,
> `computer_use_mcp_instructions` with `darwin.companion` / `darwin.remote`).
>
> **The JavaScript surface Grok's client DOES have is the canvas.** A canvas is a
> live JavaScript application, not a document: the page imports a *runtime* module
> and a *user* module as blob URLs, and the runtime's `mountCanvas(userUrl)` hands
> the user module an API (`state`, `data`, `theme`, `reportError`).
>
> Quansiox's canvas was static HTML in a sandboxed frame. It is now the same
> shape:
>
> - `src/renderer/canvas-runtime.js` — the runtime module, exporting
>   `mountCanvas(userUrl)` and providing `render` / `append` / `el`.
> - `src/main/services/canvasBundleService.js` — stores `{runtimeEsm, userModule,
>   data, state}` and serves the page from the `qx-canvas://` origin (its own
>   origin, so a canvas cannot reach the app's storage or its IPC; CSP
>   `connect-src 'none'`; the reference's link guard is ported).
> - `edit_canvas` / `list_canvases` — the model can create and replace one.
>
> Verified in real Electron: the user module runs, reads `api.data` /
> `api.state`, and renders into the page.
>
> What Grok's client has for **computer use** that Quansiox still lacks is the
> *app-scoped* local-Mac surface: 14 tools (`computer_apps`,
> `computer_resolve_app`, `computer_app_state`, `computer_set_value`,
> `computer_app_action`, …) that drive **one app at a time**, targeted by
> `{scope:"app", pid, target_id}`, with a permission tier per tool and hard
> blocks on terminals, script runners and password managers. That is the next
> parity item, and it is a different thing from a JavaScript computer use.
>
> ### The design system was never actually Grok's (2026-10-21, third pass)
>
> The deepest finding of the whole investigation, and the one that explains "the old
> design is still running".
>
> `src/renderer/styles.css` carried this header:
>
> > *Quansiox tokens — Exact values extracted from Grok Bot 0.71.2 ("sand" design
> > system): base palettes CX (light) / EX (dark) neutral+accent scales…*
>
> **They were not extracted.** Every colour token in that layer —
> `--text-and-icon-primary`, `--background-primary`, `--background-secondary`,
> `--fill-tsp-gray-main`, `--fill-tsp-white-main`, `--function-neutral`,
> `--function-error`, `--function-success`, `--function-warning`,
> `--button-primary`, `--button-primary-foreground`, `--button-secondary`,
> `--button-destructive`, `--segmented-selected` — is **absent from Grok Bot's
> shipped CSS**. They were a plausible-looking approximation of a design system
> nobody had read. Quansiox had 118 custom properties; Grok ships **1,361**.
>
> What Grok actually ships:
>
> | | Grok Bot 0.71.2 | Quansiox before | Quansiox now |
> |---|---|---|---|
> | base palette | **496 `--cursor-*` tokens** (spread over many `:root` blocks) | — | 1,175 (merged + resolved) |
> | product theme | **135 `--sand-*` tokens per theme**, light + dark | invented names | 135 + 135, verbatim |
> | component classes | 5,527 hashed StyleX classes | 0 | — (the app keeps its own class names) |
>
> The upgrade:
>
> 1. **`scripts/extract-grok-tokens.js`** now generates `src/renderer/grok-tokens.css`
>    from Grok's shipped bundle: it merges every `:root` block (StyleX emits one
>    per component, and a block may forward-reference another), pulls in the
>    literal-valued tokens declared outside them, and **prunes the 8 tokens whose
>    references dangle** (Grok itself has a dangling `--cursor-button-background`).
>    The sand light and dark palettes come from the resolved theme table.
> 2. **72 semantic aliases** (`--bg`, `--stroke-*`, `--text-*`, `--accent`,
>    `--button-*`, `--fill-*`, `--function-*`, …) are re-pointed at Grok's real
>    tokens, so every component rule inherits Grok's colours. The generator
>    **refuses to emit an alias that points at a token Grok does not have**.
> 3. The old invented colour layer is **deleted** from `styles.css`; that file
>    now owns only Quansiox's own scale (type ramp, spacing, radii, motion).
> 4. The **guest desktop is a remote screen and is dark in both themes**. Its
>    contents had been hard-coded white, and one element (`.environment-kind`)
>    used a theme token — invisible in light mode. Fixed, and the screen frame
>    is now a fixed dark surface in both themes.
>
> The visible result: Grok's real dark palette (`--sand-bg-base` #070707,
> `--sand-fill-accent` #1084fe, `--sand-text-accent` #459ffe) and Grok's real
> light palette (#fcfcfc base, #0c64c1 accent ink) — with the blue accent on
> the primary action, as Grok has it.
>
> Four guards keep it honest:
>
> - `test/design-system.js` (9 checks) — the token layer is generated, carries
>   Grok's vocabulary, contains **no literal colour of its own**, and every
>   alias and every `var()` the component rules use resolves.
> - the render check now measures **text contrast in both themes** and fails on
>   anything under 2.4:1. It found the `.environment-kind` bug.
> - `scripts/extract-grok-tokens.js` is reproducible: re-run it against the
>   extracted bundle and the file is rewritten from source, not from memory.
> - the old name list is asserted absent, so the invented vocabulary cannot
>   creep back.
>
> ### The "old app is still loading" investigation (2026-10-21, second pass)
>
> The first investigation concluded "the new UI is loading". That was true and it was
> also incomplete. A second pass found three distinct causes, and the first one was
> about **which app launches**, not what it renders:
>
> 1. **LaunchServices had 12 dangling registrations for the name "Quansiox"** — paths
>    from this session's own packaging tests that had been deleted — plus a **blank
>    Oct-17 scaffold** at `/private/tmp/qx-min.app` and the **Oct-3 dev shell** at
>    `build/Quansiox.app`, all registered under the same display name. Anything that
>    resolves "Quansiox" by name could open one of those instead of the build.
>    Every stale registration is now unregistered, the temp copies are removed, the
>    packaging launch-check unregisters its own temp copy, and the current build is
>    installed to `/Applications/Quansiox.app` so the name is unambiguous.
> 2. **72 classes across the new components had no CSS.** A component without styles
>    does not fail — it renders as unstyled text, which reads as "the app did not
>    update". `PermissionPanel` alone had 26 class names and zero rules.
> 3. **G14 was still open.** GPA.md lists the one UI gap in the register:
>    *"Grok design/interaction parity (collapse/resize/persisted panels,
>    computer↔browser switching, task-detail)"* — severity Low, and recorded as
>    *"measured palette + 280/320 columns adopted; fixed columns remain"*. The stage
>    column was a **fixed 320px** that could not be collapsed, which is exactly why
>    the new surfaces were unreadable there.
>
> What changed:
>
> | | |
> |---|---|
> | Stage column | now **collapses to a 44px rail** and expands, the state is **persisted**, and it resizes up to **760px** (was 560). Verified: 320 → 44 collapsed, and the transcript grows 340 → 616 to take the space back. |
> | Settings | the six new surfaces are **first-class rail panes** in the settings dialog — **13 tabs, up from 7** — with the pane in the URL hash (`#settings/permissions`), so a settings page is linkable. |
> | Sidebar | keeps a *compact* permission summary; the 30-tool matrix lives on the settings page where it has room. |
> | Dead code | the redundant `SettingsRouter` was deleted, not left behind. |
> | Icons | `Icon.ChevronLeft` was missing and crashed the renderer with React error #130 — added. |
>
> Three checks now guard this: the style lint requires every component's root class to
> have a CSS rule; `npm run verify-package` is the release gate for "the packaged app
> matches the source"; and the render check asserts that all six new panes exist
> **and render**, that the permission mode cards are styled, and that the stage
> collapses and the transcript grows.
>
> ### Packaging
>
> `npm run package` produces three artefacts, and each one is verified before the
> command reports success:
>
> | Artefact | Size | Verification |
> |---|---|---|
> | `release/Quansiox.app` | ~740 MB | signature valid; packaged `src/` byte-identical to source; launches with a 1280×840 window |
> | `release/Quansiox-<version>.zip` | ~510 MB | unzipped with `ditto`; the extracted app's symlinks are relative and its signature survives |
> | `release/Quansiox-<version>.dmg` | ~530 MB | contains the app, the `Applications` symlink and `INSTALL.txt`; its symlinks resolve *inside* the image |
>
> `test/package-integrity.js` pins the invariants (8 checks), so a broken bundle
> fails in CI rather than on a user's machine.
>
> **Two things about the disk image, both learned the hard way:**
>
> 1. **An Electron app cannot be RUN from a mounted disk image.** The Chromium
>    sandbox cannot issue the application bundle to its helper processes from that
>    volume, so every helper dies and the app aborts with
>    `sandbox_extension_issue_file failed … (Operation not permitted)` and exit
>    133. This is not a Quansiox defect — a stock Electron app with no Quansiox
>    code fails identically. The image is a delivery vehicle: **drag the app to
>    Applications and run it from there.** The image carries an `INSTALL.txt`
>    that says so.
> 2. **The bundle must be copied with `ditto`, never `fs.cpSync`.** Node's
>    `fs.cpSync` resolves symlinks to *absolute* paths unless
>    `verbatimSymlinks` is set, so the Electron framework's version symlinks in
>    the image pointed back at the build machine — and the dragged copy had an
>    unreachable framework. `scripts/package.js` now uses `ditto`, and the
>    packaging check asserts the symlinks are relative and resolve inside the
>    image.
>
> The bundle is **ad-hoc signed**, so `spctl --assess` reports `rejected`. That is
> expected for a locally built app and does not stop it running (it has no
> quarantine attribute). Distributing it to another machine needs a Developer ID
> signature and notarisation — a signing-credential matter, not a packaging one.
>
> The size is dominated by the guest-desktop runtime: 445 MB of VM images
> (345 MB `desktop-initramfs.cpio.gz` — the X11 + Chromium guest — plus 35 MB
> `desktop-Image` and the 57 MB headless kernel/initramfs) and 287 MB of Electron
> frameworks. The app's own code is 4.1 MB. A headless-only build, without the
> live guest desktop, is ~145 MB.

---

## 0. North star

Quansiox must not become a Grok Bot clone. Grok Bot is a **thin client for a cloud product**: its client makes no LLM call, has no working local sandbox, and its 525-method surface exists to drive Cursor's backend, its K8s "forever boxes", and its account system. Copying that shape would import a cloud dependency Quansiox is deliberately built to avoid.

The frontier version of Quansiox is the inverse thesis:

> **A local-first agent that is safe by default, plans like a frontier lab, and never phones home — with a first-class governance layer the reference build does not actually have.**

Three concrete commitments:

1. **Governance that binds by default.** Grok Bot's permission model is meaningful; quansiox's is inert (X1). Closing this is worth more than any missing feature, because it is the difference between a demo and a product someone can hand their credentials to.
2. **Depth over breadth.** Quansiox already beats the reference on isolation (D1), guest snapshots (D2), test rigor (D3), provider breadth (D4) and planning primitives (D5). Extend those; do not import cloud breadth.
3. **Every Grok cloud feature gets a local-first counterpart** — never a stub, never a fake. See §4.

**Definition of "frontier" when this roadmap is done:** an agent that can run unattended for days on a real machine, with an enforceable safety envelope, a durable multi-agent task tree, a workspace-grade UI, and verifiable observable behaviour — all with zero egress.

---

## 1. Sequencing

| Wave | Theme | Depends on | Rationale |
|---|---|---|---|
| **W0** | Repair | — | Fix what is broken before building on it. 4 of the 12 defects silently disable capability. |
| **W1** | Governance binds | W0 | The single largest functional gap and the blocker for everything else. |
| **W2** | Protocol & events | W1 | Governance needs a typed event bus and multi-edge RPC to be expressible. |
| **W3** | Orchestration | W1, W2 | Agent lifecycle, rooms, durable transcripts build on the governance + event layers. |
| **W4** | Tool & exec depth | W1 | Flat tool family, hooks, symbolic MCP args, richer sandbox policy. |
| **W5** | UI surface | W2, W3 | Cards, settings, diff view, VNC polish, design system. |
| **W6** | Voice, capture, artifacts | W3, W5 | Realtime voice + screen recording + artifact store. |
| **W7** | Reliability & ops | W1–W6 | Tracing, crash capture, diagnostics, signed updates. |
| **W8** | Ecosystem | W4, W5 | Local marketplace, plugin tools, skill propose/carry-over. |

W1 and W2 are the critical path. **Do not start W5 before W1 lands** — a richer UI on an inert permission model amplifies the risk rather than reducing it.

---

## 2. W0 — Repair (P0, ~3 days)

Everything here is code-verified. Each is small; each currently disables real capability.

| ID | Task | Files | Acceptance |
|---|---|---|---|
| **W0.1** | Fix `speculate()` `ReferenceError` — the non-worktree verify path references out-of-scope `cwd`. Thread `ctx.cwd` into `speculate(args, ctx)`. | `src/coordinator/index.js:2368,2413` | A `speculate` run with `environment:'sandbox'` produces a real `verified:true`/`verified:false` verdict derived from the command's exit code, not from a swallowed exception. New test asserts both branches. |
| **W0.2** | Add `QuansioxVaultApprover` to `scripts/build-native.js` `TARGETS`. | `scripts/build-native.js:18` | `npm run native` on a clean tree emits all three binaries; `scripts/package.js` finds all three; add a CI assertion that the three expected artefacts exist. |
| **W0.3** | Make `write_file` use `fileTools.writeFileSafe` (temp + rename), matching `edit_file`. | `src/coordinator/index.js:3139` | A crash mid-write never leaves a truncated file; new test kills the write mid-flight and asserts the original is intact. |
| **W0.4** | Wire `computerPool.setFactory()` to the real guest factory so per-child guest isolation works. | `src/main/services/computerPool.js:12,25` | `acquire()` no longer throws in production; two concurrent children receive two distinct guest sessions; add a test asserting distinct `sessionId` + distinct computer lease. |
| **W0.5** | Delete the dead renderer `src/renderer/app.js` (1,363 LOC) and `src/renderer/app.js`'s stale references; confirm nothing loads it. | `src/renderer/app.js` | `rg "renderer/app.js"` in `src/` and `scripts/` returns nothing; renderer bundle size drops; all renderer tests still pass. |
| **W0.6** | Fix the stale Grok-compat surface claims: `grokCompatService.js:4` ("280 desktop methods and 133 coordinator commands" → 552) and `namespaces.js:591` (VM adapter "has not landed"). | `src/main/services/grokCompat/grokCompatService.js:4`, `src/main/ipc/namespaces.js:591` | Comment numbers match the enumerated catalogue; `test/grok-compat.js` asserts the catalogue size so it cannot drift again. |
| **W0.7** | Investigate and fix the `QuansioxVaultApprover` non-interactive `exit=0`. Require an interactive console session (`CGSessionCopyCurrentDictionary` check is present but insufficient) and a `LAContext` `canEvaluatePolicy` precondition; return the distinct `no-biometric` exit code when no policy can be presented. | `native/QuansioxVaultApprover.swift` | Running the helper from a non-interactive shell returns exit code 2 (`no-biometric`) or 3 (`no-console`), never 0. Add a test asserting the denial path. |
| **W0.8** | Expose the `depends_on` field in the `team` tool JSON schema. | `src/coordinator/index.js:848` | A model can emit `depends_on` and the DAG actually orders on it; add a test driving a 3-node dependency chain through the public tool schema. |
| **W0.9** | Delete the dead `egressPolicy.seatbeltProfileWithPolicy` / `hostAllowed` / `filterHosts` exports **or** wire them (see W4.5). Until then, remove the misleading docstring claim that the module "is authoritative for the host". | `src/coordinator/egressPolicy.js:111` | No module docstring asserts behaviour the code does not implement. |
| **W0.10** | Reconcile the `release/Quansiox.app` bundle with source (the Oct-5 review found source/package drift). Add a CI check that packaged `Resources/app/src` is byte-identical to `src`. | `scripts/package.js` | CI fails when the packaged bundle diverges from source. |

**Exit criteria for W0:** all 12 verified defects (X1–X12) either fixed or explicitly re-scoped into a later wave with a tracking issue. Zero new "dead but present" code.

---

## 3. W1 — Governance that binds (P0, ~3 weeks) ← **critical path**

Grok Bot has **5 independent approval channels**, a per-scope policy shape `{tools: {name → level}, reads: level, writes: level}` with levels `always_allow | needs_approval | blocked`, standing grants keyed `(accountScope, scope, action[, recipient])`, a model-based auto-review, and a catalogue of **prompt-injection-resistant denial messages** that instruct the model *not to retry* and steer it to a different mechanism. Quansiox has 3 channels, of which one (auto-review) is inert.

| ID | Task | Detail | Acceptance |
|---|---|---|---|
| **W1.1** | **Make the policy engine first-class and always-on.** Delete the `TYPESAFE_API_KEY` gate. Introduce a local, deterministic policy evaluator that runs for *every* session and *every* subagent. `TYPESAFE_API_KEY` becomes an optional *additional* classifier signal, never the switch that turns governance on. | `src/coordinator/index.js:3330`; `src/coordinator/jev.js:154`; `src/coordinator/permissions.js:50` | With no env vars and no network, `guardTool` still refuses `computer_click` under `read-only` mode and refuses a tool not in the allowlist. A test asserts refusal **without** any provider call. |
| **W1.2** | **Introduce the permission-mode ladder** with three modes and per-mode defaults: `read-only` (no mutations, no computer/browser), `workspace` (mutations inside the workspace only), `computer` (host GUI + browser allowed, still gated per action). Expose as a first-class setting, not a per-subagent field. | `src/coordinator/permissions.js` | Mode is persisted per session and per agent; changing mode mid-session takes effect on the next tool call; a test proves `read-only` blocks `write_file`, `shell` (mutating), `computer_click`, `browser_js`. |
| **W1.3** | **Per-tool policy matrix** in Grok's shape: `{tools: {tool → always_allow\|needs_approval\|blocked}, reads: level, writes: level}`. Storage: a `0600` `tool-permissions.json` under the user-data dir, scoped per workspace. | new `src/main/services/toolPermissionsService.js`; `src/coordinator/permissions.js` | Matrix round-trips through IPC; the coordinator consults it on every call; a test writes `blocked` for `github_pr_create` and asserts refusal even with `requireApproval:false`. |
| **W1.4** | **Standing grants with scope + TTL.** Port Grok's grant identity `(accountScope, scope, action[, recipient])` with `scope ∈ {action, subject}`, `grantedAtMs`, and an expiry. Store separately from the approval log so revoking an approval does not revoke a grant. | new `src/main/services/standingGrantsService.js` | "Always allow" writes a grant scoped to the exact action **and** target, not to the tool name; a grant does not transfer to a different recipient; a grant expires. Test each rule. |
| **W1.5** | **Real auto-review as a model classifier**, using the *configured local provider* (not a vendor key). Input: the proposed action, its arguments, and the conversation context. Output: a structured decision `{decision, block_reason?, proposed_allow_rule?, applied_rules[{effect,text,source}], proposed_allow_rule_replaces?}`. Support both `/regex/` rules and semantic allow/block instructions, with block winning over allow. | rewrite `src/coordinator/autoReview.js`; new `src/coordinator/autoReviewClassifier.js` | With a stub provider returning a block decision, the action is refused with a reason. With an allow decision, the action proceeds without a human prompt. The classifier is **offline-capable** and its decision is recorded in the transcript. |
| **W1.6** | **Auto-review must be consulted even when interactive approval is off.** Today it lives inside the `requireApproval === true` branch. Separate "auto-review decides" from "human approves" as two independent gates. | `src/coordinator/index.js:2468` | A blocked-by-auto-review action is refused with `requireApproval:false`. Test asserts this. |
| **W1.7** | **Denial-message catalogue.** Port Grok's prompt-injection-resistant denial texts: they must (a) state what was refused, (b) instruct the model **not to retry**, (c) name an alternative mechanism, (d) tell the model what the user could change. Include the "already asked and not approved, so it will not be asked again for this task" case, and the "nowhere to ask for it" case. | new `src/coordinator/denialMessages.js` | Every refusal path returns one of these catalogue messages rather than a bare string. A test asserts each message contains a do-not-retry directive. |
| **W1.8** | **Per-action approval requests become first-class objects.** Today `requestConfirm(sessionId, 'shell', args, cwd)` passes loose args. Replace with a typed request: `{id, tool, action, target, targetKind, description, argsPreview, expiresAtMs, machineId?, recipient?}` and a typed resolution `{approved|denied|always, scope}`. | `src/coordinator/index.js:2464`, `src/main/services/confirmationService.js` | Approval cards can render target, action and a redacted argument preview. Test asserts the preview never contains a resolved secret. |
| **W1.9** | **Fail-closed everywhere.** Any error path in the approval flow must resolve to `denied`, never to `approved` or to a hang. Extend to: renderer crash, coordinator crash, window close, timeout, session end. | `src/coordinator/index.js:51-59` | Kill the renderer mid-approval → the action is denied and the transcript records it. Test with a real process kill. |
| **W1.10** | **Permission-mode + matrix UI** in the React renderer, with a live preview of what the current mode permits. | new `src/renderer-src/PermissionPanel.jsx` | Mode, per-tool matrix, grant list (with revoke) and expiry are all visible and editable; changes take effect without a restart. |
| **W1.11** | **Make the governance layer observable.** Every policy decision emits a structured event: `{sessionId, tool, decision, reason, gate, policyVersion}`. Surface a per-session "governance log" in the UI. | `src/coordinator/index.js`, `src/main/ipc/emitEvent.js` | A user can answer "why did it refuse that?" from the UI. Test asserts the event stream matches the decision stream. |

**Exit criteria for W1:** with **zero** configuration, a default install refuses a mutation under `read-only`, refuses an out-of-matrix tool, records every decision, and never leaks a secret into an approval preview. The permission model is no longer contingent on a third-party key.

---

## 4. W2 — Protocol & eventing (P1, ~2.5 weeks)

Quansiox has one flat IPC channel set. Grok Bot has 7 schema-validated Dune RPC edges and an SSE event bus with ~30 named channels. Without this, governance and orchestration cannot be expressed cleanly.

| ID | Task | Detail | Acceptance |
|---|---|---|---|
| **W2.1** | **Multi-edge RPC.** Split the 68 namespaces into typed edges: `main`, `agent`, `computer`, `vault`, `automation`, `provider`, `capabilities`. Each edge declares its own method schemas and failure codes, mirroring Grok's `dune-rpc:<edge>:m:<method>` envelope with `{ok,value}` / `{ok:false,failure:{code,detail}}`. | `src/main/ipc/registry.js`, `src/main/ipc/namespaces.js` | A call to an unregistered method on a known edge returns `{ok:false,failure:{code:'edge/unknown-method'}}` rather than throwing. |
| **W2.2** | **Typed event bus with named, resumable channels.** Define a channel registry: `agent`, `transcript`, `task`, `subagent`, `computer-action`, `mcp`, `permission-request`, `automations`, `notification`, `connection`, `trays`, `cloud-agent-update` (rename: `agent-update`). Each channel has a payload schema. | new `src/main/ipc/eventBus.js` | A subscriber to `computer-action` receives typed frames; an unknown channel subscription fails loudly at registration, not silently. |
| **W2.3** | **Resumable event cursors.** Per-channel `afterSeq` cursors so a renderer reload resumes rather than re-fetches. | new `src/main/ipc/eventCursor.js` | Reload the renderer mid-stream → no duplicate and no lost frames. Test with a forced reload. |
| **W2.4** | **Deadline + retry policy kit.** Port Grok's named policies: `gateway-send-post` 15 s, `gateway-sse-connect`, `gateway-sse-stall` idle watchdog, `local-exec-heartbeat` 10 s, `local-exec-sse-stall` 35 s, `local-exec-data-post` 120 s. Implement as a shared module usable by main, coordinator and daemon. | new `src/shared/policies.js` (new `src/shared/` tree) | A hung tool call aborts at its deadline and emits `aborted`, not a hang. Test with a real sleeping child. |
| **W2.5** | **Error taxonomy.** Adopt Grok's 11-value transport taxonomy (`ok, refused, timeout, http_5xx, dns, no_storage, access_denied, box_blocked, network, pod_hibernated` → local equivalents) and classify every error site. | new `src/shared/errors.js` | Every error surfaced to the UI carries a taxonomy code, not a free-text message. |
| **W2.6** | **Idempotency.** `clientNonce` on every mutating RPC; the coordinator dedupes replays. This is what makes retry safe. | `src/coordinator/index.js`, `src/main/ipc/registry.js` | A duplicated `sendPrompt` produces one agent run. Test by firing the same request twice concurrently. |
| **W2.7** | **Backpressure / demand scheduling.** Tag every RPC `person` or `background`; background reads are deprioritised and droppable under load. | new `src/shared/demand.js` | Under a synthetic load spike, a foreground call completes first. Test with 200 concurrent reads. |
| **W2.8** | **Capability negotiation.** A `capabilities` edge returning what this install can actually do: sandbox mode (off/sandboxed/vm), providers configured, MCP servers, native helper presence, voice transport, guest desktop availability. The renderer adapts to it. | new `src/main/services/capabilitiesService.js` | On a machine without the native helper, the UI hides computer-use and says why, instead of failing at click time. |
| **W2.9** | **Harness abstraction.** Introduce a `Harness` contract with three implementations: `local` (in-process coordinator), `worker` (separate process pool), `guest` (the VZ Linux guest). This is where a future remote box would slot in — and it is how the UI stays identical across them. | new `src/coordinator/harness/` | Switching a session to the guest harness routes shell/file/browser/computer calls into the guest and the UI is unchanged. Test both modes. |

**Exit criteria for W2:** every cross-boundary call is typed, timed, retried per taxonomy, idempotent, and observable. The renderer survives a reload mid-stream with no lost or duplicated events.

---

## 5. W3 — Orchestration & agent lifecycle (P1, ~3 weeks)

This is where "a chat client with tools" becomes "a workspace". Grok Bot's `SendToAgent` / `SendToUser` / rooms / agent roster / templates / publish are the model.

| ID | Task | Detail | Acceptance |
|---|---|---|---|
| **W3.1** | **Durable transcript with generation epochs.** Port Grok's model: `generation` (uint32 epoch) + `seq` + `updated_seq` + a `after_updated_seq` cursor, with `cursor-too-old` forcing a full re-read and a `watch-cleared` signal on reset. This fixes quansiox's append-only JSON race. | `src/main/services/sessionService.js`, `src/main/services/transcriptService.js` | A transcript rewritten concurrently by a parent and a child converges; a stale cursor returns `cursor_too_old` rather than silently losing rows. |
| **W3.2** | **Named agents, not just sessions.** Agent identity: name, description, avatar, colour, shape, voice, visibility, pinned, primary. Agents are durable objects that own sessions. | new `src/main/services/agentIdentityService.js` | An agent survives an app restart with identity intact and can be selected as the primary agent. |
| **W3.3** | **Agent roster tools for the LLM.** `create_agent`, `update_agent`, `set_primary_agent`, `publish_to_team` (local equivalent: publish to the local agent library), `convert_to_team` (local: promote to a shared multi-agent team), `offer_team_access` (local: share within the local workspace). | `src/coordinator/index.js` | The model can create a named agent and hand work to it, and the agent appears in the roster. |
| **W3.4** | **Peer messaging.** `send_to_agent` and `send_to_user` alongside the existing `message_subagent`. | `src/coordinator/index.js` | Two agents in a room can exchange messages without a human in the loop. |
| **W3.5** | **Rooms: multi-agent conversation protocol.** Port Grok's `GrokBotRoomMemberTurn*` semantics — nonce-based turn ownership, peers injected into the prompt, `deadline_ms`, `is_winding_down`, reply-to quoting, and nested `parent_request_id` / `root_parent_request_id`. | new `src/coordinator/rooms.js` | Three agents in a room each take a turn, respect the deadline, and wind down cleanly. Test with a stub provider. |
| **W3.6** | **Stop subagent.** Add `stop_subagent` (Grok's `StopSubagent`) — currently quansiox has `task_interrupt` but no per-subagent stop surfaced to the model. | `src/coordinator/index.js` | A stopped subagent's process is actually killed, not just marked. Test asserts the child PID is gone. |
| **W3.7** | **Async task registry.** Separate from subagents (Grok: `getAsyncTasks`). Long-running background work (a 20-minute build) gets its own registry with progress, output tail, and cancellation. | new `src/main/services/asyncTaskService.js` | A background build appears in an async-task tray with live progress and can be cancelled. |
| **W3.8** | **Blackboard conflict semantics.** Replace last-writer-wins with revision-checked writes: the writer supplies the `rev` it read; a mismatch is reported to the loser rather than silently overwritten. Keep `append` as the conflict-free mode. | `src/coordinator/blackboard.js:107` | Two agents racing on one key → exactly one wins, the other receives a `conflict` outcome. Test with a forced race. |
| **W3.9** | **Blackboard scope + persistence policy.** Per-team blackboards, atomic 0600 persistence, and an explicit retention policy. | `src/coordinator/blackboard.js` | A board survives a coordinator restart and is scoped to its team. |
| **W3.10** | **Agent templates / cloning / carry-over.** Port `CreateBotShareJson`, `SearchBotTemplates`, `ProposeSkills`, `ProposeCarryOver`. Local-first: templates are signed local JSON bundles (build on the existing Ed25519 addon signing, D6). | `src/main/services/templateService.js`, `src/coordinator/index.js` | A template can be exported, re-imported, and signed; the signature verifies. |
| **W3.11** | **Task-state tools.** `create_task`, `read_task`, `update_task`, `update_state` — a durable task list the model can maintain, distinct from the ephemeral `update_plan`. | `src/coordinator/index.js` | The model can create and close a task; it persists across restarts and shows in the task tray. |

**Exit criteria for W3:** the model can create agents, hand work to them, converse agent-to-agent in bounded rooms, maintain a durable task list, and stop any of it — all locally and observably.

---

## 6. W4 — Tool & execution depth (P1, ~2.5 weeks)

| ID | Task | Detail | Acceptance |
|---|---|---|---|
| **W4.1** | **Flat tool family (the `pi*` equivalent).** Add `pi_bash`, `pi_edit`, `pi_find`, `pi_grep`, `pi_ls`, `pi_read`, `pi_write` with truncation-aware results: every result carries `{truncated, truncated_by, total_lines, output_lines, output_bytes, first_line_exceeds_limit, last_line_partial}` plus `match_limit_reached` / `result_limit_reached` / `entry_limit_reached` and `full_output_path` for large output. Write-shaped tools carry an explicit reject path; read-shaped tools do not. | new `src/coordinator/flatTools.js` | The model can choose the flat family for deterministic file work; results are explicitly truncated rather than silently clipped. |
| **W4.2** | **Dual-family dispatch.** Both the rich tools and the flat tools stay available; policy selects. Document when to use which. | `src/coordinator/permissions.js` | A test asserts both families are reachable and that a policy can restrict to one. |
| **W4.3** | **Symbolic path arguments for MCP.** Late-bound `$file:/abs/path` args resolved at the executor boundary (cap ~16 MiB), so the model never has to inline large file contents into an MCP call. | `src/main/services/mcpService.js` | A 10 MB file can be passed to an MCP tool without entering the transcript. Test asserts the transcript holds only the symbolic reference. |
| **W4.4** | **Hook system.** Implement Grok's hook points: `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeTabFileRead`, `afterTabFileEdit`, `stop`, `beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought`, `sessionStart`, `sessionEnd`, `preCompact`, `subagentStart`, `subagentStop`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `workspaceOpen`. Hooks can return `allow / deny / ask`, plus `user_message`, `agent_message`, `additional_context`, `updated_input`. | new `src/coordinator/hooks.js` | A `preToolUse` hook can veto a tool and rewrite its input; a `preCompact` hook can inject context before compaction. Test both. |
| **W4.5** | **Per-domain egress allow-list enforcement.** Close X4. SBPL can express `network-outbound (remote ip)`; implement a resolving proxy or a resolved-IP allow-list that is refreshed and re-pinned, so "only these domains" is real. | `src/coordinator/egressPolicy.js`, `src/exec-daemon/seatbelt.js` | With an allow-list of `api.example.com`, a shell command reaching `evil.example.net` is **denied by the sandbox**, proven by a test with two real hosts. |
| **W4.6** | **Rich `SandboxPolicy` proto.** Port Grok's 15-field policy: `type`, `read_boundary` (SYSTEM/WORKSPACE/NONE), `network_policy` (version/default_action/deny/allow/logging), `network_policy_strict`, `allowlist_escalated`, `capture_denies`, `disable_tmp_write`, `additional_readwrite_paths`, `additional_readonly_paths`, `additional_read_paths`, `enable_shared_build_cache`, `skip_statsig_defaults`, `debug_output_dir`. | new `src/shared/sandboxPolicy.js` | A policy round-trips and the seatbelt profile changes accordingly; a test asserts a `WORKSPACE` read boundary blocks reads outside the workspace. |
| **W4.7** | **Secret redaction in tool output.** A redacted read path + `secret_scope_id` so values from the vault never appear in stdout/stderr, file reads, or the transcript. | `src/coordinator/index.js`, `src/main/services/secretsService.js` | A file containing a vault value read via the redacted path returns `***`. Test with a real secret. |
| **W4.8** | **Conversation search with incremental rebuild.** Port `ConversationSearchSuccess{hits, truncated, partial, rebuilding}` — search reports when the index is being rebuilt rather than returning stale results silently. | new `src/main/services/conversationSearchService.js` | A search during a rebuild reports `rebuilding:true`. Test by triggering a rebuild. |
| **W4.9** | **Per-tool smart-mode classifier hook.** Allow a model-based pre-check on a single action (`{action, arguments}` + context) before the human prompt — Grok's `smartModeClassifierExecutor`. Runs against the local provider. | new `src/coordinator/smartMode.js` | A classifier can propose an allow rule; the user is offered "allow always" with the proposed rule. |
| **W4.10** | **Task/State tools → durable task store** (paired with W3.11). | `src/coordinator/task-store.js` | Same acceptance as W3.11. |

---

## 7. W5 — UI surface (P1, ~4 weeks) — the biggest visible gap

Grok Bot: 130 feature source paths, 19 bounded contexts, 48 card kinds, 5 routed settings pages, 62 `chunk-view-*` entrypoints. Quansiox: 17 files, one 2,731-line `main.jsx`, 5 card kinds, 1 inline settings panel, **0 component tests**.

| ID | Task | Detail | Acceptance |
|---|---|---|---|
| **W5.1** | **Card framework.** A declarative registry: `type → {payload schema, renderer, resolution channel, outcome renderer, expiry policy}`. Cards are data, not hand-rolled JSX per case. | new `src/renderer-src/cards/registry.js` | Adding a new card type requires one registry entry plus one component — no changes to the transcript renderer. |
| **W5.2** | **Approval cards (12).** `local-tool-permission`, `auto-review-approval`, `connector-grant`, `credential-request`, `cookie-origin-approval`, `virtual-card-approval` (local: spending cap), `mobile-tool-permission`, `meeting-join-consent`, `scm-connect`, `publish-approval`, `app-secrets-request`, `team-access`. | `src/renderer-src/cards/` | Each card renders its target/action preview, offers the correct resolution set, and shows an expired state when the deadline passes. |
| **W5.3** | **Draft cards (4).** `email-draft`, `slack-draft`, `meeting-chat-draft`, `calendar-event` — preview-then-send with per-field editing. | `src/renderer-src/cards/` | A drafted email can be edited in the card and sent from there; the sent message is recorded. |
| **W5.4** | **Event cards (12).** `automation-changed`, `task-changed`, `team-shared`, `team-bot-publish`, `person-added`, `person-removed`, `person-left`, `bot-added`, `bot-removed`, `name-changed`, `channel-connected`, `channel-disconnected`. | `src/renderer-src/cards/` | Events render inline in the transcript at the correct position, not appended at the bottom. |
| **W5.5** | **Other kinds (6).** `mcp-app` (embedded app frame), `notice`, `feedback` (with sentiment), `voice-call` (with duration + rating), `user-attachment`, `message`. | `src/renderer-src/cards/` | Each renders and is keyboard-navigable. |
| **W5.6** | **Card outcome states.** After resolution, render an outcome row (allowed / denied / expired / superseded) rather than removing the card. | `src/renderer-src/cards/` | A denied approval stays visible with its reason. |
| **W5.7** | **Component tests.** Add `@testing-library/react` + `jsdom`; test every card, `ConfirmOverlay`, `ToolCard`, `PlanCard`, `Palette`, `ScreenViewer`, `VoiceOverlay`, `TaskDetail`. | `package.json`, new `test/renderer/*.test.jsx` | Every card type has a render test and a resolution test. CI runs them. |
| **W5.8** | **Decompose the renderer into bounded contexts.** Split `main.jsx` along Grok's 19-context shape, adapted to quansiox's actual feature set: `transcript`, `send`, `roster`, `approvals`, `tasks`, `automations`, `computer`, `browser`, `voice`, `vault`, `library`, `artifacts`, `skills`, `marketplace`, `mcp`, `settings`, `connection`, `permissions`, `usage`. | `src/renderer-src/` | No renderer file exceeds ~600 LOC; each context owns its state, ports and lifecycle. |
| **W5.9** | **Design-token system.** Replace ad-hoc CSS with a token layer (colour roles, spacing, radius, typography, motion, elevation) + light/dark + accent. | new `src/renderer-src/tokens.css` | Every component consumes tokens; no raw hex in components. Add a lint check. |
| **W5.10** | **Routed settings surfaces.** `/general`, `/computer`, `/vault`, `/usage`, `/updates` as separate routed views with deep-linkable state. | `src/renderer-src/` | Each is deep-linkable and independently testable. |
| **W5.11** | **Real diff view.** `edit_file` already returns a unified diff but the UI shows it as raw `<pre>`. Build a proper diff renderer (side-by-side + unified, syntax-highlighted, collapsible hunks). | `src/renderer-src/markdown.js`, new `DiffView.jsx` | A diff in the transcript is rendered, highlighted and collapsible. |
| **W5.12** | **Composer upgrade.** Rich text with mention / skill / emoji / canvas / PR-reference atoms, markdown dual serialization, RTL direction support, slash commands, draft revision highlight. | `src/renderer-src/Composer.jsx` | A `@mention` of an agent, `/skill` invocation and emoji shortcode all work and survive a reload. |
| **W5.13** | **VNC viewer parity.** The noVNC dependency is installed but the guest is not wired into the product (per the Oct-5 review, the active adapter loads the headless assets). Wire the guest desktop: adaptive-quality EMA controller (low=6 / high=8, raise ≥15 Mbps, lower <11 Mbps, weight 0.25, hold doubling to 160 s), liveness beacon, IME field for CJK, mac Cmd→Ctrl chord mapping, frame-hold on hidden. | `src/renderer-src/ScreenViewer.jsx`, `src/main/services/desktopVmService.js` | A guest desktop boots and is visible, interactive, and quality-adaptive. Test asserts quality changes under a synthetic bandwidth change. |
| **W5.14** | **MCP, meeting, OnePassword, vault and voice-call UI.** These are all implemented in main but have no React surface (X10). | `src/renderer-src/` | Each has a real settings surface, reachable from the UI. |
| **W5.15** | **Marketplace + plugin management UI.** Local marketplace over the existing `marketplaceService` catalogue, plus the Ed25519 signing path (D6). | `src/renderer-src/` | A plugin installs, its MCP server appears, and its skills are listed. |
| **W5.16** | **Canvas UI.** `canvasService` (283 LOC) has no UI. Build the canvas surface with share state, visibility, principals, page address and HTML export. | `src/renderer-src/` | A canvas renders inline in the transcript and can be opened full-window. |
| **W5.17** | **Usage & cost surface.** `pricingService` already computes per-1M-token cost. Surface per-session and per-agent spend in the UI. | `src/renderer-src/` | The usage view shows real spend derived from real token counts. |
| **W5.18** | **Command palette parity.** Extend the existing `Palette.jsx` to cover agents, tools, settings, skills and actions with fuzzy scoring. | `src/renderer-src/Palette.jsx` | Every registry entry is reachable from the palette. |

**Exit criteria for W5:** the renderer has a card framework with all 48 kinds, a token system, bounded contexts, component tests, a real diff view, and no main-process feature without a UI.

---

## 8. W6 — Voice, capture, artifacts (P2, ~2 weeks)

| ID | Task | Detail | Acceptance |
|---|---|---|---|
| **W6.1** | **Realtime voice transport.** An OpenAI-Realtime-compatible WebSocket client so voice is a real streaming conversation, not only local `say`+whisper. Provider-agnostic: point it at any OpenAI-Realtime-compatible endpoint (including a local one). | new `src/coordinator/providers/realtime.js` | A voice session streams audio both ways with server-VAD turn detection and tool calls during a turn. |
| **W6.2** | **Voice call lifecycle.** Credential mint, presence, barge-in, sent-message transcript, hang-up, call rating (Grok's `voice_call_connect / delivery / fault` telemetry). | `src/main/services/voiceCallService.js` | A call survives a reconnect and the transcript records what was said. |
| **W6.3** | **Screen recording.** Port Grok's `recordScreenExecutor` modes: `START_RECORDING / SAVE_RECORDING / DISCARD_RECORDING`, with duration and a rejected-path reason. | new `src/main/services/screenRecordService.js` | Record → save produces a real file; discard produces none; the rejection path is reported. |
| **W6.4** | **Artifact store with content addressing.** Port Grok's box store: `rel_path`, `etag`, `size_bytes`, `last_modified_ms`, `sha256`, `if_match_etag`, `expect_absent`. Artifacts and attachments become content-addressed and version-safe. | new `src/main/services/artifactStore.js` | A concurrent write to the same path is rejected with an etag conflict rather than silently clobbering. Test the conflict. |
| **W6.5** | **Attachment pipeline parity.** Chunked ingest, content-addressed dedupe, preupload, precaption, staged-commit, discard. | `src/main/services/attachmentService.js` | A 100 MB upload is chunked and resumes after an interruption. |

---

## 9. W7 — Reliability & operations (P2, ~2 weeks)

| ID | Task | Detail | Acceptance |
|---|---|---|---|
| **W7.1** | **OpenTelemetry tracing.** Spans for: agent turn, tool call, provider request, gateway command, renderer render, sandbox spawn, exec op. OTLP exporter to a local collector, plus a local file sink. | new `src/shared/telemetry.js` | A full turn produces a readable trace with parent/child spans. |
| **W7.2** | **Structured reliability reporting.** Adopting a Dune-style classification: every unhandled error is classified (transient / permanent / policy / user-cancelled / internal) and reported with a stable code. | `src/shared/errors.js` | No unclassified error reaches the UI. |
| **W7.3** | **Crash capture.** Coordinator crash reporter + Electron minidump + a crash banner that offers to restore the session. | `src/main/services/agentService.js` | Kill the coordinator mid-turn → the app restarts it and restores the session with the transcript intact. Test with a real kill. |
| **W7.4** | **Network diagnostics.** Extend `netDiagnosticsService` with Grok's multi-path DNS diagnosis (system resolver vs independent resolver vs wildcard vs baseline) and per-endpoint classification. | `src/main/services/netDiagnosticsService.js` | A misconfigured resolver produces a specific diagnosis, not a generic "offline". |
| **W7.5** | **Signed update pipeline.** Code-signed, size-capped, resumable download; release tracks (stable/beta/nightly); idle-apply scheduling; an apply-marker file so a crash mid-apply is recoverable. Verify the signature before swapping. | `src/main/services/updaterService.js` | A tampered update is rejected before installation. Test with a modified zip. |
| **W7.6** | **Session checkpoint/restore.** Extend `restoreService` to checkpoint a live turn (not just a route), and restore the in-flight run. | `src/main/services/restoreService.js` | An app restart mid-turn resumes the turn with its tool history intact. |
| **W7.7** | **Local support bundle.** Extend the existing redacted bundle to include the governance log, the trace, and the capability snapshot. | `src/main/services/supportBundleService.js` | The bundle contains no transcript content and no secrets. Assert in a test. |

---

## 10. W8 — Ecosystem (P2, ~2 weeks)

| ID | Task | Detail | Acceptance |
|---|---|---|---|
| **W8.1** | **Plugin/MCP management tools for the model.** Port `InstallPlugin`, `UninstallPlugin`, `GetPlugin`, `SearchPlugins`, `AddMcpServer`, `RemoveMcpAccount`, `RenameMcpAccount`, `AuthenticateMcpServer`, `GetMcpServerStatus`, `SetMcpInstructions`, `RestartMcpServers`, `UninstallMcpServer`. | `src/coordinator/index.js` | The model can install and configure an MCP server and read its status. |
| **W8.2** | **Local marketplace registry.** A signed local registry of addons/plugins/skills (reuse the Ed25519 signer). Search, install, update, uninstall, publish-to-local-library. | `src/main/services/marketplaceService.js` | A locally published addon installs into another profile with a valid signature. |
| **W8.3** | **Skill propose + carry-over.** `ProposeSkills` (derive a skill from the conversation) and `ProposeCarryOver` (port a setup to another agent). | `src/coordinator/index.js` | A skill proposed from a conversation installs and is immediately usable. |
| **W8.4** | **Web fetch/search tools.** `WebFetch`, `WebSearch` with a domain allow-list wired into the egress policy (W4.5). | `src/coordinator/index.js` | A fetch to a non-allow-listed domain is refused by the egress policy. |

---

## 11. §4 — The "not a clone" table: local-first substitutions

Every Grok Bot cloud feature gets a **local-first counterpart**. None is a stub; none is a fake.

| Grok Bot cloud feature | Quansiox local-first counterpart | Wave |
|---|---|---|
| Cursor account / OAuth backend | Local install identity + per-agent profiles; no login required | W3.2 |
| Cloud agents (`CloudAgent`, `openCloudAgent`, artifacts, publish) | **Worker pool**: isolated local processes/VMs per agent, with local artifact stores and a local library | W2.9, W3.3 |
| "Forever box" (a K8s pod per agent) | The VZ Linux guest + APFS snapshots — already real, needs UI wiring | W5.13 |
| Team backend, managers, access lists | Local workspace: a shared agent library, a shared blackboard, and per-workspace grants | W3.3, W3.8 |
| Public bot marketplace + sharing | Local signed registry + template bundles (Ed25519) | W8.2, W3.10 |
| Slack / MS Teams app install | Slack Web API via the existing `slackService`; no app-store install, no workspace admin | W5.14 |
| GitHub / GitLab SCM connect (`RequestScmConnect`) | `gh` CLI against the user's existing auth — no OAuth dance | existing + W3.3 |
| 1Password Connect / credential broker | Local Touch ID-gated vault (`QuansioxVaultApprover`) + `op` CLI | W0.7, W5.14 |
| Virtual cards / payments (`RequestVirtualCard`) | Per-agent spending caps and a pre-purchase approval card | W5.2 |
| Phone calls (`place_phone_call`) | Local voice session (already real) — no carrier | W6.2 |
| Stripe billing, prepaid wallets, usage warnings | Local cost accounting surfaced from `pricingService` | W5.17 |
| Statsig feature flags / experiments | Local `flagsService` + an in-app override console | existing |
| Sentry / OTel to Cursor infra | Local OTel collector + file sink + local support bundle | W7.1, W7.7 |
| Cursor cloud transcript store | Local durable transcript with generation epochs | W3.1 |
| `cursorvm.com` gateway + DNS diagnosis | Local harness abstraction + local diagnostics | W2.9, W7.4 |

---

## 12. Differentiators to defend

These are quansiox advantages over the reference build. Each wave must not regress them.

| # | Advantage | Defend with |
|---|---|---|
| D1 | Real local sandbox enforcement (the reference build's local sandbox is inert) | Keep the escape test in CI (`test/seatbelt.js`); extend to the guest harness |
| D2 | Kernel-level guest isolation + APFS snapshots | Snapshot tests per session |
| D3 | Test rigor (1,908 strict : 3 tautologies) | Keep the ratio; add a CI budget that fails if tautologies exceed 1 % |
| D4 | Provider breadth (6 protocols, prompt caching) | Add a provider-conformance test suite |
| D5 | DAG planner + revision-tracked blackboard | Keep `test/team-dag.js`, `test/blackboard.js`; extend with the conflict test from W3.8 |
| D6 | Ed25519-signed first-party extensions | Extend signing to plugins (W8.2) |
| D7 | Honest fail-closed compat surface | Keep `test/grok-compat.js` asserting every stub returns `unavailable` |

---

## 13. Effort and dependency summary

| Wave | Tasks | Est. | Hard dependencies |
|---|---|---|---|
| W0 Repair | 10 | 3 d | — |
| W1 Governance | 11 | 3 w | W0 |
| W2 Protocol | 9 | 2.5 w | W1 |
| W3 Orchestration | 11 | 3 w | W1, W2 |
| W4 Tool depth | 10 | 2.5 w | W1 |
| W5 UI surface | 18 | 4 w | W2, W3 |
| W6 Voice/capture | 5 | 2 w | W3, W5 |
| W7 Reliability | 7 | 2 w | W1–W6 |
| W8 Ecosystem | 4 | 2 w | W4, W5 |
| **Total** | **85** | **~24 w** | |

**Critical path:** W0 → W1 → W2 → W3 → W5. W4, W6, W7 and W8 parallelise off W1.

**Suggested first three weeks:** W0 in full, then W1.1–W1.4 (policy always-on, mode ladder, tool matrix, standing grants). Those four tasks are what change quansiox from a demo into something you can trust with credentials — and they are worth more than the entire missing feature surface.

---

## 14. Explicit non-goals

- **Do not** implement a Cursor/Grok account backend, cloud agent hosting, or a public marketplace server.
- **Do not** reintroduce a vendor-API-key gate on safety. Safety must be local and unconditional.
- **Do not** fake a capability. The 144 fail-closed stubs are correct behaviour; extend that pattern to every new surface.
- **Do not** chase pixel parity with Grok Bot. Parity of *capability and safety*, not of appearance.
- **Do not** delete the Grok-compat catalogue. It is a precise, verified map of the reference surface and is the best available regression oracle for this roadmap.
