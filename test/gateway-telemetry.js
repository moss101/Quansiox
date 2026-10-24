'use strict';
/* Gateway control plane + local telemetry/feedback sinks — pause/offline
 * gating with control-method reachability, reconnect, sand-box path
 * resolution, timezone override, feedback JSONL, telemetry → diagnostics,
 * prompt acceptance status and transcript tail. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-gateway-telemetry-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { settingsService } = require('../src/main/services/settingsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { gatewayStateService } = require('../src/main/services/gatewayStateService');
const { feedbackService } = require('../src/main/services/feedbackService');
const { diagnosticsService } = require('../src/main/services/diagnosticsService');
const { agentService } = require('../src/main/services/agentService');

(async () => {
  gatewayStateService.resetForTests();
  settingsService.save({ workspaceRoot: tmp });

  // 1. baseline dispatch works and is counted
  const before = gatewayStateService.status().dispatches;
  const trays = await grokCompatService.dispatch('getTrays', {});
  assert.strictEqual(trays.status, 'ok');
  assert.strictEqual(gatewayStateService.status().dispatches, before + 1);
  assert.strictEqual(gatewayStateService.status().lastDispatchMethod, 'getTrays');

  // 2. paused: non-control methods are refused, control methods stay reachable
  const paused = await grokCompatService.dispatch('setGatewayPaused', { paused: true });
  assert.strictEqual(paused.status, 'ok');
  assert.strictEqual(paused.paused, true);
  const blocked = await grokCompatService.dispatch('getTrays', {});
  assert.strictEqual(blocked.status, 'unavailable');
  assert.strictEqual(blocked.scope, 'gateway');
  assert.match(blocked.reason, /paused/);
  const stillAlive = await grokCompatService.dispatch('getTimeZone', {});
  assert.strictEqual(stillAlive.status, 'ok', 'control methods reachable while paused');
  const blockedTelemetry = await grokCompatService.dispatch('reportSendAck', { n: 1 });
  assert.strictEqual(blockedTelemetry.status, 'unavailable', 'stub and telemetry paths gated too');

  // 3. reconnect clears pause
  const reconnected = await grokCompatService.dispatch('forceReconnectGateway', {});
  assert.strictEqual(reconnected.status, 'ok');
  assert.strictEqual(reconnected.reconnected, true);
  assert.strictEqual(reconnected.wasPaused, true);
  assert.strictEqual((await grokCompatService.dispatch('getTrays', {})).status, 'ok');

  // 4. dev-induced offline behaves the same and only clears via control path
  await grokCompatService.dispatch('setDevGatewayOffline', { induced: true });
  const offline = await grokCompatService.dispatch('getTrays', {});
  assert.strictEqual(offline.status, 'unavailable');
  assert.match(offline.reason, /dev-induced/);
  const cleared = await grokCompatService.dispatch('setDevGatewayOffline', { induced: false });
  assert.strictEqual(cleared.induced, false);
  assert.strictEqual((await grokCompatService.dispatch('getTrays', {})).status, 'ok');

  // 5. resolveGatewayConnection resolves sand-box-ish paths against the workspace
  fs.writeFileSync(path.join(tmp, 'box.txt'), 'x');
  const resolved = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'box.txt' });
  assert.strictEqual(resolved.status, 'ok');
  assert.strictEqual(resolved.path, path.join(tmp, 'box.txt'));
  assert.strictEqual(resolved.kind, 'file');
  assert.strictEqual(resolved.exists, true);
  const missing = await grokCompatService.dispatch('resolveGatewayConnection', { path: 'nope/none.bin' });
  assert.strictEqual(missing.exists, false);
  assert.strictEqual(missing.kind, 'missing');
  const noPath = await grokCompatService.dispatch('resolveGatewayConnection', {});
  assert.strictEqual(noPath.status, 'error');

  // 6. timezone override: validated, reported, cleared
  const badTz = await grokCompatService.dispatch('setTimeZoneOverride', { timeZone: 'Not/AZone' });
  assert.strictEqual(badTz.status, 'error');
  const setTz = await grokCompatService.dispatch('setTimeZoneOverride', { timeZone: 'America/New_York' });
  assert.strictEqual(setTz.overridden, true);
  const tz = await grokCompatService.dispatch('getTimeZone', {});
  assert.strictEqual(tz.timeZone, 'America/New_York');
  assert.strictEqual(tz.overridden, true);
  await grokCompatService.dispatch('setTimeZoneOverride', { timeZone: null });
  const sysTz = await grokCompatService.dispatch('getTimeZone', {});
  assert.strictEqual(sysTz.overridden, false);
  assert.ok(sysTz.timeZone.length > 0);

  // 7. feedback JSONL: real append + readback, size guard
  const fb = await grokCompatService.dispatch('submitFeedback', { message: 'love the panel', rating: 5 });
  assert.strictEqual(fb.status, 'ok');
  assert.match(fb.id, /^fb_/);
  const vote = await grokCompatService.dispatch('voteFeedback', { vote: 'up', context: 'onboarding' });
  assert.strictEqual(vote.kind, 'vote');
  const rows = feedbackService.list({ limit: 10 });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].payload.message, 'love the panel');
  assert.strictEqual(rows[1].payload.vote, 'up');
  assert.strictEqual(fs.statSync(path.join(tmp, 'feedback.jsonl')).mode & 0o777, 0o600);
  feedbackService.append('feedback', { big: 'x'.repeat(20000) });
  const capped = feedbackService.list({ limit: 10 }).at(-1);
  assert.ok(capped.payload.big.length <= 4000, 'payload strings capped');

  // 8. telemetry → diagnostics (kind: telemetry, method recorded)
  const tel = await grokCompatService.dispatch('reportSendLatency', { ms: 42, transport: 'ws' });
  assert.strictEqual(tel.status, 'ok');
  assert.strictEqual(tel.recorded, true);
  await grokCompatService.dispatch('noteBoxIntent', { boxFoundAsleep: true });
  const events = diagnosticsService.list({ kind: 'telemetry', limit: 20 });
  const methods = events.map((e) => e.detail?.method);
  assert.ok(methods.includes('reportSendLatency'));
  assert.ok(methods.includes('noteBoxIntent'));
  const latencyEvent = events.find((e) => e.detail?.method === 'reportSendLatency');
  assert.strictEqual(latencyEvent.detail.args.ms, 42);

  // 9. prompt acceptance reflects a real running agent
  agentService._testSetRunning('sess-run', true);
  const accepted = await grokCompatService.dispatch('promptAcceptanceStatus', { sessionId: 'sess-run' });
  assert.strictEqual(accepted.accepted, true);
  assert.strictEqual(accepted.running, true);
  agentService._testSetRunning('sess-run', false);
  const notAccepted = await grokCompatService.dispatch('promptAcceptanceStatus', { sessionId: 'sess-run' });
  assert.strictEqual(notAccepted.accepted, false);
  const noSession = await grokCompatService.dispatch('promptAcceptanceStatus', {});
  assert.strictEqual(noSession.status, 'error');

  // 10. transcript store tail reads back a real (empty) session store
  const tailRes = await grokCompatService.dispatch('readTranscriptStoreTail', { sessionId: 'sess-run', limit: 5 });
  assert.strictEqual(tailRes.status, 'ok');
  assert.deepStrictEqual(tailRes.rows, []);
  assert.strictEqual(tailRes.sessionId, 'sess-run');

  console.log('gateway-telemetry test: ALL OK (gate/pause/offline/timezone/feedback/telemetry/tail)');
})().catch((e) => { console.error(e); process.exit(1); });
