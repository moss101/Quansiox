#!/usr/bin/env node
'use strict';
/**
 * Package Quansiox into a standalone double-clickable app bundle:
 *   release/Quansiox.app
 * Pattern follows what electron-builder does, minus the dependency:
 *  1. copy the local Electron dist bundle
 *  2. rename the executable, rewrite Info.plist (id/name/version/icon)
 *  3. drop our app into Resources/app (package.json main -> src/main/index.js)
 *  4. remove default_app.asar, add the icon
 *  5. ad-hoc codesign so Gatekeeper lets it run locally
 */
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ELECTRON_APP = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
const RELEASE = path.join(ROOT, 'release');
const OUT = path.join(RELEASE, 'Quansiox.app');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NATIVE_HELPERS = ['QuansioxCapture', 'QuansioxComputerHelper', 'QuansioxVaultApprover', 'QuansioxVision'];

function sh(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/**
 * Compare two directory trees and report every difference.
 * Used to prove the packaged payload did not drift from the source tree.
 *
 * @returns {string[]} human-readable difference descriptions (empty = identical)
 */
function verifyNoDrift(sourceDir, packagedDir) {
  const crypto = require('node:crypto');
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const walk = (dir, base = dir, out = new Map()) => {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full);
      if (entry.isDirectory()) walk(full, base, out);
      else if (entry.isFile()) out.set(rel, hash(full));
    }
    return out;
  };
  const source = walk(sourceDir);
  const packaged = walk(packagedDir);
  const diffs = [];
  for (const [rel, digest] of source) {
    if (!packaged.has(rel)) diffs.push(`missing from package: ${rel}`);
    else if (packaged.get(rel) !== digest) diffs.push(`content differs: ${rel}`);
  }
  for (const rel of packaged.keys()) {
    if (!source.has(rel)) diffs.push(`extra in package: ${rel}`);
  }
  return diffs;
}

/**
 * Verify the native helpers are built from the current Swift sources and,
 * when a packaged directory is supplied, installed byte-for-byte.
 *
 * The source-tree drift check cannot see this: a stale Swift helper is still
 * "byte-identical" to the source tree, yet behaves differently in the shipped
 * app. (This is how the v2.66 OCR path bug survived every other check.)
 *
 * @param {string} [packagedNativeDir] the bundle's native/ directory
 * @returns {string[]} human-readable differences (empty = current)
 */
function verifyNativeFreshness(packagedNativeDir = null) {
  const crypto = require('node:crypto');
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const problems = [];
  for (const name of NATIVE_HELPERS) {
    const source = path.join(ROOT, 'native', `${name}.swift`);
    const binary = path.join(ROOT, 'build', name);
    if (!fs.existsSync(source)) {
      if (fs.existsSync(binary)) problems.push(`${name}: the built helper has no Swift source`);
      continue;
    }
    if (!fs.existsSync(binary)) {
      problems.push(`${name}: the helper is not built — run "npm run native"`);
      continue;
    }
    const sourceStat = fs.statSync(source);
    const binaryStat = fs.statSync(binary);
    // Filesystem timestamps have one-second resolution on some volumes.
    if (binaryStat.mtimeMs + 1000 < sourceStat.mtimeMs) {
      problems.push(`${name}: the built helper is older than its Swift source — run "npm run native"`);
    }
    if (packagedNativeDir) {
      const installed = path.join(packagedNativeDir, name);
      if (!fs.existsSync(installed)) {
        problems.push(`${name}: missing from the packaged app`);
      } else if (!(fs.statSync(installed).mode & 0o111)) {
        problems.push(`${name}: the packaged helper is not executable`);
      } else if (hash(installed) !== hash(binary)) {
        problems.push(`${name}: the packaged helper differs from the fresh build — run "npm run package"`);
      }
    }
  }
  return problems;
}

/** Bare npm modules the packaged main process actually require()s, with the
 *  transitive closure of their own dependencies (ws today; scan keeps this
 *  honest if the surface grows). */function collectRuntimeDeps() {
  const roots = ['src/main', 'src/preload', 'src/coordinator'].map((d) => path.join(ROOT, d));
  const found = new Set();
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(p, 'utf8');
      for (const m of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        if (spec === 'electron' || NODE_BUILTINS.has(spec)) continue;
        found.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
  };
  for (const dir of roots) if (fs.existsSync(dir)) visit(dir);

  const closure = new Set(found);
  const queue = [...found];
  while (queue.length) {
    const dep = queue.pop();
    const manifest = path.join(ROOT, 'node_modules', dep, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const meta = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const next of Object.keys(meta.dependencies ?? {})) {
      if (!closure.has(next) && fs.existsSync(path.join(ROOT, 'node_modules', next))) {
        closure.add(next);
        queue.push(next);
      }
    }
  }
  return [...closure].filter((d) => fs.existsSync(path.join(ROOT, 'node_modules', d))).sort();
}

