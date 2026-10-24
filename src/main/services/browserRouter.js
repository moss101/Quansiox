'use strict';
/**
 * Browser runtime router — decides whether a bot's browser_* tools drive the
 * host Electron browser or the bot's own Linux VM Chromium.
 *
 *  - a session whose guest computer is live always uses the guest (the page is
 *    visible in that bot's VM screen);
 *  - `sandboxMode: 'vm'` bots get their own Linux box, so the browser boots the
 *    same guest on first use instead of silently using the host browser;
 *  - default `sandboxed`/`off` sessions keep the embedded host browser;
 *  - QUANSIOX_BROWSER_TARGET=host|guest overrides (used by tests/diagnostics).
 */
function defaultDeps() {
  return {
    settings: () => require('./settingsService').settingsService.load(),
    status: (sessionId) => require('./computerRuntimeService').computerRuntimeService.status(sessionId),
    desktopAvailable: () => require('./desktopVmService').desktopVmService.available(),
    desktopGet: (sessionId) => require('./desktopVmService').desktopVmService.get(sessionId),
    ensureComputer: (sessionId, options) =>
      require('./computerRuntimeService').computerRuntimeService.ensure(sessionId, options),
  };
}

let deps = defaultDeps();
function setDeps(next = {}) { deps = { ...defaultDeps(), ...next }; }
function resetDeps() { deps = defaultDeps(); }

/** @returns {Promise<'host'|'guest'>} */
async function resolve(sessionId, { reason = 'browser' } = {}) {
  const target = String(process.env.QUANSIOX_BROWSER_TARGET || '').toLowerCase();
  if (target === 'host') return 'host';
  if (!sessionId) return 'host';
  if (target === 'guest') {
    await deps.ensureComputer(sessionId, { reason });
    return 'guest';
  }
  let live = false;
  try {
    live = deps.status(sessionId)?.phase === 'ready' || deps.desktopGet(sessionId)?.ready === true;
  } catch { live = false; }
  if (live) return 'guest';
  let mode = 'sandboxed';
  try { mode = deps.settings()?.sandboxMode || 'sandboxed'; } catch { /* settings unavailable */ }
  if (mode === 'vm') {
    const available = (() => { try { return deps.desktopAvailable() === true; } catch { return false; } })();
    if (available) {
      await deps.ensureComputer(sessionId, { reason });
      return 'guest';
    }
  }
  return 'host';
}

module.exports = { browserRouter: { resolve, setDeps, resetDeps } };
