'use strict';
/* Computer pool test — per-child guest leases: refcounted acquire/reuse,
 * concurrency cap, release-to-reap, and reapAll, via an injected factory.
 * Node-only; live VM boot per child is hardware-gated. */
const assert = require('node:assert/strict');
const { computerPool } = require('../src/main/services/computerPool');

async function run() {
  const closed = [];
  let boots = 0;
  computerPool.setFactory(async (sid) => { boots += 1; return { sessionId: sid, close: () => closed.push(sid) }; });
  computerPool.cap(2); // small cap to exercise the limit

  // 1. acquire twice for the same session → one boot, refCount 2
  const a1 = await computerPool.acquire('child-a');
  const a2 = await computerPool.acquire('child-a');
  assert.strictEqual(a1, a2, 'same lease reused');
  assert.strictEqual(boots, 1, 'one boot for the shared session');
  assert.strictEqual(computerPool.list()[0].refCount, 2);

  // 2. second session ok; third exceeds the cap → throws (child falls back)
  await computerPool.acquire('child-b');
  await assert.rejects(() => computerPool.acquire('child-c'), /pool is full/);

  // 3. release once (refCount 1) → still open, NOT closed yet
  assert.strictEqual(computerPool.release('child-a'), true);
  assert.deepStrictEqual(closed, [], 'sibling still holds the lease');
  // final release → reaped once refCount hits 0
  computerPool.release('child-a');
  assert.deepStrictEqual(closed, ['child-a'], 'lease reaped on last release');
  assert.strictEqual(computerPool.get('child-a'), null);

  // 4. freed slot → a new session can lease now
  const c = await computerPool.acquire('child-c');
  assert.strictEqual(c.sessionId, 'child-c');

  // 5. reapAll closes the rest
  computerPool.reapAll();
  assert.deepStrictEqual(closed.sort(), ['child-a', 'child-b', 'child-c']);
  assert.strictEqual(computerPool.list().length, 0);

  console.log('computer-pool test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
