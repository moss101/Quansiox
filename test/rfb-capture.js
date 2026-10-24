'use strict';
/* RFB framebuffer decode test — capture() over an injected duplex: a fake guest
 * sends the RFB 3.8 handshake (32bpp trueColor RGBA pixel format) and, on the
 * FramebufferUpdateRequest, a 2x2 Raw FramebufferUpdate; the client's capture()
 * decodes it to RGBA. Injected duplex (no TCP framing to fight). Node-only. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { rfbClient } = require('../src/main/services/rfbClient');
const { encodePNG } = require('../src/main/services/pngEncode');

function fakeGuest() {
  const d = new EventEmitter();
  const records = [];
  const pf = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]); // 32bpp, r0 g8 b16
  const si = Buffer.concat([Buffer.from([0, 2, 0, 2]), pf, Buffer.from([0, 0, 0, 5, 71, 117, 101, 115, 116])]); // 2x2 "Guest"
  const raw = Buffer.concat([
    Buffer.from([255, 0, 0, 255]), Buffer.from([0, 255, 0, 255]),
    Buffer.from([0, 0, 255, 255]), Buffer.from([255, 255, 255, 255]),
  ]);
  const greeting = Buffer.concat([
    Buffer.from('RFB 003.008\n'),
    Buffer.from([1, 1]),
    Buffer.from([0, 0, 0, 0]),
    si,
  ]);
  d.write = (b) => {
    records.push(Buffer.from(b));
    if (Buffer.isBuffer(b) && b[0] === 3) { // FramebufferUpdateRequest → reply with a 2x2 Raw update
      const rect = Buffer.alloc(12); rect.writeUInt16BE(0, 0); rect.writeUInt16BE(0, 2); rect.writeUInt16BE(2, 4); rect.writeUInt16BE(2, 6); rect.writeUInt32BE(0, 8);
      const update = Buffer.concat([Buffer.from([0, 0]), Buffer.from([0, 1]), rect, raw]);
      setImmediate(() => d.emit('data', update));
    }
    return true;
  };
  d.feed = (b) => setImmediate(() => d.emit('data', Buffer.isBuffer(b) ? b : Buffer.from(b)));
  return { d, records, raw, greeting };
}

async function run() {
  const g = fakeGuest();
  const client = rfbClient.connect(g.d);
  const hsP = client.handshake();
  g.d.feed(g.greeting); // deliver the handshake frames
  const info = await hsP;
  assert.strictEqual(info.width, 2);
  assert.strictEqual(info.height, 2);
  assert.strictEqual(info.pixelFormat.bytesPerPixel, 4);

  const frame = await client.capture();
  assert.deepStrictEqual([...frame.rgba.subarray(0, 4)], [255, 0, 0, 255], 'red pixel decoded');
  assert.deepStrictEqual([...frame.rgba.subarray(4, 8)], [0, 255, 0, 255], 'green pixel decoded');
  assert.deepStrictEqual([...frame.rgba.subarray(8, 12)], [0, 0, 255, 255], 'blue pixel decoded');
  assert.deepStrictEqual([...frame.rgba.subarray(12, 16)], [255, 255, 255, 255], 'white pixel decoded');

  // the decoded framebuffer encodes to a valid PNG
  const png = encodePNG(frame.rgba, frame.width, frame.height);
  assert.strictEqual(png.subarray(1, 4).toString(), 'PNG', 'valid PNG magic');

  console.log('rfb-capture test: ALL OK (framebuffer decode → RGBA → PNG)');
}
run().catch((e) => { console.error(e); process.exit(1); });
