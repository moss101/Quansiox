'use strict';
/* The VNC link-quality controller (W5.13).
 *
 *  - the bandwidth estimate is an EMA over samples that carry enough bytes
 *    AND enough messages to mean something
 *  - a fast link raises the quality level, a slow one lowers it, and every
 *    change doubles the hold so the controller settles
 *  - the liveness beacon fires while the session is connected and reports
 *    how long ago we last heard from the guest
 *  - input correlation: "the screen did not change" after we acted
 *
 * Pure module — no DOM, no noVNC. */
const assert = require('node:assert/strict');

const { QualityController, DEFAULTS } = require('../src/renderer-src/vnc-quality.js');

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** Feed the link at a fixed rate for a fixed stretch of time. */
function feed(controller, clk, mbps, ms, bytesPerSample = 96 * 1024) {
  const intervalMs = (bytesPerSample * 8) / (mbps * 1e6) * 1000;
  const end = clk.now() + ms;
  let guard = 0;
  while (clk.now() < end && guard < 200_000) {
    clk.advance(intervalMs);
    controller.noteBytes(bytesPerSample, 3);
    guard += 1;
  }
}

(async () => {
  /* 1. the reference parameters are the defaults */
  const c0 = new QualityController();
  assert.equal(c0.lowQuality, 6);
  assert.equal(c0.highQuality, 8);
  assert.equal(c0.raiseMbps, 15);
  assert.equal(c0.lowerMbps, 11);
  assert.equal(c0.weight, 0.25);
  assert.equal(c0.minSampleBytes, 96 * 1024);
  assert.equal(c0.minSampleMessages, 3);
  assert.equal(c0.raiseHoldMs, 10_000);
  assert.equal(c0.maxHoldMs, 160_000);
  assert.equal(DEFAULTS.lowQuality, 6);
  assert.equal(DEFAULTS.highQuality, 8);

  /* 2. a sample needs 96 KiB AND 3 messages */
  const c1 = clock();
  const q1 = new QualityController({ now: c1.now });
  q1.setConnected(true);
  q1.noteBytes(50 * 1024, 1);
  assert.equal(q1.hasEstimate, false, 'a partial window is not a sample');
  q1.noteBytes(50 * 1024, 1);
  assert.equal(q1.hasEstimate, false, 'bytes alone are not enough');
  c1.advance(1000);
  q1.noteBytes(1, 3);
  assert.equal(q1.hasEstimate, true, '96 KiB and 3 messages make a sample');
  assert.ok(q1.emaMbps > 0, 'the estimate must be positive');

  /* 3. a fast link raises the quality — after the hold, not before */
  const c2 = clock();
  const q2 = new QualityController({ now: c2.now });
  q2.setConnected(true);
  feed(q2, c2, 30, 5_000);
  assert.equal(q2.quality, 6, 'five seconds of a fast link is not a sustained estimate');
  feed(q2, c2, 30, 12_000);
  assert.equal(q2.quality, 7, 'a sustained fast link raises the quality');
  assert.equal(q2.lastChange, 'raise');

  /* 4. the hold doubles on each change and is capped */
  const holds = [];
  const c3 = clock();
  const q3 = new QualityController({ now: c3.now });
  q3.setConnected(true);
  let last = q3.quality;
  for (let i = 0; i < 8; i += 1) {
    feed(q3, c3, 30, 20_000);
    if (q3.quality !== last) { last = q3.quality; holds.push(q3.holdMs); }
  }
  assert.ok(holds.length >= 2, `expected several changes, got ${holds.length}`);
  assert.equal(holds[0], 20_000, 'the first change doubles the 10 s hold');
  assert.equal(holds[1], 40_000, 'the hold doubles again');
  assert.ok(q3.holdMs <= DEFAULTS.maxHoldMs, 'the hold is capped');

  /* 5. the quality never leaves the band */
  assert.ok(q3.quality >= q3.lowQuality && q3.quality <= q3.highQuality, 'the quality stays in the band');
  assert.equal(q3.quality, 8, 'a fast link reaches the ceiling');

  /* 6. a slow link lowers the quality again */
  feed(q3, c3, 4, 240_000);
  assert.equal(q3.quality, 6, 'a sustained slow link lowers the quality back to the floor');
  assert.equal(q3.lastChange, 'lower');

  /* 7. the liveness beacon fires while connected */
  const c4 = clock();
  const beats = [];
  const q4 = new QualityController({ now: c4.now, onHeartbeat: (beat) => beats.push(beat) });
  q4.setConnected(true);
  assert.equal(q4.tick(), null, 'no heartbeat before the period is up');
  c4.advance(5_000);
  const beat = q4.tick();
  assert.ok(beat, 'the beacon fires');
  assert.equal(beats.length, 1);
  assert.equal(beat.connected, true);
  assert.equal(beat.lastSeenAgeMs, 5_000, 'the beacon reports the last-seen age');
  assert.equal(q4.heartbeats, 1);
  q4.setConnected(false);
  c4.advance(10_000);
  assert.equal(q4.tick(), null, 'no heartbeat while the session is down');

  /* 8. input correlation: the screen did not change */
  const c5 = clock();
  const q5 = new QualityController({ now: c5.now });
  q5.setConnected(true);
  assert.equal(q5.stuck(), false, 'nothing was sent, nothing is stuck');
  q5.noteAction('key');
  assert.equal(q5.state().lastAction.kind, 'key');
  c5.advance(9_000);
  assert.equal(q5.stuck(), false, 'the guest still has time to answer');
  c5.advance(2_000);
  assert.equal(q5.stuck(), true, 'an action with no repaint is a stuck screen');
  q5.noteFrame();
  assert.equal(q5.stuck(), false, 'a repaint clears the signal');
  assert.equal(q5.state().changedAfterAction, true);

  /* 9. reset puts everything back */
  q5.reset();
  assert.equal(q5.quality, 6);
  assert.equal(q5.hasEstimate, false);
  assert.equal(q5.lastAction, null);

  console.log('vnc quality test: ALL OK (ema/hold-doubling/raise-lower/beacon/input-correlation/reset)');
})().catch((e) => { console.error(e); process.exit(1); });
