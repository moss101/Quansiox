'use strict';
/**
 * Policy engine — the single place where "may this agent do this?" is
 * answered.
 *
 * This module is the local-first counterpart of Grok Bot's tool-permission
 * model. Grok ships a per-scope policy shape:
 *
 *   { tools: { <tool>: always_allow | needs_approval | blocked },
 *     reads: <level>, writes: <level> }
 *
 * keyed by scope, with standing grants identified by
 * `(accountScope, scope, action[, recipient])`. We keep the same shape and the
 * same level vocabulary, and drop the account scope (a local-first app has one
 * principal: the person sitting at the machine).
 *
 * THE POINT OF THIS MODULE: a policy is ALWAYS present.
 *
 * Until the 2026-10-20 repair pass, the coordinator built its policy as
 * `{ permissive: true }` unless a third-party `TYPESAFE_API_KEY` happened to be
 * in the environment, and `guardToolCore` returned "allow" for a permissive
 * policy. The whole allowlist / mode / fan-out machinery was therefore code
 * that never executed in a default install. Here, a policy always exists, a
 * permissive *classifier* only means "the classifier had no opinion", and the
 * user's own mode + matrix always applies.
 *
 * Pure module — no Electron, no fs, no network. Both the forked coordinator
 * and the main process require it.
 */

/** Permission modes, weakest first. */
const MODE_READ_ONLY = 'read-only';
const MODE_WORKSPACE = 'workspace';
const MODE_COMPUTER = 'computer';
const MODES = [MODE_READ_ONLY, MODE_WORKSPACE, MODE_COMPUTER];

/** Per-tool permission levels. */
const LEVEL_ALWAYS_ALLOW = 'always_allow';
const LEVEL_NEEDS_APPROVAL = 'needs_approval';
const LEVEL_BLOCKED = 'blocked';
const LEVELS = [LEVEL_ALWAYS_ALLOW, LEVEL_NEEDS_APPROVAL, LEVEL_BLOCKED];

/** Decision outcomes. */
const ALLOW = 'allow';
const ASK = 'ask';
const DENY = 'deny';

/**
 * Tool classification.
 *
 * `read`      — observes the world; safe under every mode.
 * `write`     — changes LOCAL state (files, documents, artifacts, board).
 *               Confined by the sandbox, so it is cheap to allow.
 * `outbound`  — sends something to a third party or out of the machine
 *               (email, Slack, iMessage, a pull request). Not reversible by
 *               deleting a local file, so it is always worth a question.
 * `drive`     — drives the user's GUI or a browser: the highest-impact class,
 *               because the blast radius is the human's actual screen.
 * `control`   — orchestration (delegate, plan, wait). Never mutates by itself.
 */
const READ_TOOLS = new Set([
  'read_file', 'list_dir', 'glob_files', 'search_code',
  'list_documents', 'read_document',
  'board_read', 'board_list',
  'task_list', 'task_get',
  'recall', 'list_secrets', 'list_skills',
  'github_status', 'github_pr_list', 'github_pr_view', 'github_repo', 'github_issue_list',
  'slack_status', 'slack_channels', 'slack_history',
  'email_status', 'email_search',
  'messages_status', 'messages_chats', 'messages_read', 'messages_search',
  'list_mcp_resources', 'read_mcp_resource',
  'project_knowledge', 'read_image',
]);

/**
 * Observing the user's screen or browser.
 *
 * These read the human's actual desktop — a screenshot, an accessibility
 * tree, the tabs they have open. They are not "safe reads" like reading a
 * file: they expose whatever is on the screen right now. They are therefore
 * gated by the mode (no computer mode → no looking) but need no approval once
 * computer mode is on, because they change nothing.
 */
const SCREEN_TOOLS = new Set([
  'computer_screenshot', 'computer_ax_tree', 'computer_find',
  'computer_list_apps', 'computer_list_windows',
  'browser_snapshot', 'browser_console', 'browser_tabs',
]);

