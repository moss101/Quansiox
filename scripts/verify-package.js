#!/usr/bin/env node
'use strict';
/**
 * The release gate: the packaged app must match the source tree exactly.
 *
 * A stale package is the most expensive class of bug in this project — the
 * app behaves differently from the repository, and the user has no way to
 * tell. `npm run package` performs this check too; this script is the
 * standalone version for CI and for "did I remember to rebuild?".
 */
const path = require('node:path');
const { verifyNoDrift, verifyNativeFreshness } = require('./package.js');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'release', 'Quansiox.app');
const source = path.join(ROOT, 'src');
const packaged = path.join(APP, 'Contents', 'Resources', 'app', 'src');

const drift = verifyNoDrift(source, packaged);
if (drift.length) {
  console.error('the packaged app does not match the source:');
  for (const line of drift.slice(0, 30)) console.error(`  ${line}`);
  console.error(`\n${drift.length} difference(s). Run "npm run package" and try again.`);
  process.exit(1);
}
console.log('the packaged app is byte-identical to the source tree');

const nativeDrift = verifyNativeFreshness(path.join(APP, 'Contents', 'Resources', 'app', 'native'));
if (nativeDrift.length) {
  console.error('the packaged native helpers are stale:');
  for (const line of nativeDrift) console.error(`  ${line}`);
  console.error('\nRun "npm run native" and then "npm run package".');
  process.exit(1);
}
console.log('the native helpers are current and byte-identical to the fresh build');
