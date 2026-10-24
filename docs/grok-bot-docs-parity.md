# Grok Bot documentation parity review — 17 October 2026

Product-spec parity of Quansiox against the **complete Grok Bot documentation**
(`https://docs.x.ai/grok-bot/overview`, all 22 pages, fetched 2026-10-17):

overview · get-started · use-cases · bots · chat-and-collaboration ·
computer-and-apps · skills-routines-and-automations · files-and-results ·
approvals-security-and-privacy · settings-and-notifications · team-bots ·
teams-and-enterprises · security · security-faq · mobile · tag-on-x ·
troubleshooting · computers · private-networks · proxies · deployment ·
identity-and-access.

Method: each documented, user-visible behavior was checked against the
Quansiox source (`src/renderer-src`, `src/renderer`, `src/main`). Statuses:
**Verified** = behavior exists and was exercised in this or previous reviews;
**Partial** = real implementation with named gaps; **Missing** = no
implementation found; **Local analog** = Quansiox implements the user goal
locally instead of the cloud mechanics; **Honest-N/A** = cloud/vendor surface
that Quansiox reports unavailable rather than faking (project policy).

This review supersedes the docs-scope of `parity-review-2026-10-05.md`;
runtime findings there (VM, browser, delegation) remain valid.

## Summary matrix

| Doc page | Documented behavior | Quansiox status |
| --- | --- | --- |
| overview | Persistent named Bots, shared computer, parallel work | Local analog: sessions + sandbox per session |
| get-started | First-run flow, create Bot, first task, sign-in handoff | Partial: **three-step first-run wizard (welcome → workspace → bot profile) + starter cards (v2.63)**; sign-in handoff is N/A locally |
| use-cases | Role templates / starter prompts | Partial: 4 starter cards on empty state |
| bots | Create / edit / duplicate / pin / hide / share / delete / memory | Partial: create/duplicate/pin/hide/rename (v2.54) + conversation details (v2.55); **edit profile done (v2.62)**; **share via local template JSON export/import (v2.63)**; remaining: true cloud sharing |
| chat-and-collaboration | Mentions, replies, reactions, threads, drafts, voice, group chat, handoffs, shortcuts, palette | Partial: `/` and `@` exist, drafts, **palette (⌘K) + session shortcuts (v2.51)**, per-session run queue (v2.53), **voice dictation ⌘D / memos / voice chat (v2.58)**, **replies + reactions + redirect in-flight work (v2.59)**, **cross-conversation search: messages/files/links/routines (v2.60–v2.61)**, **local group chats 2–6 bots with mentions (v2.62)**, **reply threads with per-message counts (v2.63)** |
| computer-and-apps | Watch computer, takeover, sign-in persistence, recover/update/reset | Partial: live view + host browser + **Take over / I'm done, Recover, Reset (v2.57)**; Update-Bot's-Computer N/A (image ships with app) |
| skills-routines-and-automations | Skills, teach-by-demo, routines with schedules/test/run-history, event triggers | Partial: skills + automations + cron + webhooks exist; **routine Test run + run history done (v2.62)**; teach-by-demonstration now has a native capture UI (v2.62); **routine step editing done (v2.63)**; remaining polish is live teach-capture verification (permission/hardware-gated) |
| files-and-results | Attachments (6 max, size caps), previews, result cards | Partial: attach + chips + transcript cards; **in-app image/PDF/audio/video previews + open-in-default-app (v2.62)** |
| approvals-security-and-privacy | Allow once / Always allow / Deny, expiry, auto-review rules, secret requests, local-execution policy | Partial: confirm overlay with Always allow + countdown (v2.52), standing grants + Security pane, **auto-review rules (v2.56)**, **secret-request + form cards (v2.62)**, **expired-state copy (v2.63)** |
| settings-and-notifications | General/Appearance/Language/Timezone, Auto-review, Computer, Usage, Updates; per-Bot notifications | Partial: Provider/General/Agent/Desktop/Integrations/Updates/Security (**v2.56**); per-conversation notifications (v2.55); **per-Bot memory scope done (v2.62)** |
| team-bots | Team bots, managers, Slack app | Honest-N/A (no team backend); marketplace approximates sharing |
| teams-and-enterprises | Admin dashboard, Team Setup/Secrets, SCIM, audit, OTel | Honest-N/A (cloud admin surface) |
| security / security-faq | Isolation, network policy, Auto Review, action recording, local execution | Partial: per-session sandbox isolation + auto-review service exist; network policy/audit/recording are cloud |
| mobile | iOS/Android app | Honest-N/A (desktop app) |
| tag-on-x | @bot on X | Honest-N/A (cloud) |
| troubleshooting | Least-destructive recovery order, request IDs, support bundle | Partial: diagnostics; **Recover before Reset ordering + request-ID notice stack (v2.57)**, **local redacted support bundle (v2.63)** |
| computers | Recreate/terminate fleet ops | Honest-N/A (cloud admin) |
| private-networks / proxies / deployment / identity-and-access | Enterprise network + IdP ops | Honest-N/A (cloud / org infra) |

