'use strict';
/**
 * Quansiox agent coordinator — the agent loop running in a forked child
 * process (Grok Bot's node-agent-coordinator pattern):
 *  - crash-isolated from Electron; a hung provider or tool can't freeze the UI
 *  - plain Node: no electron dependency (services use QUANSIOX_USER_DATA_DIR)
 *  - message protocol over the fork channel:
 *      -> { type: 'run',    reqId, sessionId, message, attachments }
 *      -> { type: 'abort',  sessionId }
 *      <- { type: 'event',  event, sessionId, args }   (relayed to windows)
 *      <- { type: 'result', reqId, result | error }
 *      <- { type: 'notify', ok, text }                 (main shows a Notification)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const providerEngine = require('./providers');
const { sessionService } = require('../main/services/sessionService');
const { settingsService } = require('../main/services/settingsService');
const { execService } = require('../main/services/execService');
const { mcpService } = require('../main/services/mcpService');
const { secretsService } = require('../main/services/secretsService');
const { attachmentService } = require('../main/services/attachmentService');
const { gitService } = require('../main/services/gitService');
const { guardTool, toolsForPolicy, policyFromJudgment } = require('./permissions');
const { prepareChildJob, planTeam, SubagentScheduler, DEFAULT_CAP, NEST_DEPTH_CAP } = require('./subagents');
const { AGENT_TOOLS, FLAT_TOOLS, executeAgentTool, executeFlatTool } = require('./agentTools');
const { ECOSYSTEM_TOOLS, executeEcosystemTool } = require('./ecosystemTools');
const { judgeTurn } = require('./jev');
const { readArtifact, replayArtifact } = require('./skill-recording');
const { agentRecorder } = require('./agentRecorder');
const { FreshnessGate } = require('./freshness');
const { taskStore } = require('./task-store');
const fileTools = require('./fileTools');
const { BackgroundShellManager } = require('./backgroundShell');

// Computer use runs in the Electron main process (desktopCapturer lives
// there); the coordinator calls back over the fork channel.
const computerPending = new Map(); // reqId -> {resolve, reject}
let computerReqId = 1;
let computerProxy = null;

// Interactive tool-approval: ask the main process (→ renderer) before running a
// gated tool; fail-closed (deny) on timeout. Only used when requireApproval is on.
const confirmPending = new Map();
let confirmReqId = 1;
// Mirrors confirmationService.GATED — tools gated behind the approval prompt.
const GATED_TOOLS = new Set([
  'shell', 'write_file', 'submit_secret', 'computer_click', 'computer_type',
  'computer_key', 'computer_scroll', 'computer_set_value', 'computer_open_app',
  'browser_fill', 'browser_click', 'browser_fill_credentials', 'browser_import_cookies', 'github_pr_create', 'slack_post_message', 'email_send', 'messages_send',
]);

/**
 * Ask the user to approve an action.
 *
 * The request is a STRUCTURED object (W1.8): the approval card needs the
 * action, the target, a redacted argument preview and an expiry — not just a
 * tool name. The legacy positional form is still accepted so older call
 * sites keep working.
 *
 * Fail-closed: no IPC channel, a crash in the main process, or a timeout all
 * resolve to "not approved".
 */
async function requestConfirm(sessionIdOrRequest, tool, args, cwd, timeoutMs = 120_000) {
  if (!process.send || !process.connected) return false; // no IPC → fail closed
  const structured = sessionIdOrRequest && typeof sessionIdOrRequest === 'object'
    ? sessionIdOrRequest
    : {
        id: `ask-${Date.now().toString(36)}`,
        tool: String(tool ?? 'action'),
        action: String(tool ?? 'action'),
        target: '',
        targetKind: 'unknown',
        description: '',
        argsPreview: args ?? {},
        cwd: cwd ?? null,
        sessionId: sessionIdOrRequest ?? null,
        expiresAtMs: Date.now() + timeoutMs,
      };
  const sessionId = structured.sessionId ?? sessionIdOrRequest ?? null;
  const id = `cfm-${confirmReqId++}`;
  const wait = Number(timeoutMs) || 120_000;
  const timer = setTimeout(() => { if (confirmPending.delete(id)) return; }, wait);
  return new Promise((resolve) => {
    confirmPending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
    process.send({
      type: 'confirmRequest',
      id,
      sessionId,
      // Legacy fields, so an older main process still understands the message.
      tool: structured.tool,
      args: structured.argsPreview,
      cwd: structured.cwd,
      timeoutMs: wait,
      // The structured request the approval card renders.
      request: structured,
    });
  });
}

function installIpcComputerProxy(computerImpl, browserImpl) {
  computerProxy = typeof computerImpl === 'function'
    ? computerImpl
    : (method, args, sessionId) => new Promise((resolve, reject) => {
        if (!process.send || !process.connected) { reject(new Error('computer use unavailable (no IPC channel)')); return; }
        const id = `cu-${computerReqId++}`;
        const timer = setTimeout(() => { computerPending.delete(id); reject(new Error('computer call timed out')); }, 30_000);
        computerPending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        process.send({ type: 'computerCall', id, method, args, sessionId });
      });
  browserProxy = typeof browserImpl === 'function'
    ? browserImpl
    : (method, args) => new Promise((resolve, reject) => {
        if (!process.send || !process.connected) { reject(new Error('browser unavailable (no IPC channel)')); return; }
        const id = `br-${computerReqId++}`;
        const timer = setTimeout(() => { browserPending.delete(id); reject(new Error('browser call timed out')); }, 60_000);
        browserPending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        process.send({ type: 'browserCall', id, method, args });
      });
}

// In-app agent browser (Manus WebContentsView pattern): browser_* tools run
// in the main process (Electron-only APIs) and are proxied over the fork
// channel exactly like computer calls.
const browserPending = new Map(); // reqId -> {resolve, reject}
let browserProxy = null;
const browser = (method, args) =>
  new Promise((resolve, reject) => {
    if (!browserProxy) return reject(new Error('browser unavailable (no IPC channel)'));
    const id = `br-${computerReqId++}`;
    const timer = setTimeout(() => {
      browserPending.delete(id);
      reject(new Error('browser call timed out'));
    }, 60_000);
    browserPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    process.send({ type: 'browserCall', id, method, args });
  });

// Sandbox computer: file/exec tools route through the session's sandbox
// in the main process (same fork-channel round trip pattern). The main
// process ensures the sandbox before each run and sends its info along.
const sessionSandboxes = new Map(); // sessionId -> { active, root }
function sandboxActive(sessionId) {
  return sessionSandboxes.get(sessionId)?.active === true;
}
function sandboxRootFor(sessionId) {
  return sessionSandboxes.get(sessionId)?.root ?? '(sandbox)';
}
const sandboxProxy = (sessionId, method, params) =>
  new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error('sandbox unavailable (no IPC channel)'));
      return;
    }
    const id = `sb-${computerReqId++}`;
    const timer = setTimeout(() => {
      computerPending.delete(id);
      reject(new Error('sandbox call timed out'));
    }, 60_000);
    computerPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    process.send({ type: 'sandboxCall', id, sessionId, method, params });
  });

function setComputerProxy(fn) {
  computerProxy = fn;
}
async function computer(method, args, sessionId) {
  if (!computerProxy) throw new Error('computer use unavailable in this process');
  return computerProxy(method, args, sessionId);
}

