'use strict';
/* Stubbed electron module for plain-node smoke tests (test/smoke.js).
 * Set QUANSIOX_TEST_USERDATA for test isolation. */
module.exports = {
  app: {
    getPath: (k) =>
      require('node:path').join(process.env.QUANSIOX_TEST_USERDATA ?? require('node:os').tmpdir(), k),
  },
  BrowserWindow: class BrowserWindow {},
  ipcMain: { on: () => {}, handle: () => {} },
  desktopCapturer: {
    async getSources() {
      // 1x1 png data URL
      return [{ thumbnail: { toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ', getSize: () => ({ width: 1280, height: 800 }) } }];
    },
  },
};
