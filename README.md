# Quansiox

A local-first desktop AI agent for macOS, built as an Electron app.

Quansiox was designed by deeply analyzing two production desktop agents and
combining their strongest architectural patterns:

- **Manus Studio 2.0.3** (`im.manus.desktop`) — namespaced single-channel IPC
  registry with meta-discovery, service-oriented main process, scoped events.
- **Grok Bot 0.66.0** (`com.anysphere.sand`, Cursor's "sand" agent) — a local
  agent coordinator executing tools on your machine, streaming progress into
  the   chat UI.

### v2.68 — Finish releases, native freshness, visual gates

Three gaps were left open after v2.67:

- **The native computer helper's v4 contract is complete.** The helper now
  advertises `computer/finish` alongside `computer/list_windows` and
  `computer/screenshot`, and the tests assert `version: 4`, the background /
  window-capture capabilities, and the release round-trip. When the last
  agent run settles, the main process calls `finish()` and clears the
  snapshot token, so an element handle from one run cannot be replayed in
  the next. Cleanup is awaited before the run settles so a queued turn cannot
  have its first snapshot invalidated by the previous turn's release.
- **Native helpers are now part of the release gate.** `scripts/package.js`
  exports `verifyNativeFreshness()`, which rejects a build older than its
  Swift source and compares the installed helpers byte-for-byte with the
  fresh build. `npm run package`, `npm run verify-package` and the packaged
  wiring check all call it. Previously only `src/` was compared, which is how
  the packaged app kept a stale v3 helper while `build/` had v4.
- **The settings rail scrolls and the screenshots assert layout.**
  `.settings-rail` now has its own overflow (with the active tab scrolled
  into view), so the last pages are reachable in an 84vh dialog.
  `test/screenshot-surfaces.js` no longer only captures PNGs: it asserts the
  active pane/surface is visible, the clicked tab is inside the rail, the
  dialog fits the viewport, and the renderer console is clean.
  `npm run verify-visuals` runs it against the packaged app.

### v2.67 — The bundle gates: nothing ships unwired

A bundle can be byte-identical to the source and still be **unreachable** —
a namespace that never registers, a surface that never mounts, a native
helper that is installed but not found. All three happened during the
v2.66 work (the OCR helper resolved only `build/`, so it was silently
unavailable in the packaged app), so there are now gates for it:

- `npm run verify-wiring` — loads the **packaged** bundle and checks every
  layer: the services load, the IPC namespaces register, the preload facade
  exposes the methods, the agent tools are defined *and* handled, the
  renderer surfaces and settings panes are present, the native helper is
  installed and answering, and the bundle is byte-identical to the source.
- `npm run verify-runtime` — runs the **packaged** app's code in a real
  Electron and exercises every new feature for real (a project with a
  knowledge base, a deck exported to a real `.pptx`, a design session with an
  applied edit, the bundled OCR helper, a published site answering over HTTP,
  a collaborator joining a collaborative task, a workflow address and an
  `.ics` event), then mounts the packaged renderer and asserts that no
  namespace, pane or surface is missing and that the console is clean.
- `npm run package` now **runs the wiring gate before it produces the
  archive and the disk image**, so an unwired bundle cannot ship.

### v2.66 — Slides, Design View, Multimedia, Websites, Collaboration, Mail

The second half of the Manus documentation parity pass: the six remaining
documented feature families, each implemented locally and tested.

- **Slides** (Manus Slides) — `src/main/services/slidesService.js` plus a new
  dependency-free **Open XML writer** (`src/shared/pptx.js`). A deck is a
  model of slides with layouts (`title`, `section`, `bullets`, `two-column`,
  `chart`, `quote`, `closing`), bullets and **speaker notes for every
  slide**. Ten named themes (Minimalist, Onyx, Ginkgo, Basalt, Patina,
  Emerald, Amber, Alabaster, Cobalt, Sand). Exports:
  - **`.pptx`** — real Open XML, validated by `xmllint` and opened in
    PowerPoint; the text stays editable;
  - **PDF** — through the existing offscreen render service;
  - **web slides** — a self-contained interactive deck (arrow keys, a
    presenter-notes panel, a print stylesheet);
  - **speaker notes** — a standalone document.
  A user's own `.pptx` can be imported as a template (its theme colours and
  fonts are read out of `ppt/theme/theme1.xml`, via a new minimal ZIP
  **reader**, `src/shared/zipReader.js`). Charts come from a CSV through the
  data-visualization service. New tools: `slides_deck`, `slides_export`.
- **Design View** — `src/main/services/designService.js` over a new
  **image-operations engine** (`src/shared/imageOps.js`) and a new **PNG
  decoder** (`src/shared/png.js`). A design session is an image with a
  **version history**: you mark a region, attach an instruction, and the
  agent applies the marked regions as one edit. The edits are real pixel
  work — upscale (bicubic), background removal (a border flood fill),
  crop, rotate, and per-region brightness / contrast / saturation / hue /
  tint / soften — plus **text extraction** through a new local OCR helper
  (`native/QuansioxVision.swift`, the macOS Vision framework) and a text
  edit that patches the region and redraws the words. Reference images can
  be composited. New tools: `design_mark`, `design_edit`.
- **Multimedia** — `src/main/services/multimediaService.js`. **OCR** through
  the Vision helper (no model, no network), **batch OCR** into a table,
  **image analysis** (dominant colours, brightness, contrast, a real
  perceptual comparison of two images), **video** probing, frame extraction
  and audio extraction through `ffmpeg`, and **video generation** from a
  set of images (real `.mp4` and animated `.gif`). **Speech** with a real
  tone / pace / style system — the styles genuinely rewrite the text and
  the tone and pace genuinely change the rate — through the system voice.
  New tools: `read_image`, `make_video`, `speak`.
- **Website Builder** — the local subset: `src/main/services/websiteService.js`.
  Scaffold an app on disk, edit its files, read the whole codebase and
  download it as a ZIP (**code control**), **make a copy** (with the
  publishing state reset, as documented), a real **SEO audit** over the
  actual HTML with the fixes applied (meta tags, canonical, `robots.txt`,
  `sitemap.xml`), **access control** enforced by the preview server
  (public / token / password / allow-list), local **analytics**, **notification**
  rules, **schedules**, and **publishing** — a static bundle, a local
  preview server and the DNS records a real deployment would need.
  New tool: `website_build`.
- **Collaboration** — `src/main/services/collabService.js`. Collaboration is
  a mode on a task: the owner invites by email, the invite token admits the
  collaborator immediately, and a collaborator's prompt is **queued** and the
  queue runs the prompts **one after another**, so two people typing at
  once never interleave. Every prompt and answer is recorded, so a late
  joiner still sees the whole history, and the task can be exported. The
  invite link is served from a loopback HTTP server.
- **Mail Manus** — `src/main/services/mailManusService.js`. The bot address
  is an address that delivers into the user's own mailbox; **workflow
  addresses** are aliases on it with a default prompt; an **approved-sender**
  allowlist gates who may start a task. The mail flow is real: MIME parsing
  (the email service now parses bodies, addresses and attachments), a
  status email, a **"cancel" reply that stops the task**, the result sent
  back by SMTP with attachments, the **client-side filter configuration**
  for Gmail and Outlook, and a **calendar event** as an `.ics` file.

### v2.65 — Projects, Wide Research, Data Viz (Manus docs parity pass)

A parity pass against the **complete official Manus documentation** (all 44
pages of `manus.im/docs`, plus all 20 embedded demo videos) and against a
fresh reverse engineering of **Manus Studio 2.0.9** (`im.manus.desktop`,
extracted from `Manus-Setup-2.0.9.dmg`). Three documented features that
Quansiox did not have are now implemented for real.

- **Projects** (the flagship documented feature — `PRJ-01…21`).
  A project is a persistent workspace carrying a **master instruction** and a
  **knowledge base** into every task started inside it. New service
  `src/main/services/projectService.js`; new IPC namespace `projects`;
  new surface `src/renderer-src/surfaces/ProjectsPanel.jsx`.
  The propagation rules are the part that is easy to get wrong, so they are
  enforced by the data model, not by convention:
  - the **instruction is live** — an edit applies from your *next message* in
    the current task (the prompt block is rebuilt every turn);
  - the **files are frozen** — the file set is snapshotted when a task joins
    the project, so a later upload cannot rewrite what a running task sees.
    Project files are stored as **immutable content-addressed blobs**, so a
    replaced file keeps its old bytes alive for the tasks that froze it, and
    `gc()` reclaims the ones nothing references any more.
  Also: pinning, drag-and-drop ordering, the four sidebar task filters
  (All / Non-project / Favorites / Scheduled), moving an existing task into a
  project, a local collaborator roster, private-by-default, unlimited
  projects, and a `project_knowledge` agent tool that reads the frozen file
  set.
- **Wide Research** (`WRS-01…12`) — the fan-out/fan-in engine, as a new
  `wide_research` agent tool (`src/coordinator/wideResearch.js`). One
  dedicated child agent per item, each with an **isolated context window**,
  run in bounded parallel waves; a fixed field schema per item so the results
  line up in a matrix; synthesis into a table, a report, a dataset or CSV;
  real pattern detection (column profile, mode, outliers); **post-hoc
  refinement** over a subset of items; and the whole result packaged as a
  **ZIP** — written by a new dependency-free ZIP writer
  (`src/shared/zip.js`).
- **Data analysis & visualization** (`DVZ-01…20`) — a new `analyze_data` agent
  tool and `src/main/services/dataVizService.js`. Real CSV / TSV / JSON
  parsing (quoted fields, embedded commas), a per-column profile (type,
  coverage, distinct count, min/mean/median/max/σ), **customer segmentation**
  by a deterministic k-means with a readable profile per cluster, and
  **inline-SVG charts** (bar, line, area, pie, donut, scatter, heatmap,
  radar, stacked bar — capped at 5 per analysis, as documented) rendered
  into a self-contained interactive dashboard, a Markdown report, or a CSV
  dataset. No chart library, no network.

### v2.64 — Native computer helper, messages/cookies, viewer input, namespaces
- **Native Swift computer helper.** `native/QuansioxComputerHelper.swift`
  replaces the AppleScript/JXA helper on macOS: same 0600 unix-socket
  newline-delimited JSON-RPC contract (single-use bootstrap file + control
  token, per-method auth) but AX reads/writes and CGEvent input are native.
  Verbs: `computer/{app_state,find_elements,click,type_text,set_value,
  press_key,scroll,open_app,list_apps,status}`, `application/{list,icon}`.
  Safety: app blocklist (`APP_BLOCKED`, defaults include Keychain Access,
  SecurityAgent, loginwindow; extend with `QUANSIOX_COMPUTER_BLOCKLIST`),
  `ACCESSIBILITY_PERMISSION_REQUIRED` refusal instead of fake success, a
  Ctrl+Option+Escape panic chord that exits the helper, SIGTERM cleanup and
  an orphan (ppid==1) watchdog. Build with `npm run native`; the host service
  prefers the binary and falls back to the JXA helper
  (`QUANSIOX_COMPUTER_HELPER_KIND=jxa` forces the fallback);
  `scripts/package.js` bundles it. `test/native-helper.js` covers the full
  protocol and host selection.
- **Per-bot VM browser + terminal.** The desktop guest's Chromium is now driven
  over **CDP through the existing 0600 `9222.sock` vsock bridge**: the same
  `browser_open/snapshot/click/type/fill/select/press_key/scroll/js/wait/tabs`
  tools get the same a11y ref snapshot and staleness model as the host browser,
  with **no screenshots or RFB pixels involved**. `browserRouter` picks the
  guest when the bot's VM is live (or when `sandboxMode: vm` boots it on first
  use) and the embedded Electron browser otherwise;
  `QUANSIOX_BROWSER_TARGET=host|guest` overrides. Cookie import and vault
  credential fill target the selected runtime. Shell/file tools redirect into
  the live desktop guest too (even from process-sandbox mode), so a bot has one
  Linux box with its xterm + Chromium. `test/guest-browser.js` covers CDP
  navigation/snapshot/actions/tabs/cookies and the host-vs-guest router.
