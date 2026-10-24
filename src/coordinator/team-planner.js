'use strict';
/**
 * Model-directed team planning — ask the provider to decompose a turn into
 * independent subagent tasks instead of guessing with regexes. Opt-in through
 * `settings.autoTeam`:
 *   'off'   → never fan out automatically
 *   'regex' → heuristic planTeam (default; previous behavior)
 *   'model' → provider-generated plan, heuristic fallback
 *
 * The planner never runs tools and always falls back safely, so a malformed
 * model response degrades to the regex plan (or no team at all).
 */

const PLANNER_SYSTEM = `You are the orchestration planner for a desktop AI agent.
Decide whether the user's request is better done by several independent subagents in parallel.

Rules:
- Return ONLY a JSON object, no prose, no markdown fences.
- If one agent should just do it, return {"agents":[]}.
- Each agent must be self-contained: it does not see the parent conversation.
- Give each agent a distinct, non-overlapping task. Do not split a single sequential edit across agents.
- Prefer 2–4 agents. Never more than 6.
- subagent_type must be one of: general, explore, shell, browser, computer-use.
- environment is "shared" (same files) or "isolated" (separate sandbox copy).
- Put genuinely shared facts (repo layout, conventions) in "brief"; agents must not duplicate each other's work.

Schema: {"brief":"<one line>","agents":[{"description":"<short title>","prompt":"<full self-contained task>","subagent_type":"general","environment":"shared"}]}`;

const TYPES = new Set(['general', 'explore', 'shell', 'browser', 'computer-use']);

/** Pull the first JSON object out of a model response (fences tolerated). */
function extractJson(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* scan for a balanced object */ }
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i += 1) {
    if (raw[i] === '{') depth += 1;
    else if (raw[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Validate and normalize a planner response into the shape dispatchTeam expects.
 * @returns {{brief:string, agents:Array<{description,prompt,subagent_type,environment}>}|null}
 */
function normalizePlan(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
  const seen = new Set();
  const clean = [];
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') continue;
    const prompt = String(agent.prompt ?? agent.task ?? '').trim();
    if (!prompt || prompt.length < 8) continue;
    const description = String(agent.description ?? agent.title ?? prompt.split('\n')[0]).trim().slice(0, 120);
    const fingerprint = `${description}|${prompt}`.toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    clean.push({
      description: description || prompt.slice(0, 80),
      prompt: prompt.slice(0, 8000),
      subagent_type: TYPES.has(agent.subagent_type) ? agent.subagent_type : (TYPES.has(agent.type) ? agent.type : 'general'),
      environment: agent.environment === 'isolated' ? 'isolated' : 'shared',
    });
    if (clean.length >= 6) break;
  }
  if (clean.length < 2) return null;
  return { brief: String(parsed.brief ?? '').slice(0, 200), agents: clean };
}

/**
 * Ask the model for a team plan.
 * @param {string} message
 * @param {{ complete: (messages: Array<{role:string,content:string}>) => Promise<string> }} deps
 * @returns {Promise<{brief:string,agents:Array}|null>}
 */
async function planTeamModel(message, { complete } = {}) {
  const text = String(message ?? '').trim();
  if (!text || text.length > 12_000 || typeof complete !== 'function') return null;
  const reply = await complete([
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: text },
  ]);
  return normalizePlan(extractJson(reply));
}

/**
 * Resolve the effective plan for a turn according to settings.
 * @param {string|Array} message
 * @param {object} settings
 * @param {{ fallback?: Function, complete?: Function }} deps
 */
async function resolveTeamPlan(message, settings = {}, deps = {}) {
  const mode = settings.autoTeam || 'regex';
  if (mode === 'off' || Array.isArray(message)) return null;
  if (mode === 'model') {
    try {
      const plan = await planTeamModel(message, { complete: deps.complete });
      if (plan) return plan;
    } catch { /* fall back to the heuristic */ }
  }
  return typeof deps.fallback === 'function' ? deps.fallback(String(message)) : null;
}

module.exports = { planTeamModel, resolveTeamPlan, normalizePlan, extractJson, PLANNER_SYSTEM };
