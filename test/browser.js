'use strict';
/* Browser-service test — fakes WebContentsView + CDP debugger.
 * Exercises the Manus-pattern mechanics: snapshot refs + snapshotId,
 * staleness refusals, click coordinate dispatch, console ring, dialogs. */
const Module = require('node:module');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

process.env.QUANSIOX_TEST_USERDATA = require('node:fs').mkdtempSync('/tmp/qx-browser-test-');

const commands = [];
let axTree = null;

function fakeWebContents() {
  const wc = new EventEmitter();
  wc.debugger = {
    attached: false,
    isAttached() { return this.attached; },
    attach() { this.attached = true; },
    detach() { this.attached = false; },
    async sendCommand(method, params) {
      commands.push({ method, params });
      if (method === 'Accessibility.getFullAXTree') return axTree;
      if (method === 'DOMSnapshot.captureSnapshot') {
        return { documents: [{ nodes: { backendNodeId: [10, 11] }, layout: { nodeIndex: [0, 1], bounds: [[0, 0, 100, 40], [0, 50, 80, 30]] } }] };
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [10, 20, 60, 20, 60, 50, 10, 50] } }; // quad
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: true } } };
      if (method === 'Runtime.evaluate') return { result: { value: params?.expression?.includes('Boolean') ? true : 'eval-result' } };
      return {};
    },
    on() {},
  };
  wc.getURL = () => 'https://example.com/page';
  wc.getTitle = () => 'Example Page';
  wc.isLoadingMainFrame = () => false;
  wc.loadURL = async () => { wc.emit('did-navigate'); };
  wc.capturePage = async () => ({ toDataURL: () => 'data:image/png;base64,AAAA', getSize: () => ({ width: 800, height: 600 }) });
  wc.setWindowOpenHandler = () => {};
  wc.close = () => {};
  wc.once = wc.once.bind(wc);
  wc.removeListener = wc.removeListener.bind(wc);
  return wc;
}

class FakeWebContentsView {
  constructor() {
    this.webContents = fakeWebContents();
    this._bounds = null;
  }
  setBounds(b) { this._bounds = b; }
  getBounds() { return this._bounds; }
}

class FakeBrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.contentView = {
      children: [],
      addChildView: (v) => this.contentView.children.push(v),
      removeChildView: (v) => { this.contentView.children = this.contentView.children.filter((c) => c !== v); },
    };
    this._destroyed = false;
    stub.__created.push(this);
  }
  loadFile() {}
  getContentSize() { return [1200, 800]; }
  setTitle() {}
  show() {}
  focus() {}
  isDestroyed() { return this._destroyed; }
  close() { this._destroyed = true; this.emit('closed'); }
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-browser.js');
  return origResolve.call(this, req, ...rest);
};
const stub = require('./stub-electron-browser.js');
stub.__setWebContentsView(FakeWebContentsView);
stub.__setBrowserWindow(FakeBrowserWindow);

// Quiet settings service dependency (defaults allow browser).
process.env.QUANSIOX_USER_DATA_DIR = process.env.QUANSIOX_TEST_USERDATA;

const { classifyAppName, classifyShell } = require('../src/coordinator/hostBrowser.js');
assert.strictEqual(classifyAppName('Safari').kind, 'browser-app');
assert.strictEqual(classifyAppName('Google Chrome').kind, 'browser-app');
assert.strictEqual(classifyAppName('https://example.com').url, 'https://example.com');
assert.strictEqual(classifyShell('open https://example.com/path').url, 'https://example.com/path');
assert.strictEqual(classifyShell('open -a Safari').kind, 'browser-app');
assert.strictEqual(classifyShell('open -a Safari https://example.com').url, 'https://example.com');
assert.strictEqual(classifyShell('ls'), null);
assert.strictEqual(classifyShell('open notes.txt'), null);
assert.strictEqual(classifyShell('curl https://example.com'), null);
assert.strictEqual(classifyShell('open https://example.com && echo hi').url, 'https://example.com');
assert.strictEqual(classifyShell('osascript -e \'tell application "Safari" to activate\'').kind, 'browser-app');
assert.strictEqual(classifyAppName('Finder'), null);

const { browserService } = require('../src/main/services/browserService.js');

