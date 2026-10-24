'use strict';
/**
 * Computer use service — real macOS control for the agent.
 *
 * v2.4 (Manus architecture port): AX reads, element actions, and input
 * injection now route through the supervised out-of-process helper
 * (src/computer-helper, reached via computerHostService — the Manus
 * skill-recorder/operator pattern: NDJSON JSON-RPC over a unix socket,
 * control-token bootstrap, capped-backoff restarts). Screenshots stay here
 * because desktopCapturer is Electron-only, and now carry a dHash frame
 * fingerprint (the Manus screenshot.frameHash pattern) so the model can
 * verify "did the screen actually change" after an action.
 *
 * Every call is gated by `settings.allowComputerUse` (default OFF) — the
 * agent cannot touch the GUI until the user opts in.
 */
const { desktopCapturer } = require('electron');
const { settingsService } = require('./settingsService');
const { controlHandoff } = require('./controlHandoff');
const { FreshnessGate, frameHashFromBgra, frameHashFromBytes } = require('../../coordinator/freshness');

const freshness = new FreshnessGate();

function assertEnabled() {
  if (!settingsService.load().allowComputerUse) {
    throw new Error('computer use is disabled — enable it in Settings');
  }
}

/** Enabled AND not handed over to the user (Take over / I'm done). */
function assertAvailable() {
  assertEnabled();
  if (controlHandoff.isActive()) {
    throw new Error('USER_TAKEOVER — the user has taken over the computer; your actions are paused until they click "I\'m done"');
  }
}

/** Route an operation to the computer helper host. */
async function host(method, params, timeoutMs) {
  assertAvailable();
  const { computerHostService } = require('./computerHostService');
  return computerHostService.request(method, params, timeoutMs);
}

/* ---- freshness tokens (Grok Bot semantics) ----
 * coordinate_token: issued by the latest screenshot; coordinate actions
 *   (click) must present it; invalidated by the next screenshot.
 * snapshot_id: issued by the latest AX read; invalidated by the next read. */
/** SCREENSHOT_REQUIRED-style refusal text (model-facing taxonomy). */
function requireCoordinateToken(provided) {
  return freshness.requireCoordinate(provided);
}

/** Validate a snapshot_id (for AX-element actions). */
function requireSnapshotToken(provided) {
  return freshness.requireSnapshot(provided);
}

/**
 * dHash fingerprint of a NativeImage (Manus screenshot.frameHash pattern):
 * 8x8 grayscale difference hash — cheap "did the screen change" signal.
 */
function frameHashOf(image) {
  try {
    if (typeof image?.resize === 'function' && typeof image?.getBitmap === 'function') {
      const small = image.resize({ width: 9, height: 8 });
      const bitmap = small.getBitmap();
      const data = bitmap?.data ?? bitmap;
      const hash = frameHashFromBgra(data, 9, 8);
      if (hash) return hash;
    }
  } catch {
    /* fall through to a byte hash of the image payload */
  }
  try {
    if (typeof image?.toDataURL === 'function') return frameHashFromBytes(image.toDataURL());
  } catch {
    /* no hash available */
  }
  return null;
}

/**
 * The target an action applies to.
 *
 * When a target is given the native helper addresses that app directly:
 * its window is captured with ScreenCaptureKit and its accessibility tree is
 * actuated through the AX API, so the app does NOT need to be frontmost and
 * the user's mouse and keyboard are never taken over. That is the difference
 * from the JXA fallback, which can only drive whatever is in front.
 *
 * @param {object} params
 * @returns {object} the subset of params the helper understands
 */
