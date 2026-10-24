# Codebase-vs-codebase parity matrix — Grok Bot 0.71.2 vs Quansiox

**Date:** 2026-10-20
**Reference target:** `/Users/mohsin/manux/Grok Bot.app` — `com.anysphere.sand`, CFBundleShortVersion `0.71.2`, Electron, author `SpaceXAI`, `ElectronAsarIntegrity` SHA-256 present, built 2026-10-14.
**Subject:** `/Users/mohsin/manux/quansiox` — local-first desktop AI agent, Electron 44.5.1, React 19.3.
**Method:** static reverse engineering of the shipped `app.asar` bundles + native Mach-O analysis, compared against the **actual quansiox source and its runtime behaviour**. No document was used as a source of truth — the previous `docs/grok-bot-docs-parity.md` review was a docs.x.ai spec comparison and is explicitly *not* the basis here.

Extracted reference corpus (read-only, in temp):

| Artifact | Size | Role |
|---|---|---|
| `dist/electron-main/main-app.cjs` | 2.63 MB | Electron main, feature logic, RPC edges |
| `dist/electron-main/main-core.cjs` | 865 KB | Platform core, 126-module registry |
| `dist/electron-main/proto.cjs` | 1.23 MB | `aiserver.v1` protobuf |
| `dist/node-agent-coordinator/main.cjs` | 893 KB | Harness router / protocol broker |
| `dist/local-exec-daemon/main.cjs` | 3.55 MB | In-box executor, 41 exec resources |
| `dist/renderer/**` | 32 MB | 534 JS chunks, 588 assets, 19 bounded contexts, 130 recovered source paths |
| `dist/native/sand-webauthn-signer` | 5.02 MB | Rust CTAP2 authenticator |
| `dist/native/sand-op-launcher` | 136 KB | macOS seatbelt launcher for `op` CLI |

---

## 1. Headline verdict

The two codebases are **not** comparable in the shape the existing docs imply.

**Quansiox's substrate is ahead of Grok Bot's.** Grok Bot's shipped desktop build has a **broken local sandbox**: the helper binary path variable `Vkt` is declared and never assigned, so `isSandboxHelperSupported()` is always false. Every local shell call requesting `workspace_readwrite`/`workspace_readonly` raises `SandboxUnsupportedError`; every call that requests no policy runs with the effective policy `insecure_none` — **unsandboxed**. The daemon's `PermissionsService` is likewise constructed with zero overrides, so `shouldBlockShellCommand → {kind:"allow"}` unconditionally. Quansiox, by contrast, ships a real deny-by-default SBPL generator (`src/exec-daemon/seatbelt.js:40`), an authenticated exec daemon over a unix socket with `crypto.timingSafeEqual` bootstrap auth, a forked per-session host process, and a real kernel-isolated Linux guest (`vm/qx-vm.next`, `desktop-Image`, `desktop-initramfs.cpio.gz`) with APFS-clone snapshots.

**Quansiox's agent-governance layer and product surface are far behind.** The permission model does not execute in a default install (`policy = { permissive: true }` unless `TYPESAFE_API_KEY` is set), the auto-review is a substring matcher rather than a classifier, and the renderer is a single 2,731-line `main.jsx` with **4** approval card types against Grok Bot's **48** card kinds.

So "minimal functional parity" is correct for the *product*, and backwards for the *engine*. The gap is concentrated in three places — **governance**, **orchestration protocol**, and **UI surface** — not in the execution substrate.

---

## 2. Structural comparison

