'use strict';
/* Transcript surface — real paging/window/tail/thread/todos/rollback and
 * task pinning (Grok 0.71: getAgentTranscript{Page,Window,Tail}, getAgentThread,
 * getAgentTodos, rollBackConversation, markAgentTaskDone, setAgentTaskPinned).
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-transcript-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { sessionService } = require('../src/main/services/sessionService');
const { transcriptService } = require('../src/main/services/transcriptService');
const { taskStore } = require('../src/coordinator/task-store');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

const plan = (steps) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ steps }) } }],
});

(async () => {
  const id = 'sess-transcript-test';
  sessionService.ensure(id);
  sessionService.appendTurn(id, { role: 'user', content: 'Build a landing page' });
  sessionService.appendTurn(id, plan([{ title: 'Draft', status: 'in_progress' }, { title: 'Ship', status: 'pending' }]));
  sessionService.appendTurn(id, { role: 'tool', name: 'update_plan', tool_call_id: 'c1', content: '{"__plan":[{"title":"Draft","status":"in_progress"}]}' });
  sessionService.appendTurn(id, { role: 'assistant', content: 'Drafting now.' });
  sessionService.appendTurn(id, { role: 'user', content: 'Use a blue palette' });
  sessionService.appendTurn(id, plan([{ title: 'Draft', status: 'done' }, { title: 'Ship', status: 'in_progress' }]));
  sessionService.appendTurn(id, { role: 'assistant', content: 'Done-ish.' });

  // 1. all() — addressable entries with previews
  const all = transcriptService.all(id);
  assert.strictEqual(all.entries.length, 7);
  assert.deepStrictEqual(all.entries.map((t) => t.id), ['t0', 't1', 't2', 't3', 't4', 't5', 't6']);
  assert.strictEqual(all.entries[0].preview, 'Build a landing page');
  assert.strictEqual(all.entries[1].toolCalls[0].name, 'update_plan');
  assert.strictEqual(all.entries[2].toolCallId, 'c1');

  // 2. paging — real slices, forward order
  const p0 = transcriptService.page(id, { page: 0, pageSize: 3 });
  assert.strictEqual(p0.total, 7);
  assert.strictEqual(p0.totalPages, 3);
  assert.strictEqual(p0.hasMore, true);
  assert.deepStrictEqual(p0.turns.map((t) => t.id), ['t0', 't1', 't2']);
  const p2 = transcriptService.page(id, { page: 2, pageSize: 3 });
  assert.deepStrictEqual(p2.turns.map((t) => t.id), ['t6']);
  assert.strictEqual(p2.hasMore, false);
  const pClamp = transcriptService.page(id, { page: 99, pageSize: 3 });
  assert.strictEqual(pClamp.page, 2, 'page clamps to the last page');

  // 3. window — by index range and newest-first
  const w = transcriptService.window(id, { start: 2, end: 5 });
  assert.deepStrictEqual(w.turns.map((t) => t.id), ['t2', 't3', 't4']);
  const wn = transcriptService.window(id, { limit: 2, newestFirst: true });
  assert.deepStrictEqual(wn.turns.map((t) => t.id), ['t6', 't5']);

  // 4. tail
  const tl = transcriptService.tail(id, { limit: 2 });
  assert.deepStrictEqual(tl.turns.map((t) => t.id), ['t5', 't6']);

  // 5. thread — user turns with their replies
  const th = transcriptService.thread(id);
  assert.strictEqual(th.groups.length, 2);
  assert.strictEqual(th.groups[0].user.id, 't0');
  assert.deepStrictEqual(th.groups[0].replies.map((t) => t.id), ['t1', 't2', 't3']);
  assert.deepStrictEqual(th.groups[1].replies.map((t) => t.id), ['t5', 't6']);

  // 6. todos — latest update_plan wins
  const todos = transcriptService.todos(id);
  assert.strictEqual(todos.updateCount, 2);
  assert.deepStrictEqual(todos.counts, { pending: 0, in_progress: 1, done: 1 });
  assert.deepStrictEqual(todos.steps.map((s) => [s.title, s.status]), [['Draft', 'done'], ['Ship', 'in_progress']]);

  // 7. rollback(lastUser) — truncate at last user turn; compaction dropped if stale
  sessionService.saveCompaction(id, { cutoff: 5, summary: 'old' });
  const rb = transcriptService.rollback(id, { lastUser: true });
  assert.strictEqual(rb.removed, 3);
  assert.strictEqual(sessionService.get(id).turns.length, 4);
  assert.strictEqual(sessionService.get(id).compaction, undefined, 'stale compaction dropped');
  await assert.rejects(async () => { transcriptService.rollback(id, {}); }, /provide toMessageId/);

  // rollback by message address
  sessionService.appendTurn(id, { role: 'assistant', content: 'extra' });
  const rb2 = transcriptService.rollback(id, { toMessageId: 't3' });
  assert.strictEqual(rb2.removed, 2);
  assert.strictEqual(sessionService.get(id).turns.length, 3);

  // 8. dispatch surface — envelope + real payloads
  const pageEnv = await grokCompatService.dispatch('getAgentTranscriptPage', { id, page: 0, pageSize: 2 });
  assert.strictEqual(pageEnv.status, 'ok');
  assert.strictEqual(pageEnv.total, 3);
  assert.strictEqual(pageEnv.turns.length, 2);
  const todoEnv = await grokCompatService.dispatch('getAgentTodos', { id });
  assert.strictEqual(todoEnv.steps.length, 2);
  const tailEnv = await grokCompatService.dispatch('getAgentTranscriptTail', { id, limit: 1 });
  assert.deepStrictEqual(tailEnv.turns.map((t) => t.id), ['t2']);
  const rbEnv = await grokCompatService.dispatch('rollBackConversation', { id, lastUser: true });
  assert.strictEqual(rbEnv.removed, 3);

  // 9. task pin/done — real task-store mutation
  const task = taskStore.persist({ id: 'task-1', parentSessionId: id, title: 'Subtask', status: 'running', createdAt: Date.now() });
  assert.strictEqual(task.status, 'running');
  const pinned = await grokCompatService.dispatch('setAgentTaskPinned', { id: 'task-1', agentId: id, pinned: true });
  assert.strictEqual(pinned.pinned, true);
  assert.strictEqual(taskStore.get('task-1').pinned, true);
  const done = await grokCompatService.dispatch('markAgentTaskDone', { taskId: 'task-1', agentId: id });
  assert.strictEqual(done.taskStatus, 'completed');
  assert.strictEqual(taskStore.get('task-1').status, 'completed');
  const missing = await grokCompatService.dispatch('markAgentTaskDone', { taskId: 'nope', agentId: id });
  assert.strictEqual(missing.found, false, 'missing task reports found:false, not a crash');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('transcript-surface test: ALL OK (all/page/window/tail/thread/todos/rollback/tasks)');
})().catch((e) => { console.error(e); process.exit(1); });
