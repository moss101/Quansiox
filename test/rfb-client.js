'use strict';
/* RFB input client test — handshake (version/security-None/ServerInit) + input
 * message framing (PointerEvent/KeyEvent bytes, click/scroll) against a fake
 * server duplex. Node-only; a live guest is hardware-gated. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { rfbClient } = require('../src/main/services/rfbClient');

// Fake server duplex: on connect it queues server greeting frames; records all
// client frames the client writes (for asserting exact bytes).
function fakeServer() {
  const d = new EventEmitter();
  const records = [];
  d.write = (b) => { records.push(Buffer.from(b)); return true; };
  d.feed = (b) => setImmediate(() => d.emit('data', Buffer.isBuffer(b) ? b : Buffer.from(b)));
  const greet = Buffer.concat([
    Buffer.from('RFB 003.008\n'),
    Buffer.from([1, 1]),                    // 1 security type: None(1)
    Buffer.from([0, 0, 0, 0]),              // SecurityResult: OK
    Buffer.from([0x02, 0x80, 0x01, 0xE0]),   // ServerInit: 640 x 480
    Buffer.alloc(16),                       // pixel-format
    Buffer.from([0, 0, 0, 5, 71, 117, 101, 115, 116]), // name "Guest"
  ]);
  d.begin = () => d.feed(greet);
  return { d, records };
}

async function run() {
  const srv = fakeServer();
  const client = rfbClient.connect(srv.d);
  const hsP = client.handshake();
  srv.d.begin();
  const info = await hsP;
  assert.strictEqual(info.width, 640, 'framebuffer width parsed');
  assert.strictEqual(info.height, 480, 'framebuffer height parsed');
  assert.strictEqual(info.name, 'Guest', 'server name parsed');
  // client asserted version + picked security None + shared=1
  const sent = srv.records.map((b) => b.toString('latin1'));
  assert.strictEqual(sent[0], 'RFB 003.008\n', 'handshake: client version reply');
  assert.strictEqual(sent[1].length, 1 && 1, 'security select frame present');
  assert.strictEqual([...srv.records[1]][0], 1, 'selected security type None(1)');
  assert.deepStrictEqual([...srv.records[2]], [1], 'ClientInit shared=1');

  // PointerEvent bytes: [5, mask, xHi, xLo, yHi, yLo]
  client.pointerEvent(10, 20, 1);
  assert.deepStrictEqual([...srv.records[3]], [5, 1, 0, 10, 0, 20], 'PointerEvent framing');
  client.pointerEvent(10, 20, 0);
  assert.deepStrictEqual([...srv.records[4]], [5, 0, 0, 10, 0, 20], 'PointerEvent release');

  // KeyEvent bytes: [4, down, padHi, padLo, keyHi, keyMid, keyLo, keyLLo]
  client.keyEvent(0xff0d, true); // Return
  assert.deepStrictEqual([...srv.records[5]], [4, 1, 0, 0, 0, 0, 0xff, 0x0d], 'KeyEvent down framing');
  client.keyEvent(0xff0d, false);
  assert.deepStrictEqual([...srv.records[6]], [4, 0, 0, 0, 0, 0, 0xff, 0x0d], 'KeyEvent up framing');

  // helpers
  srv.records.length = 0;
  client.leftClick(5, 6);
  assert.strictEqual(srv.records.length, 2, 'leftClick = press+release');
  client.scroll(5, 6, -3);
  assert.strictEqual(srv.records[2][1], 16, 'scroll up = button 16');

  console.log('rfb-client test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