- **Read-only Messages + Chrome cookie import.** `imessageReader` reads
  `chat.db` read-only (probe reports `ENOENT_CHATDB` / `NEEDS_FDA` honestly),
  `macMessagesService` adds list chats/read/search/send behind the existing
  opt-in + recipient allowlist (AppleScript-escaping, 4000-char cap), and the
  agent gets `messages_status/chats/read/search` (read-only) plus gated
  `messages_send`.
  `chromeCookies` copies the profile DB aside, decrypts `v10` values with the
  Keychain-stored Chrome/Edge/Brave key, and `cookieImportService` plans
  imports that respect per-origin grants and the `chromeCookieImport` setting;
  the browser toolbar's **Cookies** popover manages per-origin grants and
  imports from Chrome, and the gated `browser_import_cookies` tool exposes the
  same path to the agent without ever returning cookie values.
- **Vault → browser credential fill.** `browser_fill_credentials` (gated,
  approval-required) matches a vault credential by site, fills username and
  password through the native-setter snippet, optionally submits, and reports
  only which fields were filled — the password never reaches the model or
  renderer.
- **Viewer input + rich markdown.** `ScreenViewer` gained clipboard
  round-trip, IME input, Cmd→Super, Ctrl+Alt+Del/Alt+Tab/Super toolbar,
  fit/fullscreen and a liveness watchdog with auto-reconnect
  (`viewer-input.js`: keysym table + chord helpers). Assistant text now
  renders through `markdown.js`: safe-by-default HTML escaping, code
  highlighting, link autodetection, tables, task lists, TeX-subset math and
  Mermaid-subset flowcharts as inline SVG.
- **First-class local namespaces + Settings UI.** `feedback`, `diagnostics`,
  `net`, `boxSecrets`, `agentFiles`, `agentPlugins`, `agentSkills` are now
  direct IPC namespaces (previously only reachable through `grok:invoke`),
  and Settings exposes feedback (saved locally), diagnostics summary/clear
  and box-secret management. `test/local-namespaces.js`.

Verified: full `npm test` green (incl. new `native-helper`, `imessage`,
`cookies`, `viewer-input`, `markdown`, `local-namespaces` tests),
`npm run build` green.

### v2.63 — Second local parity pass (templates, threads, wizard, support)
Closes the remaining *local-able* gaps identified after v2.62. The compat
surface is now **390 real-local / 162 fail-closed of 552** (60 Cursor/account,
58 backend, 33 cloud, 11 voice). The irreducible cloud/vendor rows stay
honest-N/A.

- **First-run + create-bot wizard.** A three-step flow (welcome → workspace
  picker → bot name/label/description) appears once, persists
  `onboardingSeen`, and creates the first bot profile.
- **Bot templates / share.** `templateService` snapshots a bot profile plus a
  starter prompt into a local catalog; templates can be created from, made
  private/shared, exported as a JSON document, imported, versioned, and
  deleted. Ten compat methods now route to it (`listBotTemplates`,
  `publishBotTemplate`, `deleteBotTemplate`, `getPublicBotTemplate`,
  `getBotTemplateForSourceAgent`, `createAgentFromTemplate`,
  `setBotTemplateVisibility`, `getBotTemplateExportPolicy`,
  `getBotTemplateVersion`, `updateGrokBotAgent`). Sharing is a local file
  handoff, not a cloud link.
- **Threads.** Replies are grouped into a thread pane with a per-message reply
  count; `sessions.thread` returns the root plus nested replies and their
  assistant answers, and `threadCounts` feeds the transcript badges.
- **Support bundle.** Settings → Updates → Troubleshooting builds a local,
  redacted zip (manifest, redacted settings, diagnostics, notices, flags,
  session summaries; transcripts/secrets/cookies excluded) and reveals it in
  Finder. `test/support-bundle.js` asserts credential-shaped keys/values never
  reach the archive.
- **Approval expiry copy.** When the approval deadline passes, Allow/Always are
  disabled and the card says the request expired and was denied automatically.
- **Local voice transcription.** `transcribeAudio` now maps to the existing
  local whisper.cpp chain (honest-unavailable when the binary/model is absent),
  so the method is no longer a scoped stub.
- **Group compat mappings.** `createGroup` / `setGroupMembers` /
  `addGrokBotRoomPeople` / `listGrokBotAgentSessions` route to the local group
  and session services.
- **Routine editing.** Workflows/automations get an edit dialog (name, steps or
  prompt, interval, cron) in the sidebar.

Verified: `npm test` green (now including templates, support-bundle, and local
transcribe tests), `npm run check-renderer` green, `npm run check-browser-real`
green (hidden click + typing). Packaged app rebuilt and verified.

### v2.62 — Remaining GPA tasks closed (capture, groups, addons, restore)
Closes the outstanding local items in `GPA.md`; the cloud/vendor surfaces are
still documented non-goals, not stubs.

- **G3 — human demonstration capture.** New native helper
  (`native/QuansioxCapture.swift`, compiled to `build/QuansioxCapture`) is a
  listen-only `CGEventTap` that streams real mouse/keyboard events as NDJSON
  over a Unix socket. `humanCaptureService` supervises it, coalesces printable
  keys into `type` steps, maps special keys/scrolling/clicks, and finalizes the
  same replayable `SkillRecorder` artifact the agent recorder uses. The Skills
  surface has **Teach by demonstration** / **Finish demo** / **Cancel demo**.
  Accessibility/Input-Monitoring permission is mandatory: without it the helper
  reports the reason and the start fails (no fake capture). Verified with a
  fake helper over a real socket in `test/human-capture.js`; the live tap is
  permission-gated. The compiled helper ships in the app bundle.
- **G9 — local group chats.** A group is a real session (`kind:'group'`) with
  2–6 member sessions. Sends fan out to all members or only those `@mentioned`;
  each member answers in a **transient** session seeded with the group
  transcript, its persona, and its own memory scope, so member DMs are not
  polluted. Replies are appended with author metadata and stream into the UI.
  Create/edit membership, group banner, per-author avatars, and honest failure
  reporting are included. `test/groups.js` covers membership, mentions,
  memory scoping, transcript authoring, cleanup, and error paths.
- **G13 — local addon system.** `addonService` installs bundles from a folder,
  validates/bounds manifests, verifies **Ed25519 signatures** against
  user-trusted publisher keys, enforces declared permissions, and applies
  contributed **skills** + **MCP servers** on enable / removes them on disable
  or uninstall. A bad signature rejects the install; `requireSignature` blocks
  unsigned addons. Addons panel installs, enables, removes, verifies, and
  manages trusted keys. `test/addons.js` covers signed/unsigned/tampered
  bundles, permissions, policy, contributions, and cleanup. (This is signature
  trust + permission enforcement, not DRM.)
- **G15 — post-restart restore.** `restoreService` checkpoints the active
  session and the pending update version (written before `app.relaunch()`);
  the renderer consumes it on boot, reopens the session, and shows an
  “Updated to x” notice. `test/restore.js` covers validation, consume-once,
  update checkpointing, and the updater wiring.
- **G6 — background browser input.** A hidden window now accepts real pointer/
  keyboard input: the view runs with `backgroundThrottling:false` and the
  hidden page gets CDP focus/lifecycle emulation (no visibility refusal). Also
  fixed a latent no-snapshot coordinate-action crash. Verified in real Electron
  (`check-browser-real`) with a never-shown window: the hidden page's button
  handler fired.
- **G7 — downloads + rich previews.** `will-download` events now produce
  tracked records (progress/completed/cancelled, bytes, path) with a Downloads
  dock tab (open/reveal/clear). The file viewer previews images, PDFs, audio and
  video in-app with an “open in default app” action, under a 20 MB cap.
- **Docs-parity extras closed:** agent **form cards** and masked
  **secret-request cards** (new `interactions` surface + coordinator
  `request_user_input`/`request_secret` tools; the agent blocks until the user
  answers and secrets go straight to the vault), **routine Test run + run
  history** (trigger-tagged, bounded, schedule-neutral test runs), **per-bot
  memory** (scoped facts with global fallback in recall/injection), and **edit
  bot profile** (name/label/description).
- **G5** stays closed for its local subset: long-shell cancellation and
  per-child computer leases already exist (`exec.cancel`, `computerPool`);
  independent OS worker processes per child are deliberately out of the
  in-process coordinator architecture.

Verified: full `npm test` green, `npm run check-renderer` green in real
Electron, `npm run check-browser-real` green (hidden input + sibling storage
isolation), renderer bundle rebuilt. The packaged app is rebuilt and verified
separately below.

### v2.61 — Prior links + routines in the palette (docs parity, batch 9)
Completes the docs' "Find prior work" surface — the palette now finds all
four documented things: messages, files, **links**, and **routines**.
- **Links** (`sessions.searchLinks`): http(s) URLs extracted from every
  conversation's user/assistant text, deduped globally (the newest mention
  wins, so a link shared across chats appears once with its latest context),
  prose punctuation trimmed, `data:` payloads never indexed. Rows show the
  URL with match highlighting plus the sharing conversation; picking one
  opens it through the same policy as in-chat links — http(s) goes to the
  session's in-app browser (`window-open` handler), never Safari.
- **Routines**: matching scheduled automations (name search) appear under a
  Routines group with kind/enabled status; picking one opens the sidebar's
  more-sections group, expands the Automations surface, scrolls to the row
  and flashes it.
- Verified: `npm test` green (new `test/search-links.js`: extraction +
  punctuation trim, global dedupe newest-wins, anchors, guards), `npm run
  check-renderer` OK; captured run searched `runbook` (session + message +
  file + link rows together), clicked the link row (opened via the window
  policy), searched `Nightly` and revealed the automation row
  (`flash: true, detailsOpen: true`), zero renderer errors; packaged app
  boots.

### v2.60 — Find prior work: cross-conversation search (docs parity, batch 8)
The docs' "Find prior work" flow: the `⌘K` palette now searches **messages
across every conversation**, not just session titles and actions.
- **Message search** (`sessions.searchMessages`): case-insensitive substring
  over user + assistant text in all sessions (workspace-grep-independent,
  electron-free), newest sessions first, bounded (200 sessions / 30 hits),
  min 2 chars. Hits return `{sessionId, title, messageId, role, snippet, at}`
  with a ±60-char context snippet.
- **Jump back to the place**: picking a hit switches to that session (if
  needed) and scrolls to the matching message with a flash highlight — the
  same anchor used by reply quotes. Same-session hits jump directly. Title
  hits anchor to the conversation's last turn; a hit with no live anchor
  warns instead of failing silently.
- **Workspace files** in the palette: matching files from the live file tree
  appear under a Files group; picking one mentions it into the composer
  (`@path`, with a toast).
- Modal answer matching in the palette (bold highlight), flat keyboard nav
  across Sessions → Messages → Files → Actions, results debounced (180 ms).
- Id-backfill writes during search preserve `updatedAt`, so searching never
  reorders the sidebar.
- Fixed two latent bugs surfaced here: the `@`-mention suggestion popup
  could stay open after programmatic content insertion (stale-ref clear in
  `Composer.jsx`), and palette queries now reset on close.
- Honest scope note: message + file search are live; links and routines are
  not indexed in the palette yet (documented in the parity matrix).
- Verified: `npm test` green (new `test/search-messages.js`: cross-session
  hits + ordering, multimodal flattening, title anchors, min-chars/limit
  guards, recency untouched), `npm run check-renderer` OK; captured run
  searched `prod-green` from a different session, jumped with the flash on
  the target bubble, re-ran the jump in-session, mentioned `deploy-plan.md`
  into the composer, surfaced a title hit, zero renderer errors; packaged
  app boots.

### v2.59 — Replies, reactions, redirect (docs parity, batch 7)
Chat collaboration surfaces from the docs' "Message and collaborate" page:
- **Reply to a message**: hover a message → reply button; the composer shows
  a quoted chip (cancel with Esc or ✕). The sent bubble renders the quote
  (author + preview) and persists as `replyTo` on the user turn; clicking the
  quote jumps to the parent and flashes it.
- **React to a message**: hover picker with the docs' lightweight set
  (👍 ❤️ 😂 🎉 👀 ✅); chips render under the message and toggle on/off.
  Reactions persist per turn (`sessions.react`), sync across windows
  (`sessions:onReaction`), and are allowlisted server-side.
