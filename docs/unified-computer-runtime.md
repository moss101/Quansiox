# Unified live computer runtime — design & staged plan

**Status: design (not shipped).** This is the #1 structural gap vs. Manus /
Grok / Cue (GPA §6, G1). The work is native/Swift (Virtualization.framework)
plus a transport + renderer bridge. It cannot be verified end-to-end in a
headless/CI environment, so this document scopes it into phases with explicit
prerequisites and acceptance criteria, and marks what is already partially
proven here.

## 1. Current state (verified in source, 2026-10-09)

- `vm/qx-vm.swift` boots a real Alpine aarch64 guest (kernel, ≥512 MB, ≤1 CPU)
  over Virtualization.framework, with `stdio` console + virtiofs + NAT.
  It configures **no graphics or input devices** — grep of
  `src/main/services/vmSandboxService.js` for
  `display|graphic|framebuffer|VNC|RFB|keyboard|pointer|input|window` = 0.
- The guest runs a busybox agent speaking a **TSV protocol on the virtio
  console**; the host adapter maps it onto the sandbox op set
  (shell/fs.read/fs.write/fs.listdir). Headless by design → no live desktop.
- `sandboxMode: sandboxed` (default) is a process+seatbelt sandbox; `vm` is
  opt-in. Sidepanel honestly labels "headless" and returns `desktopDisplay:false`.
- **Already available for the bridge:** `@novnc/novnc` 1.7.0 and `ws` 8.22.0
  are dependencies — so a WebSocket↔RFB transport + a noVNC renderer client
  are feasible without new deps.
- **Partial proof-of-life exists:** `work/parity-2026-10-05/desktop-test/` holds
  `desktop-Image`, `desktop-initramfs.cpio.gz`, `qx-vm.next` that (per
  `parity-verification-current.md`) booted an actual X desktop + Chromium and
  returned an RFB greeting. Phase 1 is largely "promote + harden that
  prototype." It is not wired into the app and is NOT shipped by
  `scripts/package.js` (only `qx-vm`, `Image`, `initramfs.cpio.gz` ship).

## 2. Target architecture

```
 ┌── guest VM (VZ, aarch64) ────────────────┐   ┌──── host (Electron main) ────┐
 │  Linux + X/Wayland + (Chromium optional) │   │                              │
 │  virtio-gpu scanout → shared framebuffer │◄──┤ vncBridge (node): read fb,   │
 │  virtio-keyboard ─┐                       │   │   serve RFB on TCP; ws→tcp   │
 │  virtio-tablet  ──┼─ inject guest input  │◄──┤   bridge for sandboxed rndr; │
 │  virtio console ──┘ (TSV control plane)  │   │   route input back to devices │
 └──────────────────────────────────────────┘   └──────────────┬───────────────┘
                                                               │ WebSocket (ws://loopback)
                                                    renderer sidepanel: @novnc/novnc RFB client
                                                    (read-only preview + interactive when the
                                                     user grants control) → computer_* tools + sidepanel
```

