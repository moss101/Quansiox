'use strict';
/**
 * Packaged-bundle wiring check.
 *
 * The question this answers is not "does the source contain the feature" but
 * "**is the feature actually reachable in the app the user runs**". So it
 * loads the code from `release/Quansiox.app` — the packaged bundle — and
 * checks every layer of the wiring:
 *
 *   1. the services exist in the bundle and load;
 *   2. the IPC namespaces are registered by the bundled registry;
 *   3. the preload facade exposes every new namespace and method;
 *   4. the agent tools are in the bundled coordinator;
 *   5. the renderer surfaces are in the bundled renderer bundle;
 *   6. the native helper is installed and runnable.
 *
 * A feature that passes (1) but fails (2) or (3) is invisible to the user,
 * and that is exactly the class of bug this catches.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.resolve(process.env.QUANSIOX_PACKAGED_APP || path.join(ROOT, 'release', 'Quansiox.app'));
const APP_SRC = path.join(APP, 'Contents', 'Resources', 'app', 'src');

/** The namespaces this pass added, with the methods each one must expose. */
const NEW_NAMESPACES = {
  projects: ['list', 'get', 'create', 'update', 'remove', 'setPinned', 'reorder',
    'addFiles', 'pickFiles', 'removeFile', 'readFile', 'assignTask', 'taskConfig',
    'filters', 'addCollaborator', 'removeCollaborator'],
  slides: ['list', 'get', 'create', 'update', 'remove', 'themes', 'exportPptx',
    'exportWeb', 'exportNotes', 'exportPdf', 'importTemplate', 'pickTemplate', 'setChart'],
  design: ['list', 'get', 'create', 'remove', 'pickImage', 'addMark', 'addMarks',
    'clearMarks', 'extractText', 'applyOps', 'addReference', 'compare', 'operations'],
  multimedia: ['capabilities', 'ocr', 'ocrBatch', 'analyzeImage', 'compareImages',
    'probeVideo', 'extractFrames', 'makeVideo', 'extractAudio', 'speak', 'listVoices'],
  website: ['list', 'get', 'create', 'remove', 'files', 'readFile', 'writeFile',
    'deleteFile', 'codeControl', 'makeCopy', 'seoAudit', 'applySeo', 'setAccess',
    'recordView', 'analytics', 'addNotification', 'removeNotification', 'addSchedule',
    'removeSchedule', 'publish', 'previewUrl', 'stopPreview', 'dnsRecords'],
  collab: ['get', 'enable', 'disable', 'invite', 'join', 'members', 'removeMember',
    'prompt', 'queue', 'drain', 'history', 'exportTranscript'],
  mailManus: ['state', 'configure', 'botAddress', 'approveSender', 'removeSender',
    'addWorkflow', 'removeWorkflow', 'poll', 'handleMessage', 'cancel',
    'filterConfiguration', 'calendarEvent', 'extractRecord'],
};

/** The agent tools this pass added. */
const NEW_TOOLS = [
  'slides_deck', 'slides_export', 'design_mark', 'design_edit',
  'read_image', 'make_video', 'speak', 'website_build',
  'wide_research', 'analyze_data', 'project_knowledge',
];