| Dimension | Grok Bot 0.71.2 | Quansiox | Verdict |
|---|---|---|---|
| Process model | Electron main → forked coordinator → detached exec daemon | Electron main → forked coordinator → exec daemon + forked sandbox host | **par** |
| RPC transport | Dune RPC: 7 schema-validated edges (`main` 309, `gateway` 172, `coordinator-control` 30, `desktop-mount` 12, `sand-dev` 10, `box-vnc` 2, `coordinator-main` 2) | Single flat IPC channel set, 68 namespaces / 370 methods, `src/main/ipc/registry.js` | **behind** |
| Event bus | SSE gateway, ~30 named channels (`transcript`, `subagents`, `computer-action`, `mcp-servers-updated`, `messages-grants`, `box-disk-pressure`, …) + `MessagePort` transfer | `emitEvent.js` broadcast + scoped fan-out + one MessagePort fast path | **behind** |
| RPC method surface | 525 methods across edges | 370 methods across 68 namespaces (+ a 552-name Grok-compat catalogue) | **behind** |
| Agent loop | **Not in the client.** Harness routes to `box` (remote K8s pod, `cursorvm.com`) or `temporal` (Cursor cloud, `aiserver.v1.GrokBotService`, 313 unary RPCs) | In-process real tool-call loop, 6 hand-rolled provider protocols, SSE streaming, LLM compaction, fork isolation | **ahead** |
| LLM tool surface | 121 tools (`ToolName` enum, verified count) + 41 exec resources behind them | 98 tools, all dispatched | **behind (taxonomy)** |
| Flat tool family | `pi*` — 7 tools (`piBash/piEdit/piFind/piGrep/piLs/piRead/piWrite`), truncation-aware results, dual tool-call/exec protos | absent (namespace difference only) | **behind** |
| Approval channels | 5 independent channels: local-tool, auto-review, connector-grant, credential-request, virtual-card | 3: confirm overlay, standing consent grant, auto-review (regex) | **behind** |
| Card taxonomy | 30 send-message + 12 event + 6 other = **48 card kinds** | 4 approval cards + 1 plan card | **behind** |
| Renderer architecture | 19 bounded contexts (`{members, ports, lifecycle}` hexagonal), 130 recovered feature source paths, 32 MB bundle, StyleX (5,787 `ui-*` classes, 1,361 CSS vars), TanStack Query | 17 files, 6,871 LOC, one 2,731-line `main.jsx`, hand-rolled CSS | **far behind** |
| Rich text | TipTap v3 + markdown ext, mention/skill/emoji/canvas/PR atoms, RTL, KaTeX, Mermaid (29 diagram types), Shiki (~70 grammars), real diff view | Hand-rolled markdown.js (1,094 LOC): math + hand-rolled mermaid + highlighting — real but singular | **behind** |
| Sandbox | seatbelt via **missing** external helper binary → inert locally; `SandboxPolicy` proto rich (`read_boundary`, `network_policy`, `allowlist_escalated`, `capture_denies`, `disable_tmp_write`, shared build cache) | Real SBPL generator + exec daemon + forked host + VZ Linux VM + APFS snapshots; `SandboxPolicy` proto absent | **ahead (enforcement), behind (policy expressiveness)** |
| Secrets | AES-256-GCM sealed files (`{sandSealedFile:1,data}`), key never crosses the coordinator; `safeStorage` + keychain; 1Password via seatbelt launcher | AES-256-GCM vault + `safeStorage` + Touch ID approver | **par** |
| Multi-agent | Rooms with nonce turn ownership, peer injection, `deadline_ms`, `is_winding_down`, nested `parent_request_id`/`root_parent_request_id`; subagent tree with parent+root links | DAG scheduler (Kahn, cycle-safe), blackboard with per-key revisions + audit trail, depth cap 2, concurrency cap 32 | **ahead (planning), behind (conversation protocol)** |
| Test rigor | n/a (binary) | 136 files, 14,460 LOC, **1,908 strict : 3 tautologies** (~600:1) | **ahead** |
| Fail-closed honesty | n/a | 144 of 552 Grok-compat methods fail closed with `{status:'unavailable',scope,reason}` | **ahead** |

---

## 3. Tool-surface comparison

Grok Bot's 121-tool `ToolName` enum versus Quansiox's 98 tools, grouped by intent. "—" = no quansiox equivalent.

