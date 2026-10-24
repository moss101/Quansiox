'use strict';
/* Batch 19 — application menu + renderer commands bridge:
 *  - appMenu template carries Grok-parity accelerators; New Session emits
 *    navigation:navigate {type:'new'} (consumed by the compiled renderer),
 *    feature commands emit ui:command {command},
 *  - commands-bridge.js routes ui:command to real DOM actions (settings,
 *    sidebar toggle, panels/find accelerators, composer focus) and reports
 *    unhandled commands instead of faking them.
 * Electron-free: fake Menu captures the template; the bridge runs against
 * DOM stubs via new Function. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildTemplate, installAppMenu, COMMANDS } = require('../src/main/appMenu');

function flatten(items, out = []) {
  for (const item of items) {
    out.push(item);
    if (item.submenu) flatten(item.submenu, out);
  }
  return out;
}

function findItem(template, predicate) {
  const hit = flatten(template).find(predicate);
  assert.ok(hit, `menu item not found: ${predicate}`);
  return hit;
}

(async () => {
  // ---- Part A: main-process menu ----
  const emitted = [];
  const emit = (namespace, method, ...args) => emitted.push([namespace, method, ...args]);
  const fakeMenu = {
    applied: null,
    setApplicationMenu(m) { this.applied = m; },
    buildFromTemplate(t) { return { template: t }; },
  };

  const darwinTemplate = installAppMenu({ Menu: fakeMenu, emit, platform: 'darwin' });
  assert.ok(fakeMenu.applied, 'setApplicationMenu called');
  assert.strictEqual(fakeMenu.applied.template, darwinTemplate);

  assert.deepStrictEqual(
    darwinTemplate.map((m) => m.label),
    ['Quansiox', 'File', 'Edit', 'View', 'Window']
  );

  // accelerators
  const byAccel = (a) => findItem(darwinTemplate, (i) => i.accelerator === a);
  assert.strictEqual(byAccel('CmdOrCtrl+N').label, 'New Session');
  assert.strictEqual(byAccel('CmdOrCtrl+,').label, 'Settings…');
  assert.strictEqual(byAccel('CmdOrCtrl+B').label, 'Toggle Sidebar');
  assert.strictEqual(byAccel('CmdOrCtrl+.').label, 'Toggle Panels');
  assert.strictEqual(byAccel('CmdOrCtrl+F').label, 'Find in Session');
  assert.strictEqual(byAccel('CmdOrCtrl+I').label, 'Focus Composer');
  assert.strictEqual(byAccel('Ctrl+Command+F').role, 'togglefullscreen');

  // native roles really present
  const roles = flatten(darwinTemplate).filter((i) => i.role).map((i) => i.role);
  for (const role of ['about', 'quit', 'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'reload', 'forceReload', 'toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'minimize', 'zoom', 'front', 'close']) {
    assert.ok(roles.includes(role), `missing role ${role}`);
  }

  // New Session -> real navigation route
  byAccel('CmdOrCtrl+N').click();
  assert.deepStrictEqual(emitted.pop(), ['navigation', 'navigate', { type: 'new' }]);

  // Feature commands -> ui:command
  const commandClicks = [
    ['CmdOrCtrl+,', COMMANDS.openSettings],
    ['CmdOrCtrl+B', COMMANDS.toggleSidebar],
    ['CmdOrCtrl+.', COMMANDS.togglePanels],
    ['CmdOrCtrl+F', COMMANDS.findInChat],
    ['CmdOrCtrl+I', COMMANDS.focusInput],
  ];
  for (const [accel, command] of commandClicks) {
    byAccel(accel).click();
    assert.deepStrictEqual(emitted.pop(), ['ui', 'command', { command }]);
  }

  // win/linux shape: no app menu, settings + quit live in File, F11 fullscreen
  const winTemplate = buildTemplate({ platform: 'win32', emit });
  assert.deepStrictEqual(winTemplate.map((m) => m.label), ['File', 'Edit', 'View']);
  const fileMenu = winTemplate[0];
  assert.ok(findItem(fileMenu.submenu, (i) => i.label === 'Settings…'));
  assert.ok(findItem(fileMenu.submenu, (i) => i.role === 'quit'));
  assert.strictEqual(findItem(winTemplate, (i) => i.role === 'togglefullscreen').accelerator, 'F11');

  // ---- Part B: renderer bridge ----
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'commands-bridge.js'), 'utf8');

  function makeEnv({ selectorMap = {}, mac = true } = {}) {
    const env = {
      subscriptions: [],
      clicks: {},
      keyEvents: [],
      warns: [],
      errors: [],
      focused: 0,
      settingsOpened: 0,
      quansioxUI: undefined,
    };
    const element = (name) => ({
      clicked: 0,
      click() { this.clicked += 1; env.clicks[name] = (env.clicks[name] ?? 0) + 1; },
      focus() { env.focused += 1; },
    });
    env.elements = {};
    for (const [selector, name] of Object.entries(selectorMap)) {
      env.elements[selector] = element(name);
    }
    const document = {
      querySelector: (s) => env.elements[s] ?? null,
      dispatchEvent: (ev) => { env.keyEvents.push(ev); return true; },
    };
    class KeyboardEvent {
      constructor(type, init) { this.type = type; Object.assign(this, init); }
    }
    const window = {
      quansiox: {
        events: {
          on(namespace, method, fn) { env.subscriptions.push({ namespace, method, fn }); },
        },
      },
      get quansioxUI() { return env.quansioxUI; },
    };
    const navigator = { platform: mac ? 'MacIntel' : 'Win32' };
    const consoleStub = {
      warn: (...a) => env.warns.push(a.join(' ')),
      error: (...a) => env.errors.push(a.join(' ')),
    };
    new Function('window', 'document', 'navigator', 'console', 'KeyboardEvent', source)(
      window, document, navigator, consoleStub, KeyboardEvent
    );
    env.fire = (payload) => env.subscriptions[0].fn(payload);
    return env;
  }

  // no preload API -> bridge stays dormant
  new Function('window', 'document', 'navigator', 'console', 'KeyboardEvent', source)(
    {}, { querySelector: () => null, dispatchEvent: () => {} }, {}, { warn() {}, error() {} }, class {}
  );

  // openSettings prefers quansioxUI, falls back to titlebar button
  {
    const env = makeEnv({ selectorMap: { '#btn-settings': 'settings' } });
    assert.strictEqual(env.subscriptions.length, 1);
    assert.strictEqual(env.subscriptions[0].namespace, 'ui');
    assert.strictEqual(env.subscriptions[0].method, 'command');

    env.fire({ command: 'sand.openSettings' });
    assert.strictEqual(env.clicks.settings, 1, 'falls back to #btn-settings click');

    env.quansioxUI = { openSettings: () => { env.settingsOpened += 1; } };
    env.fire({ command: 'sand.openSettings' });
    assert.strictEqual(env.settingsOpened, 1);
    assert.strictEqual(env.clicks.settings, 1, 'no extra click when quansioxUI present');
  }

  // sidebar toggle clicks the compiled renderer's rail button
  {
    const sel = 'button[aria-label="Toggle sidebar"]';
    const env = makeEnv({ selectorMap: { [sel]: 'rail' } });
    env.fire({ command: 'sand.toggleSidebar' });
    assert.strictEqual(env.clicks.rail, 1);
    assert.strictEqual(env.warns.length, 0);

    const bare = makeEnv();
    bare.fire({ command: 'sand.toggleSidebar' });
    assert.strictEqual(bare.warns.length, 1, 'reports when sidebar button is absent');
  }

  // panels/find route through synthesized accelerators (meta on mac, ctrl elsewhere)
  {
    const env = makeEnv();
    env.fire({ command: 'sand.togglePanels' });
    env.fire({ command: 'sand.findInChat' });
    assert.strictEqual(env.keyEvents.length, 2);
    assert.deepStrictEqual(
      env.keyEvents.map((e) => [e.type, e.key, e.code, e.metaKey === true, e.bubbles === true]),
      [['keydown', '.', 'Period', true, true], ['keydown', 'f', 'KeyF', true, true]]
    );
    const win = makeEnv({ mac: false });
    win.fire({ command: 'sand.togglePanels' });
    assert.strictEqual(win.keyEvents[0].ctrlKey, true);
    assert.strictEqual(win.keyEvents[0].metaKey, undefined);
  }

  // composer focus: contenteditable -> textarea fallback -> honest miss
  {
    const env = makeEnv({ selectorMap: { 'textarea[placeholder]': 'composer' } });
    env.fire({ command: 'sand.focusInput' });
    assert.strictEqual(env.focused, 1);

    const bare = makeEnv();
    bare.fire({ command: 'sand.focusInput' });
    assert.strictEqual(bare.focused, 0);
    assert.strictEqual(bare.warns.length, 1, 'reports when no composer is mounted');
  }

  // unknown commands are reported, never silently swallowed
  {
    const env = makeEnv();
    env.fire({ command: 'sand.doesNotExist' });
    env.fire({});
    assert.strictEqual(env.warns.length, 2);
    assert.ok(env.warns[0].includes('sand.doesNotExist'));
  }

  console.log('batch19: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
