'use strict';
/* Delegation depth test — Grok SubagentArgs cluster: model_parameters passthrough,
 * selected_context injection, continuation_config (max_loops / nudge), readonly,
 * and real long-shell cancellation via exec.cancel. Real sandbox workers + real
 * coordinator; provider is a fixture. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), Module = require('node:module');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-deleg-'));
process.env.QUANSIOX_USER_DATA_DIR = profile;
process.env.QUANSIOX_TEST_USERDATA = profile;
delete process.env.TYPESAFE_API_KEY;
const origResolve = Module._resolveFilename;
Module._resolveFilename = (n, ...r) => (n === 'electron' ? require.resolve('./stub-electron.js') : origResolve.call(this, n, ...r));
const { settingsService } = require('../src/main/services/settingsService');
const { sandboxService } = require('../src/main/services/sandboxService');
const { agentService } = require('../src/main/services/agentService');
const requests = [];
const sender = { isDestroyed: () => false, send: () => {} };
const event = { sender };
const shellCall = (command) => ({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command }) } }] });
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const input = JSON.parse(body || '{}');
    requests.push(input);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let delta;
    if (input.model === 'shell-child') delta = shellCall('sleep 30');
    else if (input.model === 'ro-child') delta = { role: 'assistant', content: 'read done' };
    else delta = shellCall('echo hi');
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  });
});
let timeout = setTimeout(() => { console.error('delegation timed out'); process.exit(1); }, 40_000);
const control = (action, options = {}) => agentService.task(event, { sessionId: 'deleg-parent', action, ...options });
const start = async (o) => JSON.parse(await control('start', o));
const wait = (id) => control('wait', { id, timeout_ms: 8000 });

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  settingsService.save({ workspaceRoot: profile, sandboxMode: 'sandboxed', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', model: 'parent', mcpServers: [], autoCheckpoint: false, notifyOnDone: false });
  const { sessionService } = require('../src/main/services/sessionService');
  sessionService.ensure('deleg-parent');

  // 1. model_parameters → forwarded to the provider for this child only
  const mp = await start({ prompt: 'p', model: 'mp-child', model_parameters: [{ name: 'temperature', value: 0.9 }, { name: 'top_p', value: 0.5 }, { name: 'seed', value: 42 }, { name: 'junk', value: 'x' }] });
  if (process.env.QX_DEBUG) console.error('MP start =>', JSON.stringify(mp));
  await wait(mp.id);
  const mpReq = requests.find((r) => r.model === 'mp-child');
  assert.ok(mpReq, 'child request recorded');
  assert.strictEqual(mpReq.temperature, 0.9);
  assert.strictEqual(mpReq.top_p, 0.5);
  assert.strictEqual(mpReq.seed, 42);
  assert.ok(!('junk' in mpReq), 'unknown sampling keys are dropped');

  // 2. selected_context reaches the child's task
  const ctx = await start({ prompt: 'do it', model: 'ctx-child', selected_context: 'ROSTER=alpha;beta;gamma' });
  await wait(ctx.id);
  const ctxReq = requests.find((r) => r.model === 'ctx-child' && r.messages.some((m) => String(m.content).includes('ROSTER=alpha')));
  assert.ok(ctxReq, 'selected_context is injected into the child prompt');

  // 3. continuation_config max_loops → nudge_message surfaced when budget spent
  const cap = await start({ prompt: 'loop', model: 'cap-child', continuation_config: { max_loops: 1, nudge_message: 'budget spent — resume to finish' } });
  const capDone = await wait(cap.id);
  assert.strictEqual(capDone.status, 'completed');
  assert.match(capDone.summary, /budget spent/, 'nudge_message is surfaced when the step budget is spent');

  // 4. readonly forces a read-only (explore) child (verify via persisted record)
  const ro = await start({ prompt: 'read', model: 'ro-child', readonly: true, subagent_type: 'shell' });
  const roRec = await control('get', { id: ro.id });
  assert.strictEqual(roRec.type, 'explore', 'readonly forces an explore child');
  assert.strictEqual(roRec.policy.permissionMode, 'read-only');
  await wait(ro.id);

  // 5. interrupting a child cancels its long-running sandbox shell (exec.cancel)
  const long = await start({ prompt: 'long task', model: 'shell-child', subagent_type: 'shell', environment: 'isolated' });
  await new Promise((r) => setTimeout(r, 350)); // let it reach the sandbox exec(sleep 30)
  await control('interrupt', { id: long.id });
  const afterInterrupt = await wait(long.id);
  assert.strictEqual(afterInterrupt.status, 'aborted', 'interrupt aborts the child (shell cancelled, not left running)');

  console.log('DELEGATION OK — model params, selected_context, continuation_config, readonly, long-shell interrupt');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  clearTimeout(timeout);
  for (const e of sandboxService.status()) await sandboxService.stop(e.sessionId).catch(() => {});
  for (const h of process._getActiveHandles()) if (h.spawnargs?.some((a) => a.endsWith('/src/coordinator/index.js')) && h.exitCode === null) h.kill('SIGTERM');
  server.closeAllConnections?.(); server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
});
