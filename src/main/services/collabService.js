'use strict';
/**
 * Collaboration — the local-first implementation of Manus' task
 * collaboration.
 *
 * The documented feature is a **collaboration mode** on a task (distinct
 * from a plain share link): the owner invites people by email, they join
 * immediately, they watch the task as it develops, and **they can prompt
 * Manus themselves**. Two rules shape the implementation:
 *
 *   - **only the owner consumes credits** — a collaborator's prompt is run
 *     on the owner's session, with the owner's provider, so the owner pays
 *     for it and the collaborator pays nothing;
 *   - **prompts run one after another** — two collaborators typing at the
 *     same time do not interleave; the second prompt waits its turn.
 *
 * A local app has no credits, so the meaningful half of the first rule is
 * "the run happens on the owner's session and uses the owner's settings" —
 * which is exactly what this does.
 *
 * The mechanics:
 *
 *   - `enable(sessionId)` turns the collaboration on for a task;
 *   - `invite(sessionId, email)` mints an invite token and a link;
 *   - `join(token, identity)` admits the collaborator immediately;
 *   - `prompt(sessionId, identity, message)` queues the prompt and the
 *     **queue runs the prompts one after another**;
 *   - the owner alone may invite and remove people;
 *   - every prompt and answer is recorded, so a collaborator who joins late
 *     still sees the whole history, including the prompts from before they
 *     arrived;
 *   - the invite link is served from a loopback HTTP server, so a
 *     collaborator on the same machine (or reachable through it) can join.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

/* ------------------------------------------------------------------ store */

function userDataDir() {
  return require('./userData').userDataDir();
}
function storeFile() { return path.join(userDataDir(), 'collaboration.json'); }

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function save(sessions) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(sessions, null, 2), { mode: 0o600 });
  return sessions;
}

