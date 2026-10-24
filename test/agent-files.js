'use strict';
/* Agent files & presence — real per-agent file store (upload bytes → disk,
 * replace-on-name, delete, sandbox mirror) plus pickAvatarFile/Source and
 * composing/viewing agent state. Electron-free with a stubbed dialog. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-agent-files-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-af-ws-'));
const avatarPng = path.join(tmp, 'me.png');
fs.writeFileSync(avatarPng, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));

const realElectron = { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [avatarPng] }) } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return realElectron;
  return origLoad.call(this, request, parent, isMain);
};

const { settingsService } = require('../src/main/services/settingsService');
const { sessionService } = require('../src/main/services/sessionService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { sandboxService } = require('../src/main/services/sandboxService');

(async () => {
  settingsService.save({ workspaceRoot });

  // 1. upload real bytes → disk + index; list reports metadata
  const bytes = new Uint8Array(Buffer.from('hello agent context\n'));
  const up = await grokCompatService.dispatch('uploadGrokBotAgentFile', { agentId: 'agent-1', fileName: 'notes.txt', contentType: 'text/plain', bytes });
  assert.strictEqual(up.ok, true);
  assert.strictEqual(up.size, 20);
  const sha = crypto.createHash('sha256').update(Buffer.from('hello agent context\n')).digest('hex');
  assert.strictEqual(up.sha256, sha);
  const onDisk = fs.readdirSync(path.join(tmp, 'agent-files', 'agent-1')).filter((f) => f.endsWith('notes.txt'));
  assert.strictEqual(onDisk.length, 1, 'one stored copy');
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'agent-files', 'agent-1', onDisk[0]), 'utf8'), 'hello agent context\n');
  assert.strictEqual(fs.statSync(path.join(tmp, 'agent-files', 'agent-1', onDisk[0])).mode & 0o777, 0o600);

  // array-form bytes (IPC variants)
  await grokCompatService.dispatch('uploadGrokBotAgentFile', { agentId: 'agent-1', fileName: 'arr.txt', contentType: 'text/plain', bytes: [...Buffer.from('abc')] });
  const list1 = await grokCompatService.dispatch('listGrokBotAgentFiles', { agentId: 'agent-1' });
  assert.deepStrictEqual(list1.files.map((f) => f.name).sort(), ['arr.txt', 'notes.txt']);
  assert.strictEqual(list1.files.find((f) => f.name === 'arr.txt').size, 3);

  // 2. replace-on-name removes the old stored file
  await grokCompatService.dispatch('uploadGrokBotAgentFile', { agentId: 'agent-1', fileName: 'notes.txt', contentType: 'text/plain', bytes: new Uint8Array(Buffer.from('updated context')) });
  const filesOnDisk = fs.readdirSync(path.join(tmp, 'agent-files', 'agent-1')).filter((f) => f.endsWith('-notes.txt'));
  assert.strictEqual(filesOnDisk.length, 1, 'old revision pruned');
  const list2 = await grokCompatService.dispatch('listGrokBotAgentFiles', { agentId: 'agent-1' });
  assert.strictEqual(list2.files.find((f) => f.name === 'notes.txt').size, 15);

  // 3. validation: empty, path-y names, missing agentId
  const empty = await grokCompatService.dispatch('uploadGrokBotAgentFile', { agentId: 'agent-1', fileName: 'e.txt', bytes: new Uint8Array(0) });
  assert.strictEqual(empty.status, 'error');
  const traversal = await grokCompatService.dispatch('uploadGrokBotAgentFile', { agentId: 'agent-1', fileName: '../evil.sh', bytes: new Uint8Array([1]) });
  assert.strictEqual(traversal.status, 'ok');
  assert.strictEqual(traversal.name, 'evil.sh', 'path components stripped');
  const noAgent = await grokCompatService.dispatch('listGrokBotAgentFiles', {});
  assert.strictEqual(noAgent.status, 'error');

  // 4. sandbox mirror when the agent computer workspace exists
  const sandboxRoot = sandboxService.sandboxRoot('agent-1');
  fs.mkdirSync(sandboxRoot, { recursive: true });
  await grokCompatService.dispatch('uploadGrokBotAgentFile', { agentId: 'agent-1', fileName: 'mirror.txt', contentType: 'text/plain', bytes: new Uint8Array(Buffer.from('m')) });
  assert.strictEqual(fs.readFileSync(path.join(sandboxRoot, 'agent-files', 'mirror.txt'), 'utf8'), 'm');

  // 5. delete is real
  const del = await grokCompatService.dispatch('deleteGrokBotAgentFile', { agentId: 'agent-1', name: 'arr.txt' });
  assert.strictEqual(del.deleted, true);
  const delAgain = await grokCompatService.dispatch('deleteGrokBotAgentFile', { agentId: 'agent-1', name: 'arr.txt' });
  assert.strictEqual(delAgain.deleted, false);
  const list3 = await grokCompatService.dispatch('listGrokBotAgentFiles', { agentId: 'agent-1' });
  assert.ok(!list3.files.some((f) => f.name === 'arr.txt'));

  // 6. pickAvatarFile → dataUrl + fileName (stubbed native dialog)
  const picked = await grokCompatService.dispatch('pickAvatarFile', {});
  assert.strictEqual(picked.ok, true);
  assert.strictEqual(picked.fileName, 'me.png');
  assert.match(picked.dataUrl, /^data:image\/png;base64,/);
  const viaSource = await grokCompatService.dispatch('pickAvatarSource', {});
  assert.strictEqual(viaSource.source, 'file');
  assert.strictEqual(viaSource.dataUrl, picked.dataUrl);

  // 7. composing/viewing state
  sessionService.ensure('sess-a');
  const comp = await grokCompatService.dispatch('setComposingAgent', { agentId: 'sess-a', composing: true });
  assert.strictEqual(comp.composing, true);
  assert.strictEqual(sessionService.get('sess-a').composing, true);
  const compMissing = await grokCompatService.dispatch('setComposingAgent', { agentId: 'no-such-session', composing: true });
  assert.strictEqual(compMissing.status, 'ok', 'missing session is a no-op, not an error');
  const viewing = await grokCompatService.dispatch('setViewingAgent', { agentId: 'sess-a' });
  assert.strictEqual(viewing.agentId, 'sess-a');
  assert.strictEqual(settingsService.load().viewingAgentId, 'sess-a');
  const cleared = await grokCompatService.dispatch('setViewingAgent', { agentId: null });
  assert.strictEqual(cleared.agentId, null);
  assert.strictEqual(settingsService.load().viewingAgentId, null);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  console.log('agent-files test: ALL OK (upload/replace/list/delete/mirror/avatars/presence)');
})().catch((e) => { console.error(e); process.exit(1); });
