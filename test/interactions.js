'use strict';
/* Agent→user interaction cards: forms, secret requests, cross-process answers. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-interactions-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { userInteractionService: ui } = require('../src/main/services/userInteractionService');
const { secretsService } = require('../src/main/services/secretsService');
const { allTools, executeTool } = require('../src/coordinator/index');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cross-process submitter: the renderer runs in main, the agent in the
// coordinator fork, so the answer must be visible through the on-disk entry.
function submitFromChild(entryId, values, delayMs = 200) {
  const script = `
    const ui = require(${JSON.stringify(require.resolve('../src/main/services/userInteractionService'))}).userInteractionService;
    setTimeout(() => { ui.submitForm({ entryId: ${JSON.stringify(entryId)}, values: ${JSON.stringify(values)} }); }, ${delayMs});
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env: { ...process.env } });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err || `child exited ${code}`))));
  });
}

(async () => {
  assert.ok(allTools().some((t) => t.function.name === 'request_user_input'), 'tool offered');
  assert.ok(allTools().some((t) => t.function.name === 'request_secret'), 'secret tool offered');

  // ---- direct form lifecycle ----
  const entry = ui.requestForm({
    agentId: 'sess-1', sessionId: 'sess-1', title: 'Deploy target',
    fields: [{ name: 'env', label: 'Environment', type: 'select', options: ['staging', 'prod'], required: true }],
  });
  assert.equal(entry.kind, 'form');
  assert.equal(ui.pending().forms.length, 1, 'pending lists the card');
  const waiting = ui.awaitEntry(entry.id, 5000);
  await sleep(50);
  ui.submitForm({ entryId: entry.id, values: { env: 'staging' } });
  const outcome = await waiting;
  assert.equal(outcome.state, 'submitted');
  assert.equal(outcome.values.env, 'staging');
  assert.equal(ui.pending().forms.length, 0, 'submitted card leaves the pending list');
  assert.throws(() => ui.submitForm({ entryId: entry.id, values: {} }), /already submitted/);

  // ---- dismiss ----
  const dismissed = ui.requestForm({ agentId: 'sess-1', title: 'Optional', fields: [{ name: 'x' }] });
  const waitingDismiss = ui.awaitEntry(dismissed.id, 5000);
  ui.dismissForm({ entryId: dismissed.id, mode: 'dismissed' });
  const dismissedOutcome = await waitingDismiss;
  assert.equal(dismissedOutcome.state, 'dismissed');

  // ---- coordinator tool: request_user_input, answered by another process ----
  const toolPromise = executeTool(
    'request_user_input',
    { title: 'Project details', fields: [{ name: 'project', label: 'Project', required: true }], timeout_seconds: 10 },
    tmp, 'sess-tool', { permissive: true },
  );
  let pending = [];
  for (let i = 0; i < 40; i += 1) {
    pending = ui.pending().forms;
    if (pending.length) break;
    await sleep(50);
  }
  assert.equal(pending.length, 1, 'tool queued a form card');
  await submitFromChild(pending[0].id, { project: 'atlas' });
  const toolResult = await toolPromise;
  assert.match(toolResult, /atlas/, 'tool returns the submitted value');
  assert.equal(ui.pending().forms.length, 0, 'card cleared');

  // ---- coordinator tool: request_secret, answered cross-process ----
  const secretPromise = executeTool(
    'request_secret',
    { name: 'deploy_token', fields: ['token'], label: 'Deploy token', timeout_seconds: 10 },
    tmp, 'sess-tool', { permissive: true },
  );
  pending = [];
  for (let i = 0; i < 40; i += 1) {
    pending = ui.pending().forms;
    if (pending.length) break;
    await sleep(50);
  }
  assert.equal(pending.length, 1, 'secret card queued');
  assert.equal(pending[0].fields[0].type, 'password', 'secret field is masked');
  await submitFromChild(pending[0].id, { token: 'tok_live_123' });
  const secretResult = await secretPromise;
  assert.match(secretResult, /\{\{secret:deploy_token\.token\}\}/, 'returns a reference');
  assert.doesNotMatch(secretResult, /tok_live_123/, 'never echoes the secret');
  const stored = secretsService.get?.('deploy_token') ?? null;
  const listed = secretsService.list().find((s) => s.name === 'deploy_token');
  assert.ok(listed, 'secret stored in the vault');
  assert.equal(stored.fields.token, 'tok_live_123', 'stored value is exact');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('interactions test: ALL OK');
})().catch((error) => { console.error(error); process.exit(1); });
