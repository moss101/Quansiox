'use strict';
/* Stubbed electron for test/windows.js — BrowserWindow injected by the test. */
let BrowserWindowImpl = class {};
module.exports = {
  app: { getPath: () => '/tmp' },
  get BrowserWindow() {
    return BrowserWindowImpl;
  },
  ipcMain: { on: () => {}, handle: () => {} },
  __setBrowserWindow(impl) {
    BrowserWindowImpl = impl;
  },
};
