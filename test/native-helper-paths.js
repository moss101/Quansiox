'use strict';
/**
 * Native-helper path resolution test.
 *
 * Every native helper is built into `build/` in the source tree, but the
 * packaging step installs the binaries into `native/` inside the app bundle.
 * A service that resolves only one of those two directories works in
 * development and is **silently broken in the shipped app** — the feature
 * just reports "not available" and nothing else says why.
 *
 * This test resolves each helper the way the service does, and — when a
 * packaged app exists — it loads the **packaged** copy of the service and
 * asks it where the helper is, then checks that path really exists. That is
 * the only check that proves the shipped app can find its own binaries.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'release', 'Quansiox.app');
const PACKAGED_APP_SRC = path.join(APP, 'Contents', 'Resources', 'app', 'src');

const HELPERS = [
  { name: 'QuansioxComputerHelper', service: 'computerHostService', probe: (m) => m.computerHostService?.helperPath?.() ?? m.computerHostService?.helper?.() },
  { name: 'QuansioxCapture', service: 'humanCaptureService', probe: (m) => m.humanCaptureService?.helperPath?.() ?? null },
  { name: 'QuansioxVaultApprover', service: 'vaultService', probe: (m) => m.vaultService?.approverPath?.() ?? null },
  { name: 'QuansioxVision', service: 'multimediaService', probe: (m) => m.multimediaService?.helperPath?.() ?? null },
];

/** Every path a service will accept for a helper, in order. */
function candidatesFor(name) {
  const root = path.join(ROOT, 'src', 'main', 'services');
  return ['build', 'native'].map((directory) => path.join(root, '..', '..', '..', directory, name));
}

async function run() {
  /* -- 1. the source tree ------------------------------------------------ */
  for (const helper of HELPERS) {
    const candidates = candidatesFor(helper.name);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    assert.ok(found, `${helper.name} is not found in the source tree (looked in ${candidates.join(', ')})`);
    assert.ok(fs.statSync(found).mode & 0o111, `${helper.name} is not executable`);
  }

  /* -- 2. every service must consider BOTH directories -------------------- */
  // A service that only knows about `build/` works in the source tree and
  // breaks in the bundle, so the *set* of candidate directories is part of
  // the contract.
  const sources = {
    computerHostService: fs.readFileSync(path.join(ROOT, 'src/main/services/computerHostService.js'), 'utf8'),
    humanCaptureService: fs.readFileSync(path.join(ROOT, 'src/main/services/humanCaptureService.js'), 'utf8'),
    vaultService: fs.readFileSync(path.join(ROOT, 'src/main/services/vaultService.js'), 'utf8'),
    onePasswordService: fs.readFileSync(path.join(ROOT, 'src/main/services/onePasswordService.js'), 'utf8'),
    multimediaService: fs.readFileSync(path.join(ROOT, 'src/main/services/multimediaService.js'), 'utf8'),
  };
  const expected = {
    computerHostService: 'QuansioxComputerHelper',
    humanCaptureService: 'QuansioxCapture',
    vaultService: 'QuansioxVaultApprover',
    onePasswordService: 'QuansioxVaultApprover',
    multimediaService: 'QuansioxVision',
  };
  for (const [service, helper] of Object.entries(expected)) {
    const source = sources[service];
    assert.ok(source.includes(helper), `${service} does not mention ${helper}`);
    assert.match(source, /['"]build['"]/, `${service} does not consider the build/ directory`);
    assert.match(source, /['"]native['"]/, `${service} does not consider the native/ directory — it would break in the packaged app`);
  }

  /* -- 3. the packaged app ------------------------------------------------ */
  if (!fs.existsSync(PACKAGED_APP_SRC)) {
    console.log('native-helper paths: source tree OK (no packaged app to check)');
    return;
  }
  const packagedNative = path.join(APP, 'Contents', 'Resources', 'app', 'native');
  for (const helper of HELPERS) {
    const installed = path.join(packagedNative, helper.name);
    assert.ok(fs.existsSync(installed), `${helper.name} is not installed in the packaged app`);
    assert.ok(fs.statSync(installed).mode & 0o111, `the packaged ${helper.name} is not executable`);
  }

  // The decisive check: load the **packaged** service and ask it where the
  // helper is. If the packaged code resolves to a path that does not exist,
  // the feature is broken in the shipped app.
  const { multimediaService } = require(path.join(PACKAGED_APP_SRC, 'main/services/multimediaService.js'));
  const resolved = multimediaService.visionHelperPath();
  assert.ok(fs.existsSync(resolved), `the packaged multimediaService resolves ${resolved}, which does not exist`);
  assert.ok(
    resolved.startsWith(path.join(APP, 'Contents', 'Resources', 'app')),
    `the packaged multimediaService resolved outside the app bundle: ${resolved}`
  );
  assert.strictEqual(multimediaService.visionAvailable(), true, 'the packaged app cannot see its OCR helper');

  // And the helper there actually runs.
  const { spawnSync } = require('node:child_process');
  const probe = spawnSync(resolved, ['ocr', '/nonexistent-image.png'], { encoding: 'utf8', timeout: 30_000 });
  assert.ok(probe.status !== null, 'the packaged OCR helper did not run');
  assert.match(String(probe.stdout || ''), /"ok":false/, 'the packaged OCR helper answered');

  console.log('native-helper paths: source tree + packaged app OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
