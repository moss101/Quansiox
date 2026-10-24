'use strict';
/* Stubbed electron for browser/render tests: injectable WebContentsView and
 * BrowserWindow with a fake CDP debugger, session, powerSaveBlocker. */
let WebContentsViewImpl = class {};
let BrowserWindowImpl = class {};
const created = [];

const state = { blockerStarts: 0, blockerStops: 0 };

const stub = {
  app: {
    getPath: (k) =>
      require('node:path').join(process.env.QUANSIOX_TEST_USERDATA ?? require('node:os').tmpdir(), k),
  },
  get WebContentsView() { return WebContentsViewImpl; },
  get BrowserWindow() { return BrowserWindowImpl; },
  ipcMain: { on: () => {}, handle: () => {} },
  session: { fromPartition: () => ({ on: () => {} }) },
  powerSaveBlocker: {
    start: () => { state.blockerStarts += 1; return 1; },
    stop: () => { state.blockerStops += 1; },
    isStarted: (id) => id === 1 && state.blockerStarts > state.blockerStops,
  },
  __setWebContentsView(impl) { WebContentsViewImpl = impl; },
  __setBrowserWindow(impl) {
    BrowserWindowImpl = impl;
    BrowserWindowImpl.getAllWindows = () => created.filter((w) => !w.isDestroyed());
  },
  __created: created,
  __state: state,
};
module.exports = stub;
