'use strict';
/* Parity (P2.6): the media filmstrip + fullscreen viewer.
 *
 * 1. mediaModel — collection from transcript items (agent screenshots +
 *    user-attached images), wraparound lightbox navigation, captions.
 * 2. transcript.mjs surfaces user-attached images on user items (data URLs
 *    only — never echoed to a provider).
 * 3. The viewer downloads locally (data URL → file) — no network. */
const assert = require('node:assert/strict');

const { collectMedia, stepIndex, stripLabel } = require('../src/renderer-src/mediaModel.js');

const results = [];
const checks = [];
function check(name, fn) { checks.push([name, fn]); }
async function run() {
  for (const [name, fn] of checks) {
    try {
      await fn();
      results.push(`  ok   ${name}`);
    } catch (error) {
      results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
      process.exitCode = 1;
    }
  }
}

check('collection takes tool screenshots and user-attached images, in order', () => {
  const items = [
    { kind: 'user', text: 'look at this', images: ['data:image/png;base64,AAA'], at: 1 },
    { kind: 'assistant', text: 'working', at: 2 },
    { kind: 'tool', name: 'computer_screenshot', image: 'data:image/png;base64,BBB', at: 3 },
    { kind: 'tool', name: 'shell', output: 'no image', at: 4 },
    { kind: 'user', text: 'two more', images: ['data:image/png;base64,CCC', 'data:image/png;base64,DDD'], at: 5 },
  ];
  const media = collectMedia(items);
  assert.deepEqual(media.map((m) => m.src.slice(-3)), ['AAA', 'BBB', 'CCC', 'DDD']);
  assert.deepEqual(media.map((m) => m.from), ['attachment', 'screenshot', 'attachment', 'attachment']);
  assert.deepEqual(media.map((m) => m.at), [1, 3, 5, 5]);
  assert.deepEqual(collectMedia([]), []);
  assert.deepEqual(collectMedia(null), []);
});

check('collection skips empty and non-string sources', () => {
  const media = collectMedia([
    { kind: 'tool', image: '', at: 1 },
    { kind: 'user', images: ['', null, 'data:image/png;base64,EEE'], at: 2 },
  ]);
  assert.equal(media.length, 1);
  assert.equal(media[0].src.endsWith('EEE'), true);
});

check('lightbox navigation wraps in both directions and clamps', () => {
  assert.equal(stepIndex(0, 4, 1), 1);
  assert.equal(stepIndex(3, 4, 1), 0);
  assert.equal(stepIndex(0, 4, -1), 3);
  assert.equal(stepIndex(9, 4, 1), 0, 'out-of-range clamps before stepping');
  assert.equal(stepIndex(0, 0, 1), 0);
});

check('captions read count + origin', () => {
  const media = collectMedia([
    { kind: 'tool', image: 'data:image/png;base64,AAA', at: 1 },
    { kind: 'user', images: ['data:image/png;base64,BBB'], at: 2 },
  ]);
  assert.equal(stripLabel(media, 0), '1 of 2 · screenshot');
  assert.equal(stripLabel(media, 1), '2 of 2 · attached image');
  assert.equal(stripLabel([], 0), '');
});

check('transcript items carry user-attached images through to the strip', () => {
  const { transcriptItems } = require('../src/renderer-src/transcript.mjs');
  const { items } = transcriptItems([
    { role: 'user', at: 1, content: [
      { type: 'text', text: 'see attachment' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,FFF' } },
    ] },
  ], 0);
  const user = items.find((i) => i.kind === 'user');
  assert.deepEqual(user.images, ['data:image/png;base64,FFF']);
  assert.equal(user.text.includes('see attachment'), true);
  const plain = transcriptItems([{ role: 'user', at: 2, content: 'no images' }], 1);
  assert.deepEqual(plain.items.find((i) => i.kind === 'user').images, []);
  // and the strip model consumes them
  const media = collectMedia(items);
  assert.equal(media.length, 1);
});

(async () => {
  await run();
  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nerror: parity-media FAILED');
    process.exit(1);
  }
  console.log(`\nparity media: ${results.filter((r) => r.startsWith('  ok')).length} checks OK — filmstrip collection, wraparound viewer, transcript wiring`);
})();
