'use strict';
/**
 * PNG decode + encode (built-in zlib, no dependencies).
 *
 * The encoder half already existed (`pngEncode.js`) for handing a guest
 * framebuffer to the model. This file adds the **decoder** half, which the
 * image-editing surface needs: to upscale an image, remove its background
 * or patch a region, you have to be able to get at the pixels.
 *
 * Scope is deliberately the subset that matters and that is unambiguous:
 *
 *   - bit depth 8 and 16, colour types 0 (grey), 2 (RGB), 3 (palette),
 *     4 (grey+alpha) and 6 (RGBA);
 *   - non-interlaced (Adam7 interlaced images are rejected, not mangled);
 *   - all five PNG scanline filters;
 *   - tRNS transparency for palette and grey/RGB images.
 *
 * A file the decoder cannot read throws with a precise reason rather than
 * returning garbage — the caller can then fall back to the browser's own
 * decoder (Chromium reads everything) when one is available.
 */
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ------------------------------------------------------------------ crc32 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/* ----------------------------------------------------------------- decode */

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Reverse one PNG scanline filter in place. */
function unfilter(type, line, previous, bpp) {
  const length = line.length;
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < length; i += 1) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      if (previous) for (let i = 0; i < length; i += 1) line[i] = (line[i] + previous[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < length; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        const up = previous ? previous[i] : 0;
        line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < length; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        const up = previous ? previous[i] : 0;
        const upLeft = i >= bpp && previous ? previous[i - bpp] : 0;
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        line[i] = (line[i] + predictor) & 0xff;
      }
      return;
    default:
      throw new Error(`unsupported PNG filter type ${type}`);
  }
}

/**
 * Decode a PNG into straight RGBA.
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number, data: Buffer}} `data` is RGBA.
 */
function decodePNG(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG file');
  }
  let offset = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.subarray(dataStart, dataStart + length);
    offset = dataStart + length + 4; // skip the CRC

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colourType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!header) throw new Error('PNG has no header');
  if (header.interlace) throw new Error('interlaced PNG is not supported');
  if (![8, 16].includes(header.bitDepth)) throw new Error(`unsupported PNG bit depth ${header.bitDepth}`);
  const channels = CHANNELS[header.colourType];
  if (!channels) throw new Error(`unsupported PNG colour type ${header.colourType}`);
  if (!idat.length) throw new Error('PNG has no image data');

  const { width, height, bitDepth } = header;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerSample = bitDepth / 8;
  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);

  // Un-filter each scanline.
  const scanlines = [];
  let position = 0;
  let previous = null;
  for (let y = 0; y < height; y += 1) {
    if (position >= raw.length) throw new Error('PNG data is truncated');
    const filterType = raw[position];
    const line = Buffer.from(raw.subarray(position + 1, position + 1 + stride));
    position += 1 + stride;
    unfilter(filterType, line, previous, bytesPerPixel);
    scanlines.push(line);
    previous = line;
  }

  // Expand to RGBA.
  const out = Buffer.alloc(width * height * 4);
  const maxValue = bitDepth === 16 ? 65535 : 255;
  for (let y = 0; y < height; y += 1) {
    const line = scanlines[y];
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      const sample = (index) => {
        if (bitDepth === 8) return line[index];
        return line.readUInt16BE(index * 2);
      };
      if (header.colourType === 0) {
        const grey = sample(x);
        const alpha = transparency && transparency.readUInt16BE(0) === grey ? 0 : 255;
        const scaled = Math.round((grey / maxValue) * 255);
        out[target] = scaled; out[target + 1] = scaled; out[target + 2] = scaled; out[target + 3] = alpha;
      } else if (header.colourType === 2) {
        const r = sample(x * 3);
        const g = sample(x * 3 + 1);
        const b = sample(x * 3 + 2);
        let alpha = 255;
        if (transparency && transparency.length >= 6) {
          if (r === transparency.readUInt16BE(0) && g === transparency.readUInt16BE(2) && b === transparency.readUInt16BE(4)) alpha = 0;
        }
        out[target] = Math.round((r / maxValue) * 255);
        out[target + 1] = Math.round((g / maxValue) * 255);
        out[target + 2] = Math.round((b / maxValue) * 255);
        out[target + 3] = alpha;
      } else if (header.colourType === 3) {
        if (!palette) throw new Error('indexed PNG has no palette');
        const index = line[x];
        const p = index * 3;
        out[target] = palette[p] ?? 0;
        out[target + 1] = palette[p + 1] ?? 0;
        out[target + 2] = palette[p + 2] ?? 0;
        out[target + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      } else if (header.colourType === 4) {
        const grey = sample(x * 2);
        const alpha = sample(x * 2 + 1);
        const scaled = Math.round((grey / maxValue) * 255);
        out[target] = scaled; out[target + 1] = scaled; out[target + 2] = scaled;
        out[target + 3] = Math.round((alpha / maxValue) * 255);
      } else {
        const r = sample(x * 4);
        const g = sample(x * 4 + 1);
        const b = sample(x * 4 + 2);
        const a = sample(x * 4 + 3);
        out[target] = Math.round((r / maxValue) * 255);
        out[target + 1] = Math.round((g / maxValue) * 255);
        out[target + 2] = Math.round((b / maxValue) * 255);
        out[target + 3] = Math.round((a / maxValue) * 255);
      }
    }
  }
  return { width, height, data: out };
}

/* ----------------------------------------------------------------- encode */

/** RGBA → PNG (8-bit, colour type 6). */
function encodePNG(rgba, width, height) {
  if (!Buffer.isBuffer(rgba) || rgba.length < width * height * 4) throw new Error('bad RGBA buffer');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + stride)] = 0;
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { decodePNG, encodePNG, crc32 };
