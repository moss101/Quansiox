'use strict';
/* Local-first namespaces wired to first-class IPC: feedback, diagnostics,
 * net (link previews + probes), box secrets, per-agent files/skills/plugins.
 * Runs the real registry sender checks with a tracked main window. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-local-ns-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

// Capture the single invoke channel via a stubbed ipcMain.
const handlers = {};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-playback.js');
  return origResolve.call(this, req, ...rest);
};
const stub = require('./stub-electron-playback.js');
stub.ipcMain = {
  on: (ch, fn) => { handlers[ch] = fn; },
  handle: (ch, fn) => { handlers[ch] = fn; },
};
class FakeBrowserWindow {
  constructor() { this.id = ++FakeBrowserWindow.nextId; this.destroyed = false; this.listeners = new Map(); }
  static nextId = 0;
  on(event, cb) { this.listeners.set(event, cb); return this; }
  isDestroyed() { return this.destroyed; }
  loadFile() {}
  loadURL() { return Promise.resolve(); }
  webContents = { on: () => {}, send: () => {}, openDevTools: () => {}, getURL: () => 'file:///app/renderer/index.html' };
}
stub.__setBrowserWindow(FakeBrowserWindow);

const { windowManager, WindowManager } = require('../src/main/windowManager');
const { setupIpc } = require('../src/main/ipc/registry');

const wm = new WindowManager();
const singleton = require('../src/main/windowManager').windowManager;
singleton.windows = wm.windows;

require('../src/main/ipc/namespaces.js');
setupIpc();

const win = wm.createMainWindow();
function fakeEvent() {
  const mainFrame = { url: 'file:///app/renderer/index.html' };
  return {
    sender: {
      id: win.id,
      isDestroyed: () => false,
      mainFrame,
      getURL: () => mainFrame.url,
    },
    senderFrame: mainFrame,
  };
}
async function call(route, ...args) {
  let res;
  try {
    res = await handlers['quansiox-ipc-api'](fakeEvent(), route, ...args);
  } catch (error) {
    res = { ok: false, error: String(error?.message ?? error) };
  }
  assert.ok(res && typeof res === 'object', `${route} answered`);
  return res;
}
async function ok(route, ...args) {
  const res = await call(route, ...args);
  assert.equal(res.ok, true, `${route} ok: ${JSON.stringify(res)}`);
  return res.result;
}
async function fails(route, ...args) {
  const res = await call(route, ...args);
  assert.equal(res.ok, false, `${route} should fail: ${JSON.stringify(res)}`);
  return String(res.error);
}

(async () => {
  // 1. feedback: append + list
  const entry = await ok('feedback:send', { message: 'ship it' });
  assert.ok(entry.id.startsWith('fb_'));
  assert.equal(entry.kind, 'feedback');
  assert.equal(entry.payload.message, 'ship it');
  const votes = await ok('feedback:send', { kind: 'vote', message: 'up' });
  assert.equal(votes.kind, 'vote');
  const listed = await ok('feedback:list', { limit: 10 });
  assert.equal(listed.length, 2);
  assert.equal(await fails('feedback:send', { message: '' }).then((e) => /required/.test(e)), true);
  assert.ok(fs.existsSync(path.join(tmp, 'feedback.jsonl')));

  // 2. diagnostics: record via service, list/summary/clear through IPC
  const { diagnosticsService } = require('../src/main/services/diagnosticsService');
  diagnosticsService.record('unit_test', { ok: true });
  const events = await ok('diagnostics:list', { limit: 5, kind: 'unit_test' });
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.ok, true);
  const summary = await ok('diagnostics:summary');
  assert.ok(summary.total >= 1);
  assert.ok(summary.byKind.unit_test >= 1);
  assert.equal(await ok('diagnostics:clear'), true);
  assert.equal((await ok('diagnostics:list', {})).length, 0);

  // 3. net: invalid URLs degrade honestly, bad hosts are refused, probes run
  const meta = await ok('net:linkMetadata', { url: 'not a url' });
  assert.equal(meta.status, 'ok');
  assert.equal(meta.metadata, null);
  assert.ok(/missing required argument/.test(await fails('net:linkMetadata', {})));
  assert.ok(/invalid host/.test(await fails('net:runDiagnostics', { hosts: ['evil host!'] })));
  const diag = await ok('net:runDiagnostics', { hosts: ['localhost'] });
  assert.equal(diag.status, 'ok');
  assert.equal(diag.dns.length, 1);
  assert.equal(diag.dns[0].host, 'localhost');
  assert.ok(Array.isArray(diag.tcp));

  // 4. box secrets: values are write-only, names listed, remove works
  await ok('boxSecrets:set', { secrets: { DEPLOY_TOKEN: 's3cret-value' } });
  const status = await ok('boxSecrets:status');
  assert.deepEqual(status.names, ['DEPLOY_TOKEN']);
  assert.equal(JSON.stringify(status).includes('s3cret-value'), false, 'status never echoes values');
  const beforeCarry = await ok('boxSecrets:list', {});
  assert.equal(beforeCarry.length, 0);
  await ok('boxSecrets:carry', { serverId: 'srv-1', names: ['DEPLOY_TOKEN'] });
  const carried = await ok('boxSecrets:list', { serverId: 'srv-1' });
  assert.equal(carried.length, 1);
  assert.equal(carried[0].name, 'DEPLOY_TOKEN');
  assert.equal(JSON.stringify(carried).includes('s3cret-value'), false, 'carried listing never echoes values');
  await ok('boxSecrets:remove', { name: 'DEPLOY_TOKEN' });
  assert.deepEqual((await ok('boxSecrets:status')).names, []);
  assert.ok(/missing required argument/.test(await fails('boxSecrets:remove', {})));

  // 5. per-agent files: base64 upload, list, delete
  await ok('agentFiles:upload', { agentId: 'bot-1', fileName: 'notes.txt', contentType: 'text/plain', bytes: Buffer.from('hello agent').toString('base64') });
  const files = await ok('agentFiles:list', { agentId: 'bot-1' });
  assert.equal(files.files.length, 1);
  assert.equal(files.files[0].name, 'notes.txt');
  assert.equal(files.files[0].size, 11);
  await ok('agentFiles:remove', { agentId: 'bot-1', name: 'notes.txt' });
  assert.equal((await ok('agentFiles:list', { agentId: 'bot-1' })).files.length, 0);

  // 6. per-agent plugins (inline binding) and skills
  const empty = await ok('agentPlugins:get', { agentId: 'bot-1' });
  assert.deepEqual(empty.plugins, []);
  const set = await ok('agentPlugins:set', { agentId: 'bot-1', plugins: [{ kind: 'inline', name: 'fetch', displayName: 'Fetch', mcpConfigJson: '{"url":"http://localhost:9000"}' }] });
  assert.equal(set.plugins.length, 1);
  assert.equal(set.plugins[0].displayName, 'Fetch');
  await ok('agentSkills:add', { agentId: 'bot-1', name: 'Ship It', description: 'release helper', content: '# steps\n1. tag' });
  const skills = await ok('agentSkills:list', { agentId: 'bot-1' });
  assert.equal(skills.length, 1);
  assert.ok(skills[0].inCatalog);
  await ok('agentSkills:remove', { agentId: 'bot-1', name: 'ship-it' });
  assert.equal((await ok('agentSkills:list', { agentId: 'bot-1' })).length, 0);

  // 7. Messages agent tools: read-only guard, status probe, honest disabled send
  const { allTools, executeTool } = require('../src/coordinator/index.js');
  const { guardTool } = require('../src/coordinator/permissions.js');
  const toolNames = allTools().map((t) => t.function.name);
  for (const name of ['messages_status', 'messages_chats', 'messages_read', 'messages_search', 'messages_send']) {
    assert.ok(toolNames.includes(name), `${name} is offered to the model`);
  }
  assert.ok(toolNames.includes('browser_import_cookies'), 'Chrome cookie import is agent-reachable');
  assert.match(
    guardTool('browser_import_cookies', {}, { permissionMode: 'read-only', allowlist: ['browser_import_cookies'] }),
    /cannot drive browser_import_cookies/,
  );
  const readOnly = { permissionMode: 'read-only', allowlist: ['messages_send', 'messages_read'] };
  assert.match(guardTool('messages_send', {}, readOnly), /read-only subagent cannot write/);
  assert.equal(guardTool('messages_read', {}, readOnly), null);
  const msgStatus = await executeTool('messages_status', {}, tmp, 'ns-session', { permissive: true });
  const statusJson = JSON.parse(msgStatus);
  assert.equal(statusJson.enabled, false);
  assert.ok(['missing', 'denied', 'granted'].includes(statusJson.read.status));
  assert.deepEqual(statusJson.recipients, []);
  const send = await executeTool('messages_send', { to: '+15551234567', text: 'hi' }, tmp, 'ns-session', { permissive: true });
  assert.match(send, /Messages is disabled/);

  // 8. unknown routes still fail cleanly
  assert.ok(/unknown|not found/i.test(await fails('feedback:nope', {})));

  console.log('local-namespaces test: ALL OK (feedback/diagnostics/net/boxSecrets/agentFiles/agentPlugins/agentSkills)');
})().catch((error) => { console.error(error); process.exit(1); });
