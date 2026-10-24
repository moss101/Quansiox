'use strict';
/**
 * Deep-link delivery queue — Grok's markDeepLinksReady parity.
 *
 * quansiox:// links can arrive before the renderer has subscribed (cold start,
 * second instance). Deliveries are queued until the renderer signals readiness
 * via `markDeepLinksReady` (or the window finishes loading), then flushed in
 * order to the `navigation`/`navigate` event stream.
 */
const MAX_PENDING = 32;

let ready = false;
const pending = [];

function emit(route) {
  try { require('../ipc/emitEvent').emitEvent('navigation', 'navigate', route); } catch {}
}

function deliver(route) {
  if (!route || !route.type) throw new Error('route.type is required');
  if (ready) {
    emit(route);
    return { delivered: true, queued: false, pending: pending.length };
  }
  if (pending.length >= MAX_PENDING) pending.shift();
  pending.push(route);
  return { delivered: false, queued: true, pending: pending.length };
}

function markReady() {
  ready = true;
  const flushedRoutes = pending.splice(0);
  for (const route of flushedRoutes) emit(route);
  return { ready: true, flushed: flushedRoutes.length };
}

function status() { return { ready, pending: pending.length, routes: pending.slice() }; }

module.exports = { deepLinkService: { deliver, markReady, status } };
