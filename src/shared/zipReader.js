'use strict';
/**
 * A minimal ZIP reader.
 *
 * The Slides surface can import a user's own `.pptx` as a template, and the
 * Website Builder can read a project's exported bundle back. Both need to
 * open a ZIP, and neither justifies a dependency in a local-first app that
 * otherwise has none for this.
 *
 * This reads the **central directory** (the authoritative index at the end of
 * the archive), then inflates each member. It handles the two methods that
 * matter in practice: STORE (0) and DEFLATE (8).
 */
const zlib = require('node:zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Find the end-of-central-directory record, scanning back from the end. */
function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Read a ZIP archive.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, {name: string, size: number, data: Buffer|null}>}
 */
function readZip(buffer) {
  const out = new Map();
  const eocd = findEocd(buffer);
  if (eocd === -1) throw new Error('not a ZIP archive (no end-of-central-directory record)');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // a directory entry

    // Walk to the local header to find where the payload starts.
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data = null;
    try {
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else data = null; // an unsupported method is reported, not faked
    } catch {
      data = null;
    }
    out.set(name, { name, size: uncompressedSize, data });
  }
  return out;
}

/** Read one member as text (UTF-8), or null when it is absent. */
function readText(entries, name) {
  const entry = entries.get(name);
  if (!entry || !entry.data) return null;
  return entry.data.toString('utf8');
}

module.exports = { readZip, readText };
