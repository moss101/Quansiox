'use strict';
/* Stubbed electron for test/capture.js — desktopCapturer injected by the test. */
let desktopCapturerImpl = { getSources: async () => [] };
module.exports = {
  app: { getPath: () => '/tmp' },
  get desktopCapturer() {
    return desktopCapturerImpl;
  },
  BrowserWindow: class {},
  ipcMain: { on: () => {}, handle: () => {} },
  __setDesktopCapturer(impl) {
    desktopCapturerImpl = impl;
  },
};
