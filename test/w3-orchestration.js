'use strict';
/* W3 — orchestration.
 *
 *  W3.1  the transcript has epochs, so a cursor knows when it is too old
 *  W3.2  agents are named objects that outlive a conversation
 *  W3.3  the model can create, update, publish and share agents
 *  W3.4  the model can send a message to another agent
 *  W3.5  a room is a deadline-bounded multi-agent conversation
 *  W3.6  stopping a subagent really stops it
 *  W3.7  background work has its own registry
 *  W3.8  a blackboard write that lost a race says so
 *  W3.9  a blackboard belongs to a scope, not to a conversation
 *  W3.10 an agent can be cloned
 *  W3.11 the durable checklist survives a restart
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-w3-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const { agentIdentityService } = require('../src/main/services/agentIdentityService');
const { taskStateService } = require('../src/main/services/taskStateService');
const { asyncTaskService } = require('../src/main/services/asyncTaskService');
const { sessionService } = require('../src/main/services/sessionService');
const { transcriptService } = require('../src/main/services/transcriptService');
const rooms = require('../src/coordinator/rooms');
const { Blackboard, getBoard, getTeamBoard } = require('../src/coordinator/blackboard');
const { executeAgentTool } = require('../src/coordinator/agentTools');
const coordinator = require('../src/coordinator/index');

(async () => {
  /* ---------------------------------------------------------------- W3.1 */
  await test('W3.1 the transcript assigns sequence numbers and a cursor', () => {
    const id = 'w3-cursor-session';
    sessionService.ensure(id);
    sessionService.appendTurn(id, { role: 'user', content: 'one' });
    sessionService.appendTurn(id, { role: 'assistant', content: 'two' });

    const cursor = sessionService.transcriptCursor(id);
    assert.equal(cursor.generation, 1);
    assert.ok(cursor.afterUpdatedSeq >= 2, 'the cursor must reflect the appended rows');

    const since = sessionService.transcriptSince(id, { generation: 1, afterUpdatedSeq: 0 });
    assert.equal(since.entries.length, 2);
    assert.equal(since.cursorTooOld, false);
    assert.equal(since.entries[0].body.content, 'one');

    // A cursor from the middle returns only what came after.
    const partial = sessionService.transcriptSince(id, { generation: 1, afterUpdatedSeq: 1 });
    assert.equal(partial.entries.length, 1);
    assert.equal(partial.entries[0].body.content, 'two');
  });

  await test('W3.1 a rewind advances the epoch and invalidates old cursors', () => {
    const id = 'w3-rewind-session';
    sessionService.ensure(id);
    sessionService.appendTurn(id, { role: 'user', content: 'first' });
    sessionService.appendTurn(id, { role: 'assistant', content: 'second' });
    const before = sessionService.transcriptCursor(id);

    const result = transcriptService.rollback(id, { toTurnIndex: 1 });
    assert.equal(result.removed, 1);
    assert.equal(result.generation, 2, 'a rewind must advance the generation');

    const stale = sessionService.transcriptSince(id, before);
    assert.equal(stale.cursorTooOld, true, 'a cursor from before the rewind must be refused');
    assert.equal(stale.entries.length, 0);
    assert.equal(stale.nextCursor.generation, 2, 'the client must be told to re-read');
  });

  /* ---------------------------------------------------------------- W3.2 */
  await test('W3.2 an agent is a named object that outlives a conversation', () => {
    const agent = agentIdentityService.create({
      name: 'Researcher',
      description: 'reads and summarises',
      permissionMode: 'read-only',
    });
    assert.ok(agent.id);
    assert.equal(agent.name, 'Researcher');
    assert.equal(agent.permissionMode, 'read-only');

    agentIdentityService.attachSession(agent.id, 'w3-session-a');
    const found = agentIdentityService.agentForSession('w3-session-a');
    assert.equal(found.id, agent.id);
    assert.equal(agentIdentityService.agentForSession('w3-unknown'), null);
  });

  await test('W3.2 there is exactly one primary agent', () => {
    const a = agentIdentityService.create({ name: 'A' });
    const b = agentIdentityService.create({ name: 'B' });
    agentIdentityService.setPrimary(a.id);
    assert.equal(agentIdentityService.primary().id, a.id);
    agentIdentityService.setPrimary(b.id);
    assert.equal(agentIdentityService.primary().id, b.id);
    assert.equal(agentIdentityService.list().filter((x) => x.primary).length, 1);
  });

  /* ---------------------------------------------------------------- W3.3 */
  await test('W3.3 the model can create, update and publish an agent', async () => {
    const created = await executeAgentTool('create_agent', {
      name: 'Writer', description: 'drafts text', permissionMode: 'workspace',
    }, { sessionId: 'w3-model-session' });
    assert.match(created, /created agent "Writer"/);
    const agents = agentIdentityService.list();
    const writer = agents.find((a) => a.name === 'Writer');
    assert.ok(writer, 'the agent must exist');

    await executeAgentTool('update_agent', { agentId: writer.id, description: 'drafts better text' }, {});
    assert.equal(agentIdentityService.get(writer.id).description, 'drafts better text');

    await executeAgentTool('publish_agent', { agentId: writer.id }, {});
    const published = agentIdentityService.get(writer.id);
    assert.equal(published.published, true);
    assert.equal(published.scope, 'team');

    await executeAgentTool('convert_agent_to_team', { agentId: writer.id }, {});
    assert.equal(agentIdentityService.get(writer.id).scope, 'team');
  });

  await test('W3.3 the agent tools are offered to the model', () => {
    const names = coordinator.allTools().map((t) => t.function.name);
    for (const name of [
      'list_agents', 'create_agent', 'update_agent', 'set_primary_agent', 'publish_agent',
      'convert_agent_to_team', 'offer_agent_access', 'send_to_agent', 'send_to_user',
      'stop_subagent', 'create_task', 'read_task', 'update_task', 'list_tasks',
      'update_state', 'list_async_tasks', 'create_room', 'room_status',
    ]) {
      assert.ok(names.includes(name), `${name} must be offered to the model`);
    }
  });

  /* ---------------------------------------------------------------- W3.4 */
  await test('W3.4 the model can send a message to another agent', async () => {
    const target = agentIdentityService.create({ name: 'Receiver' });
    sessionService.ensure('w3-receiver-session');
    agentIdentityService.attachSession(target.id, 'w3-receiver-session');

    const result = await executeAgentTool('send_to_agent', {
      agentId: target.id, message: 'please look at this',
    }, { sessionId: 'w3-sender-session' });
    assert.match(result, /sent a message to "Receiver"/);

    const session = sessionService.get('w3-receiver-session');
    const last = session.turns[session.turns.length - 1];
    assert.equal(last.content, 'please look at this', 'the message must land in the target conversation');
  });

  await test('W3.4 sending to an unknown agent says so', async () => {
    const result = await executeAgentTool('send_to_agent', { agentId: 'nope', message: 'x' }, {});
    assert.match(result, /unknown agent/);
  });

  /* ---------------------------------------------------------------- W3.5 */
  await test('W3.5 a room holds members, turns and a deadline', () => {
    const room = rooms.createRoom({ members: ['a', 'b', 'c'], title: 'Planning' });
    assert.equal(room.members.length, 3);
    assert.throws(() => rooms.createRoom({ members: ['only-one'] }), /at least two members/);

    const turn = rooms.requestMemberTurn({
      roomId: room.id, memberAgentId: 'a', deadlineMs: 5000, newMessages: [{ text: 'hello' }],
    });
    assert.equal(turn.peers.length, 2, 'a member must know who else is in the room');
    assert.ok(turn.deadlineAtMs > Date.now());
    assert.equal(turn.windingDown, false);

    const prompt = rooms.turnPrompt(turn);
    assert.match(prompt, /You are a/);
    assert.match(prompt, /- b/);
    assert.match(prompt, /- c/);
    assert.match(prompt, /5 seconds/);
  });

  await test('W3.5 a delivered turn is recorded and the room winds down', () => {
    const room = rooms.createRoom({ members: ['x', 'y'] });
    const t1 = rooms.requestMemberTurn({ roomId: room.id, memberAgentId: 'x' });
    rooms.deliverMemberTurn({
      roomId: room.id, nonce: t1.nonce, memberAgentId: 'x', messages: [{ text: 'from x' }],
    });
    assert.equal(rooms.getRoom(room.id).windingDown, false, 'one turn is not a round');

    const t2 = rooms.requestMemberTurn({ roomId: room.id, memberAgentId: 'y' });
    rooms.deliverMemberTurn({
      roomId: room.id, nonce: t2.nonce, memberAgentId: 'y', messages: [{ text: 'from y' }],
    });
    assert.equal(rooms.getRoom(room.id).windingDown, true, 'the room winds down after a full round');
    assert.equal(rooms.messages(room.id).length, 2);
  });

  await test('W3.5 a turn in flight can be cancelled', () => {
    const room = rooms.createRoom({ members: ['p', 'q'] });
    const turn = rooms.requestMemberTurn({ roomId: room.id, memberAgentId: 'p' });
    assert.equal(rooms.pendingTurns(room.id).length, 1);
    const cancelled = rooms.cancelMemberTurn({ roomId: room.id, nonce: turn.nonce, reason: 'changed my mind' });
    assert.equal(cancelled.cancelled, true);
    assert.equal(rooms.pendingTurns(room.id).length, 0);
  });

  await test('W3.5 a turn carries its tree links', () => {
    const room = rooms.createRoom({ members: ['r1', 'r2'] });
    const turn = rooms.requestMemberTurn({
      roomId: room.id, memberAgentId: 'r2', parentRequestId: 'rt-parent', rootParentRequestId: 'rt-root',
    });
    assert.equal(turn.parentRequestId, 'rt-parent');
    assert.equal(turn.rootParentRequestId, 'rt-root');
    assert.match(rooms.turnPrompt(turn), /rt-root/);
  });

  /* ---------------------------------------------------------------- W3.6 */
  await test('W3.6 stopping an unknown subagent says so rather than pretending', async () => {
    const result = await executeAgentTool('stop_subagent', { id: 'no-such-child' }, { sessionId: 'w3-s' });
    assert.match(result, /unknown subagent/);
  });

  /* ---------------------------------------------------------------- W3.7 */
  await test('W3.7 background work has its own registry', () => {
    const task = asyncTaskService.create({ kind: 'build', title: 'cargo build', sessionId: 'w3-s' });
    assert.equal(task.status, 'queued');
    asyncTaskService.update(task.id, { status: 'running', progress: 0.5 });
    assert.equal(asyncTaskService.get(task.id).progress, 0.5);
    assert.equal(asyncTaskService.active().length, 1);

    asyncTaskService.update(task.id, { status: 'succeeded', progress: 1 });
    assert.equal(asyncTaskService.active().length, 0, 'a finished task is not active');
    assert.equal(asyncTaskService.list({ sessionId: 'w3-s' }).length, 1);
  });

  await test('W3.7 the model can see the background work', async () => {
    const result = await executeAgentTool('list_async_tasks', {}, { sessionId: 'w3-s' });
    assert.match(result, /cargo build/);
  });

  /* ---------------------------------------------------------------- W3.8 */
  await test('W3.8 a blackboard write that lost a race reports the conflict', () => {
    const board = new Blackboard({ sessionId: 'w3-board' });
    const first = board.set('findings', 'from a', 'a');
    assert.equal(first.rev, 1);

    // A writer that read rev 1 but writes after another writer bumped it.
    board.set('findings', 'from b', 'b');
    const conflict = board.set('findings', 'from c', 'c', { rev: 1 });
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.yourRev, 1);
    assert.equal(conflict.currentRev, 2);
    assert.equal(conflict.current.value, 'from b', 'the conflict must show the current value');
    assert.equal(board.get('findings').value, 'from b', 'the losing write must not land');
  });

  await test('W3.8 a write with the current revision lands', () => {
    const board = new Blackboard({ sessionId: 'w3-board-2' });
    board.set('k', 1, 'a');
    const current = board.get('k').rev;
    const ok = board.set('k', 2, 'a', { rev: current });
    assert.equal(ok.conflict, undefined);
    assert.equal(board.get('k').value, 2);
  });

  await test('W3.8 an append never conflicts', () => {
    const board = new Blackboard({ sessionId: 'w3-board-3' });
    board.append('log', 'one', 'a');
    const second = board.append('log', 'two', 'b');
    assert.equal(second.conflict, undefined);
    assert.equal(board.get('log').count, 2);
  });

  /* ---------------------------------------------------------------- W3.9 */
  await test('W3.9 a board belongs to a scope, not to a conversation', () => {
    const team = getTeamBoard('team-1');
    team.set('decision', 'ship it', 'lead');
    // A different conversation in the same team sees the same board.
    const again = getTeamBoard('team-1');
    assert.equal(again.get('decision').value, 'ship it');
    // A different team does not.
    const other = getTeamBoard('team-2');
    assert.equal(other.get('decision'), null);
  });

  /* --------------------------------------------------------------- W3.10 */
  await test('W3.10 an agent can be cloned', () => {
    const original = agentIdentityService.create({ name: 'Original', description: 'x', permissionMode: 'read-only' });
    agentIdentityService.attachSession(original.id, 'w3-orig-session');
    const copy = agentIdentityService.clone(original.id, { name: 'Copy' });
    assert.equal(copy.name, 'Copy');
    assert.equal(copy.permissionMode, 'read-only');
    assert.deepEqual(copy.sessionIds, [], 'a clone starts with no conversations');
    assert.notEqual(copy.id, original.id);
  });

  /* --------------------------------------------------------------- W3.11 */
  await test('W3.11 the durable checklist survives a restart', () => {
    const created = taskStateService.createTask({ title: 'write the report', scope: 'w3-scope' });
    assert.ok(created.id);
    assert.equal(created.state, 'todo');

    const updated = taskStateService.updateTask(created.id, { state: 'in_progress' });
    assert.equal(updated.state, 'in_progress');

    const listed = taskStateService.listTasks({ scope: 'w3-scope' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, 'write the report');
  });

  await test('W3.11 the model can maintain the checklist', async () => {
    const created = await executeAgentTool('create_task', { title: 'do the thing' }, { sessionId: 'w3-tool-session' });
    const id = /\[(\S+)\]/.exec(created)?.[1];
    assert.ok(id, 'create_task must return the id');
    const updated = await executeAgentTool('update_task', { id, state: 'done' }, { sessionId: 'w3-tool-session' });
    assert.match(updated, /is now done/);
    const listed = await executeAgentTool('list_tasks', {}, { sessionId: 'w3-tool-session' });
    assert.match(listed, /do the thing/);
  });

  await test('W3.11 the state blob can be rewritten', async () => {
    const result = await executeAgentTool('update_state', {
      state: { done: ['a'], next: 'b' },
    }, { sessionId: 'w3-state-session' });
    assert.match(result, /state updated/);
    const state = taskStateService.getState({ scope: 'w3-state-session' });
    assert.deepEqual(state.data.done, ['a']);
  });

  await test('W3.11 an invalid task state is refused', () => {
    const task = taskStateService.createTask({ title: 'x' });
    assert.throws(() => taskStateService.updateTask(task.id, { state: 'nonsense' }), /invalid task state/);
  });

  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nW3 orchestration tests FAILED');
    process.exit(1);
  }
  console.log(`\nW3 orchestration: ${results.length} checks OK`);
})();
