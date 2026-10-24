'use strict';
/* Capture-service test — fakes desktopCapturer (thumbnail images + sources). */
const Module = require('node:module');
const assert = require('node:assert');

const png1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const fakeThumbnail = {
  toDataURL: () => `data:image/png;base64,${png1x1}`,
};
const sourcesByType = {
  screen: [
    { id: 'screen:0', name: 'Entire Screen', thumbnail: fakeThumbnail },
    { id: 'screen:1', name: 'Second Display', thumbnail: fakeThumbnail },
  ],
  window: [{ id: 'window:1', name: 'Safari', thumbnail: fakeThumbnail }],
};
const calls = [];
const fakeDesktopCapturer = {
  async getSources(opts) {
    calls.push(opts);
    return sourcesByType[opts.types[0]] ?? [];
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-capture.js');
  return origResolve.call(this, req, ...rest);
};
require('./stub-electron-capture.js').__setDesktopCapturer(fakeDesktopCapturer);

const { captureService } = require('../src/main/services/captureService.js');

(async () => {
  // screen capture returns a ready-to-attach record
  const shot = await captureService.capture({ target: 'screen' });
  assert(shot.name.startsWith('screenshot-screen-') && shot.name.endsWith('.png'), 'named');
  assert.strictEqual(shot.mimeType, 'image/png');
  assert.strictEqual(shot.data, png1x1, 'base64 payload extracted from data URL');
  assert(shot.sourceName === 'Entire Screen', 'source label');

  // index selects among screens
  const second = await captureService.capture({ target: 'screen', index: 1 });
  assert.strictEqual(second.sourceName, 'Second Display');
  // out-of-range index clamps
  const clamped = await captureService.capture({ target: 'screen', index: 99 });
  assert.strictEqual(clamped.sourceName, 'Second Display', 'index clamped');

  // window target
  const win = await captureService.capture({ target: 'window' });
  assert.strictEqual(win.sourceName, 'Safari');

  // listing sources (no thumbnails requested)
  const screens = await captureService.listSources('screen');
  assert.deepStrictEqual(
    screens.map((s) => s.name),
    ['Entire Screen', 'Second Display']
  );

  // thumbnail size capped for privacy/perf
  assert(calls.every((c) => c.thumbnailSize.width <= 1920), 'thumbnail size capped');

  console.log('CAPTURE SMOKE OK — screen, window, index clamp, listing all pass');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