## Per-page findings (user-visible scope)

### bots
- Session rows (`src/renderer-src/main.jsx`) show avatar/title/time and
  hover actions (playback, browser, popout, delete). v2.54 adds the
  documented sidebar management: **Pin** (pinned-first order, pin glyph),
  **Hide / Unhide** with a collapsible **Hidden (n)** section, **Rename…**
  dialog, **Duplicate** (transcript copy, “(copy)” suffix), plus the v2.51
  **Mark read/unread** context menu. Edit Profile DONE (v2.62): name/label/description persist per session
  (avatar already existed). Per-Bot memory scope DONE (v2.62). Still missing:
  share (local analog: duplicate).
- Memory exists (Memory panel, `memoryService`) — partial vs per-Bot memory.

### chat-and-collaboration
- Present: rich composer with `/` commands and `@` file mentions
  (`Composer.jsx:75`), attachments with chips, stop button, `⌘F` find,
  `⌘.` panels, per-conversation drafts (`sessionExtras.saveDraft/getDraft`,
  `main.jsx:425`), **⌘K command palette + ⌘⇧F session search** (`Palette.jsx`),
  **session cycling ⌘1–9 / Alt+↑↓ / Ctrl+Tab**, **⌘[ / ⌘] history** (v2.51).
- Voice DONE (v2.58, `voiceService` grew real STT/TTS): **dictation ⌘D** (mic
  button; MediaRecorder → `afconvert` → `whisper-cli`, honest-unavailable),
  **voice memos** (Speak on assistant messages, single playback), **voice
  chat** (auto-play finished replies), per-session voice + speed in the
  details drawer.
- Replies + reactions + redirect DONE (v2.59): hover **Reply** with a quoted
  composer chip, quote block in the transcript and jump-to-parent flash
  (`replyTo` persisted on the turn; legacy transcripts backfill `msg_*` ids);
  hover reaction picker (👍 ❤️ 😂 🎉 👀 ✅) with persisted toggle chips and
  cross-window sync; **Send now** on the Queued chip promotes + aborts
  (redirect) so a direct message takes priority. Group chats / threads remain
  the team-feature gap.
- Find prior work DONE (v2.60–v2.61): the `⌘K` palette queries
  `sessions.searchMessages` across every conversation (user + assistant text,
  newest first, bounded, ±60-char snippets); picking a hit switches sessions
  and jumps to the message with the flash highlight (title hits anchor to the
  last turn; dead anchors warn). Workspace files matching the query appear in
  a Files group and mention into the composer (`@path`). Links
  (`sessions.searchLinks`: http(s) URLs extracted from conversations, deduped
  globally newest-wins) open via the in-app browser policy; routines
  (automations) reveal + flash in the sidebar's Automations surface.
- Group chats DONE (v2.62): group sessions with 2–6 member bots, @mention
  routing, per-member transient turns and authored replies. Remaining:
  steering by plain
  message content (redirect is the explicit affordance — docs' "Stop now"
  maps to the Stop button).

### attention & notifications
- v2.51: sidebar **unread dot (persisted) + working spinner**, right-click
  **mark read/unread**, **dock badge** (`system.setBadge`), **OS notification**
  on finish/needs-input while unfocused, click focuses + opens the session
  (`system.notify` + `navigation:navigate`), and mark-all-read via palette.
- Per-conversation notification switch DONE (v2.55): `session.muted` toggles
  in the details drawer (⌘⇧I); `useAttention` skips OS notifications for
  muted conversations, unread dots unaffected.
- Notice stack DONE (v2.57): above-composer notifications with per-notice
  dismiss, Clear all, and copyable request IDs (`req_*`), raised on failed
  runs and fail-closed approval timeouts.

