'use strict';
/* Agent code sandbox test — the Manus computer-use/js pattern:
 * call budget, deadline, preserved state, output collection, error shape. */
const assert = require('node:assert');
const { runCell, resetState, CALL_BUDGET } = require('../src/coordinator/agent-code.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake cu/iab host bindings backed by the coordinator proxy contract.
function fakeHosts() {
  let calls = 0;
  const computer = async (method, args) => {
    calls += 1;
    if (method === 'screenshot') {
      return { width: 100, height: 50, frameHash: 'ab12', screenChanged: true, coordinateToken: 'ct-1', data: 'data:image/png;base64,AAAA' };
    }
    if (method === 'findElements') return { count: 1, elements: [{ id: 'ax1', role: 'AXButton', title: 'OK' }] };
    if (method === 'click') return `clicked (${args.x}, ${args.y})`;
    return `${method} ok`;
  };
  const browser = async (method, args) => {
    calls += 1;
    if (method === 'open') return `opened ${args.url}`;
    if (method === 'snapshot') return { snapshotId: 'snap_1', text: '- button "Go" [ref=e1]', refCount: 1 };
    if (method === 'act' && args?.method === 'screenshot') return { width: 10, height: 10, data: 'data:image/png;base64,BBBB' };
    if (method === 'act') return `${args.method} ok`;
    return 'ok';
  };
  return { computer, browser, count: () => calls };
}

(async () => {
  // 1. A simple cell using bindings + output + state.
  const hosts = fakeHosts();
  const r1 = await runCell({
    sessionId: 't1', computer: hosts.computer, browser: hosts.browser,
    code: `
      const found = await cu.find({ role: 'AXButton' });
      state.found = found.count;
      output.observation('found ' + found.count);
      await iab.open('example.com');
      const i = await iab.snapshot();
      state.snap = i.snapshotId;
      return i.refCount;
    `,
  });
  assert.strictEqual(r1.error, undefined, 'no error');
  assert.match(r1.text, /\[observation\] found 1/);
  assert.match(r1.text, /\[return\] 1/);
  assert.ok(r1.budgetUsed >= 2, 'budget counted');
  assert.deepStrictEqual(r1.stateKeys.sort(), ['found', 'snap']);

  // 2. State persists across cells (Manus globalThis.state pattern).
  const r2 = await runCell({
    sessionId: 't1', computer: hosts.computer, browser: hosts.browser,
    code: `return 'snap was ' + state.snap + ', found ' + state.found;`,
  });
  assert.match(r2.text, /snap was snap_1, found 1/);

  // 3. Budget enforcement: exhausting calls fails with guidance, state kept.
  const r3 = await runCell({
    sessionId: 't2', computer: hosts.computer, browser: hosts.browser,
    code: `
      state.n = 0;
      for (let i = 0; i < ${CALL_BUDGET + 10}; i++) {
        await cu.key({ key: 'a' });
        state.n += 1;
      }
    `,
  });
  assert.strictEqual(r3.error, true, 'budget cell errors');
  assert.match(r3.text, /CELL_BUDGET_EXCEEDED/);
  assert.match(r3.text, /state is preserved/);
  // And state really was preserved.
  const r4 = await runCell({
    sessionId: 't2', computer: hosts.computer, browser: hosts.browser,
    code: `return 'did ' + state.n + ' calls';`,
  });
  assert.match(r4.text, /did 64 calls/);

  // 4. Deadline enforcement.
  const r5 = await runCell({
    sessionId: 't3', computer: hosts.computer, browser: hosts.browser,
    timeoutMs: 1000,
    code: `
      for (;;) { await cu.key({ key: 'a' }); }
    `,
  });
  assert.strictEqual(r5.error, true);
  assert.match(r5.text, /CELL_DEADLINE_EXCEEDED|CELL_BUDGET_EXCEEDED/);

  // 5. Images: screenshot metadata → output.image attaches the dataUrl.
  const r6 = await runCell({
    sessionId: 't4', computer: hosts.computer, browser: hosts.browser,
    code: `
      const shot = await cu.screenshot();
      output.image(shot.__imageDataUrl);
      output.write('hash ' + shot.frameHash + ' changed=' + shot.screenChanged);
    `,
  });
  assert.deepStrictEqual(r6.images, ['data:image/png;base64,AAAA']);
  assert.match(r6.text, /hash ab12 changed=true/);

  // 6. Runtime errors carry output context, not a crash.
  const r7 = await runCell({
    sessionId: 't5', computer: hosts.computer, browser: hosts.browser,
    code: `output.write('before'); throw new Error('boom');`,
  });
  assert.strictEqual(r7.error, true);
  assert.match(r7.text, /\[write\] before/);
  assert.match(r7.text, /CELL_ERROR.*boom/);

  // 7. Sync infinite loop is interrupted by the vm timeout.
  const r8 = await runCell({
    sessionId: 't6', computer: hosts.computer, browser: hosts.browser,
    code: `while (true) {}`,
  });
  assert.strictEqual(r8.error, true, 'sync loop interrupted');

  // 8. resetState clears.
  resetState('t1');
  const r9 = await runCell({
    sessionId: 't1', computer: hosts.computer, browser: hosts.browser,
    code: `return Object.keys(state).length;`,
  });
  assert.match(r9.text, /\[return\] 0/);

  console.log('agent-code test: ALL OK');
  process.exit(0);
})().catch((error) => {
  console.error('agent-code test FAILED:', error);
  process.exit(1);
});
