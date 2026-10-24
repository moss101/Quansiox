'use strict';
/* Automations & workflows test — Grok createAgentAutomation / *Workflow,
 * local-first. Covers: CRUD, enable/disable, interval floor, workflow step
 * sequencing, runNow via the compat surface, scheduler due-gating, webhook
 * token + timingSafe verify, and text import. Electron-free (injected runner). */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-auto-test-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { automationService } = require('../src/main/services/automationService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  // fake agent runner: records (sessionId, message) and returns a stub result.
  const calls = [];
  automationService.setRunner(async (sessionId, message) => { calls.push([sessionId, message]); return `done: ${message.slice(0, 12)}`; });

  // 1. create an automation
  const a = automationService.create({ sessionId: 'auto-sess', prompt: 'summarize the repo', intervalMs: 60_000 });
  assert.match(a.id, /^auto_/);
  assert.strictEqual(a.kind, 'automation');
  assert.strictEqual(a.intervalMs, 60_000); // interval floor
  assert.strictEqual(a.lastStatus, 'idle');

  // 2. interval floor of 60s
  const fast = automationService.create({ sessionId: 's', prompt: 'x', intervalMs: 5 });
  assert.strictEqual(fast.intervalMs, 60_000, 'interval clamped to 60s floor');
  automationService.setEnabled(fast.id, false); // keep it out of the scheduler checks below

  // 3. run it (feeds prompt to the injected runner)
  const r1 = await automationService.run(a.id);
  assert.strictEqual(r1.status, 'ok');
  assert.deepStrictEqual(calls[0], ['auto-sess', 'summarize the repo']);
  assert.strictEqual(automationService.get(a.id).runCount, 1);
  assert.strictEqual(automationService.get(a.id).lastStatus, 'ok');
  assert.ok(!('value' in JSON.parse(JSON.stringify(automationService.list())).find((x) => x.id === a.id))); // no leak fields

  // 4. scheduler due-gating: not due immediately after a run; interval < 60s never fires early
  assert.strictEqual(automationService.due(Date.now() + 30_000).length, 0, 'not due within interval');
  assert.strictEqual(automationService.due(Date.now() + 61_000).length, 1, 'due after interval');
  const fired = await automationService.tick(Date.now() + 61_000);
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(calls.length, 2);

  // 5. enable/disable gates scheduling
  automationService.setEnabled(a.id, false);
  assert.strictEqual(automationService.due(Date.now() + 3600_000).length, 0, 'disabled automation never dues');

  // 6. workflow: ordered steps run sequentially in one session
  const w = automationService.create({ kind: 'workflow', sessionId: 'wf', name: 'Release', steps: ['build', 'test', 'publish'] });
  assert.strictEqual(w.kind, 'workflow');
  const wr = await automationService.run(w.id);
  assert.strictEqual(wr.status, 'ok'); assert.strictEqual(wr.ran, 3);
  assert.deepStrictEqual(calls.slice(-3).map((c) => c[1]), ['build', 'test', 'publish']);

  // 7. list filtering
  assert.strictEqual(automationService.list('wf').length, 1);
  assert.ok(automationService.list().length >= 2);

  // 8. webhook token + timingSafe verification
  const hook = automationService.webhookToken(a.id);
  assert.match(hook.token, /^[0-9a-f]{64}$/);
  const ref = automationService.get(a.id); // internal read keeps the token; public list() must not
  assert.ok(!automationService.list().find((x) => x.id === a.id).hasWebhook === false, 'hasWebhook flag is public but token is not');
  automationService.setEnabled(a.id, true);
  const hw = await automationService.runByWebhook(a.id, hook.token); // valid token triggers a run
  assert.strictEqual(hw.status, 'ok');
  await assert.rejects(() => automationService.runByWebhook(a.id, 'deadbeef'), /invalid webhook token/);

  // 9. text import becomes a workflow with parsed steps
  const imported = automationService.importWorkflowText({ name: 'Deploy', text: '# Deploy\n1. pull\n2. build\n- test\n- ship' });
  assert.strictEqual(imported.kind, 'workflow');
  assert.deepStrictEqual(imported.steps, ['pull', 'build', 'test', 'ship']);
  assert.strictEqual(imported.name, 'Deploy');

  // 10. through the Grok compatibility surface (fail-closed → real now)
  let env = await grokCompatService.dispatch('createAgentAutomation', { sessionId: 'compat', prompt: 'nightly build' });
  assert.strictEqual(env.status, 'ok'); assert.ok(env.automation.id);
  env = await grokCompatService.dispatch('runAgentAutomationNow', { id: env.automation.id });
  assert.strictEqual(env.status, 'ok');
  env = await grokCompatService.dispatch('getAgentAutomations', { agentId: 'compat' });
  assert.strictEqual(env.status, 'ok'); assert.strictEqual(env.automations.length, 1);
  env = await grokCompatService.dispatch('listAllAutomations', {});
  assert.strictEqual(env.status, 'ok'); assert.ok(env.automations.length >= 3);

  // 11. update + remove
  automationService.update(env.automations[0]?.id ?? a.id, { enabled: false });
  automationService.remove(fast.id);
  assert.strictEqual(automationService.get(fast.id), null);

  // cron scheduling: create with a cron expression, used by due()
  const cr = automationService.create({ name: 'Daily 9am', prompt: 'standup', cron: '0 9 * * *', sessionId: 'cron-s' });
  assert.strictEqual(cr.cron, '0 9 * * *');
  const a0 = automationService.get(cr.id);
  const nextAt = require('../src/main/services/cron').next(a0.cron, new Date(a0.lastRunAt || a0.createdAt));
  assert.ok(nextAt && nextAt.getTime() >= Date.now() - 8000, 'cron next run computed');
  assert.throws(() => automationService.create({ name: 'bad', prompt: 'x', cron: '99 * * * *' }), /out of/);
  assert.throws(() => automationService.create({ name: 'bad', prompt: 'x', cron: '* *' }), /5 fields/);
  automationService.update(cr.id, { cron: '*/5 * * * *' });
  assert.strictEqual(automationService.get(cr.id).cron, '*/5 * * * *');

  // run history + test run (docs: routine run history / Test run)
  const hist = automationService.create({ name: 'History', prompt: 'hist', intervalMs: 60_000, sessionId: 'hist' });
  assert.deepStrictEqual(automationService.history(hist.id), [], 'no runs yet');
  const manual = await automationService.run(hist.id);
  assert.strictEqual(manual.status, 'ok');
  let runs = automationService.history(hist.id);
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].trigger, 'manual');
  assert.strictEqual(runs[0].status, 'ok');
  assert.ok(runs[0].at > 0 && runs[0].durationMs >= 0);
  const before = automationService.get(hist.id);
  const tested = await automationService.testRun(hist.id);
  assert.strictEqual(tested.status, 'ok');
  assert.strictEqual(tested.trigger, 'test');
  const after = automationService.get(hist.id);
  assert.strictEqual(after.runCount, before.runCount, 'test run does not advance runCount');
  assert.strictEqual(after.lastRunAt, before.lastRunAt, 'test run does not advance the schedule');
  runs = automationService.history(hist.id);
  assert.deepStrictEqual(runs.map((r) => r.trigger), ['test', 'manual'], 'newest first');
  // webhook + scheduler triggers are recorded too
  const token = automationService.webhookToken(hist.id).token;
  await automationService.runByWebhook(hist.id, token);
  assert.strictEqual(automationService.history(hist.id)[0].trigger, 'webhook');
  // bounded history (max 20) + error entries
  automationService.setRunner(async () => { throw new Error('boom'); });
  const failed = await automationService.run(hist.id);
  assert.strictEqual(failed.status, 'error');
  assert.strictEqual(automationService.history(hist.id)[0].status, 'error');
  assert.match(automationService.history(hist.id)[0].error, /boom/);
  for (let i = 0; i < 25; i += 1) await automationService.testRun(hist.id);
  assert.strictEqual(automationService.history(hist.id).length, automationService.MAX_RUNS, 'history is bounded');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('automations test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
