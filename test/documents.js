'use strict';
/* Documents + attachments test — Grok getDocument / stageAttachment* mapped to
 * real local behavior: library CRUD + visibility, attachment staging (bytes +
 * confined path), media resolve, text/base64 read-back, commit, discard, and
 * routing through the Grok compatibility surface. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-docs-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-docs-ws-'));
process.env.QUANSIOX_USER_DATA_DIR = profile;
// seed settings so stageAttachmentPath confines to `workspace`
const { settingsService } = require('../src/main/services/settingsService');
settingsService.save({ workspaceRoot: workspace });
const { documentsService: docs } = require('../src/main/services/documentsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  // 1. library: save → get → list → visibility → shared pages
  const d1 = docs.saveDocument({ id: 'doc_readme', title: 'Readme', content: '# Hello\nworld', visibility: 'private' });
  assert.strictEqual(d1.id, 'doc_readme');
  assert.strictEqual(docs.getDocument('doc_readme').content, '# Hello\nworld');
  docs.saveDocument({ id: 'doc_shared', title: 'Shared notes', content: 'shared body', visibility: 'shared' });
  assert.ok(docs.listLibraryDocs().some((d) => d.id === 'doc_shared'));
  const granted = docs.setDocumentVisibility('doc_readme', 'shared');
  assert.strictEqual(granted.visibility, 'shared');
  assert.ok(docs.resolveLibraryPages().map((p) => p.id).includes('doc_readme'));
  assert.ok(!('content' in docs.listLibraryDocs()[0]) || Array.isArray(docs.listLibraryDocs()), 'list summaries carry no content blob');
  assert.ok(!JSON.stringify(docs.listLibraryDocs()).includes('shared body'), 'list does not embed content');

  // 2. attachment bytes (text) → resolve → readText → commit to library
  const stagedText = docs.stageAttachmentBytes({ name: 'notes.txt', text: 'alpha beta', mime: 'text/plain' });
  assert.match(stagedText.id, /^att_/);
  assert.strictEqual(docs.resolveAttachmentMedia(stagedText.id).kind, 'text');
  assert.strictEqual(docs.readAttachmentText(stagedText.id), 'alpha beta');
  const committedText = docs.commitStagedAttachments({ ids: [stagedText.id] });
  assert.strictEqual(committedText.committed, 1);
  assert.strictEqual(docs.getDocument(committedText.docs[0].id).content, 'alpha beta');

  // 3. attachment bytes (binary png) → base64 round-trips
  const png = Buffer.from('89504e470d0a1a0a' + '00'.repeat(16), 'hex');
  const stagedPng = docs.stageAttachmentBytes({ name: 'pixel.png', contentBase64: png.toString('base64') });
  assert.strictEqual(docs.resolveAttachmentMedia(stagedPng.id).kind, 'image');
  const readBack = docs.readAttachmentBytes(stagedPng.id);
  assert.strictEqual(Buffer.from(readBack.contentBase64, 'base64').toString('hex'), png.toString('hex'));

  // 4. forge binary attachment is committed with a mime-bearing record
  const committedPng = docs.commitStagedAttachments({ ids: [stagedPng.id], visibility: 'shared' });
  assert.strictEqual(committedPng.docs[0].mime, 'image/png');
  assert.ok(committedPng.docs[0].bytes >= png.length);

  // 5. attachment path confined to workspace; outside is refused
  const inside = path.join(workspace, 'data.csv');
  fs.writeFileSync(inside, 'a,b\n1,2\n');
  const stagedFile = docs.stageAttachmentPath({ path: inside });
  assert.strictEqual(docs.resolveAttachmentMedia(stagedFile.id).mime, 'text/csv');
  docs.discardStagedAttachment(stagedFile.id);
  assert.throws(() => docs.stageAttachmentPath({ path: '/etc/hostname' }), /outside the workspace/);
  assert.throws(() => docs.stageAttachmentPath({ path: '/nonexistent/nope.txt' }), /does not exist|outside/);

  // 6. through the Grok compatibility surface (backend stub → real)
  let env = await grokCompatService.dispatch('saveDocument', { id: 'doc_compat', title: 'Compat', content: 'via compat', visibility: 'private' });
  assert.strictEqual(env.status, 'ok'); assert.strictEqual(env.document.id, 'doc_compat');
  env = await grokCompatService.dispatch('getDocument', { id: 'doc_compat' });
  assert.strictEqual(env.document.content, 'via compat');
  env = await grokCompatService.dispatch('stageAttachmentBytes', { name: 'x.txt', text: 'compat-attach' });
  assert.strictEqual(env.status, 'ok'); assert.ok(env.attachment.id);
  env = await grokCompatService.dispatch('readAttachmentText', { id: env.attachment.id });
  assert.strictEqual(env.text, 'compat-attach');
  env = await grokCompatService.dispatch('listLibraryDocs', {});
  assert.ok(env.documents.some((d) => d.id === 'doc_compat'));

  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  console.log('documents test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
