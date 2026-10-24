'use strict';
/* The UI parity of the composer and the command palette (W5.12 / W5.18).
 *
 *  - the composer offers @mentions (agents *and* files) as inline tokens,
 *    keyboard navigable and announced as a listbox
 *  - the / trigger offers the app's own commands next to the session ones
 *  - the attachment chips can be removed
 *  - a draft that differs from the last one sent is marked as revised
 *  - the footer counts the draft and says how to send it
 *  - the palette reaches every registry: agents, tools, skills, plugins,
 *    the settings surfaces and the actions — each with its source badge
 *
 * The React components are rendered with @testing-library/react in jsdom —
 * the components themselves are exercised, not a mock of them. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
global.KeyboardEvent = dom.window.KeyboardEvent;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.IS_REACT_ACT_ENVIRONMENT = true;
global.Range = dom.window.Range;
global.DocumentFragment = dom.window.DocumentFragment;
global.MutationObserver = dom.window.MutationObserver;
global.DOMParser = dom.window.DOMParser;
global.getSelection = dom.window.getSelection.bind(dom.window);

// jsdom has no layout: ProseMirror asks a Range for its rects.
const emptyRect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
dom.window.Range.prototype.getClientRects = function () { return Object.assign([], { item: () => null }); };
dom.window.Range.prototype.getBoundingClientRect = function () { return { ...emptyRect }; };
dom.window.Element.prototype.getClientRects = function () { return Object.assign([], { item: () => null }); };
dom.window.Element.prototype.getBoundingClientRect = function () { return { ...emptyRect }; };

const React = require('react');
const { render, cleanup, fireEvent, waitFor } = require('@testing-library/react');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', '.build');

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

/** The registries the components read. */
const AGENTS = [{ id: 'agt-1', name: 'Researcher', description: 'reads the papers', primary: true }];
const SKILLS = [{ id: 'sk-1', name: 'pdf', enabled: true }];
const PLUGINS = [{ id: 'plug-1', name: 'notion', kind: 'mcp', installed: false }];

