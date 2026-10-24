'use strict';
/**
 * Visual verification of the new surfaces.
 *
 * The wiring and runtime gates prove the panels *mount* and the services
 * *work*. This proves they **look right** — it opens the packaged app's
 * settings dialog, clicks each new rail tab, and captures the window.
 *
 * Output: PNGs in work/reports/screenshots/ (or QUANSIOX_SHOT_DIR).
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

process.on('uncaughtException', (e) => {
  console.log('UNCAUGHT ' + e.stack);
  app.exit(1);
});

const PACKAGED = path.resolve(process.env.QUANSIOX_PACKAGED_APP || path.join(__dirname, '..', 'release', 'Quansiox.app'));
const APP_SRC = path.join(PACKAGED, 'Contents', 'Resources', 'app', 'src');
const RENDERER = path.join(PACKAGED, 'Contents', 'Resources', 'app', 'src', 'renderer');
const OUT_DIR = path.resolve(process.env.QUANSIOX_SHOT_DIR || path.join(__dirname, '..', '..', 'work', 'reports', 'screenshots'));

/** The panes to capture, in the order they appear in the settings rail. */
const PANES = [
  { tab: 'projects', name: '01-projects' },
  { tab: 'slides', name: '02-slides' },
  { tab: 'design', name: '03-design' },
  { tab: 'websites', name: '04-websites' },
  { tab: 'collab', name: '05-collaboration' },
  { tab: 'mail', name: '06-mail' },
];

