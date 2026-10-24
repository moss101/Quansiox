'use strict';
/**
 * Screen liveness tracker — decides whether a remote framebuffer is *dead*.
 *
 * Why this exists: a naive "no frame for N seconds ⇒ stalled" watchdog
 * tears down healthy connections. A guest showing a static screen (an idle
 * editor, a finished build, a paused terminal) legitimately sends no
 * updates for minutes, and the viewer used to reconnect in a loop.
 *
 * The rule we use (matching Grok Bot's `__sandVncLivenessBeacon`):
 *
 *   dead  ⇔  we PROVED it: we sent input and the guest still painted
 *            nothing within the window, or the transport reported an error.
 *   idle  ⇔  no frames, but also no input — perfectly normal. Never fatal.
 *
 * Pure module (no DOM, no noVNC) so it can be unit tested.
 */

/** Input-correlation window. */
const WINDOW_MS = 10_000;
/** Minimum inputs inside the window before "we asked for a repaint". */
const MIN_INPUTS = 3;

class LivenessTracker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.windowMs]   how long we wait after input before
   *                                   declaring a stall
   * @param {number} [opts.minInputs]  inputs required before a stall is claimed
   * @param {() => number} [opts.now]  clock (monotonic ms)
   */
  constructor(opts = {}) {
    this.windowMs = Number(opts.windowMs) || WINDOW_MS;
    this.minInputs = Number(opts.minInputs) || MIN_INPUTS;
    this.now = opts.now || (() => Date.now());
    this.reset();
  }

  reset() {
    const t = this.now();
    this.lastFrameAt = t;
    this.frames = 0;
    this.fpsAt = t;
    // Inputs since the last decoded frame. A repaint clears the suspicion,
    // so an old burst can never condemn a healthy session.
    this.inputsSinceFrame = 0;
    this.lastInputAt = 0;
    this.faulted = false;
  }

  /** A framebuffer update was decoded — proof the relay is alive. */
  noteFrame() {
    const t = this.now();
    this.lastFrameAt = t;
    this.frames += 1;
    this.inputsSinceFrame = 0;
  }

  /** We sent a key or pointer event — the guest should repaint. */
  noteInput() {
    this.inputsSinceFrame += 1;
    this.lastInputAt = this.now();
  }

  /** The transport failed outright (socket error, RFB protocol error). */
  noteFault() {
    this.faulted = true;
  }

  /** Frames per second since the last fps sample. */
  fps() {
    const t = this.now();
    const secs = Math.max(1, (t - this.fpsAt) / 1000);
    const value = Math.round(this.frames / secs);
    if (secs >= 2) { this.frames = 0; this.fpsAt = t; }
    return value;
  }

  /**
   * Evaluate the current state.
   * @returns {{ dead: boolean, idle: boolean, quietMs: number, inputs: number }}
   *   `dead`  → the caller should tear the connection down and reconnect.
   *   `idle`  → no frames, but we cannot prove a fault (do not reconnect).
   */
  evaluate() {
    const t = this.now();
    const quietMs = t - this.lastFrameAt;
    if (this.faulted) return { dead: true, idle: false, quietMs, inputs: this.inputsSinceFrame };
    if (quietMs <= this.windowMs) return { dead: false, idle: false, quietMs, inputs: this.inputsSinceFrame };
    // We asked for a repaint and got nothing → the guest is wedged.
    const sinceInput = this.lastInputAt ? t - this.lastInputAt : Infinity;
    if (this.inputsSinceFrame >= this.minInputs && sinceInput >= this.windowMs) {
      return { dead: true, idle: false, quietMs, inputs: this.inputsSinceFrame };
    }
    // No input (or too few): the screen may simply be static. Not a fault.
    return { dead: false, idle: true, quietMs, inputs: this.inputsSinceFrame };
  }
}

module.exports = { LivenessTracker, WINDOW_MS, MIN_INPUTS };
