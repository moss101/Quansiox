'use strict';
/* W5 — the UI surface.
 *
 *  W5.1  the card framework: a registry, so a new card type is one entry
 *  W5.2  the approval cards render their target and offer a decision
 *  W5.3  a draft card can be edited and sent
 *  W5.5  the other card kinds render
 *  W5.6  an answered card shows an outcome, not stale buttons
 *  W5.7  the components are covered by real tests
 *  W5.9  no component carries a raw colour
 *  W5.11 the diff view renders a real diff
 *
 * The React components are rendered with @testing-library/react in jsdom —
 * the components themselves are exercised, not a mock of them. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// jsdom has to exist before React is imported.
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'file:///',
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.Event = dom.window.Event;
global.MouseEvent = dom.window.MouseEvent;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.IS_REACT_ACT_ENVIRONMENT = true;

// The IPC registry needs Electron; stub it the way the other IPC tests do,
// so the context map can be checked against the real namespaces.
const Module = require('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-playback.js');
  return origResolve.call(this, req, ...rest);
};

const React = require('react');
const { render, cleanup, fireEvent, screen, waitFor } = require('@testing-library/react');

const results = [];
async function test(name, fn) {
  cleanup();
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

// The renderer sources are JSX, so the testable components are bundled with
// esbuild first (the same bundler the app uses).
const RENDERER = path.join(__dirname, '..', 'src', 'renderer-src');

(async () => {
  // The card components call `api.*`, which does not exist outside Electron.
  // The stub records what the card would have done. It has to exist BEFORE
  // the bundle is imported: `lib.js` reads `window.quansiox` at import time.
  const calls = [];
  dom.window.quansiox = {
    api: new Proxy({}, {
      get: (_t, ns) => new Proxy({}, {
        get: (_t2, method) => async (...args) => { calls.push({ ns, method, args }); return {}; },
      }),
    }),
    events: { on: () => () => {} },
    meta: { handlers: [] },
  };

  const { build } = require('../scripts/build-renderer-test.js');
  const bundle = await build();
  const renderer = await import(bundle);
  const { Card, DiffView } = renderer;

  /* ---------------------------------------------------------------- W5.1 */
  await test('W5.1 the registry declares every card kind the reference has', () => {
    const cards = renderer.allCards();
    assert.ok(cards.length >= 48, `expected at least 48 card types, got ${cards.length}`);
    const byKind = {};
    for (const card of cards) byKind[card.kind] = (byKind[card.kind] ?? 0) + 1;
    assert.ok(byKind['send-message'] >= 29, 'the send-message cards are missing');
    assert.ok(byKind.event >= 12, 'the event cards are missing');
    for (const kind of ['message', 'user-attachment', 'mcp-app', 'notice', 'feedback', 'voice-call']) {
      assert.ok(byKind[kind] >= 1, `the "${kind}" card kind is missing`);
    }
  });

  await test('W5.1 every card has a descriptor with a title and a resolution', () => {
    for (const card of renderer.allCards()) {
      assert.ok(card.title, `${card.kind}:${card.type} has no title`);
      assert.ok(card.resolution, `${card.kind}:${card.type} has no resolution`);
      assert.ok(Array.isArray(card.fields), `${card.kind}:${card.type} has no field list`);
    }
  });

  await test('W5.1 an unknown card is described as unknown', () => {
    assert.equal(renderer.describeCard('send-message', 'not-a-card'), null);
  });

  /* ---------------------------------------------------------------- W5.2 */
  await test('W5.2 the local-tool permission card shows the action and the target', () => {
    render(React.createElement(Card, {
      kind: 'send-message',
      type: 'local-tool-permission',
      payload: {
        ask: {
          action: 'run-command',
          target: 'npm publish',
          description: 'publishes the package',
          recipientName: 'the release agent',
        },
      },
      resolutionId: 'cfm-1',
    }));
    assert.ok(screen.getByText('Run this on your computer'), 'the title must be shown');
    assert.ok(screen.getByText('run-command'), 'the action must be shown');
    assert.ok(screen.getByText('npm publish'), 'the target must be shown');
    assert.ok(screen.getByText('the release agent'), 'the recipient must be shown');
    assert.ok(screen.getByText('Allow once'), 'the decision must be offered');
    assert.ok(screen.getByText('Deny'), 'the denial must be offered');
  });

  await test('W5.2 the auto-review card offers the rule it would add', () => {
    render(React.createElement(Card, {
      kind: 'send-message',
      type: 'auto-review-approval',
      payload: { approval: { surface: 'bot_share', command: 'git push', proposedAllowRule: '/^git push/' } },
      resolutionId: 'cfm-2',
    }));
    assert.ok(screen.getByText('Safety review'));
    assert.ok(screen.getByText('/^git push/'), 'the proposed rule must be shown');
  });

  await test('W5.2 the app-secrets card lists what it needs', () => {
    render(React.createElement(Card, {
      kind: 'send-message',
      type: 'app-secrets-request',
      payload: { request: { secrets: [{ name: 'API_KEY', description: 'the service key' }] } },
      resolutionId: 'cfm-3',
    }));
    assert.ok(screen.getByText('The app needs secrets'));
    assert.ok(screen.getByText('API_KEY'));
  });

  /* ---------------------------------------------------------------- W5.3 */
  await test('W5.3 a draft card shows the draft and can be edited', () => {
    render(React.createElement(Card, {
      kind: 'send-message',
      type: 'email-draft',
      payload: { draft: { to: 'a@b.c', subject: 'Hello', body: 'first draft' } },
      interactionId: 'draft_1',
    }));
    assert.ok(screen.getByText('Email draft'));
    assert.ok(screen.getByText('a@b.c'));
    const box = screen.getByDisplayValue('first draft');
    fireEvent.change(box, { target: { value: 'edited draft' } });
    assert.equal(screen.getByDisplayValue('edited draft').value, 'edited draft');
    assert.ok(screen.getByText('Send'));
    assert.ok(screen.getByText('Discard'));
  });

  /* ---------------------------------------------------------------- W5.5 */
  await test('W5.5 the other card kinds render', () => {
    const cases = [
      ['event', 'task-changed', { task: { title: 'write the report' } }, 'Task changed'],
      ['event', 'bot-added', { bot: { name: 'Researcher' } }, 'Agent added'],
      ['notice', 'notice', { text: 'the vault is locked' }, 'Notice'],
      ['feedback', 'feedback', { state: 'sent', sentiment: 'inaccurate' }, 'Feedback'],
      ['voice-call', 'voice-call', { call: { durationMs: 65_000, ending: 'goodbye' } }, 'Voice call'],
      ['user-attachment', 'user-attachment', { file_path: '/tmp/a.txt' }, 'Your attachment'],
    ];
    for (const [kind, type, payload, title] of cases) {
      cleanup();
      render(React.createElement(Card, { kind, type, payload }));
      assert.ok(screen.getByText(title), `${kind}:${type} must render its title`);
    }
  });

  await test('W5.5 an unknown card is shown raw rather than swallowed', () => {
    render(React.createElement(Card, { kind: 'send-message', type: 'who-knows', payload: { hello: 'world' } }));
    assert.ok(screen.getByText(/hello/), 'the raw payload must be visible');
  });

  /* ---------------------------------------------------------------- W5.6 */
  await test('W5.6 a settled card shows an outcome, not buttons', () => {
    render(React.createElement(Card, {
      kind: 'send-message',
      type: 'local-tool-permission',
      payload: { ask: { action: 'run-command', target: 'ls' } },
      resolutionId: 'cfm-4',
      resolution: { pending: false, state: 'denied', text: 'The user declined this action.' },
    }));
    assert.equal(screen.queryByText('Allow once'), null, 'a settled card must not offer a decision');
    assert.ok(screen.getByText(/declined/i), 'the outcome must be shown');
  });

  /* ---------------------------------------------------------------- W5.7 */
  await test('W5.7 the components are covered: the card renders inside a real DOM', () => {
    const { container } = render(React.createElement(Card, {
      kind: 'send-message',
      type: 'text',
      payload: { content: 'hello from the agent' },
    }));
    assert.ok(container.querySelector('.card'), 'the card element must be in the DOM');
    assert.ok(container.textContent.includes('hello from the agent'));
  });

  /* ---------------------------------------------------------------- W5.9 */
  await test('W5.9 no component carries a raw colour', () => {
    const lint = require('node:child_process').execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'lint-renderer.js')],
      { encoding: 'utf8' },
    );
    assert.match(lint, /renderer style lint: OK/);
  });

  /* --------------------------------------------------------------- W5.11 */
  await test('W5.11 the diff view renders both sides of a diff', () => {
    const diff = [
      '@@ -1,3 +1,3 @@',
      ' context',
      '-removed line',
      '+added line',
      ' tail',
    ].join('\n');
    render(React.createElement(DiffView, { diff }));
    assert.ok(screen.getByText('removed line'), 'the removed line must be shown');
    assert.ok(screen.getByText('added line'), 'the added line must be shown');
    assert.ok(screen.getByText('context'), 'the context must be shown');
  });

  await test('W5.11 the diff view says so when there is no diff', () => {
    render(React.createElement(DiffView, { diff: '' }));
    assert.ok(screen.getByText(/no changes/i));
  });

  /* ---------------------------------------------------------------- W5.8 */
  await test('W5.8 the renderer is organised into bounded contexts', () => {
    const { describe, contextById, contextsUsing } = require('../src/shared/contexts.js');
    const map = describe();
    assert.equal(map.count, 19, 'the renderer has 19 bounded contexts, like the reference');
    for (const context of map.contexts) {
      assert.ok(context.id, 'a context needs an id');
      assert.ok(context.members.length, `${context.id} owns no state`);
      assert.ok(context.ports.length, `${context.id} depends on nothing`);
    }
    // Every port is a namespace the app actually has.
    require('../src/main/ipc/namespaces.js');
    const { allHandlers } = require('../src/main/ipc/registry.js');
    const namespaces = new Set(Object.keys(allHandlers));
    for (const port of map.ports) {
      assert.ok(namespaces.has(port), `the "${port}" port must be a real IPC namespace`);
    }
    // The contexts that need the vault, and the ones that need the agent.
    assert.ok(contextsUsing('secrets').includes('vault'), 'the vault context depends on the secrets namespace');
    assert.ok(contextsUsing('permissions').includes('permissions'));
    assert.ok(contextsUsing('agent').includes('send'));
    assert.ok(contextById('permissions').members.includes('toolMatrix'));
  });

  await test('W5.8 the context map is reachable over IPC', () => {
    require('../src/main/ipc/namespaces.js');
    const { allHandlers } = require('../src/main/ipc/registry.js');
    const contexts = allHandlers.contexts;
    assert.ok(contexts, 'the contexts namespace must exist');
    const map = contexts.list();
    assert.equal(map.count, 19);
    assert.ok(map.ports.includes('permissions'));
  });

  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nW5 UI tests FAILED');
    process.exit(1);
  }
  console.log(`\nW5 UI: ${results.length} checks OK`);
})();