if (!fs.existsSync(APP_SRC)) {
  console.log(`SHOTS SKIP — no packaged app at ${PACKAGED}`);
  app.exit(0);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-shots-'));
process.env.QUANSIOX_USER_DATA_DIR = userData;
fs.mkdirSync(OUT_DIR, { recursive: true });

app.whenReady().then(async () => {
  require(path.join(APP_SRC, 'main', 'ipc', 'namespaces.js'));
  const { setupIpc } = require(path.join(APP_SRC, 'main', 'ipc', 'registry.js'));
  setupIpc();

  // Seed some content so the panels show something real rather than an
  // empty state — an empty panel proves it mounts, not that it renders.
  try {
    const { projectService } = require(path.join(APP_SRC, 'main', 'services', 'projectService.js'));
    const project = projectService.create({
      name: 'Weekly reports',
      masterInstruction: 'End every report with a bullet summary.',
    });
    projectService.addFiles(project.id, [{ name: 'q1-notes.md', content: '# Q1\nRevenue up 12%.' }]);
    projectService.setPinned(project.id, true);

    const { slidesService } = require(path.join(APP_SRC, 'main', 'services', 'slidesService.js'));
    slidesService.create({
      title: 'Quarterly Review', theme: 'cobalt',
      slides: [
        { layout: 'title', title: 'Quarterly Review', subtitle: 'Q1 2026', notes: 'Welcome.' },
        { layout: 'bullets', title: 'Revenue', bullets: ['Enterprise grew', 'Churn fell'], notes: 'Lead with the number.' },
        { layout: 'chart', title: 'Revenue by region', notes: 'Point at North.' },
      ],
    });

    const { websiteService } = require(path.join(APP_SRC, 'main', 'services', 'websiteService.js'));
    const site = websiteService.create({ name: 'Landing Page', description: 'A page for the product.' });
    websiteService.recordView(site.id, '/');
    websiteService.recordView(site.id, '/');

    // A design session with a real image, a marked region and two versions,
    // so the canvas, the mark overlay and the version row all render.
    {
      const { designService } = require(path.join(APP_SRC, 'main', 'services', 'designService.js'));
      const imageOps = require(path.join(APP_SRC, 'shared', 'imageOps.js'));
      const image = imageOps.createImage(480, 320, [244, 246, 250, 255]);
      for (let y = 120; y < 240; y += 1) {
        for (let x = 120; x < 360; x += 1) imageOps.setPixel(image, x, y, [91, 141, 239, 255]);
      }
      const source = path.join(userData, 'poster.png');
      fs.writeFileSync(source, imageOps.encodePNG(image.data, 480, 320));
      const design = designService.create({ sourcePath: source, title: 'Launch poster' });
      designService.addMark(design.id, {
        x: 120, y: 120, width: 240, height: 120, instruction: 'change this to muted sage green',
      });
      designService.applyOps(design.id, [{
        type: 'region-adjust', region: { x: 120, y: 120, width: 240, height: 120 }, hue: 70, saturation: 0.5,
      }], { label: 'Sage green' });
    }

    const { mailManusService } = require(path.join(APP_SRC, 'main', 'services', 'mailManusService.js'));
    mailManusService.configure({
      enabled: true, botAddress: 'quansiox@example.com',
      approvedSenders: ['ada@example.com'],
      settings: { defaultPrompt: 'Summarise what came in.', sendStatusUpdates: true },
    });
    mailManusService.addWorkflow({ alias: 'travel', prompt: 'Extract the trip details.' });
  } catch (error) {
    console.log('SEED FAILED ' + error.message);
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#0b0e14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(RENDERER, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (...args) => {
    const details = args[1];
    const level = details && typeof details === 'object' ? details.level : details;
    const message = details && typeof details === 'object' ? details.message : args[2];
    if (level === 'error' || level === 3) consoleErrors.push(String(message ?? ''));
  });

  win.webContents.on('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Dismiss the onboarding wizard — it is a first-run overlay and it
    // would cover the very panels we want to photograph.
    await win.webContents.executeJavaScript(`(() => {
      const overlay = document.querySelector('[data-surface="onboarding"]');
      if (!overlay) return 'none';
      const skip = [...overlay.querySelectorAll('button')].find((b) => /skip/i.test(b.textContent || ''));
      if (skip) { skip.click(); return 'skipped'; }
      overlay.remove();
      return 'removed';
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const captured = [];
    for (const pane of PANES) {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const dialog = document.querySelector('#settings-dialog');
        if (!dialog) return { error: 'no dialog' };
        if (!dialog.open) {
          dialog.setAttribute('open', '');
          if (typeof dialog.showModal === 'function') { try { dialog.showModal(); } catch (e) {} }
          await sleep(250);
        }
        const tab = dialog.querySelector('.rail-tab[data-pane="${pane.tab}"]');
        if (!tab) return { error: 'no tab' };
        tab.click();
        await sleep(450);
        const rail = dialog.querySelector('.settings-rail');
        const active = dialog.querySelector('.settings-pane.active');
        const surface = active ? active.querySelector('[data-surface$="-panel"]') : null;
        const body = dialog.querySelector('.settings-body');
        if (body) body.scrollTop = 0;
        await sleep(120);
        const dialogRect = dialog.getBoundingClientRect();
        const railRect = rail.getBoundingClientRect();
        const tabRect = tab.getBoundingClientRect();
        const surfaceRect = surface ? surface.getBoundingClientRect() : null;
        const surfaceStyle = surface ? getComputedStyle(surface) : null;
        return {
          error: surface ? null : 'no visible surface',
          pane: active ? active.dataset.pane : null,
          active: tab.classList.contains('active'),
          dialogInViewport: dialogRect.top >= -1 && dialogRect.bottom <= innerHeight + 1,
          tabInRail: tabRect.top >= railRect.top - 1 && tabRect.bottom <= railRect.bottom + 1,
          railScrolls: ['auto', 'scroll'].includes(getComputedStyle(rail).overflowY),
          surfaceVisible: Boolean(surfaceRect && surfaceRect.width > 0 && surfaceRect.height > 0
            && surfaceStyle.display !== 'none' && surfaceStyle.visibility !== 'hidden'),
          details: {
            dialogBottom: Math.round(dialogRect.bottom),
            viewport: innerHeight,
            tabBottom: Math.round(tabRect.bottom),
            railBottom: Math.round(railRect.bottom),
          },
        };
      })()`);

      const problems = [];
      if (result.error) problems.push(result.error);
      if (result.pane !== pane.tab) problems.push(`active pane is ${result.pane ?? 'none'}`);
      if (!result.active) problems.push('the clicked rail tab is not active');
      if (!result.dialogInViewport) problems.push(`dialog bottom ${result.details?.dialogBottom} exceeds viewport ${result.details?.viewport}`);
      if (!result.tabInRail) problems.push(`tab bottom ${result.details?.tabBottom} is outside the rail (${result.details?.railBottom})`);
      if (!result.railScrolls) problems.push('the settings rail does not scroll');
      if (!result.surfaceVisible) problems.push('the active surface has no visible box');

      const file = path.join(OUT_DIR, `${pane.name}.png`);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      captured.push({ pane: pane.tab, file, problems, details: result.details });
      console.log(`captured ${pane.tab}: ${problems.length ? 'FAIL' : 'ok'} → ${path.basename(file)}`);
      for (const problem of problems) console.log(`  - ${problem}`);
    }
    if (consoleErrors.length) {
      console.log('renderer console errors:');
      for (const line of consoleErrors) console.log(`  - ${line}`);
    }
    console.log(JSON.stringify({ captured, consoleErrors }, null, 1));
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
    const failed = captured.filter((entry) => entry.problems.length > 0);
    if (failed.length || consoleErrors.length) {
      console.log(`VISUAL CHECK FAILED — ${failed.length} pane(s) with layout problems, ${consoleErrors.length} console error(s)`);
      app.exit(1);
    } else {
      console.log('VISUAL CHECK OK — every surface is visible and every rail tab stays inside the dialog');
      app.exit(0);
    }
  });

  win.loadFile(path.join(RENDERER, 'index.html'));
}).catch((error) => {
  console.log('SHOTS FAILED: ' + (error?.stack ?? error));
  app.exit(1);
});