function main() {
  if (!fs.existsSync(ELECTRON_APP)) {
    console.error('Electron dist missing — run: node node_modules/electron/install.js');
    process.exit(1);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  console.log('• copying Electron bundle…');
  sh(`cp -R ${JSON.stringify(ELECTRON_APP)} ${JSON.stringify(OUT)}`);

  const contents = path.join(OUT, 'Contents');

  console.log('• renaming executable…');
  fs.renameSync(path.join(contents, 'MacOS', 'Electron'), path.join(contents, 'MacOS', 'Quansiox'));
  // Helper apps keep their names; only the main binary matters.

  console.log('• writing Info.plist…');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Quansiox</string>
  <key>CFBundleExecutable</key><string>Quansiox</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleIdentifier</key><string>im.quansiox.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Quansiox</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>Quansiox saves the files it creates for you in your Documents folder.</string>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist);

  console.log('• installing app payload…');
  fs.rmSync(path.join(contents, 'Resources', 'default_app.asar'), { force: true });
  const appDir = path.join(contents, 'Resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const item of ['src', 'package.json', 'README.md']) {
    sh(`cp -R ${JSON.stringify(path.join(ROOT, item))} ${JSON.stringify(appDir)}`);
  }

  // Drift check: the packaged payload must be byte-identical to the source
  // tree. A packaged build that lags the source is the single most expensive
  // class of bug in this project — it was the root cause of the "the app
  // behaves differently from the repo" reports in the parity review.
  const drift = verifyNoDrift(path.join(ROOT, 'src'), path.join(appDir, 'src'));
  if (drift.length) {
    console.error('✗ packaged payload drifted from source:');
    for (const line of drift.slice(0, 20)) console.error(`   ${line}`);
    throw new Error(`packaged payload differs from source in ${drift.length} place(s)`);
  }
  console.log('• verified: packaged src is byte-identical to source src');

  // Main-process runtime deps: the asar-less bundle has no node_modules, so
  // anything require()d by src/main|preload|coordinator must ship alongside.
  const runtimeDeps = collectRuntimeDeps();
  if (runtimeDeps.length) {
    console.log(`• installing runtime dependencies (${runtimeDeps.join(', ')})…`);
    const nm = path.join(appDir, 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    for (const dep of runtimeDeps) {
      const from = path.join(ROOT, 'node_modules', dep);
      const to = path.join(nm, dep);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      sh(`cp -R ${JSON.stringify(from)} ${JSON.stringify(to)}`);
    }
  }

  // Linux-VM sandbox runtime (Virtualization.framework): the agent binary,
  // its kernel and initrd. Build artifacts (rootfs/apk/minirootfs) stay out.
  const vmSrc = path.join(ROOT, 'vm');
  const vmRuntime = ['qx-vm', 'Image', 'initramfs.cpio.gz'];
  if (vmRuntime.every((f) => fs.existsSync(path.join(vmSrc, f)))) {
    console.log('• installing VM sandbox runtime…');
    const vmDir = path.join(appDir, 'vm');
    fs.mkdirSync(vmDir, { recursive: true });
    for (const f of vmRuntime) {
      fs.copyFileSync(path.join(vmSrc, f), path.join(vmDir, f));
      fs.chmodSync(path.join(vmDir, f), 0o755);
    }
  }

  // Live guest desktop runtime (unified-computer runtime, opt-in): the desktop
  // VM binary + its X+Chromium image + desktop initramfs. Only shipped if built.
  const desktopRuntime = ['qx-vm.next', 'desktop-Image', 'desktop-initramfs.cpio.gz'];
  if (desktopRuntime.every((f) => fs.existsSync(path.join(vmSrc, f)))) {
    console.log('• installing live desktop VM runtime…');
    const vmDir = path.join(appDir, 'vm');
    fs.mkdirSync(vmDir, { recursive: true });
    for (const f of desktopRuntime) {
      fs.copyFileSync(path.join(vmSrc, f), path.join(vmDir, f));
      fs.chmodSync(path.join(vmDir, f), 0o755);
    }
  }

  // Native human-demonstration capture helper (GPA G3): the compiled
  // CGEventTap binary lives beside the app's src/ and is signed with the app.
  const nativeDir = path.join(appDir, 'native');
  for (const name of NATIVE_HELPERS) {
    const binary = path.join(ROOT, 'build', name);
    if (!fs.existsSync(binary)) continue;
    console.log(`• installing native helper ${name}…`);
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.copyFileSync(binary, path.join(nativeDir, name));
    fs.chmodSync(path.join(nativeDir, name), 0o755);
  }
  const nativeDrift = verifyNativeFreshness(nativeDir);
  if (nativeDrift.length) {
    console.error('✗ native helpers are stale:');
    for (const line of nativeDrift) console.error(`   ${line}`);
    throw new Error(`native helpers are stale in ${nativeDrift.length} place(s)`);
  }
  console.log('• verified: native helpers are current and installed from the fresh build');

  if (fs.existsSync(path.join(ROOT, 'build', 'icon.icns'))) {
    fs.copyFileSync(path.join(ROOT, 'build', 'icon.icns'), path.join(contents, 'Resources', 'icon.icns'));
  }

  console.log('• ad-hoc codesigning…');
  sh(`codesign --force --deep --sign - ${JSON.stringify(OUT)}`);

  // --deep re-signs nested binaries ad-hoc WITHOUT their entitlements, which
  // strips com.apple.security.virtualization and breaks VM boot. Re-sign every
  // VZ host binary (headless sandbox AND the desktop guest) with entitlements,
  // then reseal the outer bundle.
  const qxEnt = path.join(ROOT, 'vm', 'qx-vm.entitlements');
  const vzBins = ['qx-vm', 'qx-vm.next'].map((name) => path.join(appDir, 'vm', name));
  let reseal = false;
  for (const bin of vzBins) {
    if (fs.existsSync(bin) && fs.existsSync(qxEnt)) {
      sh(`codesign --force --sign - --entitlements ${JSON.stringify(qxEnt)} ${JSON.stringify(bin)}`);
      reseal = true;
    }
  }
  if (reseal) sh(`codesign --force --sign - ${JSON.stringify(OUT)}`);

  console.log(`✓ packaged: ${OUT}`);

  // The wiring gate. A bundle can be byte-identical to the source and still
  // be *unreachable* — a namespace that never registers, a renderer surface
  // that never mounts, a native helper that is installed but not found. All
  // three happened during development, so the gate checks them.
  {
    const wiring = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'test', 'packaged-wiring.js')],
      { stdio: 'inherit', env: { ...process.env, QUANSIOX_PACKAGED_APP: OUT } }
    );
    if (wiring.status !== 0) {
      throw new Error('the packaged app failed the wiring check — see the output above');
    }
  }

  // The distributable artefacts. The .app alone is a working bundle, but it
  // is not something you can hand to someone else, and a zip of an app
  // bundle made with the ordinary `zip` tool loses the symlinks and the
  // resource forks — so `ditto` is the one that produces a bundle Apple will
  // still accept after it is unzipped.
  const version = pkg.version || '0.0.0';
  const zip = path.join(RELEASE, `Quansiox-${version}.zip`);
  fs.rmSync(zip, { force: true });
  sh(`ditto -c -k --sequesterRsrc --keepParent ${JSON.stringify(OUT)} ${JSON.stringify(zip)}`);
  console.log(`✓ archive: ${path.relative(ROOT, zip)} (${Math.round(fs.statSync(zip).size / 1024 / 1024)} MB)`);

  // A disk image, so the app can be dragged to Applications.
  //
  // The image is UNCOMPRESSED (UDRO) and carries an install note, because an
  // Electron app cannot be RUN from a mounted image: the Chromium sandbox
  // cannot issue the bundle's files to its helper processes from that volume,
  // so every helper dies and the app aborts on launch with exit 133. (This is
  // not a Quansiox defect — a stock Electron app fails the same way. The
  // image is a delivery vehicle: drag the app to Applications and run it
  // from there.)
  const dmg = path.join(RELEASE, `Quansiox-${version}.dmg`);
  fs.rmSync(dmg, { force: true });
  const stage = path.join(RELEASE, '.dmg-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
  // `ditto`, NOT `fs.cpSync`: Node's copy resolves symlinks to ABSOLUTE
  // paths unless `verbatimSymlinks` is set, which would point the Electron
  // framework's version symlinks back at this build machine. The dragged
  // copy would then have an unreachable framework and the app would die on
  // launch with a sandbox error.
  sh(`ditto ${JSON.stringify(OUT)} ${JSON.stringify(path.join(stage, 'Quansiox.app'))}`);
  fs.writeFileSync(path.join(stage, 'INSTALL.txt'), [
    'Quansiox',
    '',
    'INSTALL',
    '  1. Drag "Quansiox.app" onto the "Applications" icon in this window.',
    '  2. Launch Quansiox from your Applications folder.',
    '',
    'DO NOT LAUNCH IT FROM THIS DISK IMAGE.',
    '  An Electron app cannot run from a mounted disk image: the Chromium',
    '  sandbox cannot hand the application bundle to its helper processes',
    '  from that volume, and the app quits with an error on launch. Copy it',
    '  to Applications first — it takes a second, and then it works.',
    '',
    `Version ${version}`,
  ].join('\n'));
  try {
    sh(`hdiutil create -volname Quansiox -srcfolder ${JSON.stringify(stage)} -ov -format UDRO ${JSON.stringify(dmg)}`);
    console.log(`✓ disk image: ${path.relative(ROOT, dmg)}`);

    // Check the image has what it should.
    const contents = verifyDmgContents(dmg);
    if (!contents.ok) {
      console.error(`✗ the disk image is incomplete: ${contents.reason}`);
      throw new Error(`the disk image is incomplete: ${contents.reason}`);
    }
    console.log(`✓ verified: ${contents.reason}`);

    // And check the app itself launches — from a writable copy, which is the
    // path the user ends up on after the drag.
    const launch = verifyAppLaunch(OUT);
    if (!launch.ok) {
      console.error(`✗ the app does not launch: ${launch.reason}`);
      throw new Error(`the app does not launch: ${launch.reason}`);
    }
    console.log(`✓ verified: ${launch.reason}`);
  } catch (error) {
    if (/does not launch|is incomplete/.test(String(error?.message ?? ''))) throw error;
    // A disk image is a convenience; the zip is the artefact.
    console.warn(`! could not build the disk image: ${String(error?.message ?? error).slice(0, 200)}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Verify the app actually launches — from a WRITABLE location.
 *
 * This is the check that matters, and it is where the packaging used to lie.
 *
 * An Electron app cannot be RUN from a mounted disk image: the Chromium
 * sandbox cannot issue the bundle's files to its helper processes from that
 * volume, so every helper dies and the app aborts with
 *
 *     sandbox_extension_issue_file failed ... (Operation not permitted)
 *     GPU process exited unexpectedly: exit_code=15
 *     FATAL: GPU process isn't usable. Goodbye.   (exit 133)
 *
 * This is not a Quansiox defect — a stock Electron app fails the same way.
 * The disk image is a DELIVERY VEHICLE: the app is dragged to /Applications
 * and run from there, which is the path that has to work.
 *
 * So the verification copies the app to a writable directory, launches it,
 * and checks it stayed up.
 *
 * @param {string} appPath  the .app to launch
 * @returns {{ ok: boolean, reason: string }}
 */
function verifyAppLaunch(appPath) {
  const { spawn, spawnSync, execFileSync } = require('node:child_process');
  const os = require('node:os');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-launch-'));
  const copy = path.join(staging, 'Quansiox.app');
  try {
    // `ditto` preserves the bundle's symlinks; `fs.cpSync` would resolve
    // them to absolute paths and make the check fail for the wrong reason.
    execFileSync('/usr/bin/ditto', [appPath, copy], { stdio: 'ignore' });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: `the app could not be copied for the launch check: ${String(error?.message ?? error).slice(0, 200)}` };
  }
  const binary = path.join(copy, 'Contents', 'MacOS', path.basename(path.dirname(path.dirname(copy))) === 'Quansiox.app'
    ? 'Quansiox'
    : 'Quansiox');
  let child = null;
  let stderr = '';
  try {
    child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && exited === null) {
      spawnSync('/bin/sleep', ['0.4']);
    }
    if (exited !== null) {
      const fatal = /GPU process isn't usable|FATAL:|sandbox_extension_issue_file|icudtl\.dat not found/i.test(stderr);
      return {
        ok: false,
        reason: fatal
          ? `the app died on launch: ${(stderr.match(/FATAL:.*|sandbox_extension_issue_file.*|icudtl\.dat not found.*/i) || ['unknown failure'])[0].trim().slice(0, 200)}`
          : `the app exited immediately (code ${exited.code}, signal ${exited.signal ?? 'none'}): ${stderr.trim().slice(0, 200)}`,
      };
    }
    return { ok: true, reason: 'the app launched and stayed up' };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
  } finally {
    try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    // The launch check copies the app to a temp directory. macOS registers
    // every bundle it sees, and a leftover registration under the name
    // "Quansiox" makes the system open the WRONG copy later. Unregister it.
    try {
      require('node:child_process').execFileSync(
        '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
        ['-u', copy],
        { stdio: 'ignore' },
      );
    } catch { /* lsregister is best-effort */ }
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Check that the disk image contains what it should: the app, the
 * Applications symlink, the install note, and — the thing that actually
 * broke it — framework symlinks that are relative and resolve inside the
 * image.
 */
function verifyDmgContents(dmg) {
  const { spawnSync } = require('node:child_process');
  // `diskutil image attach` is the non-deprecated form, and it prints the
  // mount point so the volume does not have to be guessed.
  const attach = spawnSync('diskutil', ['image', 'attach', dmg, '-mountOptions', 'nobrowse', '-readOnly'], { encoding: 'utf8' });
  const output = `${attach.stdout ?? ''}${attach.stderr ?? ''}`;
  if (attach.status !== 0) {
    return { ok: false, reason: `the image could not be mounted: ${output.trim().slice(0, 200)}` };
  }
  // `diskutil image attach` prints a device table; the mount point is the
  // last field of the line naming the volume.
  const volumeLine = output.split('\n').find((line) => /Apple_APFS_Volume\s+\/Volumes\//.test(line))
    || output.split('\n').find((line) => /\/Volumes\//.test(line));
  const root = volumeLine ? volumeLine.trim().split(/\s+/).pop() : null;
  let mountedRoot = root;
  if (!mountedRoot) {
    // Fall back to the volume name.
    const name = path.basename(dmg).replace(/^Quansiox-?/, '').replace(/\.dmg$/, '') || 'Quansiox';
    mountedRoot = `/Volumes/${name}`;
  }
  try {
    const app = path.join(mountedRoot, 'Quansiox.app');
    const problems = [];
    if (!fs.existsSync(app)) problems.push(`the image has no Quansiox.app (looked in ${mountedRoot})`);
    if (!fs.existsSync(path.join(app, 'Contents', 'MacOS', 'Quansiox'))) problems.push('the app has no executable');
    if (!fs.existsSync(path.join(mountedRoot, 'Applications'))) problems.push('the image has no Applications symlink');
    if (!fs.existsSync(path.join(mountedRoot, 'INSTALL.txt'))) problems.push('the image has no INSTALL.txt');
    // The framework's version symlinks must be RELATIVE and must resolve
    // inside the image. An absolute symlink (what `fs.cpSync` produces)
    // points at the build machine and breaks the app after the drag.
    const frameworkDir = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework');
    try {
      const link = fs.readlinkSync(path.join(frameworkDir, 'Electron Framework'));
      if (path.isAbsolute(link)) problems.push(`the framework symlink is absolute (${link})`);
      else if (!fs.existsSync(path.join(frameworkDir, 'Electron Framework'))) {
        problems.push('the framework symlink does not resolve inside the image');
      }
    } catch (error) {
      problems.push(`the framework symlink is unreadable: ${String(error?.message ?? error).slice(0, 80)}`);
    }
    if (problems.length) return { ok: false, reason: problems.join('; ') };
    return { ok: true, reason: 'the image contains the app, the Applications symlink, the install note, and its symlinks resolve inside the image' };
  } finally {
    try { spawnSync('hdiutil', ['detach', mountedRoot, '-quiet'], { stdio: 'ignore' }); } catch { /* already detached */ }
  }
}

if (require.main === module) main();

module.exports = { verifyNoDrift, verifyNativeFreshness, collectRuntimeDeps, verifyAppLaunch, verifyDmgContents, main };
