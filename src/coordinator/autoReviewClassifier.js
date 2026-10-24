'use strict';
/**
 * Auto-review — the model-based safety reviewer.
 *
 * Until the 2026-10-20 repair pass, "auto review" in Quansiox was a case-
 * insensitive substring test (`text.includes(rule)`) consulted only when
 * `requireApproval` was on — which it was not by default. So the feature was
 * doubly inert: it was not a reviewer, and it did not run.
 *
 * This module makes it a real reviewer:
 *
 *   1. The user's rules are evaluated deterministically first. A rule written
 *      as `/regex/` is a regex; anything else is a case-insensitive substring
 *      match against the *action* (tool + arguments + description).
 *      **Block wins over allow.**
 *   2. If the rules do not settle it, the configured local model is asked to
 *      judge the action against the user's allow/block instructions and the
 *      conversation context. The answer must be strict JSON.
 *   3. If the model is unreachable or answers with garbage, the decision
 *      degrades to `ask` — never to `allow`.
 *
 * The model is the *configured provider* — a local model by default. Nothing
 * leaves the machine unless the user configured a remote provider.
 *
 * Pure-ish: the completion function is injected, so this is testable offline.
 */

/** Decisions. `ask` means "fall through to the human". */
const ALLOW = 'allow';
const DENY = 'deny';
const ASK = 'ask';

/**
 * Evaluate one rule against the text.
 *
 * `/pattern/flags` is a regular expression; anything else is a substring
 * match. An invalid regex is inert — it must never crash a turn.
 */
function ruleMatches(pattern, text) {
  const raw = String(pattern ?? '').trim();
  if (!raw) return false;
  const haystack = String(text ?? '');
  if (raw.length > 2 && raw.startsWith('/') && raw.endsWith('/')) {
    try {
      return new RegExp(raw.slice(1, -1), 'i').test(haystack);
    } catch {
      return false; // an invalid regex is simply inert
    }
  }
  return haystack.toLowerCase().includes(raw.toLowerCase());
}

/**
 * The text a rule is matched against: the action, its arguments and the
 * human-readable description.
 */
