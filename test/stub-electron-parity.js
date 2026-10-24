'use strict';
/* Electron stand-in for the parity loop.
 * Screenshots carry a real 9x8 BGRA bitmap so the shipped dHash path runs.
 * Browser fakes are injected the same way test/stub-electron-browser.js does. */
let WebContentsViewImpl = class {};
let BrowserWindowImpl = class {};
const created = [];

function thumbnail() {
  const width = 9;
  const height = 8;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i / 4) % 255;
    data[i + 1] = 40;
    data[i + 2] = 80;
    data[i + 3] = 255;
  }
  const image = {
    resize() { return image; },
    getBitmap() { return data; },
    toDataURL() { return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'; },
    getSize() { return { width: 1280, height: 800 }; },
  };
  return image;
}

module.exports = {
  app: {
    getPath: (k) =>
      require('node:path').join(process.env.QUANSIOX_TEST_USERDATA ?? require('node:os').tmpdir(), k),
  },
  get WebContentsView() { return WebContentsViewImpl; },
  get BrowserWindow() { return BrowserWindowImpl; },
  ipcMain: { on: () => {}, handle: () => {} },
  session: { fromPartition: () => ({ on: () => {} }) },
  desktopCapturer: {
    async getSources() {
      return [{ thumbnail: thumbnail() }];
    },
  },
  powerSaveBlocker: {
    start: () => 1,
    stop: () => {},
    isStarted: () => false,
  },
  __setWebContentsView(impl) { WebContentsViewImpl = impl; },
  __setBrowserWindow(impl) { BrowserWindowImpl = impl; },
  __created: created,
};
