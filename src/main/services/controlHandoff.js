'use strict';
/**
 * User take-over handoff for host computer control (docs: Take over / I'm
 * done). While active, every agent-driven computer action is refused with a
 * clear model-facing message until the user hands control back. Global (the
 * host Mac is a single machine). Node-safe: no electron at load time.
 */
let active = false;

function isActive() {
  return active;
}

function setActive(next) {
  active = next === true;
  // Hide the trust overlay the moment the user takes over; it will re-arm on
  // the next agent computer call after hand-back.
  if (active) {
    try { require('./trustOverlayService').trustOverlayService.hide(); } catch { /* best-effort */ }
  }
  try { require('../ipc/emitEvent').emitEvent('computerUse', 'onTakeover', { active }); } catch { /* no windows */ }
  return { active };
}

module.exports = { controlHandoff: { isActive, setActive } };
