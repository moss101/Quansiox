'use strict';
/* The JavaScript canvas.
 *
 * A canvas in Grok Bot is not a document — it is a live JavaScript
 * application. The page imports a runtime module and a user module as blob
 * URLs, and the runtime's `mountCanvas(userUrl)` hands the user module an API
 * (`data`, `state`, `theme`, `render`, `el`).
 *
 * These tests pin that shape, and prove the page actually RUNS the module
 * rather than only shipping the markup.
 *
 * Electron-free: the page is rendered with jsdom, which executes the inline
 * bootstrap; the module mounting is checked by running the runtime's
 * `mountCanvas` against a blob URL.
 *
 * The reference's tool-name and schema facts this is modelled on:
 *   EditCanvas is tool #26 in Grok's 121-name list;
 *   the canvas page shape is `main-app.cjs` @ ~1809648.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-canvas-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const { canvasBundleService } = require('../src/main/services/canvasBundleService');

(async () => {
  /* ------------------------------------------------------------- the store */
  await test('a canvas bundle stores a user module and the data it reads', () => {
    const record = canvasBundleService.save({
      title: 'Sales chart',
      userModule: 'export default (api) => api.el("h1", { text: "hi" });',
      data: { series: [1, 2, 3] },
      state: { zoom: 1 },
    });
    assert.ok(record.id);
    assert.equal(record.title, 'Sales chart');
    assert.deepEqual(record.data, { series: [1, 2, 3] });
    const stored = canvasBundleService.get(record.id);
    assert.match(stored.userModule, /export default/);
    assert.equal(
      Buffer.byteLength(stored.userModule, 'utf8'), record.userModuleBytes,
      'the stored module must be the one that was saved',
    );
  });

  await test('a canvas needs a user module', () => {
    assert.throws(() => canvasBundleService.save({ title: 'empty' }), /needs a user module/);
  });

  await test('an oversized canvas module is refused', () => {
    const huge = 'x'.repeat(600 * 1024);
    assert.throws(() => canvasBundleService.save({ userModule: huge }), /too large/);
  });

  await test('the canvas list shows the live canvases', () => {
    canvasBundleService.save({ title: 'Second', userModule: 'export default () => {};' });
    const list = canvasBundleService.list();
    assert.ok(list.length >= 2);
    assert.ok(list.some((c) => c.title === 'Second'));
    // The list omits the module source (it is large).
    assert.equal(list[0].userModule, undefined);
  });

  /* ------------------------------------------------------------- the page */
  await test('the page has the reference\'s shape: #root, the bootstrap, the module mount', () => {
    const record = canvasBundleService.save({
      title: 'Shape',
      userModule: 'export default (api) => api.el("div");',
      data: { a: 1 },
    });
    const html = canvasBundleService.page(record);
    assert.match(html, /<div id="root">/);
    assert.match(html, /window\.__quansioxCanvas\s*=/);
    assert.match(html, /state:\s*new Map/);
    assert.match(html, /data:\s*new Map/);
    assert.match(html, /reportError/);
    assert.match(html, /type="module"/);
    assert.match(html, /new Blob\(\[bundle\.runtimeEsm\]/);
    assert.match(html, /new Blob\(\[bundle\.userModule\]/);
    assert.match(html, /runtimeModule\.mountCanvas\(userUrl\)/);
  });

  await test('the page carries the link guard', () => {
    const record = canvasBundleService.save({ title: 'Guard', userModule: 'export default () => {};' });
    const html = canvasBundleService.page(record);
    assert.match(html, /noopener noreferrer/);
    assert.match(html, /addEventListener\('click'/);
  });

  /* ---------------------------------------------------------------- the CSP */
  await test('the canvas page can import a blob module and nothing else', () => {
    const csp = canvasBundleService.contentSecurityPolicy();
    assert.match(csp, /script-src 'unsafe-inline' blob:/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-src 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /default-src 'none'/);
  });

  /* ------------------------------------------------------- the runtime API */
  await test('the runtime module exposes mountCanvas', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'renderer', 'canvas-runtime.js'), 'utf8',
    );
    assert.match(source, /export\s+async\s+function\s+mountCanvas/);
    assert.match(source, /__quansioxCanvas/);
    assert.match(source, /reportError/);
    assert.match(source, /render\s*\(/);
  });

  await test('the runtime hands the user module a working API', async () => {
    // Run the runtime's mountCanvas against a blob URL, in a DOM.
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://canvas.local/',
      runScripts: 'outside-only',
    });
    global.window = dom.window;
    global.document = dom.window.document;
    global.URL = dom.window.URL;
    global.Blob = dom.window.Blob;

    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'renderer', 'canvas-runtime.js'), 'utf8',
    );
    // Evaluate the module as a data URL import so its export is real.
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
    const runtime = await import(moduleUrl);

    // A user module that reads the API and renders into the page.
    const userSource = `
      export default (api) => {
        api.render(api.el('h1', { text: 'from the canvas' }));
        window.__seenData = api.data.get('series');
        window.__seenState = api.state.get('zoom');
      };
    `;
    const userUrl = `data:text/javascript;base64,${Buffer.from(userSource, 'utf8').toString('base64')}`;

    dom.window.__quansioxCanvas = {
      tokenParam: '',
      state: new Map([['zoom', 2]]),
      data: new Map([['series', [1, 2, 3]]]),
      reportError: () => {},
    };
    await runtime.mountCanvas(userUrl);

    assert.equal(dom.window.document.getElementById('root').textContent, 'from the canvas');
    // `render` replaces; `append` adds.
    const api = dom.window.__quansioxCanvas;
    api.append(api.el('span', { text: ' + more' }));
    assert.equal(dom.window.document.getElementById('root').textContent, 'from the canvas + more');
    assert.deepEqual(dom.window.__seenData, [1, 2, 3]);
    assert.equal(dom.window.__seenState, 2);
  });

  /* --------------------------------------------------------- the agent tool */
  await test('the model can create and list canvases', async () => {
    const { executeEcosystemTool } = require('../src/coordinator/ecosystemTools');
    const created = await executeEcosystemTool('edit_canvas', {
      title: 'Made by the agent',
      userModule: 'export default (api) => api.el("p", { text: "hi" });',
      data: { n: 1 },
    });
    assert.match(created, /saved the canvas "Made by the agent"/);
    assert.match(created, /qx-canvas:\/\//);
    const listed = await executeEcosystemTool('list_canvases', {});
    assert.match(listed, /Made by the agent/);
  });

  await test('the canvas tools are offered to the model', () => {
    const coordinator = require('../src/coordinator/index');
    const names = coordinator.allTools().map((t) => t.function.name);
    assert.ok(names.includes('edit_canvas'));
    assert.ok(names.includes('list_canvases'));
  });

  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\ncanvas tests FAILED');
    process.exit(1);
  }
  console.log(`\ncanvas: ${results.length} checks OK`);
})();
