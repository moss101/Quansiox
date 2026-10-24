'use strict';
/* Guest computer bridge test — maps the coordinator's Mac-style computer_*
 * methods to RFB input via a fake attached client + fake factory; verifies attach
 * routing, ASCII typing keysyms, modifiers, scroll/click, honest screenshot (no
 * fake pixels), unsupported (ax) honesty, and detach. Node-only. */
const assert = require('node:assert/strict');
const bridge = require('../src/main/services/guestComputerBridge').guestComputerBridge;

// Fake RFB client: records events. capture() returns a 2x2 RGBA framebuffer.
function fakeClient() {
  const evts = [];
  return {
    width: 640, height: 480, name: 'Guest',
    pointerEvent: (x, y, m) => evts.push(['ptr', x, y, m]),
    keyEvent: (k, d) => evts.push(['key', k, d]),
    leftClick: (x, y) => evts.push(['click', x, y]),
    rightClick: (x, y) => evts.push(['rclick', x, y]),
    scroll: (x, y, dy) => evts.push(['scroll', x, y, dy]),
    move: (x, y) => evts.push(['move', x, y]),
    capture: async () => {
      evts.push(['capture']);
      const rgba = Buffer.from([
        255, 0, 0, 255, 0, 255, 0, 255,
        0, 0, 255, 255, 255, 255, 255, 255,
      ]); // 2x2
      return { width: 2, height: 2, rgba };
    },
    close: () => evts.push(['close']),
    _evts: evts,
  };
}

async function run() {
  const c = fakeClient();
  bridge.setClientFactory(async () => c);
  const attached = await bridge.attach('g1', '/tmp/does-not-exist.sock');
  assert.strictEqual(attached, c);
  assert.strictEqual(bridge.isAttached('g1'), true);

  // screenshot first: REAL guest pixels → PNG data URL + coordinate token
  c._evts.length = 0;
  const shot = await bridge.computer('g1', 'screenshot', {});
  assert.match(shot.data, /^data:image\/png;base64,/, 'real guest framebuffer as a PNG');
  assert.strictEqual(shot.width, 2);
  assert.strictEqual(shot.height, 2);
  assert.ok(shot.id && shot.coordinateToken, 'screenshot issues id + coordinate token');
  assert.ok(shot.frameHash, 'frameHash from guest pixels');
  assert.ok(Buffer.from(shot.data.split(',')[1], 'base64').subarray(1, 4).toString() === 'PNG', 'valid PNG magic');

  // coordinate gate: a click without the fresh token is refused (no fake action)
  c._evts.length = 0;
  const refused = await bridge.computer('g1', 'click', { x: 3, y: 4 });
  assert.match(String(refused), /SCREENSHOT_REQUIRED|coordinate_token/, 'click without a token is refused');
  assert.strictEqual(c._evts.some((e) => e[0] === 'click'), false, 'no click reached the guest');

  // with the issued token, click/scroll/move route straight through
  await bridge.computer('g1', 'click', { x: 3, y: 4, coordinate_token: shot.coordinateToken });
  assert.deepStrictEqual(c._evts.at(-1), ['click', 3, 4]);
  await bridge.computer('g1', 'scroll', { x: 1, y: 2, deltaY: -5 });
  assert.deepStrictEqual(c._evts.at(-1), ['scroll', 1, 2, -5]);

  // typeText: ASCII keysym == code point, down+up per char, \n → 0xff0d
  c._evts.length = 0;
  await bridge.computer('g1', 'typeText', { text: 'ab\n' });
  assert.deepStrictEqual(c._evts, [
    ['key', 97, true], ['key', 97, false],
    ['key', 98, true], ['key', 98, false],
    ['key', 0xff0d, true], ['key', 0xff0d, false],
  ], 'ASCII typing + newline keysym');

  // pressKey with modifiers: Shift held around the key
  c._evts.length = 0;
  await bridge.computer('g1', 'pressKey', { key: 'a', modifiers: ['Shift'] });
  const kinds = c._evts.map((e) => e[0]);
  assert.strictEqual(kinds[0], 'key'); assert.strictEqual(c._evts[0][1], 0xffe1); assert.strictEqual(c._evts[0][2], true, 'shift down first');
  assert.strictEqual(c._evts.at(-1)[1], 0xffe1); assert.strictEqual(c._evts.at(-1)[2], false, 'shift released last');
  assert.deepStrictEqual(c._evts.find((e) => e[1] === 97 && e[2] === true), ['key', 97, true], 'the key pressed while shift held');

  // ax/other: honest refusal (guest has no accessibility tree)
  const ax = await bridge.computer('g1', 'appState', {});
  assert.strictEqual(ax.ok, false);
  assert.match(ax.reason, /no accessibility tree/);

  // not attached → throws (caller falls back)
  await assert.rejects(() => bridge.computer('nope', 'click', {}), /no attached guest/);

  // detach closes the client
  bridge.detach('g1');
  assert.strictEqual(bridge.isAttached('g1'), false);
  assert.ok(c._evts.some((e) => e[0] === 'close'));

  console.log('guest-computer-bridge test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
