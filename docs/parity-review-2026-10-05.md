# Quansiox competitor parity review — 5 October 2026

Current source and packaged-app findings are updated in [parity-verification-current.md](parity-verification-current.md). Delegation lifecycle and browser isolation have advanced in source since this baseline; the packaged app remains behind.

**Quansiox does not have full feature, function, or design parity with the three supplied applications.** The sidepanel is not a live VM desktop. Delegated tasks execute, but Grok's complete subagent lifecycle is missing. The browser is real host Chromium; its initial automation implementation was broken, and its layout does not match Grok's computer experience.

This review supersedes the previous `parity-inventory.md`. That inventory treated component names, mock tests, and visible DOM placeholders as parity evidence, did not extract Grok, and incorrectly excluded cloud features because Quansiox was described as local-first. Cloud capabilities remain requirements under the user's requested scope.

## Evidence and limits

The supplied bundles were inspected offline. No competitor account, hosted API, or logged-in competitor session was accessed. Only Quansiox was executed, using temporary profiles, loopback HTTP fixtures, and its own Linux VM. Production model quality, remote services, and a pixel comparison against a signed-in Grok window are unverified.

| Application | Bundle identity | Version | Application text files indexed |
| --- | --- | --- | ---: |
| Grok Bot | com.anysphere.sand | 0.66.0 | 536 |
| Manus Studio | im.manus.desktop | 2.0.3 | 899 |
| Cue | ai.manus.agents | 1.0.7 | 732 |

Evidence root: `/Users/mohsin/manux/work/parity-2026-10-05`.

- `bundle-manifest.json`: archive SHA-256, extracted-file SHA-256, bundle identities, signature and native-library inspection.
- `grok-bot/app`, `manus-studio/app`, `cue/app`: freshly extracted application text. Third-party dependencies and media were excluded from this text index.
- `ipc-catalog.json`: 280 Grok desktop methods, 133 Grok coordinator commands, 24 Manus handler namespaces with 234 function-name matches, and 52 Cue preload channels. Counts include infrastructure/telemetry and are not feature counts or parity percentages.
- `grok-preload.readable.cjs`, `grok-coordinator.readable.cjs`: formatted inspection copies.
- `grok-design-tokens.json`: resolved native `sand` theme colors from Grok's shipped theme tables. Only the color tables were evaluated in an isolated JavaScript context.
- Runtime evidence: `delegation-runtime.json`, `browser-runtime-before.json`, `browser-runtime-after-protocol.json`, `browser-runtime-final.json`, `vm-runtime-before.json`, `vm-file-runtime-before.json`, `vm-file-runtime-final.json`, `recording-runtime.json`.
- Validation: `test-final.log`, `browser-final.log`, `vm-final.log`, `renderer-final.log`; visual captures `design-before.png`, `design-after.png`.

Static client contracts establish shipped surfaces and expected operations, not successful server behavior or availability for every account. A client feature may require an independently implemented Quansiox backend. The matrix below groups reviewed capabilities; it is not a claim that every branch of every competitor bundle has been exercised.

## The three requested findings

### F01 — Delegation works, but Grok's subagent experience is incomplete

A real forked Quansiox coordinator called its `task` tool. The child ran the actual child model/tool loop against a local streaming provider fixture and wrote a proof file. The parent received queued/running/completed progress tied to its tool call. A private marker seeded into the parent transcript was absent from the child's requests. Therefore delegation is not merely a roster placeholder.

However, `runChildSession` in `src/coordinator/index.js` runs asynchronous child loops inside the same coordinator process. `toolSession = job.parentSessionId || job.id` routes siblings into the parent's sandbox and browser. Two browser children share the same active tab; computer-use children share this Mac's GUI. There is no computer allocated per child.

Grok's shipped `SubagentArgs` schema explicitly includes `model_id`, `resume_agent_id`, `run_in_background`, `interrupt`, `fork_agent_id`, `selected_context`, `environment`, and `model_parameters`. Its coordinator exposes `getSubagents` and `getAsyncTasks`. These are substantially richer than Quansiox's task schema and summary roster. Grok's environment field alone does not prove that every child receives a separate VM; competitor runtime isolation was not exercised. Quansiox's shared parent browser/sandbox routing is directly established by its implementation.