const COMPUTER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'computer_screenshot',
      description:
        'Screenshot and get it back as an image plus a coordinate_token. With no target this captures the whole screen. With a target (bundle_id / app_name / window_id) it captures THAT app window — even when the app is in the background. Always do this before clicking; pass the fresh coordinate_token to computer_click.',
      parameters: {
        type: 'object',
        properties: {
          bundle_id: { type: 'string', description: 'the target app bundle id (e.g. com.apple.finder)' },
          app_name: { type: 'string', description: 'the target app name (e.g. Finder)' },
          window_id: { type: 'number', description: 'a specific window id from computer_list_windows' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_ax_tree',
      description:
        'Read the accessibility tree of an app (roles, titles, actions) and get a snapshot_id referencing it. With no target it reads the frontmost app. With a target (bundle_id / app_name / pid / window_id) it reads THAT app — the app does not need to be in front, so the user keeps working.',
      parameters: {
        type: 'object',
        properties: {
          bundle_id: { type: 'string', description: 'the target app bundle id' },
          app_name: { type: 'string', description: 'the target app name' },
          pid: { type: 'number', description: 'the target process id' },
          window_id: { type: 'number', description: 'a specific window id from computer_list_windows' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_list_windows',
      description:
        'List the windows of every running app with their id, title, owning app and bundle id. Use it to pick a target for the background computer tools (computer_ax_tree / computer_screenshot / computer_click with a target).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_find',
      description: 'Find accessibility elements by role and/or name substring (e.g. role "button", name "Save"). Returns up to 50 matches. Requires a current snapshot — call computer_ax_tree first.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'AX role, e.g. button, textField, checkBox' },
          name: { type: 'string', description: 'title/name substring (case-insensitive)' },
          value: { type: 'string', description: 'current value substring' },
          snapshot_id: { type: 'string' },
          bundle_id: { type: 'string', description: 'the target app bundle id' },
          app_name: { type: 'string', description: 'the target app name' },
          window_id: { type: 'number', description: 'a specific window id from computer_list_windows' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_set_value',
      description:
        'Set the value of an accessibility element (field, checkbox) — no click or typing needed, and it works on a BACKGROUND app. Identify it by element_id + snapshot_id (preferred) or by role/name.',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string' }, name: { type: 'string' },
          value: { type: 'string' },
          snapshot_id: { type: 'string' },
          element_id: { type: 'string', description: 'an element id from computer_ax_tree' },
          bundle_id: { type: 'string', description: 'the target app bundle id' },
          app_name: { type: 'string', description: 'the target app name' },
        },
        required: ['value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_click',
      description:
        'Click. Either at screen coordinates (x, y, with a fresh coordinate_token), or on an accessibility element (element_id + snapshot_id) — the element form is BACKGROUND: the app does not need to be in front and the user keeps their mouse.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          coordinate_token: { type: 'string', description: 'from computer_screenshot' },
          element_id: { type: 'string', description: 'an element id from computer_ax_tree (background click)' },
          snapshot_id: { type: 'string', description: 'the snapshot id from computer_ax_tree' },
          bundle_id: { type: 'string', description: 'the target app bundle id' },
          app_name: { type: 'string', description: 'the target app name' },
          window_id: { type: 'number', description: 'a specific window id from computer_list_windows' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_type',
      description: 'Type text into the currently focused element.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_scroll',
      description: 'Scroll at global screen coordinates. Positive deltaY scrolls up. Requires a fresh computer_screenshot first so the screen position is current.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          deltaY: { type: 'number' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_key',
      description: 'Press a key (return, tab, escape, a letter/digit, arrow keys) with optional modifiers like ["command"].',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          modifiers: { type: 'array', items: { type: 'string' } },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_open_app',
      description: 'Activate a Mac application by name (e.g. Finder, Notes). Do not pass Safari, Chrome, or a URL — web pages load with browser_open in the Electron browser.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_list_apps',
      description: 'List currently visible applications.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

/* Browser toolset — Manus Studio's in-app browser surface
 * (dist/browser/contract/browserContract.js), local subset. */
const BROWSER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: 'Open a URL in this session\'s browser (the embedded Electron browser, or the bot\'s own Linux-VM Chromium when the bot has its own VM). Returns the final URL and page title. This is the only browser. Never launch Safari, Chrome, or `open` a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) URL or bare domain' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Capture an accessibility snapshot of the active browser tab: a role/name tree where every interactable node has [ref=eN] plus a snapshot_id. Use refs for click/type/fill/select. The snapshot_id goes stale after navigation or DOM changes — actions then fail with STALE_PAGE and you must snapshot again.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element in the browser by ref (preferred, from browser_snapshot) or by x/y coordinates.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'element ref from browser_snapshot (e.g. e12)' },
          x: { type: 'number' }, y: { type: 'number' },
          snapshot_id: { type: 'string', description: 'optional staleness guard from browser_snapshot' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into the browser. Optionally target a ref (it is focused first). Set submit:true to press Enter afterwards.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' }, text: { type: 'string' },
          submit: { type: 'boolean' }, snapshot_id: { type: 'string' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill',
      description: 'Set the value of a form field by ref in one shot (works for inputs/textareas; dispatches input+change so frameworks see it). Prefer over browser_type for forms.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' }, value: { type: 'string' }, snapshot_id: { type: 'string' },
        },
        required: ['ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill_credentials',
      description: 'Log into the current page using a saved credential from the local encrypted vault (matched by site, or pass credentialId). The password is never shown to you — only which fields were filled. Use after browser_open on a login page.',
      parameters: {
        type: 'object',
        properties: {
          credentialId: { type: 'string', description: 'Explicit vault credential id (optional; defaults to the credential matching this site).' },
          username: { type: 'string', description: 'Override the username/email to type (optional).' },
          submit: { type: 'boolean', description: 'Submit the form after filling (default false).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_select',
      description: 'Choose an option of a <select> element by ref (matches by value or label).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' }, value: { type: 'string' }, snapshot_id: { type: 'string' },
        },
        required: ['ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press_key',
      description: 'Press a key in the browser (enter, tab, escape, arrowdown, a-z, 0-9).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['shift', 'ctrl', 'alt', 'meta'] } },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the page (or an element by ref) up/down/left/right.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number', description: 'pixels (default 600)' },
          ref: { type: 'string' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Screenshot the active browser tab; the image comes back to you on the next turn.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_js',
      description: 'Evaluate JavaScript in the active tab (async allowed; the value is returned as text). Read-only by convention — respect the site.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: 'Wait until text appears on the page, a CSS selector matches, or a fixed number of ms.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' }, selector: { type: 'string' }, ms: { type: 'number' },
          timeoutMs: { type: 'number', description: 'default 10000' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_console',
      description: 'Read the last N console messages from the active tab (default 20).',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_handle_dialog',
      description: 'Accept or dismiss a pending alert/confirm/prompt (required before the page unblocks).',
      parameters: {
        type: 'object',
        properties: {
          accept: { type: 'boolean' }, text: { type: 'string', description: 'prompt reply text' },
        },
        required: ['accept'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_tabs',
      description: 'Manage browser tabs: list | new (url?) | activate (tabId) | close (tabId?).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'new', 'activate', 'close'] },
          tabId: { type: 'string' }, url: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_import_cookies',
      description: 'Import cookies from a locally installed Chromium browser (Chrome/Edge/Brave/Chromium) into this session, limited to origins the user has granted. Requires the Chrome-cookie-import setting; macOS may prompt for Keychain access. Cookie values are never returned.',
      parameters: {
        type: 'object',
        properties: {
          browser: { type: 'string', enum: ['chrome', 'edge', 'brave', 'chromium'] },
          domains: { type: 'array', items: { type: 'string' }, description: 'optional extra domains; still grant-filtered' },
        },
      },
    },
  },
];

/* Agent code sandbox — Manus computer-use/js pattern (see agent-code.js):
 * the model composes "cu" and "iab" binding calls in JS with a call budget,
 * deadline, and state preserved across cells. */
const AGENT_CODE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'agent_js',
      description: 'Run a JavaScript cell orchestrating computer and browser tools with loops/conditionals. Bindings: cu.screenshot/appState/find/click/type/key/setValue/scroll/openApp/listApps (computer control — needs allowComputerUse) and iab.open/snapshot/click/type/fill/select/pressKey/scroll/screenshot/js/wait/console/handleDialog/tabs (embedded browser). `state` is a plain object preserved across cells; `output.observation(text)`, `output.write(text)`, `output.image(dataUrl)` collect results. Budget: 64 host calls per cell — on CELL_BUDGET_EXCEEDED or CELL_DEADLINE_EXCEEDED just run another cell and continue from state. cu.screenshot()/iab.screenshot() return metadata — pass the result to output.image() to attach it for viewing.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript (top-level await allowed)' },
          timeoutMs: { type: 'number', description: 'cell deadline, default 120000' },
        },
        required: ['code'],
      },
    },
  },
];

/* Offscreen render tools — Manus utilityHost render_pdf/render_png pattern. */
const RENDER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'render_pdf',
      description: 'Render a local HTML file to a PDF (A4, backgrounds included) via a hidden offscreen window; waits for fonts to load. Returns the output path. Great for reports/invoices from HTML you generate.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'path to the .html file (workspace-relative or absolute)' },
          output: { type: 'string', description: 'optional output path (.pdf)' },
          landscape: { type: 'boolean' },
        },
        required: ['input'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'render_png',
      description: 'Render a local HTML file to a full-page PNG (CDP captureBeyondViewport, content-size auto-grow, 16384px cap). Returns the output path and dimensions.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
          output: { type: 'string' },
          scale: { type: 'number', description: 'device scale 0.5–2 (default 1)' },
        },
        required: ['input'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are Quansiox, a local-first desktop AI agent running inside an Electron app on the user's Mac.
You are the parent. You orchestrate. Independent parts of a task go to a team of subagents.
You still have tools for a single step: shell, files, MCP tools (mcp__), the Electron browser, and, when enabled, this Mac's GUI.
The browser is Electron's built-in browser, one WebContentsView per session, shown on that session's computer screen.
browser_open, browser_snapshot, browser_click, browser_type, browser_fill, browser_select, browser_press_key,
browser_scroll, browser_screenshot, browser_js, browser_wait, browser_console, browser_handle_dialog, and browser_tabs
are the only way to use the web.
You are the parent agent. Independent work is done by a team of subagents, not by you.
Delegation:
- If the user gives two or more independent items (a list, a comparison, "research A, B, and C", or separate jobs), call team once. One agent per item. Do not do those items yourself.
- team.brief is the name shown above the team. Each agent needs description (the row title), prompt (self-contained — the child does not see this conversation), and subagent_type.
- subagent_type is explore (read and search), shell (commands and files), browser (the Electron browser on this session's computer), computer-use (this Mac's GUI), or general.
- A single small question or a single file edit stays with you. Do not spawn a team for one step.
- After team returns, write the combined answer from the agents' results. Do not redo their work.
Rules:
- Work inside the user's workspace directory unless the task explicitly says otherwise.
- Prefer small steps; verify results (e.g. run the file, check exit codes) before declaring success.
- For any web page, call browser_open. Do not launch Safari, Chrome, Firefox, or Arc. Do not run \`open\` on a URL.
- Do not use computer_open_app for a browser. computer_open_app is for other Mac apps such as Finder or Notes.
- After browser actions that navigate, re-snapshot before acting again (snapshot_id goes stale).
- Use update_plan to show multi-step plans as a live checklist.
- After finishing, reply with a concise summary of what you did and where artifacts live.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a shell command in the workspace. Returns stdout/stderr and exit code. Non-interactive only. Do not open URLs or browsers; use browser_open.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The bash command to execute' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file (relative to workspace or absolute). Optionally read a line range with offset/limit (1-based line numbers).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', description: 'first line to read (1-based)' },
          limit: { type: 'integer', description: 'how many lines to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Surgically edit a file by replacing an exact snippet. Prefer this over write_file: it never touches the rest of the file. Provide old_string (copied exactly from the file, including indentation) and new_string. The snippet must be unique unless replace_all is true. Returns a unified diff of what changed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'the exact text to replace' },
          new_string: { type: 'string', description: 'the replacement text' },
          replace_all: { type: 'boolean', description: 'replace every occurrence instead of requiring uniqueness' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description:
        'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.{js,jsx}"). Faster and safer than shelling out to find. Skips node_modules/.git/build.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          limit: { type: 'integer', description: 'max results (default 200)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'await_shell',
      description:
        'Wait for a backgrounded shell to finish (or for a timeout), then read its output. Use after a shell call returned a shellId.',
      parameters: {
        type: 'object',
        properties: {
          shell_id: { type: 'string' },
          timeout_ms: { type: 'integer', description: 'how long to wait (max 600000)' },
        },
        required: ['shell_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_shell_output',
      description: 'Read the captured output of a backgrounded shell without waiting for it to finish.',
      parameters: {
        type: 'object',
        properties: {
          shell_id: { type: 'string' },
          limit: { type: 'integer', description: 'max characters to return (default 20000)' },
        },
        required: ['shell_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_shell_input',
      description: 'Write text to the stdin of a backgrounded shell (e.g. answer a prompt, send ctrl-c as \\u0003).',
      parameters: {
        type: 'object',
        properties: {
          shell_id: { type: 'string' },
          data: { type: 'string' },
        },
        required: ['shell_id', 'data'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a UTF-8 text file (relative to workspace or absolute). Parent dirs are created.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List entries of a directory (relative to workspace or absolute).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', default: '.' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description:
        'Show or update your task plan as a checklist the user sees live. Call this when starting a multi-step task and whenever a step status changes. Send the complete plan every time.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
              },
              required: ['title', 'status'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_document',
      description: 'Create or overwrite a document in the local library (markdown/text). Returns its id. Use for notes, reports, and deliverables the user can reopen later. Pass id to overwrite an existing document.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Document title' },
          content: { type: 'string', description: 'Full markdown/text content' },
          visibility: { type: 'string', enum: ['private', 'shared'], description: 'shared documents are listed as shareable library pages' },
          id: { type: 'string', description: 'Existing document id to overwrite' },
        },
        required: ['title', 'content'],
      },
    },
  },
  ...['list_documents', 'read_document', 'append_document'].map((name) => ({
    type: 'function',
    function: {
      name,
      description: name === 'list_documents'
        ? 'List documents in the local library (id, title, visibility, updated time).'
        : name === 'read_document'
          ? 'Read a library document by id, including its full content.'
          : 'Append markdown to an existing library document (creates it when the id is unknown).',
      parameters: { type: 'object', properties: name === 'list_documents' ? {} : { id: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' } }, required: name === 'list_documents' ? [] : name === 'append_document' ? ['id', 'content'] : ['id'] },
    },
  })),
];

const TASK_TOOLS = [
  ...[
    ['task_list', 'List persisted child tasks in this conversation, including background tasks.'],
    ['task_get', 'Read a child task result and its saved transcript.'],
    ['task_wait', 'Wait for a child task, then retrieve its persisted status and result.'],
    ['task_interrupt', 'Interrupt one child without stopping its siblings.'],
    ['task_artifact', 'Read a file created by a child task from its workspace.'],
  ].map(([name, description]) => ({ type: 'function', function: {
    name, description, parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'Child task id' },
      timeout_ms: { type: 'integer', description: 'Wait time, up to 60000 ms' },
      path: { type: 'string', description: 'File path from the child fileResults list' },
    }, required: name === 'task_list' ? [] : name === 'task_artifact' ? ['id', 'path'] : ['id'] },
  } })),
  {
    type: 'function',
    function: {
      name: 'task',
      description: 'Start one child subagent with its own prompt. The child does not see this conversation. Types: general, explore, shell, browser, computer-use. For two or more independent items, call team instead. Pass name to run a saved custom subagent.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short title shown in the subagent roster' },
          prompt: { type: 'string', description: 'Self-contained task for the child. Do not paste the parent transcript.' },
          subagent_type: { type: 'string', enum: ['general', 'explore', 'shell', 'browser', 'computer-use'] },
          name: { type: 'string', description: 'Custom subagent name, when not using a built-in type' },
          background: { type: 'boolean' },
          model: { type: 'string', description: 'Optional child model; defaults to the configured model' },
          environment: { type: 'string', enum: ['shared', 'isolated'], description: 'shared uses parent files; isolated uses a separate file sandbox. Browser tabs and storage are always separate.' },
          resume_agent_id: { type: 'string', description: 'Continue a persisted child in this conversation' },
          fork_agent_id: { type: 'string', description: 'Create a new child from a persisted child transcript' },
          readonly: { type: 'boolean', description: 'Force a read-only child (no file writes / mutating shell)' },
          selected_context: { type: 'string', description: 'Extra curated context handed only to this child' },
          model_parameters: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: {} }, required: ['name', 'value'] }, description: 'Provider sampling params, e.g. [{name:"temperature",value:0.2}]' },
          continuation_config: { type: 'object', properties: { max_loops: { type: 'integer' }, nudge_message: { type: 'string' } }, description: 'Per-child step budget + the message shown when the budget is spent' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slides_deck',
      description: 'Create or revise a presentation. Pass the slides (layout, title, bullets, speaker notes) and the tool stores the deck and can export it as .pptx, PDF, an interactive web deck or a speaker-notes document. Use it when the user asks for slides or a deck.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The deck title' },
          subtitle: { type: 'string', description: 'A one-line subtitle' },
          theme: { type: 'string', enum: ['minimalist', 'onyx', 'ginkgo', 'basalt', 'patina', 'emerald', 'amber', 'alabaster', 'cobalt', 'sand'], description: 'The theme to design the deck with.' },
          language: { type: 'string', description: 'The output language (BCP-47), e.g. "en" or "fr".' },
          deck_id: { type: 'string', description: 'The deck to revise. Omit to create a new deck.' },
          slides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                layout: { type: 'string', enum: ['title', 'section', 'bullets', 'two-column', 'chart', 'quote', 'closing'] },
                title: { type: 'string' },
                subtitle: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
                quote: { type: 'string' },
                attribution: { type: 'string' },
                notes: { type: 'string', description: 'The speaker notes for this slide. Every slide should have them.' },
              },
              required: ['layout'],
            },
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slides_export',
      description: 'Export a deck. format: pptx (editable in PowerPoint/Keynote/Slides), pdf, web (an interactive browser deck), notes (a speaker-notes document).',
      parameters: {
        type: 'object',
        properties: {
          deck_id: { type: 'string' },
          format: { type: 'string', enum: ['pptx', 'pdf', 'web', 'notes'] },
        },
        required: ['deck_id', 'format'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'design_edit',
      description: 'Edit an image: upscale it, remove its background, crop or rotate it, adjust a marked region (brightness, contrast, saturation, hue, tint, blur), replace the text inside a region, or composite a reference image. Mark the regions first with design_mark, then apply the edits in one batch.',
      parameters: {
        type: 'object',
        properties: {
          design_id: { type: 'string' },
          base_version_id: { type: 'string', description: 'Which version to start from. Omit for the latest.' },
          label: { type: 'string', description: 'A name for the new version, e.g. "Sage green hero".' },
          ops: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['upscale', 'remove-background', 'crop', 'rotate', 'adjust', 'region-adjust', 'edit-text', 'composite-reference'] },
                factor: { type: 'number', description: 'upscale: the factor (2 or 4).' },
                tolerance: { type: 'number', description: 'remove-background: how different a pixel may be (0-255).' },
                x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
                degrees: { type: 'number', description: 'rotate: 90, 180 or 270.' },
                region: { type: 'object', description: 'The region to change: {x, y, width, height}.' },
                brightness: { type: 'number', description: '-1 to 1' },
                contrast: { type: 'number', description: '-1 to 1' },
                saturation: { type: 'number', description: '0 to 2' },
                hue: { type: 'number', description: '-180 to 180 degrees' },
                tint: { type: 'string', description: 'A hex colour to tint towards, e.g. "#8fa98a".' },
                tintAmount: { type: 'number', description: '0 to 1' },
                blur: { type: 'number', description: '0 to 20' },
                text: { type: 'string', description: 'edit-text: the new text.' },
                colour: { type: 'string', description: 'edit-text: the text colour.' },
                fontSize: { type: 'number', description: 'edit-text: the font size in pixels.' },
                referenceId: { type: 'string', description: 'composite-reference: which reference image.' },
                opacity: { type: 'number', description: 'composite-reference: 0 to 1.' },
              },
              required: ['type'],
            },
          },
        },
        required: ['design_id', 'ops'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'design_mark',
      description: 'Mark a region of an image with an instruction ("change this to muted sage green"). Mark several regions to batch them into one edit.',
      parameters: {
        type: 'object',
        properties: {
          design_id: { type: 'string' },
          marks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
                instruction: { type: 'string' },
              },
              required: ['x', 'y', 'width', 'height'],
            },
          },
        },
        required: ['design_id', 'marks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_image',
      description: 'Read an image: extract the text in it (OCR, local and private), describe what is in it by the numbers (dominant colours, brightness, contrast), or compare two images. Use it when the user points at a picture.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The image to read.' },
          other_path: { type: 'string', description: 'A second image, to compare with the first.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_video',
      description: 'Build a video or an animated GIF from a set of images, or read a video: probe it, extract frames from it, or cut its audio out for transcription.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'The images to build the video from.' },
          output: { type: 'string', description: 'The output file path.' },
          format: { type: 'string', enum: ['mp4', 'gif'] },
          fps: { type: 'number' },
          action: { type: 'string', enum: ['build', 'probe', 'frames', 'audio'], description: 'What to do. "build" needs paths; the others need a path.' },
          path: { type: 'string', description: 'The video to read.' },
          count: { type: 'number', description: 'frames: how many frames to take (default 8).' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'speak',
      description: 'Speak text out loud with the system voice, choosing a tone, a pace and a style. It writes an audio file you can attach to something.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          tone: { type: 'string', enum: ['professional', 'friendly', 'casual', 'energetic', 'calm'] },
          pace: { type: 'string', enum: ['fast', 'moderate', 'slow'] },
          style: { type: 'string', enum: ['conversational', 'formal', 'educational', 'promotional'] },
          voice: { type: 'string', description: 'A system voice name, e.g. "Samantha".' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'website_build',
      description: 'Build or change a website: scaffold a new one, edit a file, run the SEO audit and apply its fixes, set who may see it, and publish it to a local static bundle with a preview URL.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'read', 'write', 'delete', 'seo-audit', 'apply-seo', 'access', 'analytics', 'publish', 'copy'] },
          site_id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          path: { type: 'string', description: 'read/write/delete: the file inside the site.' },
          content: { type: 'string', description: 'write: the new file content.' },
          seo: { type: 'object', description: 'apply-seo: {title, description, canonical, robots, sitemap}.' },
          access: { type: 'object', description: 'access: {mode: public|token|password|allowlist, allowlist: []}.' },
          domain: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_data',
      description: 'Analyze a local CSV / TSV / JSON dataset and produce a real analysis: a column profile, charts, customer segments and written insights. Output is a self-contained interactive dashboard (HTML), a Markdown report, or a CSV dataset. Use this when the user has data to analyze or wants a chart or a dashboard.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the dataset inside the workspace (CSV, TSV or JSON).' },
          data: { type: 'string', description: 'The dataset inline, if it is not a file on disk.' },
          title: { type: 'string', description: 'Title for the dashboard or report.' },
          subtitle: { type: 'string', description: 'One line under the title — usually the analysis question.' },
          question: { type: 'string', description: 'The analysis the user asked for, in their words. It is recorded with the result and shown to the user.' },
          chart_types: {
            type: 'array',
            maxItems: 5,
            items: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter', 'heatmap', 'radar', 'area', 'donut', 'stacked-bar'] },
            description: 'Which charts to build (up to 5 in one analysis).',
          },
          output: { type: 'string', enum: ['dashboard', 'report', 'dataset'], description: 'The output shape: an interactive dashboard (default), a written report, or a CSV dataset.' },
          segments: { type: 'integer', description: 'How many customer segments to derive from the numeric columns (0 disables segmentation).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wide_research',
      description: 'Research many items in parallel — one dedicated agent per item, each with an isolated context — then merge the results into a single table with the same fields for every item. Use this when the request names many things to look up ("find the price of these 20 products", "research these 50 companies"). For one item use task; for a small number of interdependent items use team.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'What to do for every item, e.g. "find the current retail price and the top customer rating".' },
          items: {
            type: 'array',
            minItems: 2,
            maxItems: 250,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable id for this item, so you can refine it later' },
                label: { type: 'string', description: 'Short row title for this item' },
                prompt: { type: 'string', description: 'The item itself — a URL, a name, a question. The child agent sees only this.' },
              },
              required: ['prompt'],
            },
          },
          fields: {
            type: 'array',
            maxItems: 24,
            items: { type: 'string' },
            description: 'The fields to extract for every item, e.g. ["price", "rating", "notes"]. Every item is asked for the same fields so the results line up.',
          },
          output: { type: 'string', enum: ['table', 'report', 'dataset', 'csv'], description: 'The shape of the result: a table (default), a written report, a CSV dataset, or raw CSV.' },
          concurrency: { type: 'integer', description: 'How many items to process at once (default 4, max 12).' },
          model: { type: 'string', description: 'Optional model override for the item agents.' },
          package: { type: 'boolean', description: 'Also write the result out as CSV + Markdown, and as a single ZIP.' },
          refine: {
            type: 'object',
            description: 'Re-run a subset of the items with a different instruction and merge the new values back in — "add a column" or "re-research items 20-30 with more detail".',
            properties: {
              items: { type: 'array', items: { type: 'string' }, description: 'The item ids to re-run.' },
              instruction: { type: 'string', description: 'The instruction for the re-run.' },
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'team',
      description: 'Create a team of subagents and run them together. Use this when the user has two or more independent items. One agent per item. You orchestrate; you do not do the items yourself. brief is the team name the user sees. Each agent prompt is self-contained.',
      parameters: {
        type: 'object',
        properties: {
          brief: { type: 'string', description: 'Team name shown above the rows, 80 characters or fewer' },
          agents: {
            type: 'array',
            minItems: 2,
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Optional stable id for this agent, so other agents can name it in depends_on. Defaults to agent-1, agent-2, …' },
                description: { type: 'string', description: 'Row title for this agent' },
                prompt: { type: 'string', description: 'Self-contained task. The child does not see the parent conversation.' },
                subagent_type: { type: 'string', enum: ['general', 'explore', 'shell', 'browser', 'computer-use'] },
                depends_on: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Which agents in this team must finish before this one starts. Refer to them by their id or by their description. The agent then receives their summaries as context. Use this to express real ordering, not just parallelism.',
                },
              },
              required: ['description', 'prompt', 'subagent_type'],
            },
          },
        },
        required: ['brief', 'agents'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'message_subagent',
      description:
        'Send a steering instruction to a running subagent. It is delivered at its next step boundary, so it can change course without being restarted. Use this when a child is going the wrong way.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'the subagent id (from task_list or the onSubagent rows)' },
          message: { type: 'string', description: 'what the subagent should do differently' },
        },
        required: ['id', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_subagent',
      description: 'Read the live state of a subagent (status, summary so far, files produced, pending steering).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wake_parent',
      description:
        'Ask the parent agent (or the user) a question while you are still running. Use it when the task is ambiguous and the answer changes what you should do — then wait for the answer with check_subagent. The parent is notified immediately.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          context: { type: 'string', description: 'optional context for the question' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'merge_worktrees',
      description:
        'Review the isolated git worktrees the subagents created: list the files each changed, show the combined diff, and (optionally) apply the changes to the main workspace.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'subagent ids (all finished worktrees by default)' },
          apply: { type: 'boolean', description: 'apply the changes to the main workspace (default false — preview only)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'discover_ai_tools',
      description:
        'Discover the MCP servers, skills and slash commands the user already has configured in other AI tools on this machine (Claude Code, Codex, Cursor, OpenCode). Returns what is available so it can be imported instead of re-typed. Nothing is imported without the user asking.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'optional filter: claude_code | codex | cursor | opencode' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'meeting_copilot',
      description:
        'Analyze a meeting transcript: a summary, the decisions that were made, the action items (with their owners) and the open questions. The transcript is stored locally and the analysis uses the model the user already configured — nothing is sent anywhere else. Use it after a voice session or dictation captured a conversation.',
      parameters: {
        type: 'object',
        properties: {
          meetingId: { type: 'string', description: 'the meeting to analyze — omit it to analyze the newest meeting' },
          title: { type: 'string', description: 'a title for a new meeting (only when there is no meeting yet)' },
          transcript: { type: 'string', description: 'a raw transcript to analyze directly, instead of a stored meeting' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_artifact',
      description:
        'Create an interactive artifact — a self-contained HTML document (a chart, a calculator, a small tool, a report) the user can open in its own window. It is sandboxed: no network access and no access to the app. Write the whole document in one go, including any CSS and JS it needs, and make it work offline. Use it when a static answer would be better as something the user can play with.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'a short title shown in the artifact list' },
          html: { type: 'string', description: 'the full HTML document (or the body markup — a shell is added for you)' },
          kind: { type: 'string', description: 'html | chart | form | report | game | diagram | code' },
        },
        required: ['title', 'html'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_artifact',
      description: 'Replace the content of an existing artifact and show the change to the user.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'the artifact id' },
          title: { type: 'string', description: 'optional new title' },
          html: { type: 'string', description: 'the new HTML' },
        },
        required: ['id', 'html'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_artifact',
      description: 'Open an artifact in its own window for the user.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'the artifact id' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'onepassword_list',
      description:
        'List the 1Password vaults and items the user already has (titles and metadata only — never the secrets). Use it when the task needs a credential the user stores in 1Password; reading the secret itself always needs the user\'s Touch ID approval.',
      parameters: {
        type: 'object',
        properties: {
          vault: { type: 'string', description: 'optional vault name' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'onepassword_read',
      description:
        'Read a secret from a 1Password item. The user must approve with Touch ID; if they decline the call returns a denial and nothing is read. The secret is handed to you in this conversation only.',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'the item id or title' },
          field: { type: 'string', description: 'optional field (password, username, url)' },
          vault: { type: 'string', description: 'optional vault name' },
        },
        required: ['item'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'speculate',
      description:
        'Run the same task with two or more different models in parallel isolated worktrees, then verify each result with a command (e.g. the test suite). Returns which candidates passed. Use it when a hard problem is worth spending a second opinion on.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'the task every candidate attempts' },
          models: {
            type: 'array',
            items: { type: 'string' },
            description: 'the candidate models (2 or 3)',
          },
          verify: { type: 'string', description: 'a shell command run in each candidate worktree; exit code 0 means the candidate passed' },
          subagent_type: { type: 'string', description: 'the subagent type for the candidates (default general)' },
        },
        required: ['task', 'models'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replay_skill',
      description: 'Replay a completed local skill recording as computer actions. Each click uses a fresh screenshot token.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'artifact id from a completed recording' } },
        required: ['id'],
      },
    },
  },
  // Secrets (Grok submitSecret / `{{secret:name}}` model): store sensitive
  // values encrypted, then reference them in other tools without exposing them.
  {
    type: 'function',
    function: {
      name: 'submit_secret',
      description: 'Store a sensitive value (API key, token, password) in the encrypted local vault. One field can hold {{secret:NAME.FIELD}}; with a single field you can write {{secret:NAME}}. Returns names/fields only — never the value.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Secret name, [A-Za-z0-9][A-Za-z0-9_-], e.g. github_token' },
          fields: { type: 'object', description: '{ field: value } to create or merge into the secret', additionalProperties: { type: 'string' } },
          note: { type: 'string', description: 'Optional human note about what this secret is for' },
        },
        required: ['name', 'fields'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_secrets',
      description: 'List stored secret names and their field names (never values), so you can reference them as {{secret:NAME.FIELD}} in shell/write_file/browser/type tools.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_user_input',
      description: 'Ask the user for structured input with a form card above the composer (text, password, number, select/choice fields). Blocks until the user submits or dismisses it; returns the submitted values as JSON. Use for missing details, choices, or confirmation, not for secrets (use request_secret).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short form title' },
          fields: {
            type: 'array',
            description: 'Fields to ask for (max 40)',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Value key' },
                label: { type: 'string', description: 'Human label' },
                type: { type: 'string', description: 'text | password | number | email | select' },
                required: { type: 'boolean' },
                placeholder: { type: 'string' },
                options: { type: 'array', items: { type: 'string' }, description: 'For select fields' },
              },
              required: ['name'],
            },
          },
          timeout_seconds: { type: 'number', description: 'How long to wait (10–900s, default 300)' },
        },
        required: ['title', 'fields'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_secret',
      description: 'Ask the user for a secret (API key, token, password) with a masked form card, then store it in the encrypted local vault. Accepts missing secret values from the user without ever echoing them; returns names/fields and the {{secret:NAME.FIELD}} reference to use.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Secret name, [A-Za-z0-9][A-Za-z0-9_-]' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Field names to collect, e.g. ["token"]' },
          label: { type: 'string', description: 'Human label shown on the card' },
          note: { type: 'string', description: 'Optional note stored with the secret' },
          timeout_seconds: { type: 'number' },
        },
        required: ['name', 'fields'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_knowledge',
      description: 'List or read the knowledge-base files of the project this task belongs to. Without a file_id it lists the files; with a file_id it returns that file\'s text. The file set is frozen when the task joined the project, so it never changes under you.',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The id of a knowledge-base file to read. Omit to list the files.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Store a durable fact, preference, or project detail in local long-term memory for future sessions. Provide concise text; optionally tags. Rewriting an existing fact refreshes it.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact to remember (concise)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags, e.g. ["preference","project-x"]' },
          subject: { type: 'string', description: 'Optional subject key. A new fact about the same subject replaces the old one instead of piling up contradictions.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_write',
      description: 'Publish a finding, decision, or artifact reference to the shared blackboard so sibling subagents (and the parent) can read it. Use short keys like "findings", "api-map", "decisions". mode=append keeps a history; mode=set replaces the value.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short stable key (max 120 chars)' },
          value: { description: 'JSON-serializable value (string, object, array, number, boolean)' },
          mode: { type: 'string', enum: ['set', 'append'], description: 'set replaces (default); append adds to a history list' },
          rev: { type: 'number', description: 'The revision you read. If it has changed since, the write is refused with a conflict instead of overwriting a sibling\'s work.' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_read',
      description: 'Read a value another agent (or you) published on the shared blackboard.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Key to read; omit to list keys' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_list',
      description: 'List the keys currently on the shared blackboard with author and a short preview, so you can see what siblings have already discovered.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search local long-term memory for facts relevant to a query (or with a tag), e.g. preferences or project details you stored earlier.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search memory for' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter' },
          limit: { type: 'integer', description: 'Max results (default 8)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_start',
      description: 'Begin recording the computer_* actions you take from now on, into a replayable skill. Call record_stop to finish and save (returns the id for replay_skill).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search the workspace for code/text by substring or regex. Returns file:line matches (faster and safer than shelling out to grep). Skips node_modules/.git/build.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'substring, or a regex if regex=true' },
          regex: { type: 'boolean', description: 'treat query as a JavaScript regex' },
          context: { type: 'integer', description: 'lines of context around each hit (0-5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_stop',
      description: 'Finish the active recording and save it as a replayable skill artifact.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_cancel',
      description: 'Abandon the active recording without saving.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_status',
      description: 'Report whether a recording is active for this session and how many steps it has captured.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List installed skills in the local catalog (id, name, enabled, description).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description: 'Load a skill from the local catalog by id and follow its instructions for the current task.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'skill id from list_skills / the system catalog' },
          input: { type: 'string', description: 'optional task-specific input for the skill' },
        },
        required: ['id'],
      },
    },
  },
  // GitHub (SCM) connector — real gh-CLI ops on the user's account.
  {
    type: 'function',
    function: {
      name: 'github_status',
      description: 'Report whether the GitHub CLI (gh) is installed and authenticated (and the account).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_list',
      description: 'List GitHub pull requests for a repo (owner/name; defaults to the workspace origin).',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name (optional; defaults to workspace origin)' },
          state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'] },
          limit: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_view',
      description: 'View a pull request (number, title, body, state, diff stats).',
      parameters: {
        type: 'object',
        properties: { repo: { type: 'string' }, number: { type: 'integer' } },
        required: ['number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_create',
      description: 'Open a pull request (title, body, base, head, draft). Real side-effect on GitHub.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' },
          base: { type: 'string', description: 'base branch (default main)' }, head: { type: 'string', description: 'head branch' }, draft: { type: 'boolean' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_repo',
      description: 'View repo info (name, description, default branch, privacy).',
      parameters: { type: 'object', properties: { repo: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_issue_list',
      description: 'List GitHub issues for a repo.',
      parameters: { type: 'object', properties: { repo: { type: 'string' }, state: { type: 'string' }, limit: { type: 'integer' } } },
    },
  },
  // Slack connector — real Web API calls (bot token from the vault).
  {
    type: 'function',
    function: {
      name: 'slack_status',
      description: 'Report whether the Slack bot token is configured (and the team/account).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slack_post_message',
      description: 'Post a message to a Slack channel. Real side-effect on your workspace. Requires the bot token secret.',
      parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slack_channels',
      description: 'List Slack channels (id + name).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slack_history',
      description: 'Read recent messages from a Slack channel.',
      parameters: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'integer' } }, required: ['channel'] },
    },
  },
  // Email connector — IMAP read + SMTP send (creds from the vault).
  {
    type: 'function',
    function: {
      name: 'email_status',
      description: 'Report whether email (SMTP/IMAP) is configured and signed in.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'email_send',
      description: 'Send an email over SMTP. Real side-effect. Requires configured SMTP settings + a password secret.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' }, from: { type: 'string' },
          subject: { type: 'string' }, text: { type: 'string' },
        },
        required: ['to', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'email_search',
      description: 'Search an IMAP mailbox and return recent messages (subject/from/date/snippet).',
      parameters: {
        type: 'object',
        properties: { criteria: { type: 'string', description: 'IMAP SEARCH criteria, e.g. ALL or FROM "x@y.com"' }, mailbox: { type: 'string' }, limit: { type: 'integer' } },
      },
    },
  },
  // macOS Messages (iMessage/SMS) — read-only chat.db access + allowlisted sends.
  {
    type: 'function',
    function: {
      name: 'messages_status',
      description: 'Report macOS Messages availability: Full Disk Access to chat.db, Contacts/Automation grants, whether the agent toggle is on, and the recipient allowlist.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'messages_chats',
      description: 'List recent iMessage/SMS chats (title, handle, service, last message time). Read-only; needs Full Disk Access.',
      parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'max chats (default 30)' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'messages_read',
      description: 'Read recent messages from one chat, by chatId (from messages_chats) or recipient handle/phone. Read-only.',
      parameters: {
        type: 'object',
        properties: { chatId: { type: 'string' }, identifier: { type: 'string', description: 'phone/email handle' }, limit: { type: 'integer' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'messages_search',
      description: 'Search message text across recent chats. Read-only; needs Full Disk Access.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'messages_send',
      description: 'Send an iMessage/SMS to an allowlisted recipient. Real side-effect on your Mac; requires Messages to be enabled and the recipient to be on the allowlist.',
      parameters: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] },
    },
  },
];

/** @type {Map<string, { aborted: boolean, controller: AbortController }>} */
const runs = new Map();
/** @type {Map<string, object>} */
const sessionPolicies = new Map();
/** Long-running shells promoted out of a tool call. */
const backgroundShells = new BackgroundShellManager();
// The abort tree and the scheduler registry live in their own module, so the
// agent-lifecycle tools can stop a child without importing this one.
const { abortTree, registerNested, registerScheduler, schedulerFor: schedulerForSession } = require('./abortTree');

function allTools() {
  return [
    ...TOOLS, ...TASK_TOOLS, ...COMPUTER_TOOLS, ...BROWSER_TOOLS,
    ...AGENT_CODE_TOOLS, ...RENDER_TOOLS, ...AGENT_TOOLS, ...FLAT_TOOLS,
    ...ECOSYSTEM_TOOLS, ...mcpService.toolSpecs(),
  ];
}

function schedulerFor(sessionId) {
  let sched = schedulerForSession(sessionId);
  if (!sched) {
    const cap = Number(settingsService.load().subagentCap) || DEFAULT_CAP;
    sched = new SubagentScheduler({
      cap,
      onProgress: (row) => emit(sessionId, 'onSubagent', row),
      onState: (job) => taskStore.persist(job),
      runChild: (job, signal) => runChildSession(job, signal),
    });
    registerScheduler(sessionId, sched);
  }
  return sched;
}

async function runChildSession(job, signal) {
  const settings = settingsService.load();
  // Privacy mode (P4.4): enforced HERE, before anything is prepared or sent
  // — no prompt, transcript, or tool output leaves for a provider while the
  // gate is closed. A configured local provider (ollama/lmstudio) keeps
  // working: it never leaves the machine.
  const privacyGate = require('../main/services/privacyService').privacyService.gateRun(settings, {
    hasLocalProvider: /^(http:\/\/(localhost|127\.0\.0\.1))/i.test(String(settings.baseUrl ?? '')),
  });
  if (!privacyGate.allowed) {
    return { summary: privacyGate.reason, fileResults: [], aborted: false, errored: true };
  }
  if (!settings.apiKey) {
    return { summary: 'no API key configured', fileResults: [], aborted: false, errored: true };
  }
  // Child messages were built by prepareChildJob. The parent transcript is not loaded.
  const messages = structuredClone(job.messages || []);
  job.messages = messages;
  // Upstream agent results (DAG dependencies) are prepended to the task.
  if (job.dependencyContext) {
    messages.splice(1, 0, { role: 'system', content: job.dependencyContext });
  }
  registerNested(job.abortRoot || job.parentSessionId, job.runSessionId);
  // Context for any grandchildren this child spawns: its own scheduler, its
  // depth, and the run root to abort on.
  const deleg = {
    sessionId: job.runSessionId,
    parentToolCallId: job.id,
    policy: job.policy,
    depth: job.depth || 0,
    abortRoot: job.abortRoot || job.parentSessionId || null,
    scheduler: schedulerFor(job.runSessionId),
    // The session this child reports to (for `wake_parent`).
    parentSessionId: job.parentSessionId || job.abortRoot || null,
  };
  const offered = allTools().filter((tool) => job.policy?.allowlist?.includes(tool.function.name));
  let cwd = settings.workspaceRoot || process.cwd();
  const toolSession = job.toolSessionId || job.parentSessionId || job.id;
  if (job.environment === 'isolated') {
    // Prefer a real git worktree on host runs: the child gets a private
    // checkout (own branch of HEAD) so parallel edits never collide, and the
    // work survives afterwards for the parent to review/merge.
    if (settings.worktreeIsolation === true && !sandboxActive(toolSession)) {
      try {
        const { gitService } = require('../main/services/gitService');
        if (await gitService.isRepo()) {
          const fs = require('node:fs');
          const pathMod = require('node:path');
          const repoRoot = settings.workspaceRoot || process.cwd();
          const dir = pathMod.join(repoRoot, '.git', 'qx-worktrees', String(job.id).replace(/[^A-Za-z0-9_-]/g, '_'));
          fs.mkdirSync(pathMod.dirname(dir), { recursive: true });
          await gitService.worktreeAdd(dir, { cwd: repoRoot });
          job.worktree = dir;
          cwd = dir;
          emit(job.parentSessionId, 'onSubagent', {
            id: job.id, type: job.type, status: 'running', title: job.title,
            summary: `isolated worktree ${dir}`, worktree: dir, parentToolCallId: job.parentToolCallId || null,
          });
        }
      } catch (error) {
        emit(job.parentSessionId, 'onSubagent', {
          id: job.id, type: job.type, status: 'running', title: job.title,
          summary: `worktree unavailable (${error.message}); falling back to sandbox`,
          parentToolCallId: job.parentToolCallId || null,
        });
      }
    }
    if (!job.worktree) {
      const descriptor = await sandboxProxy(toolSession, 'ensure', { forkedFrom: job.forkedFrom, parentSessionId: job.parentSessionId });
      sessionSandboxes.set(toolSession, descriptor);
      cwd = descriptor.root;
      require('node:fs').mkdirSync(cwd, { recursive: true });
    }
  }
  job.workspaceRoot = sandboxActive(toolSession) ? sandboxRootFor(toolSession) : cwd;
  const fileResults = [...(job.fileResults || [])];
  let summary = '';
  let steps = 0;
  // Grok continuation_config: per-child step budget + a nudge message that tells
  // the model how to continue when the budget is spent.
  const maxLoops = Math.max(1, Math.min(64, Number(job.maxLoops) || 12));
  // Grok model_parameters: sampling knobs (temperature / top_p / max_tokens …)
  // forwarded to the provider for this child only.
  const paramFields = childParamFields(job.modelParameters);
  let budgetExhausted = false;
  // Shared blackboard: give the child what its siblings already published, so
  // parallel agents build on each other instead of repeating the same work.
  const boardRoot = job.abortRoot || job.parentSessionId || job.runSessionId;
  try {
    const { getBoard } = require('./blackboard');
    const digest = getBoard(boardRoot).digest({ limit: 12 });
    if (digest) messages.splice(1, 0, { role: 'system', content: digest });
  } catch { /* board unavailable — run without it */ }
  while (steps < maxLoops && !signal.aborted) {
    steps += 1;
    const { message: assistantMessage } = await chatCompletionStream(
      { model: job.model || settings.model, messages, tools: offered, ...paramFields },
      job.apiKey || settings.apiKey,
      job.baseUrl || settings.baseUrl,
      (delta) => emit(job.parentSessionId, 'onSubagentDelta', { id: job.id, delta }),
      signal,
      { apiStyle: job.apiStyle || settings.apiStyle, provider: job.provider || settings.provider },
    );
    if (signal.aborted) break;
    messages.push(assistantMessage);
    job.notify?.({ status: 'running' });
    // Live steering: the parent (or the user, through the UI) can inject
    // instructions into a running child between its steps.
    drainSteering(job, messages);
    if (!assistantMessage.tool_calls?.length) {
      summary = assistantMessage.content || '';
      break;
    }
    for (const call of assistantMessage.tool_calls) {
      if (signal.aborted) break;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* empty args */ }
      job.notify?.({ status: 'running', summary: `${call.function.name}` });
      // Resource routing:
      //   browser_*  → the session's own browser (a child gets its own)
      //   computer_* → the session's OWN guest desktop, never the parent's.
      //                A delegated child that drove the parent's guest would
      //                fight the parent for the same mouse and screen.
      //   everything else → the shared tool session (files, shell, memory).
      const resourceSession = call.function.name.startsWith('browser_')
        ? (job.browserSessionId || job.id)
        : call.function.name.startsWith('computer_')
          ? (job.computerSessionId || job.id)
          : toolSession;
      const output = await executeTool(call.function.name, args, cwd, resourceSession, job.policy, job.id, signal, deleg, job.abortRoot || job.parentSessionId || job.runSessionId);
      if ((call.function.name === 'write_file' || call.function.name === 'edit_file') && typeof output === 'string' && output.startsWith('wrote ')) {
        if (!fileResults.includes(args.path)) fileResults.push(args.path);
      }
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: text.slice(0, 8000) });
      job.fileResults = fileResults;
      job.notify?.({ status: 'running' });
    }
    drainSteering(job, messages);
    if (steps >= maxLoops) budgetExhausted = true;
  }

  if (signal.aborted) {
    return { summary, fileResults, aborted: true, errored: false };
  }
  if (!summary && budgetExhausted) {
    summary = job.nudgeMessage || `reach its ${maxLoops}-step budget — resume with a follow-up to continue`;
  }
  // Publish this child's outcome so later/parallel siblings (and the parent's
  // synthetic history) can reuse it without re-running the same investigation.
  const finalSummary = job.worktree ? `${summary || 'finished'}\n\n[isolated worktree: ${job.worktree}]` : (summary || 'finished');
  try {
    const { getBoard } = require('./blackboard');
    getBoard(boardRoot).append('results', {
      id: job.id,
      type: job.type,
      title: job.title,
      ok: true,
      summary: String(summary || 'finished').slice(0, 2000),
      ...(job.worktree ? { worktree: job.worktree } : {}),
    }, job.name || job.type || 'subagent');
  } catch { /* board unavailable */ }
  return { summary: finalSummary, fileResults, aborted: false, errored: false, worktree: job.worktree || null };
}

/**
 * Move any steering messages queued for a child into its conversation.
 *
 * `message_subagent` (or the UI) can queue instructions for a running
 * child; they are delivered at the next step boundary so the child sees
 * them as a normal user turn and can act on them mid-run.
 */
function drainSteering(job, messages) {
  if (!Array.isArray(job.steering) || job.steering.length === 0) return;
  const queued = job.steering.splice(0, job.steering.length);
  for (const item of queued) {
    const text = String(item?.message ?? item ?? '').trim();
    if (!text) continue;
    messages.push({ role: 'user', content: `[steering from the parent agent]\n${text}` });
    job.notify?.({ status: 'running', summary: `steered: ${text.slice(0, 80)}` });
  }
}

/** Map Grok model_parameters (array of {name,value} | object) to provider fields. */
const PROVIDER_PARAM_KEYS = new Set(['temperature', 'top_p', 'max_tokens', 'frequency_penalty', 'presence_penalty', 'stop', 'seed', 'max_completion_tokens']);
function childParamFields(modelParameters) {
  const out = {};
  const list = Array.isArray(modelParameters)
    ? modelParameters
    : (modelParameters && typeof modelParameters === 'object' ? Object.entries(modelParameters).map(([name, value]) => ({ name, value })) : []);
  for (const entry of list) {
    const key = String(entry?.name ?? entry?.key ?? '');
    if (PROVIDER_PARAM_KEYS.has(key) && entry?.value !== undefined) out[key] = entry.value;
  }
  return out;
}
async function scoreChild(job, result) {
  if (!process.env.TYPESAFE_API_KEY || !result?.summary) return { ...result, lowScore: false, success: !result.aborted && !result.errored };
  const judged = await judgeTurn({
    userMessage: job.prompt,
    parentTask: job.description || job.title || job.prompt,
    subagentSummary: result.summary,
  });
  const lowScore = judged.lowScore === true;
  return {
    ...result,
    lowScore,
    success: !result.aborted && !result.errored && !lowScore,
  };
}

function clampChildType(type, parentPolicy) {
  const requested = type || 'general';
  if (!parentPolicy || parentPolicy.permissive || parentPolicy.route === 'subagent') return requested;
  if (requested === 'computer-use' && parentPolicy.enableComputer !== true) return null;
  if (requested === 'browser' && parentPolicy.enableBrowser !== true) return null;
  if ((requested === 'shell' || requested === 'general') && parentPolicy.enableFileMutation !== true) return 'explore';
  return requested;
}

async function dispatchTask(args, ctx) {
  if (args.resume_agent_id && args.fork_agent_id) throw new Error('choose resume or fork');
  const previousId = args.resume_agent_id || args.fork_agent_id;
  const previous = previousId ? taskStore.get(previousId, ctx.sessionId) : null;
  if (previous && args.resume_agent_id && taskStore.ACTIVE.has(previous.status)) throw new Error('task is already active');
  const customAgents = ctx.customAgents ?? settingsService.load().customSubagents ?? [];
  const requested = previous?.type || args.subagent_type || (args.name ? 'custom' : 'general');
  const clamped = args.name ? requested : clampChildType(requested, ctx.policy);
  if (!args.name && clamped == null) {
    return JSON.stringify({
      summary: 'refused: this turn cannot delegate that kind of agent',
      fileResults: [], aborted: false, errored: true, success: false,
    });
  }
  let job;
  try {
    job = previous ? {
      ...previous,
      id: args.resume_agent_id ? previous.id : null,
      forkedFrom: args.fork_agent_id ? previous.id : previous.forkedFrom,
      createdAt: args.resume_agent_id ? previous.createdAt : Date.now(),
      runAttempt: args.resume_agent_id ? (previous.runAttempt || 1) + 1 : 1,
      title: args.description || previous.title,
      model: args.model || args.model_id || previous.model,
      messages: taskStore.continuation(previous, args.prompt),
      background: args.background === true || args.run_in_background === true,
      environment: args.environment || previous.environment,
      parentToolCallId: ctx.parentToolCallId || null,
      error: null,
    } : prepareChildJob({
      type: args.name ? (args.subagent_type || args.type) : clamped,
      name: args.name,
      prompt: args.prompt,
      description: args.description,
      background: args.background === true || args.run_in_background === true || args.mode === 'background',
      model: args.model || args.model_id || settingsService.load().model,
      environment: args.environment || 'shared',
      readonly: args.readonly === true,
      selected_context: args.selected_context,
      model_parameters: args.model_parameters,
      continuation_config: args.continuation_config,
      parentToolCallId: ctx.parentToolCallId || null,
      parentSessionId: ctx.sessionId || null,
      team: args.team || ctx.team || '',
      customAgents,
      dependencyContext: ctx.dependencyContext || null,
      agentId: args.agent_id || null,
    });
  } catch (error) {
    return JSON.stringify({ summary: String(error.message), fileResults: [], aborted: false, errored: true, success: false });
  }
  if (!['shared', 'isolated'].includes(job.environment)) throw new Error('invalid child environment');
  if (previous && clamped !== requested) throw new Error('this turn cannot resume that child role');
  // Nested delegation depth: children call with deleg (ctx.depth = their depth);
  // a top-level task has ctx.depth 0 so the child sits at depth 1.
  const depth = Math.max(0, Number(ctx.depth) || 0) + 1;
  if (depth > NEST_DEPTH_CAP && !previous) {
    return JSON.stringify({ summary: `refused: delegation depth limit (${NEST_DEPTH_CAP}) reached`, fileResults: [], aborted: false, errored: true, success: false });
  }
  job.depth = previous ? (job.depth || depth) : depth;
  job.abortRoot = ctx.abortRoot || ctx.sessionId || null;
  if (job.policy) job.policy.depth = job.depth;
  const sched = ctx.scheduler || schedulerFor(ctx.sessionId);
  const emitRow = (row) => emit(ctx.sessionId, 'onSubagent', row);
  if (!ctx.scheduler) {
    /* schedulerFor already emits on the parent session */
  } else {
    const previous = sched.onProgress;
    sched.onProgress = (row) => {
      emitRow(row);
      if (previous) previous(row);
    };
  }
  if (job.background) {
    const handle = sched.start(job);
    handle.done.then(async (result) => {
      try {
        const scored = await scoreChild(job, result);
        emitRow({
          id: handle.id, title: job.title, type: job.type,
          status: scored.aborted ? 'aborted' : scored.lowScore ? 'low_score' : scored.errored ? 'errored' : 'completed',
          summary: scored.lowScore ? `low score — ${scored.summary}` : scored.summary,
          parentToolCallId: job.parentToolCallId,
          team: job.team || '',
          aborted: scored.aborted, errored: scored.errored,
        });
      } catch { /* background score is best-effort */ }
    }).catch(() => {});
    return JSON.stringify({
      id: handle.id, status: 'background', summary: '', fileResults: [], aborted: false, errored: false, success: null,
    });
  }
  const result = await sched.start(job);
  const scored = await scoreChild(job, result);
  if (scored.lowScore) {
    const row = {
      id: result.id,
      title: job.title,
      type: job.type,
      status: 'low_score',
      summary: `low score — ${scored.summary}`,
      parentToolCallId: job.parentToolCallId,
      team: job.team || '',
      aborted: false,
      errored: false,
    };
    if (typeof sched.onProgress === 'function') sched.onProgress(row);
    else emit(ctx.sessionId, 'onSubagent', row);
  }
  return JSON.stringify(scored);
}

async function taskControl(action, args, ctx) {
  if (action === 'start') return dispatchTask({ ...args, background: true }, ctx);
  if (action === 'resume' || action === 'fork') return dispatchTask({ ...args, background: true, [action === 'resume' ? 'resume_agent_id' : 'fork_agent_id']: args.id }, ctx);
  if (action === 'list') return taskStore.summaries(ctx.sessionId);
  const record = taskStore.get(args.id, ctx.sessionId);
  const active = schedulerFor(ctx.sessionId)?.jobs.get(args.id);
  if (action === 'get') return record;  if (action === 'interrupt') {
    if (active && !active._settled) schedulerFor(ctx.sessionId).abort(args.id);
    return taskStore.get(args.id, ctx.sessionId);
  }
  if (action === 'wait') {
    if (active && !active._settled) {
      const timeout = Math.min(60_000, Math.max(0, Number(args.timeout_ms ?? 20_000)));
      let timer;
      try { await Promise.race([active.done, new Promise((resolve) => { timer = setTimeout(resolve, timeout); })]); }
      finally { clearTimeout(timer); }
    }
    return taskStore.get(args.id, ctx.sessionId);
  }
  if (action === 'artifact') {
    if (!record) throw new Error(`unknown task: ${args.id}`);
    if (!record.fileResults?.includes(args.path)) throw new Error('file is not a recorded task artifact');
    const fs = require('node:fs'), path = require('node:path');
    const root = fs.realpathSync(record.workspaceRoot);
    const target = fs.realpathSync(path.resolve(root, args.path));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('artifact is outside the child workspace');
    if (fs.statSync(target).size > 200_000) throw new Error('artifact is too large to return as text');
    return fs.readFileSync(target, 'utf8');
  }
  throw new Error(`unknown task action: ${action}`);
}

async function dispatchTeam(args, ctx) {
  const brief = String(args?.brief || 'Team').slice(0, 80);
  const { planTeamDag, normalizeAgents, buildDependencyContext } = require('./teamDag');
  const agents = normalizeAgents(args?.agents);
  if (agents.length < 2) {
    return JSON.stringify({
      brief,
      agents: [],
      summary: 'A team needs at least two agents. Use task for a single child.',
      errored: true,
    });
  }

  // A dependency DAG: everything in a wave runs in parallel, and the next
  // wave starts once the previous one is done — with the upstream results
  // already in its context.
  const { waves, errors } = planTeamDag(agents);
  const results = [];
  for (const wave of waves) {
    const pending = wave.map((agent) => dispatchTask({
      description: agent.description,
      prompt: agent.prompt,
      subagent_type: agent.subagent_type,
      // `agent_id` labels the child for DAG bookkeeping. It is deliberately
      // NOT `name`: `name` means "a custom subagent" and would bypass the
      // per-type tool clamping (a browser child could be handed shell).
      agent_id: agent.id,
      team: brief,
    }, {
      ...ctx,
      dependencyContext: buildDependencyContext(results, agent),
    }).then((raw) => {
      try {
        const parsed = JSON.parse(raw);
        return { ...parsed, id: parsed.id ?? agent.id, agentId: agent.id, description: agent.description, type: agent.subagent_type };
      } catch {
        return { id: agent.id, agentId: agent.id, description: agent.description, type: agent.subagent_type, summary: String(raw), errored: true, success: false };
      }
    }));
    const settled = await Promise.all(pending);
    results.push(...settled);
  }

  return JSON.stringify({
    brief,
    agents: results.map((result) => ({
      id: result.id ?? null,
      agentId: result.agentId ?? null,
      title: result.description ?? '',
      type: result.type ?? 'general',
      summary: result.summary || '',
      success: result.success !== false && !result.errored && !result.aborted,
      errored: !!result.errored,
      aborted: !!result.aborted,
      worktree: result.worktree ?? null,
    })),
    ...(errors.length ? { warnings: errors } : {}),
  });
}

async function replaySkill(args) {
  if (process.send && process.connected) {
    const result = await new Promise((resolve, reject) => {
      const id = `sk-${computerReqId++}`;
      const timer = setTimeout(() => {
        browserPending.delete(id);
        reject(new Error('skill replay timed out'));
      }, 60_000);
      browserPending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      process.send({ type: 'skillReplay', id, artifactId: args.id });
    });
    return JSON.stringify(result.actions ?? result);
  }
  const artifact = readArtifact(args.id);
  const out = await replayArtifact(artifact, new FreshnessGate(), null);
  return JSON.stringify(out);
}

function emit(sessionId, event, ...args) {
  try {
    if (process.send && process.connected) {
      process.send({ type: 'event', event, sessionId, args });
    }
  } catch {
    /* channel closed — parent is gone */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chatCompletionStream(body, apiKey, baseUrl, onEvent, signal, providerOpts = {}) {
  // Protocol is chosen per call: OpenAI chat/responses, Anthropic, Gemini or a
  // local OpenAI-compatible server (Ollama / LM Studio).
  const provider = providerEngine.detectProvider(baseUrl, body?.model, providerOpts);
  const request = providerEngine.buildRequest(provider, body, { apiKey });
  const url = request.url;
  const doFetch = (extra) =>
    fetch(url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(extra && Object.keys(extra).length ? { ...request.payload, ...extra } : request.payload),
      signal,
    });

  // Fetch with retry: transient failures (429 / 5xx / network) are retried
  // with capped exponential backoff, honoring Retry-After when present.
  const MAX_RETRIES = 3;
  const emitRetry = (info) => {
    try {
      onEvent({ type: 'retry', ...info });
    } catch {}
  };
  async function fetchWithRetry(extra) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (signal?.aborted) throw new Error('aborted');
      try {
        const res = await doFetch(extra);
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 30_000)
              : Math.min(500 * 2 ** attempt, 8000);
          res.body?.cancel?.().catch(() => {});
          if (attempt === MAX_RETRIES) {
            throw new Error(`provider ${res.status} after ${MAX_RETRIES + 1} attempts`);
          }
          emitRetry({ status: res.status, attempt: attempt + 1, delay });
          await sleep(delay);
          continue;
        }
        return res;
      } catch (error) {
        if (error.message?.startsWith('provider ')) throw error; // already final
        if (error.name === 'AbortError' || signal?.aborted) throw error;
        lastError = error;
        if (attempt === MAX_RETRIES) break;
        await sleep(Math.min(500 * 2 ** attempt, 8000));
      }
    }
    throw lastError ?? new Error('provider unreachable');
  }

  // `stream_options` is an OpenAI chat-completions extension — don't send it to
  // other providers (they reject unknown fields).
  const wantsUsageOption = provider.id === 'openai-chat' || provider.id === 'lmstudio' || provider.id === 'ollama';
  let res = await fetchWithRetry(wantsUsageOption ? { stream_options: { include_usage: true } } : {});
  if (res.status === 400) res = await fetchWithRetry({});
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`provider ${res.status}: ${text.slice(0, 400)}`);
  }

  const message = { role: 'assistant', content: '' };
  const toolCalls = new Map();
  let usage = null;

  const apply = (evt) => {
    if (!evt) return;
    if (evt.reasoning) onEvent({ type: 'reasoning', text: evt.reasoning });
    if (evt.deltaText) {
      message.content += evt.deltaText;
      onEvent({ type: 'delta', text: evt.deltaText });
    }
    for (const part of evt.toolCalls ?? []) {
      const idx = part.index ?? 0;
      if (!toolCalls.has(idx)) {
        toolCalls.set(idx, { id: part.id ?? `call_${idx}`, type: 'function', function: { name: '', arguments: '' } });
      }
      const call = toolCalls.get(idx);
      if (part.id) call.id = part.id;
      if (part.name) call.function.name += part.name;
      if (part.args) call.function.arguments += part.args;
    }
    if (evt.usage) usage = evt.usage;
  };

  // Providers without an SSE stream (or that answer `application/json`) get a
  // single-shot JSON parse instead of a stream read.
  const contentType = res.headers?.get?.('content-type') ?? '';
  if (!res.body || (contentType.includes('application/json') && !contentType.includes('event-stream'))) {
    const json = await res.json();
    return providerEngine.parseFull(provider, json);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      apply(providerEngine.parseEvent(provider, chunk));
    }
  }
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  }
  return { message, usage, provider: provider.id };
}

/** Resolve an attachment to {mime, base64|text} — inline payload or disk. */
function resolveAttachment(a) {
  const mime = a.mimeType || a.mime || attachmentService.guessMime(a.name);
  if (typeof a.data === 'string' && a.data) return { mime, base64: a.data };
  if (typeof a.text === 'string') return { mime, text: a.text };
  const p = a.path || a.attachmentPath;
  if (!p) return { mime };
  try {
    if (String(mime).startsWith('image/')) {
      const img = attachmentService.readAttachmentImage({ path: p });
      return { mime: img.mime, base64: String(img.dataUrl ?? '').split(',')[1] || '' };
    }
    const read = attachmentService.readAttachmentText({ path: p });
    return { mime, text: read.text };
  } catch (error) {
    return { mime, error: String(error.message ?? error) };
  }
}

function buildUserContent(message, attachments) {
  const list = (attachments ?? []).filter((a) => a && a.name);
  if (!list.length) return String(message);
  const parts = [{ type: 'text', text: String(message) }];
  for (const a of list.slice(0, 8)) {
    const resolved = resolveAttachment(a);
    if (resolved.mime?.startsWith('image/') && resolved.base64) {
      if (resolved.base64.length > 7_000_000) {
        parts.push({ type: 'text', text: `[attachment ${a.name}: too large]` });
        continue;
      }
      parts.push({ type: 'image_url', image_url: { url: `data:${resolved.mime};base64,${resolved.base64}` } });
    } else if (typeof resolved.text === 'string') {
      const clipped = resolved.text.length > 100_000 ? `${resolved.text.slice(0, 100_000)}\n…[truncated]` : resolved.text;
      parts.push({ type: 'text', text: `--- attached: ${a.name} ---\n${clipped}\n--- end of ${a.name} ---` });
    } else {
      parts.push({ type: 'text', text: `[attachment ${a.name}: unsupported${resolved.error ? ` (${resolved.error})` : ''}]` });
    }
  }
  return parts;
}

function windowHistory(history, maxTurns) {
  if (!Number.isFinite(maxTurns) || maxTurns <= 0 || history.length <= maxTurns + 1) {
    return history;
  }
  const system = history[0]?.role === 'system' ? [history[0]] : [];
  const rest = history.slice(system.length);
  let start = Math.max(0, rest.length - maxTurns);
  while (start < rest.length) {
    if (rest[start].role === 'user') break;
    start += 1;
  }
  return [...system, ...rest.slice(start)];
}

async function steerHostBrowser(name, args, sessionId, policy) {
  const { classifyAppName, classifyShell } = require('./hostBrowser');
  const decision = name === 'shell'
    ? classifyShell(args?.command)
    : name === 'computer_open_app'
      ? classifyAppName(args?.name)
      : null;
  if (!decision) return null;
  if (policy && policy.permissive !== true && policy.enableBrowser === false) {
    return 'refused: web pages open in the Electron browser, and this turn is not a browser turn';
  }
  if (decision.kind === 'url') {
    return String(await browser('open', { sessionId, url: decision.url }));
  }
  return decision.message;
}

/**
 * Run a shell command, promoting it to a background job when it runs long.
 *
 * A dev server or a long build must not consume the whole turn budget, so
 * after `backgroundAfterMs` the command is detached and the model receives a
 * `shellId` it can poll, read and write to. This mirrors Grok Bot's
 * `backgroundShellExecutor` behaviour.
 */
async function runShell(args, cwd, sessionId, signal, policy) {
  const command = String(args?.command ?? '');
  if (!command.trim()) return 'shell: no command given';
  const backgroundAfterMs = Math.max(0, Math.min(Number(args?.background_after_ms) || 15_000, 600_000));

  // Sandbox mode has its own exec path (the guest VM owns the shell).
  if (sessionId && sandboxActive(sessionId)) {
    return runSandboxShell(args, cwd, sessionId, signal);
  }

  // Exact AST cross-check (tree-sitter-bash). The synchronous gate already
  // decided; the AST can only make the verdict stricter.
  const verdict = await classifyShell(command);
  const refusal = shellPolicyRefusal(verdict, policy);
  if (refusal) return refusal;

  if (backgroundAfterMs === 0) {
    return execService.run(command, cwd);
  }

  // Start it in the background and race the foreground budget.
  const started = backgroundShells.start(command, { cwd });
  const raced = await backgroundShells.await(started.shellId, { timeoutMs: backgroundAfterMs });
  if (raced.exited) {
    return `[exit ${raced.exitCode ?? raced.signal}]\n${raced.output || '(no output)'}`;
  }
  // Still running: it becomes a background job the model can drive.
  return `[still running in the background — shell_id: ${started.shellId}, pid: ${started.pid}]\n${raced.output || '(no output yet)'}\nUse await_shell / read_shell_output / write_shell_input with this shell_id.`;
}

/**
 * Refuse a command the policy forbids, using the *merged* (sync + AST)
 * verdict.
 *
 * The AST can only escalate: a command the tokenizer called safe but the
 * exact parse shows mutating is refused here.
 */
function shellPolicyRefusal(verdict, policy) {
  if (!policy || policy.permissive === true) return null;
  if (!verdict?.mutating) return null;
  const mode = policy.permissionMode || 'read-only';
  if (mode === 'read-only') {
    return `refused: the shell analysis found this command mutates state (${verdict.reasons.join('; ') || 'mutating'})`;
  }
  if (policy.enableFileMutation === false) {
    return `refused: file mutation is gated off for this turn (${verdict.reasons.join('; ') || 'mutating'})`;
  }
  return null;
}

/**
 * Classify a shell command with the exact parser when it is available.
 *
 * The synchronous analyzer is the authority; the tree-sitter AST is a
 * second opinion that can only escalate. Returns the merged report.
 */
async function classifyShell(command) {
  const sync = require('./shell-analyze').analyze(command);
  try {
    const { analyzeAst, crossCheck, initParser } = require('./shellAst');
    if (!require('./shellAst').available()) {
      // Warm the parser in the background so later calls get the AST.
      initParser().catch(() => {});
      return sync;
    }
    const ast = await analyzeAst(command);
    return crossCheck(sync, ast);
  } catch {
    return sync;
  }
}

/** Shell execution inside the session's Linux guest sandbox. */
async function runSandboxShell(args, cwd, sessionId, signal) {
  const jobId = `xj-${computerReqId++}`;
  const running = sandboxProxy(sessionId, 'exec', { command: args.command, jobId });
  if (signal) {
    const cancelled = new Promise((resolve) => {
      const kill = () => {
        sandboxProxy(sessionId, 'exec.cancel', { jobId }).catch(() => {});
        resolve({ exitCode: 130, output: '[interrupted] child shell cancelled', jobId });
      };
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    });
    return `[exit ${(await Promise.race([running, cancelled])).exitCode}]\ninterrupted`;
  }
  const r = await running;
  return `[exit ${r.exitCode}]\n${r.output || '(no output)'}\n(sandbox: ${sandboxRootFor(sessionId)})`;
}

/**
 * Glob inside the session's Linux guest sandbox.
 *
 * The guest exposes `fs.listdir`, so we walk the tree ourselves. The matcher
 * is the same glob→RegExp translation the host path uses.
 */
async function sandboxGlob(sessionId, pattern, limit = 200) {
  const matcher = fileTools.globToRegExp(String(pattern ?? '**/*'));
  const results = [];
  const queue = ['.'];
  const seen = new Set();
  while (queue.length && results.length < limit && seen.size < 5_000) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try {
      entries = await sandboxProxy(sessionId, 'fs.listdir', { p: dir });
    } catch { continue; }
    for (const entry of entries) {
      const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (entry.dir) {
        if (['node_modules', '.git', 'proc', 'sys', 'dev', 'tmp'].includes(entry.name)) continue;
        queue.push(rel);
        continue;
      }
      if (matcher.test(rel)) {
        results.push(rel);
        if (results.length >= limit) break;
      }
    }
  }
  results.sort();
  return results;
}

/**
 * Review (and optionally apply) the isolated worktrees the subagents made.
 *
 * When children run with `environment: 'isolated'` and worktree isolation
 * is on, each one gets its own git worktree under
 * `.git/qx-worktrees/<id>`. Their changes are invisible to the main
 * workspace until somebody merges them — which used to mean the parent had
 * to do it by hand.
 *
 * This tool shows what each worktree changed and can apply the patches
 * back into the main workspace (3-way merge, so overlapping edits report a
 * conflict instead of silently clobbering).
 */
async function mergeSubagentWorktrees(args, sessionId) {
  const { gitService } = require('../main/services/gitService');
  const settings = settingsService.load();
  const repoRoot = settings.workspaceRoot || process.cwd();

  // Collect the worktrees of the relevant tasks.
  const wanted = Array.isArray(args?.ids) && args.ids.length ? new Set(args.ids.map(String)) : null;
  let records = [];
  try { records = taskStore.list(sessionId); } catch { records = []; }
  const worktrees = records
    .filter((r) => r.worktree && (!wanted || wanted.has(r.id)))
    .map((r) => ({ id: r.id, title: r.title, worktree: r.worktree, status: r.status }));

  if (!worktrees.length) {
    return wanted
      ? `no isolated worktree found for ${[...wanted].join(', ')}`
      : 'no isolated subagent worktrees to merge (run the subagents with environment: "isolated")';
  }

  const report = [];
  const patches = [];
  for (const entry of worktrees) {
    let changed = [];
    let patch = '';
    try {
      const status = await gitService.git(['-C', entry.worktree, 'status', '--porcelain=v1'], { cwd: repoRoot });
      changed = String(status || '').split('\n').filter(Boolean);
      patch = await gitService.git(['-C', entry.worktree, 'diff', 'HEAD'], { cwd: repoRoot });
    } catch (error) {
      report.push(`- ${entry.id} (${entry.title}): could not read the worktree — ${error.message}`);
      continue;
    }
    report.push(`- ${entry.id} (${entry.title}): ${changed.length ? `${changed.length} file(s) changed` : 'no changes'}`);
    for (const line of changed) report.push(`    ${line}`);
    if (patch.trim()) patches.push({ id: entry.id, patch });
  }

  const preview = report.join('\n');
  if (args?.apply !== true) {
    return `${preview}\n\nThis is a preview. Call merge_worktrees with apply: true to apply the changes to the main workspace.`;
  }

  // `git apply` needs the patch on stdin; the gitService helper takes args
  // only, so write each patch to a temp file and apply that.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const applied = [];
  const conflicts = [];
  for (const { id, patch } of patches) {
    const tmp = path.join(os.tmpdir(), `qx-merge-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.patch`);
    try {
      fs.writeFileSync(tmp, patch);
      // --3way reports a conflict instead of clobbering the working tree.
      await gitService.git(['apply', '--3way', '--whitespace=nowarn', tmp], { cwd: repoRoot });
      applied.push(id);
    } catch (error) {
      conflicts.push(`${id} (${error.message})`);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* tmp */ }
    }
  }

  const parts = [preview, ''];
  if (applied.length) parts.push(`applied: ${applied.join(', ')}`);
  if (conflicts.length) parts.push(`could not apply (resolve manually): ${conflicts.join(', ')}`);
  if (!applied.length && !conflicts.length) parts.push('nothing to apply');
  return parts.join('\n');
}

/**
 * Speculative ensemble: run one task with several models in parallel
 * isolated worktrees and keep the candidate whose verification passes.
 *
 * Grok Bot cannot do this — it has a single backend model. Quansiox can,
 * because it already speaks several providers, and the per-bot Linux guest
 * makes isolated runs cheap.
 *
 * The verification command runs *in the candidate's own worktree*, so a
 * candidate that breaks the tests is rejected on its own merits.
 */
/**
 * Run a verification command and decide whether it passed.
 *
 * Exported so the pass/fail contract can be asserted directly instead of
 * only through `speculate` (whose failure mode used to be a swallowed
 * ReferenceError that pinned every verdict to `false`).
 *
 * @param {string} command
 * @param {string} cwd  the workspace to run it in — never inferred
 * @returns {Promise<{ verified: boolean, output: string }>}
 */
async function runVerification(command, cwd) {
  if (!cwd) return { verified: false, output: 'no workspace available to run the verification command' };
  try {
    const out = await execService.run(command, cwd);
    const text = String(out ?? '');
    return { verified: /\[exit 0\]/.test(text), output: text.slice(0, 2000) };
  } catch (error) {
    return { verified: false, output: String(error?.message ?? error).slice(0, 500) };
  }
}

/**
 * Run the same task on several models at once and report which candidates
 * pass the verification command.
 *
 * The verification command runs *in the candidate's own worktree*, so a
 * candidate that breaks the tests is rejected on its own merits.
 */
async function speculate(args, ctx) {
  const task = String(args?.task ?? '').trim();
  if (!task) return 'speculate needs a task';
  const models = (Array.isArray(args?.models) ? args.models : []).map((m) => String(m).trim()).filter(Boolean).slice(0, 3);
  if (models.length < 2) return 'speculate needs at least two candidate models';
  const verify = String(args?.verify ?? '').trim();
  const type = String(args?.subagent_type ?? 'general');

  // Each candidate gets its own isolated worktree so the runs cannot collide.
  const candidates = await Promise.all(models.map(async (model) => {
    const raw = await dispatchTask({
      description: `candidate: ${model}`,
      prompt: task,
      subagent_type: type,
      model,
      environment: 'isolated',
      agent_id: `cand-${model}`,
    }, ctx);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { summary: String(raw), errored: true }; }
    return { model, ...parsed };
  }));

  const results = [];
  for (const candidate of candidates) {
    const row = {
      model: candidate.model,
      ok: candidate.success !== false && !candidate.errored && !candidate.aborted,
      summary: candidate.summary || '',
      worktree: candidate.worktree ?? null,
      verified: null,
    };
    if (verify) {
      // The verification runs in the candidate's own worktree when it has one,
      // otherwise in the session workspace. The workspace comes from
      // `ctx.cwd` — a bare `cwd` is not in scope in this function and used to
      // throw a ReferenceError that was swallowed, pinning `verified` to
      // false forever.
      const target = candidate.worktree || ctx?.cwd || null;
      if (!target) {
        row.verified = false;
        row.verifyOutput = 'no workspace available to run the verification command';
        row.note = 'verification skipped: no workspace';
      } else {
        const verdict = await runVerification(verify, target);
        row.verified = verdict.verified;
        row.verifyOutput = verdict.output;
        if (!candidate.worktree) row.note = 'verified in the shared workspace (no isolated worktree)';
      }
    }
    results.push(row);
  }

  const passed = results.filter((r) => r.verified === true);
  const lines = results.map((r) => [
    `- ${r.model}: ${r.ok ? 'ran' : 'failed'}${r.verified === null ? '' : (r.verified ? ' · VERIFIED' : ' · verification failed')}`,
    r.summary ? `    ${String(r.summary).slice(0, 400)}` : '',
    r.verifyOutput ? `    ${String(r.verifyOutput).slice(0, 600)}` : '',
  ].filter(Boolean).join('\n'));
  const verdict = passed.length === 1
    ? `\n\n${passed[0].model} passed the verification — prefer its worktree (${passed[0].worktree ?? 'shared workspace'}).`
    : passed.length > 1
      ? `\n\n${passed.length} candidates passed (${passed.map((p) => p.model).join(', ')}) — pick one and merge it.`
      : verify
        ? '\n\nNo candidate passed the verification — do not merge any of them; report what failed.'
        : '\n\nNo verification command was given, so the candidates are unverified.';
  return lines.join('\n') + verdict;
}

async function executeTool(name, args, cwd, sessionId, policy, parentToolCallId, signal, deleg, boardRoot) {
  const parentSessionId = deleg?.parentSessionId ?? null;

  // --- GOVERNANCE ------------------------------------------------------
  // One decision point for "may this action run?". The ladder (standing
  // denial → standing grant → permission mode → tool matrix → auto-review →
  // the human) lives in ./governance.js. The refusal text it produces is
  // actionable for the model: it says what did not happen, that it must not
  // be retried, and what to try instead.
  const governance = require('./governance');
  const settings = settingsService.load();
  const verdict = await governance.governToolCall({
    name,
    args,
    cwd,
    sessionId,
    policy,
    settings,
    requestConfirm: (request) => requestConfirm(request),
    complete: (messages) => completeOnce(messages, settings),
    rules: settings.autoReviewInstructions ?? {},
    context: recentContextFor(sessionId),
    autoReviewEnabled: settings.autoReviewEnabled !== false
      && settings.autoReviewInstructions?.isEnabled !== false,
  });
  if (!verdict.allowed) return verdict.refusal;

  // --- HOOKS -----------------------------------------------------------
  // `preToolUse` is the extension point that can veto or rewrite an action
  // before it happens. It runs AFTER the permission ladder, so a hook can
  // only ever be more restrictive than the user's policy — never less.
  const hooks = require('./hooks');
  if (hooks.has(hooks.HOOK.PRE_TOOL_USE)) {
    const hook = await hooks.run(hooks.HOOK.PRE_TOOL_USE, {
      tool: name, args, sessionId, cwd,
    });
    if (hook.permission === 'deny') {
      const d = require('./denialMessages').denial(
        require('./denialMessages').REASON.AUTO_REVIEW_BLOCKED,
        { tool: name },
      );
      return `${d.text} Reason: ${hook.agent_message || 'blocked by a pre-tool hook'}`;
    }
    if (hook.updated_input && typeof hook.updated_input === 'object') {
      args = { ...args, ...hook.updated_input };
    }
    if (hook.additional_context) {
      // The context is delivered to the model with the tool result.
      args = { ...args, __hookContext: hook.additional_context };
    }
  }

  // The agent-lifecycle tools have their own module (src/coordinator/agentTools.js)
  // so the coordinator's dispatch switch does not have to grow with them.
  const agentResult = await executeAgentTool(name, args, {
    sessionId,
    agentId: deleg?.agentId ?? null,
    cwd,
    signal,
  });
  if (agentResult != null) return agentResult;

  // The flat tool family (deterministic file work, precise reporting).
  const flatResult = await executeFlatTool(name, args, { sessionId, cwd, signal });
  if (flatResult != null) return flatResult;

  // The ecosystem tools: the model manages the app's own extensions.
  const ecosystemResult = await executeEcosystemTool(name, args, { sessionId, cwd, signal });
  if (ecosystemResult != null) return ecosystemResult;

  const steered = await steerHostBrowser(name, args, sessionId, policy);
  if (steered != null) return steered;
  if (name === 'submit_secret') {
    try {
      const rec = secretsService.set(args.name, args.fields, args.note);
      return `stored secret "${rec.name}" (fields: ${rec.fields.map((f) => f).join(', ') || 'none'}). Reference it as {{secret:${rec.name}.${rec.fields[0] || 'FIELD'}}}.`;
    } catch (error) { return `secret error: ${error.message}`; }
  }
  if (name === 'list_secrets') {
    const rows = secretsService.list();
    if (!rows.length) return 'no secrets stored yet';
    return rows.map((s) => `${s.name}: ${s.fields.join(', ') || '(no fields)'}`).join('\n')
      + '\nReference a value as {{secret:NAME.FIELD}} in a tool argument.';
  }
  if (name === 'request_user_input') {
    try {
      const { userInteractionService } = require('../main/services/userInteractionService');
      const timeout = Math.min(900, Math.max(10, Number(args.timeout_seconds) || 300)) * 1000;
      const title = String(args.title || 'Input requested').slice(0, 200);
      const fields = Array.isArray(args.fields) ? args.fields.slice(0, 40) : [];
      if (!fields.length) return 'user-input error: at least one field is required';
      const entry = userInteractionService.requestForm({ agentId: sessionId, sessionId, title, fields });
      const outcome = await userInteractionService.awaitEntry(entry.id, timeout);
      if (!outcome) return 'user-input error: the request disappeared';
      if (outcome.timedOut) return `user did not answer "${title}" within ${timeout / 1000}s`;
      if (outcome.state === 'dismissed' || outcome.state === 'escalated') return `user dismissed "${title}"`;
      if (outcome.state !== 'submitted') return `user-input ended in state ${outcome.state}`;
      return `user submitted:\n${JSON.stringify(outcome.values ?? {}, null, 2)}`;
    } catch (error) { return `user-input error: ${error.message}`; }
  }
  if (name === 'request_secret') {
    try {
      const { userInteractionService } = require('../main/services/userInteractionService');
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(String(args.name || ''))) {
        return 'secret request error: name must match [A-Za-z0-9][A-Za-z0-9_-]';
      }
      const names = (Array.isArray(args.fields) ? args.fields : []).map((f) => String(f)).filter(Boolean).slice(0, 20);
      if (!names.length) return 'secret request error: at least one field name is required';
      const timeout = Math.min(900, Math.max(10, Number(args.timeout_seconds) || 300)) * 1000;
      const label = String(args.label || `Enter ${args.name}`).slice(0, 200);
      const fields = names.map((f) => ({ name: f, label: f, type: 'password', required: true }));
      const entry = userInteractionService.requestForm({
        agentId: sessionId, sessionId, title: label, fields, secretName: args.name,
      });
      const outcome = await userInteractionService.awaitEntry(entry.id, timeout);
      if (!outcome) return 'secret request error: the request disappeared';
      if (outcome.timedOut) return `user did not provide "${args.name}" within ${timeout / 1000}s`;
      if (outcome.state === 'dismissed' || outcome.state === 'escalated') return `user dismissed the secret request for "${args.name}"`;
      if (outcome.state !== 'submitted') return `secret request ended in state ${outcome.state}`;
      const values = Object.fromEntries(Object.entries(outcome.values ?? {}).filter(([, v]) => String(v ?? '').length > 0));
      if (!Object.keys(values).length) return 'secret request error: no non-empty values were submitted';
      const rec = secretsService.set(args.name, values, args.note);
      return `stored secret "${rec.name}" from the user (fields: ${rec.fields.join(', ')}). Reference it as {{secret:${rec.name}.${rec.fields[0]}}}.`;
    } catch (error) { return `secret request error: ${error.message}`; }
  }
  if (name === 'board_write' || name === 'board_read' || name === 'board_list') {
    try {
      const { getBoard } = require('./blackboard');
      const board = getBoard(boardRoot || sessionId);
      if (name === 'board_list') {
        const rows = board.list();
        if (!rows.length) return 'blackboard is empty';
        return rows.map((r) => `- ${r.key} [${r.author}] rev ${r.rev}${r.mode === 'append' ? ` (${r.count} entries)` : ''}: ${r.preview}`).join('\n');
      }
      if (name === 'board_read') {
        if (!args?.key) {
          const rows = board.list();
          return rows.length ? rows.map((r) => `${r.key} (${r.mode}, rev ${r.rev})`).join('\n') : 'blackboard is empty';
        }
        const entry = board.get(String(args.key));
        if (!entry) return `no blackboard entry "${args.key}"`;
        return `# ${entry.key} (${entry.mode}, rev ${entry.rev}, by ${entry.author})\n${JSON.stringify(entry.value, null, 2)}`;
      }
      const entry = args?.mode === 'append'
        ? board.append(args.key, args.value, policy?.name || 'agent')
        : board.set(args.key, args.value, policy?.name || 'agent', { rev: args?.rev });
      if (entry?.conflict) {
        // The value moved on since this agent read it. Say so, and say what
        // the current value is — a silent overwrite loses a sibling's work.
        return `board ${entry.key} CONFLICT: ${entry.reason} (you had rev ${entry.yourRev}, it is now rev ${entry.currentRev}). `
          + `Current value: ${JSON.stringify(entry.current?.value ?? null).slice(0, 800)}. `
          + 'Read it again and merge, or write to a different key.';
      }
      return `board ${entry.key} ${args?.mode === 'append' ? 'appended' : 'set'} (rev ${entry.rev})`;
    } catch (error) { return `blackboard error: ${error.message}`; }
  }
  if (name === 'project_knowledge') {
    try {
      const { projectService } = require('../main/services/projectService');
      const { sessionService } = require('../main/services/sessionService');
      const session = sessionService.get(sessionId);
      const config = projectService.taskConfig(session);
      if (!config) return 'this task does not belong to a project';
      if (!args?.file_id) {
        if (!config.files.length) return `project "${config.projectName}" has no knowledge-base files`;
        return config.files.map((f) => `- ${f.id}  ${f.name}  (${f.size} bytes)`).join('\n');
      }
      const file = projectService.readFile(config.projectId, args.file_id);
      if (file.binary) {
        return `file ${file.name} is binary (${file.size} bytes) and cannot be read as text; use shell tools on the project files directory instead`;
      }
      return `--- ${file.name} ---\n${file.text}`;
    } catch (error) { return `project knowledge error: ${error.message}`; }
  }
  if (name === 'remember') {
    try {
      const memory = require('../main/services/memoryService').memoryService;
      const fact = memory.remember(args.text, { tags: args.tags, scope: sessionId, subject: args.subject });
      return `remembered "${fact.text}"${fact.tags.length ? ` (${fact.tags.join(', ')})` : ''} — ${fact.id}`;
    } catch (error) { return `memory error: ${error.message}`; }
  }
  if (name === 'recall') {
    try {
      const memory = require('../main/services/memoryService').memoryService;
      const rows = args.query ? memory.recall(args.query, { tags: args.tags, scope: sessionId }) : memory.list({ scope: sessionId }).slice(-8);
      if (!rows.length) return 'no matching memories';
      return rows.map((m) => `- ${m.text}${m.tags.length ? ` [${m.tags.join(', ')}]` : ''}`).join('\n');
    } catch (error) { return `memory error: ${error.message}`; }
  }
  if (['save_document', 'list_documents', 'read_document', 'append_document'].includes(name)) {
    try {
      const { documentsService } = require('../main/services/documentsService');
      if (name === 'list_documents') {
        const rows = documentsService.listLibraryDocs();
        if (!rows.length) return 'no documents in the library yet';
        return rows.map((d) => `${d.id}  ${d.title}  [${d.visibility}]  ${new Date(d.updatedAt).toISOString()}`).join('\n');
      }
      if (name === 'read_document') {
        const doc = documentsService.getDocument(String(args.id || ''));
        return `# ${doc.title}\n(${doc.visibility}, ${doc.bytes} bytes, id ${doc.id})\n\n${doc.content}`;
      }
      if (name === 'append_document') {
        let prior = '';
        let title = String(args.title || 'Untitled');
        try { const doc = documentsService.getDocument(String(args.id || '')); prior = doc.content; title = args.title || doc.title; } catch { /* new */ }
        const saved = documentsService.saveDocument({ id: args.id, title, content: `${prior}${prior && !prior.endsWith('\n') ? '\n\n' : ''}${String(args.content ?? '')}` });
        return `appended to document ${saved.id} (${saved.title}, ${saved.bytes} bytes)`;
      }
      const saved = documentsService.saveDocument({ id: args.id, title: args.title, content: args.content, visibility: args.visibility });
      return `saved document ${saved.id} (${saved.title}, ${saved.bytes} bytes)`;
    } catch (error) { return `document error: ${error.message}`; }
  }
  if (name === 'search_code') {
    try {
      const { searchService } = require('../main/services/searchService');
      const root = settingsService.load().workspaceRoot || cwd || process.cwd();
      const out = searchService.searchFiles(args.query, root, {
        regex: args.regex === true,
        context: Math.max(0, Math.min(5, Number(args.context) || 0)),
      });
      if (out.error) return `search error: ${out.error}`;
      if (!out.results.length) return `no matches for "${args.query}" (scanned ${out.filesScanned} files)`;
      const body = out.results.slice(0, 60).map((r) => `${r.path}:${r.line}: ${r.text}`).join('\n');
      return `${body}${out.truncated ? `\n…(truncated; ${out.results.length}+ matches, scanned ${out.filesScanned} files)` : ''}`;
    } catch (error) { return `search error: ${error.message}`; }
  }
  // Resolve {{secret:...}} references into a local copy (parameter reassignment
  // never affects the caller's `args`, so persisted tool cards keep the reference,
  // not the decrypted value).
  args = secretsService.resolveArgs(args);
  if (name.startsWith('task_')) {
    const action = { task_list: 'list', task_get: 'get', task_wait: 'wait', task_interrupt: 'interrupt', task_artifact: 'artifact' }[name];
    if (action) {
      const result = await taskControl(action, args, { sessionId, policy });
      return typeof result === 'string' ? result : JSON.stringify(result);
    }
  }
  if (name === 'task') {
    return dispatchTask(args, deleg || { sessionId, parentToolCallId: parentToolCallId || null, policy });
  }
  if (name === 'team') {
    return dispatchTeam(args, deleg || { sessionId, parentToolCallId: parentToolCallId || null, policy });
  }
  if (name === 'slides_deck') {
    try {
      const { slidesService } = require('../main/services/slidesService');
      const deck = args?.deck_id
        ? slidesService.update(args.deck_id, args)
        : slidesService.create(args);
      return JSON.stringify({
        id: deck.id, title: deck.title, theme: deck.theme, language: deck.language,
        slides: deck.slideCount,
        note: 'Export it with slides_export (pptx, pdf, web or notes).',
      });
    } catch (error) {
      return `slides error: ${error.message}`;
    }
  }
  if (name === 'slides_export') {
    try {
      const { slidesService } = require('../main/services/slidesService');
      const id = args?.deck_id;
      const format = String(args?.format ?? 'pptx');
      let result;
      if (format === 'pdf') result = await slidesService.exportPdf(id);
      else if (format === 'web') result = slidesService.exportWeb(id);
      else if (format === 'notes') result = slidesService.exportNotes(id);
      else result = await slidesService.exportPptx(id);
      return JSON.stringify({ format, path: result.path, bytes: result.bytes });
    } catch (error) {
      return `slides export error: ${error.message}`;
    }
  }
  if (name === 'design_mark') {
    try {
      const { designService } = require('../main/services/designService');
      const marks = designService.addMarks(args?.design_id, args?.marks ?? []);
      return JSON.stringify({ marked: marks.length, marks });
    } catch (error) {
      return `design mark error: ${error.message}`;
    }
  }
  if (name === 'design_edit') {
    try {
      const { designService } = require('../main/services/designService');
      const design = designService.applyOps(args?.design_id, args?.ops ?? [], {
        label: args?.label,
        baseVersionId: args?.base_version_id,
      });
      const version = design.versions.find((v) => v.id === design.activeVersionId);
      return JSON.stringify({
        design_id: design.id, version: version?.id, label: version?.label,
        path: version?.path, versions: design.versions.length,
      });
    } catch (error) {
      return `design edit error: ${error.message}`;
    }
  }
  if (name === 'read_image') {
    try {
      const { multimediaService } = require('../main/services/multimediaService');
      const path = args?.path;
      if (!path) return 'read_image needs a path';
      if (args?.other_path) {
        const comparison = multimediaService.compareImages(path, args.other_path);
        return comparison.ok ? JSON.stringify(comparison) : `read_image: ${comparison.reason}`;
      }
      const ocr = multimediaService.ocrImage(path);
      const analysis = multimediaService.analyzeImage(path);
      return JSON.stringify({
        ocr: ocr.ok ? { text: ocr.text, blocks: ocr.blocks.length } : { unavailable: ocr.reason },
        analysis: analysis.ok ? {
          width: analysis.width, height: analysis.height,
          dominant: analysis.dominant.slice(0, 5),
          brightness: Number(analysis.brightness.toFixed(3)),
          contrast: Number(analysis.contrast.toFixed(3)),
        } : { unavailable: analysis.reason },
      });
    } catch (error) {
      return `read_image error: ${error.message}`;
    }
  }
  if (name === 'make_video') {
    try {
      const { multimediaService } = require('../main/services/multimediaService');
      const action = String(args?.action ?? 'build');
      if (action === 'probe') {
        const info = multimediaService.probeVideo(args?.path);
        return info.ok ? JSON.stringify(info) : `make_video: ${info.reason}`;
      }
      if (action === 'frames') {
        const extracted = multimediaService.extractFrames(args?.path, { count: args?.count ?? 8 });
        return extracted.ok
          ? JSON.stringify({ frames: extracted.frames.map((f) => ({ path: f.path, timestamp: f.timestamp })) })
          : `make_video: ${extracted.reason}`;
      }
      if (action === 'audio') {
        const audio = multimediaService.extractAudio(args?.path, args?.output);
        return audio.ok ? JSON.stringify(audio) : `make_video: ${audio.reason}`;
      }
      const built = multimediaService.makeVideo(args?.paths ?? [], {
        fps: args?.fps, format: args?.format, output: args?.output,
      });
      return built.ok ? JSON.stringify(built) : `make_video: ${built.reason}`;
    } catch (error) {
      return `make_video error: ${error.message}`;
    }
  }
  if (name === 'speak') {
    try {
      const { multimediaService } = require('../main/services/multimediaService');
      const spoken = multimediaService.speak(args?.text, {
        tone: args?.tone, pace: args?.pace, style: args?.style, voice: args?.voice,
      });
      return spoken.ok
        ? JSON.stringify({ path: spoken.path, bytes: spoken.bytes, tone: spoken.tone, pace: spoken.pace, style: spoken.style })
        : `speak: ${spoken.reason}`;
    } catch (error) {
      return `speak error: ${error.message}`;
    }
  }
  if (name === 'website_build') {
    try {
      const { websiteService } = require('../main/services/websiteService');
      const action = String(args?.action ?? 'list');
      if (action === 'create') return JSON.stringify(websiteService.create(args));
      if (action === 'list') return JSON.stringify(websiteService.list());
      if (action === 'read') return JSON.stringify(websiteService.readFile(args.site_id, args.path));
      if (action === 'write') return JSON.stringify(websiteService.writeFile(args.site_id, args.path, args.content));
      if (action === 'delete') return JSON.stringify(websiteService.deleteFile(args.site_id, args.path));
      if (action === 'copy') return JSON.stringify(websiteService.makeCopy(args.site_id, { name: args.name }));
      if (action === 'seo-audit') return JSON.stringify(websiteService.seoAudit(args.site_id));
      if (action === 'apply-seo') return JSON.stringify(websiteService.applySeo(args.site_id, args.seo ?? {}));
      if (action === 'access') return JSON.stringify(websiteService.setAccess(args.site_id, args.access ?? {}));
      if (action === 'analytics') return JSON.stringify(websiteService.analyticsSummary(args.site_id));
      if (action === 'publish') {
        const published = await websiteService.publish(args.site_id, { domain: args.domain });
        return JSON.stringify(published);
      }
      return `website_build: unknown action ${action}`;
    } catch (error) {
      return `website_build error: ${error.message}`;
    }
  }
  if (name === 'analyze_data') {
    try {
      const { dataVizService } = require('../main/services/dataVizService');
      const out = dataVizService.analyze({
        data: args?.data,
        path: args?.path,
        title: args?.title || args?.question || 'Data analysis',
        subtitle: args?.question || args?.subtitle || '',
        chartTypes: Array.isArray(args?.chart_types) ? args.chart_types : [],
        output: args?.output || 'dashboard',
        segments: args?.segments === undefined ? 3 : Number(args.segments),
      });
      if (out.error) return `analyze_data: ${out.error}`;
      // The dashboard is written next to the workspace so the user can open
      // it; the HTML is returned too, so the agent can point at it.
      let written = null;
      try {
        const fs = require('node:fs');
        const path = require('node:path');
        const { settingsService } = require('../main/services/settingsService');
        const root = settingsService.load().workspaceRoot || process.cwd();
        const dir = path.join(root, 'analysis');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const base = `analysis-${stamp}`;
        if (out.html) {
          written = path.join(dir, `${base}.html`);
          fs.writeFileSync(written, out.html, 'utf8');
        }
        if (out.markdown) {
          const mdPath = path.join(dir, `${base}.md`);
          fs.writeFileSync(mdPath, out.markdown, 'utf8');
          written = written ?? mdPath;
        }
        if (out.csv) {
          const csvPath = path.join(dir, `${base}.csv`);
          fs.writeFileSync(csvPath, out.csv, 'utf8');
          written = written ?? csvPath;
        }
      } catch { /* writing the artifact is best-effort */ }
      const summary = {
        rows: out.rows,
        columns: out.columns,
        profiles: out.profiles,
        charts: out.charts,
        segments: out.segments,
        insights: out.insights,
        ...(written ? { artifact: written } : {}),
      };
      return JSON.stringify(summary);
    } catch (error) {
      return `analyze_data error: ${error.message}`;
    }
  }
  if (name === 'wide_research') {
    const { runWideResearch } = require('./wideResearch');
    const wide = await runWideResearch(args, deleg || { sessionId, parentToolCallId: parentToolCallId || null, policy }, dispatchTask);
    return typeof wide === 'string' ? wide : JSON.stringify(wide);
  }
  if (name === 'message_subagent') {
    const sched = ctx?.scheduler || schedulerFor(sessionId);
    const result = sched.steer(args.id, args.message);
    if (!result.delivered) return `cannot steer ${args.id}: ${result.reason}`;
    return `steering delivered to ${args.id}`;
  }
  if (name === 'check_subagent') {
    const sched = ctx?.scheduler || schedulerFor(sessionId);
    const row = sched.inspect(args.id);
    if (!row) {
      const record = taskStore.get(args.id, sessionId);
      if (!record) return `unknown task: ${args.id}`;
      return JSON.stringify(record);
    }
    return JSON.stringify(row, null, 1);
  }
  if (name === 'wake_parent') {
    // A child needs an answer. Notify the parent session (and the UI)
    // immediately; the answer arrives as steering.
    const question = String(args.question ?? '').trim();
    if (!question) return 'wake_parent needs a question';
    const payload = {
      id: args.id ?? null,
      question,
      context: String(args.context ?? '').slice(0, 2000),
    };
    taskStore.recordWake?.(sessionId, payload);
    emit(parentSessionId, 'onSubagentWake', payload);
    // Also surface it to the parent's own transcript so a later turn sees it.
    try {
      const { getBoard } = require('./blackboard');
      getBoard(parentSessionId || sessionId).append('questions', payload, 'subagent');
    } catch { /* board unavailable */ }
    return 'the parent was notified — wait for the answer (use check_subagent)';
  }
  if (name === 'merge_worktrees') {
    return mergeSubagentWorktrees(args, sessionId);
  }
  if (name === 'discover_ai_tools') {
    try {
      const { ecosystemService } = require('../main/services/ecosystemService');
      const found = ecosystemService.discover();
      const source = args?.source ? String(args.source) : null;
      const items = source ? found.items.filter((i) => i.source === source) : found.items;
      if (!items.length) {
        const seen = found.sources.filter((s) => s.found).map((s) => s.label).join(', ');
        return seen
          ? `no matching items (found: ${seen})`
          : 'no local AI-tool configuration found (checked ~/.claude, ~/.codex, ~/.cursor, ~/.config/opencode)';
      }
      const lines = items.map((i) => `- [${i.kind}] ${i.title} (${i.source})${i.excerpt ? ` — ${i.excerpt}` : ''}`);
      const importable = items.filter((i) => i.importable).length;
      return `${lines.join('\n')}\n\n${importable} item(s) can be imported on the user's request.`;
    } catch (error) {
      return `discovery error: ${error.message}`;
    }
  }
  if (name === 'meeting_copilot') {
    try {
      const { meetingService } = require('../main/services/meetingService');
      let meeting = args?.meetingId ? meetingService.get(String(args.meetingId)) : null;
      let text = String(args?.transcript ?? '');
      if (!meeting && !text) {
        const meetings = meetingService.list();
        meeting = meetings.length ? meetingService.get(meetings[0].id) : null;
        if (meeting) text = meetingService.transcript(meeting.id);
      }
      if (!text) {
        if (args?.title) {
          meeting = meetingService.start({ title: String(args.title), sessionId });
          text = '';
        } else {
          return 'there is no meeting to analyze — record one with the voice session, or pass a transcript.';
        }
      }
      if (args?.transcript && !meeting) {
        meeting = meetingService.start({ title: String(args?.title || 'Meeting'), sessionId });
        meetingService.appendTurn({ meetingId: meeting.id, speaker: 'Transcript', text });
        text = meetingService.transcript(meeting.id);
      }
      if (!text.trim()) return 'the meeting has no spoken content yet.';

      const settings = settingsService.load();
      if (!settings.apiKey) return 'the meeting copilot needs a configured model — open Settings and add a provider key.';
      const answer = await completeOnce(
        [
          {
            role: 'user',
            content: [
              'Analyze this meeting transcript. Reply with JSON only, in exactly this shape:',
              '{"summary":"...","decisions":["..."],"actions":[{"text":"...","owner":"...","due":"..."}],"questions":["..."],"topics":["..."]}',
              'Use an empty array when a list has no items. Be concrete and do not invent anything that was not said.',
              '',
              text.slice(0, 120_000),
            ].join('\n'),
          },
        ],
        settings
      );
      const analysis = meetingService.setAnalysis(meeting.id, meetingService.parseAnalysis(answer));
      const lines = [analysis.summary || '(no summary)'];
      if (analysis.decisions.length) {
        lines.push('Decisions:\n' + analysis.decisions.map((d) => `- ${d.text}`).join('\n'));
      }
      if (analysis.actions.length) {
        lines.push('Action items:\n' + analysis.actions.map((a) => `- ${a.text}${a.owner ? ` (owner: ${a.owner})` : ''}${a.due ? ` (due: ${a.due})` : ''}`).join('\n'));
      }
      if (analysis.questions.length) {
        lines.push('Open questions:\n' + analysis.questions.map((q) => `- ${q.text}`).join('\n'));
      }
      return lines.join('\n\n');
    } catch (error) {
      return `meeting copilot error: ${error.message}`;
    }
  }
  if (name === 'create_artifact' || name === 'update_artifact') {
    try {
      const { artifactService } = require('../main/services/artifactService');
      const isUpdate = name === 'update_artifact';
      const record = artifactService.save({
        id: isUpdate ? args?.id : undefined,
        title: args?.title,
        html: args?.html,
        kind: args?.kind,
        sessionId,
      });
      try { artifactService.open(record.id); } catch { /* the window could not open */ }
      // The chip makes the artifact reachable from the transcript.
      const chip = ['```artifact', record.id, record.title, '```'].join('\n');
      return `${chip}\n\nThe artifact "${record.title}" is ready — it is open in its own sandboxed window (no network, no access to the app) and listed under Artifacts.`;
    } catch (error) {
      return `artifact error: ${error.message}`;
    }
  }
  if (name === 'open_artifact') {
    try {
      const { artifactService } = require('../main/services/artifactService');
      const opened = artifactService.open(String(args?.id ?? ''));
      return `opened the artifact "${opened.title}".`;
    } catch (error) {
      return `artifact error: ${error.message}`;
    }
  }
  if (name === 'onepassword_list') {
    try {
      const { onePasswordService } = require('../main/services/onePasswordService');
      const state = await onePasswordService.status();
      if (!state.available) return `1Password is not available: ${state.reason}`;
      if (args?.vault) {
        const items = await onePasswordService.items({ vault: String(args.vault) });
        if (!items.length) return `no items in vault "${args.vault}"`;
        return items.map((i) => `- ${i.title} (${i.category ?? 'item'})${i.id ? ` id=${i.id}` : ''}`).join('\n');
      }
      const vaults = await onePasswordService.vaults();
      if (!vaults.length) return 'no 1Password vaults are visible to the signed-in account';
      return vaults.map((v) => `- ${v.name}${v.id ? ` (id=${v.id})` : ''}`).join('\n');
    } catch (error) {
      return `1Password error: ${error.message}`;
    }
  }
  if (name === 'onepassword_read') {
    try {
      const { onePasswordService } = require('../main/services/onePasswordService');
      const read = await onePasswordService.readSecret({
        item: args?.item,
        field: args?.field,
        vault: args?.vault,
      });
      if (!read.approved) return `the user did not approve reading that secret${read.reason ? ` (${read.reason})` : ''}`;
      const record = read.record ?? {};
      const fields = record.fields ?? {};
      const pick = (key) => {
        const value = fields[key];
        if (value === undefined || value === null) return null;
        return typeof value === 'object' ? (value.value ?? value.concealed ?? null) : value;
      };
      const wanted = args?.field ? String(args.field) : null;
      const out = wanted
        ? { [wanted]: pick(wanted) }
        : { username: pick('username'), password: pick('password'), url: pick('url') };
      return JSON.stringify({ title: record.title ?? null, ...out });
    } catch (error) {
      return `1Password error: ${error.message}`;
    }
  }
  if (name === 'speculate') {
    return speculate(args, { sessionId, policy, scheduler: deleg?.scheduler ?? null, cwd });
  }
  if (name === 'replay_skill') return replaySkill(args);
  if (name === 'record_start') {
    try { agentRecorder.start(sessionId); return 'recording started — subsequent computer_* actions are captured into a replayable skill'; }
    catch (error) { return `record error: ${error.message}`; }
  }
  if (name === 'record_stop') {
    try { const info = agentRecorder.stop(sessionId); return `recording saved as skill ${info.id} (${info.steps} step(s)). Replay it with replay_skill { id: "${info.id}" }.`; }
    catch (error) { return `record error: ${error.message}`; }
  }
  if (name === 'record_cancel') {
    try { agentRecorder.cancel(sessionId); return 'recording cancelled'; }
    catch (error) { return `record error: ${error.message}`; }
  }
  if (name === 'record_status') return JSON.stringify(agentRecorder.status(sessionId));
  if (name === 'list_skills') {
    try {
      const rows = require('../main/services/skillsService').skillsService.list();
      if (!rows.length) return 'no skills installed';
      return rows.map((s) => `- ${s.id}: ${s.name}${s.enabled ? '' : ' (disabled)'} — ${s.description || ''}`).join('\n');
    } catch (error) { return `skill error: ${error.message}`; }
  }
  if (name === 'use_skill') {
    try {
      const skill = require('../main/services/skillsService').skillsService.get(args.id);
      if (!skill) return `skill not found: ${args.id}`;
      if (skill.enabled === false) return `skill is disabled: ${args.id}`;
      const input = args.input ? `\n\nInput for this skill: ${String(args.input).slice(0, 4000)}` : '';
      return `Follow this skill ("${skill.name}") for the task.${input}\n\n--- skill: ${skill.name} (v${skill.version}) ---\n${skill.body}`;
    } catch (error) { return `skill error: ${error.message}`; }
  }
  if (name.startsWith('github_')) {
    const gh = require('../main/services/githubService').githubService;
    const op = name.slice('github_'.length);
    try {
      if (op === 'status') return JSON.stringify(await gh.status());
      const r = await gh[{
        pr_list: 'prList', pr_view: 'prView', pr_create: 'prCreate', repo: 'repoView', issue_list: 'issueList',
      }[op]](args);
      return JSON.stringify(r, null, 1).slice(0, 12_000);
    } catch (error) { return `github error: ${error.message}`; }
  }
  if (name.startsWith('slack_')) {
    const slack = require('../main/services/slackService').slackService;
    const op = name.slice('slack_'.length);
    try {
      if (op === 'status') return JSON.stringify(await slack.status());
      const r = await slack[{
        post_message: 'chatPostMessage', channels: 'conversationsList', history: 'conversationsHistory',
      }[op]](args);
      return JSON.stringify(r, null, 1).slice(0, 12_000);
    } catch (error) { return `slack error: ${error.message}`; }
  }
  if (name.startsWith('email_')) {
    const mail = require('../main/services/emailService').emailService;
    const cfg = mail.config();
    const op = name.slice('email_'.length);
    try {
      if (op === 'status') return JSON.stringify({ smtp: Boolean(cfg.smtp?.pass), imap: Boolean(cfg.imap?.pass) });
      if (op === 'send') {
        if (!cfg.smtp?.pass) return 'email not configured (set emailSmtp settings + the password secret)';
        return JSON.stringify(await mail.smtpSend({ ...cfg.smtp, from: args.from, to: args.to, subject: args.subject ?? '', text: args.text }));
      }
      if (op === 'search') {
        if (!cfg.imap?.pass) return 'email not configured (set emailImap settings + the password secret)';
        return JSON.stringify(await mail.imapSearch({ ...cfg.imap, criteria: args.criteria || 'ALL', mailbox: args.mailbox || 'INBOX', limit: args.limit }), null, 1).slice(0, 12_000);
      }
    } catch (error) { return `email error: ${error.message}`; }
  }
  if (name.startsWith('messages_')) {
    const msgs = require('../main/services/macMessagesService').macMessagesService;
    const op = name.slice('messages_'.length);
    try {
      if (op === 'status') {
        return JSON.stringify({
          enabled: msgs.getEnabled().messagesEnabled,
          permissions: msgs.checkPermissions({}),
          read: await msgs.readStatus(),
          recipients: msgs.listRecipients().recipients,
        });
      }
      if (op === 'chats') return JSON.stringify(await msgs.listChats({ limit: args.limit }), null, 1).slice(0, 12_000);
      if (op === 'read') return JSON.stringify(await msgs.readMessages({ chatId: args.chatId, identifier: args.identifier, limit: args.limit }), null, 1).slice(0, 12_000);
      if (op === 'search') return JSON.stringify(await msgs.searchMessages({ query: args.query, limit: args.limit }), null, 1).slice(0, 12_000);
      if (op === 'send') return JSON.stringify(msgs.sendMessage({ to: args.to, text: args.text }));
    } catch (error) { return `messages error: ${error.message}`; }
  }
  if (name.startsWith('mcp__')) return mcpService.callTool(name, args);
  if (name.startsWith('computer_')) {
    const method = {
      computer_screenshot: 'screenshot',
      computer_ax_tree: 'appState',
      computer_find: 'findElements',
      computer_set_value: 'setValue',
      computer_click: 'click',
      computer_type: 'typeText',
      computer_key: 'pressKey',
      computer_scroll: 'scroll',
      computer_open_app: 'openApp',
      computer_list_apps: 'listApps',
      computer_list_windows: 'listWindows',
    }[name];
    if (!method) return `unknown computer tool: ${name}`;
    const result = await computer(method, args, sessionId);
    // A guest has no accessibility tree: report that honestly instead of
    // stringifying undefined snapshot/app fields for AX-only tools.
    if (result && typeof result === 'object' && result.ok === false) {
      return `${name} unavailable on this computer: ${result.reason || 'not supported'}`;
    }
    // Agent-workflow recording: capture replayed-able computer actions (gated —
    // off unless record_start was called; never disrupts the live action).
    try { agentRecorder.noteStep(sessionId, name, args); } catch { /* recording is best-effort */ }
    if (name === 'computer_screenshot') {
      // Attach the image into the next provider turn (multimodal tool result).
      return {
        __image: {
          dataUrl: result.data,
          note: `screenshot ${result.width}x${result.height} id=${result.id} coordinate_token=${result.coordinateToken} frameHash=${result.frameHash} screenChanged=${result.screenChanged} (pass the token to computer_click; it is invalidated by the next screenshot; frameHash lets you verify screen changes)`,
        },
      };
    }
    if (name === 'computer_ax_tree') {
      const where = result.bundleId ? ` [${result.app} · ${result.bundleId}]` : '';
      return `snapshot_id=${result.snapshotId}${where} (invalidated by the next ax read)\n${JSON.stringify({ app: result.app, bundleId: result.bundleId, windowId: result.windowId, elements: result.elements }, null, 1).slice(0, 11_000)}`;
    }
    if (name === 'computer_find') {
      return JSON.stringify(result, null, 1).slice(0, 12_000);
    }
    if (name === 'computer_list_windows') {
      if (!result.windows?.length) return 'no windows found';
      return result.windows.map((w) => `- window ${w.windowId}: ${w.app} (${w.bundleId}) — ${w.title || '(untitled)'}`).join('\n');
    }
    if (name === 'computer_list_apps') {
      return JSON.stringify(result, null, 1).slice(0, 12_000);
    }
    return String(result);
  }
  if (name.startsWith('browser_')) {
    // In-app browser tools execute in the main process (WebContentsView +
    // CDP are Electron-only) via the browserCall relay.
    try {
      if (name === 'browser_open') {
        return String(await browser('open', { sessionId, url: args.url }));
      }
      if (name === 'browser_snapshot') {
        const r = await browser('snapshot', { sessionId });
        return r.text ?? JSON.stringify(r);
      }
      if (name === 'browser_screenshot') {
        const r = await browser('act', { sessionId, method: 'screenshot' });
        return {
          __image: {
            dataUrl: r.data,
            note: `browser screenshot ${r.width}x${r.height} id=${r.id}`,
          },
        };
      }
      if (name === 'browser_import_cookies') {
        // The cookie DB is decrypted in the main process; only counts cross back.
        const r = await browser('importCookies', { sessionId, args: { browser: args.browser, domains: args.domains } });
        const unmatched = Array.isArray(r.unmatchedOrigins) && r.unmatchedOrigins.length
          ? `; not granted (skipped): ${r.unmatchedOrigins.slice(0, 8).join(', ')}` : '';
        return `imported ${r.set} cookies from ${r.browser} (${r.granted} granted of ${r.parsed} parsed${r.failed ? `, ${r.failed} failed` : ''})${unmatched}`;
      }
      if (name === 'browser_fill_credentials') {
        // The vault password is injected in the main process; only a summary
        // (which fields were filled) returns here.
        const r = await browser('credentials', { sessionId, args });
        if (r && r.filled) {
          return `filled ${r.fields.join(' + ')} from vault credential "${r.credential?.title ?? r.credential?.id}"${r.submitted ? ' and submitted the form' : ''}`;
        }
        return `could not fill credentials: ${r?.reason ?? 'unknown reason'}`;
      }
      if (name === 'browser_tabs') {
        const r = await browser('tabs', { sessionId, action: args.action, args });
        return typeof r === 'string' ? r : JSON.stringify(r, null, 1).slice(0, 12_000);
      }
      if (name === 'browser_console') {
        const r = await browser('act', { sessionId, method: 'console', args: { limit: args.limit } });
        return (Array.isArray(r) && r.length)
          ? r.map((line, i) => `${i + 1}. ${line}`).join('\n').slice(0, 8_000)
          : '(console empty)';
      }
      // Simple pass-through actions.
      const method = {
        browser_click: 'click',
        browser_type: 'type',
        browser_fill: 'fill',
        browser_select: 'select',
        browser_press_key: 'press_key',
        browser_scroll: 'scroll',
        browser_js: 'js',
        browser_wait: 'wait',
        browser_handle_dialog: 'handle_dialog',
      }[name];
      if (!method) return `unknown browser tool: ${name}`;
      const r = await browser('act', { sessionId, method, args });
      if (r && r.__browserError) {
        return `${r.message} (retry after a fresh browser_snapshot if advised)`;
      }
      return typeof r === 'string' ? r : JSON.stringify(r);
    } catch (error) {
      return `browser error: ${String(error?.message ?? error)}`;
    }
  }
  if (name === 'render_pdf' || name === 'render_png') {
    // Offscreen renders execute in the main process (hidden BrowserWindow).
    const result = await new Promise((resolve, reject) => {
      if (!process.send || !process.connected) return reject(new Error('render unavailable (no IPC channel)'));
      const id = `rd-${computerReqId++}`;
      const timer = setTimeout(() => {
        browserPending.delete(id);
        reject(new Error('render timed out'));
      }, 120_000);
      browserPending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      process.send({ type: 'renderCall', id, method: name, args: { ...args, cwd } });
    });
    return `${name}: wrote ${result.bytes} bytes to ${result.path}` +
      (result.width ? ` (${result.width}x${result.height})` : '');
  }
  if (name === 'agent_js') {
    // Manus computer-use/js pattern: run the model's JS cell with cu/iab
    // bindings under a call budget + deadline, state preserved across cells.
    const { runCell } = require('./agent-code');
    const result = await runCell({
      sessionId: sessionId ?? 'default',
      code: String(args.code ?? ''),
      timeoutMs: args.timeoutMs,
      computer,
      browser,
    });
    if (result.images?.length) {
      return {
        __image: {
          dataUrl: result.images[0],
          note: `${result.text.slice(0, 4_000)}\n(+${result.images.length - 1} more image(s) from this cell)`,
        },
      };
    }
    return result.text;
  }
  if (name === 'update_plan') {
    const steps = (args.steps ?? []).slice(0, 20).map((s) => ({
      title: String(s.title ?? '').slice(0, 120),
      status: ['pending', 'in_progress', 'done'].includes(s.status) ? s.status : 'pending',
    }));
    return { __plan: steps };
  }

  // File/exec tools run inside the session's sandbox computer when one is
  // active (settings.sandboxMode); otherwise on the raw host (legacy).
  if (sessionId && sandboxActive(sessionId)) {
    try {
      switch (name) {
        case 'read_file':
          return sandboxProxy(sessionId, 'fs.read', { p: args.path });
        case 'write_file': {
          const r = await sandboxProxy(sessionId, 'fs.write', { p: args.path, content: args.content });
          return `wrote ${r.bytes} bytes to ${args.path} (in sandbox)`;
        }
        case 'edit_file': {
          // Read → edit locally → write back. The guest has no edit verb, but
          // this keeps the change surgical and inside the sandbox.
          const current = await sandboxProxy(sessionId, 'fs.read', { p: args.path });
          const tmp = path.join(os.tmpdir(), `qx-edit-${process.pid}-${Date.now()}`);
          fs.writeFileSync(tmp, current);
          const result = fileTools.applyEdit(tmp, args.old_string, args.new_string, { replaceAll: args.replace_all === true });
          let payload = null;
          try { payload = fs.readFileSync(tmp, 'utf8'); } finally { try { fs.unlinkSync(tmp); } catch {} }
          if (!result.ok) return `edit failed: ${result.error}`;
          const r = await sandboxProxy(sessionId, 'fs.write', { p: args.path, content: payload });
          return `edited ${args.path} in sandbox (${result.replaced} replacement${result.replaced === 1 ? '' : 's'})\n${result.diff || '(no diff)'}`;
        }
        case 'glob_files': {
          const rows = await sandboxGlob(sessionId, args.pattern, Math.max(1, Math.min(Number(args.limit) || 200, 1000)));
          if (!rows.length) return `no files match ${args.pattern}`;
          return rows.join('\n');
        }
        case 'list_dir': {
          const entries = await sandboxProxy(sessionId, 'fs.listdir', { p: args.path || '.' });
          return entries.map((e) => `${e.dir ? 'd' : '-'} ${e.name}`).join('\n');
        }
        default:
          break;
      }
    } catch (error) {
      return `sandbox error: ${error.message}`;
    }
  }

  switch (name) {
    case 'shell':
      return runShell(args, cwd, sessionId, signal, policy);
    case 'read_file': {
      const fs = require('node:fs');
      const p = execService.resolveInWorkspace(args.path, cwd);
      const range = fileTools.readFileRange(p, { offset: args.offset, limit: args.limit });
      const header = range.totalLines ? `lines ${range.startLine}-${range.startLine + (range.text ? range.text.split('\n').length - 1 : 0)} of ${range.totalLines}\n` : '';
      return header + range.text;
    }
    case 'edit_file': {
      const p = execService.resolveInWorkspace(args.path, cwd);
      const result = fileTools.applyEdit(p, args.old_string, args.new_string, { replaceAll: args.replace_all === true });
      if (!result.ok) return `edit failed: ${result.error}`;
      return `edited ${args.path} (${result.replaced} replacement${result.replaced === 1 ? '' : 's'})${result.fuzzy ? ' [whitespace-tolerant match]' : ''}\n${result.diff || '(no diff)'}`;
    }
    case 'glob_files': {
      const root = cwd || process.cwd();
      const rows = fileTools.globFiles(root, args.pattern, { limit: Math.max(1, Math.min(Number(args.limit) || 200, 1000)) });
      if (!rows.length) return `no files match ${args.pattern}`;
      return rows.map((r) => r.relative).join('\n');
    }
    case 'await_shell': {
      const out = await backgroundShells.await(args.shell_id, { timeoutMs: args.timeout_ms });
      return `[shell ${args.shell_id} ${out.exited ? `exited ${out.exitCode ?? out.signal}` : 'still running'}]\n${out.output || '(no output)'}`;
    }
    case 'read_shell_output': {
      const out = backgroundShells.read(args.shell_id, { limit: Math.max(1000, Math.min(Number(args.limit) || 20000, 200_000)) });
      return `[shell ${out.shellId} ${out.exited ? `exited ${out.exitCode ?? out.signal}` : 'running'}]\n${out.output || '(no output)'}`;
    }
    case 'write_shell_input': {
      const out = backgroundShells.write(args.shell_id, args.data);
      return `wrote ${out.wrote} chars to shell ${out.shellId}`;
    }
    case 'write_file': {
      const path = require('node:path');
      const { writeFileSafe } = require('./fileTools');
      const p = execService.resolveInWorkspace(args.path, cwd);
      // Atomic (temp + rename) so a crash mid-write cannot truncate the file —
      // `edit_file` already writes this way; `write_file` must match.
      writeFileSafe(p, String(args.content ?? ''));
      return `wrote ${String(args.content ?? '').length} bytes to ${p}`;
    }
    case 'list_dir': {
      const fs = require('node:fs');
      const p = execService.resolveInWorkspace(args.path || '.', cwd);
      return fs
        .readdirSync(p, { withFileTypes: true })
        .map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}`)
        .join('\n');
    }
    default:
      return `unknown tool: ${name}`;
  }
}

const toProviderTurn = (t) =>
  t.role === 'tool'
    ? { role: 'tool', tool_call_id: t.tool_call_id, content: t.content }
    : t.role === 'assistant' && t.tool_calls
      ? { role: 'assistant', content: t.content ?? '', tool_calls: t.tool_calls }
      : t.role === 'assistant'
        ? { role: 'assistant', content: t.content ?? '' }
        : { role: 'user', content: t.content };

/**
 * A short digest of the recent conversation, for the safety reviewer.
 *
 * The reviewer needs to know what the user actually asked for in order to
 * judge whether an action serves that request. It is deliberately short: the
 * reviewer is a gate, not a second agent.
 */
function recentContextFor(sessionId, maxTurns = 6) {
  try {
    const session = sessionService.get(sessionId);
    const turns = Array.isArray(session?.turns) ? session.turns : [];
    return turns
      .slice(-maxTurns)
      .map((t) => `${t?.role ?? 'user'}: ${String(t?.content ?? '').slice(0, 800)}`)
      .join('\n')
      .slice(0, 4000);
  } catch {
    return '';
  }
}

function estimateTokens(turns) {
  // Rough heuristic: ~4 chars per token, only counting text content.
  let chars = 0;
  for (const t of turns ?? []) {
    if (typeof t.content === 'string') chars += t.content.length;
    else if (Array.isArray(t.content)) {
      for (const p of t.content) if (p.type === 'text') chars += p.text.length;
    }
    if (t.tool_calls) chars += t.tool_calls.reduce((a, c) => a + (c.function?.arguments?.length ?? 0), 0);
  }
  return Math.ceil(chars / 4);
}

/** Non-streaming completion helper (used for compaction summaries). */
async function completeOnce(messages, settings) {
  const provider = providerEngine.detectProvider(settings.baseUrl, settings.model, { apiStyle: settings.apiStyle, provider: settings.provider });
  const request = providerEngine.buildRequest(provider, { model: settings.model, messages, max_tokens: 1000 }, { apiKey: settings.apiKey });
  delete request.payload.stream; // one-shot request
  const res = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.payload) });
  if (!res.ok) throw new Error(`compaction summarize ${res.status}`);
  const data = await res.json();
  return providerEngine.parseFull(provider, data).message.content ?? '';
}

/**
 * When the transcript exceeds `compactThresholdTokens` (default 60k),
 * summarize everything except the last `keep` turns and store the result
 * ({ summary, cutoff }) — the transcript itself is preserved on disk.
 */
async function maybeCompact(sessionId, settings) {
  const threshold = settings.compactThresholdTokens ?? 60_000;
  const session = sessionService.get(sessionId);
  const turns = session.turns ?? [];
  if (estimateTokens(turns) < threshold) return null;

  const keep = 10;
  if (turns.length <= keep + 4) return null; // not enough older context to bother

  // Cutoff must land on a user boundary (or after) so the kept slice is valid.
  let cutoff = turns.length - keep;
  while (cutoff < turns.length && turns[cutoff].role !== 'user') cutoff += 1;
  if (cutoff >= turns.length - 2) return null;
  const older = turns.slice(0, cutoff);

  const transcript = older
    .map((t) => {
      const who = t.role === 'user' ? 'User' : t.role === 'assistant' ? 'Assistant' : `${t.name ?? 'tool'} result`;
      const body =
        typeof t.content === 'string'
          ? t.content
          : Array.isArray(t.content)
            ? t.content.map((p) => p.text ?? `[${p.type}]`).join(' ')
            : '';
      return `${who}: ${String(body).slice(0, 2000)}`;
    })
    .join('\n')
    .slice(0, 120_000);

  const summary = await completeOnce(
    [
      {
        role: 'user',
        content: `Summarize this conversation so an AI agent can continue seamlessly. Keep: the user's goals and constraints, decisions made, files created/modified (paths), commands run and their outcomes, and anything still pending. Be concise and factual.\n\n${transcript}`,
      },
    ],
    settings
  );
  if (!summary.trim()) return null;

  const compaction = { summary: summary.trim(), cutoff, at: Date.now() };
  sessionService.saveCompaction(sessionId, compaction);
  emit(sessionId, 'onCompacted', { cutoff, turns: turns.length });
  return compaction;
}

