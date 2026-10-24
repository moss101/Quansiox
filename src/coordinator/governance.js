'use strict';
/**
 * Governance — the single decision point for "may this action run?".
 *
 * Everything about permissions lives here, so there is exactly one place to
 * look when asking "why did it refuse that?" and exactly one place to change
 * when adding a gate.
 *
 * The decision ladder, in order:
 *
 *   1. standing denial     — "never this tool" wins over everything
 *   2. standing grant      — "always this exact action" allows it
 *   3. the permission mode — read-only / workspace / computer
 *   4. the tool matrix     — always_allow / needs_approval / blocked
 *   5. auto-review         — the user's rules, then the model reviewer
 *   6. the human           — the approval card
 *
 * Every outcome is recorded in a governance log so the UI can answer "why did
 * it refuse that?" and so a run can be audited after the fact.
 *
 * Pure-ish: the approval callback and the model completion are injected, so
 * the whole ladder is testable without a window or a provider.
 */
const policyEngine = require('../shared/policy');
const { denial, REASON } = require('./denialMessages');
const autoReview = require('./autoReviewClassifier');

/**
 * Tools that always need a human decision, whatever the matrix says.
 * These either change something irreversible or reach outside the machine.
 *
 * Note what is NOT here: `request_secret` and `request_user_input` are
 * inherently interactive — the user is being asked for something, so there is
 * nothing to approve.
 */
const ALWAYS_ASK = new Set([
  'github_pr_create', 'slack_post_message', 'email_send', 'messages_send',
  'browser_fill_credentials', 'browser_import_cookies',
]);

/** The last N governance decisions, for the UI's governance log. */
const LOG_LIMIT = 500;
const log = [];
let logSeq = 0;

function record(entry) {
  logSeq += 1;
  const row = { seq: logSeq, at: Date.now(), ...entry };
  log.push(row);
  if (log.length > LOG_LIMIT) log.shift();
  try {
    require('../main/ipc/emitEvent').emitEvent('agent', 'onGovernance', row);
  } catch { /* the coordinator's event channel is best-effort */ }
  return row;
}

function governanceLog({ sessionId, limit = 100 } = {}) {
  const rows = sessionId ? log.filter((r) => r.sessionId === sessionId) : log;
  return { entries: rows.slice(-Math.max(1, Math.min(Number(limit) || 100, LOG_LIMIT))) };
}

/** The standing consent decision for a tool ('allow' | 'deny' | undefined). */
function consentFor(name, sessionId) {
  try {
    const { consentService } = require('../main/services/consentService');
    return consentService.getGrant(sessionId, name) ?? consentService.getGrant('*', name);
  } catch {
    return undefined;
  }
}

/**
 * The "target" an action is bound to.
 *
 * A standing grant must be bound to *what* was approved, not just to the tool
 * name — "always allow git push" must not become "always allow shell".
 */
function targetFor(name, args = {}) {
  const tool = String(name || '');
  if (tool === 'shell') return String(args?.command ?? '');
  if (tool.startsWith('write_file') || tool.startsWith('edit_file')) return String(args?.path ?? '');
  if (tool.startsWith('computer_') || tool.startsWith('browser_')) {
    return String(args?.bundle_id ?? args?.app_name ?? args?.url ?? '');
  }
  if (tool === 'email_send') return String(args?.to ?? '');
  if (tool === 'slack_post_message') return String(args?.channel ?? '');
  if (tool === 'messages_send') return String(args?.to ?? '');
  if (tool === 'github_pr_create') return String(args?.repo ?? '');
  return '';
}

/**
 * Is there a standing grant that covers this exact action?
 * @returns {{ covered: boolean, grant: object|null }}
 */
function standingGrantFor(name, args = {}) {
  try {
    const { standingGrantsService } = require('../main/services/standingGrantsService');
    const target = targetFor(name, args);
    const covered = standingGrantsService.has({
      scope: 'action',
      action: String(name),
      target,
    });
    return { covered, grant: covered ? { action: String(name), target } : null };
  } catch {
    return { covered: false, grant: null };
  }
}

/**
 * The policy the USER configured — always applied, never optional.
 *
 * This is the base the effective policy is built from. It reads the settings
 * (permission mode, computer/browser toggles) and the persisted tool matrix.
 */
