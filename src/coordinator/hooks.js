'use strict';
/**
 * Hooks — extension points in the agent's own lifecycle.
 *
 * The reference implementation defines twenty-one hook points, and they are
 * the thing that turns a fixed agent into a programmable one:
 *
 *   beforeSubmitPrompt · afterAgentResponse · afterAgentThought
 *   preToolUse · postToolUse · postToolUseFailure
 *   beforeShellExecution · afterShellExecution
 *   beforeMCPExecution · afterMCPExecution
 *   beforeReadFile · afterFileEdit · beforeTabFileRead · afterTabFileEdit
 *   preCompact · subagentStart · subagentStop · stop
 *   sessionStart · sessionEnd · workspaceOpen
 *
 * A hook can:
 *
 *   - return `permission: 'allow' | 'deny' | 'ask'` — a veto, a pass, or a
 *     request for the human;
 *   - add `additional_context` — text injected into the model's next turn;
 *   - return `updated_input` — rewrite the input the agent is about to act on;
 *   - return `agent_message` — say something to the user;
 *   - return `user_message` — a message injected as if the user had said it;
 *   - return `followup_message` — a message the agent will act on next;
 *   - return `continue: false` — stop the run.
 *
 * A hook that throws is *disabled for the rest of the run* and reported: a
 * broken extension must not take the agent down, and it must not be
 * silently ignored either.
 *
 * Pure module — no Electron, no network.
 */

/** Every hook point. */
const HOOK = {
  BEFORE_SUBMIT_PROMPT: 'beforeSubmitPrompt',
  AFTER_AGENT_RESPONSE: 'afterAgentResponse',
  AFTER_AGENT_THOUGHT: 'afterAgentThought',
  PRE_TOOL_USE: 'preToolUse',
  POST_TOOL_USE: 'postToolUse',
  POST_TOOL_USE_FAILURE: 'postToolUseFailure',
  BEFORE_SHELL_EXECUTION: 'beforeShellExecution',
  AFTER_SHELL_EXECUTION: 'afterShellExecution',
  BEFORE_MCP_EXECUTION: 'beforeMCPExecution',
  AFTER_MCP_EXECUTION: 'afterMCPExecution',
  BEFORE_READ_FILE: 'beforeReadFile',
  AFTER_FILE_EDIT: 'afterFileEdit',
  BEFORE_TAB_FILE_READ: 'beforeTabFileRead',
  AFTER_TAB_FILE_EDIT: 'afterTabFileEdit',
  PRE_COMPACT: 'preCompact',
  SUBAGENT_START: 'subagentStart',
  SUBAGENT_STOP: 'subagentStop',
  STOP: 'stop',
  SESSION_START: 'sessionStart',
  SESSION_END: 'sessionEnd',
  WORKSPACE_OPEN: 'workspaceOpen',
};

const HOOK_NAMES = Object.values(HOOK);

/** The registered hooks: name -> [{ handler, source, id }] */
const registry = new Map();
/** Hooks that threw, so they are not called again in this run. */
const disabled = new Set();
let nextId = 1;

/**
 * Register a hook.
 * @param {string} name  one of HOOK_NAMES
 * @param {Function} handler  async (payload) => result
 * @param {object} [opts]
 * @param {string} [opts.source]  where the hook came from (a plugin, a skill)
 * @returns {{ id: string, name: string, source: string }}
 */
function register(name, handler, { source = 'inline' } = {}) {
  if (!HOOK_NAMES.includes(name)) {
    throw new Error(`unknown hook point: ${name} (known: ${HOOK_NAMES.join(', ')})`);
  }
  if (typeof handler !== 'function') throw new Error('a hook needs a function');
  const entry = { id: `hk-${nextId++}`, name, handler, source };
  const list = registry.get(name) ?? [];
  list.push(entry);
  registry.set(name, list);
  return entry;
}

/** Remove a hook by id. */
function unregister(id) {
  let removed = false;
  for (const [name, list] of registry) {
    const next = list.filter((h) => h.id !== id);
    if (next.length !== list.length) { removed = true; registry.set(name, next); }
  }
  return removed;
}

/** Remove every hook from one source. */
function unregisterSource(source) {
  let removed = 0;
  for (const [name, list] of registry) {
    const next = list.filter((h) => h.source !== source);
    removed += list.length - next.length;
    registry.set(name, next);
  }
  return removed;
}

function clear() {
  registry.clear();
  disabled.clear();
}

/** What is registered. */
function describe() {
  const out = {};
  for (const name of HOOK_NAMES) {
    const list = registry.get(name) ?? [];
    if (list.length) out[name] = list.map((h) => ({ id: h.id, source: h.source }));
  }
  return out;
}

/**
 * Run a hook point.
 *
 * The results are merged: a `deny` from any hook wins over an `allow`;
 * `additional_context` accumulates; `updated_input` is applied in order.
 *
 * @param {string} name
 * @param {object} payload
 * @returns {Promise<{ permission: 'allow'|'deny'|'ask'|null, additional_context: string, agent_message: string, user_message: string, followup_message: string, updated_input: any, continue: boolean, errors: Array<{ id, source, error }> }>}
 */
async function run(name, payload = {}) {
  const result = {
    permission: null,
    additional_context: '',
    agent_message: '',
    user_message: '',
    followup_message: '',
    updated_input: undefined,
    continue: true,
    errors: [],
  };
  const list = registry.get(name) ?? [];
  for (const entry of list) {
    if (disabled.has(entry.id)) continue;
    let out;
    try {
      out = await entry.handler(payload);
    } catch (error) {
      // A broken hook is disabled for the rest of the run and reported. It
      // must not take the agent down, and it must not be silent either.
      disabled.add(entry.id);
      result.errors.push({ id: entry.id, source: entry.source, error: String(error?.message ?? error).slice(0, 500) });
      continue;
    }
    if (!out || typeof out !== 'object') continue;
    if (out.permission === 'deny') result.permission = 'deny';
    else if (out.permission === 'allow' && result.permission !== 'deny') result.permission = 'allow';
    else if (out.permission === 'ask' && result.permission === null) result.permission = 'ask';
    if (out.additional_context) {
      result.additional_context += `${result.additional_context ? '\n' : ''}${String(out.additional_context)}`;
    }
    if (out.agent_message) result.agent_message += String(out.agent_message);
    if (out.user_message) result.user_message += String(out.user_message);
    if (out.followup_message) result.followup_message += String(out.followup_message);
    if (out.updated_input !== undefined) {
      result.updated_input = result.updated_input === undefined
        ? out.updated_input
        : { ...(typeof result.updated_input === 'object' ? result.updated_input : {}), ...out.updated_input };
    }
    if (out.continue === false) result.continue = false;
  }
  return result;
}

/** Are any hooks registered at all? A fast path for the hot path. */
function has(name) {
  return (registry.get(name) ?? []).length > 0;
}

module.exports = {
  HOOK,
  HOOK_NAMES,
  clear,
  describe,
  has,
  register,
  run,
  unregister,
  unregisterSource,
};
