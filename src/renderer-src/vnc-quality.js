'use strict';
/**
 * VNC link quality (W5.13).
 *
 * The noVNC viewer talks to the guest over a relay WebSocket. How much image
 * quality that link can carry is a property of the *link*, not of the
 * screen: a fat pipe can afford noVNC quality 8, a thin one has to fall
 * back to 6 or the guest turns into a slideshow.
 *
 * This module is the decision, and nothing else: no DOM, no noVNC, no
 * timers of its own — so it can be unit tested.
 *
 *   - an EMA of the measured link bandwidth. A sample is only taken when the
 *     window carries enough bytes *and* enough messages to mean something
 *     (a single small frame says nothing about the link).
 *   - the quality level is raised when the estimate has been sustained above
 *     a threshold, and lowered when it has been sustained below another one.
 *     Every change starts a hold, and the hold doubles on each change, so
 *     the controller settles instead of oscillating around the threshold.
 *   - a liveness beacon: a heartbeat while the session is connected, plus
 *     the age of the last thing we heard from the guest.
 *   - input correlation: the last action we sent, and whether the screen
 *     changed after it — the "the screen did not change" signal.
 */

const KIB = 1024;

/** The reference parameters. */
const DEFAULTS = {
  lowQuality: 6,
  highQuality: 8,
  raiseMbps: 15,
  lowerMbps: 11,
  weight: 0.25,
  minSampleBytes: 96 * KIB,
  minSampleMessages: 3,
  raiseHoldMs: 10_000,
  maxHoldMs: 160_000,
  // A safety valve: a slow link may never fill a 96 KiB sample, so a window
  // is also flushed once it is this old (with whatever did arrive).
  maxSampleMs: 5_000,
  // How long an action may go unanswered before the screen counts as stuck.
  stuckMs: 10_000,
  // The liveness beacon period.
  heartbeatMs: 5_000,
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

class QualityController {
  /**
   * @param {object} [opts]
   * @param {number} [opts.lowQuality]        the floor (default 6)
   * @param {number} [opts.highQuality]       the ceiling (default 8)
   * @param {number} [opts.raiseMbps]         raise at or above this (15)
   * @param {number} [opts.lowerMbps]         lower below this (11)
   * @param {number} [opts.weight]            the EMA weight (0.25)
   * @param {number} [opts.minSampleBytes]    96 KiB per sample
   * @param {number} [opts.minSampleMessages] 3 messages per sample
   * @param {number} [opts.raiseHoldMs]       the first hold (10 s)
   * @param {number} [opts.maxHoldMs]         the hold ceiling (160 s)
   * @param {number} [opts.maxSampleMs]       flush a partial sample after this
   * @param {number} [opts.stuckMs]           "the screen did not change" window
   * @param {number} [opts.heartbeatMs]       the beacon period
   * @param {() => number} [opts.now]         the clock (monotonic ms)
   * @param {(beat: object) => void} [opts.onHeartbeat] the beacon sink
   */
  constructor(opts = {}) {
    this.lowQuality = num(opts.lowQuality, DEFAULTS.lowQuality);
    this.highQuality = num(opts.highQuality, DEFAULTS.highQuality);
    this.raiseMbps = num(opts.raiseMbps, DEFAULTS.raiseMbps);
    this.lowerMbps = num(opts.lowerMbps, DEFAULTS.lowerMbps);
    this.weight = num(opts.weight, DEFAULTS.weight);
    this.minSampleBytes = num(opts.minSampleBytes, DEFAULTS.minSampleBytes);
    this.minSampleMessages = num(opts.minSampleMessages, DEFAULTS.minSampleMessages);
    this.raiseHoldMs = num(opts.raiseHoldMs, DEFAULTS.raiseHoldMs);
    this.maxHoldMs = num(opts.maxHoldMs, DEFAULTS.maxHoldMs);
    this.maxSampleMs = num(opts.maxSampleMs, DEFAULTS.maxSampleMs);
    this.stuckMs = num(opts.stuckMs, DEFAULTS.stuckMs);
    this.heartbeatMs = num(opts.heartbeatMs, DEFAULTS.heartbeatMs);
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.onHeartbeat = typeof opts.onHeartbeat === 'function' ? opts.onHeartbeat : null;
    this.reset();
  }

  /** Forget everything — a new session starts at the low quality level. */
  reset() {
    const t = this.now();
    this.quality = this.lowQuality;
    this.emaMbps = 0;
    this.hasEstimate = false;
    this.lastSampleMbps = 0;
    this.sampleBytes = 0;
    this.sampleMessages = 0;
    this.sampleStartedAt = t;
    this.holdMs = this.raiseHoldMs;
    this.holdUntil = 0;
    this.aboveSince = null;
    this.belowSince = null;
    this.connected = false;
    this.lastSeenAt = null;
    this.lastFrameAt = null;
    this.frames = 0;
    this.lastAction = null;
    this.changedAfterAction = false;
    this.lastChange = null;
    this.lastChangeAt = 0;
    this.lastHeartbeatAt = 0;
    this.heartbeats = 0;
  }

  /** The session is (or is no longer) connected. */
  setConnected(connected) {
    this.connected = connected === true;
    const t = this.now();
    if (this.connected) {
      this.lastSeenAt = t;
      this.sampleStartedAt = t;
      this.lastHeartbeatAt = t;
    }
  }

  /**
   * Feed the link statistics: bytes that arrived, and how many messages
   * carried them.
   */
  noteBytes(bytes, messages = 1) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return null;
    this.sampleBytes += n;
    this.sampleMessages += Math.max(1, Number(messages) || 1);
    this.lastSeenAt = this.now();
    return this.maybeSample();
  }

  /**
   * Take a sample when the window carries enough to be meaningful, and feed
   * it into the EMA.
   */
  maybeSample() {
    const t = this.now();
    const elapsed = t - this.sampleStartedAt;
    const full = this.sampleBytes >= this.minSampleBytes && this.sampleMessages >= this.minSampleMessages;
    const stale = elapsed >= this.maxSampleMs && this.sampleBytes > 0;
    if (!full && !stale) return null;
    const seconds = Math.max(0.001, elapsed / 1000);
    const mbps = (this.sampleBytes * 8) / seconds / 1e6;
    this.sampleBytes = 0;
    this.sampleMessages = 0;
    this.sampleStartedAt = t;
    this.lastSampleMbps = mbps;
    this.emaMbps = this.hasEstimate ? this.emaMbps + this.weight * (mbps - this.emaMbps) : mbps;
    this.hasEstimate = true;
    this.trackSustained(t);
    this.evaluate(t);
    return mbps;
  }

  /** Remember how long the estimate has been above / below a threshold. */
  trackSustained(t) {
    if (this.emaMbps >= this.raiseMbps) {
      if (this.aboveSince === null) this.aboveSince = t;
      this.belowSince = null;
    } else if (this.emaMbps < this.lowerMbps) {
      if (this.belowSince === null) this.belowSince = t;
      this.aboveSince = null;
    } else {
      // The dead band: neither direction is sustained.
      this.aboveSince = null;
      this.belowSince = null;
    }
  }

  /**
   * Change the quality level when the estimate has been sustained on one
   * side of a threshold for at least the current hold. Every change starts a
   * new hold and doubles it, so the controller settles.
   *
   * @returns {number|null} the new quality level, or null when nothing moved.
   */
  evaluate(at = this.now()) {
    if (!this.hasEstimate) return null;
    if (at < this.holdUntil) return null; // the hold is still running
    const before = this.quality;
    if (this.quality < this.highQuality
      && this.aboveSince !== null
      && this.emaMbps >= this.raiseMbps
      && at - this.aboveSince >= this.holdMs) {
      this.quality = Math.min(this.highQuality, this.quality + 1);
      this.lastChange = 'raise';
    } else if (this.quality > this.lowQuality
      && this.belowSince !== null
      && this.emaMbps < this.lowerMbps
      && at - this.belowSince >= this.holdMs) {
      this.quality = Math.max(this.lowQuality, this.quality - 1);
      this.lastChange = 'lower';
    } else {
      return null;
    }
    if (this.quality === before) return null;
    this.lastChangeAt = at;
    this.holdUntil = at + this.holdMs;
    this.holdMs = Math.min(this.holdMs * 2, this.maxHoldMs);
    return this.quality;
  }

  /** The guest painted something. */
  noteFrame() {
    const t = this.now();
    this.lastFrameAt = t;
    this.lastSeenAt = t;
    this.frames += 1;
    if (this.lastAction) this.changedAfterAction = true;
  }

  /** We sent input — the guest is expected to repaint. */
  noteAction(kind = 'input') {
    this.lastAction = { kind, at: this.now() };
    this.changedAfterAction = false;
  }

  /**
   * "The screen did not change": we acted and nothing was painted since.
   */
  stuck(at = this.now()) {
    if (!this.lastAction) return false;
    if (this.changedAfterAction) return false;
    return at - this.lastAction.at >= this.stuckMs;
  }

  /**
   * The periodic tick: emits the heartbeat while the session is connected.
   */
  tick() {
    const t = this.now();
    if (!this.connected) return null;
    if (t - this.lastHeartbeatAt < this.heartbeatMs) return null;
    this.lastHeartbeatAt = t;
    this.heartbeats += 1;
    const beat = this.state(t);
    if (this.onHeartbeat) {
      try { this.onHeartbeat(beat); } catch { /* a bad listener must not stop the beacon */ }
    }
    return beat;
  }

  /** Everything a surface needs to show. */
  state(at = this.now()) {
    return {
      connected: this.connected,
      quality: this.quality,
      bandwidthMbps: this.emaMbps,
      lastSampleMbps: this.lastSampleMbps,
      lastSeenAgeMs: this.lastSeenAt === null ? null : at - this.lastSeenAt,
      lastFrameAgeMs: this.lastFrameAt === null ? null : at - this.lastFrameAt,
      lastAction: this.lastAction,
      changedAfterAction: this.changedAfterAction,
      stuck: this.stuck(at),
      holdMs: this.holdMs,
      lastChange: this.lastChange,
      lastChangeAt: this.lastChangeAt,
      heartbeats: this.heartbeats,
    };
  }
}

module.exports = { QualityController, DEFAULTS };
