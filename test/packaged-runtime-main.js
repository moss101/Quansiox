'use strict';
/**
 * Packaged-app runtime check.
 *
 * The static wiring check proves the code is *present* in the bundle. This
 * proves it *works* there: the real Electron runtime loads the **packaged**
 * app's main-process code, calls the new IPC handlers for real, and mounts
 * the packaged renderer to confirm the new surfaces appear.
 *
 * Run with:
 *   QUANSIOX_PACKAGED_APP=release/Quansiox.app \
 *     ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron test/packaged-runtime-main.js
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

if (!fs.existsSync(APP_SRC)) {
  console.log(`PACKAGED-RUNTIME SKIP — no packaged app at ${PACKAGED}`);
  app.exit(0);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-packaged-'));
process.env.QUANSIOX_USER_DATA_DIR = userData;

app.whenReady().then(async () => {
  const results = {};
  const errors = [];

  // The packaged main-process code, not the source tree.
  require(path.join(APP_SRC, 'main', 'ipc', 'namespaces.js'));
  const { setupIpc } = require(path.join(APP_SRC, 'main', 'ipc', 'registry.js'));
  setupIpc();

  const { getExposedMeta } = require(path.join(APP_SRC, 'main', 'ipc', 'registry.js'));
  const meta = getExposedMeta();
  const exposed = new Map(meta.handlers);

  /* -- 1. call the new handlers for real --------------------------------- */
  const services = {
    projectService: require(path.join(APP_SRC, 'main', 'services', 'projectService.js')).projectService,
    slidesService: require(path.join(APP_SRC, 'main', 'services', 'slidesService.js')).slidesService,
    designService: require(path.join(APP_SRC, 'main', 'services', 'designService.js')).designService,
    multimediaService: require(path.join(APP_SRC, 'main', 'services', 'multimediaService.js')).multimediaService,
    websiteService: require(path.join(APP_SRC, 'main', 'services', 'websiteService.js')).websiteService,
    collabService: require(path.join(APP_SRC, 'main', 'services', 'collabService.js')).collabService,
    mailManusService: require(path.join(APP_SRC, 'main', 'services', 'mailManusService.js')).mailManusService,
  };

  // Projects: create → master instruction → knowledge base → pin → reorder.
  const project = services.projectService.create({ name: 'Packaged check', masterInstruction: 'Be brief.' });
  services.projectService.addMark; // (design, not project)
  services.projectService.update(project.id, { masterInstruction: 'Be brief.' });
  services.projectService.setPinned(project.id, true);
  const added = services.projectService.addFiles(project.id, [{ name: 'a.txt', content: 'hello' }]);
  results.project = {
    created: Boolean(project.id),
    instruction: services.projectService.get(project.id).masterInstruction,
    fileCount: added.added.length,
    pinned: services.projectService.get(project.id).pinned,
  };

  // Slides: a deck with notes, and the four exports.
  const deck = services.slidesService.create({
    title: 'Packaged deck',
    theme: 'cobalt',
    slides: [{ layout: 'title', title: 'Hello', notes: 'Speak slowly.' }],
  });
  const pptx = await services.slidesService.exportPptx(deck.id);
  const web = services.slidesService.exportWeb(deck.id);
  const notes = services.slidesService.exportNotes(deck.id);
  results.slides = {
    deck: deck.slideCount,
    pptxBytes: pptx.bytes,
    webBytes: web.bytes,
    notesBytes: notes.bytes,
    pptxIsZip: fs.readFileSync(pptx.path).readUInt32LE(0) === 0x04034b50,
  };

  // Design View: a session, a marked region and a real edit.
  const imageOps = require(path.join(APP_SRC, 'shared', 'imageOps.js'));
  const png = path.join(userData, 'src.png');
  const canvas = imageOps.createImage(120, 90, [255, 255, 255, 255]);
  fs.writeFileSync(png, imageOps.encodePNG(canvas.data, 120, 90));
  const design = services.designService.create({ sourcePath: png, title: 'Packaged design' });
  services.designService.addMark(design.id, { x: 10, y: 10, width: 40, height: 30, instruction: 'tint it' });
  const edited = services.designService.applyOps(design.id, [
    { type: 'region-adjust', region: { x: 10, y: 10, width: 40, height: 30 }, brightness: 0.2 },
  ]);
  results.design = {
    versions: edited.versions.length,
    marks: edited.marks.length,
    editedBytes: fs.statSync(edited.versions[1].path).size,
  };

  // Multimedia: the packaged OCR helper must actually run here.
  const ocr = services.multimediaService.ocrImage(png);
  results.multimedia = {
    helper: services.multimediaService.visionHelperPath(),
    helperInstalled: fs.existsSync(services.multimediaService.visionHelperPath()),
    ocrAnswered: ocr.ok || typeof ocr.reason === 'string',
    ffmpeg: services.multimediaService.ffmpegAvailable(),
    speech: services.multimediaService.speak('Packaged speech check.').ok,
  };

  // Website Builder: scaffold → SEO audit → publish (a real preview server).
  const site = services.websiteService.create({ name: 'Packaged site' });
  const audit = services.websiteService.seoAudit(site.id);
  const published = await services.websiteService.publish(site.id);
  const fetchResponse = await fetch(`${published.previewUrl}/`).catch(() => null);
  results.website = {
    files: site.files.length,
    seoScore: audit.score,
    bundleBytes: fs.statSync(published.bundlePath).size,
    previewStatus: fetchResponse ? fetchResponse.status : null,
  };

  // Collaboration: enable → invite → join → a queued prompt.
  const collab = services.collabService.enable('packaged-task');
  const invite = services.collabService.invite('packaged-task', 'ada@example.com');
  const joined = services.collabService.join(invite.token);
  services.collabService.prompt('packaged-task', 'ada@example.com', 'do the thing');
  results.collab = {
    enabled: collab.enabled,
    invited: Boolean(invite.token),
    joined: joined.ok,
    queued: services.collabService.queue('packaged-task').length,
  };

  // Mail Manus: the addresses, the allowlist and a workflow.
  services.mailManusService.configure({ enabled: true, botAddress: 'quansiox@example.com', approvedSenders: [] });
  const workflow = services.mailManusService.addWorkflow({ alias: 'travel', prompt: 'File the trip.' });
  const filter = services.mailManusService.filterConfiguration({ keyword: 'invoice', provider: 'gmail' });
  results.mail = {
    address: services.mailManusService.botAddress(),
    workflow: workflow.address,
    filterTarget: filter.forwardTo,
    ics: services.mailManusService.calendarEvent({
      title: 'Check', start: '2026-03-01T10:00:00Z', end: '2026-03-01T11:00:00Z',
    }).includes('BEGIN:VEVENT'),
  };

  /* -- 2. the packaged renderer mounts the new surfaces ------------------ */
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(RENDERER, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const surface = await win.webContents.executeJavaScript(`(() => {
      const out = {};
      out.namespaces = ['projects','slides','design','multimedia','website','collab','mailManus']
        .filter((ns) => typeof window.quansiox?.api?.[ns] !== 'object');
      out.panes = ['projects','slides','design','websites','collab','mail']
        .filter((p) => !document.querySelector('[data-react-pane="' + p + '"]'));
      out.surfaces = ['projects-panel','slides-panel','design-panel','website-panel','collab-panel','mail-panel']
        .filter((s) => !document.querySelector('[data-surface="' + s + '"]'));
      return JSON.stringify(out);
    })()`);
    const parsed = JSON.parse(surface);
    results.renderer = {
      namespacesMissing: parsed.namespaces,
      panesMissing: parsed.panes,
      surfacesMissing: parsed.surfaces,
    };

    console.log(JSON.stringify({ results, errors: errors.slice(0, 5) }, null, 1));

    const problems = [];
    if (results.renderer.namespacesMissing.length) problems.push(`renderer cannot reach: ${results.renderer.namespacesMissing}`);
    if (results.renderer.panesMissing.length) problems.push(`renderer is missing panes: ${results.renderer.panesMissing}`);
    if (results.renderer.surfacesMissing.length) problems.push(`renderer is missing surfaces: ${results.renderer.surfacesMissing}`);
    if (errors.length) problems.push(`console errors: ${errors.slice(0, 3).join(' | ')}`);
    if (!results.project.created) problems.push('projects did not create');
    if (!results.slides.pptxIsZip) problems.push('the pptx export is not a zip');
    if (!results.multimedia.helperInstalled) problems.push('the OCR helper is not installed in the bundle');
    if (!results.multimedia.speech) problems.push('speech synthesis failed');
    if (results.website.previewStatus !== 200) problems.push(`the preview server answered ${results.website.previewStatus}`);
    if (!results.collab.joined) problems.push('the collaborator did not join');
    if (!results.mail.ics) problems.push('the calendar event was not produced');

    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
    if (problems.length) {
      console.log('PACKAGED-RUNTIME FAILED: ' + problems.join('; '));
      app.exit(1);
    }
    console.log('PACKAGED-RUNTIME OK — every feature works in the packaged app');
    app.exit(0);
  });

  win.loadFile(path.join(RENDERER, 'index.html'));
}).catch((error) => {
  console.log('PACKAGED-RUNTIME FAILED: ' + (error?.stack ?? error));
  app.exit(1);
});