| Grok Bot tool family (count) | Quansiox equivalent | Gap |
|---|---|---|
| Shell / AwaitShell / Read / Screenshot / Computer (5) | `shell`, `await_shell`, `read_file`, `computer_screenshot` + 10 more `computer_*` | **ahead** — quansiox has 14 computer tools vs Grok's 2 |
| Files: Write/Edit/Grep/Ls/Glob (5) | `write_file`, `edit_file`, `search_code`, `list_dir`, `glob_files` | par, but no `pi*` flat family |
| Transcript: ReadTranscript / ChatItems / ReadAgentActivity / FetchConnectedActivity (4) | `transcript.mjs` + session APIs (no LLM-facing tool) | **behind** |
| Messaging: SendMessage / SendToUser / SendToAgent / MessageSubagent / CheckSubagent / StopSubagent / WakeParent (7) | `message_subagent`, `check_subagent`, `wake_parent` (3) | **behind** — no peer `send_to_agent`, no `stop_subagent` |
| Agent lifecycle: CreateAgent / UpdateAgent / ConvertToTeam / PublishToTeam / OfferTeamAccess / SetPrimaryBot / CloudAgent (7) | none | **behind** |
| Task/State: CreateTask / ReadTask / UpdateTask / UpdateState (4) | `update_plan` (1) | **behind** |
| Channels: CreateChannel / UpdateChannel / DisconnectChannel / SetSlackStatus / SetUpSlack / OfferSlackConnect / Slack reactions / Teams equivalents (11) | `slack_*` (4), no channels, no Teams | **behind** |
| Email: SendEmail / ReadEmailThread / SearchEmailThreads / ReadEmailAttachment / ListEmailInboxes / ClaimEmailInbox / CheckEmailInboxAvailability (7) | `email_send`, `email_search`, `email_status` (3) | **behind** |
| iMessage: SendIMessage / SearchIMessages / FindIMessageChats / FetchIMessageAttachment / IMessageActivity / CheckIMessagePermissions (6) | `messages_send/read/search/chats/status` (5) | near par |
| Calendar/Meetings: MobileReadCalendar / DraftCalendarInvite / FindMeeting / ListMeetings / GetMeetingSummary / ReadMeetingLines / ReadMeetingTranscript / JoinMeeting / LeaveMeeting / RespondInMeeting (10) | `meeting_copilot` (1) | **far behind** |
| Documents: ListDocuments / ReadDocument / WriteDocument / WriteDocumentAsset / ListSections (5) | `save_document`, `list_documents`, `read_document`, `append_document` (4) | par |
| Canvas: EditCanvas (1) | `create_artifact` / `update_artifact` (2) | par — different name |
| Memory: UpdateMemory / RecallMemory / SortMemories (3) | `remember`, `recall` (2) | near par |
| Skills: Skill / UpdateSkill / ProposeSkills / ProposeCarryOver (4) | `list_skills`, `use_skill` (2) | **behind** — no propose/carry-over |
| Plugin/MCP: InstallPlugin / UninstallPlugin / GetPlugin / SearchPlugins / AddMcpServer / RemoveMcpAccount / RenameMcpAccount / AuthenticateMcpServer / GetMcpServerStatus / SetMcpInstructions / RestartMcpServers / UninstallMcpServer (12) | `mcp__<server>__<tool>` dynamic only | **far behind** — no marketplace-side tools |
| Secrets: ListCredentials / ListAvailableSecureValues / FillCredential / GetCredentialProviderStatus / RequestOnePasswordConnect / SetOnePasswordPreference (6) | `onepassword_list/read`, `submit_secret`, `request_secret` (4) | **behind** |
| UI: RequestUserForm / RemapUserFormTargets (2) | `request_user_input` (1) | near par |
| Web: WebFetch / WebSearch (2) | none | **behind** |
| Payments/Telephony: RequestVirtualCard / place_phone_call (2) | none | **behind** — see §6 for the local-first substitute |
| Other: FindContacts / SetUserAttribute / UpdateProfile / UpdateAvatar / UpdateAppHome / UpdateRoutine / DownloadFile / UploadFile / ReactToMessage / CreateBotShareJson / SearchBotTemplates / RequestScmConnect / RequestCookieOriginApproval / BrowserSecureFill / ListMachines / CheckSubscriptionUsage / SendFeedback / request_box_help (18) | partial via coordinator/host APIs | mixed |

