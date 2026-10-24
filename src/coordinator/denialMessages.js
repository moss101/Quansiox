'use strict';
/**
 * Denial messages — what the agent is told when an action is refused.
 *
 * A refusal that says only "permission denied" is a bad refusal: the model
 * either retries in a loop or gives up on the whole task. The reference
 * implementation (Grok Bot) uses a catalogue of refusals that are written to be
 * *actionable by the model*:
 *
 *   - state what did not happen, in plain words;
 *   - say explicitly NOT to retry, so a refused action is not attempted again
 *     in a loop;
 *   - name an alternative mechanism the model can use right now;
 *   - say what the user could change if they want this to work;
 *   - never leak that the refusal was a *policy* decision the user made
 *     adversarially (no prompt-injection surface).
 *
 * We keep that shape and add the cases the local-first product needs.
 *
 * Pure module — no I/O.
 */

/** Why an action was refused. */
const REASON = {
  PERMISSION_MODE: 'permission-mode',
  TOOL_BLOCKED: 'tool-blocked',
  STANDING_DENIAL: 'standing-denial',
  USER_DECLINED: 'user-declined',
  USER_UNANSWERED: 'user-unanswered',
  ALREADY_ASKED: 'already-asked',
  NO_CHANNEL: 'no-channel',
  AUTO_REVIEW_BLOCKED: 'auto-review-blocked',
  OUTSIDE_WORKSPACE: 'outside-workspace',
  TOO_LONG: 'too-long',
  COMPUTER_OFF: 'computer-off',
  MESSAGES_OFF: 'messages-off',
  SECRETS_UNAVAILABLE: 'secrets-unavailable',
};

/**
 * Each entry carries the pieces a refusal needs. `alternatives` are short
 * tool-level suggestions; `userAction` is what a human could change.
 */
