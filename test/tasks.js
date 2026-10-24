'use strict';
// Real main service + coordinator + sandbox workers; only the provider and
// Electron window APIs are fixtures. Exercises durable task lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), Module = require('node:module');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-tasks-'));
process.env.QUANSIOX_USER_DATA_DIR = profile;
process.env.QUANSIOX_TEST_USERDATA = profile;
delete process.env.TYPESAFE_API_KEY;
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...rest) { return name === 'electron' ? require.resolve('./stub-electron.js') : originalResolve.call(this, name, ...rest); };
const { settingsService } = require('../src/main/services/settingsService');
const { sandboxService } = require('../src/main/services/sandboxService');
const { agentService } = require('../src/main/services/agentService');
const { taskStore } = require('../src/coordinator/task-store');
const requests = [], senders = [];
const sender = { isDestroyed: () => false, send: (...args) => senders.push(args) };
const event = { sender };
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body); requests.push(input);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (input.model === 'slow-child') { res.write(': keep-alive\n\n'); return; }
  const last = input.messages.at(-1);
  let delta;
  if (last.role === 'user' && last.content.startsWith('WRITE ')) {
    const value = last.content.slice(6);
    delta = { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'write-proof', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'proof.txt', content: value }) } }] };
  } else delta = { role: 'assistant', content: `answer:${input.model}:${last.role === 'tool' ? 'written' : last.content}` };
  res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
});
let timeout = setTimeout(() => { console.error('task integration timed out'); process.exit(1); }, 25_000);
const control = (action, options = {}) => agentService.task(event, { sessionId: 'task-parent', action, ...options });
const start = async (options) => JSON.parse(await control('start', options));
const wait = (id) => control('wait', { id, timeout_ms: 5000 });
function coordinator() {
  return process._getActiveHandles().find((handle) => handle.spawnargs?.some((arg) => arg.endsWith('/src/coordinator/index.js')) && handle.exitCode === null);
}
async function killCoordinator() {
  const child = coordinator(); assert.ok(child, 'actual coordinator process must exist');
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); });
}
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  settingsService.save({ workspaceRoot: profile, sandboxMode: 'sandboxed', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', model: 'parent-model', mcpServers: [], autoCheckpoint: false, notifyOnDone: false });
  const { sessionService } = require('../src/main/services/sessionService');
  sessionService.ensure('task-parent');
  sessionService.appendTurn('task-parent', { role: 'user', content: 'PRIVATE_PARENT_CONTEXT' });
  const a = await start({ prompt: 'WRITE alpha', description: 'Alpha', model: 'child-A', subagent_type: 'general', environment: 'isolated' });
  const b = await start({ prompt: 'WRITE beta', description: 'Beta', model: 'child-B', subagent_type: 'general', environment: 'isolated' });
  const [doneA, doneB] = await Promise.all([wait(a.id), wait(b.id)]);
  assert.equal(doneA.status, 'completed'); assert.equal(doneB.status, 'completed');
  assert.equal(doneA.model, 'child-A'); assert.equal(doneB.model, 'child-B');
  assert.notEqual(doneA.toolSessionId, doneB.toolSessionId);
  assert.notEqual(doneA.browserSessionId, doneB.browserSessionId);
  assert.equal(fs.readFileSync(path.join(doneA.workspaceRoot, 'proof.txt'), 'utf8'), 'alpha');
  assert.equal(fs.readFileSync(path.join(doneB.workspaceRoot, 'proof.txt'), 'utf8'), 'beta');
  assert.equal(fs.existsSync(path.join(sandboxService.sandboxRoot('task-parent'), 'proof.txt')), false);
  assert.equal(await control('artifact', { id: a.id, path: 'proof.txt' }), 'alpha');
  assert.ok(doneA.messages.some((turn) => turn.role === 'tool' && turn.name === 'write_file'));
  assert.ok(requests.filter((request) => request.model === 'child-A').length >= 2);
  assert.ok(!JSON.stringify(requests).includes('PRIVATE_PARENT_CONTEXT'));
  await assert.rejects(control('get', { sessionId: 'wrong-parent', id: a.id }), /another session/);

  const slow = await start({ prompt: 'Wait forever', model: 'slow-child', subagent_type: 'explore' });
  const sibling = await start({ prompt: 'SIBLING', model: 'fast-child', subagent_type: 'explore' });
  await control('interrupt', { id: slow.id });
  assert.equal((await wait(slow.id)).status, 'aborted');
  assert.equal((await wait(sibling.id)).status, 'completed');

  await killCoordinator();
  assert.equal((await control('get', { id: a.id })).status, 'completed', 'completed task survives coordinator restart');
  const resumed = JSON.parse(await control('resume', { id: a.id, prompt: 'Continue from alpha', model: 'resume-model' }));
  assert.equal(resumed.id, a.id);
  const afterResume = await wait(a.id);
  assert.equal(afterResume.runAttempt, 2);
  assert.ok(requests.some((request) => request.model === 'resume-model' && request.messages.some((turn) => turn.role === 'tool' && turn.content.includes('wrote'))));
  const forked = JSON.parse(await control('fork', { id: a.id, prompt: 'Fork follow-up', model: 'fork-model' }));
  assert.notEqual(forked.id, a.id);
  const forkRecord = await wait(forked.id);
  assert.equal(forkRecord.forkedFrom, a.id);
  assert.equal(fs.readFileSync(path.join(forkRecord.workspaceRoot, 'proof.txt'), 'utf8'), 'alpha', 'fork gets a separate copy of source files');
  fs.writeFileSync(path.join(forkRecord.workspaceRoot, 'proof.txt'), 'fork changed');
  assert.equal(fs.readFileSync(path.join(afterResume.workspaceRoot, 'proof.txt'), 'utf8'), 'alpha', 'fork files cannot change original');
  assert.equal(taskStore.get(a.id).runAttempt, 2, 'fork does not overwrite original transcript');

  const interrupted = await start({ prompt: 'Crash recovery', model: 'slow-child', subagent_type: 'explore' });
  await killCoordinator();
  const recovered = await control('get', { id: interrupted.id });
  assert.equal(recovered.status, 'interrupted');
  await control('resume', { id: interrupted.id, prompt: 'Finish after restart', model: 'recovery-model' });
  assert.equal((await wait(interrupted.id)).status, 'completed');
  assert.ok((await control('list')).some((record) => record.id === interrupted.id));
  // Interrupted assistant calls are represented explicitly, never replayed by recovery.
  const repaired = taskStore.continuation({ messages: [{ role: 'assistant', tool_calls: [{ id: 'uncertain', function: { name: 'shell', arguments: '{}' } }] }] });
  assert.equal(repaired[1].tool_call_id, 'uncertain');
  assert.match(repaired[1].content, /Inspect current state/);
  console.log('TASKS OK — child models, persisted transcripts, isolated files, scoped access, artifact retrieval, individual interrupt, resume/fork and crash recovery');
  if (process.env.QUANSIOX_TASK_REPORT) fs.writeFileSync(process.env.QUANSIOX_TASK_REPORT, JSON.stringify({ passed: true, taskIds: (await control('list')).map((record) => record.id), requestedModels: [...new Set(requests.map((request) => request.model))], privateParentContextLeaked: false }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(timeout);
  for (const entry of sandboxService.status()) await sandboxService.stop(entry.sessionId);
  for (const handle of process._getActiveHandles()) if (handle.spawnargs?.some((arg) => arg.endsWith('/src/coordinator/index.js')) && handle.exitCode === null) handle.kill('SIGTERM');
  server.closeAllConnections(); server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
});
