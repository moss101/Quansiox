'use strict';
/* Rich file previews (GPA G7): bounded image/PDF reads + workspace confinement. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-file-media-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const { settingsService } = require('../src/main/services/settingsService');
settingsService.save({ workspaceRoot: tmp });
const { fileService } = require('../src/main/services/fileService');

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
fs.writeFileSync(path.join(tmp, 'shot.png'), png);
fs.writeFileSync(path.join(tmp, 'notes.pdf'), Buffer.from('%PDF-1.4\n%%EOF'));

const image = fileService.readMedia('shot.png');
assert.equal(image.mime, 'image/png');
assert.equal(image.size, png.length);
assert.equal(Buffer.from(image.base64, 'base64').equals(png), true, 'binary round-trip');
const pdf = fileService.readMedia('notes.pdf');
assert.equal(pdf.mime, 'application/pdf');
assert.throws(() => fileService.readMedia('shot.svg'), /ENOENT/); // missing file

// unknown extension falls back to octet-stream
fs.writeFileSync(path.join(tmp, 'blob.dat'), Buffer.from('abc'));
assert.equal(fileService.readMedia('blob.dat').mime, 'application/octet-stream');

// confinement: no escaping the workspace
fs.writeFileSync(path.join(os.tmpdir(), 'qx-outside.png'), png);
assert.throws(() => fileService.readMedia('../qx-outside.png'), /escapes workspace/);

// size cap (20 MB)
const big = path.join(tmp, 'big.bin');
fs.writeFileSync(big, '');
fs.truncateSync(big, 20 * 1024 * 1024 + 1);
assert.throws(() => fileService.readMedia('big.bin'), /too large/);

// directories are not previewable media
fs.mkdirSync(path.join(tmp, 'dir'));
assert.throws(() => fileService.readMedia('dir'), /not a file/);

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(path.join(os.tmpdir(), 'qx-outside.png'), { force: true });
console.log('file-media test: ALL OK');
