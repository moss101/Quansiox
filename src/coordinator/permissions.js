'use strict';
/**
 * Permission checks for parent turns and subagents.
 *
 * The decision logic now lives in `src/shared/policy.js` so the main process,
 * the forked coordinator and the renderer all agree on it. This module keeps
 * the coordinator-facing API (`guardTool`, `toolsForPolicy`) and the legacy
 * refusal wording that the tool-call layer surfaces to the model; the richer,
 * actionable refusals live in `denialMessages.js` and are produced by
 * `governance.js`.
 *
 * THE BEHAVIOURAL CHANGE (2026-10-20 repair pass):
 *
 *   Before: a policy of `{ permissive: true }` returned "allow" for EVERY
 *   tool, and the coordinator built exactly that policy unless a third-party
 *   `TYPESAFE_API_KEY` happened to be present. The allowlist, the permission
 *   modes and the fan-out caps were code that never executed in a default
 *   install.
 *
 *   Now: a policy always names a mode. `permissive` means only "the optional
 *   model-based router had no opinion" — it never disables a gate.
 */
const policyEngine = require('../shared/policy');
const shellAnalyzer = require('./shell-analyze');

const COMPUTER_CAPABLE = policyEngine.MODE_COMPUTER;

/** Global standing-consent decision for a tool, or undefined when none. */
function consentFor(name) {
  try {
    return require('../main/services/consentService').consentService.getGrant('*', String(name));
  } catch {
    return undefined; // consent store unavailable → behave as before
  }
}

/**
 * Structural shell analysis (quotes, substitutions, pipelines, redirections)
 * shared with the coordinator's permission gate.
 */
function shellMutates(command) {
  try { return shellAnalyzer.mutating(command); } catch { return true; } // fail closed
}

/**
 * Translate a (possibly legacy) policy object into an engine policy.
 *
 * Legacy policies used `permissionMode`; the engine uses `mode`. Both are
 * accepted, and a policy with neither falls back to the configured default
 * mode — never to "allow everything".
 */
function toEnginePolicy(policy, fallbackMode) {
  if (!policy) return policyEngine.defaultPolicy({ mode: fallbackMode });
  if (policy.version === 1 && policy.matrix && policy.mode) return policy;
  const mode = policy.mode || policy.permissionMode || fallbackMode;
  return policyEngine.defaultPolicy({
    mode,
    matrix: policy.matrix,
    scopes: policy.scopes,
    allowlist: policy.allowlist,
    enableComputer: policy.enableComputer,
    enableBrowser: policy.enableBrowser,
    enableFileMutation: policy.enableFileMutation,
    fanOut: policy.fanOut,
    depth: policy.depth,
    route: policy.route,
    permissive: policy.permissive,
  });
}

/** The configured default permission mode. */
function configuredMode() {
  try {
    const settings = require('../main/services/settingsService').settingsService.load();
    return policyEngine.normalizeMode(settings.permissionMode || policyEngine.MODE_WORKSPACE);
  } catch {
    return policyEngine.MODE_WORKSPACE;
  }
}

/**
 * @returns {string|null} refusal text, or null when the call may proceed.
 */
function guardTool(name, args, policy) {
  const grant = consentFor(name);
  if (grant === 'deny') return `refused: ${name} is blocked by a standing denial`;
  const enginePolicy = toEnginePolicy(policy, configuredMode());
  enginePolicy.shellMutates = shellMutates;
  const verdict = policyEngine.decide({
    policy: enginePolicy,
    tool: name,
    args,
    consent: grant === 'allow' ? 'allow' : undefined,
  });
  if (verdict.decision !== policyEngine.DENY) return null;

  // Legacy wording, kept stable for the tests and the tool-call layer.
  const mode = enginePolicy.mode;
  const class_ = policyEngine.classifyTool(name);
  if (verdict.gate === 'mode') {
    // The specific reason must survive: "browser tools are gated off" and
    // "permission mode X cannot drive Y" say different things.
    if (verdict.reason.includes('gated off')) return `refused: ${verdict.reason}`;
    if (class_ === 'drive' || class_ === 'screen') return `refused: permission mode ${mode} cannot drive ${name}`;
    if (class_ === 'write' || class_ === 'outbound') return `refused: read-only subagent cannot write (${name})`;
    return `refused: ${verdict.reason}`;
  }
  if (verdict.gate === 'depth') return `refused: ${verdict.reason}`;
  if (verdict.gate === 'allowlist') return `refused: ${name} is not in this subagent's tool allowlist`;
  if (verdict.gate === 'matrix') return `refused: ${name} is blocked by the tool permission matrix`;
  return `refused: ${verdict.reason}`;
}

