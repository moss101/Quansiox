'use strict';
/* Attachment surface — real chunked uploads, staged preupload, byte-range and
 * image reads, provider-honest captioning, HTTP download.
 * (Grok 0.71: uploadAttachment[Chunk], preuploadStagedAttachment,
 * releaseStagedAttachmentPreupload, readAttachmentChunk/Image/Text,
 * precaptionStagedAttachment, downloadAttachment). Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-attach-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { attachmentService } = require('../src/main/services/attachmentService');
const { settingsService } = require('../src/main/services/settingsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

function pngBytes(w = 3, h = 2) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; b[25] = 6; b[26] = 0; b[27] = 0; b[28] = 0;
  return b;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-attach-out-'));

  // 1. uploadAttachment — content-addressed store, real file on disk
  const png = pngBytes();
  const up = attachmentService.uploadAttachment({ filename: 'pic.png', bytesBase64: png.toString('base64') });
  assert.strictEqual(up.mime, 'image/png');
  assert.strictEqual(up.mediaKind, 'image');
  assert.strictEqual(up.size, png.length);
  assert.strictEqual(up.sha256, sha(png));
  assert.ok(fs.existsSync(up.path), 'object stored');
  assert.strictEqual(fs.statSync(up.path).mode & 0o777, 0o600);
  assert.strictEqual(up.complete, true);

  // 2. uploadAttachmentChunk — offset-verified, fsync, part cleaned on completion
  const big = crypto.randomBytes(300_000);
  const chunks = [big.subarray(0, 100_000), big.subarray(100_000, 250_000), big.subarray(250_000)];
  let last;
  chunks.forEach((c, i) => {
    last = attachmentService.uploadAttachmentChunk({
      uploadId: 'up-test-1', filename: 'big.bin',
      offset: i === 0 ? 0 : chunks.slice(0, i).reduce((n, x) => n + x.length, 0),
      totalSize: big.length, bytesBase64: c.toString('base64'),
    });
    if (i < 2) assert.strictEqual(last.complete, false);
  });
  assert.strictEqual(last.complete, true);
  assert.strictEqual(last.sha256, sha(big));
  assert.deepStrictEqual(fs.readFileSync(last.path), big);
  assert.ok(!fs.existsSync(path.join(tmp, 'attachments', 'uploads', 'up-test-1.part')), 'part cleaned after completion');

  // offset mismatch and unknown upload both refuse
  attachmentService.uploadAttachmentChunk({ uploadId: 'up-test-2', filename: 'x.bin', offset: 0, totalSize: 10, bytesBase64: Buffer.from('abc').toString('base64') });
  assert.throws(() => attachmentService.uploadAttachmentChunk({ uploadId: 'up-test-2', filename: 'x.bin', offset: 999, totalSize: 10, bytesBase64: 'YQ==' }), /offset mismatch/);
  assert.throws(() => attachmentService.uploadAttachmentChunk({ uploadId: 'up-never', filename: 'x.bin', offset: 5, totalSize: 10, bytesBase64: 'YQ==' }), /unknown uploadId/);

  // 3. readAttachmentChunk — byte-range read with eof flags (object lives in userData → allowed)
  const rc = attachmentService.readAttachmentChunk({ path: up.path, offset: 8, length: 8 });
  assert.strictEqual(rc.totalSize, up.size);
  assert.strictEqual(rc.eof, false);
  assert.deepStrictEqual(Buffer.from(rc.bytesBase64, 'base64'), png.subarray(8, 16));
  const rcTail = attachmentService.readAttachmentChunk({ path: up.path, offset: up.size - 4, length: 0 });
  assert.strictEqual(rcTail.eof, true);
  assert.strictEqual(rcTail.length, 4);

  // 4. staged preupload — outside-workspace path becomes readable, then released
  const outsideFile = path.join(outside, 'notes.txt');
  fs.writeFileSync(outsideFile, 'hello staged attachment');
  assert.throws(() => attachmentService.readAttachmentChunk({ path: outsideFile, offset: 0, length: 4 }), /stage it first/);
  const pre = attachmentService.preuploadStagedAttachment({ path: outsideFile, agentId: 'a1' });
  assert.strictEqual(pre.preuploaded, true);
  assert.strictEqual(pre.size, Buffer.byteLength('hello staged attachment'));
  assert.ok(fs.existsSync(path.join(tmp, 'attachments', 'preuploads.json')), 'preupload index persisted');
  const rcStaged = attachmentService.readAttachmentChunk({ path: outsideFile, offset: 0, length: 5 });
  assert.strictEqual(Buffer.from(rcStaged.bytesBase64, 'base64').toString('utf8'), 'hello');
  assert.strictEqual(attachmentService.readAttachmentText({ path: outsideFile }).text, 'hello staged attachment');

  const rel = attachmentService.releaseStagedAttachmentPreupload({ path: outsideFile });
  assert.deepStrictEqual({ released: rel.released, removed: rel.removed }, { released: true, removed: true });
  assert.ok(!fs.existsSync(pre.path), 'stored object removed when unreferenced');
  assert.throws(() => attachmentService.readAttachmentChunk({ path: outsideFile, offset: 0 }), /stage it first/);

  // 5. readAttachmentImage — real dimension probing + original dataUrl
  const img = attachmentService.readAttachmentImage({ path: up.path });
  assert.strictEqual(img.width, 3);
  assert.strictEqual(img.height, 2);
  assert.ok(img.dataUrl.startsWith('data:image/png;base64,'));
  const preview = attachmentService.readAttachmentImage({ path: up.path, rendition: 'preview' });
  assert.strictEqual(preview.rendition, 'preview');
  assert.strictEqual(preview.resized, false, 'headless passthrough (Electron would downscale)');

  // 6. precaptionStagedAttachment — honest when no provider, real call when configured
  const noProvider = await attachmentService.precaptionStagedAttachment({ path: up.path });
  assert.deepStrictEqual({ caption: noProvider.caption, available: noProvider.available }, { caption: null, available: false });

  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/chat/completions')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'A tiny test image.' } }] }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  settingsService.save({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model' });
  const cap = await attachmentService.precaptionStagedAttachment({ path: up.path, draftText: 'look at this' });
  assert.strictEqual(cap.available, true);
  assert.strictEqual(cap.caption, 'A tiny test image.');
  assert.strictEqual(seen[0].model, 'test-model');
  assert.ok(seen[0].messages[0].content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png')));
  server.close();

  // 7. downloadAttachment — real HTTP fetch into the store
  const payload = crypto.randomBytes(65536);
  const dlServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(payload); });
  await new Promise((r) => dlServer.listen(0, '127.0.0.1', r));
  const dl = await attachmentService.downloadAttachment({ url: `http://127.0.0.1:${dlServer.address().port}/file.bin` });
  assert.strictEqual(dl.sha256, sha(payload));
  assert.strictEqual(dl.size, payload.length);
  assert.deepStrictEqual(fs.readFileSync(dl.path), payload);
  dlServer.close();
  await assert.rejects(() => attachmentService.downloadAttachment({ url: 'ftp://example.com/x' }), /only http/);

  // 8. dispatch envelope
  const env = await grokCompatService.dispatch('uploadAttachment', { filename: 'e.txt', bytesBase64: Buffer.from('hi').toString('base64') });
  assert.strictEqual(env.status, 'ok');
  assert.strictEqual(env.size, 2);
  assert.strictEqual(env.mediaKind, 'text');
  const envChunk = await grokCompatService.dispatch('uploadAttachmentChunk', { uploadId: 'up-disp', filename: 'd.bin', offset: 0, totalSize: 2, bytesBase64: 'aGk=' });
  assert.strictEqual(envChunk.complete, true);
  const envRead = await grokCompatService.dispatch('readAttachmentChunk', { path: env.path, offset: 0, length: 1 });
  assert.strictEqual(Buffer.from(envRead.bytesBase64, 'base64').toString('utf8'), 'h');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  console.log('attachments test: ALL OK (upload/chunk/preupload/read/image/caption/download)');
})().catch((e) => { console.error(e); process.exit(1); });
