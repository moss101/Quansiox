'use strict';
/* Keep-awake test — Manus keepAwake pattern: powerSaveBlocker held during
 * runs, released when the last run finishes. The AC-only gate makes this
 * power-state dependent, so the test asserts the correct branch for the
 * machine's current power source (deterministic on AC and on battery). */
const Module = require('node:module');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-browser.js');
  return origResolve.call(this, req, ...rest);
};
const stub = require('./stub-electron-browser.js');

const { keepAwakeService } = require('../src/main/services/keepAwakeService.js');

function onAcPower() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('pmset', ['-g', 'ps'], { timeout: 2000, encoding: 'utf8' });
      return !/discharging/i.test(out);
    }
  } catch { /* assume AC when unknown */ }
  return true;
}

if (onAcPower()) {
  const id = keepAwakeService.ensureAwake('test run');
  assert.strictEqual(id, 1, 'first blocker id');
  assert.strictEqual(stub.__state.blockerStarts, 1);
  assert.ok(keepAwakeService.state().active);

  keepAwakeService.ensureAwake('second run');
  assert.strictEqual(stub.__state.blockerStarts, 1, 'no double start');

  keepAwakeService.release();
  assert.strictEqual(stub.__state.blockerStops, 1);
  assert.strictEqual(keepAwakeService.state().active, false);

  keepAwakeService.release();
  assert.strictEqual(stub.__state.blockerStops, 1, 'release when idle is a no-op');

  keepAwakeService.ensureAwake('again');
  assert.strictEqual(stub.__state.blockerStarts, 2, 'restart after release');
  keepAwakeService.release();
  console.log('keep-awake test: ALL OK (AC)');
} else {
  // On battery the AC-only gate must never start a blocker.
  assert.strictEqual(keepAwakeService.ensureAwake('battery test'), null);
  assert.strictEqual(stub.__state.blockerStarts, 0, 'no blocker on battery');
  assert.strictEqual(keepAwakeService.state().active, false);
  keepAwakeService.release();
  assert.strictEqual(stub.__state.blockerStops, 0, 'release is a no-op on battery');
  console.log('keep-awake test: ALL OK (battery — AC-gate honored)');
}
