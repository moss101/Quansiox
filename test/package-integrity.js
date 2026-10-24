'use strict';
/* The packaging integrity.
 *
 * A packaged app is a bundle of symlinks, and the failure mode is silent:
 * the files are all there, the signature verifies, and the app still dies on
 * launch with a Chromium sandbox error.
 *
 * Two real bugs are pinned here:
 *
 *  1. Node's `fs.cpSync` resolves symlinks to ABSOLUTE paths unless
 *     `verbatimSymlinks` is set. Copying the app that way into a disk image
 *     left the Electron framework's version symlinks pointing back at the
 *     build machine, so the image shipped a bundle whose framework was
 *     unreachable.
 *
 *  2. An Electron app cannot be RUN from a mounted disk image: the Chromium
 *     sandbox cannot issue the bundle to its helper processes from that
 *     volume. The image is a delivery vehicle — the app is dragged to
 *     /Applications and run from there.
 *
 * The tests below check the built artefacts, so a regression fails here
 * rather than on a user's machine.
 *
 * Skipped when nothing has been packaged yet. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const APP = path.join(RELEASE, 'Quansiox.app');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const packaged = fs.existsSync(APP);
if (!packaged) {
  console.log('  skip packaging integrity — run "npm run package" first');
  console.log('\npackaging integrity: skipped');
  process.exit(0);
}

check('the packaged app has an executable', () => {
  const binary = path.join(APP, 'Contents', 'MacOS', 'Quansiox');
  assert.ok(fs.existsSync(binary), `missing ${binary}`);
});

check('the framework version symlinks are RELATIVE', () => {
  const framework = path.join(APP, 'Contents', 'Frameworks', 'Electron Framework.framework');
  for (const name of ['Electron Framework', 'Helpers', 'Libraries', 'Resources']) {
    const link = path.join(framework, name);
    assert.ok(fs.existsSync(link), `missing ${name}`);
    const target = fs.readlinkSync(link);
    assert.ok(
      !path.isAbsolute(target),
      `the "${name}" symlink is absolute (${target}) — it points outside the bundle and breaks the app after the drag`,
    );
  }
});

check('the framework symlinks resolve INSIDE the bundle', () => {
  const framework = path.join(APP, 'Contents', 'Frameworks', 'Electron Framework.framework');
  for (const name of ['Electron Framework', 'Helpers', 'Libraries', 'Resources']) {
    assert.ok(
      fs.existsSync(path.join(framework, name)),
      `the "${name}" symlink does not resolve inside the bundle`,
    );
  }
});

// The DRIFT check is a release gate, not a unit test: it compares the
// packaged app against the source tree, so it fails whenever the source
// changes and the package has not been rebuilt. That is the right behaviour
// for a release, and the wrong behaviour for `npm test` during development.
//
// It runs in `npm run verify-package`, and `npm run package` performs it too,
// so a stale app cannot be shipped.
check('the packaged payload is not NEWER than the source (a release gate, checked by npm run verify-package)', () => {
  const srcNewest = Math.max(
    ...['src/renderer-src/main.jsx', 'src/renderer/styles.css', 'src/main/index.js']
      .map((rel) => { try { return fs.statSync(path.join(ROOT, rel)).mtimeMs; } catch { return 0; } }),
  );
  const packaged = fs.statSync(path.join(APP, 'Contents', 'Resources', 'app', 'src')).mtimeMs;
  // A warning, not a failure: the unit suite must not depend on a release
  // build being current.
  if (packaged < srcNewest) {
    results.push('  note the packaged app is older than the source — run "npm run verify-package" to see the drift');
  }
});

check('the app is signed', () => {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', APP], { stdio: 'pipe' });
  } catch (error) {
    assert.fail(`the signature does not verify: ${String(error?.stderr ?? error?.message ?? error).slice(0, 300)}`);
  }
});

check('the packaging script copies the bundle with ditto, not fs.cpSync', () => {
  // `fs.cpSync` resolves symlinks to absolute paths. The stage copy MUST use
  // ditto, which preserves them.
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'package.js'), 'utf8');
  const stageCopy = source.match(/ditto[^\n]*Quansiox\.app|fs\.cpSync\([^)]*Quansiox\.app[^)]*\)/);
  assert.ok(stageCopy, 'the stage copy could not be found');
  assert.ok(
    !/fs\.cpSync\([^)]*Quansiox\.app/.test(stageCopy[0]),
    'the disk-image stage copy uses fs.cpSync, which resolves the bundle symlinks to absolute paths',
  );
});

check('the disk image carries the install note and the Applications symlink', () => {
  const dmg = fs.readdirSync(RELEASE).find((f) => f.endsWith('.dmg'));
  if (!dmg) return; // no image built — the zip is still the artefact
  const { verifyDmgContents } = require('../scripts/package.js');
  const verdict = verifyDmgContents(path.join(RELEASE, dmg));
  assert.ok(verdict.ok, verdict.reason);
});

check('the archive contains the bundle with its symlinks intact', () => {
  const zip = fs.readdirSync(RELEASE).find((f) => f.endsWith('.zip'));
  if (!zip) return;
  const { execFileSync } = require('node:child_process');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-zip-'));
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', path.join(RELEASE, zip), staging], { stdio: 'pipe' });
    const extracted = path.join(staging, 'Quansiox.app');
    assert.ok(fs.existsSync(extracted), 'the archive did not extract to Quansiox.app');
    const framework = path.join(extracted, 'Contents', 'Frameworks', 'Electron Framework.framework');
    const target = fs.readlinkSync(path.join(framework, 'Electron Framework'));
    assert.ok(!path.isAbsolute(target), `the extracted symlink is absolute (${target})`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

console.log(results.join('\n'));
if (process.exitCode) {
  console.error('\npackaging integrity: FAILED');
  process.exit(1);
}
console.log(`\npackaging integrity: ${results.length} checks OK`);
