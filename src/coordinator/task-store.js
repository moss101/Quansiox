'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { settingsService } = require('../main/services/settingsService');
const ACTIVE = new Set(['queued', 'running', 'stopping']);
function directory() {
  const profile = process.env.QUANSIOX_USER_DATA_DIR || require('electron').app.getPath('userData');
  return path.join(profile, 'tasks');
}
function file(id) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id || '')) throw new Error('invalid task id');
  return path.join(directory(), `${id}.json`);
}
/**
 * Read a task record.
 * @returns {object|null} null when the task does not exist — a missing task
 *   is an answer, not an exception, so a caller can report it honestly.
 */
function get(id, parentSessionId) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (parentSessionId && record.parentSessionId !== parentSessionId) throw new Error('task belongs to another session');
  return record;
}
function save(record) {
  const dest = file(record.id);
  fs.mkdirSync(directory(), { recursive: true });
  const temporary = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...record, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, dest);
  return record;
}
function persist(job) {
  return save({
    schemaVersion: 1, id: job.id, parentSessionId: job.parentSessionId,
    parentToolCallId: job.parentToolCallId, forkedFrom: job.forkedFrom || null,
    title: job.title, description: job.description, prompt: job.prompt,
    name: job.name, type: job.type, team: job.team || '', background: job.background,
    model: job.model || settingsService.load().model,
    environment: job.environment || 'shared', toolSessionId: job.toolSessionId,
    browserSessionId: job.browserSessionId || job.id,
    depth: job.depth || 0,
    runSessionId: job.runSessionId || null,
    abortRoot: job.abortRoot || null,
    workspaceRoot: job.workspaceRoot || null,
    policy: job.policy, messages: job.messages || [],
    modelParameters: job.modelParameters || null,
    selectedContext: job.selectedContext || '',
    maxLoops: job.maxLoops ?? null,
    nudgeMessage: job.nudgeMessage || null,
    agentId: job.agentId || null,
    dependencyContext: job.dependencyContext || null,
    worktree: job.worktree || null,
    readonly: !!job.readonly,
    status: job.status, summary: job.summary || '', fileResults: job.fileResults || [],
    aborted: !!job.aborted, errored: !!job.errored,
    createdAt: job.createdAt || Date.now(), runAttempt: job.runAttempt || 1,
    error: job.error || null,
  });
}
function list(parentSessionId) {
  fs.mkdirSync(directory(), { recursive: true });
  return fs.readdirSync(directory()).filter((name) => name.endsWith('.json')).map((name) => {
    try { return get(name.slice(0, -5)); } catch { return null; }
  }).filter((record) => record && (!parentSessionId || record.parentSessionId === parentSessionId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Record a question a child asked its parent (`wake_parent`).
 *
 * The question is stored on the parent's task record so a later turn (or
 * a resume) can see what the child was blocked on, even if the live
 * steering channel is gone.
 */
function recordWake(parentSessionId, payload) {
  const id = `wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const record = {
    schemaVersion: 1,
    id,
    parentSessionId: parentSessionId || null,
    kind: 'wake',
    question: String(payload?.question ?? '').slice(0, 4000),
    context: String(payload?.context ?? '').slice(0, 2000),
    agentId: payload?.id ?? null,
    createdAt: Date.now(),
  };
  try { save(record); } catch { /* the store is best-effort */ }
  return record;
}
function summaries(parentSessionId) {
  return list(parentSessionId).map(({ messages, policy, prompt, ...record }) => record);
}
function recover() {
  for (const record of list()) {
    if (ACTIVE.has(record.status)) save({ ...record, status: 'interrupted', error: 'Coordinator stopped before this task finished. Resume to continue.', errored: false });
  }
}
function continuation(record, prompt) {
  const messages = structuredClone(record.messages || []);
  // A crash can occur between recording a call and its tool response. Keep the
  // provider conversation valid without replaying an uncertain side effect.
  for (let i = 0; i < messages.length; i += 1) {
    const turn = messages[i];
    if (turn.role !== 'assistant' || !turn.tool_calls?.length) continue;
    let end = i + 1;
    while (messages[end]?.role === 'tool') end += 1;
    const received = new Set(messages.slice(i + 1, end).map((t) => t.tool_call_id));
    const missing = turn.tool_calls.filter((call) => !received.has(call.id));
    messages.splice(end, 0, ...missing.map((call) => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: 'Execution was interrupted before its result was persisted. Inspect current state before repeating any side effect.' })));
  }
  messages.push({ role: 'user', content: String(prompt || 'Continue this task from its recorded state.').trim() });
  return messages;
}
module.exports = { taskStore: { get, save, persist, list, summaries, recover, continuation, recordWake, ACTIVE } };