**Net:** quansiox has **better** computer-use depth (14 vs 2 tools) and **equal-or-better** file/shell/iMessage/Document coverage, but is missing the entire **agent-lifecycle, channel, meeting, plugin-management, task-state and web** families — i.e. the surface that makes Grok Bot a *team workspace* rather than a *chat client with tools*.

---

## 4. Protocol comparison

| Capability | Grok Bot | Quansiox |
|---|---|---|
| Request idempotency | `clientNonce` + `x-sand-mint-dedupe` header, single retry only when the POST never started | absent |
| Deadline policy | Named policies: `gateway-send-post` 15 s, `gateway-sse-connect`, `gateway-sse-stall` idle watchdog, `local-exec-heartbeat` 10 s, `local-exec-sse-stall` 35 s, `local-exec-data-post` 120 s | per-call timeouts only |
| Retry taxonomy | `ok / refused / timeout / http_5xx / dns / no_storage / access_denied / box_blocked / network / pod_hibernated`; non-retryable set; pre-dispatch retryable set | generic 3× backoff with `Retry-After` at the provider layer |
| Backpressure | `demand` scheduler: every RPC tagged `person` vs `background`; background reads deprioritised and droppable | none |
| Network diagnosis | 4-way DNS diagnosis (system / independent / wildcard `*.cursorvm.com` / `api2.cursor.sh`) → 8 diagnoses | `netDiagnosticsService` — DNS + TCP probes only |
| Transcript durability | `generation` epoch + `seq` + `updated_seq` + `after_updated_seq` cursor; `GrokBotTranscriptCursorTooOld` forces full re-read; `GrokBotTranscriptWatchCleared` signals reset | append-only per-session JSON; no epoch, no cursor invalidation |
| Blob store | content-addressed with `etag`, `if_match_etag`, `expect_absent`, multipart parts | plain files under `userData/` |
| Sealed files | `{sandSealedFile:1,data:base64(iv‖tag‖ciphertext)}`, AES-256-GCM, key sealed by main so it never crosses the coordinator | AES-256-GCM vault, 0600 key file |
| Streaming | SSE `{channel,payload}` frames; `x-sand-slim-avatars`; `traceparent` propagation | SSE provider stream only; internal events are MessagePort |

---

## 5. Renderer surface comparison

| | Grok Bot | Quansiox |
|---|---|---|
| Source files recovered | 130 (`src/electron-renderer/features/…`) | 17 (`src/renderer-src/*`) |
| Bounded contexts | 19 | 1 (a single `main.jsx`) |
| Feature slices | 62 `chunk-view-*` | ~16 |
| Card kinds | 48 | 5 |
| Settings pages | 5 routed overlays (general / computer / vault / usage / updates) | 1 inline panel + 1 legacy vanilla dialog (7 tabs) |
| Feature gates | 78 Statsig gates | local `flagsService` |
| Dead renderer code | none observed | `src/renderer/app.js`, 1,363 LOC, referenced by no HTML or build script |
| IPC namespaces consumed by UI | all of `main` (327 exposed) | 42 of 68 namespaces; **182 of 370 methods reachable (49 %)** |
| Component tests | — | **0** (no jsdom / testing-library; devDeps are `electron` + `esbuild` only) |

Grok Bot's card taxonomy, for reference — the taxonomy quansiox must match to be usable as a workspace rather than a chat box:

