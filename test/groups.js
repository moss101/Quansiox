'use strict';
/* Local group chats (GPA G9): 2–6 members, mentions, transient member turns,
 * per-member memory scope, and group transcript authoring. Electron-free with
 * an injected agent runner. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-groups-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { sessionService } = require('../src/main/services/sessionService');
for (const [id, title, label] of [['sess-alpha', 'Alpha', 'planner'], ['sess-beta', 'Beta', ''], ['sess-gamma', 'Gamma', 'reviewer']]) {
  sessionService.ensure(id);
  sessionService.update(id, { title, label });
}

// Inject the agent runner: records the passed persona/memory scope and writes
// an assistant turn into the transient session (as the real coordinator does).
const calls = [];
const agentPath = require.resolve('../src/main/services/agentService');
require.cache[agentPath] = {
  id: agentPath, filename: agentPath, loaded: true,
  exports: {
    agentService: {
      async run(_event, opts) {
        calls.push(opts);
        sessionService.appendTurn(opts.sessionId, {
          role: 'assistant',
          content: `reply from ${opts.memoryScope} (${opts.persona.includes(opts.memoryScope === 'sess-alpha' ? 'Alpha' : 'member') ? 'persona' : 'no-persona'})`,
        });
        return { ok: true };
      },
      async abort() { return true; },
    },
  },
};

const { groupService } = require('../src/main/services/groupService');

(async () => {

// ---- create + validation ----
assert.throws(() => groupService.create({ memberIds: ['sess-alpha'] }), /2–6 bots/);
assert.throws(() => groupService.create({ memberIds: ['sess-alpha', 'nope'] }), /unknown member/);
const group = groupService.create({ name: 'Launch room', memberIds: ['sess-alpha', 'sess-beta'] });
assert.match(group.id, /^grp_/);
assert.equal(group.kind, 'group');
assert.equal(group.members.length, 2);
assert.equal(sessionService.list().find((s) => s.id === group.id).memberCount, 2);

// ---- send to everyone ----
let result = await groupService.send({ id: group.id, message: 'What should we ship?' });
assert.equal(result.ok, true);
assert.equal(result.replies.length, 2, 'both bots reply');
assert.deepEqual(result.replies.map((r) => r.author), ['Alpha', 'Beta']);
assert.equal(result.errors.length, 0);
const transcript = sessionService.get(group.id).turns;
assert.equal(transcript[0].role, 'user');
assert.deepEqual(transcript.slice(1).map((t) => t.author), ['Alpha', 'Beta'], 'replies carry author metadata');
assert.equal(calls[0].memoryScope, 'sess-alpha', 'member memory scope is used');
assert.match(calls[0].persona, /Alpha/);
assert.match(calls[0].message, /Group chat "Launch room" transcript/);
assert.ok(!sessionService.list().some((s) => s.id.startsWith('grptmp_')), 'transient sessions are cleaned up');

// ---- @mention routes to one bot ----
calls.length = 0;
result = await groupService.send({ id: group.id, message: '@Alpha summarize the risks' });
assert.equal(result.replies.length, 1, 'mention limits the reply');
assert.equal(result.replies[0].author, 'Alpha');
assert.equal(calls.length, 1);
// label mentions work too
result = await groupService.send({ id: group.id, message: '@reviewer not here' });
assert.equal(result.replies.length, 2, 'unknown mention falls back to everyone');
// explicit mention ids
result = await groupService.send({ id: group.id, message: 'ping', mentionIds: ['sess-beta'] });
assert.deepEqual(result.replies.map((r) => r.author), ['Beta']);

// ---- membership updates ----
const updated = groupService.setMembers({ id: group.id, memberIds: ['sess-alpha', 'sess-gamma'] });
assert.deepEqual(updated.members.map((m) => m.title), ['Alpha', 'Gamma']);
assert.throws(() => groupService.setMembers({ id: group.id, memberIds: ['sess-alpha'] }), /2–6 bots/);

// ---- failures are reported, not faked ----
const originalRun = require.cache[agentPath].exports.agentService.run;
require.cache[agentPath].exports.agentService.run = async () => { throw new Error('provider down'); };
result = await groupService.send({ id: group.id, message: 'status?' });
assert.equal(result.ok, false);
assert.equal(result.replies.length, 0);
assert.equal(result.errors.length, 2);
assert.match(result.errors[0].error, /provider down/);
require.cache[agentPath].exports.agentService.run = originalRun;

// ---- Grok compat mappings (createGroup / setGroupMembers / addRoomPeople) ----
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { sessionService: sessionsForCompat } = require('../src/main/services/sessionService');
sessionsForCompat.ensure('sess-compat-a');
sessionsForCompat.ensure('sess-compat-b');
let env = await grokCompatService.dispatch('createGroup', { name: 'Compat room', memberIds: ['sess-compat-a', 'sess-compat-b'] });
assert.equal(env.status, 'ok');
assert.equal(env.group.kind, 'group');
const compatId = env.groupId;
env = await grokCompatService.dispatch('addGrokBotRoomPeople', { roomId: compatId, agentIds: ['sess-gamma'] });
assert.equal(env.status, 'ok');
assert.equal(env.group.members.length, 3);
env = await grokCompatService.dispatch('setGroupMembers', { groupId: compatId, memberIds: ['sess-compat-a', 'sess-gamma'] });
assert.equal(env.status, 'ok');
assert.deepEqual(env.group.members.map((m) => m.id).sort(), ['sess-compat-a', 'sess-gamma']);
env = await grokCompatService.dispatch('listGrokBotAgentSessions', {});
assert.equal(env.status, 'ok');
assert.ok(env.sessions.some((s) => s.id === compatId && s.kind === 'group'));
env = await grokCompatService.dispatch('addGrokBotRoomPeople', { roomId: compatId, agentIds: ['bad id!'] });
assert.equal(env.status, 'error', 'invalid member ids are reported');

// ---- get rejects non-groups ----
assert.throws(() => groupService.get('sess-alpha'), /unknown group/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('groups test: ALL OK');
})().catch((error) => { console.error(error); process.exit(1); });
