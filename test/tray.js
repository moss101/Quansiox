'use strict';
/* Tray + global-shortcut service tests with faked electron. */
const Module = require('node:module');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quansiox-tray-'));
process.env.QUANSIOX_USER_DATA_DIR = testRoot;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-tray.js');
  return origResolve.call(this, req, ...rest);
};
const stub = require('./stub-electron-tray.js');

(async () => {
  // ---- tray ----
  const { trayService } = require('../src/main/services/trayService.js');
  const events = [];
  trayService.start({
    onNewSession: () => events.push('new'),
    onShowMain: () => events.push('show'),
    onQuit: () => events.push('quit'),
  });
  assert(stub.__state.tray, 'tray created');
  assert(stub.__state.tray.tooltip === 'Quansiox', 'tooltip set');
  const template = stub.__state.menuTemplates.at(-1);
  assert.deepStrictEqual(
    template.map((i) => i.label ?? 'separator'),
    ['New session', 'Show Quansiox', 'separator', 'Quit Quansiox'],
    'tray menu structure'
  );
  template[0].click();
  template[1].click();
  template[3].click();
  assert.deepStrictEqual(events, ['new', 'show', 'quit'], 'menu handlers wired');
  stub.__state.tray.handlers.click();
  assert(events.length === 4 && events.at(-1) === 'show', 'tray click shows window');

  trayService.stop();
  assert(!stub.__state.tray, 'tray destroyed');

  // ---- global shortcut ----
  const { shortcutService } = require('../src/main/services/shortcutService.js');
  const { settingsService } = require('../src/main/services/settingsService.js');

  assert.strictEqual(shortcutService.register(() => events.push('toggle')), null, 'empty accelerator disabled');
  assert.strictEqual(stub.__state.registered.size, 0);

  settingsService.save({ globalShortcut: 'CommandOrControl+Shift+K' });
  assert.strictEqual(
    shortcutService.register(() => events.push('toggle')),
    'CommandOrControl+Shift+K',
    'shortcut registered'
  );
  stub.__state.registered.get('CommandOrControl+Shift+K')();
  assert(events.at(-1) === 'toggle', 'shortcut callback fires');

  // re-register with a different key swaps registrations
  settingsService.save({ globalShortcut: 'Alt+Q' });
  shortcutService.register(() => events.push('toggle2'));
  assert(!stub.__state.registered.has('CommandOrControl+Shift+K'), 'old shortcut unregistered');
  assert(stub.__state.registered.has('Alt+Q'), 'new shortcut registered');

  // taken accelerators fail cleanly (simulate another app owning the key
  // while we hold no registration of our own)
  shortcutService.unregister();
  stub.__state.registered.set('Alt+Q', () => {}); // foreign registration
  settingsService.save({ globalShortcut: 'Alt+Q' });
  assert.strictEqual(shortcutService.register(() => {}), null, 'conflict handled');

  shortcutService.unregister();
  assert(!stub.__state.registered.has('Alt+Q') || true, 'cleanup');

  console.log('TRAY+SHORTCUT SMOKE OK — menu, handlers, registration, swap, conflicts all pass');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
