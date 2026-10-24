# Grok Bot 0.75.0 vs Quansiox — Codebase-to-Codebase Parity Analysis

Date: 2026-10-23 · Method: static RE of `Grok Bot.app` (asar extracted to `work/grok-re/asar-extracted/`,
fully enumerated against `/Users/mohsin/manux/quansiox` source). No documents were used — every comparison below
cites extracted app code or Quansiox source.

## 1. Target identification (RE intro)

| Fact | Value | Evidence |
|---|---|---|
| Product | Grok Bot desktop agent, internal codename **"sand"** | `Info.plist` CFBundleIdentifier `com.anysphere.sand`; theme CSS `sand-*` |
| Vendor | Anysphere (package name `"sand"`, author "SpaceXAI", homepage cursor.com) | `asar-extracted/package.json` |
| Version | 0.75.0 (asar integrity hash `6c46273c...`) | Info.plist |
| Bundler/runtime | Electron + rolldown, react-compiler + Lingui + StyleX + TipTap + dnd-kit + mermaid/katex/pdfjs/xlsx | `asar-extracted/package.json` deps |
| URL schemes | `grokbot://`, `sand://` (authority `app`), deep links via `cursor.com/grok-bot/link` | main-app.cjs |
| Custom protocols | `sand-avatar:`, `sand-favicon:`, `sand-media:`, `sand-html-preview:`, `sand-canvas:`, `sand-mcp-app:`, `sand-visualization:` + `https://grok.com` in CSP | `renderer/index.html` |
| Backend services (protobuf, `aiserver.v1`) | AiService, GrokBotService, SandBoxService, AgentStoreService, BackgroundComposerService, DashboardService, AnalyticsService | `dist/electron-main/proto.cjs` typeName exports |

Extraction assets: `work/grok-re/case/` (asar-extract.js, proto-exports.txt = 273 exported proto types,
grok-hostapi-manifest.txt, grok-hostapi-methods.json = 22 domains/141 bridge methods, grok-tools.txt 156
ActionNames, tokens-missing.txt 660, tokens-extra.txt 204, grok75-classes.txt 9,259 selector names,
grok-renderer-inventory.md, quansiox-inventory.md).

## 2. Side-by-side architecture

| Layer | Grok Bot 0.75.0 | Quansiox 0.1.0 | Verdict |
|---|---|---|---|
| Window IPC | `coordinatorPort` MessagePort + `cak`-style domain manifest (`window.desktop.<domain>.<method>`); raw channels `sand:coordinator-port[-request]`, `entry:*` | Namespaced registry over 6 raw channels (`quansiox-ipc-*`); 84 namespaces/~546 handlers | Architectural equivalent — re-route not needed |
| Agent brain | remote AiService/GrokBotService (proto.cjs) + local node-agent-coordinator (1.06MB cjs) + voice-call-harness + local-exec-daemon (3.8MB cjs) | forked coordinator child (JSON messages), 6 provider protocols, 138 tools | Equivalent shape; protocol-compat gap at proto layer ( nei-stubs) |
| Tool surface | **152-ish ActionName enum** (PascalCase; `Computer Read Screenshot Shell Skill Vault` base set + device/IOS/Mac/Mobile/Slack/Teams/Meetings/MCP/emails) | 138 snake_case tools; ~24 name-equal | Tool contract needs formal mapping (unmapped 132 in `tools-unmapped.txt`) |
| Sandbox | cloud "box" + colocated VM (foreverBox, `machine-shell` device tools) | bare-node computer + Alpine VM (VZ, virtiofs, vsock, RFB+CDP+agent, CoW snapshots) | Quansiox ahead in local-first; Grok ahead in device fleet/cloud |
| Design layer | 1,824 custom props + 9,259 class names (3,510 `sand-*`, hashed StyleX + `ui-*` utilities), fonts XVF/XMono/cursor-icons/SF~Pro | grok-tokens.css from **0.71.2** (1,368 props), 53→225 semantic recipes, **no fonts** | **FAR from 100%**; drift quantified below |
| i18n | Lingui, 36 locales (emoji-only translations) | none | Missing entirely |
| Tests | (runtime, not needed) | 161 files | — |

## 3. Design/frontend parity — measured gaps (the "100% no deviation" workstream)

1. **Token drift** 0.71.2→0.75.0: `tokens-missing.txt` = **660 props missing** in Quansiox
   (`--ui-*`167, `--cursor-*`120, `--x-* StyleX interop`69, `--sand-*`59, `--rte-*`33, `--conversation-*`24,
   `--shiki/dot/pele` visualization fonts+helpers, `--vscode-*` Monaco hosting 16, tray/tab/pane terminal sets),
   `tokens-extra.txt` = **204 stale names**.
2. **Class/recipe coverage**: Grok ships 9,259 distinct selectors; Quansiox carries 53 hand-commented recipes +
   225 semantic classes with **0 name overlap**. Full-fidelity target = load Grok's serialized component CSS
   verbatim (hash names intact) next to the token layer, then bind Quansiox markup to Grok class names per component.
