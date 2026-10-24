'use strict';
/**
 * Computer pool — per-session guest leases for the unified runtime. Lets each
 * delegated child (computer-use / browser) acquire its OWN guest instead of
 * sharing the parent's, with a concurrency cap and reference-counted release
 * (a session shared by siblings leaks one guest; the last release reaps it).
 *
 * The factory (boot + attach a guest) is injectable → the lease/cap/reap logic
 * is unit-tested offline. The default factory boots the real per-session Linux
 * guest through `computerRuntimeService`; it is installed at app boot by
 * `src/main/index.js`, so `acquire()` works in production and not only in
 * tests. A test can override it with `setFactory()`.
 */
let factory = null; // (sessionId) => Promise<{ sessionId, close?: () => void }>
function setFactory(fn) { factory = typeof fn === 'function' ? fn : null; }

/**
 * Install the production factory: boot the session's own guest desktop and
 * tear it down when the last lease is released.
 *
 * The require is lazy so `computerPool` stays usable in a plain-node test
 * harness (no Electron, no VM).
 */
function installDefaultFactory() {
  setFactory(async (sessionId) => {
    const { computerRuntimeService } = require('./computerRuntimeService');
    await computerRuntimeService.ensure(sessionId, { reason: 'computer-pool' });
    return {
      sessionId,
      close: () => {
        try { computerRuntimeService.stop(sessionId); } catch { /* best effort */ }
      },
    };
  });
  return factory;
}

const leases = new Map(); // sessionId -> { refCount, lease, startedAt }
let CAP = 4;
function cap(n) { if (n) CAP = Math.max(1, Number(n) || CAP); return CAP; }

async function acquire(sessionId) {
  const sid = String(sessionId ?? '');
  if (!sid) throw new Error('computer pool needs a session id');
  const cur = leases.get(sid);
  if (cur) { cur.refCount += 1; return cur.lease; }
  if (leases.size >= CAP) throw new Error(`computer pool is full (${CAP} guests live); release one first`);
  if (!factory) {
    // Production boot installs the default factory; a harness that did not is
    // a programming error, not a runtime condition to paper over.
    installDefaultFactory();
  }
  const lease = await factory(sid);
  leases.set(sid, { refCount: 1, lease, startedAt: Date.now() });
  return lease;
}

function release(sessionId) {
  const sid = String(sessionId ?? '');
  const cur = leases.get(sid);
  if (!cur) return false;
  cur.refCount -= 1;
  if (cur.refCount <= 0) {
    try { cur.lease?.close?.(); } catch {}
    leases.delete(sid);
  }
  return true;
}

function list() {
  return [...leases.values()].map((l) => ({ sessionId: l.lease?.sessionId ?? null, refCount: l.refCount, uptimeMs: Date.now() - l.startedAt }));
}
function get(sessionId) { return leases.get(String(sessionId))?.lease || null; }
function reapAll() { for (const sid of [...leases.keys()]) { const l = leases.get(sid); try { l.lease?.close?.(); } catch {} leases.delete(sid); } }

module.exports = { computerPool: { acquire, release, list, get, cap, reapAll, setFactory, installDefaultFactory } };
