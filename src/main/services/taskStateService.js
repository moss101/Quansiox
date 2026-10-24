'use strict';
/**
 * Task state — the durable task list the agent maintains.
 *
 * The reference implementation separates two things that are easy to
 * conflate:
 *
 *   - a **task** — a todo item the agent owns: `{ id, title, state, note }`,
 *     with a `seen_done_at_ms` so the agent can tell the user about a task
 *     it finished exactly once;
 *   - an **agent task** — a named piece of work on an agent: `{ id, name,
 *     description, status, updated_at_ms, pinned_at_ms }`.
 *
 * Plus a per-scope "state" blob the agent can update in one call
 * (`UpdateState`).
 *
 * Quansiox already has a *subagent* task store (the child's run record);
 * this is the other thing: the checklist the user sees. It is durable,
 * survives a restart, and is per-agent or per-session.
 *
 * Stored 0600. Electron-free.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const MAX_TASKS = 500;

/** The task states, mirroring the reference's lifecycle. */
const STATE = {
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  BLOCKED: 'blocked',
  DONE: 'done',
  CANCELLED: 'cancelled',
};
const STATES = Object.values(STATE);

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'agent-tasks.json'); }

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        version: VERSION,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        agentTasks: Array.isArray(parsed.agentTasks) ? parsed.agentTasks : [],
        state: parsed.state && typeof parsed.state === 'object' ? parsed.state : {},
      };
    }
  } catch {}
  return { version: VERSION, tasks: [], agentTasks: [], state: {} };
}

function writeAll(store) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** The scope a task belongs to: an agent id, or a session id. */
function scopeOf(input = {}) {
  return String(input.agentId ?? input.scope ?? input.sessionId ?? 'global');
}

/* ---------------- tasks (the checklist) ---------------- */

/** Create a task. */
function createTask(input = {}) {
  const store = readAll();
  if (store.tasks.length >= MAX_TASKS) throw new Error(`too many tasks (max ${MAX_TASKS})`);
  const now = Date.now();
  const task = {
    id: String(input.id ?? `tsk-${crypto.randomUUID().slice(0, 8)}`),
    scope: scopeOf(input),
    title: String(input.title ?? input.name ?? '').trim().slice(0, 300),
    state: STATES.includes(input.state) ? input.state : STATE.TODO,
    note: String(input.note ?? '').slice(0, 4000),
    createdAtMs: now,
    doneAtMs: input.state === STATE.DONE ? now : null,
    seenDoneAtMs: null,
    pinnedAtMs: input.pinned ? now : null,
  };
  if (!task.title) throw new Error('a task needs a title');
  store.tasks.push(task);
  writeAll(store);
  return task;
}

function getTask(id) {
  return readAll().tasks.find((t) => t.id === String(id)) ?? null;
}

/** Update a task's state, note, title or pin. */
function updateTask(id, patch = {}) {
  const store = readAll();
  const index = store.tasks.findIndex((t) => t.id === String(id));
  if (index < 0) throw new Error(`unknown task: ${id}`);
  const task = { ...store.tasks[index] };
  if (patch.title != null) task.title = String(patch.title).slice(0, 300);
  if (patch.note != null) task.note = String(patch.note).slice(0, 4000);
  if (patch.state != null) {
    if (!STATES.includes(patch.state)) throw new Error(`invalid task state: ${patch.state}`);
    task.state = patch.state;
    task.doneAtMs = patch.state === STATE.DONE ? Date.now() : null;
    if (patch.state === STATE.DONE) task.seenDoneAtMs = task.seenDoneAtMs ?? null;
  }
  if (patch.pinned !== undefined) task.pinnedAtMs = patch.pinned ? Date.now() : null;
  store.tasks[index] = task;
  writeAll(store);
  return task;
}

/** Mark a finished task as seen (so the user is told once). */
function markSeen(id) {
  const store = readAll();
  const index = store.tasks.findIndex((t) => t.id === String(id));
  if (index < 0) throw new Error(`unknown task: ${id}`);
  store.tasks[index].seenDoneAtMs = Date.now();
  writeAll(store);
  return store.tasks[index];
}

function deleteTask(id) {
  const store = readAll();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => t.id !== String(id));
  writeAll(store);
  return { id: String(id), removed: store.tasks.length !== before };
}