### keyboard shortcuts (documented list → status)
| Shortcut | Status |
| --- | --- |
| `⌘K` palette | Done (v2.51; sessions/actions — **messages, files, links, routines across conversations since v2.60–61**) |
| `⌘⇧F` search bots | Done (v2.51) |
| `⌘N` new bot/chat | Verified (appMenu) |
| `⌘F` find in chat | Verified |
| `⌘B` compact sidebar | Verified |
| `⌘I` / `⌘L` focus prompt | Done (⌘I; `⌘L` v2.58) |
| `⌘⇧I` conversation details | Done (v2.55) |
| `⌘1–9` bots | Done (v2.51) |
| `Alt+↑` / `Alt+↓` prev/next | Done (v2.51; logic verified, raw Option+Arrow untestable in harness) |
| `⌘[` / `⌘]` back/forward | Done (v2.51) |
| `Ctrl+Tab` cycle | Done (v2.51) |
| `⌘⇧M` / `⌘⇧W` connect apps | Done (v2.59; opens Settings → Integrations) |
| `⌘⇧,` bot settings | Done via conversation details (v2.55/v2.56) |
| `⌘⇧I` / `⌘⌥B` conversation details | Done (v2.55; `⌘⌥B` bound v2.56) |
| `Enter` send / `⌘↵` send anywhere / `⇧↵` newline | Verified |
| `⌘D` dictate | Done (v2.58) |
| `⌘,` settings | Verified (appMenu) |
| zoom / fullscreen | Verified (native roles) |

### settings-and-notifications
- Settings dialog has 7 panes: Provider, **General**, Agent, Desktop,
  Integrations, **Updates**, **Security**. v2.56 adds the documented sections:
  **Appearance** (Match system / Light / Dark, live system-follow),
  **Language** (date/number formatting; English-only interface stated
  honestly), **Timezone** (IANA list, applied to details timestamps),
  **Usage** (aggregate tokens/requests/cost via `settings.usageSummary`),
  **Updates** consolidation (version + feed + check/install), and
  **Auto-review rules** — allow/block rule lists that really gate the
  coordinator approvals (`src/coordinator/autoReview.js`; block wins,
  `/regex/` supported; unit + smoke integration tested).
- Execution-on-local-computer policy maps to existing Agent-pane controls:
  `allowComputerUse` + `requireApproval` (approvals gate) + sandbox mode.
- Remaining: per-Bot memory granularity.

### computer-and-apps & troubleshooting
- Computer panel shows live host/guest state, honest labels, browser view.
- **DONE (v2.57):** **Take over / I'm done** control handoff (global
  `controlHandoff` flag; agent computer actions refused with `USER_TAKEOVER`;
  affordance in the mid-run banner + dock "This Mac" card; event-synced),
  **Recover computer** (helper `restart()` + guest desktop/sandbox stop with a
  per-part report), **Reset computer** (confirm dialog; removes only
  `sandboxRoot(sessionId)`), and the **request-ID notice stack** above the
  composer (`noticeService`, `system:onNotice`; raised on failed runs and
  fail-closed approval timeouts; copy/dismiss/clear).
- Remaining: **Update Bot's Computer** stays honest-unavailable (the guest
  image ships with the app version — no update channel), per-session rather
  than global hand-over granularity (the host Mac is a single machine).

### approvals-security-and-privacy
- Confirm overlay: Allow once / **Always allow** / Deny, with live auto-deny
  countdown and command/path detail (v2.52). Standing grants are honored by
  the coordinator gate (deny blocks unconditionally; allow skips the prompt)
  and listed/revocable in **Settings → Security** (v2.52).
- Secret-request masked-input card and form cards DONE (v2.62). Still
  missing: background-approval **expiry state** copy when the deadline passes
  mid-prompt (the countdown exists).

## Implementation plan (newest first)

1. **Navigation & attention batch — DONE (v2.51):**
   command palette `⌘K` with sessions/actions (message search beyond active
   session DONE v2.60 via `sessions.searchMessages` + palette Messages group); `⌘⇧F` sessions search; session switching shortcuts
   (`⌘1–9`, `Alt+↑/↓`, `Ctrl+Tab`, `⌘[`/`⌘]`); per-conversation drafts
   (already existed — verified); sidebar unread/working states with mark
   read/unread; dock badge + OS notification on turn completion. Also fixed
   `agent:onConfirm` missing its sessionId (approval overlay never armed).
