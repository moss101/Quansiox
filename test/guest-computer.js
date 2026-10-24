'use strict';
/* Guest computer-use test — maps computer_* actions into guest commands (xdotool)
 * + a base64 screencap round-trip via an injected VM exec client, verifying
 * command construction, input escaping, PNG validation, effect verification, and
 * unknown/failed capture handling. Node-only (live guest X is hardware-gated). */
const assert = require('node:assert/strict');
const { guestComputerService } = require('../src/main/services/guestComputerService');

const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');
function fakeGuest(execLog, { ok = true, screencapB64 } = {}) {
  return {
    async exec(sessionId, command) {
      execLog.push(command);
      if (/import -silent -window root png:- .* base64|xwd -root/.test(command)) {
        return ok ? { exitCode: 0, output: screencapB64 ?? PNG.toString('base64') } : { exitCode: 1, output: 'no X display' };
      }
      return { exitCode: 0, output: '' };
    },
  };
}

async function run() {
  // 1. command mapping (pure)
  assert.strictEqual(guestComputerService.mapCommand('computer_click', { x: 12, y: 34 }), 'xdotool mousemove 12 34 click 1');
  assert.strictEqual(guestComputerService.mapCommand('computer_move', { x: -5, y: 9 }), 'xdotool mousemove 0 9', 'negative coord clamped');
  assert.strictEqual(guestComputerService.mapCommand('computer_key', { key: 'Return', modifiers: ['ctrl'] }), "xdotool key 'ctrl+Return'", 'modifier combo');
  assert.match(guestComputerService.mapCommand('computer_type', { text: "O'Brien" }), /xdotool type --delay 12 -- 'O'\\''Brien'/, 'single-quote escaping');
  assert.strictEqual(guestComputerService.mapCommand('computer_scroll', { x: 1, y: 2, deltaY: -3 }), 'xdotool mousemove 1 2 click 5', 'scroll down = button 5');
  assert.strictEqual(guestComputerService.mapCommand('computer_screenshot', {}), null, 'screenshot has no xdotool map');

  // 2. screenshot round-trip: base64 output → validated PNG → dataUrl + frameHash
  const log = [];
  let r = await guestComputerService.act('g1', 'computer_screenshot', {}, fakeGuest(log));
  assert.strictEqual(r.ok, true);
  assert.match(r.dataUrl, /^data:image\/png;base64,/, 'PNG data URL');
  assert.ok(r.frameHash, 'frameHash computed');
  assert.ok(log.some((c) => /base64 -w0/.test(c)), 'binary-safe base64 screencap');

  // 3. an action (click) runs xdotool THEN a verification screencap
  const log2 = [];
  r = await guestComputerService.act('g1', 'computer_click', { x: 10, y: 20 }, fakeGuest(log2));
  assert.strictEqual(r.ok, true);
  assert.ok(r.frameHash, 'post-action frameHash for effect verification');
  assert.strictEqual(log2[0], 'xdotool mousemove 10 20 click 1', 'action runs first');
  assert.ok(log2.some((c) => /base64 -w0/.test(c)), 'verification screencap after the action');

  // 4. unknown tool → ok:false
  r = await guestComputerService.act('g1', 'computer_bogus', {}, fakeGuest([]));
  assert.strictEqual(r.ok, false);

  // 5. screencap failure → honest error (no fake success)
  r = await guestComputerService.act('g1', 'computer_screenshot', {}, fakeGuest([], { ok: false }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no X display|screencap/);

  // 6. screencap that returns non-PNG bytes → refused
  r = await guestComputerService.act('g1', 'computer_screenshot', {}, fakeGuest([], { screencapB64: Buffer.from('not-a-png').toString('base64') }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /did not return a PNG/);

  console.log('guest-computer test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