/** The tasks of a scope, pinned first, then newest first. */
function listTasks({ scope, agentId, sessionId, includeDone = true } = {}) {
  const wanted = scope ?? agentId ?? sessionId;
  const tasks = readAll().tasks.filter((t) => (wanted ? t.scope === String(wanted) : true));
  const filtered = includeDone ? tasks : tasks.filter((t) => t.state !== STATE.DONE && t.state !== STATE.CANCELLED);
  return filtered.sort((a, b) => {
    if (Boolean(a.pinnedAtMs) !== Boolean(b.pinnedAtMs)) return a.pinnedAtMs ? -1 : 1;
    return b.createdAtMs - a.createdAtMs;
  });
}

/* ---------------- agent tasks (named work on an agent) ---------------- */

/** Create an agent task. */
function createAgentTask(input = {}) {
  const store = readAll();
  const now = Date.now();
  const task = {
    id: String(input.id ?? `atk-${crypto.randomUUID().slice(0, 8)}`),
    agentId: String(input.agentId ?? input.agent_id ?? ''),
    name: String(input.name ?? '').trim().slice(0, 200),
    description: String(input.description ?? '').slice(0, 2000),
    status: String(input.status ?? 'open').slice(0, 40),
    updatedAtMs: now,
    unreadEntryId: null,
    unreadPreview: null,
    unreadAtMs: null,
    pinnedAtMs: input.pinned ? now : null,
  };
  if (!task.name) throw new Error('an agent task needs a name');
  store.agentTasks.push(task);
  writeAll(store);
  return task;
}

function getAgentTask(id) {
  return readAll().agentTasks.find((t) => t.id === String(id)) ?? null;
}

function updateAgentTask(id, patch = {}) {
  const store = readAll();
  const index = store.agentTasks.findIndex((t) => t.id === String(id));
  if (index < 0) throw new Error(`unknown agent task: ${id}`);
  const task = { ...store.agentTasks[index] };
  if (patch.name != null) task.name = String(patch.name).slice(0, 200);
  if (patch.description != null) task.description = String(patch.description).slice(0, 2000);
  if (patch.status != null) task.status = String(patch.status).slice(0, 40);
  if (patch.unreadPreview != null) {
    task.unreadPreview = String(patch.unreadPreview).slice(0, 400);
    task.unreadAtMs = Date.now();
  }
  if (patch.pinned !== undefined) task.pinnedAtMs = patch.pinned ? Date.now() : null;
  task.updatedAtMs = Date.now();
  store.agentTasks[index] = task;
  writeAll(store);
  return task;
}

function listAgentTasks({ agentId } = {}) {
  const tasks = readAll().agentTasks;
  return (agentId ? tasks.filter((t) => t.agentId === String(agentId)) : tasks)
    .sort((a, b) => {
      if (Boolean(a.pinnedAtMs) !== Boolean(b.pinnedAtMs)) return a.pinnedAtMs ? -1 : 1;
      return b.updatedAtMs - a.updatedAtMs;
    });
}

/* ---------------- the state blob ---------------- */

/**
 * Update a scope's state blob (the reference's `UpdateState`).
 * The blob is a small structured summary the agent can rewrite.
 */
function updateState({ scope, agentId, sessionId, state } = {}) {
  const store = readAll();
  const key = scopeOf({ scope, agentId, sessionId });
  const current = store.state[key] ?? { data: {}, updatedAtMs: 0 };
  const next = {
    data: state && typeof state === 'object' ? state : {},
    updatedAtMs: Date.now(),
  };
  store.state[key] = next;
  writeAll(store);
  return { scope: key, ...next };
}

function getState({ scope, agentId, sessionId } = {}) {
  const key = scopeOf({ scope, agentId, sessionId });
  const found = readAll().state[key];
  return { scope: key, data: found?.data ?? {}, updatedAtMs: found?.updatedAtMs ?? 0 };
}

module.exports = {
  taskStateService: {
    STATE, STATES,
    createAgentTask, createTask, deleteTask, getAgentTask, getState, getTask,
    listAgentTasks, listTasks, markSeen, updateAgentTask, updateState, updateTask,
  },
};