| Capability | Quansiox finding |
| --- | --- |
| Child model/tool execution | Verified against a deterministic local provider fixture; production provider unverified |
| Built-in roles and custom allowlists | Present; existing permission tests pass |
| Self-contained child context | Verified in the fixture |
| Parent-call association and progress | Verified; summary-level progress only |
| Concurrency queue and background execution | Scheduler implementation exists; background result is pushed as progress |
| Per-child model selection | Missing. The fixture's requested model was ignored; the supported schema has no model selector and the child uses global settings.model |
| Persisted child transcript and reopening | Missing; child messages remain local to the execution loop |
| Resume/fork a specific child | Missing |
| Background await/retrieve API and UI | Missing as a durable user-facing task lifecycle |
| Per-child interrupt control | Internal scheduler abort exists; no individual child stop control in the roster |
| Per-child browser/VM ownership | Missing; siblings reuse parent toolSession |
| Independent worker process per child | Missing; only the coordinator itself is forked |

This is partial delegated execution, not Grok subagent parity.

### F02 — Browser is real, initially broken, and visually incomplete

Quansiox uses Electron `WebContentsView` and Chromium's DevTools protocol. It does load and display a real page. It does not run a browser inside the Linux VM.

The first real Electron test loaded a local page but `browser_snapshot` failed with **Requested protocol version is not supported**. The debugger attached with the string `qx-browser` instead of a supported CDP protocol version. Fixing that exposed a second failure: zero actionable references because the code expected a nonexistent DOM `layoutIndex` mapping and object-shaped bounds. Actual CDP uses `layout.nodeIndex` and `[x,y,width,height]` bounds. The mocks reproduced the incorrect assumptions, so the original suite passed.

After correcting these defects, the real visible browser test proves a Save button changes to Saved, an Email field receives its value, and a snapshot from before navigation is refused. Revision/mutation checks and a single mutation-event listener were added.

A further test showed native input on an unattached or hidden view reports success without changing the page. Quansiox now returns `BROWSER_NOT_VISIBLE` for native pointer/keyboard actions when there is no visible host window. Background/headless input remains a feature gap; this change prevents false success.

Remaining browser gaps:

- Grok's full computer/browser panel interactions, collapse/resizing/persisted geometry, and rich nested task navigation.
- A guest browser sharing the VM's filesystem and desktop.
- Browser-session isolation: WebContentsViews have no separate Electron session partition, so cookies/storage are not isolated per task. The download listener is installed per tab on the shared session.
- Browser profile/cookie/password import, credential flows, richer download handling, certificate/PDF behavior, and pip/viewer lifecycle represented in the competitor clients.
- Reliable unattended native input for background tasks.

### F03 — Linux VM is real; sidepanel desktop is a placeholder

Both the source and original packaged `vm/qx-vm` booted successfully and emitted `QX_VM_READY`. The real adapter returned `Linux` / `aarch64` from the guest and wrote a file through virtiofs. Thus the VM itself is not fake.

`vm/qx-vm.swift` configures one CPU, 512 MB RAM, a Linux bootloader, stdio console, virtiofs, NAT networking, and entropy. It does not configure graphics, keyboard or pointing devices. The guest image provides a shell/file command agent, not a desktop. Quansiox has no guest framebuffer/video stream, remote-display transport, or guest input bridge.

The sidepanel JSX previously rendered a decorative computer card with identity, path, and traffic-light dots. It contained no live guest display. An actual host Chromium child view can occupy the browser viewport, but that is a separate runtime. `computer_*` tools use desktop capture and macOS GUI automation on this Mac, not the guest. Default `sandboxMode: sandboxed` starts a host process sandbox; VM mode is opt-in.

Two further runtime defects were verified and corrected:

1. VM readiness/PID did not appear in `sandboxService.describe/status` because VM instances were absent from its registry. They are now registered and cleared on exit.
2. VM `fs.read`, `fs.write`, and `fs.listdir` all returned `{exitCode,output}`, while the coordinator expected a string, `{bytes}`, and an array of entries respectively. This caused incorrect file results and `entries.map is not a function`. Successful results now match the coordinator contract and failed file operations throw. Empty VM replies also preserve their trailing protocol field, preventing empty files and commands with no output from hanging.