async function run(req) {
  const { sessionId, message, attachments, sandbox, messageId, replyTo, persona, memoryScope } = req;
  const memScope = typeof memoryScope === 'string' && memoryScope ? memoryScope.slice(0, 64) : sessionId;
  if (sandbox) sessionSandboxes.set(sessionId, sandbox);
  const settings = settingsService.load();
  if (!settings.apiKey) throw new Error('No API key configured — open Settings.');
  if (Array.isArray(message) ? !message.length : !String(message).trim()) {
    throw new Error('empty message');
  }
  if (runs.has(sessionId)) throw new Error('a run is already active for this session');
  const cwd = settings.workspaceRoot || process.cwd();
  const state = { aborted: false, controller: new AbortController() };
  runs.set(sessionId, state);

  // Make sure MCP servers match the current settings (they may have changed).
  await mcpService.ensureLoaded().catch(() => {});

  sessionService.ensure(sessionId);
  const userContent = Array.isArray(message) ? message : buildUserContent(message, attachments);
  sessionService.appendTurn(sessionId, { role: 'user', content: userContent, id: messageId ?? undefined, replyTo: replyTo ?? undefined });

  // Context compaction: summarize old turns when the transcript is huge.
  await maybeCompact(sessionId, settings).catch(() => {});
  const session = sessionService.get(sessionId);
  // Windowing applies to the turn slice only — the compaction summary (like
  // the system prompt) is always kept.
  // Long-term memory: surface remembered facts relevant to the latest user
  // message (falling back to most-recent) into the system prompt. Empty store →
  // no injection (byte-for-byte unchanged), so existing behavior is preserved.
  let memoryInjection = [];
  try {
    const memoryService = require('../main/services/memoryService').memoryService;
    const lastUser = [...session.turns].reverse().find((t) => t.role === 'user' && t.content);
    const hits = memoryService.recall(String(lastUser?.content ?? ''), { limit: 8, scope: memScope });
    memoryInjection = hits.length ? hits : memoryService.relevant({ limit: 8, scope: memScope });
  } catch { /* memory store unavailable → no injection */ }
  // Skill catalog: list available (enabled) skills so the model can follow one.
  let skillsBlock = '';
  try { skillsBlock = require('../main/services/skillsService').skillsService.catalogBlock(); } catch { /* skills unavailable → no injection */ }
  // Project context (Manus "Projects"): the master instruction is read LIVE,
  // so an instruction edit applies to the very next message in the current
  // task; the knowledge-base file set is the SNAPSHOT frozen when the task
  // joined the project, so a later file upload cannot rewrite history.
  let projectBlock = '';
  try {
    const { projectService } = require('../main/services/projectService');
    projectBlock = projectService.promptBlock(session);
  } catch { /* projects unavailable → no injection */ }
  const turnsPart = windowHistory(
    session.turns.slice(session.compaction?.cutoff ?? 0).map(toProviderTurn),
    settings.historyWindowTurns ?? 60
  );
  // The turn is a span: how long it took, what it cost, and what it did.
  // It goes to the local reliability log, never anywhere else.
  const telemetry = require('../shared/telemetry');
  const turnSpan = telemetry.startSpan('agent.turn', {
    attributes: { sessionId, model: settings.model ?? null },
  });

  // `beforeSubmitPrompt` is the extension point that can add context to a
  // turn before the model sees it, and stop the turn outright.
  const hookModule = require('./hooks');
  let hookContext = '';
  let postToolContext = '';
  if (hookModule.has(hookModule.HOOK.BEFORE_SUBMIT_PROMPT)) {
    const hook = await hookModule.run(hookModule.HOOK.BEFORE_SUBMIT_PROMPT, {
      sessionId, message, cwd,
    });
    if (hook.continue === false) return { stopped: true, reason: 'a beforeSubmitPrompt hook stopped the turn' };
    hookContext = hook.additional_context || '';
  }

  const history = [
    {
      role: 'system',
      content: `${SYSTEM_PROMPT}\nWorkspace: ${cwd}${
        projectBlock
          ? `\n\n${projectBlock.trim()}`
          : ''
      }${
        memoryInjection
          ? `\n\nRemembered facts (local memory, most recent; use recall for specifics):\n${memoryInjection.map((m) => `- ${m.text}`).join('\n')}`
          : ''
      }${
        skillsBlock
          ? `\n\n${skillsBlock.trimStart()}`
          : ''
      }${
        persona && String(persona).trim()
          ? `\n\nGroup-chat persona (follow this):\n${String(persona).slice(0, 1200)}`
          : ''
      }${
        hookContext
          ? `\n\nAdditional context for this turn (from a hook):\n${String(hookContext).slice(0, 4000)}`
          : ''
      }${
        settings.systemPromptExtra?.trim()
          ? `\n\nAdditional user instructions:\n${settings.systemPromptExtra.trim()}`
          : ''
      }`,
    },
    ...(session.compaction
      ? [
          {
            role: 'user',
            content: `Summary of the earlier part of this conversation (older turns were compacted):\n\n${session.compaction.summary}`,
          },
        ]
      : []),
    ...turnsPart,
  ];

  // Safety net: snapshot workspace changes so agent edits are undoable.
  let checkpointInfo = null;
  try {
    checkpointInfo = await gitService.checkpoint(
      Array.isArray(userContent) ? 'multimodal turn' : String(message)
    );
  } catch {
    /* checkpoint failures must never block the run */
  }
  if (checkpointInfo?.committed) emit(sessionId, 'onCheckpoint', { hash: checkpointInfo.hash });

  // The policy the USER configured always applies: the permission mode, the
  // tool matrix, the computer/browser toggles. The optional model-based
  // router (Jev) may only NARROW it — it can never widen it, and its absence
  // no longer switches the safety machinery off. This is the behavioural
  // change of the 2026-10-20 repair pass: before it, a policy of
  // `{ permissive: true }` was built unless a third-party TYPESAFE_API_KEY
  // happened to be in the environment, and every gate below was dead code.
  const governance = require('./governance');
  const basePolicy = governance.basePolicyFromSettings(settings);
  let classifier = null;
  if (process.env.TYPESAFE_API_KEY) {
    try {
      const text = Array.isArray(message) ? '' : String(message);
      const judged = await judgeTurn({ userMessage: text, parentTask: text, subagentSummary: '' });
      if (!judged.skipped) {
        classifier = policyFromJudgment(judged);
        emit(sessionId, 'onRoute', {
          route: classifier.route,
          blocked: classifier.blockedDestructive,
          confidence: judged.confidence,
        });
      }
    } catch (error) {
      emit(sessionId, 'onRoute', { route: 'permissive', skipped: true, error: String(error.message) });
      classifier = null;
    }
  }
  const policy = governance.effectivePolicy({
    base: basePolicy,
    classifier,
    shellMutates: require('./permissions').shellMutates,
  });
  sessionPolicies.set(sessionId, policy);
  emit(sessionId, 'onPolicy', {
    mode: policy.mode,
    fanOut: policy.fanOut,
    enableComputer: policy.enableComputer,
    enableBrowser: policy.enableBrowser,
    classifier: classifier ? classifier.route : null,
  });

  if (!Array.isArray(message) && policy.fanOut !== false) {
    // autoTeam: 'off' | 'regex' (default) | 'model' — model planning falls back
    // to the heuristic when the provider is unavailable or returns junk.
    const teamPlan = await require('./team-planner').resolveTeamPlan(String(message), settings, {
      fallback: planTeam,
      complete: (msgs) => completeOnce(msgs, settings),
    });
    if (teamPlan) {
      try {
        emit(sessionId, 'onToolCall', { id: 'team-auto', name: 'team', args: teamPlan });
        const teamOutput = await dispatchTeam(teamPlan, {
          sessionId,
          parentToolCallId: 'team-auto',
          policy,
        });
        emit(sessionId, 'onToolResult', { id: 'team-auto', name: 'team', output: teamOutput });
        const note = `A team of subagents already ran for this turn. Synthesize their results. Do not redo their work.\n${teamOutput}`;
        history.push({ role: 'user', content: note });
        sessionService.appendTurn(sessionId, { role: 'user', content: note });
      } catch (error) {
        emit(sessionId, 'onToolResult', { id: 'team-auto', name: 'team', output: `team error: ${error.message}` });
      }
    }
  }

  let steps = 0;
  try {
    while (steps < settings.maxSteps && !state.aborted) {
      steps += 1;
      let streamed = false;
      const { message: assistantMessage, usage } = await chatCompletionStream(
        {
          model: settings.model,
          // History is windowed once at construction (summary + system stay
          // pinned); the loop only appends, so no re-windowing here.
          messages: history,
          tools: toolsForPolicy(allTools(), policy),
        },
        settings.apiKey,
        settings.baseUrl,
        (evt) => {
          if (evt.type === 'delta') {
            streamed = true;
            emit(sessionId, 'onDelta', evt.text);
          } else if (evt.type === 'reasoning') {
            emit(sessionId, 'onReasoning', evt.text);
          } else if (evt.type === 'retry') {
            emit(sessionId, 'onRetry', evt);
          }
        },
        state.controller.signal,
        { apiStyle: settings.apiStyle, provider: settings.provider },
      );
      if (usage) {
        const totals = sessionService.addUsage(sessionId, usage, settings.model);
        emit(sessionId, 'onUsage', { ...totals, last: usage, model: settings.model });
      }

      if (assistantMessage.tool_calls?.length) {
        history.push(assistantMessage);
        sessionService.appendTurn(sessionId, {
          role: 'assistant',
          tool_calls: assistantMessage.tool_calls,
          content: assistantMessage.content || null,
        });
        for (const call of assistantMessage.tool_calls) {
          if (state.aborted) break;
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
          emit(sessionId, 'onToolCall', { id: call.id, name: call.function.name, args });
          let output;
          // Every tool call is a span: the tool, how long it took, whether
          // it worked. The span is started BEFORE the call so a tool that
          // never returns is still visible.
          const toolSpan = telemetry.startSpan('agent.tool', {
            attributes: { sessionId, tool: call.function.name },
          });
          try {
            output = await executeTool(
              call.function.name,
              args,
              cwd,
              sessionId,
              sessionPolicies.get(sessionId),
              call.id,
            );
          } catch (error) {
            output = `error: ${error.message}`;
            telemetry.endSpanWithError(toolSpan, error);
            telemetry.reportFailure(error, { tool: call.function.name, sessionId });
          }
          // `postToolUse` and `postToolUseFailure` are the extension points
          // that observe what a tool did. They can add context to the next
          // turn; they cannot change what already happened.
          if (hookModule.has(hookModule.HOOK.POST_TOOL_USE)
            || hookModule.has(hookModule.HOOK.POST_TOOL_USE_FAILURE)) {
            const failed = typeof output === 'string' && output.startsWith('error:');
            const hook = await hookModule.run(
              failed ? hookModule.HOOK.POST_TOOL_USE_FAILURE : hookModule.HOOK.POST_TOOL_USE,
              { tool: call.function.name, args, sessionId, cwd, output },
            );
            if (hook.additional_context) {
              postToolContext = postToolContext ? `${postToolContext}\n${hook.additional_context}` : hook.additional_context;
            }
          }
          if (output && typeof output === 'object' && output.__plan) {
            telemetry.endSpan(toolSpan, { result: 'plan' });
            emit(sessionId, 'onPlan', output.__plan);
            sessionService.appendTurn(sessionId, {
              role: 'tool',
              tool_call_id: call.id,
              name: 'update_plan',
              content: JSON.stringify(output.__plan),
            });
            history.push({
              role: 'tool',
              tool_call_id: call.id,
              content: 'plan updated and shown to the user',
            });
            continue;
          }
          if (output && typeof output === 'object' && output.__image) {
            telemetry.endSpan(toolSpan, { result: 'image' });
            // Screenshot: tool result carries the note, then the image
            // follows as a user turn (OpenAI-compatible multimodal).
            emit(sessionId, 'onToolResult', { id: call.id, name: call.function.name, output: output.__image.note });
            emit(sessionId, 'onScreenshot', { id: call.id, dataUrl: output.__image.dataUrl });
            sessionService.appendTurn(sessionId, {
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content: output.__image.note,
            });
            history.push({ role: 'tool', tool_call_id: call.id, content: output.__image.note });
            const imageTurn = {
              role: 'user',
              content: [
                { type: 'text', text: 'The computer_screenshot tool captured the screen; the current image is attached:' },
                { type: 'image_url', image_url: { url: output.__image.dataUrl } },
              ],
            };
            history.push(imageTurn);
            sessionService.appendTurn(sessionId, { role: 'user', content: imageTurn.content, kind: 'screenshot', tool_call_id: call.id });
            continue;
          }
          if (typeof output === 'string' && output.length > 30_000) {
            output = `${output.slice(0, 30_000)}\n…[truncated]`;
          }
          // A secret can leak into a transcript through a path the model
          // never chose — a command that prints a config file, a tool that
          // reads a file with a token in it. The stored values are masked
          // before the result is persisted or shown.
          if (typeof output === 'string') {
            try {
              const { secretsService } = require('../main/services/secretsService');
              const redacted = secretsService.redact(output);
              if (redacted.redacted > 0) {
                output = `${redacted.text}\n[${redacted.redacted} secret value(s) were masked]`;
              }
            } catch { /* redaction is best-effort */ }
          }
          telemetry.endSpan(toolSpan, { result: 'ok' });
          emit(sessionId, 'onToolResult', { id: call.id, name: call.function.name, output });
          sessionService.appendTurn(sessionId, {
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: output,
          });
          history.push({ role: 'tool', tool_call_id: call.id, content: output });
        }
        // Context a post-tool hook produced is delivered to the model with
        // the next turn, once.
        if (postToolContext) {
          history.push({ role: 'user', content: `[hook] ${postToolContext}` });
          postToolContext = '';
        }
        continue;
      }

      telemetry.endSpan(turnSpan, { steps, result: 'completed' });
      if (assistantMessage.content && !streamed) emit(sessionId, 'onDelta', assistantMessage.content);
      // `afterAgentResponse` — the extension point that observes the reply.
      if (hookModule.has(hookModule.HOOK.AFTER_AGENT_RESPONSE)) {
        await hookModule.run(hookModule.HOOK.AFTER_AGENT_RESPONSE, {
          sessionId, response: assistantMessage.content, steps,
        });
      }
      const appended = sessionService.appendTurn(sessionId, { role: 'assistant', content: assistantMessage.content });
      const assistantId = appended.turns[appended.turns.length - 1]?.id ?? null;
      emit(sessionId, 'onDone', { ok: true, steps, assistantId });
      if (process.send) {
        process.send({ type: 'notify', ok: true, text: `completed in ${steps} step${steps === 1 ? '' : 's'}` });
      }
      return { ok: true, steps };
    }
    emit(sessionId, 'onDone', { ok: state.aborted ? 'aborted' : 'max_steps', steps });
    return { ok: state.aborted ? 'aborted' : 'max_steps', steps };
  } catch (error) {
    if (state.aborted || error.name === 'AbortError') {
      emit(sessionId, 'onDone', { ok: 'aborted', steps });
      return { ok: 'aborted', steps };
    }
    emit(sessionId, 'onDone', { ok: false, error: String(error.message), steps });
    if (process.send) process.send({ type: 'notify', ok: false, text: String(error.message) });
    throw error;
  } finally {
    if (state.aborted) schedulerFor(sessionId)?.abortAll();
    runs.delete(sessionId);
    sessionPolicies.delete(sessionId);
  }
}