- **send-message (30):** `text`, `attachment`, `widget`, `cursor-agent`, `secret-request`, `credential-request`, `user-form`, `email-draft`, `slack-draft`, `meeting-chat-draft`, `calendar-event`, `permission-request`, `connector`, `connectors`, `listener-connect`, `scm-connect`, `onepassword-connect`, `team-access`, `slack-connect`, `bot-template-share`, `auto-review-approval`, `meeting-join-consent`, `connector-grant`, `local-tool-permission`, `virtual-card-approval`, `cookie-origin-approval`, `publish-approval`, `app-secrets-request`, `mobile-tool-permission`
- **event (12):** `name-changed`, `channel-connected`, `channel-disconnected`, `automation-changed`, `task-changed`, `team-shared`, `team-bot-publish`, `person-added`, `person-removed`, `person-left`, `bot-added`, `bot-removed`
- **other (6):** `message`, `user-attachment`, `mcp-app`, `notice`, `feedback`, `voice-call`

---

## 6. Where quansiox is already ahead — do not regress these

These are frontier capabilities the reference build does **not** actually have, and they must be protected while the parity work proceeds.

| # | Quansiox advantage | Evidence |
|---|---|---|
| D1 | **Real local sandbox enforcement.** Deny-by-default SBPL, network opt-in, cloud-metadata IP blocking, workspace write confinement, escape test in CI. Grok Bot's shipped build has **no working local sandbox** (`Vkt` never assigned → `insecure_none` or `SandboxUnsupportedError`). | `src/exec-daemon/seatbelt.js:40`; `test/seatbelt.js:38-49` |
| D2 | **Kernel-level guest isolation + snapshots.** VZ Linux guest with APFS-clone take/restore/branch. Grok Bot has `box-disk-pressure` and `requestDiskSaverAudit` — pressure management, not isolation. | `src/main/services/vmSnapshotService.js`, `src/main/services/desktopVmService.js` |
| D3 | **Test rigor.** 1,908 strict assertions vs 3 tautologies across 14,460 LOC. | `test/` census |
| D4 | **Provider breadth.** 6 hand-rolled wire protocols with Anthropic prompt caching, Gemini functionDeclarations, incremental tool-arg reassembly. Grok Bot's client makes **no** LLM call at all — inference is entirely server-side. | `src/coordinator/providers/index.js` |
| D5 | **Planning primitives.** Kahn-based DAG with cycle-safe degradation + dependency-context injection, and a blackboard with per-key revision counters, bounded append history, depth/size normalisation and an append-only audit trail. Grok Bot has **no blackboard and no DAG** — only markdown-bodied `AgentWorkflow`s and server-side rooms. | `src/coordinator/teamDag.js:52`, `src/coordinator/blackboard.js` |
| D6 | **Signed first-party extensions.** Ed25519-signed addons that publish skills + MCP servers. Grok Bot's marketplace is server-side and unsigned locally. | `src/main/services/addonService.js:212` |
| D7 | **Honest fail-closed compat.** 144 of 552 Grok-compat methods return `{status:'unavailable', scope, reason}` and are asserted to. No fake success anywhere. | `src/main/services/grokCompat/grokCompatService.js:49` |

---

## 7. Verified defects in quansiox (code-verified, not doc-asserted)

