'use strict';
/* Broadcast & roster test — Grok broadcastToAgents / getServerAgentRoster, local:
 * fan one message to many sessions concurrently (self-contained recipients),
 * concurrency cap, error isolation, roster snapshot, and compat routing.
 * Electron-free (injected runner). */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-bcast-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const bcast = require('../src/main/services/broadcastService').broadcastService;
const { broadcastService } = require('../src/main/services/broadcastService');

(async () => {
  // injected runner: records (sessionId, message); tracks max in-flight
  let inFlight = 0; let maxInFlight = 0;
  const calls = [];
  broadcastService.setRunner(async (sessionId, message) => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push([sessionId, message]);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return `done for ${sessionId}`;
  });

  // 1. explicit session ids: each gets its own self-contained message
  const r1 = await broadcastService.broadcast({ message: 'ping all', sessionIds: ['a1', 'a2', 'a3'] });
  assert.strictEqual(r1.recipients, 3);
  assert.strictEqual(r1.ok, 3);
  assert.strictEqual(r1.errored, 0);
  assert.deepStrictEqual(calls.map((c) => c[1]), ['ping all', 'ping all', 'ping all'], 'each recipient gets the message');
  assert.strictEqual(new Set(calls.map((c) => c[0])).size, 3, 'one run per session');
  assert.ok(maxInFlight <= 8, 'respects the concurrency cap');
  assert.ok(maxInFlight >= 2, 'runs concurrently');
  assert.ok(r1.results.every((x) => x.status === 'ok'), 'well-formed per-session results');

  // 2. count: create N fresh sessions and broadcast to them
  const before = calls.length;
  const r2 = await broadcastService.broadcast({ message: 'wake up', count: 4 });
  assert.strictEqual(r2.recipients, 4);
  assert.strictEqual(calls.length - before, 4, 'ran once per generated session');

  // 3. session ids + extra agents combined + deduped
  const r3 = await broadcastService.broadcast({ message: 'combo', sessionIds: ['a1', 'a1'], agents: [{ id: 'a1' }, 'a9'] });
  assert.deepStrictEqual(r3.results.map((x) => x.sessionId).sort(), ['a1', 'a9'], 'deduped recipients');

  // 4. error isolation: a failing recipient doesn't sink the others
  broadcastService.setRunner(async (sid) => { if (sid === 'boom') throw new Error('provider 500'); return 'ok'; });
  const r4 = await broadcastService.broadcast({ message: 'm', sessionIds: ['boom', 'ok1', 'ok2'] });
  assert.strictEqual(r4.ok, 2); assert.strictEqual(r4.errored, 1);
  const boom = r4.results.find((x) => x.sessionId === 'boom');
  assert.strictEqual(boom.status, 'error'); assert.match(boom.error, /provider 500/);

  // 5. invalid input
  await assert.rejects(() => broadcastService.broadcast({ message: '' }), /needs a message/);
  await assert.rejects(() => broadcastService.broadcast({ message: 'x' }), /sessionIds, agents, or count/);

  // 6. roster snapshot lists sessions
  const roster = broadcastService.roster();
  assert.ok(Array.isArray(roster.agents)); assert.ok(roster.generatedAt > 0);

  // 7. through the Grok compatibility surface
  const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
  let env = await grokCompatService.dispatch('broadcastToAgents', { message: 'hi team', sessionIds: ['z1', 'z2'] });
  assert.strictEqual(env.status, 'ok'); assert.strictEqual(env.recipients, 2); assert.strictEqual(env.ok, 2);
  env = await grokCompatService.dispatch('getServerAgentRoster', {});
  assert.strictEqual(env.status, 'ok'); assert.ok(Array.isArray(env.agents));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('broadcast test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