const CATALOGUE = {
  [REASON.PERMISSION_MODE]: {
    text: (t, detail) => `refused: the permission mode for this turn does not allow ${t}${detail ? ` (${detail})` : ''}. Nothing ran. Do not retry it while the mode stays as it is.`,
    doNotRetry: true,
    alternatives: (t) => (t.startsWith('computer_') || t.startsWith('browser_')
      ? ['Use the file and shell tools instead, or ask the user to switch the turn to a mode that allows driving the screen.']
      : ['Use a read-only tool instead, or ask the user to raise the permission mode.']),
    userAction: 'Raise the permission mode for this conversation (Settings → Permissions).',
  },
  [REASON.TOOL_BLOCKED]: {
    text: (t) => `refused: ${t} is blocked by the tool permission matrix. Nothing ran. Do not retry it while it stays blocked.`,
    doNotRetry: true,
    alternatives: () => ['Do the work with the tools that are allowed, and say what you could not do.'],
    userAction: 'Allow the tool in Settings → Permissions → Tool matrix.',
  },
  [REASON.STANDING_DENIAL]: {
    text: (t) => `refused: the user has permanently denied ${t} for this workspace. Nothing ran. Do not retry it.`,
    doNotRetry: true,
    alternatives: () => ['Do the work another way, and tell the user what you could not do.'],
    userAction: 'Revoke the standing denial in Settings → Permissions if it was a mistake.',
  },
  [REASON.USER_DECLINED]: {
    text: (t) => `refused: the user declined this action${t ? ` (${t})` : ''}. Nothing ran. Do not retry it.`,
    doNotRetry: true,
    alternatives: () => ['Do something else, or ask the user what they would prefer.'],
    userAction: 'Approve the action if it is needed.',
  },
  [REASON.USER_UNANSWERED]: {
    text: (t) => `refused: the request to run ${t} on this machine was not answered, so nothing ran. Do not retry it in this turn.`,
    doNotRetry: true,
    alternatives: () => ['Tell the user you are waiting on their approval, and continue with something else meanwhile.'],
    userAction: 'Answer the approval prompt when it appears.',
  },
  [REASON.ALREADY_ASKED]: {
    text: (t) => `refused: the user was already asked about this exact action${t ? ` (${t})` : ''} and did not approve it, so it will not run and will not be asked again for this task. A later permission change does not authorize it. Do not retry it.`,
    doNotRetry: true,
    alternatives: () => ['Say so in chat and let the user ask for it explicitly, and use another mechanism meanwhile.'],
    userAction: 'Ask for the action directly in chat if it is still needed.',
  },
  [REASON.NO_CHANNEL]: {
    text: (t) => `refused: running ${t} needs the user's permission, and this turn has nowhere to ask for it. Nothing ran. Do not retry it.`,
    doNotRetry: true,
    alternatives: () => ['Do the work with tools that do not need approval, or ask the user to run it themselves.'],
    userAction: 'Run this turn in a conversation where approvals can be shown.',
  },
  [REASON.AUTO_REVIEW_BLOCKED]: {
    text: (t) => `refused: blocked by an auto-review rule — the safety review blocked ${t}. Nothing ran. Do not retry it as written.`,
    doNotRetry: true,
    alternatives: () => ['Rewrite the action so it does what the user asked without the blocked part, or explain what was blocked and why.'],
    userAction: 'Adjust the auto-review rules in Settings → Permissions if this action should be allowed.',
  },
  [REASON.OUTSIDE_WORKSPACE]: {
    text: (t) => `refused: ${t} writes outside this conversation's workspace. Nothing ran. Do not retry it.`,
    doNotRetry: true,
    alternatives: () => ['Write inside the workspace instead, and tell the user what you left out.'],
    userAction: 'Point the conversation at a different workspace, or allow the path explicitly.',
  },
  [REASON.TOO_LONG]: {
    text: (t) => `refused: ${t} was too long to show the user for approval, so it was not run. Do not retry it whole.`,
    doNotRetry: true,
    alternatives: () => ['Split the work into smaller steps that each fit in an approval card.'],
    userAction: 'Run the larger step yourself.',
  },
  [REASON.COMPUTER_OFF]: {
    text: (t) => `refused: computer use is disabled for the agent — computer control is turned off in the settings, so ${t} cannot run. Nothing ran. Do not retry it.`,
    doNotRetry: true,
    alternatives: () => ['Use the file and shell tools instead of driving the screen.'],
    userAction: 'Turn computer control on in Settings → Permissions, and grant Accessibility and Screen Recording access.',
  },
  [REASON.MESSAGES_OFF]: {
    text: () => 'refused: Messages is disabled for the agent — Messages is turned off in the settings, so their Messages cannot be read or sent from here. Do not retry while it stays off.',
    doNotRetry: true,
    alternatives: () => ['Ask the user to send it, or use another channel that is enabled.'],
    userAction: 'Turn Messages on in Settings → Permissions.',
  },
  [REASON.SECRETS_UNAVAILABLE]: {
    text: () => 'refused: the secret this action needs could not be released, so nothing ran. Do not retry it.',
    doNotRetry: true,
    alternatives: () => ['Ask the user to supply the value, or do the step that does not need the secret.'],
    userAction: 'Unlock the vault, or store the secret.',
  },
};

/**
 * Build a refusal message.
 *
 * @param {string} reason   one of REASON
 * @param {object} [opts]
 * @param {string} [opts.tool]      the tool that was refused
 * @param {string} [opts.detail]    extra context (a path, a recipient…)
 * @returns {{ reason: string, text: string, doNotRetry: boolean, alternatives: string[], userAction: string }}
 */
function denial(reason, opts = {}) {
  const entry = CATALOGUE[reason] ?? CATALOGUE[REASON.TOOL_BLOCKED];
  const tool = String(opts.tool ?? 'this action');
  const detail = opts.detail ? ` (${opts.detail})` : '';
  const parts = [entry.text(tool, opts.detail ?? '')];
  const alternatives = entry.alternatives(tool);
  if (alternatives.length) parts.push(`Try instead: ${alternatives.join(' ')}`);
  parts.push(entry.userAction);
  return {
    reason,
    text: parts.join(' '),
    doNotRetry: entry.doNotRetry !== false,
    alternatives,
    userAction: entry.userAction,
  };
}

/**
 * Format a denial for the model. The tool call returns the text; the
 * structured parts are kept alongside for the UI and the governance log.
 */
function refusalText(reason, opts = {}) {
  return denial(reason, opts).text;
}

module.exports = { REASON, CATALOGUE, denial, refusalText };
