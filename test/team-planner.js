'use strict';
/* Model-directed team planning — JSON extraction, plan normalization, and the
 * autoTeam mode switch ('off' | 'regex' | 'model') with safe fallbacks. */
const assert = require('node:assert/strict');
const { planTeamModel, resolveTeamPlan, normalizePlan, extractJson } = require('../src/coordinator/team-planner');
const { planTeam } = require('../src/coordinator/subagents');

// 1. JSON extraction tolerates fences and surrounding prose
assert.deepStrictEqual(extractJson('```json\n{"agents":[]}\n```'), { agents: [] });
assert.deepStrictEqual(extractJson('Sure! Here is the plan: {"brief":"x","agents":[]} thanks'), { brief: 'x', agents: [] });
assert.equal(extractJson('not json at all'), null);

// 2. normalization: type whitelist, dedupe, min/max agents
const normalized = normalizePlan({
  brief: 'split research',
  agents: [
    { description: 'NVIDIA', prompt: 'Research NVIDIA earnings and return key figures.', subagent_type: 'browser' },
    { description: 'AMD', prompt: 'Research AMD earnings and return key figures.', subagent_type: 'weird' },
    { description: 'NVIDIA', prompt: 'Research NVIDIA earnings and return key figures.', subagent_type: 'browser' },
    { prompt: 'x' },
  ],
});
assert.equal(normalized.agents.length, 2, 'duplicate and tiny tasks removed');
assert.equal(normalized.agents[0].subagent_type, 'browser');
assert.equal(normalized.agents[1].subagent_type, 'general', 'unknown type falls back to general');
assert.equal(normalized.agents[0].environment, 'shared');

assert.equal(normalizePlan({ agents: [{ prompt: 'only one task here' }] }), null, 'single agent is not a team');
assert.equal(normalizePlan({ agents: [] }), null);
assert.equal(normalizePlan(null), null);

const many = normalizePlan({ agents: Array.from({ length: 10 }, (_, i) => ({ description: `t${i}`, prompt: `Do independent task number ${i} completely.` })) });
assert.equal(many.agents.length, 6, 'capped at 6 agents');

// 3. planTeamModel uses the injected completion, not the network
(async () => {
  let seen = null;
  const plan = await planTeamModel('research A and B', {
    complete: async (messages) => {
      seen = messages;
      return '{"brief":"research","agents":[{"description":"A","prompt":"Research A thoroughly.","subagent_type":"explore"},{"description":"B","prompt":"Research B thoroughly.","subagent_type":"explore"}]}';
    },
  });
  assert.equal(seen[0].role, 'system');
  assert.match(seen[0].content, /Return ONLY a JSON object/);
  assert.equal(seen[1].content, 'research A and B');
  assert.equal(plan.agents.length, 2);

  // malformed model output → null (no throw)
  assert.equal(await planTeamModel('x', { complete: async () => 'lol no json' }), null);
  assert.equal(await planTeamModel('x', {}), null, 'no completion → null');

  // 4. mode switch
  const regexFallback = planTeam;
  const msg = 'research NVIDIA, AMD, and Intel';
  const off = await resolveTeamPlan(msg, { autoTeam: 'off' }, { fallback: regexFallback });
  assert.equal(off, null, 'off disables automatic fan-out');

  const regex = await resolveTeamPlan(msg, { autoTeam: 'regex' }, { fallback: regexFallback });
  assert.ok(regex && regex.agents.length >= 2, 'regex mode keeps prior heuristic');

  const modeled = await resolveTeamPlan(msg, { autoTeam: 'model' }, {
    fallback: regexFallback,
    complete: async () => '{"brief":"b","agents":[{"description":"A","prompt":"Research NVIDIA fully.","subagent_type":"explore"},{"description":"B","prompt":"Research AMD fully.","subagent_type":"explore"}]}',
  });
  assert.equal(modeled.brief, 'b');
  assert.equal(modeled.agents.length, 2);

  // model mode degrades to the heuristic when the provider fails
  const degraded = await resolveTeamPlan(msg, { autoTeam: 'model' }, {
    fallback: regexFallback,
    complete: async () => { throw new Error('provider down'); },
  });
  assert.ok(degraded && degraded.agents.length >= 2, 'falls back to regex on provider failure');

  // ...and to null when there is nothing to fall back to
  assert.equal(await resolveTeamPlan(msg, { autoTeam: 'model' }, { complete: async () => 'garbage' }), null);

  console.log('team-planner test: ALL OK (extract/normalize/model + mode fallbacks)');
})().catch((e) => { console.error(e); process.exit(1); });