async function retry(sessionId, sandbox) {
  const content = sessionService.popLastUserTurn(sessionId);
  if (content === null) throw new Error('nothing to retry');
  return run({ sessionId, message: content, sandbox });
}

/* ---- fork message loop ---- */
if (process.send) {
  taskStore.recover();
  // MCP servers are configured via the settings file; load them at startup
  // and reload whenever main rewrites the file.
  mcpService.reloadAll().catch((e) => console.error('[coordinator] mcp reload failed:', e.message));
  try {
    const fs = require('node:fs');
    const settingsPath = require('node:path').join(
      process.env.QUANSIOX_USER_DATA_DIR,
      'quansiox-settings.json'
    );
    let reloadTimer = null;
    fs.watchFile(settingsPath, { interval: 1000 }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(
        () => mcpService.reloadAll().catch(() => {}),
        250
      );
    });
  } catch {
    /* watching is best-effort */
  }

  process.on('disconnect', () => process.exit(0)); // parent gone — stop cleanly
  // Background shells outlive a turn; kill them when the coordinator dies.
  process.on('exit', () => { try { backgroundShells.stopAll(); } catch { /* ignore */ } });
  installIpcComputerProxy(); // computer_* tools round-trip to the main process
  process.on('message', async (msg) => {
    // Main-process reply to a computer-use round trip.
    if (msg.type === 'computerResult') {
      const waiter = computerPending.get(msg.id);
      if (waiter) {
        computerPending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve(msg.result);
      }
      return;    }
    if (msg.type === 'sandboxResult') {
      const waiter = computerPending.get(msg.id);
      if (waiter) {
        computerPending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve(msg.result);
      }
      return;
    }
    if (msg.type === 'confirmResult') {
      const waiter = confirmPending.get(msg.id);
      if (waiter) {
        confirmPending.delete(msg.id);
        waiter.resolve(msg.approved === true);
      }
      return;
    }
    if (msg.type === 'browserResult') {
      const waiter = browserPending.get(msg.id);
      if (waiter) {
        browserPending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve(msg.result);
      }
      return;
    }
    try {
      if (msg.type === 'run') {
        const result = await run(msg);
        process.send({ type: 'result', reqId: msg.reqId, result });
      } else if (msg.type === 'retry') {
        const result = await retry(msg.sessionId, msg.sandbox);
        process.send({ type: 'result', reqId: msg.reqId, result });
      } else if (msg.type === 'taskControl') {
        if (msg.sandbox) sessionSandboxes.set(msg.sessionId, msg.sandbox);
        const result = await taskControl(msg.action, msg, { sessionId: msg.sessionId, policy: { permissive: true } });
        process.send({ type: 'result', reqId: msg.reqId, result });
      } else if (msg.type === 'abort') {
        const state = runs.get(msg.sessionId);
        if (state) {
          state.aborted = true;
          state.controller.abort();
        }
        abortTree(msg.sessionId); // cascade to nested grandchildren too
        execService.abortAll();
        process.send({ type: 'result', reqId: msg.reqId, result: true });
      }
    } catch (error) {
      if (msg.reqId) {
        process.send({ type: 'result', reqId: msg.reqId, error: String(error?.message ?? error) });
      }
    }
  });
  process.send({ type: 'ready' });
}

module.exports = {
  run, retry, TOOLS, allTools, executeTool, dispatchTask, dispatchTeam, prepareChildJob, schedulerFor, taskControl,
  installIpcComputerProxy, agentRecorder, runShell, backgroundShells, fileTools, runVerification,
  recentContextFor,
};