- **Redirect work in progress**: the Queued chip on a queued message gains
  **Send now** — it promotes the message to the queue head and aborts the
  active turn (`agent.steer` → `runQueue.promote` + `abort`), so the direct
  message runs immediately. Completed actions are not undone (docs' caveat).
- **Connect apps `⌘⇧M` / `⌘⇧W`**: opens Settings on the Integrations
  (connectors: provider profiles + MCP servers) pane; also in the palette.
- Per-message ids: `appendTurn` assigns `msg_*` ids (renderer's messageId is
  reused when present), and legacy transcripts backfill on load so replies,
  reactions, and jumps work across old history. `onDone` now carries
  `assistantId` so fresh replies are reactable without a reload.
- Verified: `npm test` green (75 checks — new `test/chat-collab.js`: id
  assign/backfill, replyTo persistence, reaction toggle + allowlist, queue
  promote), `npm run check-renderer` OK; captured run reacted 👍 (persisted,
  toggled off, re-added), replied with a quoted chip and persisted parent,
  queued a second message behind a held run and redirected it (run 1 aborted,
  promoted message ran, disk order correct), `⌘⇧M` opened Integrations, zero
  renderer errors; packaged app boots.

### v2.58 — Voice: dictation, memos, voice chat (docs parity, batch 6)
- **Dictation (`⌘D`)** — mic button in the composer (toggle with `⌘D`, hint
  updated): records via MediaRecorder (90s cap; honest toasts for denied mic
  or too-short audio), transcribes through the local STT chain —
  `afconvert` → `whisper-cli` (`QUANSIOX_WHISPER_BIN` /
  `QUANSIOX_WHISPER_MODEL` overrides; python `whisper` CLI fallback) — and
  inserts the text into the composer. Honest-unavailable with a reason when
  no local provider or model exists (shown in the details drawer).
- **Voice memos** — assistant messages get a Speak button (one shared audio
  element: play replaces play, `listen` singleton in `lib.js`).
- **Voice chat** — composer toggle (persisted `quansiox-voice-mode`); when
  on, finished runs auto-play the reply memo.
- **Per-session voice + speed** — details drawer Voice section (all system
  voices, speed 0.5–2×, Preview); `synthesize` honors the session's voice
  (`say -r` rate from speed).
- `⌘L` focuses the prompt (docs shortcut table). CSP fix: `media-src 'self'
  blob:` so rendered memo audio can play.
- Verified: `npm test` green (74 checks — new `test/voice-stt.js` drives the
  whisper chain with a fake CLI: arg shape, transcript pickup, cleanup,
  honest-unavailable), `npm run check-renderer` OK; captured run recorded
  dictation through a shimmed getUserMedia, transcribed via fake whisper,
  inserted into the composer (mic button + `⌘D`), played/stopped a memo,
  persisted voice chat, saved voice Albert 1.25× through the drawer, zero
  renderer errors; packaged app boots.

### v2.57 — Computer take-over + recovery + notice stack (docs parity, batch 5)
Control handoff and troubleshooting surfaces for the computer use feature:
- **Take over / I'm done** (`src/main/services/controlHandoff.js`, global —
  the host Mac is one machine): while taken over, every agent computer action
  (screenshots included) is refused with the model-facing `USER_TAKEOVER`
  token; the trust overlay hides immediately. The affordance appears in the
  mid-run banner and the dock's "This Mac" card (state flips to "You have
  control (agent paused)") and syncs across windows via
  `computerUse:onTakeover`.
- **Recover computer**: restart the out-of-process Mac helper
  (`computerHostService.restart()` — new non-terminal counterpart to
  `shutdown()`), stop any live guest desktop, and stop the session sandbox;
  reports per-part what it did.
- **Reset computer**: confirmation dialog (copy explains the blast radius),
  then stops the guest desktop/sandbox and removes only
  `sandboxRoot(sessionId)` (`.quansiox/sandboxes/<id>`); the next run boots
  fresh.
- **Notice stack** (`src/main/services/noticeService.js`, `system:onNotice`):
  request-ID surface above the composer. Failed runs (`agent:onDone` ok:false)
  and fail-closed approval timeouts raise notices; each carries a copyable
  `req_*` ID, per-notice dismiss, and Clear all. Bounded ring of 20,
  node-safe so coordinator-adjacent services can raise too.
- Verified: `npm test` green (73 checks — new `test/control-handoff.js`,
  `test/notices.js`, confirmation timeout notice), `npm run check-renderer`
  OK; captured run set take-over on (card flipped, event synced), raised both
  notice kinds with valid `req_*` IDs, dismissed + cleared (main-side ring
  empty), recovered (`helper: restarted, sandbox stopped`), reset through the
  dialog with the seeded sandbox tree removed on disk, zero renderer errors;
  packaged app boots.

### v2.56 — Settings panes + auto-review rules (docs parity, batch 4)
- New **General** pane: appearance picker (Match system / Light / Dark —
  follows the system appearance live, persisted), language (applies to date
  and number formats; the interface ships in English), timezone (full IANA
  list, applied to conversation-details timestamps) and an aggregate
  **Usage** block (conversations, messages, tokens, requests, estimated USD
  cost across all local sessions via new `settings.usageSummary`).
- New **Updates** pane: current app version, feed URL, check /
  download-and-restart consolidated out of Desktop.
- **Auto-review rules** (Security pane): allow/block rule lists
  (plain text or `/regex/`, block wins) now genuinely settle the coordinator
  approval gate without a prompt — allow skips, block refuses.
  `src/coordinator/autoReview.js` is the pure engine (`test/auto-review.js`,
  wired into `npm test`), the gate integration is covered by smoke
  (allow carries a shell call with no IPC prompt; block refuses).
- Conversation details: `⌘⇧I` (plus `⌘⌥B` / `⌘⇧,`) open the drawer.
- Verified: `npm test` green (71 checks), `npm run check-renderer` OK,
  captured run saved theme/language/timezone/auto-review through the real
  dialog and persisted them (`America/New_York`, rules incl. regex), usage
  summary showed real seeded numbers, app version filled the Updates pane;
  packaged app boots.

### v2.55 — Conversation details (docs parity, batch 3b)
The documented details pane (`⌘⇧I`, also in the palette and the topbar
info button) opens over the chat:
- Session block (title, id, created/updated, model), activity block
  (messages from you/bot, tool calls, files touched via `sessions.stats`),
  usage block (tokens, requests, estimated cost via `pricingService`),
  and Export/Duplicate actions.
- **Per-conversation notifications** toggle (`session.muted`): mutes OS
  notifications for that conversation while unread dots keep working.
- Verified: `npm test` green (70 checks), `npm run check-renderer` OK,
  captured run opened the drawer with real `⌘⇧I` input, toggled the mute
  flag on disk (true → false), closed with Escape, zero renderer errors;
  packaged app boots.

### v2.54 — Session management (docs parity, batch 3a)
Sidebar management for conversations, matching the docs' Bots sidebar:
- **Pin** — pinned sessions sort to the top (pin glyph on the card); ⌘1–9
  and Alt+↑/↓ / Ctrl+Tab cycling follow the pinned-first order.
- **Rename…** — proper dialog (Escape/overlay closes, Enter saves) instead of
  only the backend `sessions.rename` route.
- **Duplicate** — copies the transcript + usage under a new id, titled
  “<name> (copy)”; source untouched.
- **Hide / Unhide** — hidden sessions drop out of the sidebar, the ⌘K palette
  and shortcut slots; a collapsed “Hidden (n)” section lists them dimmed
  when expanded.
- Backend: `sessions.update` (title/pinned/hidden/muted flags),
  `sessions.duplicate`, flags exposed in `sessions.list`; the context menu
  gained pin/rename/duplicate/hide entries with a separator.
- Verified: `npm test` green (70 checks) incl. new smoke assertions for
  flags + duplicate; `npm run check-renderer` OK; captured run drove the real
  renderer through pin/rename/duplicate/hide/unhide and ⌘1 ordering; packaged
  app boots.

### v2.53 — Queued messages (docs parity, batch 2b)
Messages sent while the bot is working now queue behind the current turn
instead of failing (docs: “a message sent while the bot is working is
answered after the current turn”):
- New `src/main/services/runQueue.js` — per-session FIFO queue; the head run
  starts immediately, further runs start when the previous run settles
  (success or failure). Sessions run independently in parallel. Unit-tested
  in `test/run-queue.js` (ordering, resolve/reject handoff, positions,
  cleanup) and wired into every `npm test` run.
- `agentService` emits real `agent:onQueued {messageId, position}` and
  `agent:onRunStart {messageId, dequeued}` events; `isRunning` counts queued
  turns for the grace-close gate.
- Renderer: user bubbles show a **Queued** chip that clears when their turn
  starts; the composer keeps a working **send** button alongside **stop**
  while a run is in flight; the status line reads “queued…”.
- `test/smoke.js` phase 9 updated from the old “concurrent run rejected”
  assertion to the queue contract (real coordinator + mock provider: second
  message queues, then runs; onQueued/onRunStart payloads asserted).
- Verified: `npm test` green (70 checks), `npm run check-renderer` OK,
  captured run with a held mock stream showed the Queued chip → drain → no
  errors, packaged app boots.

### v2.52 — Approvals seam (docs parity, batch 2a)
Grok Bot's approval model, wired end to end:
- **Always allow** on the approval prompt saves a session-scoped standing
  grant (`consent.set`), and the coordinator now honors grants when gating:
  a standing `deny` blocks the tool unconditionally, a standing `allow` skips
  the prompt (global and session scope both work).
- The prompt now shows a live **auto-deny countdown** (“Auto-denies in m:ss”)
  from the request's real timeout, plus the command/path detail.
- New **Settings → Security** pane: “Ask before gated tools” toggle
  (`requireApproval` was previously a hidden setting) and a **Standing
  permissions** list with per-grant revoke, backed by `consent.list/revoke`.
- Verified with a real captured run: `agent:onConfirm` → overlay + countdown,
  Always-allow persisted the grant to `consent.json`, Security pane listed it,
  revoke removed it; `npm test` green (69 checks), `npm run check-renderer`
  OK (pane count assertion relaxed from `== 4` to "panes == railTabs ≥ 4"),
  packaged app boots.

### v2.51 — Navigation & attention (docs parity, batch 1)
Grok Bot's navigation/attention surface, built against the official docs:
- **Command palette** — ⌘K searches sessions and actions (new session, settings,
  theme, sidebar, panels, find, export, mark-all-read, “find in this session”
  with a seeded query); ⌘⇧F is the sessions-only search. Arrow keys + Enter,
  Esc closes, styled to the token palette.
- **Session shortcuts** — ⌘1–9 jump to the Nth session in sidebar order,
  Alt+↑/↓ and Ctrl+Tab cycle sessions, ⌘[ / ⌘] walk visit history (drafts are
  saved before every switch).
- **Attention states** — sessions show an unread dot (persisted to
  `localStorage`, mirrored to the macOS dock badge) and a working spinner;
  right-click a session to mark read/unread, export, watch the run, or delete.
  When a run finishes or awaits approval while the window is unfocused the app
  posts a real OS notification (via `system.notify`); clicking it focuses the
  window and opens that session.
- **Fixed**: `agent:onConfirm` was emitted without the session id, so the
  approval overlay never armed — emissions now match the `(sessionId, payload)`
  event contract.
- Verified: `npm test` green (69 checks), `npm run check-renderer` OK, palette /
  context menu / unread dot / shortcut cycling validated with real captured
  runs (no renderer errors).

### v2.50 — Grok-parity restyle (real design tokens)
The renderer now uses Grok Bot 0.71.2's **actual design tokens**, extracted from
the shipped bundle rather than eyeballed:
- `styles.css` token layer rebuilt from the app's `CX` (light) / `EX` (dark)
  palettes plus both 42-key alpha maps: ink `#1c1c1c`, canvas `#fcfcfc`, rail
  `#f5f5f5`, dark planes `#1f1f1f`/`#161616`/`#121212`, bubbles `6%`/`100%`
  light and `4%`/`18%` dark, borders `6/12/24%` and `4/6/22%`, dark shadows
  off. **Light is now the default**; theme follows the system on first launch
  and persists to `localStorage`.
