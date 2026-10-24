'use strict';
/* Screen viewer input helpers: text→keysym stream (incl. CJK/newlines), chord
 * ordering (modifiers down, reverse release), Cmd→Super translation. */
const assert = require('node:assert/strict');
const { sendText, sendChord, metaChord, SUPER_L } = require('../src/renderer-src/viewer-input.js');

function recorder() {
  const calls = [];
  return { calls, rfb: { sendKey: (...args) => calls.push(args) } };
}

(async () => {
  // 1. ASCII text → press/release pairs
  let r = recorder();
  assert.equal(sendText(r.rfb, 'ab'), 2);
  assert.deepEqual(r.calls, [[97, null, true], [97, null, false], [98, null, true], [98, null, false]]);

  // 2. newline → Return keysym (no literal \n)
  r = recorder();
  assert.equal(sendText(r.rfb, 'a\n'), 2);
  assert.deepEqual(r.calls[2], [0xff0d, 'Enter', true]);
  assert.deepEqual(r.calls[3], [0xff0d, 'Enter', false]);

  // 3. CJK / emoji use Unicode code points
  r = recorder();
  assert.equal(sendText(r.rfb, '你😀'), 2);
  assert.deepEqual(r.calls[0], [0x4f60, null, true]);
  assert.deepEqual(r.calls[2], [0x1f600, null, true]);

  // 4. empty / missing rfb is a no-op, never throws
  assert.equal(sendText(null, 'x'), 0);
  assert.equal(sendText({}, 'x'), 0);
  assert.equal(sendText(recorder().rfb, ''), 0);

  // 5. chord: modifiers down in order, released in reverse
  r = recorder();
  assert.equal(sendChord(r.rfb, ['ControlLeft', 'AltLeft', 'Delete']), true);
  assert.deepEqual(r.calls, [
    [0xffe3, 'ControlLeft', true], [0xffe9, 'AltLeft', true], [0xffff, 'Delete', true],
    [0xffff, 'Delete', false], [0xffe9, 'AltLeft', false], [0xffe3, 'ControlLeft', false],
  ]);

  // 6. unknown keys are skipped; all-unknown is false
  r = recorder();
  assert.equal(sendChord(r.rfb, ['Bogus']), false);
  assert.equal(r.calls.length, 0);
  assert.equal(sendChord(r.rfb, ['SuperLeft', 'Tab']), true);
  assert.deepEqual(r.calls[0], [SUPER_L, 'MetaLeft', true]);

  // 7. Cmd+<symbol> → Super held around the key
  r = recorder();
  assert.equal(metaChord(r.rfb, '='), true);
  assert.deepEqual(r.calls, [[SUPER_L, 'MetaLeft', true], [61, null, true], [61, null, false], [SUPER_L, 'MetaLeft', false]]);
  assert.equal(metaChord(null, '='), false);

  console.log('viewer-input test: ALL OK (text/keysyms/newlines/CJK/chords/meta)');
})().catch((e) => { console.error(e); process.exit(1); });
