'use strict';
/* Render service test — the Manus utilityHost render_pdf/render_png pattern
 * with a stubbed hidden BrowserWindow + fake CDP debugger. */
const Module = require('node:module');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync('/tmp/qx-render-test-');
process.env.QUANSIOX_TEST_USERDATA = tmp;
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const commands = [];

class FakeWebContents {
  constructor() {
    const self = this;
    this._metrics = { cssContentSize: { width: 800, height: 1200 } };
    this.debugger = {
      attached: false,
      isAttached() { return this.attached; },
      attach() { this.attached = true; },
      detach() { this.attached = false; },
      async sendCommand(method, params) {
        commands.push({ method, params });
        if (method === 'Page.getLayoutMetrics') {
          return self._metrics;
        }
        if (method === 'Page.captureScreenshot') {
          self._clip = params.clip;
          return { data: Buffer.from('fake-png-bytes').toString('base64') };
        }
        return {};
      },
      on() {},
    };
  }
  async loadFile(f) { this._loaded = f; }
  async executeJavaScript() { return undefined; } // fonts.ready wait
  async printToPDF(opts) { this._pdf = opts; return Buffer.from('fake-pdf-bytes'); }
  getURL() { return `file://${this._loaded ?? ''}`; }
}

class FakeBrowserWindow {
  constructor(opts) {
    this._opts = opts;
    this.webContents = new FakeWebContents();
    this._destroyed = false;
    stub.__created.push(this);
  }
  async loadFile(f) { return this.webContents.loadFile(f); }
  setContentSize(w, h) { this._contentSize = [w, h]; }
  getContentSize() { return this._contentSize ?? [1280, 720]; }
  destroy() { this._destroyed = true; }
  isDestroyed() { return this._destroyed; }
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-browser.js');
  return origResolve.call(this, req, ...rest);
};
const stub = require('./stub-electron-browser.js');
stub.__setBrowserWindow(FakeBrowserWindow);

// Workspace for path resolution.
const workspace = path.join(tmp, 'ws');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'page.html'), '<html><body>hi</body></html>');
process.env.QUANSIOX_WORKSPACE = workspace;

const { renderService } = require('../src/main/services/renderService.js');

(async () => {
  // resolveInWorkspace uses settingsService workspaceRoot — point it.
  const { settingsService } = require('../src/main/services/settingsService.js');
  settingsService.save({ workspaceRoot: workspace });

  // 1. render_pdf writes a pdf next to the input.
  const pdf = await renderService.renderPdf({ input: 'page.html', cwd: workspace });
  assert.ok(pdf.path.endsWith('page.pdf'), `pdf path: ${pdf.path}`);
  assert.ok(fs.existsSync(pdf.path), 'pdf written');
  assert.strictEqual(pdf.bytes, 'fake-pdf-bytes'.length);
  const pdfWin = stub.__created[0];
  assert.strictEqual(pdfWin._opts.show, false, 'hidden window');
  assert.strictEqual(pdfWin.webContents._pdf.pageSize, 'A4');
  assert.strictEqual(pdfWin.webContents._pdf.printBackground, true);

  // 2. render_png captures beyond the viewport with a content-size clip.
  const png = await renderService.renderPng({ input: 'page.html', cwd: workspace, scale: 2 });
  assert.ok(png.path.endsWith('page.png'));
  assert.ok(fs.existsSync(png.path));
  assert.strictEqual(png.bytes, 'fake-png-bytes'.length);
  const capture = commands.find((c) => c.method === 'Page.captureScreenshot');
  assert.ok(capture, 'CDP capture dispatched');
  assert.strictEqual(capture.params.captureBeyondViewport, true);
  assert.strictEqual(capture.params.clip.width, 800);
  assert.strictEqual(capture.params.clip.height, 1200);
  assert.strictEqual(capture.params.clip.scale, 2);
  assert.strictEqual(png.width, 1600, 'scaled dims reported');

  // 3. output path override works.
  const png2 = await renderService.renderPng({ input: 'page.html', output: 'out/shot.png', cwd: workspace });
  assert.strictEqual(png2.path, path.join(workspace, 'out', 'shot.png'));
  assert.ok(fs.existsSync(png2.path));

  // 4. missing input errors cleanly.
  await assert.rejects(() => renderService.renderPdf({ input: 'nope.html', cwd: workspace }), /not found/);

  console.log('render test: ALL OK');
  process.exit(0);
})().catch((error) => {
  console.error('render test FAILED:', error);
  process.exit(1);
});
