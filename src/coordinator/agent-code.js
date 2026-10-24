'use strict';
/**
 * Agent code sandbox — Quansiox's port of Manus's `computer-use/js` /
 * `in-app-browser-js` QuickJS runner pattern (from the reverse-engineered
 * addons/manus-computer-use/1.0.24/runtime/computer-use-js.mjs):
 *
 *  - The model writes JavaScript ("cells"), not primitive clicks; the cell
 *    gets `cu.*` computer bindings and `iab.*` in-app-browser bindings
 *  - a call budget per cell (Manus: 64 host calls) with friendly overflow
 *    guidance — the model continues in a new cell with `state` preserved
 *  - a deadline checked at every host-call boundary (the interrupt-handler
 *    pattern) plus a sync-execution timeout on the vm itself
 *  - `output.observation/image/write` collect structured results; images
 *    ride along on the next provider turn like computer_screenshot
 *  - `state` (a plain object) persists across cells for the session
 *
 * Honest scope note: node:vm is a reliability/budget sandbox, not a hard
 * security boundary (unlike Manus's WASM QuickJS). Quansiox's agent already
 * has shell access, so the sandbox exists to make composed loops robust,
 * interruptible, and cheap — not to contain hostile code.
 */
const vm = require('node:vm');

const CALL_BUDGET = 64; // host calls per cell (Manus constant)
const SYNC_TIMEOUT_MS = 10_000; // max synchronous execution inside the vm
const DEFAULT_DEADLINE_MS = 120_000;
const OUTPUT_TEXT_CAP = 20_000;

/** sessionId -> persisted state object (Manus globalThis.state pattern). */
const cellStates = new Map();

class BudgetError extends Error {
  constructor(used, budget) {
    super(`CELL_BUDGET_EXCEEDED — ${used}/${budget} host calls used. Return now (your state is preserved) and continue in a new agent_js cell.`);
    this.name = 'BudgetError';
  }
}
class DeadlineError extends Error {
  constructor() {
    super('CELL_DEADLINE_EXCEEDED — the cell ran out of time. state is preserved; continue in a new agent_js cell.');
    this.name = 'DeadlineError';
  }
}

function makeSandboxedBindings({ computer, browser, sessionId, deadline, counter }) {
  const guard = () => {
    counter.used += 1;
    if (counter.used > CALL_BUDGET) throw new BudgetError(counter.used - 1, CALL_BUDGET);
    if (Date.now() > deadline) throw new DeadlineError();
  };

  const wrap = (fn, mapResult = (r) => r) => async (...args) => {
    guard();
    const result = await fn(...args);
    if (Date.now() > deadline) throw new DeadlineError();
    return mapResult(result);
  };

  // cu.* — computer bindings. Screenshots return meta only (frameHash,
  // screenChanged) — the image is attached via output.image.
  const cu = {
    screenshot: wrap(async () => {
      const r = await computer('screenshot', {});
      return {
        width: r.width, height: r.height, frameHash: r.frameHash,
        screenChanged: r.screenChanged, coordinateToken: r.coordinateToken,
        __imageDataUrl: r.data,
      };
    }),
    appState: wrap(() => computer('appState', {})),
    find: wrap((params) => computer('findElements', params ?? {})),
    click: wrap((params) => computer('click', params ?? {})),
    type: wrap((params) => computer('typeText', params ?? {})),
    key: wrap((params) => computer('pressKey', params ?? {})),
    setValue: wrap((params) => computer('setValue', params ?? {})),
    scroll: wrap((params) => computer('scroll', params ?? {})),
    openApp: wrap(async (params) => {
      const { classifyAppName } = require('./hostBrowser');
      const decision = classifyAppName(params?.name);
      if (decision?.kind === 'url') return browser('open', { sessionId, url: decision.url });
      if (decision?.kind === 'browser-app') return decision.message;
      return computer('openApp', params ?? {});
    }),
    listApps: wrap(() => computer('listApps', {})),
  };

  // iab.* — in-app browser bindings (Manus in-app-browser-js `iab` surface).
  const browserCall = (method, args) => browser(method, { sessionId, ...args });
  const iab = {
    open: wrap((url) => browserCall('open', { url })),
    snapshot: wrap(async () => {
      const r = await browserCall('snapshot');
      return { snapshotId: r.snapshotId, text: r.text, refCount: r.refCount };
    }),
    click: wrap((args) => browserCall('act', { method: 'click', args })),
    type: wrap((args) => browserCall('act', { method: 'type', args })),
    fill: wrap((args) => browserCall('act', { method: 'fill', args })),
    select: wrap((args) => browserCall('act', { method: 'select', args })),
    pressKey: wrap((args) => browserCall('act', { method: 'press_key', args })),
    scroll: wrap((args) => browserCall('act', { method: 'scroll', args })),
    screenshot: wrap(async () => {
      const r = await browserCall('act', { method: 'screenshot' });
      return { width: r.width, height: r.height, __imageDataUrl: r.data };
    }),
    js: wrap((code) => browserCall('act', { method: 'js', args: { code } })),
    wait: wrap((args) => browserCall('act', { method: 'wait', args })),
    console: wrap((args) => browserCall('act', { method: 'console', args })),
    handleDialog: wrap((args) => browserCall('act', { method: 'handle_dialog', args })),
    tabs: wrap((args) => browserCall('tabs', args)),
  };

  return { cu, iab };
}

