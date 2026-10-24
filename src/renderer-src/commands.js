/* The application's own commands.
 *
 * The app menu (src/main/appMenu.js) sends these down as `ui:command`
 * events, and the renderer bridge (src/renderer/commands-bridge.js) turns
 * them into real UI actions. The composer offers the very same list as
 * slash commands, so the list lives here — next to the runner that falls
 * back to a local implementation when the bridge is not on the page.
 *
 * Every entry is a real command: it does something in this app.
 */

export const APP_COMMANDS = [
  {
    id: 'sand.openSettings',
    cmd: '/settings',
    title: 'Open settings',
    desc: 'provider, model, agents, permissions',
    accel: '⌘,',
  },
  {
    id: 'sand.toggleSidebar',
    cmd: '/sidebar',
    title: 'Toggle sidebar',
    desc: 'show or hide the session rail',
    accel: '⌘B',
  },
  {
    id: 'sand.togglePanels',
    cmd: '/panels',
    title: 'Toggle panels',
    desc: 'show or hide the side panels',
    accel: '⌘.',
  },
  {
    id: 'sand.findInChat',
    cmd: '/find',
    title: 'Find in session',
    desc: 'search this conversation',
    accel: '⌘F',
  },
  {
    id: 'sand.focusInput',
    cmd: '/focus',
    title: 'Focus composer',
    desc: 'jump back to the message box',
    accel: '⌘I',
  },
];

/** The command a piece of text refers to ("/settings" → the settings command). */
export function findAppCommand(text) {
  const cmd = String(text ?? '').trim().split(/\s+/)[0];
  if (!cmd) return null;
  return APP_COMMANDS.find((c) => c.cmd === cmd) ?? null;
}

function click(selector) {
  const el = document.querySelector(selector);
  if (!el || typeof el.click !== 'function') return false;
  el.click();
  return true;
}

function synthesizeKey(key, code) {
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent || '');
  const mod = isMac ? { metaKey: true } : { ctrlKey: true };
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key, code, bubbles: true, cancelable: true, ...mod,
  }));
  return true;
}

/**
 * The fallback runner: the same actions the bridge performs, for the case
 * where the bridge is not loaded.
 */
function runLocally(id) {
  switch (id) {
    case 'sand.openSettings':
      if (window.quansioxUI && typeof window.quansioxUI.openSettings === 'function') {
        window.quansioxUI.openSettings();
        return true;
      }
      return click('#btn-settings');
    case 'sand.toggleSidebar':
      return click('button[aria-label="Toggle sidebar"]');
    case 'sand.togglePanels':
      return synthesizeKey('.', 'Period');
    case 'sand.findInChat':
      return synthesizeKey('f', 'KeyF');
    case 'sand.focusInput': {
      const el = document.querySelector('.composer [contenteditable="true"]')
        || document.querySelector('.composer textarea')
        || document.querySelector('textarea[placeholder]');
      if (!el || typeof el.focus !== 'function') return false;
      el.focus();
      return true;
    }
    default:
      return false;
  }
}

/**
 * Run one of the app's commands. The bridge is the real implementation; the
 * local runner is the graceful degradation when it is not on the page.
 *
 * @returns {boolean} whether the command did something.
 */
export function runAppCommand(id) {
  const bridge = typeof window !== 'undefined' ? window.quansioxCommands : null;
  if (bridge && typeof bridge.run === 'function') {
    try {
      if (bridge.run(id) !== false) return true;
    } catch { /* fall through to the local runner */ }
  }
  return runLocally(id);
}