- Layout restyled to the floating-pill language: centered topbar chat pill,
  circle sidebar/titlebar actions, avatar-less bubbles with Grok geometry
  (`18/18/18/6` radius, 14/20 type), white starter cards, and a rounded
  composer pill with `+` affordance and ink send button.
- Right rail restructured into **one scrollable column of elevated cards**
  (sandbox frame, workspace, subagents, recorder, secrets) — the previous
  multi-sibling layout clipped and overlapped at short heights.
- Settings dialog restyled (neutral uppercase section labels, line-icon nav);
  check-renderer's min-size assertion updated from "all surfaces inside the
  viewport" to "contained in the scrollable rail, container fits viewport" —
  same intent under the new scroll-rail design.
- Verified: `npm test` green, `npm run check-renderer` OK, packaged app boots.

### v2.49 — Application menu + commands bridge
Quansiox now installs a real **application menu** (Grok-parity accelerators),
and menu commands land on the live UI instead of being decorative:
- `src/main/appMenu.js` builds the template — **New Session ⌘N** emits
  `navigation:navigate {type:'new'}` (the compiled renderer opens a session),
  **Settings ⌘,** / **Toggle Sidebar ⌘B** / **Toggle Panels ⌘.** / **Find in
  Session ⌘F** / **Focus Composer ⌘I** emit `ui:command` events; Edit, zoom,
  reload, DevTools and fullscreen use **native Electron roles** (⌃⌘F / F11).
- `src/renderer/commands-bridge.js` routes `ui:command` onto real DOM actions:
  settings dialog (via `quansioxUI`, falling back to the titlebar button),
  sidebar rail toggle, synthesized ⌘F / ⌘. accelerators the React renderer
  already handles, and composer focus with honest miss reporting — unknown or
  currently-impossible commands are **logged, never faked**.
- Verified in `test/batch19.js` (menu template/accelerator/click→emit
  assertions on macOS + Windows shapes; bridge DOM-shim tests: routing,
  fallbacks, mac/ctrl key synthesis, honest-warn paths) and the full
  `npm test` suite.
- **Packaging fix (found while verifying the built bundle):** packaged builds
  never booted — `src/main/services/screenBridge.js` requires `ws` at startup,
  but `scripts/package.js` shipped no `node_modules`, so Electron showed the
  "A JavaScript error occurred in the main process / Cannot find module 'ws'"
  dialog and the app sat windowless. The packager now scans
  `src/main|preload|coordinator` for bare requires and bundles the transitive
  runtime deps (`ws` today); the packaged app boots to `renderer did-finish-load`
  with the menu installed.

### v2.48 — Cron scheduling for automations
Automations now accept a **cron schedule** in addition to a fixed interval. A
dependency-free 5-field cron parser (`cron.js`: `*/n`, ranges, lists; Sunday 0
or 7) computes the next fire time by jumping month/day/hour so multi-year
schedules (e.g. `0 0 29 2 *`) resolve fast. `automationService` stores `cron`
and `due()` uses it (`isDue`); the UI form has a "Cron schedule (optional)"
field that overrides the minutes interval. Verified in `test/cron.js` (parse/
validate/matches/next incl. weekdays + Feb 29) and `test/automations.js` (cron
create/validate/update). `npm test` (52 scripts) green; repackaged + verified.

### v2.47 — Local automation webhook server
Automation webhooks now **actually fire over HTTP** (previously token-only, "server
follow-up"). A generic loopback `webhookServer` + `webhookService` serve
`POST|GET /hook/:id/:token` on `127.0.0.1:<ephemeral>`, verify the token with
`timingSafeEqual`, and run the automation (202 accepted, 403 bad token, 404
unknown, 405 wrong method). `automations.webhook` / `getAutomationWebhookCredential`
now return a real, callable URL; started at app bootstrap. Verified by
`test/webhook-server.js` (HTTP layer: 202/403/404/405 + GET) and the existing
`test/webhook.js` (token → run). `npm test` (51 scripts) green; repackaged +
verified.

### v2.46 — Workspace code search + real searchMedia/searchAgents
A dependency-free `searchService` adds grep-style **code search** and media/
roster search, wired to the agent and the compat surface:
- Agent tool **`search_code`** — substring or regex line search over the
  workspace, `file:line` hits, optional context, skipping `node_modules`/`.git`/
  build dirs and binary files, with scan/result caps and an honest bad-regex
  error.
- **`searchMedia`** / **`searchAgents`** are now **real local** handlers: media
  files (name query + `kinds` filter: image/video/audio/document) and session
  titles/id search.
- Verified in `test/search.js` (substring/regex/context/skip/caps + media +
  agents); the existing `session-extras.js` searchMedia contract is preserved.
  `npm test` (50 scripts) + renderer check green; repackaged + verified.

### v2.45 — Interactive tool-approval prompts
Quansiox now **pauses and asks** before a risky action mid-run — the local half of
Grok's `approveCredentialRequest` / `resolveLocalToolPermission`. With the new
`requireApproval` setting on (default **off**), the coordinator asks the main
process before running a **gated** tool (`shell`, `write_file`, `submit_secret`,
`computer_click/type/key/scroll/set_value/open_app`, `browser_fill/click`,
`github_pr_create`, `slack_post_message`, `email_send`); main relays an
`agent:onConfirm` event to the owning window, the renderer shows an
Approve/Deny modal for the exact tool + command/path, and the coordinator
proceeds only on approval. **Fail-closed**: no response within the timeout ⇒
denied. New `confirmationService` + `confirmations` IPC namespace; verified in
`test/confirmation.js` (approve/deny/unknown/timeout + gated set). Off by
default, so all existing behaviour/tests are unchanged. `npm test`
(49 scripts) + renderer check green; repackaged + verified.

### v2.44 — Global "Stop the run" pill
A floating, one-click **Stop the run** pill now appears over the chat whenever a
run is active (top-level or nested), calling `agent.stop` — the Grok-Bot
stop-pill pattern, complementing the per-child Stop in the subagent roster and
the computer-trust stop. Hidden while idle, so the fit-568 geometry check is
unaffected. Build + renderer check + `npm test` (43 scripts) green; repackaged +
verified.

### v2.43 — Per-child guest leases (computer pool)
The last piece of the unified live computer runtime: a **computer pool** that
leases a guest per delegated child (computer-use/browser) instead of sharing the
parent's. `computerPool.acquire(sessionId)` is reference-counted (siblings share
one guest; the last release reaps it) and enforces a concurrency cap (children
beyond the cap fall back cleanly); the boot/attach factory is injectable so the
lease/cap/reap logic is unit-tested (`test/computer-pool.js`) — booting a live
guest per child is hardware-gated. With boot (v2.36), view (v2.37), agent input
(v2.41), agent pixels (v2.42) and now per-child leases, the **unified live
computer runtime is complete as tested primitives**. `npm test` (43 scripts) +
renderer check green; repackaged + verified.

### v2.42 — Guest framebuffer decode (agent computer_screenshot sees the guest)
The agent's `guest` `computer_screenshot` now returns **real guest pixels**, not a
"viewer needed" placeholder:
- `rfbClient.capture()` requests a full framebuffer + parses the RFB 3.8
  `FramebufferUpdate` (message-type dispatch incl. Bell/ServerCutText/ColourMap),
  decodes the **Raw** encoding per the negotiated pixel format (byte-order +
  r/g/b shift+max scaling) into RGBA.
- `pngEncode` (built-in zlib) turns RGBA → a valid 8-bit RGBA **PNG** data URL +
  a `frameHash`; `guestComputerBridge.screenshot` returns it.
- Verified: `test/rfb-capture.js` (handshake + FramebufferUpdate decode →
  RGBA → PNG over an injected duplex). Driving a live guest is hardware-gated.
  `npm test` (43 scripts) + renderer check green; repackaged + verified.
  **The unified live computer runtime now has boot + view + agent input + agent
  pixels.** Remaining: per-child guest leases.

### v2.41 — Agent-driven guest input wired (safe routing)
The coordinator's `computer_*` tools now drive the **Linux guest** when a guest
desktop is live, using the **safe routing** that avoids the v2.39 hang (main
always replies; the Mac helper stays the fallback):
- `guestComputerBridge` owns a per-session RFB client and maps the Mac-style
  methods to RFB input (`click`/`rightClick`/`scroll`/`move`/`typeText` via
  keySym-per-char / `pressKey` with modifiers); `screenshot` reports the guest
  framebuffer size and points at the noVNC viewer (no fake pixels), and AX tools
  report honestly that the guest has no accessibility tree.
- On desktop boot the app attaches the RFB client to the guest's `5900.sock`; the
  coordinator passes `sessionId` on `computerCall`, and main routes to
  `guestComputerBridge` (attached) or the Mac `computerUseService` (fallback) —
  always replying, so the fork loop never blocks.
- Verified: `test/guest-computer-bridge.js` (mapping/typing/modifiers), `test/
  guest-bridge-live.js` (real RFB handshake + Pointer/Key bytes over a Unix
  socket), plus `computer-host`/`smoke` regression green. Driving a live guest X
  is hardware-gated (VZ boot). `npm test` (43 scripts) + renderer check green;
  repackaged + verified.

### v2.40 — RFB input client (guest-input primitive)
The remaining primitive for **agent-driven guest input**: `rfbClient` connects to
the guest's RFB socket (`5900.sock`), completes the **RFB 3.8 handshake** (version,
"None"-security negotiation, ClientInit, ServerInit parse) and posts
**PointerEvent / KeyEvent** — which `x11vnc` converts into X input — plus
`leftClick`/`rightClick`/`scroll`/`move`. Transport is an injectable duplex, so the
handshake + exact message framing are unit-tested offline (`test/rfb-client.js`);
a live guest is hardware-gated. This is the piece that, once connected to a booted
desktop VM, lets the agent click/type in the guest over the existing RFB socket
(no VM exec channel needed). `npm test` (43 scripts) + renderer check green;
repackaged + verified.

### v2.39 — Guest-input integration: honestly gapped (no fakes)
Attempted to route the coordinator's `computer_*` tools into the running guest.
The coordinator desktop-computer proxy, when installed in the fork loop, made
`computer_*` hang whenever the parent wasn't the real `agentService` handler
(e.g. tests that fork the coordinator directly) — a real regression, caught by
the suite and **reverted**. The desktop VM also publishes **no shell-exec
channel** (only the RFB socket + CDP), so the xdotool-based `guestComputerService`
cannot drive it today. Net honest state:
- **Live guest desktop viewer (v2.37) stays wired** — noVNC shows the guest and a
  human can **view + control** it (input via noVNC → WS → x11vnc → X). That is the
  real, working guest path.
- `guestComputerService` remains a **tested primitive** (`test/guest-computer.js`)
  for when an input channel exists (RFB-input client or a VM exec port), and
  `desktop.computer` now honestly reports the gap instead of faking success.
- Agent-driven guest input therefore needs an **RFB-input client** (the remaining
  G1 step; `docs/unified-computer-runtime.md`). `npm test` (43 scripts) +
  renderer check green; repackaged + verified.

