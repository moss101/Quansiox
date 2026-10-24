'use strict';
/**
 * Auto-review rules (Settings → Security): decide whether a gated tool call
 * can skip the human approval prompt (allow) or must be refused (deny) based
 * on stored instruction lists. Block wins; no match falls through to the
 * interactive prompt. A rule is plain text (case-insensitive substring) or
 * /regex/ wrapped in slashes.
 */

function asText(value) {
  return String(value ?? '');
}

function ruleMatches(pattern, text) {
  const raw = asText(pattern).trim();
  if (!raw) return false;
  if (raw.length > 2 && raw.startsWith('/') && raw.endsWith('/')) {
    try { return new RegExp(raw.slice(1, -1), 'i').test(text); } catch { return false; }
  }
  return text.toLowerCase().includes(raw.toLowerCase());
}

/** What the reviewer sees: the shell command, or the JSON args of the tool. */
function autoReviewText(tool, args) {
  if (tool === 'shell') return asText(args?.command);
  try { return JSON.stringify(args ?? {}); } catch { return ''; }
}

/**
 * @returns {'deny'|'allow'|null} null = no automated verdict, ask the user.
 */
function autoReviewVerdict(instructions, text) {
  if (!instructions || instructions.isEnabled !== true) return null;
  const hay = asText(text);
  if ((instructions.blockInstructions ?? []).some((p) => ruleMatches(p, hay))) return 'deny';
  if ((instructions.allowInstructions ?? []).some((p) => ruleMatches(p, hay))) return 'allow';
  return null;
}

function verdictForTool(instructions, tool, args) {
  return autoReviewVerdict(instructions, autoReviewText(tool, args));
}

module.exports = { autoReview: { ruleMatches, autoReviewText, autoReviewVerdict, verdictForTool } };