const OUTBOUND_TOOLS = new Set([
  'github_pr_create',
  'slack_post_message',
  'email_send',
  'messages_send',
]);

const DRIVE_TOOLS = new Set([
  'computer_click', 'computer_type', 'computer_key', 'computer_scroll',
  'computer_set_value', 'computer_open_app',
  'browser_open', 'browser_click', 'browser_type', 'browser_fill', 'browser_select',
  'browser_press_key', 'browser_scroll', 'browser_js', 'browser_handle_dialog',
  'browser_fill_credentials', 'browser_import_cookies',
]);

const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'shell',
  'save_document', 'append_document',
  'board_write', 'remember',
  'submit_secret', 'request_secret', 'request_user_input',
  'create_artifact', 'update_artifact',
  'render_pdf', 'render_png',
  'agent_js',
  'analyze_data',
  'slides_deck', 'slides_export', 'design_mark', 'design_edit',
  'make_video', 'speak', 'website_build',
]);

/**
 * Classify a tool.
 * @returns {'read'|'write'|'outbound'|'drive'|'screen'|'control'}
 */
function classifyTool(name) {
  const tool = String(name || '');
  if (DRIVE_TOOLS.has(tool)) return 'drive';
  if (SCREEN_TOOLS.has(tool)) return 'screen';
  if (OUTBOUND_TOOLS.has(tool)) return 'outbound';
  if (WRITE_TOOLS.has(tool)) return 'write';
  if (READ_TOOLS.has(tool)) return 'read';
  if (tool.startsWith('computer_') || tool.startsWith('browser_')) return 'drive';
  if (tool.startsWith('mcp__')) return 'write';
  return 'control';
}

/**
 * The default matrix for a permission mode.
 *
 * The ladder is deliberately shaped so that each mode is safe *and* usable:
 *
 *   read-only  — observe only. Every mutation is blocked.
 *   workspace  — local mutations are fine (the sandbox confines them), but
 *                anything that leaves the machine, and anything that drives
 *                the screen, needs a question.
 *   computer   — driving the screen is allowed, but still asked about;
 *                leaving the machine still needs a question.
 */
function defaultMatrixForMode(mode) {
  const normalized = normalizeMode(mode);
  const matrix = {
    tools: {},
    reads: LEVEL_ALWAYS_ALLOW,
    writes: LEVEL_NEEDS_APPROVAL,
    outbound: LEVEL_NEEDS_APPROVAL,
    drive: LEVEL_NEEDS_APPROVAL,
  };
  if (normalized === MODE_READ_ONLY) {
    matrix.writes = LEVEL_BLOCKED;
    matrix.outbound = LEVEL_BLOCKED;
    matrix.drive = LEVEL_BLOCKED;
  } else if (normalized === MODE_WORKSPACE) {
    // Local mutations are sandboxed and confined to the workspace.
    matrix.writes = LEVEL_ALWAYS_ALLOW;
    // Anything that leaves the machine is still worth a question.
    matrix.outbound = LEVEL_NEEDS_APPROVAL;
    // Driving the human's screen needs computer mode.
    matrix.drive = LEVEL_BLOCKED;
  } else if (normalized === MODE_COMPUTER) {
    matrix.writes = LEVEL_ALWAYS_ALLOW;
    matrix.outbound = LEVEL_NEEDS_APPROVAL;
    // Choosing computer mode IS the opt-in to letting the agent drive the
    // screen, so the tools themselves do not each ask again. The per-tool
    // matrix is where a user makes a specific tool ask every time.
    matrix.drive = LEVEL_ALWAYS_ALLOW;
  }
  return matrix;
}

function normalizeMode(mode) {
  return MODES.includes(mode) ? mode : MODE_WORKSPACE;
}

function normalizeLevel(level, fallback = LEVEL_NEEDS_APPROVAL) {
  return LEVELS.includes(level) ? level : fallback;
}

/**
 * Normalize a stored matrix. Unknown shapes degrade to the mode default
 * rather than throwing — a corrupt settings file must not brick the app.
 */
