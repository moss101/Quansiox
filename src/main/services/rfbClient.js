'use strict';
/**
 * RFB (VNC) input client — drives the live guest desktop over its RFB socket
 * (the 5900 vsock unix socket published by the desktop VM). Completes the RFB
 * 3.8 handshake and posts PointerEvent/KeyEvent, which x11vnc converts into X
 * input. Transport (a Node duplex) is injectable → handshake + message framing
 * are unit-tested offline; a live guest is hardware-gated (prototyped).
 *
 * Buttons (RFB masks): left 1, middle 2, right 4, wheel-up 8, wheel-down 16.
 */
function connect(duplex, { onFramebuffer, securityType = 1 } = {}) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  duplex.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); pump(); });
  duplex.on('error', () => {});
  function pump() { while (waiters.length && buf.length >= waiters[0].n) { const w = waiters.shift(); const p = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.resolve(p); } }
  const readExact = (n) => new Promise((resolve) => { waiters.push({ n, resolve }); pump(); });
  const write = (b) => duplex.write(b);

  const handshake = async () => {
    const version = (await readExact(12)).toString('latin1'); // "RFB 003.008\n"
    if (!/^RFB \d{3}\.\d{3}\n$/.test(version)) throw new Error(`unexpected RFB version: ${JSON.stringify(version)}`);
    write(Buffer.from('RFB 003.008\n', 'latin1'));
    const count = (await readExact(1))[0];
    const type = securityType;
    if (count === 0) { const reasonLen = (await readExact(4)).readUInt32BE(0); const reason = (await readExact(reasonLen)).toString('latin1'); throw new Error(`server refused: ${reason}`); }
    const types = [...await readExact(count)];
    const chosen = types.includes(securityType) ? securityType : (types.includes(1) ? 1 : types[0]);
    write(Buffer.from([chosen]));
    if (chosen !== 1) throw new Error(`RFB security type ${chosen} not supported by this client`); // only "None"
    const secResult = (await readExact(4)).readUInt32BE(0);
    if (secResult !== 0) throw new Error('RFB security handshake failed');
    write(Buffer.from([1])); // ClientInit: shared = 1
    const w = (await readExact(2)).readUInt16BE(0);
    const h = (await readExact(2)).readUInt16BE(0);
    const pf = await readExact(16); // pixel-format
    const pixelFormat = {
      bitsPerPixel: pf[0], depth: pf[1], bigEndian: pf[2], trueColor: pf[3],
      redMax: pf.readUInt16BE(4), greenMax: pf.readUInt16BE(6), blueMax: pf.readUInt16BE(8),
      redShift: pf[10], greenShift: pf[11], blueShift: pf[12],
      bytesPerPixel: Math.ceil(pf[0] / 8),
    };
    const nameLen = (await readExact(4)).readUInt32BE(0);
    const name = (await readExact(Math.min(nameLen, 4096))).toString('latin1');
    const info = { width: w, height: h, name, pixelFormat };
    Object.assign(client, info); // expose on the client object
    return info;
  };

  const scale = (v, max) => (max ? Math.round((v * 255) / max) : v);
  function decodePixel(px, pf) {
    const v = pf.bigEndian ? px.readUInt32BE(0) : px.readUInt32LE(0);
    const r = scale((v >>> pf.redShift) & pf.redMax, pf.redMax);
    const g = scale((v >>> pf.greenShift) & pf.greenMax, pf.greenMax);
    const b = scale((v >>> pf.blueShift) & pf.blueMax, pf.blueMax);
    return [r, g, b];
  }
  function requestFramebufferUpdate(x, y, w, h) {
    const b = Buffer.alloc(10);
    b.writeUInt8(3, 0); b.writeUInt8(0, 1); b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); b.writeUInt16BE(w, 6); b.writeUInt16BE(h, 8);
    return write(b);
  }
  /** Request + decode a full framebuffer (Raw encoding) → RGBA. */
  async function capture() {
    const w = client.width, h = client.height, pf = client.pixelFormat;
    if (!w || !h) throw new Error('RFB handshake not complete');
    requestFramebufferUpdate(0, 0, w, h);
    const fb = Buffer.alloc(w * h * 4);
    for (;;) {
      const type = (await readExact(1)).readUInt8(0);
      if (type === 0) {
        await readExact(1); // pad
        const numRects = (await readExact(2)).readUInt16BE(0);
        for (let i = 0; i < numRects; i += 1) {
          const hdr = await readExact(12);
          const rx = hdr.readUInt16BE(0), ry = hdr.readUInt16BE(2), rw = hdr.readUInt16BE(4), rh = hdr.readUInt16BE(6);
          const enc = hdr.readUInt32BE(8);
          if (enc !== 0) break; // non-Raw (pseudo-)encodings unsupported here
          const raw = await readExact(rw * rh * pf.bytesPerPixel);
          for (let row = 0; row < rh; row += 1) {
            for (let col = 0; col < rw; col += 1) {
              const sx = rx + col, sy = ry + row;
              if (sx >= w || sy >= h) continue;
              const [r, g, b] = decodePixel(raw.subarray((row * rw + col) * pf.bytesPerPixel, (row * rw + col) * pf.bytesPerPixel + pf.bytesPerPixel), pf);
              const di = (sy * w + sx) * 4;
              fb[di] = r; fb[di + 1] = g; fb[di + 2] = b; fb[di + 3] = 255;
            }
          }
        }
        return { width: w, height: h, rgba: fb };
      }
      if (type === 2) continue; // Bell
      if (type === 3) { await readExact(3); const len = (await readExact(4)).readUInt32BE(0); await readExact(len); continue; } // ServerCutText
      if (type === 1) { await readExact(1); const n = (await readExact(2)).readUInt16BE(0); await readExact(n * 6); continue; } // SetColourMapEntries
      throw new Error(`unexpected RFB server message type ${type}`);
    }
  }

  function pointerEvent(x, y, mask) {
    const b = Buffer.alloc(6);
    b.writeUInt8(5, 0); b.writeUInt8(mask & 0xff, 1); b.writeUInt16BE(Math.max(0, Math.round(x || 0)), 2); b.writeUInt16BE(Math.max(0, Math.round(y || 0)), 4);
    return write(b);
  }
  function keyEvent(key, down) {
    const b = Buffer.alloc(8);
    b.writeUInt8(4, 0); b.writeUInt8(down ? 1 : 0, 1); b.writeUInt16BE(0, 2); b.writeUInt32BE(key >>> 0, 4);
    return write(b);
  }
  const leftClick = (x, y) => { pointerEvent(x, y, 1); pointerEvent(x, y, 0); };
  const rightClick = (x, y) => { pointerEvent(x, y, 4); pointerEvent(x, y, 0); };
  const scroll = (x, y, deltaY) => { pointerEvent(x, y, Number(deltaY) < 0 ? 16 : 8); pointerEvent(x, y, 0); };
  const move = (x, y) => pointerEvent(x, y, 0);

  const client = {
    width: 0, height: 0, name: '',
    handshake,
    pointerEvent, keyEvent, leftClick, rightClick, scroll, move, readExact,
    capture, requestFramebufferUpdate, close: () => {},
  };
  return client;
}

module.exports = { rfbClient: { connect } };
