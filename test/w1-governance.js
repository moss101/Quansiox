'use strict';
/* W1 — governance.
 *
 * The permission model used to be inert: the coordinator built
 * `{ permissive: true }` unless a third-party TYPESAFE_API_KEY happened to be
 * in the environment, and `guardToolCore` returned "allow" for a permissive
 * policy. These tests pin the fixed behaviour.
 *
 *  W1.1  the policy is always on, with no key and no configuration
 *  W1.2  the mode ladder (read-only → workspace → computer)
 *  W1.3  the per-tool permission matrix
 *  W1.4  standing grants, bound to a target, with an expiry
 *  W1.5  the model-based safety reviewer
 *  W1.6  auto-review is consulted even when interactive approval is off
 *  W1.7  the denial catalogue is actionable and says "do not retry"
 *  W1.8  approval requests are structured
 *  W1.9  every failure path fails closed
 *  W1.11 every decision is recorded in the governance log
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-w1-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;
delete process.env.TYPESAFE_API_KEY;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const policyEngine = require('../src/shared/policy');
const governance = require('../src/coordinator/governance');
const denialMessages = require('../src/coordinator/denialMessages');
const autoReview = require('../src/coordinator/autoReviewClassifier');
const { toolPermissionsService } = require('../src/main/services/toolPermissionsService');
const { standingGrantsService } = require('../src/main/services/standingGrantsService');
const { settingsService } = require('../src/main/services/settingsService');

(async () => {
  /* ---------------------------------------------------------------- W1.1 */
  await test('W1.1 a policy is always present — permissive no longer disables the gates', () => {
    const policy = policyEngine.defaultPolicy({ mode: 'read-only' });
    assert.notEqual(policy.permissive, true);
    const verdict = policyEngine.decide({ policy, tool: 'write_file', args: { path: 'x', content: 'y' } });
    assert.equal(verdict.decision, policyEngine.DENY);
    // Even a policy that calls itself permissive must not bypass the mode.
    const permissive = policyEngine.defaultPolicy({ mode: 'read-only', permissive: true });
    const verdict2 = policyEngine.decide({ policy: permissive, tool: 'write_file', args: { path: 'x' } });
    assert.equal(verdict2.decision, policyEngine.DENY, 'permissive must not bypass the mode');
  });

  await test('W1.1 the classifier may only NARROW the policy', () => {
    const base = { mode: 'workspace' };
    // A classifier that asks for computer mode cannot raise a workspace turn.
    const widened = governance.effectivePolicy({
      base,
      classifier: { permissive: false, permissionMode: 'computer', route: 'computer' },
    });
    assert.equal(widened.mode, 'workspace', 'the classifier must not widen the mode');
    // A classifier that asks for read-only can narrow it.
    const narrowed = governance.effectivePolicy({
      base,
      classifier: { permissive: false, permissionMode: 'read-only', route: 'files_shell' },
    });
    assert.equal(narrowed.mode, 'read-only');
    // A permissive classifier changes nothing.
    const unchanged = governance.effectivePolicy({ base, classifier: { permissive: true } });
    assert.equal(unchanged.mode, 'workspace');
    assert.equal(unchanged.permissive, false, 'the effective policy is never permissive');
  });

  await test('W1.1 the configured mode is applied with no key and no configuration', () => {
    const base = governance.basePolicyFromSettings({ permissionMode: 'read-only' });
    assert.equal(base.mode, 'read-only');
    const policy = governance.effectivePolicy({ base });
    assert.equal(policyEngine.decide({ policy, tool: 'write_file', args: {} }).decision, policyEngine.DENY);
  });

  /* ---------------------------------------------------------------- W1.2 */
  await test('W1.2 the mode ladder: read-only → workspace → computer', () => {
    // The engine cannot tell a read-only command from a mutating one on its
    // own; the shell analyser is injected and the engine fails closed
    // without it.
    const { shellMutates } = require('../src/coordinator/permissions');
    const readOnly = policyEngine.defaultPolicy({ mode: 'read-only', shellMutates });
    const workspace = policyEngine.defaultPolicy({ mode: 'workspace', shellMutates });
    const computer = policyEngine.defaultPolicy({ mode: 'computer', shellMutates });

    // read-only: nothing changes
    assert.equal(policyEngine.decide({ policy: readOnly, tool: 'write_file', args: {} }).decision, policyEngine.DENY);
    assert.equal(policyEngine.decide({ policy: readOnly, tool: 'shell', args: { command: 'rm -rf /' } }).decision, policyEngine.DENY);
    assert.equal(policyEngine.decide({ policy: readOnly, tool: 'read_file', args: {} }).decision, policyEngine.ALLOW);
    // a read-only shell command is fine in read-only mode
    assert.equal(policyEngine.decide({ policy: readOnly, tool: 'shell', args: { command: 'ls' } }).decision, policyEngine.ALLOW);
    // computer tools need computer mode
    assert.equal(policyEngine.decide({ policy: readOnly, tool: 'computer_click', args: {} }).decision, policyEngine.DENY);
    assert.equal(policyEngine.decide({ policy: workspace, tool: 'computer_click', args: {} }).decision, policyEngine.DENY);
    assert.equal(policyEngine.decide({ policy: computer, tool: 'computer_click', args: {} }).decision, policyEngine.ALLOW);
    // looking at the screen is gated like driving it
    assert.equal(policyEngine.decide({ policy: workspace, tool: 'computer_screenshot', args: {} }).decision, policyEngine.DENY);
    assert.equal(policyEngine.decide({ policy: computer, tool: 'computer_screenshot', args: {} }).decision, policyEngine.ALLOW);
  });

  await test('W1.2 outward-facing actions always ask', () => {
    const { shellMutates } = require('../src/coordinator/permissions');
    const workspace = policyEngine.defaultPolicy({ mode: 'workspace', shellMutates });
    for (const tool of ['email_send', 'slack_post_message', 'messages_send', 'github_pr_create']) {
      const verdict = policyEngine.decide({ policy: workspace, tool, args: {} });
      assert.equal(verdict.decision, policyEngine.ASK, `${tool} must ask`);
    }
    const computer = policyEngine.defaultPolicy({ mode: 'computer' });
    assert.equal(policyEngine.decide({ policy: computer, tool: 'email_send', args: {} }).decision, policyEngine.ASK);
  });

  /* ---------------------------------------------------------------- W1.3 */
  await test('W1.3 the tool matrix stores, applies and persists (0600)', () => {
    const set = toolPermissionsService.setTool({ tool: 'shell', level: 'blocked' });
    assert.equal(set.matrix.tools.shell, 'blocked');

    const policy = policyEngine.defaultPolicy({ mode: 'workspace', matrix: set.matrix });
    assert.equal(policyEngine.decide({ policy, tool: 'shell', args: { command: 'ls' } }).decision, policyEngine.DENY);

    // A per-tool block beats a standing approval.
    const withGrant = policyEngine.decide({ policy, tool: 'shell', args: { command: 'ls' }, consent: 'allow' });
    assert.equal(withGrant.decision, policyEngine.DENY, 'an explicit block must beat a standing grant');

    // 0600 at rest
    const file = path.join(tmp, 'tool-permissions.json');
    assert.ok(fs.existsSync(file));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the matrix file must be 0600');

    toolPermissionsService.clear({ scope: 'global' });
    assert.equal(toolPermissionsService.get({ scope: 'global' }).matrix.tools.shell, undefined);
  });

  await test('W1.3 an invalid level is rejected', () => {
    assert.throws(() => toolPermissionsService.setTool({ tool: 'shell', level: 'maybe' }), /invalid level/);
  });

  /* ---------------------------------------------------------------- W1.4 */
  await test('W1.4 standing grants are bound to the action AND the target', () => {
    standingGrantsService.add({ scope: 'action', action: 'shell', target: 'git status' });
    assert.equal(standingGrantsService.has({ scope: 'action', action: 'shell', target: 'git status' }), true);
    // A different target is NOT covered — "always allow git status" must not
    // become "always allow shell".
    assert.equal(standingGrantsService.has({ scope: 'action', action: 'shell', target: 'rm -rf /' }), false);
    // A different action is not covered either.
    assert.equal(standingGrantsService.has({ scope: 'action', action: 'write_file', target: 'git status' }), false);

    // Re-granting refreshes rather than duplicating.
    standingGrantsService.add({ scope: 'action', action: 'shell', target: 'git status' });
    assert.equal(standingGrantsService.list().grants.length, 1);

    // Revoking works.
    const grant = standingGrantsService.list().grants[0];
    standingGrantsService.revoke({ id: grant.id });
    assert.equal(standingGrantsService.has({ scope: 'action', action: 'shell', target: 'git status' }), false);
  });

  await test('W1.4 a grant carries an expiry and an expired grant does not cover', () => {
    const grant = standingGrantsService.add({ scope: 'action', action: 'shell', target: 'echo hi', ttlMs: 1000 });
    assert.ok(grant.expiresAtMs > grant.grantedAtMs);
    // Force it into the past.
    const file = path.join(tmp, 'tool-standing-grants.json');
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    store.grants = store.grants.map((g) => ({ ...g, expiresAtMs: Date.now() - 1 }));
    fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
    assert.equal(standingGrantsService.has({ scope: 'action', action: 'shell', target: 'echo hi' }), false);
  });

  await test('W1.4 the grant file is 0600', () => {
    const file = path.join(tmp, 'tool-standing-grants.json');
    assert.ok(fs.existsSync(file));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  /* ---------------------------------------------------------------- W1.5 */
  await test('W1.5 the model reviewer returns a structured decision', async () => {
    const complete = async () => JSON.stringify({
      decision: 'deny',
      reason: 'the block instruction covers this',
      proposedAllowRule: null,
    });
    const verdict = await autoReview.reviewWithModel({
      action: { tool: 'shell', arguments: { command: 'rm -rf /' } },
      rules: { allowInstructions: [], blockInstructions: ['never delete'] },
      complete,
    });
    assert.equal(verdict.decision, 'deny');
    assert.match(verdict.reason, /block instruction/);
  });

  await test('W1.5 an unusable reviewer answer degrades to ASK, never to allow', async () => {
    for (const answer of ['', 'not json at all', '{"decision":"maybe"}', '{}']) {
      const verdict = await autoReview.reviewWithModel({
        action: { tool: 'shell', arguments: { command: 'ls' } },
        complete: async () => answer,
      });
      assert.equal(verdict.decision, 'ask', `answer ${JSON.stringify(answer)} must degrade to ask`);
    }
  });

  await test('W1.5 an unreachable reviewer degrades to ASK', async () => {
    const verdict = await autoReview.reviewWithModel({
      action: { tool: 'shell', arguments: {} },
      complete: async () => { throw new Error('provider is down'); },
    });
    assert.equal(verdict.decision, 'ask');
  });

  await test('W1.5 the deterministic rules beat the model, and block beats allow', () => {
    const verdict = autoReview.applyRules(
      { allowInstructions: ['git status'], blockInstructions: ['git push'] },
      'run git push origin main',
    );
    assert.equal(verdict.decision, 'deny', 'a block rule must beat an allow rule');
    assert.equal(autoReview.applyRules({ allowInstructions: ['git status'] }, 'run git status').decision, 'allow');
    // An invalid regex is inert, not fatal.
    assert.equal(autoReview.applyRules({ allowInstructions: ['/[unclosed/'] }, 'anything').decision, 'ask');
  });

  /* ---------------------------------------------------------------- W1.6 */
  await test('W1.6 auto-review blocks even when the matrix would allow the action', async () => {
    const policy = policyEngine.defaultPolicy({ mode: 'workspace' });
    const verdict = await governance.governToolCall({
      name: 'shell',
      args: { command: 'echo hello' },
      policy,
      settings: { messagesEnabled: true },
      rules: { isEnabled: true, allowInstructions: [], blockInstructions: ['echo'] },
      requestConfirm: async () => true, // the human WOULD have said yes
    });
    assert.equal(verdict.allowed, false, 'the block rule must win over the human');
    assert.equal(verdict.gate, 'auto-review-rule');
    assert.match(verdict.refusal, /auto-review rule/);
  });

  await test('W1.6 an allow rule skips the prompt', async () => {
    const policy = policyEngine.defaultPolicy({ mode: 'workspace' });
    let asked = false;
    const verdict = await governance.governToolCall({
      name: 'shell',
      args: { command: 'echo hello' },
      policy,
      settings: { messagesEnabled: true },
      rules: { isEnabled: true, allowInstructions: ['echo hello'], blockInstructions: [] },
      requestConfirm: async () => { asked = true; return false; },
    });
    assert.equal(verdict.allowed, true);
    assert.equal(asked, false, 'an allow rule must skip the human');
  });

  await test('W1.6 rules are inert when the user has not switched them on', async () => {
    const policy = policyEngine.defaultPolicy({ mode: 'workspace' });
    const verdict = await governance.governToolCall({
      name: 'shell',
      args: { command: 'echo hello' },
      policy,
      settings: { messagesEnabled: true },
      rules: { isEnabled: false, allowInstructions: [], blockInstructions: ['echo'] },
      requestConfirm: async () => true,
    });
    assert.equal(verdict.allowed, true, 'a disabled rule set must not block');
  });

  /* ---------------------------------------------------------------- W1.7 */
  await test('W1.7 every denial says what happened, that it must not be retried, and what to do instead', () => {
    for (const reason of Object.values(denialMessages.REASON)) {
      const d = denialMessages.denial(reason, { tool: 'shell' });
      assert.ok(d.text.length > 40, `${reason}: the refusal must be more than a token`);
      assert.match(d.text, /refused/, `${reason}: must be marked as a refusal`);
      assert.ok(d.alternatives.length > 0, `${reason}: must name an alternative`);
      assert.ok(d.userAction.length > 0, `${reason}: must say what the user could change`);
      assert.equal(d.doNotRetry, true, `${reason}: must carry the do-not-retry directive`);
    }
  });

  await test('W1.7 a refusal reaches the model with the do-not-retry directive', async () => {
    const policy = policyEngine.defaultPolicy({ mode: 'read-only' });
    const verdict = await governance.governToolCall({
      name: 'write_file',
      args: { path: 'x', content: 'y' },
      policy,
      settings: { messagesEnabled: true },
      requestConfirm: async () => true,
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.refusal, /Do not retry/);
    assert.match(verdict.refusal, /permission mode/);
  });

  /* ---------------------------------------------------------------- W1.8 */
  await test('W1.8 the approval request is structured and its preview is redacted', async () => {
    const policy = policyEngine.defaultPolicy({ mode: 'workspace' });
    let seen = null;
    await governance.governToolCall({
      name: 'email_send',
      args: { to: 'a@b.c', subject: 'hi', body: 'x', password: 'hunter2', api_key: 'sk-secret' },
      policy,
      settings: { messagesEnabled: true },
      requestConfirm: async (request) => { seen = request; return false; },
    });
    assert.ok(seen, 'the human must receive a request');
    assert.equal(seen.tool, 'email_send');
    assert.equal(seen.target, 'a@b.c');
    assert.equal(seen.targetKind, 'outbound');
    assert.ok(seen.expiresAtMs > Date.now());
    // Secrets never appear in the preview.
    assert.equal(seen.argsPreview.password, '•••');
    assert.equal(seen.argsPreview.api_key, '•••');
    assert.equal(seen.argsPreview.to, 'a@b.c');
  });

  await test('W1.8 the preview is capped', () => {
    const preview = governance.previewArgs({ big: 'x'.repeat(5000) });
    assert.ok(preview.big.length < 500, 'a huge argument must be truncated');
  });

  /* ---------------------------------------------------------------- W1.9 */
  await test('W1.9 with no approval channel the action is refused, not allowed', async () => {
    const policy = policyEngine.defaultPolicy({ mode: 'workspace' });
    const verdict = await governance.governToolCall({
      name: 'email_send',
      args: { to: 'a@b.c' },
      policy,
      settings: { messagesEnabled: true },
      // no requestConfirm at all
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.refusal, /refused/);
  });

  await test('W1.9 a denied approval is refused', async () => {
    const policy = policyEngine.defaultPolicy({ mode: 'workspace' });
    const verdict = await governance.governToolCall({
      name: 'email_send',
      args: { to: 'a@b.c' },
      policy,
      settings: { messagesEnabled: true },
      requestConfirm: async () => false,
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.refusal, /declined/);
  });

  await test('W1.9 a Messages send is refused when Messages is off, without asking', async () => {
    const policy = policyEngine.defaultPolicy({ mode: 'workspace' });
    let asked = false;
    const verdict = await governance.governToolCall({
      name: 'messages_send',
      args: { to: '+15551234567', text: 'hi' },
      policy,
      settings: { messagesEnabled: false },
      requestConfirm: async () => { asked = true; return true; },
    });
    assert.equal(verdict.allowed, false);
    assert.equal(asked, false, 'a tool that cannot work must not ask');
    assert.match(verdict.refusal, /Messages is disabled/);
  });

  /* --------------------------------------------------------------- W1.11 */
  await test('W1.11 every decision is recorded in the governance log', async () => {
    const policy = policyEngine.defaultPolicy({ mode: 'read-only' });
    await governance.governToolCall({
      name: 'write_file',
      args: { path: 'x' },
      policy,
      sessionId: 'gov-session',
      settings: { messagesEnabled: true },
      requestConfirm: async () => true,
    });
    await governance.governToolCall({
      name: 'read_file',
      args: { path: 'x' },
      policy,
      sessionId: 'gov-session',
      settings: { messagesEnabled: true },
      requestConfirm: async () => true,
    });
    const log = governance.governanceLog({ sessionId: 'gov-session' });
    assert.ok(log.entries.length >= 2, 'both decisions must be recorded');
    const last = log.entries[log.entries.length - 1];
    assert.equal(last.tool, 'read_file');
    assert.equal(last.decision, 'allow');
    assert.ok(last.gate, 'every decision must say which gate decided it');
    assert.ok(last.seq > 0, 'entries must be sequenced');
  });

  /* ---------------------------------------------------------------------- */
  // The mode and the computer switch must agree.
  await test('the computer switch implies the computer mode until a mode is chosen explicitly', () => {
    const saved = settingsService.load();
    // Turning on the computer switch alone (no mode in the same save) means
    // the user wants the agent to be able to drive the screen.
    settingsService.save({ allowComputerUse: true, permissionModeSet: false });
    assert.equal(settingsService.load().permissionMode, 'computer');
    // An explicit choice wins.
    settingsService.save({ permissionMode: 'read-only' });
    assert.equal(settingsService.load().permissionMode, 'read-only');
    settingsService.save({ permissionMode: 'workspace' });
    assert.equal(settingsService.load().permissionMode, 'workspace');
    settingsService.save({ allowComputerUse: saved.allowComputerUse, permissionMode: saved.permissionMode, permissionModeSet: saved.permissionModeSet });
  });

  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nW1 governance tests FAILED');
    process.exit(1);
  }
  console.log(`\nW1 governance: ${results.length} checks OK`);
})();