(async () => {
  // The components call `api.*`, which does not exist outside Electron. The
  // stub answers the registries the palette reads. It has to exist BEFORE
  // the bundle is imported: `lib.js` reads `window.quansiox` at import time.
  dom.window.quansiox = {
    api: new Proxy({}, {
      get: (_t, ns) => new Proxy({}, {
        get: (_t2, method) => async () => {
          if (ns === 'agents' && method === 'list') return AGENTS;
          if (ns === 'skills' && method === 'list') return SKILLS;
          if (ns === 'marketplace' && method === 'list') return PLUGINS;
          if (ns === 'permissions' && method === 'state') {
            return { mode: 'workspace', matrix: { matrix: { tools: { shell: 'always_allow' } } } };
          }
          if (ns === 'secrets' && method === 'list') return [{ name: 'github_token', fields: ['token'] }];
          return {};
        },
      }),
    }),
    events: { on: () => () => {} },
    meta: { handlers: [] },
  };

  // The renderer sources are JSX, so the components are bundled with esbuild
  // first — the same bundler the app itself is built with. React stays
  // external so the test and the components share one React instance.
  fs.mkdirSync(OUT, { recursive: true });
  const entry = path.join(OUT, 'ui-parity-entry.js');
  fs.writeFileSync(entry, `
export { default as Composer } from '${path.join(ROOT, 'src', 'renderer-src', 'Composer.jsx')}';
export { default as Palette } from '${path.join(ROOT, 'src', 'renderer-src', 'Palette.jsx')}';
`);
  const outfile = path.join(OUT, 'ui-parity.cjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile,
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    jsx: 'automatic',
    logLevel: 'error',
  });
  const { Composer, Palette } = require(outfile);

  /* ------------------------------------------------------------ composer */
  await test('W5.12 the composer shows the draft size and the send hint', async () => {
    const editorRef = { current: null };
    render(React.createElement(Composer, {
      onSend: () => {}, running: false, onStop: () => {}, onAttach: () => {},
      attachments: [], onRemoveAttachment: () => {}, onSnap: () => {}, onCommand: () => {},
      fileEntries: [], onOpenPrompts: () => {}, editorRef,
    }));
    await waitFor(() => { if (!editorRef.current) throw new Error('no editor'); });
    const count = document.querySelector('[data-surface="composer-count"]');
    assert.ok(count, 'the count must be shown');
    assert.match(count.textContent, /chars/);
    assert.ok(document.querySelector('.composer-send-hint'), 'the send hint must be shown');
  });

  await test('W5.12 the attachment chips can be removed', async () => {
    const removed = [];
    render(React.createElement(Composer, {
      onSend: () => {}, running: false, onStop: () => {}, onAttach: () => {},
      attachments: [{ name: 'notes.txt', size: 2048 }],
      onRemoveAttachment: (i) => removed.push(i),
      onSnap: () => {}, onCommand: () => {}, fileEntries: [], onOpenPrompts: () => {},
    }));
    const chip = document.querySelector('.attachment-chip');
    assert.ok(chip, 'the chip must be rendered');
    const button = chip.querySelector('button[aria-label^="Remove"]');
    assert.ok(button, 'the chip needs a remove button');
    fireEvent.click(button);
    assert.deepEqual(removed, [0], 'the remove button must report the chip');
  });

  await test('W5.12 the @ trigger offers the agents and the files', async () => {
    const editorRef = { current: null };
    render(React.createElement(Composer, {
      onSend: () => {}, running: false, onStop: () => {}, onAttach: () => {},
      attachments: [], onRemoveAttachment: () => {}, onSnap: () => {}, onCommand: () => {},
      fileEntries: [{ path: 'src/app.js' }, { path: 'README.md' }],
      onOpenPrompts: () => {}, editorRef,
    }));
    await waitFor(() => { if (!editorRef.current) throw new Error('no editor'); });
    const editor = editorRef.current;
    editor.commands.focus('end');
    editor.commands.insertContent('@');
    await waitFor(() => { if (!document.querySelector('.cmd-popup')) throw new Error('no popup'); });
    const popup = document.querySelector('.cmd-popup');
    assert.equal(popup.getAttribute('role'), 'listbox', 'the popup is a listbox');
    const options = popup.querySelectorAll('[role="option"]');
    assert.ok(options.length >= 2, 'the agents and the files are offered');
    assert.match(popup.textContent, /Researcher/, 'the agent is offered');
    assert.match(popup.textContent, /src\/app\.js/, 'the file is offered');
    assert.ok(popup.querySelector('[aria-selected="true"]'), 'one option is selected');
  });

  await test('W5.12 picking a mention inserts an inline token', async () => {
    const editorRef = { current: null };
    render(React.createElement(Composer, {
      onSend: () => {}, running: false, onStop: () => {}, onAttach: () => {},
      attachments: [], onRemoveAttachment: () => {}, onSnap: () => {}, onCommand: () => {},
      fileEntries: [{ path: 'src/app.js' }], onOpenPrompts: () => {}, editorRef,
    }));
    await waitFor(() => { if (!editorRef.current) throw new Error('no editor'); });
    const editor = editorRef.current;
    editor.commands.focus('end');
    editor.commands.insertContent('@');
    await waitFor(() => { if (!document.querySelector('.cmd-popup')) throw new Error('no popup'); });
    fireEvent.keyDown(document.querySelector('.composer .ProseMirror'), { key: 'Enter' });
    await waitFor(() => { if (document.querySelector('.cmd-popup')) throw new Error('the popup stayed open'); });
    assert.match(editor.getHTML(), /data-type="mention"/, 'a mention node is inserted');
    assert.match(editor.getText(), /@Researcher/, 'the mention carries its label');
  });

  await test('W5.12 the mention list is keyboard navigable', async () => {
    const editorRef = { current: null };
    render(React.createElement(Composer, {
      onSend: () => {}, running: false, onStop: () => {}, onAttach: () => {},
      attachments: [], onRemoveAttachment: () => {}, onSnap: () => {}, onCommand: () => {},
      fileEntries: [{ path: 'src/app.js' }], onOpenPrompts: () => {}, editorRef,
    }));
    await waitFor(() => { if (!editorRef.current) throw new Error('no editor'); });
    const editor = editorRef.current;
    editor.commands.focus('end');
    editor.commands.insertContent('@');
    await waitFor(() => { if (!document.querySelector('.cmd-popup')) throw new Error('no popup'); });
    const first = document.querySelector('.cmd-popup [aria-selected="true"]').textContent;
    fireEvent.keyDown(document.querySelector('.composer .ProseMirror'), { key: 'ArrowDown' });
    await waitFor(() => {
      const selected = document.querySelector('.cmd-popup [aria-selected="true"]');
      if (!selected || selected.textContent === first) throw new Error('the selection did not move');
    });
    fireEvent.keyDown(document.querySelector('.composer .ProseMirror'), { key: 'Enter' });
    await waitFor(() => { if (document.querySelector('.cmd-popup')) throw new Error('the popup stayed open'); });
    assert.match(editor.getText(), /@src\/app\.js/, 'the highlighted mention is inserted');
  });

  await test('W5.12 the / trigger offers the app commands', async () => {
    const editorRef = { current: null };
    render(React.createElement(Composer, {
      onSend: () => {}, running: false, onStop: () => {}, onAttach: () => {},
      attachments: [], onRemoveAttachment: () => {}, onSnap: () => {}, onCommand: () => {},
      fileEntries: [], onOpenPrompts: () => {}, editorRef,
    }));
    await waitFor(() => { if (!editorRef.current) throw new Error('no editor'); });
    const editor = editorRef.current;
    editor.commands.focus('end');
    editor.commands.insertContent('/');
    await waitFor(() => { if (!document.querySelector('.cmd-popup')) throw new Error('no popup'); });
    const text = document.querySelector('.cmd-popup').textContent;
    assert.match(text, /\/settings/, 'the app commands are offered');
    assert.match(text, /\/new/, 'the session commands are offered');
    fireEvent.keyDown(document.querySelector('.composer .ProseMirror'), { key: 'Escape' });
    await waitFor(() => { if (document.querySelector('.cmd-popup')) throw new Error('the popup stayed open'); });
  });

  await test('W5.12 a draft that differs from the last send is marked as revised', async () => {
    const sent = [];
    const editorRef = { current: null };
    render(React.createElement(Composer, {
      onSend: (t) => sent.push(t), running: false, onStop: () => {}, onAttach: () => {},
      attachments: [], onRemoveAttachment: () => {}, onSnap: () => {}, onCommand: () => {},
      fileEntries: [], onOpenPrompts: () => {}, editorRef,
    }));
    await waitFor(() => { if (!editorRef.current) throw new Error('no editor'); });
    const editor = editorRef.current;
    const marker = () => document.querySelector('[data-surface="composer-revised"]');
    editor.commands.setContent('hello there');
    await waitFor(() => { if (marker()) throw new Error('nothing is revised before the first send'); });
    fireEvent.click(document.querySelector('.send-btn'));
    await waitFor(() => { if (!sent.length) throw new Error('nothing was sent'); });
    assert.equal(sent[0], 'hello there');
    await waitFor(() => { if (marker()) throw new Error('the marker stayed after the send'); });
    editor.commands.setContent('hello there, and more');
    await waitFor(() => { if (!marker()) throw new Error('the revised draft is not marked'); });
    editor.commands.setContent('hello there');
    await waitFor(() => { if (marker()) throw new Error('an unchanged draft is marked'); });
  });

  /* ------------------------------------------------------------- palette */
  await test('W5.18 the palette reaches every registry', async () => {
    render(React.createElement(Palette, {
      mode: 'all',
      sessions: [{ id: 's1', title: 'First chat' }],
      activeSessionId: 's1',
      actions: [{ id: 'new-session', title: 'New Bot' }],
      onClose: () => {},
    }));
    await waitFor(() => { if (!document.querySelector('[data-source="agent"]')) throw new Error('no agent row'); });
    const text = document.querySelector('.palette-list').textContent;
    assert.match(text, /Researcher/, 'the agents are listed');
    await waitFor(() => { if (!document.querySelector('[data-source="skill"]')) throw new Error('no skill row'); });
    await waitFor(() => { if (!document.querySelector('[data-source="plugin"]')) throw new Error('no plugin row'); });
    await waitFor(() => { if (!document.querySelector('[data-source="setting"]')) throw new Error('no setting row'); });
    const full = document.querySelector('.palette-list').textContent;
    assert.match(full, /pdf/, 'the skills are listed');
    assert.match(full, /notion/, 'the plugins are listed');
    assert.match(full, /Permission mode/, 'the permission mode is listed');
    assert.match(full, /Secrets vault/, 'the vault is listed');
    assert.match(full, /Updates/, 'the updates page is listed');
    assert.match(full, /New Bot/, 'the actions are listed');
  });

  await test('W5.18 every result carries a source badge', async () => {
    render(React.createElement(Palette, {
      mode: 'all',
      sessions: [{ id: 's1', title: 'First chat' }],
      activeSessionId: 's1',
      actions: [{ id: 'new-session', title: 'New Bot' }],
      onClose: () => {},
    }));
    await waitFor(() => { if (!document.querySelector('.palette-row')) throw new Error('no rows'); });
    for (const row of document.querySelectorAll('.palette-row')) {
      const badge = row.querySelector('.palette-badge');
      assert.ok(badge, `the row "${row.textContent}" has no source badge`);
      assert.ok(badge.dataset.source, 'the badge names the registry');
    }
  });

  await test('W5.18 the keyboard walks the results', async () => {
    const picked = [];
    render(React.createElement(Palette, {
      mode: 'all',
      sessions: [{ id: 's1', title: 'First chat' }],
      activeSessionId: 's1',
      actions: [{ id: 'new-session', title: 'New Bot' }],
      onClose: () => picked.push('closed'),
    }));
    await waitFor(() => { if (!document.querySelector('.palette-row')) throw new Error('no rows'); });
    const input = document.querySelector('.palette-input input');
    const first = document.querySelector('.palette-row');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const active = document.querySelector('.palette-row.active');
    assert.ok(active, 'something is active');
    assert.notEqual(active, first, 'the selection moved');
    fireEvent.keyDown(input, { key: 'Enter' });
    assert.ok(picked.includes('closed'), 'the palette closes on enter');
  });

  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nUI parity tests FAILED');
    process.exit(1);
  }
  console.log(`\nUI parity: ${results.length} checks OK`);
})().catch((e) => { console.error(e); process.exit(1); });
