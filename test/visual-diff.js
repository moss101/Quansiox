'use strict';
/**
 * P1.6 visual regression harness — rendered-output facts.
 *
 * Loads the real renderer from src/ with the real IPC registry, captures a
 * fixed set of shell surfaces at a fixed viewport, and pixel-diffs each
 * against its committed baseline (test/visual-baselines/<name>.png).
 *
 * This is the parity gate required by docs/asset-policy.md: "verified"
 * means the rendered output matched within declared tolerance — not that
 * CSS values or class tables were compared. Downstream "verified" claims
 * (P0.3 recipe batches, P1.3 re-expression) must cite a run of this harness.
 *
 * Modes:
 *   (default)            capture every surface and diff vs its baseline
 *   --update-baselines   (re)write the baselines from fresh captures
 *
 * Optional cross-app reference — LOCAL ONLY, never committed
 * (docs/asset-policy.md): set QUANSIOX_GROK_REF_DIR to a directory holding
 * same-named captures of the Grok app. Metrics against those references are
 * printed and written to the report, but never asserted: Grok bytes do not
 * ship with this repository.
 *
 * Determinism measures: frozen clock (window.__QX_FROZEN_NOW, stamped at
 * seed time, so relative timestamps cannot drift between a capture and its
 * baseline), animations/transitions/caret disabled via injected CSS,
 * document.fonts.ready awaited, fixed 1400x900 viewport, fresh user-data
 * dir with fixed seed content, no window shown (offscreen capture).
 *
 * Baselines are Quansiox's own renders — committable per the asset policy.
 * They are per-DPR: a machine with a different display scale factor must
 * regenerate them locally with --update-baselines (they stay uncommitted).
 *
 * Output: metrics JSON in work/reports/visual-diff.json (gitignored).
 */
const { app, BrowserWindow, nativeImage } = require('electron');
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

const ROOT = path.join(__dirname, '..');
const BASELINE_DIR = path.join(__dirname, 'visual-baselines');
const REPORT_DIR = path.resolve(ROOT, '..', 'work', 'reports');
const UPDATE = process.argv.includes('--update-baselines');
const GROK_REF_DIR = process.env.QUANSIOX_GROK_REF_DIR || null;

/**
 * Everything that could leak into a capture is made deterministic:
 *  - one fixed epoch, frozen in BOTH the main and the renderer process, so
 *    timestamps, relative labels and absolute clocks cannot drift;
 *  - fixed user-data dir (the workspace path is rendered in the UI);
 *  - deterministic crypto.randomUUID / Math.random (session and computer
 *    IDs are rendered, e.g. `computer:<uuid>` in the stage column).
 */
