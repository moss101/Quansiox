'use strict';
/**
 * Edges — the RPC surface, split into named edges.
 *
 * The reference implementation exposes seven schema-validated edges
 * (`main`, `gateway`, `coordinator-control`, `desktop-mount`, `sand-dev`,
 * `box-vnc`, `coordinator-main`) and routes calls on channels shaped like
 * `dune-rpc:<edge>:m:<method>`. The point of the edges is not the channel
 * name: it is that a caller can *ask what an edge can do*, and that a failure
 * on one edge cannot be confused with a failure on another.
 *
 * We keep the existing single routed channel working (nothing in the app
 * breaks) and add a second, edge-aware channel next to it. The envelope is
 * the reference's:
 *
 *   { ok: true,  value }
 *   { ok: false, failure: { code, detail } }
 *
 * with the reference's failure codes:
 *
 *   edge/unknown-edge · edge/unknown-method · edge/transport-failed
 *   edge/handler-failed · edge/rejected
 *
 * and one of our own: `edge/duplicate` is NOT an error — a repeated call
 * with the same nonce returns the FIRST call's result (W2.6).
 */
const { allHandlers, allSchemas, checkArgs } = require('./registry');
const { classify, CODE } = require('../../shared/errors');

/**
 * The edges, and the namespaces on each.
 *
 * A namespace belongs to exactly one edge. An edge is the unit a renderer
 * (or a future harness) reasons about: "what can the computer edge do?"
 */
const EDGES = {
  main: {
    description: 'the app shell: windows, settings, navigation, panels, files',
    namespaces: [
      'system', 'window', 'settings', 'desktop', 'navigation', 'panel', 'profile', 'profiles',
      'workspace', 'prompts', 'restore', 'updater', 'update', 'feedback', 'diagnostics', 'net',
      'flags', 'hostPrefs', 'playback', 'sessions', 'sessionExtras', 'groups', 'templates',
      'library', 'documents', 'attachments', 'artifacts',
    ],
  },
  agent: {
    description: 'the agent: runs, tasks, delegation, automations, artifacts',
    namespaces: [
      'agent', 'tasks', 'automations', 'agentFiles', 'agentPlugins', 'agentSkills',
      'broadcast', 'memory', 'webhooks', 'webhook',
      'agents', 'taskState', 'asyncTasks', 'transcriptCursor',
    ],
  },
  computer: {
    description: 'the machine: computer use, the browser, the sandbox, the screen',
    namespaces: [
      'computer', 'computerUse', 'sandbox', 'screen', 'browser', 'browserCookies',
      'capture', 'shell', 'shellSession', 'file', 'git', 'humanCapture', 'skill',
      'skills', 'addons', 'marketplace', 'mcp',
    ],
  },
  vault: {
    description: 'the secrets: the vault, the credentials, the integrations',
    namespaces: ['secrets', 'boxSecrets', 'onePassword', 'ecosystem'],
  },
  provider: {
    description: 'the outside world: accounts, repositories, messages, mail',
    namespaces: ['github', 'slack', 'email', 'messages', 'imessage'],
  },
  capabilities: {
    description: 'what this install can do, and what it decided',
    namespaces: ['permissions', 'consent', 'confirmations', 'interactions', 'notices', 'grok'],
  },
};

/** namespace -> edge name */
const namespaceEdge = new Map();
for (const [edge, spec] of Object.entries(EDGES)) {
  for (const ns of spec.namespaces) {
    if (namespaceEdge.has(ns)) {
      throw new Error(`namespace "${ns}" is claimed by two edges (${namespaceEdge.get(ns)} and ${edge})`);
    }
    namespaceEdge.set(ns, edge);
  }
}

/** The failure codes. */
const FAILURE = {
  UNKNOWN_EDGE: 'edge/unknown-edge',
  UNKNOWN_METHOD: 'edge/unknown-method',
  TRANSPORT_FAILED: 'edge/transport-failed',
  HANDLER_FAILED: 'edge/handler-failed',
  REJECTED: 'edge/rejected',
};

/**
 * Idempotency (W2.6).
 *
 * A mutating call carries a nonce. A repeated call with the same nonce
 * returns the first call's result instead of doing the work twice. This is
 * what makes a retry safe: without it, a retried "send this prompt" sends
 * two prompts.
 */
const idempotency = new Map();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const IDEMPOTENCY_LIMIT = 500;

function pruneIdempotency(now = Date.now()) {
  for (const [key, entry] of idempotency) {
    if (entry.at + IDEMPOTENCY_TTL_MS < now) idempotency.delete(key);
  }
  while (idempotency.size > IDEMPOTENCY_LIMIT) {
    const oldest = idempotency.keys().next().value;
    idempotency.delete(oldest);
  }
}