function normalizeMatrix(input, mode) {
  const base = defaultMatrixForMode(mode);
  if (!input || typeof input !== 'object') return base;
  const tools = {};
  if (input.tools && typeof input.tools === 'object') {
    for (const [name, level] of Object.entries(input.tools)) {
      if (!name) continue;
      tools[String(name)] = normalizeLevel(level, LEVEL_NEEDS_APPROVAL);
    }
  }
  return {
    tools,
    reads: normalizeLevel(input.reads, base.reads),
    writes: normalizeLevel(input.writes, base.writes),
    outbound: normalizeLevel(input.outbound, base.outbound),
    drive: normalizeLevel(input.drive, base.drive),
  };
}

/**
 * The policy that always exists.
 *
 * @param {object} [input]
 * @param {string} [input.mode]          read-only | workspace | computer
 * @param {object} [input.matrix]        the user's per-tool matrix for this scope
 * @param {object} [input.scopes]        other scopes' matrices
 * @param {string[]} [input.allowlist]   when set, only these tools are offered
 * @param {boolean} [input.fanOut]       may this turn delegate?
 * @param {number}  [input.depth]        delegation depth
 */
function defaultPolicy(input = {}) {
  const mode = normalizeMode(input.mode);
  const scopes = {};
  for (const [scope, matrix] of Object.entries(input.scopes ?? {})) {
    scopes[String(scope)] = normalizeMatrix(matrix, mode);
  }
  return {
    version: 1,
    mode,
    matrix: normalizeMatrix(input.matrix, mode),
    scopes,
    allowlist: Array.isArray(input.allowlist) ? input.allowlist.map(String) : null,
    enableComputer: input.enableComputer !== false,
    enableBrowser: input.enableBrowser !== false,
    enableFileMutation: input.enableFileMutation !== false,
    fanOut: input.fanOut !== false,
    depth: Number(input.depth) || 0,
    route: String(input.route || 'direct'),
    // The shell analyser, injected by the caller. Without it the engine
    // cannot tell a read-only command from a mutating one, and it fails
    // closed (treats every command as mutating).
    shellMutates: typeof input.shellMutates === 'function' ? input.shellMutates : null,
    // A permissive *classifier* means "the model-based reviewer had no
    // opinion". It never disables the gates above.
    permissive: input.permissive === true,
  };
}

/**
 * The level that applies to a tool under a policy.
 *
 * The user's explicit per-tool matrix wins. Otherwise the mode default for
 * the tool's class applies, except that `drive` tools are always at least
 * `needs_approval` outside `computer` mode.
 */
function levelForTool(policy, tool, scope) {
  const p = policy ?? defaultPolicy();
  const scopeMatrix = scope && p.scopes ? p.scopes[scope] : null;
  const explicit = scopeMatrix?.tools?.[tool] ?? p.matrix?.tools?.[tool];
  if (explicit) return explicit;

  const class_ = classifyTool(tool);
  if (class_ === 'read') return p.matrix?.reads ?? LEVEL_ALWAYS_ALLOW;
  if (class_ === 'write') {
    if (p.mode === MODE_READ_ONLY) return LEVEL_BLOCKED;
    return p.matrix?.writes ?? LEVEL_NEEDS_APPROVAL;
  }
  if (class_ === 'outbound') {
    if (p.mode === MODE_READ_ONLY) return LEVEL_BLOCKED;
    return p.matrix?.outbound ?? LEVEL_NEEDS_APPROVAL;
  }
  if (class_ === 'drive') {
    if (p.mode !== MODE_COMPUTER) return LEVEL_BLOCKED;
    return p.matrix?.drive ?? LEVEL_NEEDS_APPROVAL;
  }
  if (class_ === 'screen') {
    // Looking at the user's screen needs computer mode, but no approval.
    if (p.mode !== MODE_COMPUTER) return LEVEL_BLOCKED;
    return LEVEL_ALWAYS_ALLOW;
  }
  return LEVEL_ALWAYS_ALLOW;
}

