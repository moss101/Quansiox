'use strict';
/**
 * A minimal, dependency-free ZIP writer.
 *
 * Wide Research can package its result matrix as a single archive (the
 * docs' "package the output as a ZIP"), and the support bundle wants the
 * same. Both are plain file collections, so a full archiver is overkill —
 * and pulling one in would add a dependency to a local-first app that has
 * none for this.
 *
 * This writes a standard PKZIP archive with DEFLATE-compressed entries and
 * a correct CRC-32 per entry, which every unzip implementation reads.
 *
 * The writer is deliberately synchronous and small: it holds the archive in
 * memory, which is fine for the sizes involved (a research matrix and its
 * CSV/Markdown exports) and keeps the file format obvious.
 */
const zlib = require('node:zlib');

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

/* ------------------------------------------------------------- dos fields */

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/* ------------------------------------------------------------------ write */

/**
 * Build a ZIP archive in memory.
 *
 * @param {Array<{name: string, data: Buffer|string, store?: boolean}>} entries
 * @param {Date} [modified]
 * @returns {Buffer}
 */
function buildZip(entries, modified = new Date()) {
  const { time, date } = dosDateTime(modified);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries ?? []) {
    const name = String(entry?.name ?? '').replace(/\\/g, '/');
    if (!name) continue;
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data ?? ''), 'utf8');
    const crc = crc32(raw);
    const store = entry.store === true;
    const deflated = store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    // Storing is only worth it when compression makes the entry bigger.
    const useDeflate = !store && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);            // extra length

    chunks.push(local, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);      // version made by
    centralHeader.writeUInt16LE(20, 6);      // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);      // extra length
    centralHeader.writeUInt16LE(0, 32);      // comment length
    centralHeader.writeUInt16LE(0, 34);      // disk number
    centralHeader.writeUInt16LE(0, 36);      // internal attrs
    centralHeader.writeUInt32LE(0o644 << 16, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE((entries ?? []).filter((e) => e?.name).length, 8);
  end.writeUInt16LE((entries ?? []).filter((e) => e?.name).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

/** A CSV cell needs quoting whenever it contains a comma, quote or newline. */
function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render rows as RFC 4180-ish CSV. */
function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

module.exports = { buildZip, toCsv, crc32 };