**One runtime identity:** after this lands, shell/files/browser/**computer** for
a session all target the *same guest VM* (the framebuffer IS the computer), and
a delegated child can be *leased* its own guest.

## 3. Phase plan (each ends in an acceptance test; only Phase 0 is verifiable headless)

### Phase 0 — transport scaffolding (JS; verifiable now)
- `src/main/services/vncBridge.js`: manage a per-session **screen server**: open
  `/tmp/qx-screen.<uid>.<hash>.sock` (0600, Cue/socket trust model) + a loopback
  WebSocket exposing one port; the RFB byte stream is forwarded over WS to the
  renderer. Provide a minimal **framebuffer-producer interface** the VM adapter
  implements (Phase 1). Until a producer exists, the service is inert.
- Renderer `ScreenViewer.jsx`: mount noVNC's `RFB` against the per-session WS
  URL, read-only by default; input gated by a "control" toggle.
- **Acceptance (headless):** unit tests with an in-memory RFB source prove (a)
  the WS bridge forwards bytes both ways, (b) `ScreenViewer` upgrades/attaches
  and shows a connecting→connected state. No real VM required. *(Testable in this
  environment.)*

### Phase 1 — guest framebuffer + input (Swift; needs a real Mac + entitlements)
- Extend `qx-vm` (promote `qx-vm.next`): add `VZGraphicsDevice` (virtio-gpu with
  a scanout surface), `VZUSBKeyboardConfiguration`, `VZUSBScreenCoordinatePointingDevice`.
  Read the scanout into a shared/OSShared buffer; hand the Linux DRM/KMS
  framebuffer there; run a tiny compositor (e.g. Cage/weston or a bare DRM KMS
  fbdev) on the `desktop-Image`.
- Bridge: a Node reader turns framebuffer tiles into `FramebufferUpdate`
  rectangles (raw encoding first; cursor + damage rect later); RFB server speaks
  VNC auth over the 0600 loopback (or none + the socket is the auth, Cue-style).
  RFB `PointerEvent`/`KeyEvent` → `VZUSBScreenCoordinatePointingDevice`/
  `VZUSBKeyboardConfiguration` post.
- **Prerequisites:** darwin arm64; Virtualization entitlement
  (`com.apple.security.virtualization` — already in `vm/qx-vm.entitlements`); a
  VZ-capable Mac with a display you can observe; re-sign qx-vm with entitlements
  after the deep sign (scripts/package.js already does the re-seal).
- **Acceptance (real Mac):** guest boots to X; a screenshot tile appears in the
  sidepanel via noVNC; a click/keypress from the renderer visibly moves the guest
  cursor/types; `computer_screenshot` returns a real guest framebuffer frame.

### Phase 2 — unify the runtime identity
- `sandboxService`/`vmSandboxService`: a session's shell/fs/`computer_*` all
  resolve to the guest: TSV ops over the console (as today) + computer capture/
  input via the Phase-1 bridge. `getHostStatus`/sidepanel report
  `desktopDisplay:true`, `browserRuntime:guest` when a guest Chromium exists.
- Graceful fallback: if VZ graphics unavailable, keep the current headless label
  (never claim a desktop that isn't there).
- **Acceptance:** agent creates a file, opens it in the guest browser, visibly
  clicks a control, and the displayed frame belongs to the guest (not this Mac);
  `sandboxMode` switch + restart/teardown demonstrably work.

### Phase 3 — per-child guest leases (closes G5 remainder)
- A `ComputerPool` that leases one guest per `computer-use`/`browser` child (cap
  concurrency; recycle on TTL; reap strays by ppid like the operator). Children
  no longer share this Mac's GUI or the parent framebuffer.
- **Acceptance:** two `computer-use` children drive two different guest desktops
  concurrently with no cross-talk; killing one child frees only its guest.

## 4. Risks / honest bounds
- Phases 1–3 require native Swift + VZ graphics + entitlements and a physical
  Mac to observe; they **cannot be shipped "verified" from this headless
  environment.** Treat Phase 0 (tested) as the only thing committable here.
- Frame rate will be modest (RFB raw over loopback is fine locally; coarse
  encoding + damage rects are the optimization path).
- Security: screen server on 0600 unix socket; renderer reaches it only via the
  authenticated per-session WS; input injection stays gated behind the opt-in
  computer-use toggle + Accessibility consent (as today).

## 5. Related frontier — skill-recording capture (G3)
Same native caveat. Design: a tiny privileged helper installs a **CGEventTap**
(Accessibility permission prompt, `kCGEventTapOptionListenOnly` for
non-invasive capture) + optional AX screenshots; events are written to the
existing skill-artifact store (the state machine + replay already exist) and
replayed through `replayArtifact` with fresh screenshot tokens (already
implemented). A JS-only path can *record the agent's own* computer actions at the
helper boundary (no global tap) as a smaller, fully-local first step — worth
doing before the human-capture tap.
