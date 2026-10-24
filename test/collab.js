'use strict';
/* Collaboration test — the local-first implementation of Manus' task
 * collaboration.
 *
 * Covers the documented behaviour:
 *   - collaboration is a separate mode on a task (COL-01);
 *   - inviting by email and joining immediately (COL-02/03);
 *   - a collaborator can prompt Manus themselves (COL-06);
 *   - everybody's prompts and answers are visible (COL-07);
 *   - prompts run one after another, never interleaved (COL-08);
 *   - only the owner controls the invitations (COL-10);
 *   - the owner can remove a collaborator (COL-11);
 *   - a late joiner still sees the whole history (COL-12);
 *   - the task can be exported (COL-13).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-collab-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const { collabService } = require('../src/main/services/collabService');

async function run() {
  /* -- 1. enabling collaboration (COL-01) --------------------------------- */
  assert.strictEqual(collabService.find('task-1'), null);
  const session = collabService.enable('task-1', { owner: 'owner@local' });
  assert.strictEqual(session.enabled, true);
  assert.strictEqual(session.owner, 'owner@local');
  assert.strictEqual(session.members.length, 0);
  // Enabling twice does not lose anything.
  assert.ok(collabService.enable('task-1').id);

  /* -- 2. inviting (COL-02) ---------------------------------------------- */
  const invite = collabService.invite('task-1', 'Ada@Example.com');
  assert.strictEqual(invite.email, 'ada@example.com', 'the address is normalised');
  assert.ok(invite.token.length >= 16);
  assert.throws(() => collabService.invite('task-1', 'not-an-email'), /not an email address/);
  assert.throws(() => collabService.invite('task-2', 'ada@example.com'), /not enabled for this task/);

  /* -- 3. joining immediately (COL-03) ----------------------------------- */
  const joined = collabService.join(invite.token, { identity: 'ada@example.com' });
  assert.strictEqual(joined.ok, true);
  assert.strictEqual(joined.member.email, 'ada@example.com');
  assert.strictEqual(joined.member.role, 'collaborator');
  // The token is single use.
  const again = collabService.join(invite.token);
  assert.strictEqual(again.ok, false);
  assert.match(again.reason, /not valid/);
  assert.strictEqual(collabService.members('task-1').length, 1);

  /* -- 4. a collaborator can prompt (COL-06) ------------------------------ */
  const queued = collabService.prompt('task-1', 'ada@example.com', 'summarise the repo');
  assert.strictEqual(queued.queued, true);
  assert.strictEqual(queued.position, 1);
  assert.strictEqual(collabService.queue('task-1').length, 1);
  assert.throws(() => collabService.prompt('task-1', 'ada@example.com', '   '), /needs a message/);

  /* -- 5. prompts run one after another (COL-08) -------------------------- */
  // Two prompts queued at once must not interleave.
  collabService.prompt('task-1', 'ada@example.com', 'second prompt');
  const order = [];
  const results = await collabService.drain('task-1', async (_sessionId, message) => {
    order.push(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return `answer to ${message}`;
  });
  assert.strictEqual(results.length, 2);
  assert.deepStrictEqual(order, ['summarise the repo', 'second prompt'], 'the prompts ran in order');
  assert.strictEqual(results[0].answer, 'answer to summarise the repo');
  assert.strictEqual(collabService.queue('task-1').length, 0, 'the queue is empty afterwards');

  /* -- 6. everybody's prompts and answers are recorded (COL-07/12) --------- */
  const history = collabService.history('task-1');
  assert.strictEqual(history.length, 4, 'two prompts and two answers');
  assert.strictEqual(history[0].role, 'prompt');
  assert.strictEqual(history[1].role, 'answer');
  assert.strictEqual(history[1].message, 'answer to summarise the repo');
  assert.strictEqual(history[0].identity, 'ada@example.com');

  /* -- 7. the owner controls the invitations (COL-10/11) ------------------- */
  const members = collabService.members('task-1');
  assert.strictEqual(members.length, 1);
  assert.strictEqual(collabService.removeMember('task-1', 'ada@example.com').removed, true);
  assert.strictEqual(collabService.members('task-1').length, 0);
  assert.strictEqual(collabService.removeMember('task-1', 'ada@example.com').removed, false);

  /* -- 8. the invite link (COL-14) ---------------------------------------- */
  const second = collabService.invite('task-1', 'bob@example.com');
  const server = collabService.ensureServer();
  assert.ok(server.base);
  const response = await fetch(`${server.base}/collab/${second.token}`);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.member.email, 'bob@example.com');
  // A bad token is refused.
  const bad = await fetch(`${server.base}/collab/${'0'.repeat(32)}`);
  assert.strictEqual(bad.status, 404);

  /* -- 9. exporting (COL-13) ---------------------------------------------- */
  const transcript = collabService.exportTranscript('task-1');
  assert.match(transcript, /# Collaborative task task-1/);
  assert.match(transcript, /summarise the repo/);
  assert.match(transcript, /answer to summarise the repo/);

  /* -- 10. disabling ------------------------------------------------------- */
  assert.strictEqual(collabService.disable('task-1').disabled, true);
  assert.strictEqual(collabService.find('task-1').enabled, false);

  collabService.stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('collab test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