/**
 * Describe an edge: its methods, grouped by namespace.
 */
function describeEdge(edge) {
  const spec = EDGES[edge];
  if (!spec) return null;
  const methods = {};
  for (const ns of spec.namespaces) {
    const handlers = allHandlers[ns];
    if (!handlers) continue;
    methods[ns] = Object.keys(handlers).sort();
  }
  return { edge, description: spec.description, methods };
}

/** Describe every edge. */
function describeAll() {
  const out = {};
  for (const edge of Object.keys(EDGES)) out[edge] = describeEdge(edge);
  return out;
}

/** Which edge owns a namespace? */
function edgeOf(namespace) {
  return namespaceEdge.get(String(namespace)) ?? null;
}

/**
 * Attach a namespace to an edge.
 *
 * The registry is the source of truth for what exists; the edge map says
 * where it is reachable from. A namespace that is registered but not on an
 * edge is unreachable through the edge channel, so the two must be kept in
 * step — this function is how.
 */
function attachNamespace(edge, namespace) {
  const spec = EDGES[edge];
  if (!spec) throw new Error(`unknown edge: ${edge}`);
  const ns = String(namespace);
  const existing = namespaceEdge.get(ns);
  if (existing && existing !== edge) {
    throw new Error(`namespace "${ns}" is already on the "${existing}" edge`);
  }
  if (!spec.namespaces.includes(ns)) spec.namespaces.push(ns);
  namespaceEdge.set(ns, edge);
  return ns;
}

/**
 * Call a method on an edge.
 *
 * @param {string} edge
 * @param {string} route  `<namespace>:<method>`
 * @param {object} args
 * @param {object} [opts]
 * @param {string} [opts.nonce]  idempotency key
 * @param {object} [opts.event]   the ipc event, for sender checks
 * @returns {Promise<{ ok: boolean, value?: any, failure?: { code: string, detail: string } }>}
 */
async function call(edge, route, args = {}, opts = {}) {
  const spec = EDGES[edge];
  if (!spec) {
    return { ok: false, failure: { code: FAILURE.UNKNOWN_EDGE, detail: `unknown edge: ${edge}` } };
  }
  const separator = String(route ?? '').indexOf(':');
  if (separator < 0) {
    return { ok: false, failure: { code: FAILURE.UNKNOWN_METHOD, detail: `malformed route: ${route}` } };
  }
  const namespace = route.slice(0, separator);
  const method = route.slice(separator + 1);

  if (edgeOf(namespace) !== edge) {
    return {
      ok: false,
      failure: {
        code: FAILURE.UNKNOWN_METHOD,
        detail: `"${namespace}" is not on the "${edge}" edge (it is on "${edgeOf(namespace) ?? 'none'}")`,
      },
    };
  }
  const handlers = allHandlers[namespace];
  const fn = handlers && handlers[method];
  if (typeof fn !== 'function') {
    return { ok: false, failure: { code: FAILURE.UNKNOWN_METHOD, detail: `unknown method: ${route}` } };
  }

  const schema = allSchemas[namespace]?.[method];
  if (schema) {
    const problem = typeof schema === 'function' ? schema([args]) : checkArgs(schema, [args]);
    if (problem) {
      return { ok: false, failure: { code: FAILURE.REJECTED, detail: problem } };
    }
  }

  // Idempotency: a repeated call with the same nonce replays the first result.
  const nonce = opts.nonce ? String(opts.nonce) : null;
  if (nonce) {
    pruneIdempotency();
    const key = `${edge}:${route}:${nonce}`;
    const existing = idempotency.get(key);
    if (existing) {
      return existing.result;
    }
  }

  try {
    const value = await fn(opts.event, args);
    const envelope = { ok: true, value };
    if (nonce) {
      const key = `${edge}:${route}:${nonce}`;
      idempotency.set(key, { at: Date.now(), result: envelope });
    }
    return envelope;
  } catch (error) {
    const classified = classify(error);
    const code = classified.code === CODE.INTERNAL ? FAILURE.HANDLER_FAILED : FAILURE.HANDLER_FAILED;
    return {
      ok: false,
      failure: {
        code,
        detail: classified.message,
        // The taxonomy code travels alongside, so a caller can tell a timeout
        // from a refusal from a bug.
        kind: classified.code,
        retryable: classified.retryable,
        needsUser: classified.needsUser,
      },
    };
  }
}

module.exports = {
  EDGES,
  FAILURE,
  attachNamespace,
  call,
  describeAll,
  describeEdge,
  edgeOf,
  namespaceEdge,
  pruneIdempotency,
};