function targetParams(params = {}) {
  const out = {};
  for (const key of ['bundle_id', 'app_name', 'pid', 'window_id']) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

/** AX snapshot of the target app — issues a snapshot_id. */
async function appState(params = {}) {
  const result = await host('computer/app_state', targetParams(params));
  const meta = result?.meta ?? null;
  // The native helper owns the element registry, so its snapshot id is the
  // authoritative one; the JS gate adopts it.
  const adopted = meta?.snapshotId ? freshness.setSnapshot(meta.snapshotId) : null;
  const issued = adopted ? { token: adopted } : freshness.issueSnapshot();
  return {
    app: result?.app ?? null,
    pid: result?.pid ?? null,
    bundleId: result?.bundleId ?? null,
    windowId: result?.windowId ?? null,
    title: result?.title ?? null,
    elements: result?.elements ?? [],
    windows: result?.windows ?? [],
    meta: meta ?? null,
    snapshotId: issued.token,
  };
}

/** Manus computer_use.find_elements: query AX elements by role/name/value. */
async function findElements(params = {}) {
  const refusal = requireSnapshotToken(params.snapshot_id);
  if (refusal) return refusal;
  const result = await host('computer/find_elements', {
    ...targetParams(params),
    role: params.role,
    name: params.name,
    value: params.value,
  });
  if (result?.meta?.snapshotId) freshness.setSnapshot(result.meta.snapshotId);
  return {
    count: result?.count ?? 0,
    elements: result?.elements ?? [],
    snapshotId: result?.snapshotId ?? freshness.snapshotToken,
  };
}

/**
 * Every window the system can see, with its owning app.
 *
 * This is how the model discovers the window it should act on: pick a
 * `window_id` (or a `bundle_id`) and every later action is addressed at
 * that app instead of whatever happens to be in front.
 */
async function listWindows() {
  const result = await host('computer/list_windows');
  return { windows: result?.windows ?? [] };
}

/**
 * Release the helper's element handles when no run is using the computer.
 *
 * A handle from an earlier run must not still be actionable in a later one,
 * and the helper's snapshot registry is bounded. This is deliberately a
 * no-op when the helper never started, so finishing a run that never touched
 * the GUI does not spawn it.
 */
async function finish() {
  const { computerHostService } = require('./computerHostService');
  if (!computerHostService.status().running) {
    return { finished: true, releasedSnapshots: 0, skipped: 'helper not running' };
  }
  const result = await computerHostService.request('computer/finish', {}, 5000);
  // The helper dropped its element registry: an old snapshot id must not be
  // validated by the JS gate and then fail in the helper. Coordinate tokens
  // are screenshot-scoped, not handle-scoped, and stay valid.
  freshness.clearSnapshot();
  return result;
}

/**
 * Screenshot.
 *
 * With a target the native helper captures THAT window (background apps
 * included); without one we fall back to the whole screen through
 * Electron's desktopCapturer.
 */
async function screenshot(params = {}) {
  assertAvailable();
  const target = targetParams(params);
  if (Object.keys(target).length > 0) {
    // The native helper can capture a background window.
    const result = await host('computer/screenshot', target);
    if (result?.data) {
      const frameHash = frameHashFromBytes(result.data);
      const issued = freshness.issueCoordinate(frameHash ?? 'window');
      return {
        id: result.id ?? `shot-${Date.now().toString(36)}`,
        data: result.data,
        width: result.width ?? 0,
        height: result.height ?? 0,
        windowId: result.windowId ?? null,
        app: result.app ?? null,
        coordinateToken: issued.token,
        frameHash: issued.frameHash,
        screenChanged: issued.screenChanged,
      };
    }
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1600, height: 1600 },
  });
  if (!sources.length) throw new Error('SCREENSHOT_FAILED — no screen sources (Screen Recording permission?)');
  const frameHash = frameHashOf(sources[0].thumbnail);
  if (!frameHash) throw new Error('SCREENSHOT_FAILED — frame hash missing');
  const issued = freshness.issueCoordinate(frameHash);
  return {
    id: `shot-${Date.now().toString(36)}`,
    data: sources[0].thumbnail.toDataURL(),
    width: sources[0].thumbnail.getSize().width,
    height: sources[0].thumbnail.getSize().height,
    coordinateToken: issued.token,
    frameHash: issued.frameHash,
    screenChanged: issued.screenChanged,
  };
}

