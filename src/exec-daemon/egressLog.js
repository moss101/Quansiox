'use strict';
/**
 * The egress audit log — a record of what the sandbox tried to reach.
 *
 * The reference implementation has a `capture_denies` flag on its sandbox
 * policy: when it is set, the sandbox records the operations it refused.
 * We always record the proxy's decisions, because a command that keeps
 * trying to reach a denied host is exactly the thing a user needs to see.
 *
 * The log is appended to the exec daemon's log file as JSON lines, so it
 * rides along with the daemon's own diagnostics.
 */
const MAX_ENTRIES = 500;
const entries = [];

function record(decision) {
  const entry = {
    at: Date.now(),
    host: decision?.host ?? null,
    allowed: decision?.allowed === true,
    reason: decision?.reason ?? null,
  };
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();
  try {
    const { appendFileSync } = require('node:fs');
    const logPath = process.env.QUANSIOX_EXEC_DAEMON_LOG;
    if (logPath) appendFileSync(logPath, `${JSON.stringify({ egress: entry })}\n`);
  } catch { /* the audit trail is best-effort */ }
  return entry;
}

function list(limit = 100) {
  return entries.slice(-Math.max(1, Math.min(Number(limit) || 100, MAX_ENTRIES)));
}

function clear() {
  entries.length = 0;
}

module.exports = { egressLog: { clear, list, record } };