/**
 * Decide whether a tool call may proceed.
 *
 * Gate order matters:
 *   1. standing denial      — an explicit "never this tool" wins over everything
 *   2. the matrix, blocked  — an explicit per-tool block wins over a grant
 *   3. standing approval    — "always this tool" overrides the mode
 *   4. the permission mode  — the user's chosen permission mode
 *   5. the matrix, allowed  — an explicit per-tool allow
 *
 * The caller decides what to do with `ask` (it may consult auto-review and
 * then the human).
 *
 * @param {object} opts
 * @param {object} opts.policy
 * @param {string} opts.tool
 * @param {object} [opts.args]
 * @param {string} [opts.scope]
 * @param {string} [opts.consent]  'allow' | 'deny' | undefined — the standing consent
 * @returns {{ decision: 'allow'|'ask'|'deny', reason: string, gate: string, level?: string }}
 */
function decide({ policy, tool, args = {}, scope, consent } = {}) {
  const p = policy ?? defaultPolicy();
  const name = String(tool || '');

  // 1. A standing denial is unconditional.
  if (consent === 'deny') {
    return { decision: DENY, reason: `${name} is blocked by a standing denial`, gate: 'standing-denial' };
  }

  // 2. An explicit per-tool block beats a standing approval: deny wins.
  const explicit = scope && p.scopes ? p.scopes[scope]?.tools?.[name] : undefined;
  const explicitLevel = explicit ?? p.matrix?.tools?.[name];
  if (explicitLevel === LEVEL_BLOCKED) {
    return { decision: DENY, reason: `${name} is blocked by the tool permission matrix`, gate: 'matrix', level: explicitLevel };
  }

  // 3. A standing approval overrides the mode — the user said "always".
  if (consent === 'allow') {
    return { decision: ALLOW, reason: 'allowed by a standing grant', gate: 'standing-grant' };
  }

  // 4. The permission mode.
  const class_ = classifyTool(name);
  if (name === 'shell') {
    // A shell command is judged by what it actually does: a read-only
    // command is fine in read-only mode, a mutating one is not. The
    // analyser is injected; a missing analyser must fail closed.
    const mutates = typeof p.shellMutates === 'function'
      ? p.shellMutates(String(args?.command || ''))
      : true;
    if (mutates) {
      if (p.mode === MODE_READ_ONLY) {
        return {
          decision: DENY,
          reason: 'read-only mode cannot run a mutating shell command',
          gate: 'mode',
        };
      }
      if (p.enableFileMutation === false) {
        return {
          decision: DENY,
          reason: 'file mutation is gated off for this turn (shell)',
          gate: 'mode',
        };
      }
    }
  }
  if (class_ === 'drive') {
    if (p.mode !== MODE_COMPUTER) {
      return {
        decision: DENY,
        reason: `permission mode "${p.mode}" cannot drive ${name}`,
        gate: 'mode',
      };
    }
    if (name.startsWith('computer_') && p.enableComputer === false) {
      return { decision: DENY, reason: `computer tools are gated off for this turn (${name})`, gate: 'mode' };
    }
    if (name.startsWith('browser_') && p.enableBrowser === false) {
      return { decision: DENY, reason: `browser tools are gated off for this turn (${name})`, gate: 'mode' };
    }
  }
  if (class_ === 'screen') {
    if (p.mode !== MODE_COMPUTER) {
      return {
        decision: DENY,
        reason: `permission mode "${p.mode}" cannot look at the screen (${name})`,
        gate: 'mode',
      };
    }
    if (name.startsWith('computer_') && p.enableComputer === false) {
      return { decision: DENY, reason: `computer tools are gated off for this turn (${name})`, gate: 'mode' };
    }
    if (name.startsWith('browser_') && p.enableBrowser === false) {
      return { decision: DENY, reason: `browser tools are gated off for this turn (${name})`, gate: 'mode' };
    }
  }
  if (class_ === 'write') {
    // `shell` is handled by its own gate above: it can distinguish a mutating
    // command from a read-only one, and the model needs that distinction.
    if (p.mode === MODE_READ_ONLY && name !== 'shell') {
      return { decision: DENY, reason: `read-only mode cannot ${name}`, gate: 'mode' };
    }
    if ((name === 'write_file' || name === 'edit_file') && p.enableFileMutation === false) {
      return { decision: DENY, reason: `file mutation is gated off for this turn (${name})`, gate: 'mode' };
    }
  }
  if (class_ === 'outbound' && p.mode === MODE_READ_ONLY) {
    return { decision: DENY, reason: `read-only mode cannot ${name}`, gate: 'mode' };
  }

  // 5. The per-tool matrix.
  let level = levelForTool(p, name, scope);
  if (name === 'shell' && level === LEVEL_BLOCKED) {
    // A read-only command is fine even in read-only mode — the matrix blocks
    // *mutating* shells, not every shell.
    const mutates = typeof p.shellMutates === 'function'
      ? p.shellMutates(String(args?.command || ''))
      : true;
    if (!mutates) level = LEVEL_ALWAYS_ALLOW;
  }
  if (level === LEVEL_BLOCKED) {
    return { decision: DENY, reason: `${name} is blocked by the tool permission matrix`, gate: 'matrix', level };
  }

  // 6. Delegation limits.
  if ((name === 'task' || name === 'team' || name === 'wide_research') && p.fanOut === false && p.depth >= 2) {
    return {
      decision: DENY,
      reason: 'delegation depth limit reached (a child this deep cannot spawn more agents)',
      gate: 'depth',
    };
  }
  if (Array.isArray(p.allowlist) && !p.allowlist.includes(name) && name !== 'update_plan') {
    return { decision: DENY, reason: `${name} is not in this turn's tool allowlist`, gate: 'allowlist' };
  }

  if (level === LEVEL_ALWAYS_ALLOW) {
    return { decision: ALLOW, reason: `${name} is always allowed`, gate: 'matrix', level };
  }
  return { decision: ASK, reason: `${name} needs approval`, gate: 'matrix', level };
}

