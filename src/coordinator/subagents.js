'use strict';
/**
 * Parent/child subagent scheduler.
 * A child is started with a self-contained prompt. It does not receive the
 * parent transcript. Built-in types: general, explore, shell, browser,
 * computer-use. Custom definitions carry name, description, prompt, tool
 * allowlist, and permission mode.
 */
const { guardTool } = require('./permissions');

const SUBAGENT_TYPES = ['general', 'explore', 'shell', 'browser', 'computer-use'];
const DEFAULT_CAP = 32;
// Nested delegation cap: parent(0) → child(1) → grandchild(2); no deeper.
const NEST_DEPTH_CAP = 2;

const BUILTIN = {
  general: {
    permissionMode: 'workspace',
    tools: ['shell', 'read_file', 'write_file', 'edit_file', 'list_dir', 'glob_files', 'update_plan', 'board_write', 'board_read', 'board_list', 'message_subagent', 'check_subagent', 'wake_parent'],
    prompt: 'General subagent. Use files and shell inside the workspace. Do not drive the GUI.',
  },
  explore: {
    permissionMode: 'read-only',
    tools: ['shell', 'read_file', 'list_dir', 'glob_files', 'search_code', 'board_read', 'board_list'],
    prompt: 'Explore subagent. Read and search only. Do not write files or change the system.',
  },
  shell: {
    permissionMode: 'workspace',
    tools: ['shell', 'read_file', 'write_file', 'edit_file', 'list_dir', 'glob_files', 'board_write', 'board_read', 'board_list'],
    prompt: 'Shell subagent. Run commands and edit workspace files. Do not drive the GUI.',
  },
  browser: {
    permissionMode: 'computer',
    tools: [
      'browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill',
      'browser_select', 'browser_press_key', 'browser_scroll', 'browser_screenshot', 'browser_fill_credentials',
      'browser_js', 'browser_wait', 'browser_handle_dialog', 'browser_tabs', 'browser_console',
      'read_file', 'board_write', 'board_read', 'board_list',
    ],
    prompt: 'Browser subagent. Drive the in-app browser. Do not mutate workspace files.',
  },
  'computer-use': {
    permissionMode: 'computer',
    tools: [
      'computer_screenshot', 'computer_ax_tree', 'computer_find', 'computer_set_value',
      'computer_click', 'computer_type', 'computer_key', 'computer_scroll',
      'computer_open_app', 'computer_list_apps', 'read_file', 'list_dir', 'board_write', 'board_read', 'board_list',
    ],
    prompt: 'Computer-use subagent. Observe the desktop and act through computer tools. Respect freshness tokens.',
  },
};

function policyForSubagent(spec) {
  const custom = (spec.customAgents || []).find((agent) => agent && agent.name && agent.name === spec.name);
  if (custom) {
    const mode = custom.permissionMode === 'workspace' || custom.permissionMode === 'computer'
      ? custom.permissionMode
      : 'read-only';
    return {
      permissive: false,
      permissionMode: mode,
      allowlist: (() => {
        const base = Array.isArray(custom.tools) ? custom.tools.slice() : [];
        for (const t of ['board_read', 'board_list']) if (!base.includes(t)) base.push(t);
        if (mode !== 'read-only' && !base.includes('board_write')) base.push('board_write');
        return base;
      })(),
      prompt: String(custom.prompt || ''),
      description: String(custom.description || ''),
      name: String(custom.name),
      type: 'custom',
      enableFileMutation: mode !== 'read-only',
      enableComputer: mode === 'computer',
      enableBrowser: mode === 'computer',
      fanOut: false,
    };
  }
  const type = spec.type || 'general';
  const builtin = BUILTIN[type];
  if (!builtin) {
    const error = new Error(`unknown subagent type: ${type}`);
    error.code = 'UNKNOWN_SUBAGENT';
    throw error;
  }
  return {
    permissive: false,
    permissionMode: builtin.permissionMode,
    allowlist: builtin.tools.slice(),
    prompt: builtin.prompt,
    description: '',
    name: spec.name || type,
    type,
    enableFileMutation: builtin.permissionMode !== 'read-only',
    enableComputer: type === 'computer-use',
    enableBrowser: type === 'browser',
    fanOut: false,
  };
}

/**
 * Messages for a child run. Only the role prompt and the task text are
 * included. Parent turns are not a parameter and cannot be copied in.
 */