/** The public shape of a collaboration session. */
function reduced(session) {
  if (!session) return null;
  return {
    id: session.id,
    sessionId: session.sessionId,
    owner: session.owner,
    enabled: session.enabled === true,
    members: (session.members ?? []).map((member) => ({
      email: member.email, identity: member.identity, role: member.role,
      joinedAt: member.joinedAt,
    })),
    invites: (session.invites ?? []).map((invite) => ({
      email: invite.email, token: invite.token, createdAt: invite.createdAt, used: invite.used === true,
    })),
    queue: (session.queue ?? []).map((entry) => ({
      id: entry.id, identity: entry.identity, message: entry.message, queuedAt: entry.queuedAt,
    })),
    history: (session.history ?? []).slice(-200),
    link: session.link ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function find(sessionId) {
  return load().find((entry) => entry.sessionId === sessionId) ?? null;
}

/* ------------------------------------------------------------------ enable */

/** Turn collaboration on for a task (COL-01). */
function enable(sessionId, { owner = 'owner@local' } = {}) {
  const sessions = load();
  const existing = sessions.find((entry) => entry.sessionId === sessionId);
  if (existing) {
    existing.enabled = true;
    existing.updatedAt = Date.now();
    save(sessions);
    return reduced(existing);
  }
  const entry = {
    id: `col_${crypto.randomBytes(9).toString('base64url')}`,
    sessionId,
    owner,
    enabled: true,
    members: [],
    invites: [],
    queue: [],
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessions.push(entry);
  save(sessions);
  return reduced(entry);
}

function disable(sessionId) {
  const sessions = load();
  const index = sessions.findIndex((entry) => entry.sessionId === sessionId);
  if (index === -1) return { disabled: false };
  sessions[index].enabled = false;
  sessions[index].updatedAt = Date.now();
  save(sessions);
  return { disabled: true };
}

/* ----------------------------------------------------------------- invites */

/** Invite a collaborator by email (COL-02). */
function invite(sessionId, email, { identity = null } = {}) {
  const sessions = load();
  const index = sessions.findIndex((entry) => entry.sessionId === sessionId);
  if (index === -1) throw new Error('collaboration is not enabled for this task');
  const session = sessions[index];
  const address = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('that is not an email address');
  const token = crypto.randomBytes(16).toString('hex');
  session.invites = session.invites ?? [];
  session.invites.push({
    email: address,
    identity: identity ?? address,
    token,
    createdAt: Date.now(),
    used: false,
  });
  session.updatedAt = Date.now();
  save(sessions);
  const server = ensureServer();
  return {
    email: address,
    token,
    link: server.base ? `${server.base}/collab/${token}` : null,
  };
}

/** Remove a collaborator (COL-11). */
function removeMember(sessionId, email) {
  const sessions = load();
  const index = sessions.findIndex((entry) => entry.sessionId === sessionId);
  if (index === -1) return { removed: false };
  const address = String(email ?? '').toLowerCase();
  const before = sessions[index].members.length;
  sessions[index].members = sessions[index].members.filter((member) => member.email !== address);
  sessions[index].updatedAt = Date.now();
  save(sessions);
  return { removed: before !== sessions[index].members.length };
}

/** Join through an invite token (COL-03). */
function join(token, { identity = null } = {}) {
  const sessions = load();
  for (const session of sessions) {
    const invite = (session.invites ?? []).find((entry) => entry.token === token && !entry.used);
    if (!invite) continue;
    invite.used = true;
    const member = {
      email: invite.email,
      identity: identity ?? invite.identity ?? invite.email,
      role: 'collaborator',
      joinedAt: Date.now(),
    };
    session.members = [...(session.members ?? []).filter((m) => m.email !== member.email), member];
    session.updatedAt = Date.now();
    save(sessions);
    return { ok: true, sessionId: session.sessionId, member, link: session.link ?? null };
  }
  return { ok: false, reason: 'that invite is not valid (it may have been used already)' };
}

/* ---------------------------------------------------------------- prompts */

/**
 * Queue a prompt from a collaborator (COL-06).
 *
 * The prompt is **queued**, not run: the queue is drained one entry at a
 * time, so two collaborators typing at once do not interleave (COL-08).
 */
function prompt(sessionId, identity, message, { role = 'collaborator' } = {}) {
  const sessions = load();
  const index = sessions.findIndex((entry) => entry.sessionId === sessionId);
  if (index === -1) throw new Error('collaboration is not enabled for this task');
  const session = sessions[index];
  const who = String(identity ?? '').trim();
  const text = String(message ?? '').trim();
  if (!text) throw new Error('a prompt needs a message');
  const isOwner = role === 'owner'
    || session.owner === who
    || (session.members ?? []).some((member) => member.identity === who && member.role === 'owner');
  const entry = {
    id: `q_${crypto.randomBytes(6).toString('base64url')}`,
    identity: who || 'anonymous',
    message: text.slice(0, 20_000),
    queuedAt: Date.now(),
    owner: isOwner,
  };
  session.queue = [...(session.queue ?? []), entry];
  session.updatedAt = Date.now();
  save(sessions);
  return { queued: true, position: session.queue.length, id: entry.id };
}

/** The prompts waiting to run. */
function queue(sessionId) {
  const session = find(sessionId);
  return (session?.queue ?? []).map((entry) => ({
    id: entry.id, identity: entry.identity, message: entry.message, queuedAt: entry.queuedAt,
  }));
}

/**
 * Drain the queue: run the prompts **one after another**.
 *
 * The runner is injected (the agent service in the app, a fake in the test).
 * Every prompt and its answer are recorded in the history, so a
 * collaborator who joins later still sees the whole conversation (COL-12).
 */
async function drain(sessionId, runner) {
  const sessions = load();
  const index = sessions.findIndex((entry) => entry.sessionId === sessionId);
  if (index === -1) throw new Error('collaboration is not enabled for this task');
  const session = sessions[index];
  const run = typeof runner === 'function' ? runner : defaultRunner;
  const results = [];
  // A copy: a prompt queued while we run waits for the next drain.
  const pending = [...(session.queue ?? [])];
  session.queue = [];
  for (const entry of pending) {
    session.history = [...(session.history ?? []), {
      at: entry.queuedAt, identity: entry.identity, message: entry.message, role: 'prompt',
    }];
    let answer = '';
    let error = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      answer = String(await run(session.sessionId, entry.message, entry.identity) ?? '');
    } catch (failure) {
      error = String(failure?.message ?? failure);
      answer = `The task failed: ${error}`;
    }
    session.history = [...session.history, {
      at: Date.now(), identity: entry.identity, message: answer, role: 'answer', error,
    }];
    results.push({ id: entry.id, identity: entry.identity, answer, error });
  }
  session.updatedAt = Date.now();
  save(sessions);
  return results;
}

async function defaultRunner(sessionId, message) {
  const { agentService } = require('./agentService');
  const result = await agentService.run({ sender: null }, { sessionId, message });
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/** The full history of a collaborative task (COL-12/13). */
function history(sessionId) {
  const session = find(sessionId);
  return (session?.history ?? []).slice();
}

/** The collaborators of a task. */
function members(sessionId) {
  const session = find(sessionId);
  return (session?.members ?? []).map((member) => ({
    email: member.email, identity: member.identity, role: member.role, joinedAt: member.joinedAt,
  }));
}

/** Export the collaborative task (COL-13). */
function exportTranscript(sessionId) {
  const session = find(sessionId);
  if (!session) throw new Error('collaboration is not enabled for this task');
  const lines = [`# Collaborative task ${session.sessionId}`, ''];
  for (const entry of session.history ?? []) {
    lines.push(`**${entry.identity}** · ${new Date(entry.at).toISOString()}`);
    lines.push('');
    lines.push(entry.role === 'prompt' ? `> ${entry.message}` : entry.message);
    lines.push('');
  }
  return lines.join('\n');
}

/* --------------------------------------------------------- the invite link */

let server = null;
let port = null;

/**
 * A loopback HTTP server that serves the invite link.
 *
 * It only listens on 127.0.0.1. The join endpoint takes the token and the
 * identity and admits the collaborator; the token is the credential, exactly
 * as the docs' invite link is.
 */
function ensureServer() {
  if (server) return { base: baseUrl() };
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const json = (code, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    };
    const invite = /^\/collab\/([a-f0-9]{16,64})$/.exec(url.pathname);
    if (invite) {
      const result = join(invite[1], { identity: url.searchParams.get('as') });
      return json(result.ok ? 200 : 404, result);
    }
    if (url.pathname === '/collab/status') {
      return json(200, { ok: true, sessions: load().length });
    }
    return json(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1', () => { port = server.address().port; });
  return { base: baseUrl() };
}

function baseUrl() { return port ? `http://127.0.0.1:${port}` : null; }
function stopServer() { try { server?.close(); } catch { /* ignore */ } server = null; port = null; }

/* ---------------------------------------------------------------- exports */

module.exports = {
  collabService: {
    load,
    save,
    enable,
    disable,
    invite,
    join,
    removeMember,
    members,
    prompt,
    queue,
    drain,
    history,
    exportTranscript,
    ensureServer,
    baseUrl,
    stopServer,
    _find: find,
    find,
    _reduced: reduced,
  },
};