function basePolicyFromSettings(settings = null) {
  let resolved = settings;
  if (!resolved) {
    try {
      resolved = require('../main/services/settingsService').settingsService.load();
    } catch {
      resolved = {};
    }
  }
  const mode = policyEngine.normalizeMode(resolved.permissionMode || policyEngine.MODE_WORKSPACE);

  let matrix = null;
  let scopes = null;
  try {
    const { toolPermissionsService } = require('../main/services/toolPermissionsService');
    matrix = toolPermissionsService.get({ scope: 'global', mode }).matrix;
    const listed = toolPermissionsService.list();
    scopes = {};
    for (const entry of listed.scopes) {
      if (entry.scope === 'global') continue;
      scopes[entry.scope] = entry.matrix;
    }
  } catch {
    // The matrix store is unavailable (a fresh install, a read-only disk):
    // the mode default still applies.
  }

  return {
    mode,
    matrix,
    scopes,
    // Computer use stays off until the user opts in — but the MODE is what
    // decides whether computer tools are even offered.
    enableComputer: resolved.allowComputerUse !== false,
    enableBrowser: resolved.allowBrowser !== false,
    enableFileMutation: resolved.enableFileMutation !== false,
    fanOut: resolved.fanOut !== false,
  };
}

/**
 * Build the effective policy for a turn.
 *
 * The user's mode and matrix always apply. The optional model-based router
 * (the Jev classifier) may only NARROW the policy — it can never widen it.
 * That is the whole point of W1.1: a permissive classifier must not switch
 * the safety machinery off.
 */
function effectivePolicy({ base = {}, classifier = null, shellMutates = null } = {}) {
  const merged = policyEngine.defaultPolicy(base);
  if (classifier && !classifier.permissive) {
    // Narrowing only.
    if (classifier.permissionMode && classifier.permissionMode !== merged.mode) {
      // A classifier may move *down* the ladder, never up.
      const order = policyEngine.MODES;
      if (order.indexOf(classifier.permissionMode) < order.indexOf(merged.mode)) {
        merged.mode = classifier.permissionMode;
      }
    }
    if (classifier.enableComputer === false) merged.enableComputer = false;
    if (classifier.enableBrowser === false) merged.enableBrowser = false;
    if (classifier.enableFileMutation === false) merged.enableFileMutation = false;
    if (classifier.fanOut === false) merged.fanOut = false;
    if (Number.isFinite(classifier.depth)) merged.depth = classifier.depth;
    if (Array.isArray(classifier.allowlist)) merged.allowlist = classifier.allowlist.map(String);
    merged.route = classifier.route || merged.route;
    // Remember that the ROUTE came from the classifier, so the tool list is
    // not narrowed by an allow set the user never asked for.
    merged.classifierRoute = classifier.route || null;
  }
  merged.permissive = false;
  if (typeof shellMutates === 'function') merged.shellMutates = shellMutates;
  return merged;
}

/** Does the matrix explicitly mention this tool? */
function explicitLevel(policy, tool) {
  const explicit = policy?.matrix?.tools?.[tool];
  return explicit ?? null;
}

/**
 * Govern one tool call.
 *
 * @param {object} opts
 * @param {string} opts.name                the tool
 * @param {object} [opts.args]              its arguments
 * @param {string} [opts.cwd]
 * @param {string} [opts.sessionId]
 * @param {object} [opts.policy]            the effective policy
 * @param {Function} [opts.requestConfirm]  async (request) => boolean
 * @param {Function} [opts.complete]        async (messages) => string — the model call
 * @param {object} [opts.rules]             auto-review rules
 * @param {string} [opts.context]           recent conversation for the reviewer
 * @param {boolean} [opts.autoReviewEnabled]
 * @param {Function} [opts.onDecision]      callback for the governance log
 * @returns {Promise<{ allowed: boolean, refusal: string|null, decision: string, gate: string, reason: string, detail?: object }>}
 */
/**
 * A hard prerequisite for a tool family, checked BEFORE anything else.
 *
 * Some tools cannot work at all in the current configuration — Messages is
 * off, computer use is off. Asking the user to approve such an action is
 * theatre: the action would fail anyway. These produce the specific refusal
 * instead, so the model learns the real reason.
 *
 * @returns {{ reason: string }|null}
 */
function prerequisiteRefusal(name, settings) {
  const tool = String(name || '');
  // Only *sending* is gated by the Messages switch. Reading the message
  // store is governed by the macOS permission prompts the service itself
  // raises, and `messages_status` must keep reporting the real state.
  if (tool === 'messages_send') {
    if (settings?.messagesEnabled !== true) return { reason: REASON.MESSAGES_OFF };
  }
  return null;
}

/**
 * Govern one tool call.
 *
 * @param {object} opts
 * @param {string} opts.name                the tool
 * @param {object} [opts.args]              its arguments
 * @param {string} [opts.cwd]
 * @param {string} [opts.sessionId]
 * @param {object} [opts.policy]            the effective policy
 * @param {object} [opts.settings]          the current settings
 * @param {Function} [opts.requestConfirm]  async (request) => boolean
 * @param {Function} [opts.complete]        async (messages) => string — the model call
 * @param {object} [opts.rules]             auto-review rules
 * @param {string} [opts.context]           recent conversation for the reviewer
 * @param {boolean} [opts.autoReviewEnabled]
 * @returns {Promise<{ allowed: boolean, refusal: string|null, decision: string, gate: string, reason: string, detail?: object }>}
 */