/** Click — on an AX element (background, no pointer movement) or at coordinates. */
async function click(params) {
  const { x, y } = params;
  // An element click is the background mode: it needs a snapshot id.
  if (params.element_id) {
    const refusal = requireSnapshotToken(params.snapshot_id);
    if (refusal) return refusal;
    const result = await host('computer/click', {
      ...targetParams(params),
      element_id: params.element_id,
      snapshot_id: params.snapshot_id,
    });
    return `clicked element ${params.element_id}${result?.outcome?.background ? ' (in the background)' : ''}`;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('invalid_arguments — x/y required');
  const refusal = requireCoordinateToken(params.coordinate_token ?? params.coordinateToken);
  if (refusal) return refusal; // model-facing refusal text
  const result = await host('computer/click', {
    ...targetParams(params),
    x,
    y,
    button: params.button,
    click_count: params.click_count,
  });
  const verified = Boolean(result?.outcome?.effectVerified);
  return `clicked (${Math.round(x)}, ${Math.round(y)})${result?.outcome?.background ? ' (in the background)' : ''}${verified ? '' : ' (screen may not have changed — verify with computer_screenshot)'}`;
}

/** Type a string into the focused element. */
async function typeText({ text }) {
  if (!text) throw new Error('text required');
  await host('computer/type_text', { text });
  return `typed ${String(text).length} chars`;
}

/** Press a key (e.g. Return, Tab, a, escape) with optional modifiers. */
async function pressKey({ key, modifiers = [] }) {
  await host('computer/press_key', { key, modifiers });
  return `pressed ${key}${modifiers?.length ? ` (+${modifiers.join(',')})` : ''}`;
}

/** Set an AX element's value (Manus computer_use.set_value). */
async function setValue(params = {}) {
  const refusal = requireSnapshotToken(params.snapshot_id);
  if (refusal) return refusal;
  const result = await host('computer/set_value', {
    ...targetParams(params),
    role: params.role,
    name: params.name,
    value: params.value,
    element_id: params.element_id,
    snapshot_id: params.snapshot_id,
  });
  if (result?.error) return `${result.error} — ${result.message ?? ''}`;
  return `set value on ${result?.matched ?? '?'} element(s)`;
}

/** Scroll wheel at coordinates (delta positive = up). */
async function scroll({ x, y, deltaY = -3 }) {
  await host('computer/scroll', { x, y, deltaY });
  return `scrolled ${deltaY > 0 ? 'up' : 'down'} at (${Math.round(x)}, ${Math.round(y)})`;
}

/** Open an app by name. Web browsers stay in the Electron session browser. */
async function openApp({ name }) {
  const { classifyAppName } = require('../../coordinator/hostBrowser');
  const decision = classifyAppName(name);
  if (decision?.kind === 'browser-app') return decision.message;
  if (decision?.kind === 'url') {
    return 'refused: pass that URL to browser_open so it loads in the Electron browser';
  }
  await host('computer/open_app', { name });
  return `activated ${name}`;
}

/** List visible apps (helper: System Events). */
async function listApps() {
  const result = await host('computer/list_apps');
  return result.apps ?? [];
}

/** List installed applications (Manus application/list shape). */
async function listInstalledApps({ refresh = false } = {}) {
  const result = await host('application/list', { refresh });
  return result.apps ?? [];
}

/** Helper host status (supervision + permissions). */
async function hostStatus() {
  const { computerHostService } = require('./computerHostService');
  try {
    const [status, perms] = await Promise.all([
      computerHostService.request('computer/status'),
      computerHostService.request('computer/authenticate', { controlToken: computerHostService.controlToken }, 5000).catch(() => null),
    ]);
    void perms;
    return status;
  } catch (error) {
    return { running: false, error: String(error?.message ?? error) };
  }
}

/** Permission probe (never gated): reports what would work right now. */
async function checkPermissions() {
  const out = { accessibility: false, screenRecording: false };
  try {
    const { computerHostService } = require('./computerHostService');
    const status = await computerHostService.request('computer/status', {}, 8000);
    out.accessibility = Boolean(status?.permissions?.accessibilityTrusted);
  } catch { /* helper unreachable */ }
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: 10, height: 10 },
    });
    out.screenRecording = sources.length > 0 && sources[0].thumbnail.toDataURL().length > 100;
  } catch {}
  return out;
}

module.exports = {
  computerUseService: {
    screenshot, appState, findElements, click, typeText, pressKey, setValue,
    scroll, openApp, listApps, listInstalledApps, listWindows, finish, hostStatus, checkPermissions,
    requireCoordinateToken, requireSnapshotToken, targetParams,
    freshness,
    isTakenOver: () => controlHandoff.isActive(),
  },
};