| # | Defect | Evidence |
|---|---|---|
| **X1** | **Permission model is inert in a default install.** `let policy = { permissive: true }` is only replaced when `process.env.TYPESAFE_API_KEY` is set; `guardToolCore` returns `null` for any permissive policy; `toolsForPolicy` then returns all 98 tools. Allowlists, `read-only`/`workspace`/`computer` modes and fan-out caps are code that never executes. | `src/coordinator/index.js:3330`, `src/coordinator/jev.js:154`, `src/coordinator/permissions.js:50` |
| **X2** | **Auto-review is a substring/regex matcher, not a classifier** — and it is only consulted when `requireApproval === true`, which defaults to `false`. Doubly inert. | `src/coordinator/autoReview.js:20`, `src/coordinator/index.js:2468`, `src/main/services/settingsService.js:69` |
| **X3** | **`speculate()` throws `ReferenceError`** — the non-worktree verification path references an out-of-scope `cwd` (a local of `run()`). The error is swallowed, so `row.verified` is permanently `false` on that path. | `src/coordinator/index.js:2413` vs `speculate()` at `:2368` |
| **X4** | **Egress allow-list never reaches the kernel.** `policy.allow` is never consulted; `hostAllowed` / `filterHosts` are called only from a test; `seatbeltProfileWithPolicy` is exported but never called and admits the limitation in its own body. | `src/coordinator/egressPolicy.js:111`, `src/main/services/execService.js:119` |
| **X5** | **`computerPool.setFactory()` is never called in production** → `acquire()` always throws `computer pool has no factory`. The per-child guest-isolation mechanism is written, unit-tested against an injected factory, and permanently unreachable. | `src/main/services/computerPool.js:12,25` |
| **X6** | **`build-native.js` omits `QuansioxVaultApprover`** → a clean `npm run native` produces no Touch ID gate binary and the vault gate silently falls back. | `scripts/build-native.js:18` vs `scripts/package.js:169` |
| **X7** | **`write_file` bypasses `writeFileSafe`** — `edit_file` writes atomically (temp + rename), `write_file` uses bare `fs.writeFileSync`. | `src/coordinator/index.js:3139` |
| **X8** | **Dead renderer** `src/renderer/app.js`, 1,363 LOC, referenced by no HTML file and no build script. | `src/renderer/index.html`, `scripts/build-renderer.js` |
| **X9** | **`QuansioxVaultApprover` returned `exit=0` (approved) from a non-interactive shell** with no visible prompt — `LAContext.evaluatePolicy` can succeed without a presented UI when no biometrics are enrolled. The gate may not gate. | direct execution of `build/QuansioxVaultApprover` |
| **X10** | **26 of 68 IPC namespaces are unreachable from the React renderer**, including every user-facing one: `mcp`, `meeting`, `onePassword`, `voiceCall`, `agentFiles`, `agentPlugins`, `canvas`, `hostPrefs`, `flags`, `webhooks`. | namespace cross-reference of `api.<ns>.<method>` against `src/renderer-src/**` |
| **X11** | **Stale surface claims** — `grokCompatService.js:4` claims "280 desktop methods and 133 coordinator commands" (413); the real catalogue is **552** (408 local / 144 stub). `namespaces.js:591` still says the VM adapter has not landed. | direct enumeration |
| **X12** | **`team` tool schema omits `depends_on`** — `normalizeAgents` reads it so the DAG works, but the public JSON schema does not advertise it, so the model cannot reach it. | `src/coordinator/index.js:848` vs `src/coordinator/teamDag.js:27` |

---

## 8. Method notes and limits

- All Grok Bot findings come from the shipped bundles; **no source maps exist**, so original module paths were recovered only where they survived (renderer Vite chunk comments, 130 paths) — the main-process bundles are fully minified with no path mapping. The reconstructed `@anysphere/*` package tree is inferred from `package.json` workspace deps, protobuf package prefixes and `Symbol.for("@anysphere/...")` registrations, not from literal source paths.
- The **121** tool count was verified by extracting the `ToolName` enum from `local-exec-daemon/main.cjs` (verified it contains `Shell`/`Read` but **not** `Write`/`Grep`/`Ls`/`Edit` — the write family lives in the `pi*` executors and the exec protocol, not the LLM tool enum).
- Quansiox findings were confirmed by reading source **and** by running its own test suite (`npm test` → exit 0; 104 files print `ALL OK`) and by executing the native helpers directly.
- The reference app's **server-side** behaviour (Cursor cloud, `cursorvm.com` boxes, real marketplace, real Slack/Teams/OnePassword installs) was **not** exercised — only the shipped client contracts. Quansiox's own cloud-shaped surfaces were likewise not exercised against live services.
- **Not assessed:** visual pixel parity, model output quality, live-provider behaviour, and signed-in flows for either product.
