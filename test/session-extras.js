'use strict';
/* Session conveniences test — Grok getConversationOutline / searchMedia / avatar /
 * draft methods mapped to real local behavior. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-sx-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-sx-ws-'));
process.env.QUANSIOX_USER_DATA_DIR = profile;
const { settingsService } = require('../src/main/services/settingsService');
settingsService.save({ workspaceRoot: ws });
const { sessionService } = require('../src/main/services/sessionService');
const sx = require('../src/main/services/sessionExtrasService').sessionExtrasService;

// seed a session with a realistic transcript
sessionService.ensure('sx-1');
sessionService.appendTurn('sx-1', { role: 'user', content: 'Add a login page and wire it to the API' });
sessionService.appendTurn('sx-1', { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'write_file', arguments: '{"path":"login.jsx"}' } }] });
sessionService.appendTurn('sx-1', { role: 'tool', tool_call_id: 't1', name: 'write_file', content: 'wrote 240 bytes to login.jsx' });
sessionService.appendTurn('sx-1', { role: 'assistant', content: '', __plan: [{ title: 'Create login component', status: 'done' }, { title: 'Wire API call', status: 'pending' }] });
sessionService.appendTurn('sx-1', { role: 'assistant', content: 'Login page created and wired.' });

(async () => {
  // 1. outline reflects the transcript kinds
  const o = sx.outline('sx-1');
  const kinds = o.outline.map((i) => i.kind);
  assert.ok(kinds.includes('user') && kinds.includes('tool') && kinds.includes('result') && kinds.includes('assistant') && kinds.includes('step'));
  const tool = o.outline.find((i) => i.kind === 'tool');
  assert.strictEqual(tool.name, 'write_file');
  assert.strictEqual(sx.outline('missing-sess').outline.length, 0, 'missing session → empty outline');

  // 2. seed a conversation name (also renames the session)
  const named = sx.seedConversationName('sx-1', 'Refactor   the   auth   module\nsecond line');
  assert.strictEqual(named.title, 'Refactor the auth module second line'.slice(0, 48));
  assert.strictEqual(sessionService.get('sx-1').title, named.title);

  // 3. media search: include media, exclude non-media, skip node_modules/.git
  fs.writeFileSync(path.join(ws, 'logo.png'), 'x');
  fs.writeFileSync(path.join(ws, 'photo.JPG'), 'x');
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(ws, 'assets'));
  fs.writeFileSync(path.join(ws, 'assets', 'clip.mp4'), 'x');
  fs.writeFileSync(path.join(ws, 'assets', 'doc.pdf'), 'x');
  fs.mkdirSync(path.join(ws, 'node_modules'));
  fs.writeFileSync(path.join(ws, 'node_modules', 'evil.png'), 'x');
  const all = sx.searchMedia();
  const names = all.results.map((r) => r.name).sort();
  assert.ok(names.includes('logo.png') && names.includes('photo.JPG') && names.includes('clip.mp4') && names.includes('doc.pdf'));
  assert.ok(!names.includes('notes.txt'), 'non-media excluded');
  assert.ok(!names.includes('evil.png'), 'node_modules pruned');
  assert.ok(sx.searchMedia('clip').results.every((r) => /clip/i.test(r.name)), 'query filters by name');
  const images = sx.searchMedia(undefined, { kinds: ['image'] });
  assert.ok(images.results.length, 'image filter returns results (not vacuous)');
  assert.ok(images.results.every((r) => r.kind === 'image'), 'kinds filter');

  // 4. avatars: bytes round-trip + deterministic generate
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64');
  const set = sx.setAvatarBytes('sx-1', { contentBase64: png, mime: 'image/png' });
  assert.strictEqual(set.bytes, 10);
  assert.strictEqual(Buffer.from(sx.getAvatar('sx-1').contentBase64, 'base64').toString('hex'), Buffer.from(png, 'base64').toString('hex'));
  const gen = sx.generateAgentImage('sx-2', { label: 'ab' });
  assert.match(gen.dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.strictEqual(sx.getAvatar('sx-2').mime, 'image/svg+xml');
  assert.throws(() => sx.setAvatarBytes('bad id!', { contentBase64: 'x' }), /invalid session id/);

  // 5. drafts: save/read/discard + drafting-disabled gates writes
  sx.saveDraft('sx-3', 'half-typed prompt');
  assert.strictEqual(sx.getDraft('sx-3').text, 'half-typed prompt');
  sx.setDraftingDisabled('sx-3', true);
  assert.strictEqual(sx.saveDraft('sx-3', 'ignored').saved, false, 'disabled drafting blocks writes');
  assert.strictEqual(sx.getDraft('sx-3').text, 'half-typed prompt', 'existing draft preserved while disabled');
  sx.setDraftingDisabled('sx-3', false);
  sx.discardDraft('sx-3');
  assert.strictEqual(sx.getDraft('sx-3').text, '');

  // 6. through the Grok compatibility surface
  const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
  let env = await grokCompatService.dispatch('getConversationOutline', { sessionId: 'sx-1' });
  assert.strictEqual(env.status, 'ok'); assert.ok(env.outline.length);
  env = await grokCompatService.dispatch('searchMedia', { query: 'clip', kinds: ['video'] });
  assert.ok(env.results.some((r) => r.name === 'clip.mp4'));
  env = await grokCompatService.dispatch('getAgentAvatar', { sessionId: 'sx-1' });
  assert.strictEqual(env.status, 'ok'); assert.strictEqual(env.mime, 'image/png');
  env = await grokCompatService.dispatch('sendDraft', { sessionId: 'sx-4', text: 'via compat' });
  assert.strictEqual(env.status, 'ok'); assert.strictEqual((await grokCompatService.dispatch('discardDraft', { sessionId: 'sx-4' })).discarded, true);

  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  console.log('session-extras test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