function actionText(action = {}) {
  const parts = [action.tool ?? action.action ?? ''];
  if (action.description) parts.push(action.description);
  if (action.arguments != null) {
    try {
      parts.push(typeof action.arguments === 'string'
        ? action.arguments
        : JSON.stringify(action.arguments));
    } catch {
      parts.push(String(action.arguments));
    }
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * Deterministic rule evaluation.
 * @returns {{ decision: 'allow'|'deny'|'ask', matched: Array<{effect,text,source}> }}
 */
function applyRules(rules = {}, text) {
  const matched = [];
  let decision = ASK;
  for (const rule of rules.blockInstructions ?? []) {
    if (ruleMatches(rule, text)) {
      matched.push({ effect: 'block', text: String(rule), source: 'rule' });
      decision = DENY; // block always wins
    }
  }
  for (const rule of rules.allowInstructions ?? []) {
    if (ruleMatches(rule, text)) {
      matched.push({ effect: 'allow', text: String(rule), source: 'rule' });
      if (decision !== DENY) decision = ALLOW;
    }
  }
  return { decision, matched };
}

const CLASSIFIER_SYSTEM = [
  'You are a safety reviewer for a local AI agent that runs on the user\'s own machine.',
  'You are given one proposed action and the user\'s own allow/block instructions.',
  'Decide whether the action should be allowed to run without asking the user.',
  '',
  'Answer with ONE JSON object and nothing else:',
  '{"decision":"allow"|"deny"|"ask",',
  ' "reason":"one sentence, quoting the instruction you applied",',
  ' "proposedAllowRule":null|"a narrow rule that would cover this action next time",',
  ' "proposedAllowRuleReplaces":null|"the existing rule this would replace"}',
  '',
  'Rules:',
  '- "allow" only when one of the user\'s allow instructions clearly covers the action.',
  '- "deny" when one of the user\'s block instructions clearly covers the action,',
  '  or when the action is clearly dangerous and no allow instruction covers it.',
  '- "ask" when the instructions do not settle it. Prefer "ask" when unsure.',
].join('\n');

/**
 * Parse the classifier's answer. Tolerates a fenced block or surrounding prose.
 * @returns {object|null}
 */
function parseDecision(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const decision = [ALLOW, DENY, ASK].includes(parsed.decision) ? parsed.decision : null;
  if (!decision) return null;
  return {
    decision,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 600) : '',
    proposedAllowRule: typeof parsed.proposedAllowRule === 'string' ? parsed.proposedAllowRule.slice(0, 400) : null,
    proposedAllowRuleReplaces: typeof parsed.proposedAllowRuleReplaces === 'string' ? parsed.proposedAllowRuleReplaces.slice(0, 400) : null,
  };
}

/**
 * Review one proposed action — rules only.
 *
 * The deterministic rules are the user's own words, so they are cheap enough
 * to evaluate on every mutating action, and a block must be honoured even
 * when the permission matrix would otherwise allow the action outright.
 *
 * @returns {{ decision: 'allow'|'deny'|'ask', matched: Array, skipped: boolean }}
 */
function reviewByRules({ action = {}, rules = {}, enabled = true } = {}) {
  if (!enabled) {
    return { decision: ASK, reason: 'auto-review is switched off', matched: [], skipped: true };
  }
  const ruled = applyRules(rules, actionText(action));
  if (ruled.decision !== ASK) {
    return {
      decision: ruled.decision,
      reason: ruled.matched.map((m) => `${m.effect} rule: ${m.text}`).join('; '),
      matched: ruled.matched,
      skipped: false,
    };
  }
  return { decision: ASK, reason: 'no rule matched', matched: [], skipped: false };
}

/**
 * Ask the MODEL to review one proposed action.
 *
 * This is the expensive half: it costs a model call, so it runs only for
 * actions that would otherwise interrupt the human. Its answer must be strict
 * JSON; anything else degrades to `ask`, never to `allow`.
 *
 * @param {object} opts
 * @param {object} opts.action   { tool, arguments, description }
 * @param {object} [opts.rules]
 * @param {string} [opts.context]
 * @param {Function} [opts.complete]  async (messages) => string
 * @returns {Promise<{ decision, reason, matched, proposedAllowRule?, skipped }>}
 */
async function reviewWithModel({ action = {}, rules = {}, context = '', complete } = {}) {
  if (typeof complete !== 'function') {
    return { decision: ASK, reason: 'no reviewer available', matched: [], skipped: false };
  }
  const text = actionText(action);
  let answer;
  try {
    answer = await complete([
      { role: 'system', content: CLASSIFIER_SYSTEM },
      {
        role: 'user',
        content: [
          'Proposed action:',
          text || '(no description)',
          '',
          'User allow instructions:',
          (rules.allowInstructions ?? []).length ? rules.allowInstructions.map((r) => `- ${r}`).join('\n') : '(none)',
          '',
          'User block instructions:',
          (rules.blockInstructions ?? []).length ? rules.blockInstructions.map((r) => `- ${r}`).join('\n') : '(none)',
          context ? `\nRecent conversation:\n${String(context).slice(0, 4000)}` : '',
          '',
          'Answer with the JSON object only.',
        ].join('\n'),
      },
    ]);
  } catch (error) {
    return {
      decision: ASK,
      reason: `the reviewer could not be reached (${String(error?.message ?? error).slice(0, 200)})`,
      matched: [],
      skipped: false,
    };
  }

  const parsed = parseDecision(answer);
  if (!parsed) {
    // An unusable answer must never become an approval.
    return {
      decision: ASK,
      reason: 'the reviewer did not return a usable decision',
      matched: [],
      skipped: false,
    };
  }
  return {
    decision: parsed.decision,
    reason: parsed.reason || 'reviewed by the model reviewer',
    matched: [],
    proposedAllowRule: parsed.proposedAllowRule,
    proposedAllowRuleReplaces: parsed.proposedAllowRuleReplaces,
    skipped: false,
  };
}

/**
 * Review one proposed action: the user's rules, then the model.
 *
 * This is the combined entry point. The governance ladder uses the two
 * phases separately so that the cheap phase can run on every mutating action
 * while the expensive phase only runs when a human would otherwise be
 * interrupted.
 */
async function review({ action = {}, rules = {}, context = '', complete, enabled = true } = {}) {
  const ruled = reviewByRules({ action, rules, enabled });
  if (ruled.decision !== ASK) return ruled;
  return reviewWithModel({ action, rules, context, complete });
}

module.exports = {
  ALLOW, DENY, ASK,
  actionText, applyRules, parseDecision, review, reviewByRules, reviewWithModel, ruleMatches,
};
