'use strict';
/* Stubbed electron for playback/update-flow tests: injectable BrowserWindow
 * plus a getAllWindows() view so emitEvent works. */
let BrowserWindowImpl = class {};
const created = [];
const state = { relaunched: 0, exited: 0 };

const stub = {
  app: {
    getPath: (k) =>
      require('node:path').join(process.env.QUANSIOX_TEST_USERDATA ?? require('node:os').tmpdir(), k),
    get isPackaged() {
      return String(process.env.QUANSIOX_TEST_PACKAGED ?? '') === '1';
    },
    relaunch: () => { state.relaunched += 1; },
    exit: () => { state.exited += 1; },
  },
  get BrowserWindow() {
    return BrowserWindowImpl;
  },
  ipcMain: { on: () => {}, handle: () => {} },
  shell: { showItemInFolder: () => {} },
  __setBrowserWindow(impl) {
    BrowserWindowImpl = impl;
    BrowserWindowImpl.getAllWindows = () => created.filter((w) => !w.isDestroyed());
  },
  __created: created,
  __state: state,
};
module.exports = stub;
