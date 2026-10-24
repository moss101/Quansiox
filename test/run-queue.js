'use strict';
/* Run-queue test — per-session FIFO behind the active run: ordering, handoff
 * after resolve AND reject, onQueued positions, dequeued meta, cleanup, and
 * independent sessions running in parallel. Electron-free. */
const assert = require('node:assert/strict');
const { createRunQueue } = require('../src/main/services/runQueue');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  const starts = [];
  const queue = createRunQueue((sessionId, task, meta) => {
    starts.push({ sessionId, task, meta });
    return task.deferred.promise;
  });

  // head run starts immediately; depth/busy reflect it
  const d1 = deferred(); const d2 = deferred(); const d3 = deferred();
  const positions = [];
  const p1 = queue.run('s1', { name: 'one', deferred: d1 });
  assert.equal(starts.length, 1, 'head run starts immediately');
  assert.equal(starts[0].meta.dequeued, false, 'head run is not a dequeue');
  assert.equal(queue.busy('s1'), true);
  assert.equal(queue.depth('s1'), 0);

  // further runs queue FIFO without starting
  const p2 = queue.run('s1', { name: 'two', deferred: d2 }, (pos) => positions.push(pos));
  const p3 = queue.run('s1', { name: 'three', deferred: d3 }, (pos) => positions.push(pos));
  assert.equal(starts.length, 1, 'queued runs do not start early');
  assert.equal(queue.depth('s1'), 2);
  assert.deepEqual(positions, [1, 2], 'onQueued reports queue positions');

  // a different session runs in parallel
  const dOther = deferred();
  const pOther = queue.run('s2', { name: 'other', deferred: dOther });
  assert.equal(starts.length, 2, 'other session starts in parallel');

  // handoff after resolve
  d1.resolve('one-done');
  assert.equal(await p1, 'one-done');
  await tick();
  assert.equal(starts.length, 3, 'second run starts after the first settles');
  assert.equal(starts[2].sessionId, 's1');
  assert.equal(starts[2].task.name, 'two');
  assert.equal(starts[2].meta.dequeued, true, 'dequeued runs are flagged');

  // handoff after reject (the next run still starts; its own promise rejects)
  d2.reject(new Error('boom'));
  await assert.rejects(p2, /boom/);
  await tick();
  assert.equal(starts.length, 4, 'third run starts after a rejected second');
  assert.equal(starts[3].task.name, 'three');

  // resolving the other session does not touch s1
  dOther.resolve('other-done');
  assert.equal(await pOther, 'other-done');
  assert.equal(queue.busy('s2'), false, 'idle session is cleaned up');
  assert.equal(queue.depth('s2'), 0);

  // drain completes and cleans up
  d3.resolve('three-done');
  assert.equal(await p3, 'three-done');
  await tick();
  assert.equal(queue.busy('s1'), false, 'session removed once the queue drains');
  assert.equal(queue.depth('s1'), 0);

  // a fresh run after drain starts as a new head
  const d4 = deferred();
  const p4 = queue.run('s1', { name: 'four', deferred: d4 });
  assert.equal(starts.length, 5, 'new run starts after cleanup');
  assert.equal(starts[4].meta.dequeued, false);
  d4.resolve('four-done');
  assert.equal(await p4, 'four-done');
  await tick();
  assert.equal(queue.busy('s1'), false);

  console.log('run-queue test: ALL OK');
})().catch((error) => { console.error(error); process.exit(1); });
