'use strict';
/* Per-bot computer runtime test — session lifecycle without VZ. Verifies:
 * lazy single-flight boot, RFB readiness handed to the caller, screen/input
 * attach, idempotent ensure, state events (starting→ready→off), stop cleanup,
 * honest boot failure, unavailable hosts, and screen-only input failure. */
const assert = require('node:assert/strict');
const { computerRuntimeService: runtime } = require('../src/main/services/computerRuntimeService');

async function run() {
  const calls = { boot: 0, attachScreen: 0, attachInput: 0, stopVm: 0, closeScreen: 0, detachInput: 0 };
  const events = [];
  let bootImpl = async ({ sessionId } = {}) => ({ rfbSock: `/tmp/${sessionId}-5900.sock`, cdpSock: `/tmp/${sessionId}-9222.sock` });

  runtime.setDeps({
    available: () => true,
    boot: async (opts) => { calls.boot += 1; return bootImpl(opts); },
    stopVm: () => { calls.stopVm += 1; return true; },
    attachScreen: async () => { calls.attachScreen += 1; return { ready: true }; },
    closeScreen: () => { calls.closeScreen += 1; return true; },
    screenUrl: (sid) => `ws://127.0.0.1:9999/${sid}`,
    attachInput: async () => { calls.attachInput += 1; return { width: 1280 }; },
    detachInput: () => { calls.detachInput += 1; },
    sandboxRoot: (sid) => `/tmp/sandbox/${sid}`,
    workspaceRoot: () => '/tmp/workspace',
    emit: (state) => events.push({ ...state }),
  });

  // 1. lazy ensure → starting → ready; attaches screen + input once
  const ready = await runtime.ensure('bot-a', { reason: 'test' });
  assert.strictEqual(ready.phase, 'ready');
  assert.strictEqual(ready.url, 'ws://127.0.0.1:9999/bot-a');
  assert.strictEqual(ready.input, true);
  assert.strictEqual(calls.boot, 1);
  assert.strictEqual(calls.attachScreen, 1);
  assert.strictEqual(calls.attachInput, 1);
  assert.deepStrictEqual(events.map((e) => e.phase), ['starting', 'ready'], 'state events starting → ready');
  assert.strictEqual(runtime.status('bot-a').phase, 'ready');

  // 2. idempotent ensure: no second boot/attach
  const again = await runtime.ensure('bot-a');
  assert.strictEqual(again.phase, 'ready');
  assert.strictEqual(calls.boot, 1);
  assert.strictEqual(calls.attachScreen, 1);

  // 3. concurrent ensure shares one boot
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  bootImpl = async ({ sessionId } = {}) => {
    await gate;
    return { rfbSock: `/tmp/${sessionId}-5900.sock`, cdpSock: null };
  };
  const p1 = runtime.ensure('bot-b');
  const p2 = runtime.ensure('bot-b');
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.strictEqual(a.phase, 'ready');
  assert.strictEqual(b.phase, 'ready');
  assert.strictEqual(calls.boot, 2, 'one extra boot for bot-b (single-flight)');

  // 4. stop closes screen/input and the VM, then reports off
  const stopped = runtime.stop('bot-b');
  assert.strictEqual(stopped.phase, 'off');
  assert.strictEqual(stopped.url, null);
  assert.ok(calls.closeScreen >= 1 && calls.detachInput >= 1 && calls.stopVm >= 1);
  assert.strictEqual(runtime.status('bot-b').phase, 'off');

  // 4b. Stop during boot wins: the boot cannot publish ready afterwards
  let releaseSlow;
  bootImpl = async ({ sessionId } = {}) => {
    await new Promise((resolve) => { releaseSlow = resolve; });
    return { rfbSock: `/tmp/${sessionId}.sock`, cdpSock: null };
  };
  const slow = runtime.ensure('bot-stop');
  await new Promise((r) => setTimeout(r, 10));
  runtime.stop('bot-stop');
  releaseSlow();
  await assert.rejects(() => slow, (error) => error.code === 'COMPUTER_CANCELLED');
  assert.strictEqual(runtime.status('bot-stop').phase, 'off', 'Stop wins over a racing boot');

  // 5. boot failure is honest: error state + cleanup + CODED rejection
  bootImpl = async () => { throw new Error('VZ refused'); };
  await assert.rejects(() => runtime.ensure('bot-c'), (error) => {
    assert.strictEqual(error.code, 'COMPUTER_BOOT_FAILED');
    assert.match(error.message, /VZ refused/);
    return true;
  });
  assert.strictEqual(runtime.status('bot-c').phase, 'error');
  assert.match(runtime.status('bot-c').error, /VZ refused/);

  // 6. screen without input still reports ready + input:false (honest)
  bootImpl = async ({ sessionId } = {}) => ({ rfbSock: `/tmp/${sessionId}.sock`, cdpSock: null });
  runtime.setDeps({
    available: () => true,
    boot: bootImpl,
    attachScreen: async () => ({}),
    screenUrl: () => 'ws://127.0.0.1:1',
    attachInput: async () => { throw new Error('input unavailable'); },
    emit: () => {},
  });
  const screenOnly = await runtime.ensure('bot-d');
  assert.strictEqual(screenOnly.phase, 'ready');
  assert.strictEqual(screenOnly.input, false, 'screen-only guest is labelled honestly');

  // 7. unavailable host fails closed with COMPUTER_UNAVAILABLE
  runtime.setDeps({ available: () => false });
  await assert.rejects(() => runtime.ensure('bot-e'), (error) => error.code === 'COMPUTER_UNAVAILABLE');
  assert.strictEqual(runtime.canProvide(), false);

  runtime.reset('bot-a');
  runtime.reset('bot-b');
  runtime.reset('bot-c');
  runtime.reset('bot-d');
  runtime.resetDeps();
  console.log('computer-runtime test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