function assembleChildMessages(spec, policy) {
  const system = [
    'You are a Quansiox subagent running one self-contained task.',
    'You do not have the parent conversation. Use only the task in the user message.',
    policy?.prompt ? `Role: ${policy.prompt}` : '',
    policy?.permissionMode === 'read-only'
      ? 'You are read-only. Do not write files or run commands that change the system.'
      : '',
    policy?.permissionMode !== 'computer'
      ? 'You cannot drive the computer or the in-app browser.'
      : '',
  ].filter(Boolean).join('\n');
  const task = String(spec.prompt || spec.description || '').trim();
  // Grok selected_context: extra curated material the parent hands the child.
  const context = String(spec.selected_context || '').trim();
  const user = context ? `${task}\n\n--- context ---\n${context}` : task;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function prepareChildJob(spec) {
  const readonly = spec.readonly === true || spec.read_only === true;
  const policy = policyForSubagent(readonly ? { ...spec, type: 'explore' } : spec);
  let subagentModel = '';
  let settingsSnapshot = {};
  try {
    const svc = require('../main/services/settingsService').settingsService;
    settingsSnapshot = svc.load() ?? {};
    subagentModel = settingsSnapshot.subagentModel || '';
  } catch { /* default */ }
  // Per-role model routing: the route for this child's role may point at a
  // different provider entirely (a local model for explore, a frontier model
  // for coding). An explicit model always wins.
  const { resolve } = require('./modelRouter');
  const routed = resolve({
    settings: settingsSnapshot,
    requestedModel: spec.model,
    type: spec.type ?? spec.subagent_type,
    name: spec.name,
  });
  const messages = assembleChildMessages(
    { prompt: spec.prompt, description: spec.description, selected_context: spec.selected_context || spec.selectedContext },
    policy,
  );
  const continuation = spec.continuation_config || spec.continuationConfig || {};
  const depth = Math.max(0, Number(spec.depth) || 0);
  const job = {
    id: spec.id || null,
    type: readonly ? 'explore' : policy.type,
    name: policy.name,
    title: String(spec.description || spec.prompt || policy.name || policy.type),
    prompt: String(spec.prompt || ''),
    description: String(spec.description || ''),
    background: spec.background === true || spec.mode === 'background',
    parentToolCallId: spec.parentToolCallId || null,
    parentSessionId: spec.parentSessionId || null,
    team: spec.team || '',
    // DAG label for this child (not a custom-agent name).
    agentId: spec.agentId || null,
    // Upstream agent results, prepended to the child's task.
    dependencyContext: spec.dependencyContext || null,
    // Per-subagent model routing: an explicit spec wins, then the configured
    // cheaper subagent model, then the parent's main model.
    // The routed provider (model + baseUrl + apiKey) for this child's role.
    model: routed.model || subagentModel || null,
    baseUrl: routed.baseUrl || null,
    apiKey: routed.apiKey || null,
    apiStyle: routed.apiStyle || null,
    provider: routed.provider || null,
    modelRoute: { role: routed.role, source: routed.source },
    environment: spec.environment || 'shared',
    // Grok SubagentArgs: sampling parameters, curated context, continuation
    // budget + nudge, and a read-only guard — all optional, all local.
    modelParameters: spec.model_parameters || spec.modelParameters || null,
    selectedContext: String(spec.selected_context || spec.selectedContext || ''),
    maxLoops: continuation.max_loops != null || continuation.maxLoops != null
      ? Number(continuation.max_loops ?? continuation.maxLoops)
      : (spec.max_loops != null || spec.maxLoops != null ? Number(spec.max_loops ?? spec.maxLoops) : null),
    nudgeMessage: continuation.nudge_message || continuation.nudgeMessage || spec.nudge_message || spec.nudgeMessage || null,
    readonly,
    // Nested delegation: how deep this child sits, the root to abort on, and
    // the session it runs under (its own scheduler for any grandchildren).
    depth,
    abortRoot: spec.abortRoot || null,
    runSessionId: spec.runSessionId || null,
    messages,
    policy,
  };
  if (job.policy) job.policy.depth = depth; // guardTool/toolsForPolicy read this
  // Nested delegation: a child below the cap (and not read-only) is offered and
  // allowed to spawn task/team so it can decompose its own work.
  if (Array.isArray(job.policy?.allowlist) && depth < NEST_DEPTH_CAP && job.policy.permissionMode !== 'read-only') {
    for (const t of ['task', 'team']) if (!job.policy.allowlist.includes(t)) job.policy.allowlist.push(t);
  }
  return job;
}

/**
 * A parent turn that should become a team: one self-contained agent per
 * independent item. A single question stays with the parent.
 * @returns {{brief:string, agents:Array<{description:string,prompt:string,subagent_type:string}>}|null}
 */
function inferSubagentType(text) {
  const line = String(text || '').trim();
  const lower = line.toLowerCase();
  if (/^(research|browse|compare|investigate|look up)\b/.test(lower)
    || /\b(browser|website|web page|https?:|news)\b/.test(lower)) {
    return 'browser';
  }
  if (/\b(click|desktop|screenshot|this mac|gui|open the app)\b/.test(lower)) return 'computer-use';
  if (/\b(shell|terminal|npm|pnpm|yarn|compile|run the tests|run tests)\b/.test(lower)) return 'shell';
  if (/\b(read|find|search|explore|where is|list files|codebase|repo)\b/.test(lower)) return 'explore';
  return 'general';
}

function planTeam(message) {
  const text = String(message || '').trim();
  if (!text || text.length > 4000) return null;
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const bullets = lines
    .filter((line) => /^(?:\d+[.)]|[-*])\s+\S/.test(line))
    .map((line) => line.replace(/^(?:\d+[.)]|[-*])\s+/, '').trim())
    .filter((line) => line.length > 2);
  let parts = bullets.length >= 2 ? bullets : [];
  if (parts.length < 2) {
    const research = text.match(/\b(research|compare|investigate|browse|summarize)\b\s+(.+)/i);
    if (research) {
      const list = research[2]
        .split(/\s*,\s*|\s+\band\b\s+/i)
        .map((item) => item.replace(/[.?!].*$/, '').trim())
        .filter((item) => item.length > 1 && item.length < 80);
      if (list.length >= 2) {
        const verb = research[1];
        parts = list.map((item) => `${verb} ${item}`);
      }
    }
  }
  if (parts.length < 2 && /\b(sub-?agents?|delegate|team of|in parallel|parallel agents|multitask)\b/i.test(text)) {
    const clauses = text.split(/\s*;\s*|\n+/).map((item) => item.trim()).filter((item) => item.length > 8);
    if (clauses.length >= 2) parts = clauses;
  }
  if (parts.length < 2) return null;
  return {
    brief: (lines[0] || text).slice(0, 80),
    agents: parts.slice(0, 8).map((part) => ({
      description: part.slice(0, 80),
      prompt: `Do this and only this. Return a short factual result.\n\n${part}`,
      subagent_type: inferSubagentType(part),
    })),
  };
}