async function governToolCall(opts = {}) {
  const {
    name, args = {}, cwd, sessionId, policy, settings = null, requestConfirm,
    complete, rules = {}, context = '', autoReviewEnabled = true,
  } = opts;

  // The user's own rules are opt-in: they only bite when the user wrote them
  // and switched them on.
  const rulesEnabled = rules?.isEnabled === true;

  const tool = String(name || '');
  // Child policies are still in the legacy shape (`permissionMode`,
  // `allowlist`); the engine expects `mode` + `matrix`. Convert here so the
  // ladder always sees one shape.
  const { toEnginePolicy, configuredMode } = require('./permissions');
  const p = toEnginePolicy(policy, configuredMode());
  if (typeof p.shellMutates !== 'function') {
    p.shellMutates = (command) => {
      try { return require('./shell-analyze').mutating(command); } catch { return true; }
    };
  }

  // 0. Hard prerequisites — a tool that cannot work in this configuration is
  // refused with the real reason, not with an approval prompt.
  const prerequisite = prerequisiteRefusal(tool, settings);
  if (prerequisite) {
    const d = denial(prerequisite.reason, { tool });
    record({ sessionId, tool, decision: 'deny', gate: 'prerequisite', reason: d.reason });
    return { allowed: false, refusal: d.text, decision: 'deny', gate: 'prerequisite', reason: d.reason };
  }

  // 1. A standing denial is unconditional.
  const consent = consentFor(tool, sessionId);
  if (consent === 'deny') {
    const d = denial(REASON.STANDING_DENIAL, { tool });
    record({ sessionId, tool, decision: 'deny', gate: 'standing-denial', reason: d.reason });
    return { allowed: false, refusal: d.text, decision: 'deny', gate: 'standing-denial', reason: d.reason };
  }

  // 2. A standing grant covers this exact action.
  const grant = standingGrantFor(tool, args);
  const effectiveConsent = consent === 'allow' ? 'allow' : (grant.covered ? 'allow' : undefined);

  // 3 + 4. Mode and matrix.
  const decision = policyEngine.decide({
    policy: p,
    tool,
    args,
    consent: effectiveConsent,
  });

  // 5a. The user's own rules — cheap, and a block must be honoured even when
  // the matrix would otherwise allow the action outright. This is the
  // "auto-review decides" gate, independent of whether a human is asked.
  const mutatingClass = ['write', 'outbound', 'drive'].includes(policyEngine.classifyTool(tool));
  if (mutatingClass && rulesEnabled) {
    const ruled = autoReview.reviewByRules({ action: { tool, arguments: args, description: opts.description }, rules });
    if (ruled.decision === autoReview.DENY) {
      const d = denial(REASON.AUTO_REVIEW_BLOCKED, { tool });
      record({ sessionId, tool, decision: 'deny', gate: 'auto-review-rule', reason: ruled.reason });
      return {
        allowed: false,
        refusal: d.text,
        decision: 'deny',
        gate: 'auto-review-rule',
        reason: ruled.reason,
        detail: { autoReview: ruled },
      };
    }
    if (ruled.decision === autoReview.ALLOW) {
      record({ sessionId, tool, decision: 'allow', gate: 'auto-review-rule', reason: ruled.reason });
      return {
        allowed: true,
        refusal: null,
        decision: 'allow',
        gate: 'auto-review-rule',
        reason: ruled.reason,
        detail: { autoReview: ruled },
      };
    }
  }

  if (decision.decision === policyEngine.DENY) {
    const reason = decision.gate === 'mode'
      ? denial(REASON.PERMISSION_MODE, { tool, detail: decision.reason })
      : decision.gate === 'matrix'
        ? denial(REASON.TOOL_BLOCKED, { tool })
        : { text: `refused: ${decision.reason}`, reason: decision.reason };
    // A gated-off computer tool (or a screen read outside computer mode)
    // gets the specific computer message.
    const computerReason = decision.reason.includes('computer tools are gated off')
      || decision.reason.includes('cannot look at the screen');
    const refusal = computerReason
      ? denial(REASON.COMPUTER_OFF, { tool }).text
      : reason.text;
    record({ sessionId, tool, decision: 'deny', gate: decision.gate, reason: decision.reason });
    return {
      allowed: false,
      refusal,
      decision: 'deny',
      gate: decision.gate,
      reason: decision.reason,
    };
  }

  // A destructive shell command is worth a question even when the tool class
  // would allow it — unless the user explicitly allowed the tool itself.
  let needsHuman = decision.decision === policyEngine.ASK;
  let forcedReason = null;
  if (tool === 'shell' && !explicitLevel(p, 'shell') && effectiveConsent !== 'allow') {
    let destructive = true;
    try {
      destructive = require('./shell-analyze').analyze(String(args?.command || '')).destructive === true;
    } catch { destructive = true; } // fail closed
    if (destructive) {
      needsHuman = true;
      forcedReason = REASON.USER_DECLINED;
    }
  }
  if (ALWAYS_ASK.has(tool) && effectiveConsent !== 'allow' && explicitLevel(p, tool) !== policyEngine.LEVEL_ALWAYS_ALLOW) {
    needsHuman = true;
  }
  if (!needsHuman) {
    record({ sessionId, tool, decision: 'allow', gate: decision.gate, reason: decision.reason });
    return {
      allowed: true,
      refusal: null,
      decision: 'allow',
      gate: decision.gate,
      reason: decision.reason,
      detail: grant.covered ? { standingGrant: grant.grant } : undefined,
    };
  }

  // 5b. The model reviewer — only for actions that would otherwise interrupt
  // the human. It can settle the call without bothering them.
  if (autoReviewEnabled && typeof complete === 'function') {
    const verdict = await autoReview.reviewWithModel({
      action: { tool, arguments: args, description: opts.description },
      rules,
      context,
      complete,
    });
    if (verdict.decision === autoReview.DENY) {
      const d = denial(REASON.AUTO_REVIEW_BLOCKED, { tool });
      record({ sessionId, tool, decision: 'deny', gate: 'auto-review', reason: verdict.reason });
      return {
        allowed: false,
        refusal: d.text,
        decision: 'deny',
        gate: 'auto-review',
        reason: verdict.reason,
        detail: { autoReview: verdict },
      };
    }
    if (verdict.decision === autoReview.ALLOW) {
      record({ sessionId, tool, decision: 'allow', gate: 'auto-review', reason: verdict.reason });
      return {
        allowed: true,
        refusal: null,
        decision: 'allow',
        gate: 'auto-review',
        reason: verdict.reason,
        detail: { autoReview: verdict },
      };
    }
  }

  // 6. The human.
  if (typeof requestConfirm !== 'function') {
    const d = denial(REASON.NO_CHANNEL, { tool });
    record({ sessionId, tool, decision: 'deny', gate: 'no-channel', reason: d.reason });
    return { allowed: false, refusal: d.text, decision: 'deny', gate: 'no-channel', reason: d.reason };
  }
  const request = {
    id: `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    tool,
    action: targetFor(tool, args) || tool,
    target: targetFor(tool, args),
    targetKind: policyEngine.classifyTool(tool),
    description: opts.description ?? '',
    argsPreview: previewArgs(args),
    cwd: cwd ?? null,
    sessionId: sessionId ?? null,
    expiresAtMs: Date.now() + 120_000,
  };
  const approved = await requestConfirm(request);
  if (approved === true) {
    record({ sessionId, tool, decision: 'allow', gate: 'approval', reason: 'approved by the user' });
    return { allowed: true, refusal: null, decision: 'allow', gate: 'approval', reason: 'approved by the user' };
  }
  const d = denial(forcedReason ?? REASON.USER_DECLINED, { tool });
  record({ sessionId, tool, decision: 'deny', gate: 'approval', reason: d.reason });
  return { allowed: false, refusal: d.text, decision: 'deny', gate: 'approval', reason: d.reason, detail: { request } };
}

/**
 * A short, SAFE preview of a tool's arguments for the approval card.
 *
 * Values that look like credentials are masked, and the preview is capped —
 * an approval card must never become a data-exfiltration channel.
 */
function previewArgs(args) {
  const SECRET_KEY = /(pass|password|secret|token|api[_-]?key|authorization|cookie|otp|pin|private)/i;
  const MAX = 400;
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (SECRET_KEY.test(key)) { out[key] = '•••'; continue; }
    if (typeof value === 'string') {
      out[key] = value.length > MAX ? `${value.slice(0, MAX)}…` : value;
    } else if (value == null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else {
      try {
        const text = JSON.stringify(value);
        out[key] = text.length > MAX ? `${text.slice(0, MAX)}…` : text;
      } catch {
        out[key] = '…';
      }
    }
  }
  return out;
}

module.exports = {
  ALWAYS_ASK,
  basePolicyFromSettings,
  consentFor,
  effectivePolicy,
  governToolCall,
  governanceLog,
  previewArgs,
  prerequisiteRefusal,
  standingGrantFor,
  targetFor,
};
