'use strict';
/* Nested delegation test — children can spawn their own children (Grok-style,
 * depth-capped at 2). Real coordinator + real sandbox workers; provider is a
 * fixture keyed on model. Proves parent → child (depth 1) → grandchild (depth 2)
 * actually runs and the grandchild's isolated write lands. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), Module = require('node:module');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-nest-'));
process.env.QUANSIOX_USER_DATA_DIR = profile;
process.env.QUANSIOX_TEST_USERDATA = profile;
delete process.env.TYPESAFE_API_KEY;
const orig = Module._resolveFilename;
Module._resolveFilename = (n, ...r) => (n === 'electron' ? require.resolve('./stub-electron.js') : orig.call(Module, n, ...r));
const { settingsService } = require('../src/main/services/settingsService');
const { sandboxService } = require('../src/main/services/sandboxService');
const { agentService } = require('../src/main/services/agentService');
const { taskStore } = require('../src/coordinator/task-store');
const { guardTool } = require('../src/coordinator/permissions');
const sender = { isDestroyed: () => false, send: () => {} };
const event = { sender };

const taskCall = (args) => ({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 't', type: 'function', function: { name: 'task', arguments: JSON.stringify(args) } }] });
const writeCall = (args) => ({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'w', type: 'function', function: { name: 'write_file', arguments: JSON.stringify(args) } }] });
const textCall = (s) => ({ role: 'assistant', content: s });
// Return each tool call once, then a terminator (so loops end, no runaway fan-out).
const seen = {};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const input = JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const n = (seen[input.model] = (seen[input.model] || 0) + 1);
    let delta;
    if (input.model === 'ndp') delta = n === 1 ? taskCall({ prompt: 'child work', model: 'ndc', subagent_type: 'general', environment: 'isolated' }) : textCall('parent done');
    else if (input.model === 'ndc') delta = n === 1 ? taskCall({ prompt: 'grandchild work', model: 'ndg', subagent_type: 'general', environment: 'isolated' }) : textCall('child done');
    else if (input.model === 'ndg') delta = n === 1 ? writeCall({ path: 'proof.txt', content: 'deep' }) : textCall('grandchild done');
    else delta = textCall('root done');
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  });
});
let timeout = setTimeout(() => { console.error('nested-delegation timed out'); process.exit(1); }, 40_000);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  settingsService.save({ workspaceRoot: profile, sandboxMode: 'sandboxed', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture', model: 'ndp', mcpServers: [], autoCheckpoint: false, notifyOnDone: false });
  const { sessionService } = require('../src/main/services/sessionService');
  sessionService.ensure('nd-root');

  // Drive a full nested chain: parent (depth 0) → child (depth 1) → grandchild (depth 2).
  await agentService.run(event, { sessionId: 'nd-root', message: 'delegate deeply' });
  await new Promise((r) => setTimeout(r, 300)); // let persisted state settle

  const records = taskStore.list();
  const child = records.find((t) => t.model === 'ndc');
  const grand = records.find((t) => t.model === 'ndg');
  assert.ok(child, 'depth-1 child ran');
  assert.strictEqual(child.depth, 1);
  assert.ok(grand, 'depth-2 grandchild ran');
  assert.strictEqual(grand.depth, 2);
  assert.strictEqual(grand.parentSessionId, child.runSessionId, 'grandchild runs under the child session (proper nesting)');
  // the grandchild's isolated write landed in its own sandbox
  assert.equal(fs.readFileSync(path.join(grand.workspaceRoot, 'proof.txt'), 'utf8'), 'deep');
  assert.ok(!fs.existsSync(path.join(child.workspaceRoot, 'proof.txt')), "grandchild write didn't leak into the child workspace");

  // depth cap: a depth-2 agent is refused further delegation
  const capped = guardTool('task', { prompt: 'x' }, { permissive: false, fanOut: false, depth: 2, allowlist: ['read_file', 'task'], permissionMode: 'workspace', enableFileMutation: true });
  assert.match(capped, /depth limit/, 'depth-2 agent cannot spawn deeper agents');
  // depth 1 can still delegate
  const can = guardTool('task', { prompt: 'x' }, { permissive: false, fanOut: false, depth: 1, allowlist: ['read_file', 'task'], permissionMode: 'workspace', enableFileMutation: true });
  assert.strictEqual(can, null, 'depth-1 child can delegate');

  console.log('nested-delegation test: ALL OK');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  clearTimeout(timeout);
  for (const e of sandboxService.status()) await sandboxService.stop(e.sessionId).catch(() => {});
  for (const h of process._getActiveHandles()) if (h.spawnargs?.some((a) => a.endsWith('/src/coordinator/index.js')) && h.exitCode === null) h.kill('SIGTERM');
  server.closeAllConnections?.(); server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
});
