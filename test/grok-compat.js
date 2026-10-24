'use strict';
/* Grok compatibility surface test — asserts the full Grok surface
 * (280 desktop methods + 133 coordinator commands; Cursor cluster removed → 356 unique) is
 * reachable and every method returns a well-formed envelope; local handlers
 * route to real behavior, stubs fail closed with a scope. Electron-free. */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-grok-compat-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { REGISTRY } = require('../src/main/services/grokCompat/catalog');
const { HANDLERS } = require('../src/main/services/grokCompat/handlers');

(async () => {
  // 1. Unique surface (Cursor-account/sand/finance/spend/usage removed — quansiox
  //    replaces Cursor); no dupes; side buckets reconcile.
  const both = REGISTRY.filter((r) => r.side === 'both').length;
  const desktopOnly = REGISTRY.filter((r) => r.side === 'desktop').length;
  const coordOnly = REGISTRY.filter((r) => r.side === 'coordinator').length;
  assert.strictEqual(REGISTRY.length, 556, 'unique methods after the Batch 17 deep-dig surface delta');
  assert.strictEqual(new Set(REGISTRY.map((r) => r.method)).size, 556, 'no duplicate method names');
  assert.strictEqual(desktopOnly + coordOnly + both, 556, 'side buckets reconcile');
  // representative in-scope names are present
  for (const m of ['sendPrompt', 'getSubagents', 'submitSecret', 'getVoiceCall', 'startTeachRecording', 'getMcpCatalog', 'createAgentAutomation', 'listLibraryDocs', 'importChromeCookies', 'listGrokBotUserBotMemories', 'getUpdateStatus', 'listPublicBotMarketplace']) {
    assert.ok(REGISTRY.some((r) => r.method === m), `missing ${m}`);
  }
  // Batch 17: the deep-dig re-extraction of 0.71.2 showed the Cursor-account
  // cluster is part of the real desktop catalog — it is now admitted as
  // fail-closed stubs (scope cursor/account) rather than dropped.
  for (const m of ['loginCursor', 'listCursorAccounts', 'getCursorAuthStatus', 'getCursorUsageSummary', 'setCursorSpendLimit']) {
    const r = REGISTRY.find((x) => x.method === m);
    assert.ok(r, `Cursor method should be present (stub): ${m}`);
    assert.strictEqual(r.impl, 'stub');
    assert.strictEqual(r.scope, 'cursor/account');
  }
  // every local entry references an implemented handler
  for (const r of REGISTRY) {
    if (r.impl === 'local') assert.ok(typeof HANDLERS[r.handler] === 'function', `local ${r.method} has handler ${r.handler}`);
    else assert.ok(r.scope, `stub ${r.method} has a scope`);
  }

  // 2. Every method returns a well-formed envelope (never throws)
  const envelopes = await Promise.all(REGISTRY.map((r) => grokCompatService.dispatch(r.method, {})));
  for (const [i, env] of envelopes.entries()) {
    assert.ok(env && typeof env === 'object', `envelope for ${REGISTRY[i].method}`);
    assert.ok(env.method, 'envelope carries method');
    if (REGISTRY[i].impl === 'local') {
      assert.ok(['ok', 'error'].includes(env.status), `local ${REGISTRY[i].method} → ok|error, got ${env.status}`);
    } else {
      assert.strictEqual(env.status, 'unavailable', `stub ${REGISTRY[i].method} must fail closed`);
      assert.ok(env.scope && env.reason, `stub ${REGISTRY[i].method} carries scope+reason`);
    }
  }

  // 3. unknown method
  assert.strictEqual((await grokCompatService.dispatch('totallyMadeUp', {})).status, 'not_found');

  // 4. Local handlers actually do real work through the dispatcher
  // secrets: set → list (reduced) → status → resolve, end to end
  let env = await grokCompatService.dispatch('submitSecret', { name: 'tok', fields: { value: 'S3CR3T' } });
  assert.strictEqual(env.status, 'ok'); assert.deepStrictEqual(env.secret.fields, ['value']);
  env = await grokCompatService.dispatch('listSecrets', {});
  assert.strictEqual(env.status, 'ok'); assert.ok(!JSON.stringify(env).includes('S3CR3T'), 'list must not leak the value');
  env = await grokCompatService.dispatch('getBoxSecretsStatus', {});
  assert.strictEqual(env.status, 'ok'); assert.strictEqual(env.result?.count ?? env.count, 1);

  // settings round-trips
  env = await grokCompatService.dispatch('setMcpCustomInstructions', { instructions: 'be terse' });
  assert.strictEqual(env.status, 'ok'); assert.strictEqual(env.result?.systemPromptExtra ?? env.systemPromptExtra, 'be terse');

  // host status is real + local
  env = await grokCompatService.dispatch('getHostStatus', {});
  assert.strictEqual(env.status, 'ok'); assert.strictEqual(env.local, true); assert.ok('sandboxMode' in env);

  // mcp list (empty) is well-formed
  env = await grokCompatService.dispatch('getMcpCatalog', {});
  assert.strictEqual(env.status, 'ok'); assert.ok(Array.isArray(env.servers));

  // cloud-background surfaces fail closed (not Cursor — that cluster is replaced/removed)
  assert.strictEqual((await grokCompatService.dispatch('ensureForeverBox', {})).scope, 'cloud');
  assert.strictEqual((await grokCompatService.dispatch('connectChannel', {})).status, 'unavailable');
  // the voice call is a REAL local feature now (a local voice session), so
  // it answers instead of failing closed
  const voice = await grokCompatService.dispatch('getVoiceCall', {});
  assert.strictEqual(voice.status, 'error');
  assert.ok(voice.reason.includes('unknown voice call'));

  // P0.5 — the four 0.75.0 methods, all local:
  // approvals.beginSpendApproval opens a pending card request that
  // resolveVirtualCardApproval settles; re-beginning reports the resolution.
  env = await grokCompatService.dispatch('beginSpendApproval', { entryId: 'entry-1', agentId: 'agent-1', requestId: 'spend-1' });
  assert.strictEqual(env.status, 'ok');
  assert.strictEqual(env.state, 'open');
  env = await grokCompatService.dispatch('resolveVirtualCardApproval', { requestId: 'spend-1', resolution: 'approved' });
  assert.strictEqual(env.resolved, true);
  env = await grokCompatService.dispatch('beginSpendApproval', { entryId: 'entry-1', agentId: 'agent-1', requestId: 'spend-1' });
  assert.strictEqual(env.state, 'approved');
  // approvals.listVirtualCardPaymentMethods — local honest empty roster
  env = await grokCompatService.dispatch('listVirtualCardPaymentMethods', {});
  assert.strictEqual(env.status, 'ok');
  assert.deepEqual(env.paymentMethods, []);
  assert.strictEqual(env.needsAuth, false);
  // send.createThreadFromMessage — forks a thread seeded from an entry
  const seedId = `t${Date.now().toString(36)}`;
  const { sessionService } = require('../src/main/services/sessionService');
  sessionService.create({ id: seedId, title: 'Source' });
  sessionService.appendTurn(seedId, { id: 'msg_fork_me', role: 'user', content: 'fork me' });
  env = await grokCompatService.dispatch('createThreadFromMessage', { agentId: seedId, entryId: 'msg_fork_me' });
  assert.strictEqual(env.status, 'ok');
  const forkedId = env.sessionId;
  assert.ok(forkedId && forkedId !== seedId, 'the fork gets a fresh session id');
  assert.strictEqual(env.seededEntryId, 'msg_fork_me');
  const fork = sessionService.get(forkedId);
  assert.ok(fork.turns.some((t) => t.id === 'msg_fork_me'), 'the fork carries the seeded entry');
  sessionService.remove(forkedId);
  env = await grokCompatService.dispatch('createThreadFromMessage', { agentId: seedId, entryId: 'msg_missing' });
  assert.strictEqual(env.status, 'error');
  sessionService.remove(seedId);
  // roster.dismissAgentSuggestions — ledger persists locally
  env = await grokCompatService.dispatch('dismissAgentSuggestions', { agentId: 'agent-roster-1', suggestionIds: ['s1', 's2'], reason: 'hidden' });
  assert.strictEqual(env.status, 'ok');
  assert.strictEqual(env.ledgerSize, 2);
  env = await grokCompatService.dispatch('dismissAgentSuggestions', { agentId: 'agent-roster-1', suggestionIds: 's3', reason: 'acted' });
  assert.strictEqual(env.status, 'ok');
  env = await grokCompatService.dispatch('dismissAgentSuggestions', { agentId: 'agent-roster-1', suggestionIds: ['s4'], reason: 'nonsense' });
  assert.strictEqual(env.status, 'error');
  // roster.dismissAgentSuggestions — ledger persists locally
  env = await grokCompatService.dispatch('dismissAgentSuggestions', { agentId: seedId, suggestionIds: ['s1', 's2'], reason: 'hidden' });
  assert.strictEqual(env.status, 'ok');
  assert.strictEqual(env.ledgerSize, 2);
  env = await grokCompatService.dispatch('dismissAgentSuggestions', { agentId: seedId, suggestionIds: 's3', reason: 'acted' });
  assert.strictEqual(env.status, 'ok');
  env = await grokCompatService.dispatch('dismissAgentSuggestions', { agentId: seedId, suggestionIds: ['s4'], reason: 'nonsense' });
  assert.strictEqual(env.status, 'error');

  // 5. catalog reports the honest split
  const cat = grokCompatService.catalog();
  assert.strictEqual(cat.total, 556);
  assert.ok(cat.local >= 50, `expected a substantial local set, got ${cat.local}`);
  assert.strictEqual(cat.local + cat.stub, 556);

  // The surface sweep starts a turn (and with it a sandbox and an exec
  // daemon) — stop them so the test leaves nothing behind.
  try {
    const { sandboxService } = require('../src/main/services/sandboxService');
    for (const entry of sandboxService.status?.() ?? []) {
      try { sandboxService.stop(entry.sessionId); } catch {}
    }
  } catch {}
  try { require('../src/main/services/execDaemonService').execDaemonService.stopLocalExecDaemon(); } catch {}

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`grok-compat test: ALL OK  (556 unique methods post-0.75.0; local=${cat.local} stub=${cat.stub})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