let seq = 0;

class SubagentScheduler {
  /**
   * @param {{ cap?: number, runChild: Function, onProgress?: Function }} opts
   * runChild(job, signal) resolves to { summary, aborted, errored, fileResults }.
   */
  constructor(opts) {
    this.cap = Number.isFinite(opts.cap) && opts.cap > 0 ? opts.cap : DEFAULT_CAP;
    this.runChild = opts.runChild;
    this.onProgress = opts.onProgress || null;
    this.onState = opts.onState || null;
    this.running = 0;
    this.queue = [];
    this.jobs = new Map();
  }

  start(job) {
    if (job.id && this.jobs.get(job.id) && !this.jobs.get(job.id)._settled) throw new Error('task is already active');
    const state = {
      ...job,
      id: job.id || `sub-${Date.now().toString(36)}-${++seq}`,
      // The session this child works under: its own id (so any grandchildren
      // scheduled for it get a distinct scheduler), unless a parent assigned one.
      runSessionId: job.runSessionId || `sub-${Date.now().toString(36)}-${++seq}`,
      status: 'queued',
      summary: '',
      aborted: false,
      errored: false,
      fileResults: [],
      controller: new AbortController(),
      _settled: false,
      createdAt: job.createdAt || Date.now(),
    };
    state.browserSessionId = state.id;
    state.toolSessionId = state.environment === 'isolated' ? state.id : state.parentSessionId || state.id;
    state.done = new Promise((resolve) => {
      state._resolveFn = resolve;
    });
    state._resolve = (value) => {
      if (state._settled) return;
      state._settled = true;
      state._resolveFn(value);
    };
    state.notify = (patch) => {
      if (patch.summary != null) state.summary = patch.summary;
      if (patch.status && !state.controller.signal.aborted) state.status = patch.status;
      if (!state._settled) this._notify(state);
    };
    this.jobs.set(state.id, state);
    this.queue.push(state);
    this._notify(state);
    this._pump();
    if (state.background) return { id: state.id, status: 'background', done: state.done };
    return state.done;
  }