3. **Fonts**: `XVF` (variable sans), `XMono`, `cursor-icons`, `SF Pro` stacks — no font files in Quansiox at all.
4. **Geometry tokens**: rail 280px `--rail-width` matches; `--sand-window-controls-inset`, pane/scale-layer,
   dot-grid off-opacity, role swatches, tray transforms — present in Grok, absent locally.
5. **Boot shell**: `#sand-boot-shell` splash + `:root:not([data-theme])` transparent pre-theme logic; CSP parity for
   the 7 protocols — Quansiox uses `qx-artifact://` naming instead.

## 4. Bridge/functional parity — measured gaps

1. **Host-API manifest (window.desktop)**: 37 domains declared, 22 backed by 141 typed methods
   (`grok-hostapi-methods.json`). Quansiox's grok-compat catalog (552 methods) covers 137/141 — missing
   `beginSpendApproval`, `createThreadFromMessage`, `dismissAgentSuggestions`, `listVirtualCardPaymentMethods`.
   Store-backed domains beyond the manifest (`desktopWindow`, `theme`, `language`, `time_zone`, `usage`,
   `update`, `hardware_acceleration`, `computerUpgradeSchedule`, `botColorInChat`, `about`, `keyboardShortcuts`,
   `desktop.mouseHistory/scrollGesture/assistiveTech`) are largely unimplemented (hostPrefs has bits).
2. **Voice**: Grok realtime WS w/ subprotocol `xai-client-secret.<secret>` + `?model=`; STT/TTS messages
   (`SttClientMessage/SttServerMessage`), voice memos AAC-in-MP4, voice-call-harness tools, meetings join
   (Meet/Zoom/Teams). Quansiox has realtime voice loop + STT but no xAI subprotocol adapter, no voice
   memos (mp4 codec pipeline), no meeting joining.
3. **Tool contract**: 156-name ActionName enum vs 138 tools; auto-mapped only 24. Missing families: device fleet
   (`ListMachines/MachineShell/CopyTo|FromBox` — iOS/Mac/Mobile/Android messengers/mail/notes/calendar/alarms
   actuation), Slack/Teams own-message deletion + reactions, Meetings (`JoinMeeting/RespondInMeeting/GetMeetingSummary`),
   emails inboxes claim/unavailability, credentials (`FillCredential/ListCredentials/GetCredentialProviderStatus/
   RequestCookieOriginApproval/RequestVirtualCard`), `Visualize`, `ChatItems`, `PlacesSearch/ProductSearch/
   WeatherForecast`, `ProposeCarryOver/ProposeRuleChange`.
4. **Purchase rails**: virtual card + spend approval + Stripe Link + xai-commerce bearer + DeviceCheck trial claim
   (densest drift area, mostly fail-closed locally by design; still needs local-first UX parity for kept flows).
5. **Marketplace/companies**: ~400 connector names + ~25 role templates ("Chief of Staff"…), `browse-model`,
   plugin sync status, native-plugin detail/state views.
6. **Automations**: cron grammar renderer (`weekday-list`, `nth-weekday`, `yearly-date…`), webhook keys/headers,
   SCM trigger catalog (GitHub/Linear/PagerDuty/Sentry/Teams/Webhook) — Quansiox has automations+cron+webhooks but
   not the Grok trigger/grammar surface.
7. **Library/pins/canvases**: library v2, hover cards, pagination pins, shared files w/ vault, memory/cards — partial.
8. **Multiplayer/team**: team bots details/manager/service-accounts/tailnet suffix, group chats `CreateGroup/
   setGroupMembers/room`, carry-over (`ProposeCarryOver`, team-bot-carry-over-plugin-selection), publish/unpublish
   to team/org (CloudAgent flows), XP: q1LJYo "Managed by your team"/verified org.
9. **Onboarding/import**: Chrome logins import (needs the `cursor-proclist`-style native helper), CSV import from
   password managers shown `vmh1dn`, memory import flow, `onboarding-flow` chunk.
10. **Driver features**: media filmstrip viewer (`sand-media:image/32hex`), fullscreen-file-viewer HTML IFrames,
    document-page/sheet/deck app windows, terminal/tray widgets, pr_review.read surface, app home `UpdateAppHome`.

## 5. Quansiox advantages to keep (do NOT regress)

- 161-test suite + W0–W5 hardening (governance ladder, no-raw-colors enforcement, event cursors).
- Providers hub (OpenAI/Anthropic/Gemini/Ollama/LM Studio + role routing) — superset of Grok's rails.
- Local-first coordinator with fail-closed approval semantics; vault Touch ID; VM/desktop with snapshots.
- check-component-tokens + extract-grok-tokens pipeline — extend, don't replace.

## 6. Verdict

Quansiox ≈ architecture clone with honest fail-closed stubs, but: **design layer 71% token coverage (measured),
0 font files, 0/9.2k class-name parity, 24/156 tool-name parity, 137/141 host-API coverage** — far from "100% no
deviation". The path to parity is a verbatim re-baseline (0.75.0), a serialized-CSS component port, and a
tool-contract translation layer + local-first implementations for the unmapped 132.
