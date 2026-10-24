'use strict';
/* Screen liveness tracker — the rule that decides whether a remote
 * framebuffer is really dead.
 *
 *  - a static screen with no input is IDLE, never a fault (the old watcher
 *    tore healthy connections down in a reconnect loop)
 *  - input that produces no repaint IS a fault
 *  - an explicit transport fault is always fatal
 *  - the input window ages out, so an old burst does not condemn a session
 *
 * Pure module — no DOM, no noVNC. */
const assert = require('node:assert/strict');

const { LivenessTracker, WINDOW_MS, MIN_INPUTS } = require('../src/renderer-src/liveness.js');

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

(async () => {
  // 1. a fresh tracker is healthy
  const c1 = clock();
  const t1 = new LivenessTracker({ now: c1.now });
  let v = t1.evaluate();
  assert.equal(v.dead, false);
  assert.equal(v.idle, false);

  // 2. THE REGRESSION: a static screen with no input must never be "dead",
  //    no matter how long it stays static.
  c1.advance(60_000);
  v = t1.evaluate();
  assert.equal(v.dead, false, 'an idle static screen is not a fault');
  assert.equal(v.idle, true, 'but it is reported as idle');

  // 3. frames keep it healthy
  c1.advance(5_000);
  t1.noteFrame();
  v = t1.evaluate();
  assert.equal(v.dead, false);
  assert.equal(v.idle, false);

  // 4. input with no repaint IS a fault (the guest is wedged)
  const c2 = clock();
  const t2 = new LivenessTracker({ now: c2.now });
  for (let i = 0; i < MIN_INPUTS; i += 1) t2.noteInput();
  c2.advance(WINDOW_MS + 1_000);
  v = t2.evaluate();
  assert.equal(v.dead, true, 'input without a repaint is a stall');
  assert.equal(v.idle, false);
  assert.equal(v.inputs, MIN_INPUTS);

  // 5. below the input threshold → idle, not dead
  const c3 = clock();
  const t3 = new LivenessTracker({ now: c3.now });
  t3.noteInput();
  t3.noteInput();
  c3.advance(WINDOW_MS + 1_000);
  v = t3.evaluate();
  assert.equal(v.dead, false);
  assert.equal(v.idle, true);

  // 6. a repaint clears the pending-input suspicion
  const c4 = clock();
  const t4 = new LivenessTracker({ now: c4.now });
  for (let i = 0; i < MIN_INPUTS; i += 1) t4.noteInput();
  c4.advance(WINDOW_MS + 1_000);
  t4.noteFrame();
  v = t4.evaluate();
  assert.equal(v.dead, false, 'a repaint proves the guest is alive');

  // 7. the input window ages out — an old burst does not condemn a session
  const c5 = clock();
  const t5 = new LivenessTracker({ now: c5.now });
  for (let i = 0; i < MIN_INPUTS; i += 1) t5.noteInput();
  c5.advance(WINDOW_MS + 1_000);
  t5.noteFrame();            // a repaint happened
  c5.advance(WINDOW_MS + 1_000); // then a long quiet stretch with no input
  v = t5.evaluate();
  assert.equal(v.dead, false, 'stale input must age out');
  assert.equal(v.idle, true);

  // 8. an explicit transport fault is always fatal
  const c6 = clock();
  const t6 = new LivenessTracker({ now: c6.now });
  t6.noteFault();
  v = t6.evaluate();
  assert.equal(v.dead, true);

  // 9. fps accounting
  const c7 = clock();
  const t7 = new LivenessTracker({ now: c7.now });
  t7.noteFrame(); t7.noteFrame();
  c7.advance(1_000);
  assert.equal(t7.fps(), 2, 'two frames in a second is 2 fps');

  // 10. reset clears everything
  t7.noteInput(); t7.noteFault();
  t7.reset();
  v = t7.evaluate();
  assert.equal(v.dead, false);

  console.log('liveness test: ALL OK (idle-not-dead/input-correlation/window-rollover/fault/fps/reset)');
})().catch((e) => { console.error(e); process.exit(1); });
