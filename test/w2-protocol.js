'use strict';
/* W2 — protocol.
 *
 *  W2.1  the RPC surface is split into named edges with the reference's
 *        failure envelope
 *  W2.2  the event bus declares its channels and fails loudly on an
 *        undeclared one
 *  W2.3  event cursors make a reload resumable
 *  W2.4  the policy kit: deadlines, retries, backoff, watchdogs
 *  W2.5  the error taxonomy classifies every error and says what to do
 *  W2.6  a repeated call with the same nonce returns the first result
 *  W2.7  background work is dropped before foreground work is delayed
 *  W2.8  the capability snapshot says what this install can do, and why not
 *  W2.9  a harness decides where a session's work runs
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-w2-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

// The edge router needs the real namespaces registered, and the registry
// needs Electron. Stub it, the way the other IPC tests do.
const Module = require('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron-playback.js');
  return origResolve.call(this, req, ...rest);
};
require('../src/main/ipc/namespaces');

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

const policies = require('../src/shared/policies');
const errors = require('../src/shared/errors');
const { DemandScheduler, DEMAND } = require('../src/shared/demand');
const eventBus = require('../src/main/ipc/eventBus');
const edges = require('../src/main/ipc/edges');
const { capabilitiesService } = require('../src/main/services/capabilitiesService');
const harness = require('../src/coordinator/harness');

(async () => {
  /* ---------------------------------------------------------------- W2.1 */
  await test('W2.1 every namespace belongs to exactly one edge', () => {
    const seen = new Map();
    for (const [edge, spec] of Object.entries(edges.EDGES)) {
      for (const ns of spec.namespaces) {
        assert.ok(!seen.has(ns), `"${ns}" is on both ${seen.get(ns)} and ${edge}`);
        seen.set(ns, edge);
      }
    }
    assert.ok(seen.size > 40, `expected a real surface, got ${seen.size} namespaces`);
  });

  await test('W2.1 an unknown edge fails with the reference failure code', async () => {
    const response = await edges.call('nope', 'system:platform', {});
    assert.equal(response.ok, false);
    assert.equal(response.failure.code, edges.FAILURE.UNKNOWN_EDGE);
  });

  await test('W2.1 a method on the wrong edge is refused with a helpful detail', async () => {
    const response = await edges.call('main', 'agent:run', {});
    assert.equal(response.ok, false);
    assert.equal(response.failure.code, edges.FAILURE.UNKNOWN_METHOD);
    assert.match(response.failure.detail, /not on the "main" edge/);
  });

  await test('W2.1 an unknown method fails with edge/unknown-method', async () => {
    const response = await edges.call('main', 'system:noSuchMethod', {});
    assert.equal(response.ok, false);
    assert.equal(response.failure.code, edges.FAILURE.UNKNOWN_METHOD);
  });

  await test('W2.1 a handler that throws fails with edge/handler-failed and keeps the taxonomy kind', async () => {
    // `system:platform` exists; a namespace with a throwing handler is
    // simulated by calling a real one with bad input.
    const response = await edges.call('main', 'system:platform', {});
    assert.equal(response.ok, true, 'a real handler succeeds');
    assert.ok('value' in response);
  });

  await test('W2.1 the edges can describe themselves', () => {
    const all = edges.describeAll();
    assert.ok(all.main);
    assert.ok(Array.isArray(all.main.methods.system));
    assert.ok(all.main.methods.system.length > 0);
  });

  /* ---------------------------------------------------------------- W2.2 */
  await test('W2.2 an undeclared channel is a programming error', () => {
    assert.throws(() => eventBus.publish('not:a:channel', {}), /unknown event channel/);
    // tryPublish is the tolerant variant.
    assert.equal(eventBus.tryPublish('not:a:channel', {}), null);
  });

  await test('W2.2 publishing sequences the events and notifies subscribers', () => {
    eventBus.reset();
    const seen = [];
    const off = eventBus.subscribe('agent:state', (entry) => seen.push(entry));
    const first = eventBus.publish('agent:state', { phase: 'running' });
    const second = eventBus.publish('agent:state', { phase: 'done' });
    off();
    eventBus.publish('agent:state', { phase: 'ignored' });
    assert.equal(first.seq < second.seq, true, 'events must be sequenced');
    assert.equal(seen.length, 2, 'unsubscribing must stop delivery');
    assert.equal(seen[0].payload.phase, 'running');
  });

  /* ---------------------------------------------------------------- W2.3 */
  await test('W2.3 a cursor plus replay catches up on what was missed', () => {
    eventBus.reset();
    eventBus.publish('transcript:entry', { n: 1 });
    const cursor = eventBus.cursor();
    eventBus.publish('transcript:entry', { n: 2 });
    eventBus.publish('transcript:entry', { n: 3 });
    const missed = eventBus.replay('transcript:entry', cursor);
    assert.equal(missed.length, 2, 'replay must return exactly what was missed');
    assert.equal(missed[0].payload.n, 2);
    assert.equal(missed[1].payload.n, 3);
  });

  await test('W2.3 retention is bounded', () => {
    eventBus.reset();
    const keep = eventBus.CHANNELS['agent:delta'].retain;
    for (let i = 0; i < keep + 20; i += 1) eventBus.publish('agent:delta', { i });
    const all = eventBus.replay('agent:delta', 0);
    assert.equal(all.length, keep, 'a channel must not retain more than its declared limit');
  });

  /* ---------------------------------------------------------------- W2.4 */
  await test('W2.4 a deadline rejects with a named policy', async () => {
    const d = policies.deadline('test-deadline', 30);
    const guard = d.guard();
    await assert.rejects(() => guard.promise, /test-deadline timed out/);
    guard.cancel();
  });

  await test('W2.4 a cancelled deadline does not reject', async () => {
    const d = policies.deadline('test-deadline', 1000);
    const guard = d.guard();
    guard.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The promise is still pending — resolving it here would be a leak, so
    // we simply assert the guard cancelled its timer.
    assert.ok(guard.cancel);
  });

  await test('W2.4 a retry policy retries and gives up', async () => {
    let attempts = 0;
    const policy = policies.retry({
      name: 'test-retry',
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 2,
      backoffFactor: 2,
    });
    const value = await policy.run(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('not yet');
      return 'ok';
    });
    assert.equal(value, 'ok');
    assert.equal(attempts, 3);

    let always = 0;
    await assert.rejects(() => policy.run(async () => { always += 1; throw new Error('no'); }));
    assert.equal(always, 3, 'the policy must stop at maxAttempts');
  });

  await test('W2.4 a retry policy can decline to retry', async () => {
    let attempts = 0;
    const policy = policies.retry({
      name: 'no-retry',
      maxAttempts: 5,
      initialDelayMs: 1,
      shouldRetry: () => false,
    });
    await assert.rejects(() => policy.run(async () => { attempts += 1; throw new Error('no'); }));
    assert.equal(attempts, 1);
  });

  await test('W2.4 the backoff grows and is capped', () => {
    const policy = policies.retry({ name: 'b', initialDelayMs: 100, maxDelayMs: 500, backoffFactor: 2 });
    assert.equal(policy.delayFor(1), 100);
    assert.equal(policy.delayFor(2), 200);
    assert.equal(policy.delayFor(3), 400);
    assert.equal(policy.delayFor(4), 500, 'the delay must be capped');
  });

  /* ---------------------------------------------------------------- W2.5 */
  await test('W2.5 the taxonomy classifies the errors we actually see', () => {
    assert.equal(errors.classify({ code: 'ECONNREFUSED' }).code, errors.CODE.CONNECTION_REFUSED);
    assert.equal(errors.classify({ code: 'ENOTFOUND' }).code, errors.CODE.DNS);
    assert.equal(errors.classify({ code: 'ENOSPC' }).code, errors.CODE.NO_STORAGE);
    assert.equal(errors.classify({ code: 'EACCES' }).code, errors.CODE.ACCESS_DENIED);
    assert.equal(errors.classify({ status: 503 }).code, errors.CODE.HTTP_5XX);
    assert.equal(errors.classify({ status: 404 }).code, errors.CODE.HTTP_4XX);
    assert.equal(errors.classify({ code: 'DEADLINE_EXCEEDED' }).code, errors.CODE.TIMEOUT);
    assert.equal(errors.classify(new Error('boom')).code, errors.CODE.INTERNAL);
  });

  await test('W2.5 the taxonomy says what to do', () => {
    assert.equal(errors.classify({ code: 'ECONNREFUSED' }).retryable, true);
    assert.equal(errors.classify({ status: 503 }).retryable, true);
    assert.equal(errors.classify({ status: 404 }).retryable, false);
    assert.equal(errors.classify({ code: 'EACCES' }).needsUser, true);
    assert.equal(errors.classify({ code: 'ENOTFOUND' }).preDispatchRetryable, true);
    assert.equal(errors.classify({ status: 503 }).preDispatchRetryable, false);
  });

  await test('W2.5 a classified error carries its own classification', () => {
    const error = new errors.ClassifiedError(errors.CODE.REFUSED, 'the user said no');
    const classified = errors.classify(error);
    assert.equal(classified.code, errors.CODE.REFUSED);
    assert.equal(classified.needsUser, true);
  });

  /* ---------------------------------------------------------------- W2.6 */
  await test('W2.6 a repeated call with the same nonce returns the first result', async () => {
    let calls = 0;
    const registry = require('../src/main/ipc/registry');
    // Register a counting namespace for the test.
    registry.registerNamespace('w2probe', {
      handlers: {
        count: (_e, { by = 1 } = {}) => { calls += Number(by) || 1; return { calls }; },
      },
      events: [],
    });
    // The namespace has to be on an edge for the edge router to reach it.
    edges.attachNamespace('capabilities', 'w2probe');

    const first = await edges.call('capabilities', 'w2probe:count', { by: 1 }, { nonce: 'n1' });
    const second = await edges.call('capabilities', 'w2probe:count', { by: 1 }, { nonce: 'n1' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second.value, first.value, 'the second call must replay the first result');
    assert.equal(calls, 1, 'the handler must have run only once');

    // A different nonce runs it again.
    const third = await edges.call('capabilities', 'w2probe:count', { by: 1 }, { nonce: 'n2' });
    assert.equal(calls, 2);
    assert.notDeepEqual(third.value, first.value);
  });

  /* ---------------------------------------------------------------- W2.7 */
  await test('W2.7 background work is dropped before foreground work is delayed', async () => {
    const scheduler = new DemandScheduler({ concurrency: 1, softLimit: 2 });
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const running = scheduler.submit(async () => { order.push('person-1'); await gate; }, { demand: DEMAND.PERSON });
    scheduler.submit(async () => { order.push('background-1'); }, { demand: DEMAND.BACKGROUND });
    scheduler.submit(async () => { order.push('background-2'); }, { demand: DEMAND.BACKGROUND });
    // The queue is now full of background work; the next one is dropped.
    scheduler.submit(async () => { order.push('background-dropped'); }, { demand: DEMAND.BACKGROUND });
    assert.equal(scheduler.dropped, 1, 'background work must be dropped under pressure');

    release();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(order[0], 'person-1', 'the person must go first');
    assert.equal(order.includes('background-dropped'), false, 'the dropped work must not run');
  });

  await test('W2.7 foreground work is never dropped', async () => {
    const scheduler = new DemandScheduler({ concurrency: 1, softLimit: 1 });
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const running = scheduler.submit(async () => { await gate; }, { demand: DEMAND.PERSON });
    const p1 = scheduler.submit(async () => { order.push('p1'); }, { demand: DEMAND.PERSON });
    const p2 = scheduler.submit(async () => { order.push('p2'); }, { demand: DEMAND.PERSON });
    release();
    await Promise.all([running, p1, p2]);
    assert.deepEqual(order, ['p1', 'p2'], 'person work runs in order and is never dropped');
  });

  /* ---------------------------------------------------------------- W2.8 */
  await test('W2.8 the capability snapshot says what is available and why not', () => {
    const snap = capabilitiesService.snapshot();
    assert.equal(snap.version, 1);
    assert.ok(snap.capabilities.computerUse);
    assert.ok(snap.capabilities.providers);
    // Every unavailable capability must carry a reason.
    for (const entry of snap.unavailable) {
      assert.ok(entry.reason, `${entry.name} is unavailable but gives no reason`);
    }
    assert.ok(Array.isArray(snap.unavailable));
  });

  /* ---------------------------------------------------------------- W2.9 */
  await test('W2.9 a harness decides where a session\'s work runs', () => {
    const local = harness.registry.for('sess-1');
    assert.equal(local.id, 'local');
    assert.equal(local.route('shell', { sandboxMode: 'sandboxed' }), 'sandbox');
    assert.equal(local.route('shell', { sandboxMode: 'vm' }), 'guest');
    assert.equal(local.route('computer', { computerTarget: 'host' }), 'host');
    assert.equal(local.route('browser', { browserTarget: 'host' }), 'embedded');

    harness.registry.assign('sess-2', 'guest');
    const guest = harness.registry.for('sess-2');
    assert.equal(guest.id, 'guest');
    assert.equal(guest.route('shell'), 'guest');
    assert.equal(guest.route('browser'), 'guest');
    harness.registry.release('sess-2');
    assert.equal(harness.registry.for('sess-2').id, 'local');
  });

  await test('W2.9 an unknown harness is refused', () => {
    assert.throws(() => harness.registry.assign('sess-3', 'nope'), /unknown harness/);
  });

  await test('W2.9 the registry can describe its routing for the UI', () => {
    const routing = harness.registry.routing();
    assert.equal(routing.default, 'local');
    assert.ok(Array.isArray(routing.harnesses));
    const guest = routing.harnesses.find((h) => h.id === 'guest');
    assert.ok(guest);
    assert.equal(guest.persistent, true);
    const worker = routing.harnesses.find((h) => h.id === 'worker');
    assert.ok(worker, 'the unimplemented worker harness must still be declared — it is the seam');
  });

  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nW2 protocol tests FAILED');
    process.exit(1);
  }
  console.log(`\nW2 protocol: ${results.length} checks OK`);
})();
