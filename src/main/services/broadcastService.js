'use strict';
/**
 * Broadcast & roster service — fan a single message out to many agent sessions
 * concurrently (Grok broadcastToAgents), plus a roster snapshot
 * (getServerAgentRoster). Local-first: each target session runs its own headless
 * agent turn in parallel via the injectable runner; the real app injects
 * agentService.run; tests inject a fake. State lives in sessionService + taskStore,
 * so a broadcast is just N concurrent runs keyed by session id.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONCURRENCY_CAP = 8;

let runFn = null; // (sessionId, message) => Promise<result>
function setRunner(fn) { runFn = typeof fn === 'function' ? fn : null; }

async function defaultRun(sessionId, message) {
  const { agentService } = require('./agentService');
  return agentService.run({ sender: null }, { sessionId, message });
}

function sessionsService() { return require('./sessionService').sessionService; }

/** Normalize the group of recipients: explicit ids or a count of fresh sessions. */
function resolveTargets({ sessionIds, agents, count, prefix = 'bcast' }) {
  const ids = [];
  if (Array.isArray(sessionIds)) ids.push(...sessionIds.map(String));
  if (Array.isArray(agents)) for (const a of agents) ids.push(String(a?.sessionId ?? a?.agentId ?? a?.id ?? a));
  const n = Number(count) || 0;
  for (let i = 0; i < n; i += 1) ids.push(`${prefix}-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`);
  const unique = [...new Set(ids)].filter((id) => ID_RE.test(id));
  if (!unique.length) throw new Error('broadcast needs sessionIds, agents, or count');
  return unique;
}

function roster() {
  return { agents: sessionsService().list(), generatedAt: Date.now() };
}

/** A compact task: run N message strings, keep ≤ cap in flight. */
async function pool(items, worker, cap = CONCURRENCY_CAP) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(cap, items.length) }, async () => {
    while (next < items.length) {
      const i = next; next += 1;
      try { results[i] = { status: 'ok', index: i, ...(await worker(items[i], i)) }; }
      catch (error) { results[i] = { status: 'error', index: i, error: String(error?.message ?? error) }; }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Broadcast a message to each target session concurrently.
 * Each recipient gets a self-contained message (a broadcast fan-out, not a
 * shared transcript). Returns a per-session result map.
 */
async function broadcast({ message, ...opts } = {}) {
  const text = String(message ?? '').trim();
  if (!text) throw new Error('broadcast needs a message');
  const targets = resolveTargets(opts);
  for (const id of targets) { try { sessionsService().ensure(id); } catch {} }
  const runner = runFn || defaultRun;
  const rows = await pool(targets, async (sid) => {
    try {
      const result = await runner(sid, text);
      const summary = typeof result === 'string' ? result : result?.text ?? result?.summary ?? '';
      return { sessionId: sid, status: 'ok', summary: String(summary).slice(0, 400) };
    } catch (error) {
      return { sessionId: sid, status: 'error', error: String(error?.message ?? error) };
    }
  });
  const ok = rows.filter((r) => r.status === 'ok').length;
  return { recipients: targets.length, ok, errored: targets.length - ok, results: rows };
}

/** Same fan-out but fire-and-track: returns ids immediately; poll via roster. */
function broadcastBackground({ message, ...opts } = {}) {
  const text = String(message ?? '').trim();
  const targets = resolveTargets(opts);
  const promise = broadcast({ message: text, ...opts }).catch(() => {});
  return { recipients: targets.length, started: targets.length, bcastId: `bcast-${Date.now().toString(36)}`, _promise: promise };
}

module.exports = {
  broadcastService: { broadcast, broadcastBackground, roster, setRunner, resolveTargets },
  CONCURRENCY_CAP,
};