Sandbox startup failures now stop runs and retries instead of silently falling back to raw host tools. Retry also receives the current sandbox descriptor. Mode changes stop the previous runtime. VM startup now checks the initrd, shares an in-flight boot promise, and rejects early spawn/exit failures.

The sidepanel now labels its runtime **Process sandbox · headless**, **Linux VM · headless**, **Host workspace · sandbox off**, or **Chromium · on this Mac**, and states that shell/file sandboxes have no desktop display. This makes the current state truthful; it does not implement the missing desktop.

Remaining VM limitations include the small TSV operation set, guest command cancellation/timeouts, exact preservation of trailing newlines by the guest protocol, complete directory metadata/hidden-file handling, nested write-directory creation, desktop applications, and snapshots/resume. These need dedicated acceptance tests before claiming full file/computer parity.

## Broader feature and function gap register

Status meanings: **Core verified** = a specific local behavior was exercised; **Partial** = useful implementation exists with important gaps; **Scaffold** = surface/state machinery without the advertised end-to-end behavior; **Missing** = no corresponding implementation found in the reviewed Quansiox surface. No row certifies complete equivalence.

Evidence groups: **G** = Grok desktop/preload/coordinator and renderer; **M** = Manus handler registry and related services; **C** = Cue preload, main RPC schemas and generated computer/viewer pages. Exact operation names are retained in the IPC catalog. Backend-dependent features are missing requirements, not excluded from scope.