### v2.38 — Guest computer-use (computer_* drive the Linux guest)
The unified-runtime computer path now targets the **guest** instead of this Mac:
`guestComputerService` maps `computer_*` (click/right-click/type/key/scroll/move)
to **xdotool** commands and captures the guest framebuffer as a **base64 PNG**
(binary-safe over the guest's text protocol; PNG magic validated). Every action
is followed by a verification screencap → `frameHash` (byte-hash) + `screenChanged`.
It's wired via `desktop.computer` (IPC) so the session's computer tools can route
into the running guest. Command construction, quote-escaping, PNG validation,
effect verification, and honest failure (no fake success) are unit-tested in
`test/guest-computer.js`. Actually driving a live guest X is hardware-gated (VZ
boot; prototyped).

### v2.37 — Live desktop viewer (noVNC) in the UI
The live-guest-desktop path is now end-to-end in the UI:
- A **"Display"** button in the computer panel boots the desktop VM for the
  session (`api.desktop.boot`) and renders a **noVNC viewer** (`ScreenViewer`
  over the `screenBridge` WS URL) — live guest pixels **and input** (noVNC → WS →
  guest x11vnc; the `screenBridge` negotiates noVNC's `binary` WebSocket
  subprotocol). A "Close desktop" button tears it down.
- **Renderer now bundles as ESM** (`format: 'esm'` + `<script type="module">`,
  which works over `file://` because esbuild emits one self-contained file) —
  required because noVNC's core uses top-level await.
- Verified in the real Electron renderer check (`results.liveDesktopControl`)
  and `test/screen-bridge.js` (asserts the `binary` subprotocol negation).
  **Live pixel verification needs a capable Mac** (VZ boot + x11vnc, prototyped).

### v2.36 — Live guest desktop: VM runtime wired (unified-computer runtime)
The desktop Linux guest that was **prototyped** (Alpine + Xvfb + openbox +
Chromium + **x11vnc**, verified on a capable Mac — RFB greeting + `guest-desktop.png`)
is now **wired into the app**:
- **`desktopVmService`** boots `qx-vm.next` with the desktop image + initramfs +
  `--socket-dir`, and returns once the **RFB (VNC) socket** (`5900.sock`) appears =
  a live guest desktop; injectable `spawn`/`sockDir` so the orchestration +
  endpoint discovery are unit-tested offline (`test/desktop-vm.js`).
- A **`desktop` IPC namespace** boots the VM for a session's sandbox root and
  attaches the existing **`screenBridge`** (WS↔Unix-socket) to the guest's RFB —
  so a noVNC renderer gets live pixels **and input** over `ws://127.0.0.1:<port>`
  (input flows noVNC → WS → x11vnc → X). CDP (`9222.sock`) is exposed for guest
  Chromium control.
- `package.js` now ships `qx-vm.next`, `desktop-Image`, `desktop-initramfs.cpio.gz`
  (verified present in the bundle).
- **Verify note (honest):** the VM boot/x11vnc/RFB was verified during the
  prototype (needs a capable Mac + VZ); here the orchestration + transport are
  tested, and the renderer noVNC viewer wiring is next. This is the first real
  step on the #1 local frontier (live guest desktop).

### v2.35 — Memory panel + sidepane reorganization
- **Memory panel** — a collapsible sidepane "Memory" section over the v2.19
  backend: recall (search), add (text + tags), and forget; verified in the real
  Electron renderer check (`results.memoryPanel`).
- **"More sections" group** — Skills / Integrations / Memory / Marketplace now
  live under one collapsible group that is **closed on short viewports** (≈0
  height, so `recorded-playback` and the computer-trust row stay in view at
  568px) and **auto-opens on tall viewports** (≥720px), with free user toggle
  (resize re-opens, never force-closes). This fixed a real fit regression the
  renderer check caught when a 4th/5th/6th fixed panel pushed the trust row out
  of the fold.

### v2.34 — Integrations panel (renderer)
GitHub/Slack/Email are surfaced in a sidepane **Integrations** section showing a
live **connect-state** per service (unknown / ok / off / error) with an
on-demand **Check status** button (status is NOT fetched on mount, so the
renderer stays offline-safe) and the real prerequisite hint when disconnected
(install gh + auth login / Slack bot-token secret / email config). Verified in
the real Electron renderer check (`results.integrationsPanel`).

### v2.33 — Skills manager (renderer)
Installed skills are now visible and manageable in the sidepane (collapsible
"Skills" section): list with enabled/disabled state, **enable/disable**
(disabled skills drop out of the agent's system-prompt catalog) and
**uninstall**, plus a quick-publish form (name + SKILL.md body → `api.skills.
publish`). Verified in the real Electron renderer check (`results.skillsPanel`).

### v2.32 — Marketplace panel (renderer)
The Marketplace is now **visible & usable** in the sidepane (collapsible
"Marketplace" section): browse the curated skills/MCP catalog with an
all/skill/mcp filter, one-tap **install** (a skill or a configured MCP server)
and **uninstall**, with an installed ✓ and disabled state until installed. Wires
`api.marketplace.*` (the v2.27 service) into the UI; verified in the real
Electron renderer check (`results.marketplacePanel`).

### v2.31 — Email connector (IMAP + SMTP, no-dep)
A real email connector over `node:tls` (no deps): `emailService` implements SMTP
send + IMAP search/fetch with a CRLF-line + `{n}`-literal aware reader and an
**injectable duplex transport**. Server settings live in settings; the
app-password is read from the **encrypted secrets vault**. Agent tools
`email_status / email_send / email_search` (`email_send` read-only-gated) + an
`email` IPC namespace. **Honest caveat:** verified here against *simulated*
protocol frames (injectable fake transport), not a live mail server — validate
against your real IMAP/SMTP before relying on it. A real per-connection
protocol-tag bug was found and fixed via the test. Verified in `test/email.js`.

### v2.30 — Slack connector (real)
A real Slack connector over the Slack Web API (HTTPS `fetch`; no SDK). The bot
token is read from the **encrypted secrets vault** (never settings/plaintext);
transport + base URL are injectable, so it's tested offline against a loopback
mock with no fake in production. Ops: `status` (`auth.test`), `chatPostMessage`,
`conversationsList`, `conversationsHistory`, `usersList`; a Slack `!ok` response
throws the real error, and a missing token fails closed. Agent tools
`slack_status / slack_post_message / slack_channels / slack_history`
(`slack_post_message` read-only-gated) + a `slack` IPC namespace. Real
prerequisite flagged: create a Slack app + store the bot token as secret
`slack_bot_token`. Verified in `test/slack.js`.

### v2.29 — SCM / GitHub connector (real)
A real GitHub connector via the `gh` CLI (no keys baked in — gh holds its auth;
credentials are never stored here). `githubService` runs `gh` with an injectable
command runner (testable in plain Node, no faking): `status` (installed/authed/
account), `prList`, `prView`, `prCreate`, `repoView`, `issueList` (repo defaults
to the workspace `origin`). Missing/unauthenticated gh is reported honestly and
operations throw the real hint (never a fake success). Exposed as agent tools
(`github_status`, `github_pr_list/view/create`, `github_repo`, `github_issue_list`;
`github_pr_create` refused in read-only) + a `github` IPC namespace. Real
prerequisite (flagged, not faked): the user installs `gh` and runs `gh auth login`.
Verified in `test/github.js`.

### v2.28 — MCP catalog + tool governance (real)
- **`getMcpCatalog`** is now a real, installable MCP-server catalog (from the
  marketplace bundle; summary-only, no command/env leakage in listings).
- **`toggleMcpToolDisabled` is now enforced** — it records a **standing deny** in
  the consent store (which `guardTool` actually enforces), fixing the old dead
  `mcpDisabledTools` flag that was written but never read (a fake). Disabling a
  tool makes `guardTool` refuse it; re-enabling revokes the deny.
- **`getEffectivePlugins`** reports the real enabled skills + configured/installed
  MCP servers.
- Verified in `test/mcp-governance.js`. (The MCP **team-shared** index is the one
  genuinely backend-bound piece — flagged in `GPA.md`, not faked.)

### v2.27 — Marketplace (Quansiox-owned, local)
A real, no-backend install marketplace unifying the skill catalog and stdio MCP
servers. `marketplaceService` ships a curated bundle (skills + MCP servers like
filesystem/fetch/memory/GitHub/SQLite); `list` (summary-only, installed flag),
`install` (dispatches by kind: skill → `skillsService`; MCP → writes
`settings.mcpServers`, preserving env incl. `{{secret:…}}` refs — the coordinator
MCP-syncs before each run), `uninstall` (idempotent), and `installFromManifest`
(an external JSON package, no network). Exposed via a `marketplace` IPC
namespace; `listPublicBotMarketplace` maps to the local catalog. Verified in
`test/marketplace.js`.

### v2.26 — Skills + plugin catalog (real, local)
First no-stub build of the in-scope feature set. A real local **skill catalog**
(`skillsService`, `userData/skills/`, 0600): a skill is a named package with a
SKILL.md-style body the model can follow (`use_skill`), tool hints, and an enable
flag. Install/"publish" (local upsert, slug-normalized ids), list, get,
uninstall, enable/disable, batch sync; publish target is the local catalog.
Enabled skills are **injected into the system prompt** and followable via the
`use_skill` / `list_skills` agent tools. The Grok skill/plugin methods map to
real ops: `skillsCatalog`, `publishSkill`, `unpublishSkill`/`uninstallPlugin`,
`syncPluginSkills`, `getSkillPublishTargets`, `getPluginSyncStatus`. A `skills`
IPC namespace exposes it. Verified in `test/skills.js`.

### v2.25 — Removed Cursor; honest compat surface
Quansiox **replaces Cursor** — it is not Cursor-connected. The compatibility
catalog (`src/main/services/grokCompat/catalog.js`) derived from Grok Bot's IPC
catalog now **drops the ~45 Cursor-account / sand / finance / spend / usage /
experiment-telemetry / Cursor-branded-SCM verbs** (`getCursor*`, `loginCursor`,
`listCursorAccounts`, `setCursorSpendLimit`, `getCursorUsageSummary`, …) — removed,
not stubbed. That cuts the surface from 401 → **356 unique methods**. The remaining
fail-closed entries are all **in-scope** capabilities to be built as real
Quansiox features (marketplace, plugins, skills, Slack/email/SCM/connectors,
cloud boxes, MCP catalog/team, voice/meetings) — not fakes/stubs. Asserted in
`test/grok-compat.js` (**118 real-local / 238 to-build**).

### v2.24 — Update controls + notification preferences
`getUpdateStatus` / `setUpdateTrack` / `setAutoUpdateWhenIdle` /
`quitAndInstallUpdate` map to the **real** updater (version + feed/track +
auto-idle + a guarded `updaterService.install()`), and
`getDesktopNotificationPreferences` / `setDesktopNotificationPreferences` are
settings-backed. `quitAndInstallUpdate` is fail-closed (`error: no update feed`)
when no feed is configured, so it never installs blind. Verified in
`test/update-notify.js`.

### v2.23 — Host preferences (pinned agents + sidebar sections)
`getHostPinnedAgents`/`setHostPinnedAgents`/`getHostSidebarSections`/
`setHostSidebarSections` map to a real `hostPrefsService`: a persisted (0600,
mtime-cached) store for **pinned session ids** (ordered, deduped, capped at 50)
and **configurable sidepane sections** (defaults all-on; unknown sections
accepted forward-compatibly). Exposed via a `hostPrefs` IPC namespace for the
renderer to consume. Verified in `test/host-prefs.js`.

### v2.22 — Agent-workflow recorder (record → replay)
Closes the skill record→replay pipeline for the local subset. New agent tools
**`record_start` / `record_stop` / `record_cancel` / `record_status`**: while
recording, the computer_* actions the agent takes are auto-captured into a
`SkillRecorder` and saved (on stop) as a replayable artifact — then driven by the
existing `replay_skill` (fresh screenshot tokens + frameHash). Gated: with no
active recording, the computer path is byte-for-byte unchanged; the
`computer` IPC proxy is now injectable (`installIpcComputerProxy(impl)`) for
tests. Verified end-to-end in `test/agent-recorder.js`. (This records the agent's
own GUI actions; capturing a *human* demo still needs the native CGEventTap.)

### v2.21 — Feature flags & experiment overrides
A local device/flags store (`flagsService`, `userData/flags.json` 0600,
mtime-cached for the forked coordinator): `evaluate(flag, default)` is the
gate primitive; user/applied **overrides win** over a small default map that
mirrors current feature reality (e.g. `nestedDelegation` on,
`unifiedComputerRuntime`/`skillRecordingCapture` off until their native work
ships). `snapshot()`/`refresh()` report every flag with its effective value +
source. The five Grok methods map to it (`getExperimentsSnapshot`,
`applyExperimentOverride`, `refreshFeatureFlags`, `applyFeatureFlagOverride`,
`exposeFeatureGate`) and there's a `flags` IPC namespace. Verified in
`test/flags.js`.

### v2.20 — Nested delegation (depth-capped)
Children can now decompose their own work: a subagent may spawn its own
`task`/`team` children, **capped at depth 2** (parent → child → grandchild).
Nested-capable, non-read-only children are offered/allowed the delegation tools;
each runs under its own scheduler/session (grandchildren inherit proper
parent/nesting keys), and aborting a run **cascades to the whole subtree**.
Verified end-to-end against the real coordinator + sandbox workers
(`test/nested-delegation.js`: a grandchild's isolated write lands in its own
sandbox, and a depth-2 agent is refused further delegation).

### v2.19 — Long-term memory
A local-first "bot memories" analog: a persistent facts store
(`userData/memory.json`, 0600) with agent tools **`remember`** (store/refresh a
fact + optional tags; read-only turns refuse it) and **`recall`** (keyword- and
tag-scored retrieval). Relevant remembered facts are **auto-injected into the
system prompt** each turn (recalled by the latest user message, else
most-recent; empty store → no change). A `memory` IPC namespace and the
`listGrokBotUserBotMemories` compat method expose it. Hashing-free keyword
scoring, dedupe on rewrite, 500-fact cap. Verified in `test/memory.js`.

### v2.18 — Webhook receiver for automations
`getAutomationWebhookCredential` now returns a **working** URL. A loopback
`webhookService` serves `POST|GET /hook/:id/:token` on an ephemeral port; the
token is verified with `timingSafeEqual` before the automation runs (fire-and-forget,
202 Accepted), returning 403 on a bad token and 404 on an unknown automation.
Wired at startup; exposed via a `webhooks` IPC namespace and folded into the
automation webhook compat method. Verified end-to-end in `test/webhook.js`.

### v2.17 — Broadcast & roster (multi-agent fan-out)
`broadcastToAgents` / `getServerAgentRoster` are now real via a
`broadcastService`: fan one message to many agent **sessions** concurrently
(each recipient gets a self-contained message and runs its own headless turn;
concurrency-capped at 8; per-session error isolation), with a roster snapshot.
Distinct from a `team` (which spawns fresh children) — a broadcast targets
existing sessions that keep their own history. Injected runner (real app:
`agentService.run`); exposed via a `broadcast` IPC namespace + the compat
methods. Verified in `test/broadcast.js`.

### v2.16 — Local standing-consent grants (tool permissions)
A `consentService` gives the user per-scope (`*` = global or a session id)
standing decisions on tools/subjects: **`deny`** (hard block that overrides
everything, even a permissive turn) or **`allow`** (a standing approval that
overrides the coordinator's policy gates). Wired into `guardTool` —
**backward-compatible**: with no grant present, behavior is exactly as before.
Persisted 0600 in `userData/consent.json`, exposed via a `consent` IPC
namespace and the Grok compat methods (`getLocalToolPermission`,
`setLocalToolPermission`, `resolveLocalToolPermission`,
`recordLocalToolStandingGrant`, `get/setLocalToolActionGrant`). Verified in
`test/consent.js` (store CRUD, wildcard subject, 0600, guardTool deny/allow/
no-grant behavior, compat routing).

### v2.15 — Screen transport bridge (unified-computer-runtime Phase 0)
First wired step toward a live guest desktop: a per-session `screenBridge` — a
websockify-style WebSocket↔backend transport the renderer's noVNC client will
connect to (`ws://127.0.0.1:<ephemeral>` → a Unix-socket or TCP screen server).
Electron-free, backed by the existing `ws` dependency, exposed via a `screen`
IPC namespace, shut down on quit. Verified headless with a synthetic RFB backend
(`test/screen-bridge.js`: WS↔TCP + WS↔Unix bidirectional forwarding, no-target
inert close, lifecycle). The **guest framebuffer itself** is Phase 1 (native
Swift/VZ virtio-gpu + input) — scoped in `docs/unified-computer-runtime.md`.

### v2.14 — Conversation outline viewer
A topbar **outline** button opens a popover listing the session's structure —
user turns, tool calls (`⚙`), results (`↳`), assistant summaries, and plan steps
(`○ ◐ ●`) via `api.sessionExtras.outline`. Clicking an item seeds the find bar
with a snippet to jump/highlight it. A compact, scrollable popover that
overlays the transcript. Verified in the real app — `check-renderer` opens it
and asserts the panel renders.

### v2.13 — Composer draft persistence
The composer now autosaves a per-session draft and restores it across session
switches/reloads. On typing, the text is debounced-saved (600 ms) to
`sessionExtras` (0600, `userData/drafts/<id>.txt`); switching or creating a
session saves the outgoing draft and the newly-active session's draft is
restored into the TipTap editor (a one-shot suppress flag avoids persisting the
restored text back); sending discards the draft. Verified in the real Electron
app — `check-renderer` asserts the `sessionExtras` save/get/discard round-trip.

### v2.12 — Session avatars in the UI
The renderer now renders a real per-session avatar in the session list. A
`useSessionAvatars` hook fetches each session's stored avatar via a new
`avatars` IPC namespace, generating a deterministic one (initials SVG data-URL)
the first time; cards show the avatar (CSP allows `data:` images), and the
collapsed rail uses the avatar as its rail marker. Verified end-to-end in the
real Electron app (`check-renderer` now asserts `avatars.generate` → SVG
data-URL and `avatars.get` persists, alongside the geometry/`stillMounted`
checks).

### v2.11 — Session conveniences (outline, media search, avatars, drafts)
Nine more Grok coordinator methods now map to real local behavior via a new
`sessionExtrasService`:

- **`getConversationOutline`** — a structured outline of a session transcript
  (user turns, tool calls, results, assistant summaries, plan steps).
- **`searchMedia`** — find image/video/audio/PDF files in the workspace
  (name query + kind filter, prunes `node_modules`/`.git`/dotfiles).
- **Avatars** — `setAgentAvatarBytes` / `getAgentAvatar` (per-session, 0600) and
  `generateAgentImage` (deterministic initials SVG, no image deps).
- **Drafts** — `sendDraft` / `discardDraft` persist a composer draft per session
  (0600), and `setAgentDraftingDisabled` gates writes (existing drafts preserved).
- **`seedConversationName`** — name a session from its first message.

Asserted in `test/session-extras.js`. (Also fixed a `$0` String.replace slip that
silently broke the media kind filter.)

### v2.10 — Authenticated browser sessions (cookie import)
The in-app browser can now run an authenticated session. `importChromeCookies`
(+ `listCookieOriginGrants` / `putCookieOriginGrants` / `listChromeCookieAllowItems`)
import a **user-supplied** Netscape `cookies.txt` into the browser's per-session
`persist:` partition via `browserService.applyCookies`. It is deliberately local
and safe: it does **not** scrape the Keychain or read other browsers' private
databases — the user provides the export. Imports are gated by a **per-session
origin-grant allowlist** (persisted 0600); only cookies whose domain matches a
granted origin are imported, and unimported domains are reported back so the
model can request a grant. New `cookieImportService` (pure parse / grant-filter / confinement) + `test/cookies.js`.

### v2.9 — Document library + attachment staging (real)
Grok's `getDocument`/`saveDocument`/`stageAttachment*` methods now map to real
local behavior instead of backend stubs. A new `documentsService` provides:

- **Library** — persistent markdown/text docs under `userData/library/` with an
  0600 index: save (upsert), get, list (summaries, no content blobs),
  `private`/`shared` visibility, and `shared`-only page resolution.
- **Attachment staging** — short-lived, addressable blobs: stage bytes (base64/
  text) or a **workspace/userData-confined** local file, resolve media
  (mime/size/kind), read back as text or base64, discard, and commit into the
  library (text → doc, binary → mime-bearing record). TTL 1h, 25 MB cap.

Wired through the compat surface (13 more Grok methods → local). Asserted in
`test/documents.js`.

### v2.8 — Delegation depth (Grok SubagentArgs cluster)
Delegated children now accept Grok's richer `SubagentArgs` fields, and
interrupting a child actually stops its work:

- **`model_parameters`** — per-child provider sampling (`temperature`, `top_p`,
  `seed`, `max_tokens`, …) forwarded to the provider for that child only.
- **`selected_context`** — extra curated context the parent hands the child
  (still never the parent transcript).
- **`continuation_config`** — per-child `max_loops` budget (default 12, clamp
  1–64) and a `nudge_message` surfaced when the budget is spent so the model
  knows to resume.
- **`readonly`** — force a read-only (`explore`) child regardless of requested type.
- **Real long-shell cancellation** — `task`/`team` children pass their abort
  signal into tool execution, and a `shell` call races a `exec.cancel` to the
  sandbox host, so interrupting a child **kills its running command** instead
  of only aborting the pending model fetch. (Sandbox host gains a `jobId` +
  `exec.cancel` op; also fixed a latent bug where the IPC `taskControl` message
  `type` leaked into the child-type lookup.) Asserted in `test/delegation.js`.

### v2.7 — Grok compatibility surface (280 desktop + 133 coordinator commands)
Quansiox now speaks the **entire shipped Grok Bot method surface**. A single
`grok` IPC namespace (`grok.invoke / grok.command / grok.catalog`) reaches
**552 unique methods** (0.71.2 surface re-extracted builder-agnostically: 530 names + coordinator-only controls, Cursor cluster admitted as fail-closed stubs)
across the two surfaces). Each method is routed by a declarative registry
(`src/main/services/grokCompat/catalog.js`, auto-generated from Grok's IPC
catalog) to one of two behaviours:

- **Real local behaviour** for the **375** methods that map to something Quansiox
  genuinely does locally — sessions/agents (`listAgents`, `openAgentTail`,
  `sendPrompt`, …), delegated tasks (`getSubagents`, `interruptAgentRun`,
  `kickstartAgent`, …), **automations & workflows** (`createAgentAutomation`,
  `runAgentAutomationNow`, `importAgentWorkflowText`, …), MCP
  (`authenticateMcpServer`, `getMcpState`, …), **vault & box secrets**
  (`getCredentialsState`, `putGrokBotVaultCredential`, `setBoxSecrets`,
  `startCredentialMint`, provider OAuth …), **agent files & avatars**
  (`uploadGrokBotAgentFile`, `pickAvatarFile`, …), **agent skills & plugins**
  (`addGrokBotAgentSkill`, `setGrokBotAgentPlugins`, `setGrokBotAgentPluginVariables`, …),
  **desktop stores & UI** (client persistence KV, deep links, theme/language/
  spell-check prefs, one-time tool approvals, link metadata, network
  diagnostics), **shell interactions** (agent trays, user forms with
  vault-save, interactive widgets), **gateway control** (pause/dev-offline
  gating, reconnect, sand-box path resolution, timezone override),
  **telemetry → local diagnostics** (every `report*`/`note*` event is recorded
  in the local diagnostics log, visible via `diagnosticsList`), **feedback
  sink** (local JSONL), **desktop overlay panel** (mount/unmount/read state,
  quick choices, geometry via movePanel/endPanelMove, drop-up menu anchor,
  real prompt submission through the agent loop), **macOS Messages state**
  (permission probes for Full Disk Access/Contacts/Automation, enable toggle,
  real app icon, recipient allowlist, grant request/await/resolve flow),
  **terms & marketplace entry installs** (terms record, bot-color pref,
  installEntry with variable values, document edit rights), **local voice**
  (macOS `say` synthesis/preview), **deep-dig additions** (host settings,
  stable machine id, global-search pref, onboarding skip, clipboard read,
  computer-use permission probes + Settings pane deep-link, allowlist,
  1Password probe, cached sand-access, gateway return/box-state notes, RPC
  trace window with W3C traceparent, server transcript-tail access, MCP
  plugin listing + adopting staged server tool permissions, agentsList,
  panel `readLayout`/`unmountSelf`, experiment-exposure → diagnostics), secrets
  (`submitSecret`, `listSecrets`, …), skills/teach-recording, updates, host
  status and window control. These call Quansiox's own services.
- **Fail-closed stubs** for the **177** methods that are cloud/backend/account/
  vendor-bound (Cursor accounts + teams, Slack/email listeners, cloud boxes
  and remote screen-live, voice calls/meetings, SCM/GitHub cloud agents,
  billing, dev-tool windows). They
  return a structured `{ status:'unavailable', scope, reason }`
  instead of a fake success — so clients get correct semantics, not a lie.

`grok.catalog()` exposes the full register with per-method group/impl/scope.
Covered and asserted in `test/grok-compat.js`. This is a **compatibility
surface**, not feature parity — see `GPA.md`.

**Automations & workflows (local-first).** A non-electron-free `automationService`
runs **scheduled agent turns** (an automation = an agent prompt on an interval,
min 60 s, background/headless) and **step workflows** (an ordered prompt list
run sequentially in one session). It persists to `userData/automations.json`
(0600), has a token-verified local webhook path (`getAutomationWebhookCredential` →
`runByWebhook`, `timingSafeEqual`), imports text/local-file workflows, is
scheduled by a tick loop wired at startup, and is managed from a collapsible
sidepane manager and the `automations` IPC namespace. The agent runner is
injected (real app: `agentService.run({sender:null})`; tests: a fake).

### v2.6 — Grok "sand" shell + encrypted secret references
- **Grok-faithful shell** — the nav rail is now collapsible (280 px ↔ 88 px
  icon rail, toggle in the sidebar head) and the sidepane is drag-resizable
  with bounds (260–560 px). Both the collapse state and the pane width persist
  in settings and survive reloads — Grok Bot's collapse/resize/persisted-geometry
  shell behaviour, on Quansiox's own components.
- **Encrypted secrets vault** — a Grok `submitSecret`-style store. A new
  `secrets` service (AES-256-GCM at rest, keyed by a 0600 `.secrets.key`,
  the same trust model as Cue's device-id and Quansiox's sockets) holds
  `{ name → { field: value } }`. `list()` returns names + field names only and
  **never** values. The agent gets `submit_secret` / `list_secrets` tools, and
  any `{{secret:NAME.FIELD}}` (or single-field `{{secret:NAME}}`) reference in a
  tool argument is decrypted at the execution boundary (`execService` and the
  coordinator) — so values never land in on-disk transcripts or tool cards.
  A sidepane manager adds/lists/deletes secrets. Tested end-to-end in
  `test/secrets.js`.

### v2.5 — Subagents, skill replay, and Jev judgments
Quansiox now runs Grok-style parent/child subagents locally (general, explore,
shell, browser, computer-use, plus custom agents with a tool allowlist and
permission mode). A child is started from its own prompt and does not receive
the parent transcript. Children honor a concurrency cap (local fallback 32),
can be awaited or backgrounded, and can be interrupted. The shell shows
subagent rows (title, type, status, summary) and computer trust/stop chrome
even when no run is active. Skill recording follows idle → preparing →
recording → processing → completed, cancelled, or error, and a completed
artifact replays as computer actions under the same freshness tokens and
frame hashes as a live computer-use loop. When `TYPESAFE_API_KEY` is set,
one `POST /v1/systemone` call with model `jev-1.13.0` supplies a route
Choice, a mutation Noul, and a subagent Score. The key stays in the main
process. With no key, the ordinary chat-completions loop is unchanged.
The feature inventory and deferrals are in `docs/parity-inventory.md`.

### v2.4 — Manus computer-use subsystem + Cue deep-dive ports
Fresh reverse-engineering pass over Manus Studio 2.0.3's computer-use
subsystem (`bin/`, `addons/`, `native/`, browser-js, the Swift helper app)
and Cue 1.0.7 (full main-process + frontend analysis) produced five new
capability families, all local-first:

- **Embedded agent browser** (Manus WebContentsViewBrowserDriver pattern) —
  `browser_*` tools drive a real in-app browser: one WebContentsView per
  session (shared `qx-browser` partition), shown in a dedicated host window
  (🌐 in the session list; closing keeps browsing headless), tabs
  (new/list/activate/close), and hybrid accessibility snapshots over the
  Chromium DevTools protocol (`webContents.debugger`:
  `DOMSnapshot.captureSnapshot` for geometry + `Accessibility.getFullAXTree`
  for semantics, joined on backendNodeId). Snapshots issue `snapshot_id` +
  `[ref=eN]` pointers; actions with stale ids are refused with the Manus
  error taxonomy (STALE_PAGE / STALE_REF / INVALID_COORDINATES …). Input
  goes through CDP `Input.dispatch*`; fills use the native-setter +
  input/change-event snippet; `documentRevision` (navigations) and a
  `mutationGeneration` counter (Runtime.addBinding + MutationObserver)
  power the staleness checks. Plus console ring buffer, dialog queue
  (`browser_handle_dialog`), `browser_js`, `browser_wait`, downloads to
  userData, and popup→tab policy. 15 tools total
- **Out-of-process computer-use helper** (Manus skill-recorder/operator
  architecture) — AX reads and input injection moved out of the main
  process into a supervised helper (`src/computer-helper`) speaking
  newline-delimited JSON-RPC 2.0 over a 0600 unix socket derived
  Manus-style (`/tmp/qx-cu.<uid>.<sha256(bundleId∥profile)[24]>.sock`).
  Launch uses the single-use 0600 bootstrap file with a 32-byte control
  token (deleted after read), then `initialize` →
  `notifications/initialized` → `computer/authenticate`. The supervisor
  (operatorManager pattern) applies an env whitelist to the child, capped
  exponential restart (3s·2ⁿ cap 10s, reset after 30s stable), and socket
  cleanup. Verbs: `computer/{app_state,find_elements,click,type_text,
  set_value,press_key,scroll,open_app,list_apps,status}` +
  `application/list` (installed apps, Manus shape). New agent tools:
  `computer_find` (AX queries by role/name) and `computer_set_value`
  (AX-native field writes). `computer_screenshot` now returns a dHash
  `frameHash` + `screenChanged` (the Manus screenshot.frameHash pattern)
  so effect verification is one comparison, not a full-frame diff
- **Agent code sandbox** (Manus `computer-use/js` / QuickJS cell pattern) —
  the `agent_js` tool runs model-authored JavaScript cells with `cu.*`
  (computer) and `iab.*` (browser) bindings, a 64-host-call budget per
  cell, deadline checks at every host-call boundary plus a sync-execution
  vm timeout, `output.observation/write/image` collection, and a `state`
  object preserved across cells — budget/deadline overflows return
  model-facing guidance to continue in a new cell. (node:vm port: a
  reliability sandbox, not a hard security boundary — documented as such.)
- **Offscreen render utility** (Manus utilityHost render_pdf/render_png
  pattern) — `render_pdf` / `render_png` tools render workspace HTML via a
  hidden BrowserWindow on a dedicated partition: waits `document.fonts.ready`
  (+settle), prints A4 PDFs, and captures full-page PNGs through CDP
  `Page.captureScreenshot{captureBeyondViewport}` with content-size
  auto-grow (16384px cap, scale ≤2), serialized through a render queue
- **Keep-awake** (Manus keepAwake pattern) — a `powerSaveBlocker`
  ('prevent-app-suspension') held while agent runs are in flight, released
  when the last finishes, AC-only via a `pmset` probe

Cue findings that were already ported (playback windows, sender
verification, staged updates, quit gating) were re-verified against the
decompiled 2 MB main bundle; Cue's remaining surface (LiveKit screen-live
viewer, cloud computer control, IM linking, browser sign-in) is
cloud-service-bound and out of scope for a local-first agent. The full
analysis lives in `../work/reports/` (manus-core.md, manus-computer-use.md,
cue.md).

### v2.3 — Cue patterns: playback windows, IPC hardening, staged updates
- **Session playback windows** — Cue's `computer:playback` pattern on local
  recordings: every `computer_screenshot` the agent takes is persisted in the
  transcript, and a ▶ button in the session list opens a dedicated playback
  window (`#playback=<id>`) that steps through the recorded run — play/pause
  (1 fps), prev/next, timeline scrub, fullscreen (`f`), fit-to-content on the
  first frame, arrow/space/f keys, and a live mode that follows the run while
  the agent is still taking screenshots (`playback:onFrame`). A
  playing-sessions registry broadcasts open playback windows to every
  renderer (`playback:onChanged`, Cue's `playingSessions`)
- **IPC sender verification** — Cue's `verify(event)` hardening on the single
  invoke/meta channel: the sender must be a window the windowManager created
  and still tracks, must be its main frame (subframes/iframes rejected), and
  must be at our own origin (file:// packaged, localhost dev); anything else
  is refused before the handler is looked up
- **Install identity** — a telemetry-free per-install UUID (`device-id`,
  0600, Cue's CredentialStore pattern); sent only to the user-configured
  update feed as `X-Quansiox-Device`
- **Staged updates with prepare-restart handshake** — `updater.install()`
  gates on active playback, downloads the artifact (size-capped), stages a
  zip bundle swap (old bundle retained as `.old`), asks every renderer to
  flush (`updater:onPrepareRestart` → ack via `updater.prepared`, 10s
  timeout), then relaunches; non-zip artifacts are revealed in Finder.
  Settings gains a "Download & restart" button
- **Recording-active gates** — staged installs are refused while a playback
  window is open, and the first quit attempt focuses it instead of quitting
  (second attempt forces, Cue's `hasActiveRecordings` pattern)
- **Grace close for session pop-outs** — closing a session window mid-run is
  deferred once: the renderer gets `window:onCloseRequested` with a 5s
  countdown overlay (Keep window / Close anyway); after the grace period or
  a second close click the window really closes

## What it does

You give Quansiox a task. It plans and executes it locally using tools —
`shell`, `read_file`, `write_file`, `list_dir` — against an
OpenAI-compatible chat-completions provider (OpenAI, xAI, OpenRouter, Ollama,
LM Studio, …) that *you* configure. Every tool call and its output streams
into the chat as a collapsible card, Grok-Bot style.

### v2.2 — Linux VM sandbox (kernel isolation)
- **True Linux VM per session** — `sandboxMode: vm` boots an Alpine
  3.20/aarch64 Linux VM (kernel 6.6, `linux-virt`) via
  Virtualization.framework (`vm/qx-vm`, Swift, entitlement-signed) with the
  sandbox dir shared over virtiofs: agent shell/file tools execute **inside
  Linux** while artifacts persist on the host. The guest runs a busybox
  agent speaking a TSV protocol on the virtio console; the host adapter
  maps it onto the sandbox op set. Selectable in Settings:
  process+seatbelt (fast) / Linux VM (kernel isolation) / off

### v2.1 — trust overlays, freshness tokens, kernel isolation
- **Trust overlays** — while the agent uses computer tools, a pulsing border
  glow frames the screen (click-through, all workspaces) and a floating
  stop pill kills the run in one click (Grok-Bot glow/stop-pill pattern,
  Electron-native instead of Metal)
- **Freshness tokens** — `computer_screenshot` issues a `coordinate_token`
  (invalidated by the next screenshot); `computer_ax_tree` issues a
  `snapshot_id`; `computer_click` refuses stale/missing tokens with
  model-facing taxonomy messages (SCREENSHOT_REQUIRED / invalid-or-stale)
- **Kernel-isolated sandbox exec** — sandbox commands run under a macOS
  seatbelt profile (`sandbox-exec`, the Chromium mechanism): filesystem
  writes are kernel-blocked outside the sandbox root (plus /tmp and dev
  null); a startup probe falls back to process isolation where seatbelt
  cannot apply (nested sandboxes)
- **Sandbox computers** — every agent session now gets its own isolated
  "computer" (Manus sidecar/supervisor pattern, local): a forked sandbox
  host process per session serving the bridge op set (fs
  read/write/stat/listdir/mkdir/remove/rename + exec + persistent
  terminals) over a 0600 unix-socket JSON-RPC, with escape-checked paths,
  confined cwd/HOME, job timeouts, and a SessionSupervisor-style desired
  state (capped backoff respawn, status reporting, hard cleanup). The
  agent's shell/read/write/list tools route through it (visible as
  `(sandbox: …)` notes in tool cards); `sandboxMode: off` falls back to
  raw host tools. Sockets use short tmpdir paths (macOS 104-char limit)

### v2.0 — React frontend + real computer use + sandbox computers
- **React 19 + TipTap frontend** — the renderer is now a React app
  (esbuild-bundled): TipTap composer with placeholder, streaming message
  list, tool cards with inline agent screenshots, plan checklists,
  session sidebar, usage row — Grok-Bot-style architecture with the
  settings/templates dialogs kept as a vanilla bridge
- **Real computer use** — seven `computer_*` agent tools (screenshot, AX
  tree, click, type, key, open app, list apps) executed in the main
  process via JXA/System Events + desktopCapturer, called from the
  coordinator over the fork channel with timeouts. Screenshots return to
  the model as multimodal follow-up turns and render in-chat. Gated by an
  opt-in setting + permission probe (Accessibility + Screen Recording),
  with a trust banner while the agent drives the GUI

### v0.25 features
- **Onboarding empty state** — welcome card with one-click starter prompts
  (workspace analysis, tool building, review, git summary) and a shortcut
  cheat-sheet; disappears with the first message

### v0.24 features
- **Find in session** — ⌘F opens a find bar: live match highlighting,
  n/total counter, ⏎/⇧⏎ cycling with smooth scroll-to, Esc closes
- **/stats** — session statistics via a tested `sessions.stats` handler:
  turn breakdown, per-tool call counts, files written, token usage, and
  estimated cost

### v0.23 features
- **Provider profiles** — save complete provider configs (base URL, key,
  model) in Settings and switch instantly: Use button, `/provider` command
  with listing + switching, `saveCurrent` one-click capture. Keys are
  stored but never returned in listings (presence flag only); redacted
  placeholders on update preserve stored keys

### v0.22 features
- **Screenshot capture** — 📷 Snap in the composer captures the main screen
  via `desktopCapturer` (capped 1920px thumbnails) and attaches it as an
  image for vision models; handlers also expose window capture and source
  listing

### v0.21 features
- **In-app file editor** — the Files panel viewer gains an Edit mode:
  textarea with Save/Cancel, workspace-escape and size guards on write,
  parent-directory creation, tree refresh on save

### v0.20 features
- **Update checker** — feed-based updates (electron-updater-style
  `latest.json`: `{version, url, notes}`): semver comparison with
  prerelease-tolerant parsing, manual "Check for updates" in Settings with
  ✓ result + download link (routed to the system browser), clean errors on
  malformed feeds, fully opt-in via `updateFeedUrl` (empty = off)

### v0.19 features
- **Context compaction** — when a transcript exceeds
  `compactThresholdTokens` (default 60k, estimated at ~4 chars/token), the
  coordinator summarizes everything except the last 10 turns via a
  non-streaming provider call, stores `{summary, cutoff}`, and sends
  `system + summary + kept turns` (the summary is pinned and never
  dropped by history windowing). The full transcript stays on disk for
  export; the UI shows a "⋯ summarized" divider (hover for the summary)

### v0.18 features
- **Cost estimation** — a built-in pricing table (OpenAI/xAI/Anthropic/Gemini/
  DeepSeek, $/1M tokens) matched by longest model-name prefix with vendor
  path stripping (`openrouter/openai/gpt-4o` → `gpt-4o`), user overrides
  via `customPricing`, per-session totals tracked with the model used,
  shown live in the usage badge and via `/cost`

### v0.17 features
- **Prompt library** — ★ Templates in the composer bar: save the current
  composer text as a reusable template, insert with a click (appends when
  the composer has text), delete, auto-titled from the body, persisted in
  settings

### v0.16 features
- **Menu-bar tray** — template-style generated icon (adapts to light/dark)
  with New session / Show / Quit, click-to-show, graceful teardown
- **Global shortcut** — configurable "toggle Quansiox" hotkey (e.g.
  `CommandOrControl+Shift+K`) in Settings, hot-swapped on save with clean
  conflict handling

### v0.15 features
- **Provider resilience** — 429/5xx and network failures retry with capped
  exponential backoff (honoring `Retry-After`), surfaced live in the status
  line via `agent:onRetry`
- **One run per session** — concurrent runs on the same session reject
  cleanly instead of clobbering each other's state

### v0.14 features
- **Multi-window sessions** — pop any session out into its own window (⧉ in
  the session list, Manus TaskWindow pattern): one window per session with
  focus-on-recall, hash-routed boot (`#session=<id>`), clean registry
  cleanup on close, and recreation after closing

### v0.13 features
- **Real PTY terminal** — the shell session wraps bash in a genuine
  pseudo-terminal via macOS `script -q /dev/null` (no native modules):
  prompts, 256-color output, and interactive programs work. The renderer
  gained an ANSI renderer (SGR colors/bold, CR progress-bar handling) and
  ⌃C support. Where ptys are unavailable (restricted execution contexts)
  the session degrades to plain pipes with auto-respawn, so the panel
  always has a live shell

### v0.12 features
- **Out-of-process agent coordinator** — the agent loop now runs in a forked
  child process (Grok Bot's node-agent-coordinator pattern): crash-isolated
  from Electron, supervised with auto-restart, request multiplexing by id,
  events relayed to the owning window, and clean shutdown on parent exit.
  Services became electron-free (lazy requires + `QUANSIOX_USER_DATA_DIR`),
  settings re-read on mtime change so main-process saves propagate to the
  child, and MCP servers sync before each run

### v0.11 features
- **Packaging pipeline** — `npm run icon` renders the app icon (gradient Q
  tile via Pillow → `iconutil`), `npm run package` assembles a standalone
  `release/Quansiox.app` (renamed binary, own Info.plist, icon, app payload,
  ad-hoc codesign) that runs with a double-click

### v0.10 features
- **Live plan checklist** — the agent has an `update_plan` tool; plans render
  as an in-chat checklist (○ pending / ◐ in progress / ● done) that updates
  live, persists in the transcript, and is reconstructed on session reload
- **Light/dark theme** — one-click toggle in the title bar, persisted

### v0.9 features
- **Slash commands** — `/new`, `/clear`, `/export`, `/model <name>`,
  `/attach <path>`, `/help` with an inline autocomplete popup in the composer
- **@file mentions** — type `@` to fuzzy-search workspace files and attach
  one as context in a click
- **Custom instructions** — free-text system-prompt addendum in Settings
- **Finish notifications** — macOS notification when a turn completes while
  the window is unfocused (click focuses the window); toggleable

### v0.8 features
- **Token usage accounting** — requests `stream_options.include_usage`
  (with automatic retry for providers that reject it), accumulates
  prompt/completion tokens per session, live badge in the sidebar
  (↑/↓ tokens · requests), restored when reopening a session
- **History windowing** — long transcripts are capped to the last N turns
  (`historyWindowTurns`, default 60) with the window always starting on a
  user turn so the provider sees a valid message sequence

### v0.7 features
- **Export as Markdown** — any session exports to a `.md` file (save dialog)
  with user/assistant turns and tool calls as collapsed blocks
- **Deep links** — `quansiox://session/<id>`, `quansiox://settings`,
  `quansiox://new` navigate the app (cold start + running instance)
- **Reveal in Finder** — right-click any file in the explorer

### v0.6 features
- **Git panel** — branch indicator, porcelain status with per-file actions
  (diff view, stage, discard — untracked files removed safely), stage-all +
  commit box, all through a `gitService` backed by `execFile('git')`
- **Agent checkpoints** — before every agent turn the workspace is
  auto-committed (`quansiox checkpoint: before "<task>"`) so agent edits are
  always undoable; clean trees skip silently, and it's toggleable via
  `autoCheckpoint` (with optional `autoInitRepo`)

### v0.5 features
- **Retry** — re-run the last turn: the transcript truncates at the last
  user message (multimodal content preserved) and the agent runs it again
- **Session rename & search** — double-click a session title to rename
  inline; type in the search box to filter sessions
- **Message actions** — hover any message for Copy (and Retry on your own
  turns)

### v0.4 features
- **Attachments** — attach or drag-drop files into the composer; text files
  are inlined as context blocks, images go to the model as base64
  `image_url` parts (vision models); turns persist as multimodal content
- **Provider presets** — OpenAI / xAI / OpenRouter / Ollama / LM Studio
  one-click base URLs
- **Test connection** — validates credentials via `GET /models` and fills a
  model picker datalist with the provider's discovered models

### v0.3 features
- **MCP tool servers** — configure stdio MCP servers (e.g. `npx -y …`) in
  Settings; Quansiox speaks JSON-RPC 2.0 (initialize → tools/list →
  tools/call), namespaces their tools as `mcp__<server>__<tool>`, merges
  them with the built-ins in the agent loop, and surfaces live status

### v0.2 features
- **Token streaming** — assistant replies render live via SSE deltas
- **Persistent sessions** — full transcripts (including tool calls/results)
  on disk; session list with auto-titles, reload, delete
- **Workspace file explorer** — live tree (⌘. to toggle the panel), click a
  file to view it, auto-refreshes via recursive fs.watch
- **Live terminal** — persistent bash session in the panel, output streamed
  back over scoped IPC events
- **Safe minimal markdown** in assistant replies (code fences, inline code,
  bold, headings)
- **Abort** mid-turn (kills the fetch stream and any running child process)
- `npm test` — end-to-end smoke test with a mock SSE provider covering
  streaming, tool assembly/execution, session persistence, and file service

Your API key is stored only in `~/Library/Application Support/Quansiox/`
and sent only to the base URL you configure.

## Architecture

```
src/
  main/                     Electron main process (Manus-style services)
    index.js                bootstrap: IPC first, then window; file logging
    windowManager.js        typed window registry (main window)
    ipc/
      registry.js           single-channel RPC: 'quansiox-ipc-api' routed as
                            'namespace:method', plus 'quansiox-ipc-event' push
      emitEvent.js          broadcast + window-scoped events
      namespaces.js         system / window / settings / agent / shell / workspace
    services/
      agentService.js       the agent loop (tool-calling, step cap, abort)
      execService.js        sandboxed-by-cwd shell execution with timeouts
      settingsService.js    JSON settings store with redacted reads
  preload/index.js          meta-discovered dynamic facade -> window.quansiox
  renderer/                 vanilla HTML/CSS/JS chat UI (no build step)
build/Quansiox.app          launcher bundle wrapping the local Electron dist
```

### Patterns adopted from Manus Studio
- **Single-channel RPC facade**: the preload asks once for the handler
  manifest (`quansiox-ipc-meta`, sendSync) and dynamically builds
  `window.quansiox.api.<namespace>.<method>()` — one choke point instead of
  dozens of `ipcMain.handle` channels.
- **Window-scoped events**: agent deltas/tool progress are emitted only to
  the window that owns the session (`emitScopedEvent`).
- **Service-oriented main process** with symmetric setup.
- `contextIsolation: true`, `nodeIntegration: false`, strict renderer CSP,
  external links forced to the system browser.

### Patterns adopted from Grok Bot
- **Local agent coordinator**: the agent loop runs in the main process as a
  supervised service with per-session state, step limits, and abort.
- **Local exec tooling**: shell commands run through a dedicated exec service
  (non-interactive bash, hard timeout, output caps, kill-all on abort).
- **Streaming tool transparency**: every tool call renders in-chat with its
  arguments and results, collapsed by default.

## Run it

```bash
npm install                # electron is a devDependency
npm_config_cache=/tmp/npmcache node node_modules/electron/install.js
open -n build/Quansiox.app     # dev launcher
```

**Build a standalone app:**

```bash
npm run icon        # generates build/icon.icns (Pillow + iconutil)
npm run package     # assembles release/Quansiox.app + ad-hoc codesigns it
open release/Quansiox.app
```

The packaged bundle carries its own Info.plist (`im.quansiox.desktop`),
generated icon, and the full app payload in `Resources/app` — double-click
to run, no shell needed (and no `--no-sandbox` flag).

Then: open **⚙ Settings**, enter your provider base URL, API key, and model,
pick a workspace folder, and give the agent a task.

> Note: under managed/sandboxed shells Chromium's sandbox can fail to
> initialize; the launcher therefore passes `--no-sandbox` (the same
> workaround Grok-Bot-style dev setups use). Launching normally from Finder
> does not require it.

## Roadmap ideas (from the analysis backlog)
- Replace the helper's JXA mechanics with a signed Swift helper
  (AXUIElement/CGEvent/ScreenCaptureKit) behind the same JSON-RPC socket —
  the Manus ManusComputerUseService layout, including background AX actions
  (activate:false) and per-window capture.
- QuickJS (WASM) as the agent-code sandbox runtime for a hard boundary.
- Skill record/replay: helper-hosted workflow recorder with the Manus
  status machine (idle→preparing→recording→processing→completed), 500ms
  fingerprint-deduped polling, and zip artifacts converted to prompt skills.
- Custom `quansiox://` privileged protocol for local media.
- Terminal attach/recovery protocol (sequence replay, viewer epochs) from
  Manus's DesktopTerminalManager.
