'use strict';
/* Shell interactions — tray notifications, user forms and widgets:
 * create → getTrays/getForms, submit/dismiss/respond flows, awaitEntry
 * resolution, saveToVault into the encrypted secret store, validation and
 * persistence pruning. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-shell-interactions-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { userInteractionService } = require('../src/main/services/userInteractionService');
const { secretsService } = require('../src/main/services/secretsService');

(async () => {
  // 1. trays: create → list → dismiss one → clear the rest
  const t1 = userInteractionService.createTray({ title: 'Agent needs attention', body: 'Review the changes', agentId: 'agent-1' });
  const t2 = userInteractionService.createTray({ title: 'Second tray' });
  const listed = await grokCompatService.dispatch('getTrays', {});
  assert.strictEqual(listed.status, 'ok');
  assert.deepStrictEqual(listed.trays.map((t) => t.id).sort(), [t1.id, t2.id].sort());
  assert.strictEqual(listed.trays.find((t) => t.id === t1.id).body, 'Review the changes');
  const dismissed = await grokCompatService.dispatch('dismissTray', { id: t1.id });
  assert.strictEqual(dismissed.status, 'ok');
  assert.strictEqual(dismissed.dismissed, true);
  const afterDismiss = await grokCompatService.dispatch('getTrays', {});
  assert.deepStrictEqual(afterDismiss.trays.map((t) => t.id), [t2.id]);
  const cleared = await grokCompatService.dispatch('clearTrays', {});
  assert.strictEqual(cleared.cleared, 1);
  assert.deepStrictEqual((await grokCompatService.dispatch('getTrays', {})).trays, []);
  const badTray = await grokCompatService.dispatch('dismissTray', { id: 'tray_nope' });
  assert.strictEqual(badTray.status, 'error');

  // 2. user form: request → awaitEntry resolves on submit; saveToVault persists
  const form = userInteractionService.requestForm({
    agentId: 'agent-1',
    sessionId: 'sess-1',
    title: 'Deployment details',
    fields: [
      { name: 'region', label: 'Region', type: 'text', required: true },
      { name: 'apiKey', label: 'API key', type: 'password' },
    ],
  });
  assert.strictEqual(form.state, 'pending');
  assert.strictEqual(form.fields.length, 2);
  const awaiting = userInteractionService.awaitEntry(form.id, 5000);
  const submitted = await grokCompatService.dispatch('submitUserForm', {
    entryId: form.id,
    values: { region: 'eu-west-1', apiKey: 'sk-test-123' },
    agentId: 'agent-1',
    saveToVault: true,
  });
  assert.strictEqual(submitted.status, 'ok');
  assert.strictEqual(submitted.state, 'submitted');
  assert.strictEqual(submitted.savedToVault, true);
  const settled = await awaiting;
  assert.strictEqual(settled.submitted, true);
  assert.deepStrictEqual(settled.values, { region: 'eu-west-1', apiKey: 'sk-test-123' });
  const secret = secretsService.get('userform_agent-1');
  assert.ok(secret, 'form saved into the secret store');
  assert.strictEqual(secret.fields.region, 'eu-west-1');
  assert.strictEqual(secret.fields.apiKey, 'sk-test-123');

  // resubmitting a resolved form is rejected
  const resubmit = await grokCompatService.dispatch('submitUserForm', { entryId: form.id, values: { region: 'x' } });
  assert.strictEqual(resubmit.status, 'error');

  // 3. dismiss modes + validation
  const form2 = userInteractionService.requestForm({ agentId: 'agent-2', title: 'More input', fields: [{ name: 'why' }] });
  const badMode = await grokCompatService.dispatch('dismissUserForm', { entryId: form2.id, mode: 'exploded', agentId: 'agent-2' });
  assert.strictEqual(badMode.status, 'ok');
  assert.strictEqual(badMode.state, 'dismissed', 'unknown mode degrades to dismissed');
  const form3 = userInteractionService.requestForm({ agentId: 'agent-2', title: 'Third', fields: [{ name: 'why' }] });
  const escalated = await grokCompatService.dispatch('dismissUserForm', { entryId: form3.id, mode: 'escalated', agentId: 'agent-2' });
  assert.strictEqual(escalated.state, 'escalated');
  const badValues = await grokCompatService.dispatch('submitUserForm', { entryId: 'form_nope', values: { a: 'b' } });
  assert.strictEqual(badValues.status, 'error');
  const noFields = (() => { try { userInteractionService.requestForm({ agentId: 'a', fields: [{}] }); return null; } catch (e) { return String(e.message); } })();
  assert.match(noFields, /needs a name/);

  // 4. widgets: respond carries the value back; dismiss closes it
  const w1 = userInteractionService.requestWidget({ agentId: 'agent-3', title: 'Approve plan?', widgetType: 'approval' });
  const wAwait = userInteractionService.awaitEntry(w1.id, 5000);
  const responded = await grokCompatService.dispatch('respondToWidget', { entryId: w1.id, value: 'approved', agentId: 'agent-3' });
  assert.strictEqual(responded.status, 'ok');
  assert.strictEqual(responded.value, 'approved');
  const wSettled = await wAwait;
  assert.strictEqual(wSettled.responded, true);
  assert.strictEqual(wSettled.value, 'approved');
  const w2 = userInteractionService.requestWidget({ agentId: 'agent-3', title: 'Chart', widgetType: 'chart' });
  const wDismissed = await grokCompatService.dispatch('dismissWidget', { entryId: w2.id, agentId: 'agent-3' });
  assert.strictEqual(wDismissed.state, 'dismissed');
  const missingAgent = await grokCompatService.dispatch('respondToWidget', { entryId: 'widget_x', value: 'v' });
  assert.strictEqual(missingAgent.status, 'error');

  // 5. persistence + pruning: pending survives reload, resolved ages out
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'interactions.json'), 'utf8'));
  assert.ok(raw.entries.some((e) => e.id === form.id && e.state === 'submitted'));
  assert.ok(raw.entries.some((e) => e.id === w1.id && e.state === 'responded'));
  assert.strictEqual(fs.statSync(path.join(tmp, 'interactions.json')).mode & 0o777, 0o600);
  for (const e of raw.entries) if (e.id === form.id || e.id === w1.id) e.resolvedAt = Date.now() - 25 * 60 * 60 * 1000;
  fs.writeFileSync(path.join(tmp, 'interactions.json'), JSON.stringify(raw), { mode: 0o600 });
  userInteractionService.listTrays();
  const pruned = JSON.parse(fs.readFileSync(path.join(tmp, 'interactions.json'), 'utf8'));
  assert.ok(!pruned.entries.some((e) => e.id === form.id), 'stale resolved entry pruned');
  assert.ok(pruned.entries.some((e) => e.id === w2.id && e.state === 'dismissed'), 'recent resolved entry kept');

  console.log('shell-interactions test: ALL OK (trays/forms/widgets + vault + pruning)');
})().catch((e) => { console.error(e); process.exit(1); });