2. **Conversation batch:** replies, reactions, queued messages UI (DONE —
   v2.53 per-session run queue with onQueued/onRunStart + Queued chips),
   Always-allow rule save + background approval expiry.
   - *Approval half DONE (v2.52): Always-allow standing grants (session/global,
     honored by the coordinator gate), auto-deny countdown, Settings →
     Security pane with revoke.*
    - *Queue half DONE (v2.53): per-session FIFO (`runQueue.js`), real events,
      composer send-while-running, tested end to end. Replies, reactions and
      steering DONE (v2.59): reply quotes + jump, reaction chips, and
      redirect via Send now (`runQueue.promote` + abort).*
3. **Bot management batch:** pin/hide/hidden section, rename, duplicate,
   edit profile (label/description/avatar), conversation details pane
   (⌘⇧I) with per-Bot notifications.
   - *Sidebar half DONE (v2.54): pin (pinned-first order + glyph), rename
     dialog, duplicate (`sessions.update`/`sessions.duplicate`), hide/unhide
     with a Hidden (n) section. Verified via captured runs incl. ⌘1 ordering.*
   - *Details half DONE (v2.55): ⌘⇧I / palette / topbar drawer with session
     metadata, activity stats, usage + cost, per-conversation notification
     mute (`session.muted`, honored by `useAttention`). Verified end to end.*
   - *Remaining: edit profile stays N/A for local transcripts (no persistent
     Bot profiles — honest gap).*
4. **Settings batch — DONE (v2.56):** General pane (Appearance/Language/
   Timezone/Usage), Updates pane consolidation, Auto-review rules with a real
   coordinator gate (`autoReview.js`); execution-on-local-computer policy maps
   to the existing Agent-pane controls (allowComputerUse/requireApproval/
   sandbox mode).
5. **Computer batch — DONE (v2.57):** Take over / I'm done (global handoff
   refusing agent actions with `USER_TAKEOVER`), Recover (helper restart +
   guest/sandbox stop) and Reset (confirm dialog; removes only the session
   sandbox tree) controls, and the above-composer notice stack with copyable
   request IDs (raised on failed runs + fail-closed approval timeouts).
   Update-Bot's-Computer remains honest-unavailable (image ships with the app).
6. **Voice batch — DONE (v2.58):** dictation (`⌘D`) through the local
   whisper chain (honest-unavailable with reasons), voice memo playback on
   assistant messages, voice chat auto-play, per-session voice + speed in
  the details drawer; `test/voice-stt.js` drives a fake whisper CLI
    (arg shape, transcript pickup, cleanup).
7. **Chat collaboration batch — DONE (v2.59):** reply-to-message (quoted
   composer chip, transcript quote block, jump-to-parent flash, `replyTo`
   persisted; per-message `msg_*` ids with lazy backfill), reactions (docs'
   six-emoji set, persisted toggle chips, cross-window sync, allowlist), and
   redirect in-flight work (Queued chip → **Send now** promotes + aborts via
   `runQueue.promote`), plus the docs' Connect-apps shortcut `⌘⇧M`/`⌘⇧W`
   opening Settings → Integrations. `test/chat-collab.js` covers ids,
   replyTo, reactions, and queue promote.
8. **Find prior work batch — DONE (v2.60–v2.61):** `sessions.searchMessages`
   (cross-conversation substring search over user/assistant text, bounded,
   ±60-char snippets, id anchors for jump-back, min 2 chars) feeds a Messages
   group in the `⌘K` palette with match highlighting and flat keyboard nav;
   picking a hit switches sessions and flashes the target message (title hits
   anchor to the last turn; dead anchors warn). Files group mentions
   `@path` into the composer. Search preserves `updatedAt` (no sidebar
   reorder). Fixed latent suggestion-popup stale-ref clear in
   `Composer.jsx`. `test/search-messages.js` covers hits, ordering,
   multimodal flattening, title anchors, guards, and recency.
   - *Links + routines half DONE (v2.61):* `sessions.searchLinks` extracts
     http(s) URLs from conversations, deduped globally newest-wins, opened
     via the in-app browser policy; routines group searches automations and
     reveals + flashes the row in the Automations surface (opens ancestor
     `details`). `test/search-links.js` covers extraction, trimming, dedupe,
     anchors, guards.
   - Remaining honest gaps: group chats, per-Bot memory granularity.