async function run() {
  if (!fs.existsSync(APP_SRC)) {
    console.log('packaged wiring: no packaged app — run "npm run package" first');
    return;
  }
  const appSrcLabel = path.relative(ROOT, APP_SRC);
  console.log(`checking the packaged bundle: ${appSrcLabel}`);

  /* -- 1. the services load from the bundle ------------------------------ */
  const services = {
    projectService: 'main/services/projectService.js',
    slidesService: 'main/services/slidesService.js',
    designService: 'main/services/designService.js',
    multimediaService: 'main/services/multimediaService.js',
    websiteService: 'main/services/websiteService.js',
    collabService: 'main/services/collabService.js',
    mailManusService: 'main/services/mailManusService.js',
    dataVizService: 'main/services/dataVizService.js',
  };
  for (const [name, relative] of Object.entries(services)) {
    const file = path.join(APP_SRC, relative);
    assert.ok(fs.existsSync(file), `${name} is missing from the bundle (${relative})`);
    const loaded = require(file);
    assert.ok(loaded[name], `${name} does not export its service object`);
  }
  console.log(`  1. services: ${Object.keys(services).length}/${Object.keys(services).length} load from the bundle`);

  /* -- 2. the IPC namespaces register ------------------------------------ */
  // Register into a fresh registry, the way the bundled main process does.
  const registryFile = path.join(APP_SRC, 'main/ipc/registry.js');
  const namespacesFile = path.join(APP_SRC, 'main/ipc/namespaces.js');
  const { registerNamespace, listNamespaces } = require(registryFile);
  const registered = [];
  const original = registerNamespace;
  // Wrap the registrar so we can see what the bundled namespaces register.
  const registryModule = require(registryFile);
  registryModule.registerNamespace = (name, spec) => { registered.push({ name, spec }); return original(name, spec); };
  require(namespacesFile);
  registryModule.registerNamespace = original;

  const byName = new Map(registered.map((entry) => [entry.name, entry.spec]));
  for (const [namespace, methods] of Object.entries(NEW_NAMESPACES)) {
    assert.ok(byName.has(namespace), `the bundle does not register the "${namespace}" namespace`);
    const spec = byName.get(namespace);
    for (const method of methods) {
      assert.ok(
        typeof spec.handlers?.[method] === 'function',
        `the bundled "${namespace}" namespace has no "${method}" handler`
      );
    }
  }
  console.log(`  2. IPC namespaces: ${Object.keys(NEW_NAMESPACES).length} new namespaces, `
    + `${Object.values(NEW_NAMESPACES).reduce((n, m) => n + m.length, 0)} handlers, all registered in the bundle`);

  /* -- 3. the preload facade exposes them -------------------------------- */
  // The bundled registry's meta is what the preload turns into window.quansiox.
  // The preload turns this exact payload into `window.quansiox.api`, so it is
  // the thing that decides whether the renderer can reach a feature.
  const meta = registryModule.getExposedMeta();
  assert.ok(meta && Array.isArray(meta.handlers), 'the bundled registry does not expose its namespace list');
  const exposed = new Map(meta.handlers);
  for (const [namespace, methods] of Object.entries(NEW_NAMESPACES)) {
    assert.ok(exposed.has(namespace), `the preload facade will not expose "${namespace}"`);
    const listed = exposed.get(namespace);
    for (const method of methods) {
      assert.ok(listed.includes(method), `the preload facade will not expose "${namespace}.${method}"`);
    }
  }
  console.log(`  3. preload facade: ${Object.keys(NEW_NAMESPACES).length} namespaces, `
    + `${Object.values(NEW_NAMESPACES).reduce((n, m) => n + m.length, 0)} methods exposed to the renderer`);

  /* -- 4. the agent tools are in the bundled coordinator ------------------ */
  const coordinatorFile = path.join(APP_SRC, 'coordinator/index.js');
  const coordinatorSource = fs.readFileSync(coordinatorFile, 'utf8');
  for (const tool of NEW_TOOLS) {
    assert.ok(coordinatorSource.includes(`name: '${tool}'`), `the bundled coordinator is missing the "${tool}" tool`);
    assert.ok(coordinatorSource.includes(`name === '${tool}'`), `the bundled coordinator has no handler for "${tool}"`);
  }
  console.log(`  4. agent tools: ${NEW_TOOLS.length}/${NEW_TOOLS.length} defined and handled in the bundle`);

  /* -- 5. the renderer surfaces are in the bundled renderer -------------- */
  const rendererFile = path.join(APP, 'Contents', 'Resources', 'app', 'src', 'renderer', 'assets', 'app.js');
  assert.ok(fs.existsSync(rendererFile), 'the bundled renderer bundle is missing');
  const renderer = fs.readFileSync(rendererFile, 'utf8');
  for (const surface of ['projects-panel', 'slides-panel', 'design-panel', 'website-panel', 'collab-panel', 'mail-panel']) {
    assert.ok(renderer.includes(surface), `the bundled renderer has no "${surface}" surface`);
  }
  // The settings dialog's panes and rail tabs live in the settings bridge,
  // not in the React bundle.
  const bridgeFile = path.join(APP, 'Contents', 'Resources', 'app', 'src', 'renderer', 'settings-bridge.js');
  assert.ok(fs.existsSync(bridgeFile), 'the bundled settings bridge is missing');
  const bridge = fs.readFileSync(bridgeFile, 'utf8');
  for (const pane of ['projects', 'slides', 'design', 'websites', 'collab', 'mail']) {
    assert.ok(bridge.includes(`data-react-pane="${pane}"`), `the bundled settings dialog has no "${pane}" pane`);
    assert.ok(bridge.includes(`data-pane="${pane}"`), `the bundled settings dialog has no "${pane}" rail tab`);
  }
  console.log('  5. renderer: 6 surfaces in the React bundle + 6 panes and rail tabs in the settings dialog');

  /* -- 6. the native helper is installed and runnable -------------------- */
  const helper = path.join(APP, 'Contents', 'Resources', 'app', 'native', 'QuansioxVision');
  assert.ok(fs.existsSync(helper), 'QuansioxVision is not installed in the bundle');
  const { spawnSync } = require('node:child_process');
  const probe = spawnSync(helper, ['ocr', '/nonexistent.png'], { encoding: 'utf8', timeout: 30_000 });
  assert.ok(probe.status !== null, 'the bundled OCR helper did not run');
  assert.match(String(probe.stdout || ''), /"ok"/, 'the bundled OCR helper did not answer');
  console.log('  6. native helper: QuansioxVision installed in the bundle and answering');

  /* -- 7. the bundle is not stale ---------------------------------------- */
  const { verifyNoDrift, verifyNativeFreshness } = require(path.join(ROOT, 'scripts', 'package.js'));
  const drift = verifyNoDrift(path.join(ROOT, 'src'), path.join(APP, 'Contents', 'Resources', 'app', 'src'));
  assert.strictEqual(drift.length, 0, `the bundle is stale:\n${drift.slice(0, 10).join('\n')}`);
  const nativeDrift = verifyNativeFreshness(path.join(APP, 'Contents', 'Resources', 'app', 'native'));
  assert.strictEqual(nativeDrift.length, 0, `the bundled native helpers are stale:\n${nativeDrift.join('\n')}`);
  console.log('  7. freshness: the bundle and its native helpers are byte-identical to the source/build');

  console.log('\npackaged wiring: ALL OK — every feature is wired and present in the shipped app');
}
run().catch((e) => { console.error(e); process.exit(1); });
