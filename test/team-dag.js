'use strict';
/* Subagent orchestration — DAGs, live steering, wake-parent and the
 * worktree merge review.
 *
 *  - a team with dependencies runs in waves (downstream agents get the
 *    upstream results in their context)
 *  - a dependency cycle degrades to "run together" and is reported
 *  - message_subagent delivers steering to a running child
 *  - check_subagent reports the live state
 *  - wake_parent records the question and notifies the parent
 *  - merge_worktrees previews the isolated worktrees
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-dag-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { planTeamDag, normalizeAgents, buildDependencyContext } = require('../src/coordinator/teamDag');
const { SubagentScheduler } = require('../src/coordinator/subagents');
const { taskStore } = require('../src/coordinator/task-store');

(async () => {
  /* ---------------- the DAG planner ---------------- */
  const agents = normalizeAgents([
    { id: 'research', description: 'find the API', prompt: 'research it' },
    { id: 'implement', description: 'write the code', prompt: 'write it', depends_on: ['research'] },
    { id: 'test', description: 'test it', prompt: 'test it', depends_on: ['implement'] },
    { id: 'docs', description: 'write the docs', prompt: 'document it', depends_on: ['research'] },
  ]);
  assert.equal(agents.length, 4);
  assert.deepEqual(agents[2].dependsOn, ['implement']);

  const plan = planTeamDag(agents);
  assert.deepEqual(plan.errors, [], 'a well-formed DAG has no errors');
  assert.equal(plan.waves.length, 3, 'research → {implement, docs} → test');
  assert.deepEqual(plan.waves[0].map((a) => a.id), ['research']);
  assert.deepEqual(plan.waves[1].map((a) => a.id).sort(), ['docs', 'implement']);
  assert.deepEqual(plan.waves[2].map((a) => a.id), ['test']);

  // an unknown dependency is reported, not silently ignored
  const badDep = planTeamDag(normalizeAgents([
    { id: 'a', depends_on: ['ghost'] },
    { id: 'b' },
  ]));
  assert.equal(badDep.errors.length, 1);
  assert.match(badDep.errors[0], /unknown agent "ghost"/);

  // a cycle degrades to one wave and is reported (never a hang)
  const cyclic = planTeamDag(normalizeAgents([
    { id: 'a', depends_on: ['b'] },
    { id: 'b', depends_on: ['a'] },
  ]));
  assert.equal(cyclic.errors.length, 1);
  assert.match(cyclic.errors[0], /cycle/);
  assert.equal(cyclic.waves.length, 1, 'a cycle runs the remaining agents together');

  // the dependency context carries the upstream summary and files
  const ctx = buildDependencyContext([
    { id: 'research', summary: 'the API is at /v2/things', fileResults: ['notes.md'], worktree: '/tmp/wt' },
  ], { dependsOn: ['research'] });
  assert.match(ctx, /the API is at \/v2\/things/);
  assert.match(ctx, /notes\.md/);
  assert.match(ctx, /\/tmp\/wt/);
  assert.equal(buildDependencyContext([{ id: 'x', summary: 'y' }], { dependsOn: ['other'] }), '');

  /* ---------------- live steering ---------------- */
  const seen = [];
  const scheduler = new SubagentScheduler({
    cap: 4,
    runChild: async (job) => {
      seen.push(job.id);
      // the child observes the steering message the parent queued
      await new Promise((r) => setTimeout(r, 50));
      const delivered = (job.steering ?? []).length;
      return { summary: `steering=${delivered}`, fileResults: [], aborted: false, errored: false };
    },
  });
  const handle = scheduler.start({ id: 'child-1', title: 'child', type: 'general', background: true });
  // steer it while it runs
  const steered = scheduler.steer('child-1', 'stop doing X, do Y instead');
  assert.equal(steered.delivered, true);
  const result = await handle.done;
  assert.equal(result.summary, 'steering=1', 'the child received the steering message');

  // steering an unknown task is refused honestly
  const refused = scheduler.steer('nope', 'hi');
  assert.equal(refused.delivered, false);
  assert.match(refused.reason, /unknown task/);

  // check_subagent reports the live state
  const inspected = scheduler.inspect('child-1');
  assert.equal(inspected.id, 'child-1');
  assert.equal(inspected.type, 'general');

  /* ---------------- wake_parent ---------------- */
  const wake = taskStore.recordWake('parent-session', { question: 'which API?', context: 'two candidates' });
  assert.equal(wake.kind, 'wake');
  assert.equal(wake.question, 'which API?');
  assert.equal(wake.parentSessionId, 'parent-session');
  assert.ok(fs.existsSync(path.join(tmp, 'tasks', `${wake.id}.json`)), 'the question is persisted');

  /* ---------------- the worktree merge preview ---------------- */
  const coordinator = require('../src/coordinator/index');
  const names = coordinator.allTools().map((t) => t.function.name);
  for (const tool of ['message_subagent', 'check_subagent', 'wake_parent', 'merge_worktrees']) {
    assert.ok(names.includes(tool), `${tool} is advertised to the model`);
  }

  // with no worktrees the tool says so instead of failing
  const preview = await coordinator.executeTool(
    'merge_worktrees', {}, tmp, 'merge-session', { permissive: true }, null, null, null, null,
  );
  assert.match(preview, /no isolated subagent worktrees/);

  console.log('team-dag test: ALL OK (DAG waves/cycle/deps context/steering/wake/merge preview)');
})().catch((e) => { console.error(e); process.exit(1); });
