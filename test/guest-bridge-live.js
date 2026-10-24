'use strict';
/* Guest computer bridge — end-to-end over a real Unix socket acting as the
 * guest RFB server: the net.connect + rfbClient handshake (used by the app's
 * factory) drives real FramebufferUpdate decode + PointerEvent/KeyEvent bytes
 * onto the socket through the bridge. Node-only; no VM. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const net = require('node:net');
const { rfbClient } = require('../src/main/services/rfbClient');
const { guestComputerBridge } = require('../src/main/services/guestComputerBridge');

const W = 640, H = 480;

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-rfbsrv-'));
  const sock = path.join(dir, '5900.sock');
  const frames = [];
  const server = net.createServer((conn) => {
    conn.on('error', () => {});
    // Emit the RFB handshake the client expects, then relay client frames.
    const pixelFormat = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
    conn.write('RFB 003.008\n');
    conn.write(Buffer.from([1, 1]));          // 1 security type: None
    conn.write(Buffer.from([0, 0, 0, 0]));    // SecurityResult OK
    conn.write(Buffer.from([0x02, 0x80, 0x01, 0xE0])); // 640x480
    conn.write(pixelFormat);
    conn.write(Buffer.from([0, 0, 0, 5, 71, 117, 101, 115, 116])); // "Guest"
    let sentFrame = false;
    conn.on('data', (d) => {
      frames.push(Buffer.from(d));
      // The first client message after ServerInit is FramebufferUpdateRequest (3).
      if (!sentFrame && d.includes(3)) {
        sentFrame = true;
        const head = Buffer.from([0, 0, 0, 1]); // FramebufferUpdate, 1 rect
        const rect = Buffer.alloc(12);
        rect.writeUInt16BE(0, 0); rect.writeUInt16BE(0, 2);
        rect.writeUInt16BE(W, 4); rect.writeUInt16BE(H, 6);
        rect.writeUInt32BE(0, 8); // Raw
        conn.write(Buffer.concat([head, rect, Buffer.alloc(W * H * 4, 0x5a)]));
      }
    });
  });
  await new Promise((r) => server.listen(sock, r));

  // The same factory the app uses (net.connect + rfbClient + handshake).
  guestComputerBridge.setClientFactory((sessionId, rfbSock) => new Promise((resolve, reject) => {
    const dup = net.connect(rfbSock);
    const client = rfbClient.connect(dup);
    dup.on('error', reject);
    client.handshake().then(() => { client.close = () => { try { dup.end(); } catch {} }; resolve(client); }).catch(reject);
  }));

  const client = await guestComputerBridge.attach('s1', sock);
  assert.strictEqual(client.width, 640, 'handshake over real socket → framebuffer width');
  assert.strictEqual(client.name, 'Guest');

  // screenshot decodes the real FramebufferUpdate → PNG + token
  const shot = await guestComputerBridge.computer('s1', 'screenshot', {});
  assert.match(shot.data, /^data:image\/png;base64,/, 'real guest framebuffer as a PNG');
  assert.strictEqual(shot.width, W);
  assert.strictEqual(shot.height, H);
  assert.ok(shot.coordinateToken, 'coordinate token issued');

  // click through the bridge (with the fresh token) → PointerEvent bytes
  frames.length = 0;
  await guestComputerBridge.computer('s1', 'click', { x: 7, y: 9, coordinate_token: shot.coordinateToken });
  await new Promise((r) => setTimeout(r, 30));
  const all = Buffer.concat(frames);
  assert.ok(all.includes(Buffer.from([5, 1, 0, 7, 0, 9])), 'PointerEvent press reached the socket');
  assert.ok(all.includes(Buffer.from([5, 0, 0, 7, 0, 9])), 'PointerEvent release reached the socket');

  // type → KeyEvent bytes reach the socket
  frames.length = 0;
  await guestComputerBridge.computer('s1', 'typeText', { text: 'A' });
  await new Promise((r) => setTimeout(r, 40));
  const k = Buffer.concat(frames);
  assert.ok(k.includes(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65])), "KeyEvent('A') down reached the socket");

  guestComputerBridge.detach('s1');
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('guest-bridge-live test: ALL OK (RFB handshake + framebuffer + input over a real socket)');
}
run().catch((e) => { console.error(e); process.exit(1); });