| Reviewed capability | Competitor evidence | Quansiox status / gap |
| --- | --- | --- |
| Streaming conversation and session history | G/M/C chat surfaces | Core verified locally; production-model behavior unverified |
| Search, rename, delete and export sessions | G coordinator; M agent handlers | Partial local session functions |
| Named/group agents and shared rooms | G createAgent/createGroup/setGroupMembers; C chat surfaces | Missing durable multi-agent conversations; local team tool is a different capability |
| Rich composer and attachments | G stage/resolve/readAttachment methods; M/C composers | Partial file/image attachments; media processing and rich previews incomplete |
| Rich markdown/document previews | G renderer PDF/Word/sheet/math/diagram viewers | Partial text/code rendering; comparable preview coverage missing |
| Provider configuration and profiles | G model/auth contracts; M agent services | Core local settings/profile behavior verified |
| Context compaction and history paging | G transcript window/tail commands; M session APIs | Partial local compaction/windowing; richer history navigation missing |
| Child execution and summaries | G SubagentArgs/getSubagents | Core local child execution verified; F01 gaps remain |
| Background task inspection/retrieval | G getAsyncTasks/continuation schema | Partial scheduler, missing durable inspection/retrieval |
| Child resume/fork/model/environment | G SubagentArgs | Missing |
| Per-child computer isolation | G environment/box contracts | Missing |
| Local shell/file tools | G exec daemon; M computer/terminal services | Core basic execution verified; VM operation coverage limited |
| Agent browser automation | G computer/browser contracts; M WebContentsViewBrowserDriver | Partial; visible local actions verified after repairs |
| Browser native input in background | M driver/supervisor lifecycle; G task/computer contract | Missing; explicit refusal now replaces false success |
| Browser per-session storage isolation | G cookie grants; M browser session lifecycle | Missing Electron partitions |
| Browser import and credentials | G importChromeCookies/origin grants; M browserDataImport | Missing |
| Browser downloads and extended browser UX | G attachment/download methods; M browser handlers | Partial global download directory; richer lifecycle/UI missing |
| Host computer capture/input | M computer-use; G local computer hooks | Partial macOS helper and freshness gating; desktop permissions still required |
| Guest Linux VM | G computer lifecycle; C cloud_pc schemas | Core headless boot/shell/files verified; F03 gaps remain |
| Live guest desktop and guest input | G VNC/box surfaces; M/C screenLive | Missing |
| Unified guest browser/shell/files | G computer environment; C computer view | Missing; host browser, host GUI, guest shell are separate |
| Computer provisioning/rebuild/upgrade | G ensureForeverBox/forceRecreateComputer/upgrade methods | Missing comparable lifecycle |
| Cloud computers, regions and snapshots | C cloud_pc RPC schema and cloud-computer page | Missing; requires Quansiox backend |
| Live remote screen/audio/clipboard/files | C LiveKit viewer; M ScreenLiveViewerWindow | Missing |
| Agent screenshot playback | M/C viewer functions | Partial local screenshot playback; not a live desktop stream |
| Human skill/teach recording | G startTeachRecording/stopTeachRecording; M skillRecording | Scaffold. Record→Finish yields zero steps; no production action-event collector calls note |
| Replay supplied skill steps | M skillRecording/replay | Partial freshness-gated action replay; genuine recording pipeline missing |
| Skill catalog/install/publish/sync | G skill/plugin coordinator commands; M addon services | Missing comparable package lifecycle; custom prompt roles are narrower |
| MCP server tools | G MCP methods; M MCP/browser service surfaces | Partial stdio integration; catalog/auth/accounts/apps/team controls missing |
| Permissions and credential grants | G approve/denyCredentialRequest/local tool grants | Partial static permissions and settings toggles; no comparable consent/credential lifecycle |
| Secure secrets and credential providers | G put/listSecrets/providerOAuth methods | Missing comparable vault/grants; provider keys use settings JSON |
| Persistent bot/user/team memories | G listGrokBotUserBotMemories/promoteGrokBotMemoriesToTeam | Missing |
| Scheduled/webhook/connector automations | G automation/workflow methods | Missing |
| Listener integrations and external channels | G listener, Slack, Messages and email APIs; C IM flows | Missing |
| Voice calls, transcription and voice output | G transcribeAudio/getVoiceCall/previewVoice; M globalVoiceInput | Missing |
| Meetings and recordings | G listMeetings/meetingCensus/leaveMeeting | Missing |
| Document library, canvas editing/sharing | G listLibraryDocs/getDocument/getCanvasShare | Missing comparable library/editor/sharing lifecycle |
| Git/worktrees/PR preview | G SCM/cloud-agent proposal methods; M worktreeRetention/PR services | Partial local Git dock/checkpoints; worktree/PR/cloud workflows missing |
| Terminal lifecycle | M LocalTerminalManager/desktopTerminalManager | Partial terminal; this machine's PTY test used pipes fallback, not a verified real PTY |
| Agent JavaScript and PDF/PNG rendering | M utility/code host; G artifact surfaces | Core local tests pass; richer sandbox/artifact coverage unverified |
| File previews, external app choice and backups | M file handlers | Partial local Files dock; extended workflows missing |
| Account, team, roles, passkeys and sessions | G account/team/passkey methods; C auth bridge | Missing comparable identity backend/UI |
| Billing/wallet/usage entitlement | G usage/billing methods; C billing RPC/return flow | Partial local usage estimates; account billing/entitlements missing |
| Marketplace/shared/published bots | G listPublicBotMarketplace/publishGrokBotAgent | Missing |
| Window lifecycle, notifications, tray/shortcut | G/M/C desktop bridges | Core local tests pass for selected operations; richer window types missing |
| Update staging and restart coordination | G/M/C update bridges | Core fixture tests pass; production distribution feed/install not exercised |
| Presentation, addon frames and devices | M presenter/addon/device services | Missing comparable surfaces |
| Grok theme palette and shell proportions | G native sand theme/layout source | Partially aligned in this review; full interaction/pixel parity unverified |

## Design changes and remaining work

Quansiox previously used a generic dark palette and fixed 240/300 px columns. The review measured the actual native `sand` theme rather than relying on unrelated theme strings bundled with Grok.

| Token | Grok dark | Grok light |
| --- | --- | --- |
| Base background | #070707 | #fcfcfc |
| Subtle/sidebar background | #111111 | #f7f7f7 |
| Elevated background | #181818 | #fcfcfc |
| Primary text | #fcfcfc | #141414 |
| Secondary text | #fcfcfc99 | #14141499 |
| Primary button | #fafafa | #070707 |
| User bubble | #5a5a5a | #070707 |
| Agent bubble | #262626 | #eeeeee |