(async () => {
  axTree = {
    nodes: [
      { nodeId: 1, backendDOMNodeId: 10, role: { value: 'button' }, name: { value: 'Sign in' }, childIds: [] },
      { nodeId: 2, backendDOMNodeId: 11, role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: '' }, childIds: [] },
    ],
  };

  // 1. open() creates a browser + tab and reports url/title.
  const opened = await browserService.open('s1', { url: 'https://example.com' });
  assert.match(opened, /opened https:\/\/example\.com/, 'open reports url');
  const state1 = browserService.state('s1');
  assert.strictEqual(state1.active, true);
  assert.strictEqual(state1.presented, true, 'open presents the page on the agent computer');
  assert.strictEqual(state1.url, 'https://example.com/page');
  assert.strictEqual(state1.title, 'Example Page');
  // GPA G6: unhosted (background) pointer input is a real dispatch, not a
  // refusal — CDP input does not need the view on screen.
  const backgroundClick = await browserService.act('s1', 'click', { x: 10, y: 10 });
  assert.match(backgroundClick, /clicked \(10, 10\)/, 'background input dispatches');
  assert.ok(commands.some((c) => c.method === 'Input.dispatchMouseEvent'), 'hidden view receives mouse events');
  const { BrowserWindow } = require('electron');
  const host = new BrowserWindow();
  browserService.attachWindow('s1', host);

  // 2. snapshot() yields refs + snapshotId + header (Manus format).
  const snap = await browserService.snapshot('s1');
  assert.match(snap.text, /snapshot_id=snap_[0-9a-f-]+ documentRevision=\d+/);
  assert.match(snap.text, /button "Sign in" \[ref=e1\]/);
  assert.match(snap.text, /textbox "Email" \[ref=e2\]/);
  assert.ok(snap.refCount >= 2, 'refs assigned');

  // 3. click by ref dispatches CDP mouse events at the rect center.
  const click = await browserService.act('s1', 'click', { ref: 'e1', snapshot_id: snap.snapshotId });
  assert.match(click, /clicked ref=e1/);
  const mouse = commands.filter((c) => c.method === 'Input.dispatchMouseEvent');
  assert.ok(mouse.length >= 2, 'mousePressed + mouseReleased dispatched');
  assert.strictEqual(mouse[0].params.button, 'left');

  // 4. stale snapshot_id is refused with taxonomy guidance.
  const stale = await browserService.act('s1', 'click', { ref: 'e1', snapshot_id: 'snap_old' });
  assert.strictEqual(stale.__browserError, 'STALE_PAGE');

  // 5. unknown ref → STALE_REF.
  const noref = await browserService.act('s1', 'click', { ref: 'e99', snapshot_id: snap.snapshotId });
  assert.strictEqual(noref.__browserError, 'STALE_REF');

  // 6. type via insertText (+ Enter when submit).
  const typed = await browserService.act('s1', 'type', { ref: 'e2', text: 'hi@example.com', submit: true });
  assert.match(typed, /typed 14 chars \+ Enter/);
  assert.ok(commands.some((c) => c.method === 'Input.insertText'), 'insertText dispatched');

  // 7. fill uses native-setter + input/change events (Manus fill pattern).
  const filled = await browserService.act('s1', 'fill', { ref: 'e2', value: 'x@y.z' });
  assert.match(filled, /filled ref=e2/);
  const callFn = commands.filter((c) => c.method === 'Runtime.callFunctionOn');
  assert.ok(callFn.length >= 1, 'callFunctionOn used for fill');
  assert.ok(
    callFn.some((c) => /new Event\('input'/.test(c.params?.functionDeclaration ?? '')),
    'fill dispatches input/change events via native setter'
  );

  // 8. console ring buffer.
  const tab = browserService._activeTab('s1');
  tab.console.push('log line 1', 'log line 2');
  const lines = await browserService.act('s1', 'console', { limit: 2 });
  assert.deepStrictEqual(lines, ['log line 1', 'log line 2']);

  // 9. dialog queue + handle_dialog.
  let dialogResponded = null;
  tab.dialog = { message: 'Are you sure?', type: 'confirm', respond: (accept, text) => { dialogResponded = { accept, text }; } };
  const handled = await browserService.act('s1', 'handle_dialog', { accept: true });
  assert.match(handled, /accepted dialog: "Are you sure\?"/);
  assert.deepStrictEqual(dialogResponded, { accept: true, text: '' });

  // 10. screenshot returns data url.
  const shot = await browserService.act('s1', 'screenshot', {});
  assert.strictEqual(shot.data, 'data:image/png;base64,AAAA');

  // 11. tabs lifecycle: new/list/activate/close.
  await browserService.tabs('s1', 'new', { url: 'https://example.com/2' });
  const tabs = await browserService.tabs('s1', 'list');
  assert.strictEqual(tabs.length, 2);
  await browserService.tabs('s1', 'activate', { tabId: tabs[0].tabId });
  assert.strictEqual(browserService.state('s1').activeTabId, tabs[0].tabId);
  await browserService.tabs('s1', 'close', { tabId: tabs[1].tabId });
  assert.strictEqual((await browserService.tabs('s1', 'list')).length, 1);

  // 12. destroy tears down.
  assert.strictEqual(browserService.dock('s1', host, { x: 12, y: 40, width: 320, height: 180 }), true);
  assert.strictEqual(browserService.state('s1').docked, true, 'page is docked in the computer');
  const view = browserService._activeTab('s1').view;
  assert.deepStrictEqual(view.getBounds(), { x: 12, y: 40, width: 320, height: 180 });
  assert.ok(host.contentView.children.includes(view), 'live page is a child of the workspace window');
  assert.strictEqual(browserService.undock('s1', host), true);
  assert.strictEqual(host.contentView.children.length, 0);
  const hidden = browserService.hide('s1');
  assert.strictEqual(hidden.presented, false);

  // 13. download tracking (GPA G7): progress + completion, bounded history.
  const item = new EventEmitter();
  let received = 0;
  item.getFilename = () => 'report.pdf';
  item.getURL = () => 'https://example.com/report.pdf';
  item.getMimeType = () => 'application/pdf';
  item.getTotalBytes = () => 1000;
  item.getReceivedBytes = () => received;
  item.setSavePath = (p) => { item.savedTo = p; };
  const rec = browserService._trackDownload('s1', item);
  assert.strictEqual(rec.state, 'progressing');
  assert.match(item.savedTo, /browser-downloads\/s1\//, 'saved under the session download dir');
  assert.strictEqual(browserService.downloadsFor('s1')[0].id, rec.id);
  received = 500; item.emit('updated', {}, 'progressing');
  assert.strictEqual(browserService.downloadsFor('s1')[0].receivedBytes, 500);
  received = 1000; item.emit('done', {}, 'completed');
  const done = browserService.downloadsFor('s1')[0];
  assert.strictEqual(done.state, 'completed');
  assert.ok(done.completedAt > 0);
  assert.strictEqual(browserService.clearDownloads('s1').length, 0, 'completed downloads clear');

  browserService.destroy('s1');
  assert.strictEqual(browserService.state('s1').active, false);

  console.log('browser test: ALL OK');
  process.exit(0);
})().catch((error) => {
  console.error('browser test FAILED:', error);
  process.exit(1);
});
