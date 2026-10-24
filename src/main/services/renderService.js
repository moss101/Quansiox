'use strict';
/**
 * Render service — Quansiox port of Manus Studio's utilityHost
 * render_pdf / render_png (dist/utilityHost/utilityHostService.js:581-786):
 *
 *  - hidden BrowserWindow on a dedicated session partition
 *  - load the input file, wait for document.fonts.ready (+ 300ms settle)
 *  - PDF: webContents.printToPDF (A4)
 *  - PNG: CDP Page.captureScreenshot with captureBeyondViewport, clip grown
 *    to the full content size (capped 16384px, scale ≤ 2), auto-grow retry
 *  - renders are serialized through a promise queue (one at a time)
 *  - input paths are workspace-escape checked; outputs land in the
 *    workspace (or next to the input when absolute inside the workspace)
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_DIM = 16384;
const SCALE_CAP = 2;
const SETTLE_MS = 300;
const FONTS_TIMEOUT_MS = 5_000;

const queue = (() => {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn); // previous failure must not break the queue
    tail = run.catch(() => {});
    return run;
  };
})();

function resolveInWorkspace(inputPath, cwd) {
  // The exec service already exposes workspace-safe resolution.
  const { execService } = require('./execService');
  return execService.resolveInWorkspace(inputPath, cwd);
}

async function loadHidden(win, target) {
  await win.loadFile(target);
  await win.webContents.executeJavaScript(`(async () => {
    try { await Promise.race([
      document.fonts.ready,
      new Promise((r) => setTimeout(r, ${FONTS_TIMEOUT_MS})),
    ]); } catch {}
    await new Promise((r) => setTimeout(r, ${SETTLE_MS}));
  })()`);
}

/**
 * Render a local HTML file (or Markdown converted to HTML by the caller) to
 * a PDF next to it (or at outputPath inside the workspace).
 */
async function renderPdf({ input, output, cwd, landscape = false }) {
  const { BrowserWindow } = require('electron');
  const target = resolveInWorkspace(input, cwd);
  if (!fs.existsSync(target)) throw new Error(`input not found: ${input}`);
  return queue(async () => {
    const win = new BrowserWindow({
      show: false, width: 1280, height: 720,
      webPreferences: { session: require('electron').session.fromPartition('qx-render') },
    });
    try {
      await loadHidden(win, target);
      const buffer = await win.webContents.printToPDF({
        pageSize: 'A4', printBackground: true, landscape: Boolean(landscape),
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      });
      const out = outputPathFor(target, output, cwd, '.pdf');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buffer);
      return { path: out, bytes: buffer.length };
    } finally {
      win.destroy();
    }
  });
}

/**
 * Render a local HTML file to a full-page PNG via CDP
 * (Page.captureScreenshot with captureBeyondViewport).
 */
async function renderPng({ input, output, cwd, scale = 1 }) {
  const { BrowserWindow } = require('electron');
  const target = resolveInWorkspace(input, cwd);
  if (!fs.existsSync(target)) throw new Error(`input not found: ${input}`);
  const zoom = Math.min(SCALE_CAP, Math.max(0.5, Number(scale) || 1));
  return queue(async () => {
    const win = new BrowserWindow({
      show: false, width: 1280, height: 720,
      webPreferences: { session: require('electron').session.fromPartition('qx-render') },
    });
    try {
      await loadHidden(win, target);
      const wc = win.webContents;
      if (!wc.debugger.isAttached?.()) wc.debugger.attach('qx-render');
      // Auto-grow: measure content, cap, capture beyond the viewport.
      const metrics = await wc.debugger.sendCommand('Page.getLayoutMetrics');
      let { width, height } = metrics?.cssContentSize ?? metrics?.contentSize ?? {};
      width = Math.min(MAX_DIM, Math.max(1, Math.ceil(width ?? 1280)));
      height = Math.min(MAX_DIM, Math.max(1, Math.ceil(height ?? 720)));
      // Give the renderer the room to lay out at full size, then re-measure.
      win.setContentSize(Math.min(2560, width), Math.min(MAX_DIM, height));
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const grown = await wc.debugger.sendCommand('Page.getLayoutMetrics');
      const size = grown?.cssContentSize ?? grown?.contentSize ?? {};
      width = Math.min(MAX_DIM, Math.max(1, Math.ceil(size.width ?? width)));
      height = Math.min(MAX_DIM, Math.max(1, Math.ceil(size.height ?? height)));
      const shot = await wc.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: zoom },
      });
      const buffer = Buffer.from(shot.data, 'base64');
      const out = outputPathFor(target, output, cwd, '.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buffer);
      return { path: out, bytes: buffer.length, width: Math.round(width * zoom), height: Math.round(height * zoom) };
    } finally {
      try { win.webContents.debugger.isAttached?.() && win.webContents.debugger.detach(); } catch {}
      win.destroy();
    }
  });
}

function outputPathFor(inputPath, output, cwd, ext) {
  if (output) return resolveInWorkspace(output, cwd);
  return inputPath.replace(/\.[^.]+$/, '') + ext;
}

module.exports = { renderService: { renderPdf, renderPng } };
