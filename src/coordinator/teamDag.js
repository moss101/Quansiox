'use strict';
/**
 * Team DAG planning.
 *
 * `team` used to be a flat `Promise.all`: every agent started at once and
 * none of them could see what the others had learned. Grok Bot's
 * `BackgroundComposerService` and its per-agent workflows show the shape
 * worth having — agents can *depend* on each other, so a downstream agent
 * starts with its upstream agent's findings already in context.
 *
 * This module is pure: it plans the execution order and detects cycles.
 * The coordinator runs the plan.
 */

/** Max agents in one team (the tool schema caps it at 8; keep the same). */
const MAX_AGENTS = 8;

/**
 * Normalize the agent specs of a team.
 *
 * `depends_on` entries are resolved to agent ids here, so the model can
 * refer to an upstream agent by the `id` it declared, by its `description`
 * (the human-readable row title it can actually see), or by the positional
 * `agent-N` fallback. Unresolvable entries are dropped and reported.
 *
 * @param {Array<object>} agents
 * @returns {Array<{ id: string, description: string, prompt: string, subagent_type: string, dependsOn: string[] }>}
 */
function normalizeAgents(agents) {
  const list = Array.isArray(agents) ? agents.slice(0, MAX_AGENTS) : [];
  const normalized = list.map((agent, index) => {
    const id = String(agent?.id ?? `agent-${index + 1}`).slice(0, 64);
    return {
      id,
      description: String(agent?.description ?? agent?.title ?? `Agent ${index + 1}`).slice(0, 120),
      prompt: String(agent?.prompt ?? agent?.description ?? ''),
      subagent_type: String(agent?.subagent_type ?? agent?.type ?? 'general'),
      rawDependsOn: (Array.isArray(agent?.depends_on)
        ? agent.depends_on
        : Array.isArray(agent?.dependsOn)
          ? agent.dependsOn
          : []
      ).map((d) => String(d).trim()).filter(Boolean),
    };
  });

  // Second pass: resolve each dependency string to a concrete agent id.
  const byId = new Map(normalized.map((a) => [a.id, a]));
  const byDescription = new Map(normalized.map((a) => [a.description.toLowerCase(), a.id]));
  const unresolved = [];
  for (const agent of normalized) {
    const dependsOn = [];
    for (const dep of agent.rawDependsOn) {
      const key = dep.toLowerCase();
      let target = byId.has(dep) ? dep : byDescription.get(key);
      if (!target && /^agent-\d+$/.test(key)) target = byId.has(key) ? key : null;
      if (!target) { unresolved.push({ agentId: agent.id, dep }); continue; }
      if (!dependsOn.includes(target)) dependsOn.push(target);
    }
    agent.dependsOn = dependsOn;
  }
  if (unresolved.length) {
    normalized.unresolvedDependencies = unresolved;
  }
  return normalized;
}

/**
 * Plan a team as a DAG.
 *
 * @param {Array<object>} agents  normalized agents
 * @returns {{ waves: Array<Array<object>>, order: string[], errors: string[] }}
 *   `waves` are the execution tiers: everything in a wave can run in
 *   parallel, and the next wave only starts once the previous one is done.
 *   A cycle degrades to "run the remaining agents in one wave" and is
 *   reported in `errors` — never a silent hang.
 */
function planTeamDag(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const byId = new Map(list.map((a) => [a.id, a]));
  const errors = [];

  // Dependencies the model named that could not be resolved to an agent in
  // this team. These are dropped (an unresolvable edge would stall the DAG),
  // but never silently — the caller surfaces them as warnings.
  for (const unresolved of list.unresolvedDependencies ?? []) {
    const agentId = typeof unresolved === 'string' ? unresolved : unresolved.agentId;
    const dep = typeof unresolved === 'string' ? unresolved : unresolved.dep;
    errors.push(`agent "${agentId}" depends on unknown agent "${dep}" — the dependency was ignored`);
  }

  // Resolve dependencies: unknown ids are dropped with a note.
  const edges = new Map();
  for (const agent of list) {
    const deps = [];
    for (const dep of agent.dependsOn) {
      if (dep === agent.id) {
        errors.push(`agent "${agent.id}" depends on itself — the dependency was ignored`);
        continue;
      }
      if (!byId.has(dep)) {
        errors.push(`agent "${agent.id}" depends on unknown agent "${dep}" — the dependency was ignored`);
        continue;
      }
      deps.push(dep);
    }
    edges.set(agent.id, deps);
  }

  // Kahn's algorithm, tier by tier.
  const remaining = new Set(list.map((a) => a.id));
  const waves = [];
  const order = [];
  let guard = 0;
  while (remaining.size > 0 && guard < list.length + 2) {
    guard += 1;
    const ready = [...remaining].filter((id) => {
      const deps = edges.get(id) ?? [];
      return deps.every((d) => !remaining.has(d));
    });
    if (!ready.length) {
      // A cycle: run the rest in one wave rather than hanging.
      errors.push(`dependency cycle between ${[...remaining].join(', ')} — those agents will run together`);
      const rest = [...remaining].map((id) => byId.get(id));
      waves.push(rest);
      order.push(...rest.map((a) => a.id));
      break;
    }
    const wave = ready.map((id) => byId.get(id));
    waves.push(wave);
    order.push(...ready);
    for (const id of ready) remaining.delete(id);
  }
  return { waves, order, errors };
}

/**
 * Build the context block a downstream agent receives from its upstream
 * agents. Kept short: the upstream *summaries* plus the files they touched
 * and their worktree (if any) — not their transcripts.
 */
function buildDependencyContext(results, agent) {
  const deps = new Set(agent?.dependsOn ?? []);
  if (!deps.size) return '';
  const upstream = (results ?? []).filter((r) => deps.has(r.id) || deps.has(r?.agentId));
  if (!upstream.length) return '';
  const lines = [];
  for (const r of upstream) {
    const files = (r.fileResults ?? []).slice(0, 20);
    lines.push(`- ${r.id ?? r.agentId ?? 'upstream'}: ${(r.summary || '(no summary)').slice(0, 1200)}`);
    if (files.length) lines.push(`  files it produced: ${files.join(', ')}`);
    if (r.worktree) lines.push(`  its isolated worktree: ${r.worktree}`);
  }
  if (!lines.length) return '';
  return `Results from the agents this task depends on (use them; do not redo their work):\n${lines.join('\n')}\n`;
}

module.exports = { planTeamDag, normalizeAgents, buildDependencyContext, MAX_AGENTS };
