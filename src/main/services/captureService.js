'use strict';
/**
 * Capture service — screenshot the screen (or a window) for attachment,
 * Manus-captureService-style but built on Electron's desktopCapturer
 * (no helper app needed). Returns a data URL ready for image attachments.
 */
const { desktopCapturer } = require('electron');

const MAX_EDGE = 1920;

async function capture({ target = 'screen', index = 0 } = {}) {
  const sources = await desktopCapturer.getSources({
    types: [target === 'window' ? 'window' : 'screen'],
    thumbnailSize: { width: MAX_EDGE, height: MAX_EDGE },
    fetchWindowIcons: false,
  });
  if (!sources.length) throw new Error(`no ${target} sources available`);
  const source = sources[Math.min(index, sources.length - 1)];
  const dataUrl = source.thumbnail.toDataURL();
  if (!dataUrl.startsWith('data:image/')) throw new Error('capture produced no image');
  return {
    name: `screenshot-${target}-${Date.now()}.png`,
    mimeType: 'image/png',
    data: dataUrl.split(',')[1],
    sourceName: source.name,
  };
}

/** List capture targets (screens/windows) so the UI can label them. */
async function listSources(target = 'screen') {
  const sources = await desktopCapturer.getSources({
    types: [target === 'window' ? 'window' : 'screen'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return sources.map((s, i) => ({ index: i, name: s.name, id: s.id }));
}

module.exports = { captureService: { capture, listSources } };