/**
 * Filter the tool list offered to the model for a policy.
 *
 * Two filters apply, in this order:
 *   1. the optional model-based router's route (it may only narrow) — applied
 *      ONLY when the router actually produced a route. A turn with no
 *      classifier opinion keeps the full tool list, minus what the permission
 *      mode forbids.
 *   2. the permission mode — a tool the mode forbids is never offered.
 */
function toolsForPolicy(allTools, policy) {
  const enginePolicy = toEnginePolicy(policy, configuredMode());
  const list = Array.isArray(allTools) ? allTools : [];
  const route = policy?.classifierRoute ?? (policy?.route && policy.route !== 'direct' ? policy.route : null);

  // 1. Route-based narrowing (the optional model router).
  const allow = new Set(['update_plan']);
  if (route) {
    if (route === 'files_shell') {
      for (const name of ['read_file', 'list_dir', 'glob_files', 'shell', 'read_document', 'list_documents']) allow.add(name);
      if (policy?.enableFileMutation) {
        for (const name of ['write_file', 'edit_file', 'save_document', 'append_document']) allow.add(name);
      }
    }
    if (route === 'computer' && policy?.enableComputer) {
      for (const tool of list) {
        if (tool.function?.name?.startsWith('computer_')) allow.add(tool.function.name);
      }
      allow.add('read_file');
      allow.add('list_dir');
    }
    if (route === 'browser' && policy?.enableBrowser) {
      for (const tool of list) {
        if (tool.function?.name?.startsWith('browser_')) allow.add(tool.function.name);
      }
      allow.add('read_file');
    }
    if (route === 'subagent' && policy?.fanOut) {
      allow.add('task');
      allow.add('read_file');
      allow.add('list_dir');
    }
    if (route === 'direct') {
      // The router decided this turn is a single-shot answer: only the plan
      // tool is offered.
      return policyEngine.toolsForPolicy(
        list.filter((tool) => allow.has(tool.function?.name)),
        enginePolicy,
      );
    }
  }
  if (!Array.isArray(policy?.allowlist) || (policy?.depth ?? 0) < 2) {
    allow.add('task');
    allow.add('team');
    allow.add('wide_research');
    for (const name of ['task_list', 'task_get', 'task_wait', 'task_interrupt', 'task_artifact', 'list_secrets', 'submit_secret', 'request_user_input', 'request_secret', 'recall', 'remember', 'list_skills', 'use_skill', 'search_code', 'glob_files', 'project_knowledge', 'analyze_data', 'slides_deck', 'slides_export', 'design_mark', 'design_edit', 'read_image', 'make_video', 'speak', 'website_build', 'save_document', 'list_documents', 'read_document', 'append_document', 'board_read', 'board_list', 'github_status', 'github_pr_list', 'github_pr_view', 'github_pr_create', 'github_repo', 'github_issue_list', 'slack_status', 'slack_post_message', 'slack_channels', 'slack_history', 'email_status', 'email_send', 'email_search', 'messages_status', 'messages_chats', 'messages_read', 'messages_search', 'messages_send', 'await_shell', 'read_shell_output', 'write_shell_input', 'message_subagent', 'check_subagent', 'wake_parent', 'merge_worktrees', 'speculate', 'discover_ai_tools']) allow.add(name);
    if (enginePolicy.mode !== policyEngine.MODE_READ_ONLY) allow.add('board_write');
  }

  // No router opinion → the whole tool list is available, filtered only by
  // the permission mode. (MCP tools and the file tools live here.)
  const routed = route
    ? list.filter((tool) => allow.has(tool.function?.name))
    : list;
  return policyEngine.toolsForPolicy(routed, enginePolicy);
}

/**
 * Turn a model-router judgment into a policy.
 *
 * The result may only NARROW the policy the user configured — see
 * `governance.effectivePolicy`, which applies the same rule.
 */
function policyFromJudgment(judged) {
  if (!judged || judged.skipped) return { permissive: true };
  const route = judged.route || 'direct';
  let permissionMode = 'read-only';
  if (route === 'files_shell') permissionMode = 'workspace';
  if (route === 'computer' || route === 'browser') permissionMode = 'computer';
  return {
    permissive: false,
    route,
    permissionMode,
    enableComputer: judged.enableComputer === true,
    enableFileMutation: judged.enableFileMutation === true,
    enableBrowser: judged.enableBrowser === true,
    fanOut: true,
    blockedDestructive: judged.blockedDestructive === true,
    allowlist: null,
  };
}

module.exports = {
  shellMutates,
  analyzeShell: (command) => shellAnalyzer.analyze(command),
  guardTool,
  toolsForPolicy,
  policyFromJudgment,
  normalizeMode: policyEngine.normalizeMode,
  toEnginePolicy,
  configuredMode,
  policyEngine,
};