Quansiox's dark/light token mappings and initial window background now follow those measured values. The default rail is 280 px and sidepane 320 px, matching Grok's source defaults. The native settings/theme buttons no longer overlap the sidepanel status. Product components remain independent Quansiox implementations.

Grok also has collapsed rail width 88 px, resize bounds, persisted split geometry, and a normally closed information pane. Quansiox still has fixed columns, an always-mounted sidepane, and a different browser/computer composition. The screenshots document the Quansiox change only; they do not establish a pixel match to Grok.

## Repairs completed in this review

- Correct CDP debugger protocol and real DOMSnapshot geometry mapping.
- Enforce browser snapshot revision/mutation freshness; avoid repeated binding listeners.
- Refuse native browser input without a visible host instead of reporting an action that never landed.
- Register VM readiness/PID, clear dead entries, stop old runtime on mode change, and normalize file results/errors.
- Stop run/retry on sandbox startup failure; relay sandbox boot errors to the coordinator.
- Preserve screenshot association using tool_call_id; restore a single card per call on reload, retain mixed assistant text/tool calls, and treat empty output as completed.
- Pass screenshot images into the renderer's tool cards.
- Label headless sandbox/host browser honestly and align measured Grok colors/proportions.
- Add transcript regression tests and opt-in real browser/VM integration checks; correct CDP fixtures and sandbox-failure tests.

## Validation and reproducibility

From `/Users/mohsin/manux/quansiox`:

- `npm test`: all 16 test scripts passed. Most desktop/unit tests use stubs; this is not a full parity certification. The PTY check reported a pipes fallback.
- `npm run check-browser-real`: real Electron page; unhosted input refused, visible click changes the page, form fill changes its value, pre-navigation snapshot refused.
- `npm run check-vm-real`: actual VZ Linux guest; uname, file write/read/list contracts, empty file/command responses and missing-file error verified.
- `npm run check-renderer`: actual preload/IPC/React mount and existing UI behavior check passed; it does not certify a live guest desktop.
- Real delegation fixture: child execution and context separation verified; it deliberately demonstrated missing child-model selection.
- `npm run build`: renderer rebuilt; dark screenshot visually inspected.
- `npm run package`: rebuilt `release/Quansiox.app`; strict deep signature verification passed. All 57 source/config payload files matched the packaged copies. Real VM and browser integration fixtures also passed against the packaged payload; the browser fixture used the installed Electron test harness. Evidence: `package-payload-final.json`, `vm-packaged-final.json`, `browser-packaged-final.json`.

The real browser/VM checks can write JSON evidence using `QUANSIOX_BROWSER_REPORT` / `QUANSIOX_VM_REPORT`. The checks use fresh temporary settings and loopback-only fixture requests. VM checks require the included runtime and a host that supports it.

## Adoption order and acceptance criteria

1. **Unify the computer runtime.** Provide a guest desktop/browser, live frame output, guest keyboard/pointer control, and one runtime identity for shell/files/browser. Acceptance: an agent creates a file, opens it in the guest browser, visibly clicks a control, and the screenshot/input stream belongs to that guest rather than this Mac. Restart/resume and teardown must be demonstrated.
2. **Complete delegated task lifecycle.** Persist child transcripts/results; expose inspect, await, interrupt, resume and fork; support explicit child models; allocate/lease computers with defined concurrency. Acceptance: two children navigate different pages concurrently without changing each other's state; a background result survives restart; one child can be stopped/resumed without stopping its sibling.
3. **Match Grok's shell and browser interactions.** Implement collapse/resize/persisted panels, computer/browser mode switching, task detail navigation, and corresponding empty/loading/error states. Acceptance: compare matching viewport/state screenshots and exercise every control against real runtime actions.
4. **Implement actual skill recording.** Collect human actions plus screen state, show captured steps, and replay a recorded workflow in the intended computer. Acceptance: recording a click/type sequence produces nonempty steps and replay demonstrably changes the target.
5. **Fill the remaining feature register.** Build Quansiox-owned backend contracts for cloud computers, accounts/teams, automations, voice, channels, secrets, memory and shared artifacts. Acceptance must be an end-to-end user workflow per feature, not an IPC method name or a button.

The requested verification is complete for these findings. Full adoption of every competitor capability remains a substantial implementation program and has not been achieved by these repairs.