/**
 * Run one agent-authored JS cell.
 * @returns {Promise<{ text: string, images: string[], budgetUsed: number,
 *                     stateKeys: string[] }>}
 */
async function runCell({ sessionId, code, timeoutMs, computer, browser }) {
  const deadline = Date.now() + Math.min(300_000, Math.max(5_000, Number(timeoutMs) || DEFAULT_DEADLINE_MS));
  const counter = { used: 0 };
  if (!cellStates.has(sessionId)) cellStates.set(sessionId, {});
  const state = cellStates.get(sessionId);
  const outputs = [];
  const images = [];

  const output = {
    observation: (text) => outputs.push({ type: 'observation', text: String(text).slice(0, 2_000) }),
    write: (text) => outputs.push({ type: 'write', text: String(text).slice(0, OUTPUT_TEXT_CAP) }),
    image: (imageOrDataUrl) => {
      const url = typeof imageOrDataUrl === 'string'
        ? imageOrDataUrl
        : imageOrDataUrl?.__imageDataUrl ?? imageOrDataUrl?.data;
      if (url && /^data:image\//.test(url)) images.push(url);
    },
  };

  const { cu, iab } = makeSandboxedBindings({ computer, browser, sessionId, deadline, counter });

  const context = vm.createContext({
    cu, iab, output, state,
    console: {
      log: (...a) => outputs.push({ type: 'log', text: a.map(String).join(' ').slice(0, 500) }),
      error: (...a) => outputs.push({ type: 'error', text: a.map(String).join(' ').slice(0, 500) }),
      warn: (...a) => outputs.push({ type: 'log', text: a.map(String).join(' ').slice(0, 500) }),
    },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(5_000, Math.max(0, Number(ms) || 0))),
    clearTimeout,
    Date, Math, JSON,
  }, { name: `qx-agent-cell-${sessionId}` });

  const wrapped = `(async () => {\n${code}\n})()`;
  let value;
  try {
    const promise = vm.runInContext(wrapped, context, {
      timeout: SYNC_TIMEOUT_MS,
      displayErrors: true,
      breakOnSigint: true,
    });
    value = await Promise.race([
      promise,
      new Promise((_r, rej) => {
        const t = setTimeout(() => rej(new DeadlineError()), deadline - Date.now());
        t.unref?.();
      }),
    ]);
  } catch (error) {
    const text = [
      ...outputs.map((o) => `[${o.type}] ${o.text}`),
      `CELL_ERROR ${error?.name ?? ''}: ${String(error?.message ?? error)}`,
      error?.stack ? String(error.stack).split('\n').slice(0, 4).join('\n') : '',
    ].filter(Boolean).join('\n');
    return {
      text: text.slice(0, OUTPUT_TEXT_CAP),
      images,
      budgetUsed: counter.used,
      stateKeys: Object.keys(state),
      error: true,
    };
  }

  const returned = value === undefined ? '' : (() => {
    try { return typeof value === 'string' ? value : JSON.stringify(value); }
    catch { return String(value); }
  })();

  const text = [
    ...outputs.map((o) => `[${o.type}] ${o.text}`),
    returned ? `[return] ${returned.slice(0, OUTPUT_TEXT_CAP)}` : '',
    `[cell] ${counter.used}/${CALL_BUDGET} calls used; state keys: ${Object.keys(state).join(', ') || '(none)'}`,
  ].filter(Boolean).join('\n');

  return {
    text: text.slice(0, OUTPUT_TEXT_CAP),
    images,
    budgetUsed: counter.used,
    stateKeys: Object.keys(state),
  };
}

function resetState(sessionId) {
  cellStates.delete(sessionId);
}

module.exports = { runCell, resetState, CALL_BUDGET, cellStates };
