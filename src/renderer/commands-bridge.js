'use strict';
/* Renderer-side command bridge: routes ui:command events from the
 * application menu onto the real UI. Every handler performs an actual
 * action or reports itself unhandled — never a silent fake. */
(() => {
  const bridge = window.quansiox;
  if (!bridge || !bridge.events || typeof bridge.events.on !== 'function') return;

  const isMac = /mac/i.test(navigator.platform || navigator.userAgent || '');

  function click(selector) {
    const el = document.querySelector(selector);
    if (!el || typeof el.click !== 'function') return false;
    el.click();
    return true;
  }

  function synthesizeKey(key, code) {
    const mod = isMac ? { metaKey: true } : { ctrlKey: true };
    const event = new KeyboardEvent('keydown', {
      key,
      code,
      bubbles: true,
      cancelable: true,
      ...mod,
    });
    document.dispatchEvent(event);
    return true;
  }

  const handlers = {
    'sand.openSettings': () => {
      // eslint-disable-next-line no-undef
      if (window.quansioxUI && typeof window.quansioxUI.openSettings === 'function') {
        window.quansioxUI.openSettings();
        return true;
      }
      return click('#btn-settings');
    },
    'sand.toggleSidebar': () => click('button[aria-label="Toggle sidebar"]'),
    'sand.togglePanels': () => synthesizeKey('.', 'Period'),
    'sand.findInChat': () => synthesizeKey('f', 'KeyF'),
    'sand.focusInput': () => {
      const el =
        document.querySelector('.composer [contenteditable="true"]') ||
        document.querySelector('.composer textarea') ||
        document.querySelector('textarea[placeholder]');
      if (!el || typeof el.focus !== 'function') return false;
      el.focus();
      return true;
    },
  };

  bridge.events.on('ui', 'command', (payload) => {
    const command = payload && payload.command;
    const handler = handlers[command];
    if (!handler) {
      console.warn('[quansiox] unhandled menu command', command);
      return;
    }
    try {
      if (!handler()) console.warn('[quansiox] menu command not applicable now', command);
    } catch (error) {
      console.error('[quansiox] menu command failed', command, error);
    }
  });

  /* The same commands, reachable from the renderer: the composer offers
   * them as slash commands, so it needs a way to run one. */
  window.quansioxCommands = {
    ids: Object.keys(handlers),
    run(command) {
      const handler = handlers[command];
      if (!handler) return false;
      return handler();
    },
  };
})();
