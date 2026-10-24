# Current parity verification — 5 October 2026

Quansiox does not have complete Grok Bot / Manus agent parity. The reported sidepanel-computer gap is confirmed. Delegation and browser functionality are partially real, with material differences between source and the packaged application.

This verification inspected supplied local bundles and reran Quansiox's actual coordinator, Electron browser and Linux VM tests. Competitor cloud services and signed-in workflows were not exercised. Shipped client contracts establish expected surfaces, not successful remote behavior.

| Area | Current source | Packaged release/Quansiox.app | Finding |
| --- | --- | --- | --- |
| Delegation | Real child model/tool loops. Fresh test passed model selection, separate files, persisted transcripts, scoped access, artifact retrieval, individual model-call interruption, resume/fork and coordinator crash recovery. | Older child loops use settings.model and parent toolSession. Durable task store and TaskDetail component absent. Loaded UI lacks the new delegation form. | Partial in source; packaged app substantially behind. |
| Child isolation | Separate browser session per child; optional separate file workspace. Async children run in one coordinator process. | Shared parent tool session; shared browser cookies/storage. | Complete child-computer isolation missing. |
| Browser | Real host Electron Chromium. Visible click/fill, stale-snapshot rejection and storage isolation passed. | Click/fill work; isolation failed: sibling read cookie childA=private and localStorage value A. | Functional browser; design and runtime parity incomplete. |
| VM | Real Linux VM shell/file operations when VM mode selected. Default is process sandbox. | Same headless VM adapter and assets. | VM is real; desktop integration missing. |
| Sidepanel | Status/identity/path card plus host browser viewport. Descriptor explicitly returns desktopDisplay:false and browserRuntime:electron-host. | Screenshot says Process sandbox · headless and Shell and files. No desktop display. | No live guest desktop. |
| Computer tools | Main-process relay calls host computerUseService. | Same host-control architecture. | Controls the Mac, not the Linux guest. |
| Grok design | Measured dark/light palette and 280px/320px panel dimensions adopted. | Similar initial palette/layout. | Collapse, resizable/persisted panels and nested task/computer interactions incomplete. Full visual match unverified. |

Grok's bundled local-exec-daemon SubagentArgs includes model_id, resume_agent_id, run_in_background, interrupt, fork_agent_id, selected_context, environment and model_parameters. Its desktop client includes VNC connection/reconnection and interactive-view contracts. This does not prove every Grok child owns a separate VM; Quansiox's incomplete guest routing is directly established by its implementation.

Current Quansiox delegation still lacks independent worker processes, nested delegation, selected-context/model-parameter parity and a live computer per child. The interrupt test covers a pending model request, not cancellation of a long-running shell command.

## Desktop prototype is not integrated

A separate prototype booted an actual X desktop and Chromium, returned an RFB greeting and CDP targets, and captured a guest screenshot. It uses desktop-Image, desktop-initramfs.cpio.gz and qx-vm.next. The active adapter instead loads qx-vm, Image and initramfs.cpio.gz; package.js ships only those headless assets. No noVNC viewer or guest display/input connection is wired into the app renderer/IPC. The installed noVNC dependency alone does not provide this connection.

## Verification evidence

All evidence is in /Users/mohsin/manux/work/parity-2026-10-05:

- tasks-verification-current.json: fresh actual coordinator + sandbox workers; deterministic local streaming provider; passed.
- vm-verification-current.json: fresh VZ guest returned Linux/aarch64; shell/file/empty-result contracts passed; desktopDisplay:false.
- browser-verification-current.json: fresh real Electron source browser acceptance passed.
- browser-packaged-verification.json: same test using packaged services failed sibling cookie/storage isolation after click/fill passed.
- release-verification-current.json: source/package comparison, including actually loaded src/renderer/assets/app.js. It differs; source build has delegation form, packaged build does not. The old src/renderer/app.js is not the loaded bundle.
- packaged-current.png: packaged renderer/services loaded through installed Electron with a separate temporary profile and no production provider. Packaged executable itself was not launched for this capture.
- desktop-boot-probe.json and desktop-test/guest-desktop.png: earlier actual desktop prototype evidence inspected during this verification; prototype boot not rerun.

## Remaining work

1. Connect guest desktop lifecycle, display and input to IPC and sidepanel; verify real visible pixels and guest keyboard/pointer effects.
2. Route browser/computer/shell/files into the same guest, with explicit child-owned or shared environments.
3. Complete missing delegation controls, including command cancellation and context/model parameters.
4. Implement and visually verify Grok panel/browser interactions.
5. Rebuild/package the final source and rerun acceptance against packaged services and UI.

The broader matrix is in parity-review-2026-10-05.md. Its F01/F02 states are the earlier audit baseline; this document supersedes them for current delegation and browser isolation. Full competitor parity remains unverified.

---

## Update — 2026-10-09 (repackaged; source/packaged drift resolved)

The source-vs-packaged drift flagged above (packaged delegation + browser
isolation lagged source; the loaded `renderer/assets/app.js` differed) is now
**resolved**. `release/Quansiox.app` was rebuilt (`npm run package`) and
verified:

- `codesign --verify --deep --strict release/Quansiox.app` passes (qx-vm
  re-signed with its virtualization entitlements after the deep sign).
- Packaged `Resources/app/src` is **byte-identical** to `/quansiox/src`
  (`diff -rq` reports no differences).
- The packaged compatibility catalog matches source: **94 local / 307
  fail-closed of 401** Grok methods.

All capabilities added this session (full Grok compat surface, secrets vault,
automations/workflows, delegation depth + real child-shell cancellation,
documents/attachments, authenticated cookie import, session conveniences,
session avatars, composer drafts, conversation outline) are present in the
packaged bundle. See `/Users/mohsin/manux/GPA.md` §10 for the change ledger.
