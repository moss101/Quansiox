'use strict';
/**
 * Build the native macOS helpers with swiftc:
 *   build/QuansioxCapture          human-demonstration CGEventTap
 *   build/QuansioxComputerHelper   computer-use NDJSON helper (Phase 2a)
 *   build/QuansioxVaultApprover    Touch ID / passcode gate for secret release
 *
 * All three must build: `scripts/package.js` packages them and
 * `vaultService` / `onePasswordService` load the approver from `build/`. A
 * missing approver means the secret-release gate silently falls back — which
 * is a security regression, not a cosmetic one.
 *
 * Binaries are ad-hoc signed with the app during packaging. If Swift or the SDK
 * is unavailable, the JS/AppleScript fallbacks stay in use (computerHostService
 * only prefers the native helper when the executable exists).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');

const TARGETS = [
  {
    name: 'QuansioxCapture',
    src: path.join(ROOT, 'native', 'QuansioxCapture.swift'),
    frameworks: ['AppKit', 'ApplicationServices', 'CoreGraphics'],
  },
  {
    name: 'QuansioxComputerHelper',
    src: path.join(ROOT, 'native', 'QuansioxComputerHelper.swift'),
    frameworks: ['AppKit', 'ApplicationServices', 'CoreGraphics'],
  },
  {
    name: 'QuansioxVision',
    src: path.join(ROOT, 'native', 'QuansioxVision.swift'),
    frameworks: ['AppKit', 'Vision', 'Foundation'],
  },
  {
    name: 'QuansioxVaultApprover',
    src: path.join(ROOT, 'native', 'QuansioxVaultApprover.swift'),
    frameworks: ['AppKit', 'LocalAuthentication', 'CoreGraphics'],
  },
];

function haveSwiftc() {
  try {
    execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
    return true;
  } catch {
    try {
      execFileSync('/usr/bin/which', ['swiftc'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

function build({ name, src, frameworks }) {
  if (!fs.existsSync(src)) return { name, skipped: 'source missing' };
  fs.mkdirSync(OUT, { recursive: true });
  const out = path.join(OUT, name);
  const args = ['-O', '-o', out, src];
  for (const framework of frameworks) args.push('-framework', framework);
  execFileSync('/usr/bin/xcrun', ['swiftc', ...args], { stdio: 'inherit' });
  fs.chmodSync(out, 0o755);
  const { size } = fs.statSync(out);
  return { name, out, size };
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('native helpers: skipped (macOS only)');
    return [];
  }
  if (!haveSwiftc()) {
    console.log('native helpers: swiftc not found — using JS/AppleScript fallbacks');
    return [];
  }
  const results = TARGETS.map(build);
  for (const r of results) {
    if (r.skipped) console.log(`• ${r.name}: skipped (${r.skipped})`);
    else console.log(`• ${r.name}: ${r.out} (${Math.round(r.size / 1024)} KB)`);
  }
  return results;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`native build failed: ${error?.message ?? error}`);
    process.exit(1);
  }
}

module.exports = { TARGETS, build, main, haveSwiftc };