  abort(id) {
    const job = this.jobs.get(id);
    if (!job || job._settled) return;
    job.aborted = true;
    job.controller.abort();
    if (job.status === 'queued') {
      this.queue = this.queue.filter((item) => item.id !== id);
      job.status = 'aborted';
      job.summary = job.summary || '';
      this._finish(job, { summary: job.summary, fileResults: job.fileResults, aborted: true, errored: false });
    } else {
      job.status = 'stopping';
      this._notify(job);
    }
  }

  /**
   * Queue a steering instruction for a running child.
   *
   * The message is delivered at the child's next step boundary (see
   * `drainSteering` in the coordinator), so the child can change course
   * without being restarted.
   *
   * @returns {{ delivered: boolean, reason?: string, id?: string }}
   */
  steer(id, message) {
    const job = this.jobs.get(String(id ?? ''));
    if (!job) return { delivered: false, reason: 'unknown task' };
    if (job._settled) return { delivered: false, reason: 'the task already finished', id: job.id };
    const text = String(message ?? '').trim();
    if (!text) return { delivered: false, reason: 'message is required', id: job.id };
    if (!Array.isArray(job.steering)) job.steering = [];
    job.steering.push({ message: text, at: Date.now() });
    this._notify(job);
    return { delivered: true, id: job.id };
  }

  /** The live state of a job (for `check_subagent`). */
  inspect(id) {
    const job = this.jobs.get(String(id ?? ''));
    if (!job) return null;
    return {
      id: job.id,
      type: job.type,
      title: job.title,
      status: job.status,
      summary: job.summary || '',
      steps: job.steps ?? 0,
      fileResults: job.fileResults ?? [],
      worktree: job.worktree ?? null,
      steeringPending: Array.isArray(job.steering) ? job.steering.length : 0,
      startedAt: job.createdAt ?? null,
    };
  }

  abortAll() {
    for (const id of [...this.jobs.keys()]) this.abort(id);
  }

  _pump() {
    while (this.running < this.cap && this.queue.length) {
      const job = this.queue.shift();
      if (!job || job._settled) continue;
      this.running += 1;
      job.status = 'running';
      this._notify(job);
      this._runJob(job);
    }
  }

  async _runJob(job) {
    let result;
    try {
      result = await this._awaitChild(job);
    } catch (error) {
      result = job.controller.signal.aborted
        ? { summary: '', fileResults: [], aborted: true, errored: false }
        : { summary: String(error?.message ?? error), fileResults: [], aborted: false, errored: true };
    } finally {
      this.running -= 1;
    }
    if (job.controller.signal.aborted) {
      result = {
        summary: result?.summary || '',
        fileResults: result?.fileResults || [],
        aborted: true,
        errored: false,
      };
    }
    job.summary = result.summary || '';
    job.fileResults = result.fileResults || [];
    job.aborted = !!result.aborted;
    job.errored = !!result.errored && !result.aborted;
    job.status = job.aborted ? 'aborted' : job.errored ? 'errored' : 'completed';
    this._finish(job, {
      summary: job.summary,
      fileResults: job.fileResults,
      aborted: job.aborted,
      errored: job.errored,
      userAborted: job.aborted,
      subagentErrored: job.errored,
    });
    this._pump();
  }

  _awaitChild(job) {
    // Keep the slot and task identity until the worker actually stops. Resolving
    // on the abort signal alone allowed resume to overlap an old mutating tool.
    if (job.controller.signal.aborted) return Promise.resolve({ summary: '', fileResults: [], aborted: true, errored: false });
    return Promise.resolve(this.runChild(job, job.controller.signal));
  }

  _finish(job, value) {
    this._notify(job);
    job._resolve({ ...value, id: job.id });
  }

  _notify(job) {
    if (this.onState) this.onState(job);
    if (!this.onProgress) return;
    this.onProgress({
      id: job.id,
      title: job.title || job.name || job.type,
      type: job.type,
      status: job.status,
      summary: job.summary || '',
      parentToolCallId: job.parentToolCallId || null,
      team: job.team || '',
      aborted: job.status === 'aborted',
      errored: job.status === 'errored',
      model: job.model,
      environment: job.environment,
      browserSessionId: job.browserSessionId,
      toolSessionId: job.toolSessionId,
      background: job.background,
    });
  }
}

module.exports = {
  SUBAGENT_TYPES,
  DEFAULT_CAP,
  NEST_DEPTH_CAP,
  BUILTIN,
  policyForSubagent,
  assembleChildMessages,
  prepareChildJob,
  planTeam,
  inferSubagentType,
  SubagentScheduler,
  guardTool,
};