const FAKE_NOW = new Date('2026-01-05T09:15:00Z').getTime();
{
  const RealDate = Date;
  const FixedDate = class Date extends RealDate {
    constructor(...args) { super(...(args.length ? args : [FAKE_NOW])); }
    static now() { return FAKE_NOW; }
  };
  globalThis.Date = FixedDate;

  const crypto = require('node:crypto');
  const deterministicBytes = (size) => {
    const buf = Buffer.alloc(size);
    let s = 0x1234567;
    for (let i = 0; i < size; i += 1) {
      s = (Math.imul(s, 1103515245) + 12345) | 0;
      buf[i] = (s >>> 16) & 0xff;
    }
    return buf;
  };
  let uuidCounter = 0;
  const fixedUuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
  crypto.randomUUID = fixedUuid;
  crypto.randomBytes = (size, cb) => {
    const buf = deterministicBytes(size);
    if (typeof cb === 'function') { queueMicrotask(() => cb(null, buf)); return undefined; }
    return buf;
  };
  // globalThis.crypto (webcrypto) — the `uuid`-style generators use
  // getRandomValues; give it the same deterministic fill.
  const patched = Object.create(globalThis.crypto);
  Object.defineProperty(patched, 'getRandomValues', {
    value: (typedArray) => {
      typedArray.set(deterministicBytes(typedArray.byteLength));
      return typedArray;
    },
  });
  Object.defineProperty(patched, 'randomUUID', { value: fixedUuid });
  Object.defineProperty(globalThis, 'crypto', { value: patched, configurable: true });

  let prngState = 0x9e3779b9;
  Math.random = () => {
    prngState = (prngState + 0x6d2b79f5) | 0;
    let t = prngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const USER_DATA = path.join(os.tmpdir(), 'qx-visual-fixed');

/** Per-channel 0-255 delta considered anti-aliasing noise. */
const TOLERANCE = 8;
/** Fraction of pixels allowed beyond TOLERANCE before a surface fails. */
const MAX_DIFF_PCT = 0.1;
const VIEWPORT = { width: 1400, height: 900 };

const SURFACES = [
  { name: '01-shell-light' },
  { name: '02-shell-dark' },
  { name: '03-settings-projects', pane: 'projects' },
  { name: '04-settings-design', pane: 'design' },
  // P2.4 thread status: seeded running/finished async tasks + a pending
  // approval + a pending form, drawer opened via its toggle.
  { name: '05-tasks', click: '.task-strip-toggle' },
  // P2.3 composer parity: seeded markdown draft (restored on load), voice
  // memo bar idle, markdown preview open, drag overlay active.
  { name: '06-composer', composer: true },
  // P2.4 find-in-chat: seeded transcript turns, bar open via mod+F, query
  // typed, one next() so the active-match outline is visible.
  { name: '07-find', find: true },
  // P1.7 shortcuts dialog: opened via a real mod+/ dispatch.
  { name: '08-shortcuts', shortcuts: true },
  // P2.4 saved messages: seeded library entries, dialog opened via the
  // topbar button (★ on rows is the same store).
  { name: '09-saved', library: true },
  // P2.2 onboarding: fresh user-data shows the wizard; navigate to the
  // appearance step (theme/accent/bot color + character shapes).
  { name: '10-onboarding', onboarding: true },
];

/** The renderer boots a random session unless #session= is pinned — a fixed
 * id is what lets the seeded async tasks land in the strip the renderer
 * polls (its list is scoped to agent.sessionId). */
const SESSION_ID = 'visual-taskcards';

const STABILIZE_CSS = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }`;

function freezeClock(now) {
  const RealDate = Date;
  const realNow = RealDate.now();
  const skew = realNow - now;
  RealDate.now = () => now;
  // Keep performance timings real (Chromium internals rely on them); only
  // wall-clock reads are frozen.
  const NewDate = class Date extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now + 0);
      else super(...args);
    }
    static now() { return now; }
  };
  void skew;
  window.Date = NewDate;
}

/**
 * Replace UUID-shaped text (session/computer IDs generated before the
 * determinism patches apply) with a constant same-length string, so captures
 * never depend on which process generated an ID or when.
 */
function scrubVolatileText() {
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const FIXED = '00000000-0000-4000-8000-000000000000';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const hits = [];
  let node;
  while ((node = walker.nextNode())) {
    if (UUID_RE.test(node.nodeValue || '')) hits.push(node);
  }
  for (const hit of hits) hit.nodeValue = (hit.nodeValue || '').replace(new RegExp(UUID_RE.source, 'gi'), FIXED);
  return hits.length;
}

function pixelMetrics(aBuf, bBuf) {
  const a = nativeImage.createFromBuffer(aBuf);
  const b = nativeImage.createFromBuffer(bBuf);
  const sa = a.getSize();
  const sb = b.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) {
    return { dimensionMismatch: true, captured: sa, baseline: sb };
  }
  const va = a.toBitmap();
  const vb = b.toBitmap();
  const pixels = sa.width * sa.height;
  let diffPixels = 0;
  let maxDelta = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < sa.height; y += 1) {
    const row = y * sa.width * 4;
    for (let x = 0; x < sa.width; x += 1) {
      const i = row + x * 4;
      const d0 = Math.abs(va[i] - vb[i]);
      if (d0 <= TOLERANCE) continue; // fast path: first channel inside noise
      const d = Math.max(d0,
        Math.abs(va[i + 1] - vb[i + 1]),
        Math.abs(va[i + 2] - vb[i + 2]));
      if (d > TOLERANCE) {
        diffPixels += 1;
        if (d > maxDelta) maxDelta = d;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    width: sa.width, height: sa.height,
    diffPixels, maxDelta,
    diffPct: +((diffPixels / pixels) * 100).toFixed(4),
    diffBox: diffPixels ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    pass: (diffPixels / pixels) * 100 <= MAX_DIFF_PCT,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const userData = USER_DATA;
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  process.env.QUANSIOX_USER_DATA_DIR = userData;
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  require(path.join(ROOT, 'src', 'main', 'ipc', 'namespaces.js'));
  const { setupIpc } = require(path.join(ROOT, 'src', 'main', 'ipc', 'registry.js'));
  setupIpc();

  // Fixed seed content — same every run, so captures only differ when the
  // renderer's output actually changes.
  try {
    const { projectService } = require(path.join(ROOT, 'src', 'main', 'services', 'projectService.js'));
    const project = projectService.create({
      name: 'Weekly reports',
      masterInstruction: 'End every report with a bullet summary.',
    });
    projectService.addFiles(project.id, [{ name: 'q1-notes.md', content: '# Q1\nRevenue up 12%.' }]);
    projectService.setPinned(project.id, true);

    // P2.4 surface seed: one running + one finished async task, a pending
    // tool approval, and a pending input form — the exact states the strip
    // summarizes. Fixed strings only; timestamps are frozen by FAKE_NOW.
    const { asyncTaskService } = require(path.join(ROOT, 'src', 'main', 'services', 'asyncTaskService.js'));
    const running = asyncTaskService.create({ sessionId: SESSION_ID, title: 'Run command — npm test' });
    asyncTaskService.update(running.id, { status: 'running', progress: 0.4, outputTail: '> npm test\n\nok design-drift\nok design-system\n' });
    const finished = asyncTaskService.create({ sessionId: SESSION_ID, title: 'Compress exports' });
    asyncTaskService.update(finished.id, { status: 'succeeded' });
    const { confirmationService } = require(path.join(ROOT, 'src', 'main', 'services', 'confirmationService.js'));
    confirmationService.request(
      SESSION_ID, 'shell', { command: 'npm test' }, null, 600_000,
      { tool: 'shell', target: 'npm test', description: 'Run the project test suite', argsPreview: { command: 'npm test' } },
    );
    const { userInteractionService } = require(path.join(ROOT, 'src', 'main', 'services', 'userInteractionService.js'));
    userInteractionService.requestForm({
      agentId: 'visual', sessionId: SESSION_ID, title: 'Confirm the release name',
      fields: [{ name: 'release', label: 'Release name', type: 'text' }],
    });

    // P2.3 surface seed: a persisted markdown draft — the composer restores
    // it on load (draft persistence), so the preview has real content.
    const { sessionExtrasService } = require(path.join(ROOT, 'src', 'main', 'services', 'sessionExtrasService.js'));
    sessionExtrasService.saveDraft(SESSION_ID,
      'Ship the **launch** today — notes:\n\n- retry the failed job\n- ping the team');

    // P2.4 surface seed: transcript turns containing the fixed query so the
    // find bar has real matches to navigate.
    const { sessionService } = require(path.join(ROOT, 'src', 'main', 'services', 'sessionService.js'));
    sessionService.appendTurn(SESSION_ID, { role: 'user', content: 'please ship the release notes tonight' });
    sessionService.appendTurn(SESSION_ID, { role: 'assistant', content: 'staged — the release notes are ready for review' });
    sessionService.appendTurn(SESSION_ID, { role: 'user', content: 'ok, release it' });

    // P2.4 surface seed: two saved messages (one from this session, one from
    // another) so the Library shows grouping and the "this chat" marker.
    const { savedMessagesService } = require(path.join(ROOT, 'src', 'main', 'services', 'savedMessagesService.js'));
    savedMessagesService.clear();
    savedMessagesService.save({
      sessionId: SESSION_ID, messageId: 'saved-here', kind: 'assistant',
      text: 'staged — the release notes are ready for review',
    });
    sessionService.appendTurn('visual-other', { role: 'user', content: 'design review notes for the quarter' });
    savedMessagesService.save({
      sessionId: 'visual-other', messageId: 'saved-other', kind: 'user',
      text: 'design review notes for the quarter',
    });
  } catch (error) {
    console.log('SEED FAILED ' + error.message);
  }

  const win = new BrowserWindow({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    useContentSize: true,
    show: false,
    backgroundColor: '#0b0e14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
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
    try {
      // Freeze wall-clock BEFORE anything renders, so "2m ago" labels can
      // never drift between a capture and its baseline.
      await win.webContents.executeJavaScript(`(${freezeClock.toString()})(${FAKE_NOW}); window.__QX_FROZEN_NOW = ${FAKE_NOW}; 'frozen'`);
      await win.webContents.insertCSS(STABILIZE_CSS);
      await win.webContents.executeJavaScript(`document.fonts.ready.then(() => 'fonts-ready')`);
      await sleep(1200);

      // Dismiss the first-run onboarding overlay if it mounts — unless this
      // run captures the onboarding surface itself (fresh user-data means
      // the wizard always shows).
      if (!SURFACES.some((s) => s.onboarding)) {
        await win.webContents.executeJavaScript(`(() => {
        const overlay = document.querySelector('[data-surface="onboarding"]');
        if (!overlay) return 'none';
        const skip = [...overlay.querySelectorAll('button')].find((b) => /skip/i.test(b.textContent || ''));
        if (skip) { skip.click(); return 'skipped'; }
        overlay.remove();
        return 'removed';
      })()`);
        await sleep(400);
      }

      const report = { generatedAt: new Date(FAKE_NOW).toISOString(), viewport: VIEWPORT, tolerance: TOLERANCE, maxDiffPct: MAX_DIFF_PCT, surfaces: {} };

      const capture = async (name) => {
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        return png;
      };

      const ensureBaseline = (name) => path.join(BASELINE_DIR, `${name}.png`);

      for (const surface of SURFACES) {
        if (surface.pane) {
          await win.webContents.executeJavaScript(`(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const dialog = document.querySelector('#settings-dialog');
            if (!dialog) return 'no dialog';
            if (!dialog.open) {
              if (typeof window.quansioxUI?.openSettings === 'function') { await window.quansioxUI.openSettings(); await sleep(300); }
              if (!dialog.open) { dialog.setAttribute('open', ''); if (typeof dialog.showModal === 'function') { try { dialog.showModal(); } catch (e) {} } await sleep(250); }
            }
            const tab = dialog.querySelector('.rail-tab[data-pane="${surface.pane}"]');
            if (!tab) return 'no tab';
            tab.click();
            await sleep(500);
            const body = dialog.querySelector('.settings-body');
            if (body) body.scrollTop = 0;
            await sleep(150);
            return 'ok';
          })()`);
        } else if (surface.name.endsWith('-dark')) {
          await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme', 'dark'); 'dark'`);
          await sleep(400);
        }
        await win.webContents.executeJavaScript(`(${scrubVolatileText.toString()})()`);
        await sleep(60);
        if (surface.click) {
          await win.webContents.executeJavaScript(`(() => {
            const el = document.querySelector('${surface.click}');
            if (el) el.click();
            return el ? 'clicked' : 'missing';
          })()`);
          await sleep(400);
        }
        if (surface.composer) {
          // Voice memo bar (idle — no capture, so no nondeterminism), the
          // markdown preview of the seeded draft, and the drag overlay
          // driven by a real dragenter.
          await win.webContents.executeJavaScript(`(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const memo = document.querySelector('[data-surface="composer-memo"]');
            if (memo) { memo.click(); await sleep(200); }
            const preview = document.querySelector('[data-surface="composer-preview-toggle"]');
            if (preview && !preview.disabled) { preview.click(); await sleep(300); }
            const box = document.querySelector('.composer-box');
            if (box) {
              const ev = new DragEvent('dragenter', { bubbles: true });
              Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files: [] } });
              box.dispatchEvent(ev);
            }
            await sleep(200);
            return 'composer staged';
          })()`);
          await sleep(300);
        }
        if (surface.find) {
          await win.webContents.executeJavaScript(`(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }));
            await sleep(250);
            const input = document.querySelector('[data-surface="find-input"]');
            if (input) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(input, 'release');
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            await sleep(400);
            const next = document.querySelector('[data-surface="find-next"]');
            if (next) { next.click(); await sleep(300); }
            return 'find staged';
          })()`);
          await sleep(300);
        }
        if (surface.shortcuts) {
          await win.webContents.executeJavaScript(`(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true, cancelable: true }));
            await sleep(400);
            const dialog = document.querySelector('[data-surface="shortcuts-dialog"]');
            return dialog ? 'open' : 'missing';
          })()`);
          await sleep(200);
        }
        if (surface.library) {
          await win.webContents.executeJavaScript(`(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const btn = document.querySelector('[data-surface="library-open"]');
            if (!btn) return 'missing';
            btn.click();
            await sleep(500);
            const dialog = document.querySelector('[data-surface="library-dialog"]');
            return dialog ? 'open' : 'dialog-missing';
          })()`);
          await sleep(300);
        }
        if (surface.onboarding) {
          await win.webContents.executeJavaScript(`(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const overlay = document.querySelector('[data-surface="onboarding"]');
            if (!overlay) return 'missing';
            for (let i = 0; i < 2; i += 1) {
              const next = [...overlay.querySelectorAll('button')].find((b) => /continue/i.test(b.textContent || ''));
              if (next) { next.click(); await sleep(300); }
            }
            const step = document.querySelector('[data-surface="onboarding-step"]');
            return step ? step.textContent : 'no-step';
          })()`);
          await sleep(300);
        }
        const png = await capture(surface.name);
        const baselinePath = ensureBaseline(surface.name);
        let entry = { captured: true };
        if (UPDATE) {
          fs.writeFileSync(baselinePath, png);
          entry.baseline = 'written';
        } else if (!fs.existsSync(baselinePath)) {
          entry.baseline = 'missing';
          entry.pass = false;
        } else {
          const metrics = pixelMetrics(png, fs.readFileSync(baselinePath));
          entry.metrics = metrics;
          entry.pass = metrics.dimensionMismatch ? false : metrics.pass;
          if (metrics.dimensionMismatch) {
            entry.note = 'dimension mismatch — different DPR or viewport; regenerate baselines locally with --update-baselines';
          }
          // Keep the fresh capture for debugging (gitignored via work/).
          fs.mkdirSync(path.join(REPORT_DIR, 'visual-diff-captures'), { recursive: true });
          fs.writeFileSync(path.join(REPORT_DIR, 'visual-diff-captures', `${surface.name}.png`), png);
        }
        if (GROK_REF_DIR && fs.existsSync(path.join(GROK_REF_DIR, `${surface.name}.png`))) {
          const grokMetrics = pixelMetrics(png, fs.readFileSync(path.join(GROK_REF_DIR, `${surface.name}.png`)));
          entry.vsGrokReference = grokMetrics; // report-only, never asserted
        }
        report.surfaces[surface.name] = entry;
        const status = entry.pass === false ? 'FAIL' : entry.baseline === 'written' ? 'baseline' : entry.metrics?.pass ? 'ok' : entry.pass ? 'ok' : 'FAIL';
        console.log(`captured ${surface.name}: ${status}` + (entry.metrics && !entry.metrics.dimensionMismatch
          ? ` (diff ${entry.metrics.diffPct}% max-delta ${entry.metrics.maxDelta})` : ''));
      }

      fs.writeFileSync(path.join(REPORT_DIR, 'visual-diff.json'), JSON.stringify(report, null, 2) + '\n');
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }

      if (consoleErrors.length) {
        console.log('renderer console errors:');
        for (const line of consoleErrors) console.log(`  - ${line}`);
      }

      if (UPDATE) {
        console.log(`VISUAL BASELINES UPDATED — ${SURFACES.length} surface(s) in ${path.relative(ROOT, BASELINE_DIR)}`);
        app.exit(consoleErrors.length ? 1 : 0);
        return;
      }

      const failed = Object.entries(report.surfaces).filter(([, e]) => e.pass === false);
      if (failed.length) {
        console.log(`VISUAL DIFF FAILED — ${failed.length}/${SURFACES.length} surface(s) outside tolerance (max ${MAX_DIFF_PCT}%): ${failed.map(([n]) => n).join(', ')}`);
        console.log('If the change is deliberate: node test/visual-diff.js --update-baselines, then commit the baseline diff.');
        app.exit(1);
        return;
      }
      console.log(`VISUAL DIFF OK — ${SURFACES.length} surface(s) within tolerance (max ${MAX_DIFF_PCT}%, per-channel ${TOLERANCE})`);
      app.exit(consoleErrors.length ? 1 : 0);
    } catch (error) {
      console.log('VISUAL DIFF ERROR: ' + (error?.stack ?? error));
      app.exit(1);
    }
  });

  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'), { hash: `session=${SESSION_ID}` });
}).catch((error) => {
  console.log('VISUAL DIFF BOOT FAILED: ' + (error?.stack ?? error));
  app.exit(1);
});
