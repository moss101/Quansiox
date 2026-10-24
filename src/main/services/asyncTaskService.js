'use strict';
/**
 * Async tasks — the registry for long-running background work.
 *
 * The reference implementation separates subagents from "async tasks"
 * (`getSubagents` and `getAsyncTasks` are different surfaces). The difference
 * matters: a subagent is a *conversation* that is running; an async task is
 * *work* that is running — a twenty-minute build, a long crawl, a batch
 * render. The user wants to see the second kind as a progress row, not as a
 * chat participant.
 *
 * Quansiox already promotes a long shell command to a background job, but the
 * job was invisible beyond the transcript. This registry makes background
 * work a first-class, durable, observable thing.
 *
 * Stored 0600. Electron-free.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const MAX_TASKS = 200;

/** The lifecycle. */
const STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'async-tasks.json'); }

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) {
      return { version: VERSION, tasks: parsed.tasks };
    }
  } catch {}
  return { version: VERSION, tasks: [] };
}

function writeAll(store) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Register a new async task. */
function create(input = {}) {
  const store = readAll();
  if (store.tasks.length >= MAX_TASKS) throw new Error(`too many async tasks (max ${MAX_TASKS})`);
  const now = Date.now();
  const task = {
    id: String(input.id ?? `at-${crypto.randomUUID().slice(0, 8)}`),
    kind: String(input.kind ?? 'work').slice(0, 40),
    title: String(input.title ?? '').trim().slice(0, 200),
    status: STATUS.QUEUED,
    progress: 0,
    outputTail: '',
    error: null,
    sessionId: String(input.sessionId ?? ''),
    agentId: String(input.agentId ?? ''),
    // The handle the work itself is keyed by (a shell id, a job id).
    handle: String(input.handle ?? ''),
    cancellable: input.cancellable !== false,
    createdAtMs: now,
    startedAtMs: null,
    finishedAtMs: null,
  };
  store.tasks.push(task);
  writeAll(store);
  return task;
}

function get(id) {
  return readAll().tasks.find((t) => t.id === String(id)) ?? null;
}

/** Update a task's progress or status. */
function update(id, patch = {}) {
  const store = readAll();
  const index = store.tasks.findIndex((t) => t.id === String(id));
  if (index < 0) throw new Error(`unknown async task: ${id}`);
  const task = { ...store.tasks[index] };
  if (patch.status != null) {
    const status = String(patch.status);
    if (!Object.values(STATUS).includes(status)) throw new Error(`invalid async task status: ${status}`);
    task.status = status;
    if (status === STATUS.RUNNING && !task.startedAtMs) task.startedAtMs = Date.now();
    if (status === STATUS.SUCCEEDED || status === STATUS.FAILED || status === STATUS.CANCELLED) {
      task.finishedAtMs = Date.now();
    }
  }
  if (patch.progress != null) task.progress = Math.max(0, Math.min(1, Number(patch.progress) || 0));
  if (patch.outputTail != null) task.outputTail = String(patch.outputTail).slice(-4000);
  if (patch.error != null) task.error = String(patch.error).slice(0, 1000);
  if (patch.title != null) task.title = String(patch.title).slice(0, 200);
  store.tasks[index] = task;
  writeAll(store);
  return task;
}

/** The tasks of a session, newest first. */
function list({ sessionId, includeFinished = true } = {}) {
  const tasks = readAll().tasks;
  const filtered = tasks.filter((t) => (sessionId ? t.sessionId === String(sessionId) : true));
  const kept = includeFinished
    ? filtered
    : filtered.filter((t) => t.status === STATUS.QUEUED || t.status === STATUS.RUNNING);
  return kept.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** The tasks still running. */
function active() {
  return list({ includeFinished: false });
}

/** Forget the finished tasks older than `maxAgeMs`. */
function prune(maxAgeMs = 24 * 60 * 60 * 1000) {
  const store = readAll();
  const cutoff = Date.now() - maxAgeMs;
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => {
    if (t.status === STATUS.QUEUED || t.status === STATUS.RUNNING) return true;
    return (t.finishedAtMs ?? t.createdAtMs) > cutoff;
  });
  writeAll(store);
  return { removed: before - store.tasks.length };
}

module.exports = {
  asyncTaskService: { STATUS, active, create, get, list, prune, update },
};