/**
 * The tools a policy offers to the model.
 *
 * A tool that the policy would refuse outright is not offered at all — the
 * model should never see a tool it cannot use.
 */
function toolsForPolicy(allTools, policy) {
  const p = policy ?? defaultPolicy();
  const list = Array.isArray(allTools) ? allTools : [];
  const allowed = [];
  for (const tool of list) {
    const name = tool?.function?.name;
    if (!name) continue;
    if (name === 'update_plan') { allowed.push(tool); continue; }
    if (Array.isArray(p.allowlist) && !p.allowlist.includes(name)) continue;
    const class_ = classifyTool(name);
    if ((class_ === 'drive' || class_ === 'screen') && p.mode !== MODE_COMPUTER) continue;
    if (class_ === 'write' && p.mode === MODE_READ_ONLY) {
      // A write the user always allows stays available even in read-only.
      if (levelForTool(p, name) !== LEVEL_ALWAYS_ALLOW) continue;
    }
    if (class_ === 'outbound' && p.mode === MODE_READ_ONLY) {
      if (levelForTool(p, name) !== LEVEL_ALWAYS_ALLOW) continue;
    }
    allowed.push(tool);
  }
  return allowed;
}

module.exports = {
  MODE_READ_ONLY, MODE_WORKSPACE, MODE_COMPUTER, MODES,
  LEVEL_ALWAYS_ALLOW, LEVEL_NEEDS_APPROVAL, LEVEL_BLOCKED, LEVELS,
  ALLOW, ASK, DENY,
  READ_TOOLS, WRITE_TOOLS, DRIVE_TOOLS,
  classifyTool,
  defaultMatrixForMode, defaultPolicy, decide, levelForTool, normalizeLevel,
  normalizeMatrix, normalizeMode, toolsForPolicy,
};
