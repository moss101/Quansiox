'use strict';
/**
 * Settings service — plain JSON store in userData (Manus-style storageHelper).
 * Holds agent provider config: { baseUrl, apiKey, model, workspaceRoot, ... }.
 * Electron-free when QUANSIOX_USER_DATA_DIR is set (used by the forked
 * coordinator process).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A packaged app launched from Finder starts with cwd `/`; an empty
 * workspaceRoot used to fall through to `process.cwd()` and produce
 * `/.quansiox/sandboxes/<id>` (ENOENT). Normalize to a writable, visible home
 * folder and persist it on startup.
 */
function defaultWorkspaceRoot() {
  const override = String(process.env.QUANSIOX_DEFAULT_WORKSPACE || '').trim();
  if (override && path.isAbsolute(override) && override !== path.parse(override).root) return override;
  // Test/coordinator contexts pin userData to a temp dir: keep the default
  // workspace beside it instead of creating ~/Quansiox on a test machine.
  if (process.env.QUANSIOX_USER_DATA_DIR) return path.join(process.env.QUANSIOX_USER_DATA_DIR, 'workspace');
  return path.join(os.homedir(), 'Quansiox');
}

function normalizeWorkspaceRoot(value) {
  const raw = String(value || '').trim();
  const normalized = (!raw || !path.isAbsolute(raw) || raw === path.parse(raw).root)
    ? defaultWorkspaceRoot()
    : raw;
  // A default substituted at read time must exist before a spawn uses it as
  // cwd (Node reports ENOENT for a missing cwd). Configured paths are created
  // by the services that write there.
  if (normalized !== raw) {
    try { fs.mkdirSync(normalized, { recursive: true }); } catch { /* read-only fallback reports later */ }
  }
  return normalized;
}

function userDataDir() {
  return require('./userData').userDataDir();
}

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  provider: '', // '' = auto-detect from baseUrl; else openai-chat|openai-responses|anthropic|gemini|ollama|lmstudio
  apiStyle: 'chat', // 'chat' (default) or 'responses' for the OpenAI Responses API
  subagentModel: '', // optional cheaper model for subagents ('' = same as main)
  autoTeam: 'regex', // 'off' | 'regex' (heuristic, default) | 'model' (LLM-planned team)
  worktreeIsolation: false, // isolated subagents get a git worktree instead of a sandbox copy
  chromeCookieImport: false, // allow reading an installed Chromium browser's cookie DB (grants required)
  workspaceRoot: '',
  maxSteps: 24,
  mcpServers: [], // [{ name, command, args, env }]
  autoCheckpoint: true, // git snapshot before each agent turn (if repo exists)
  autoInitRepo: false, // `git init` the workspace on first checkpoint
  systemPromptExtra: '', // user-added instructions appended to the system prompt
  notifyOnDone: true, // macOS notification when an agent turn finishes unfocused
  globalShortcut: '', // e.g. "CommandOrControl+Shift+K"; empty = disabled
  compactThresholdTokens: 60_000, // summarize older turns beyond this context size
  updateFeedUrl: '', // latest.json feed ({version,url,notes}); empty = off
  updateTrustedPublishers: [], // publishers whose updates may be installed (an empty list trusts the feed's own digest)
  updateChannel: 'latest', // release track label
  autoUpdateWhenIdle: false, // auto-install updates while idle
  profiles: [], // saved provider profiles: [{ id, name, baseUrl, apiKey, model }]
  allowComputerUse: false, // agent may control the GUI (opt-in; needs Accessibility + Screen Recording)
  requireApproval: false, // prompt Approve/Deny before gated tools (mid-run)
  permissionMode: 'workspace', // 'read-only' | 'workspace' | 'computer' — the permission ladder (always enforced)
  permissionModeSet: false, // true once the user chose a mode explicitly (then the computer switch does not override it)
  allowBrowser: true, // agent may drive the embedded browser
  enableFileMutation: true, // agent may write files
  autoReviewEnabled: true, // the safety reviewer runs on gated actions
  sandboxMode: 'sandboxed', // 'sandboxed' = tools run in per-session sandbox computers; 'off' = raw host
  slackTokenSecret: 'slack_bot_token', // name of the encrypted secret holding the Slack bot token
  prompts: [], // saved prompt library: [{ id, title, body, createdAt }]
};

let cached = null;
let cachedMtimeMs = 0;
function file() {
  return path.join(userDataDir(), 'quansiox-settings.json');
}

function load() {
  // Re-read when the file changed on disk — the forked coordinator caches
  // too and must observe main-process saves.
  try {
    const mtimeMs = fs.statSync(file()).mtimeMs;
    if (cached && mtimeMs === cachedMtimeMs) return cached;
    cached = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
    cached.workspaceRoot = normalizeWorkspaceRoot(cached.workspaceRoot);
    cached.permissionMode = normalizePermissionMode(cached);
    cachedMtimeMs = mtimeMs;
  } catch {
    cached = cached ?? { ...DEFAULTS };
    cached.workspaceRoot = normalizeWorkspaceRoot(cached.workspaceRoot);
    cached.permissionMode = normalizePermissionMode(cached);
  }
  return cached;
}

/**
 * Reconcile the permission mode with the "allow computer use" switch.
 *
 * The mode ladder (read-only → workspace → computer) is the policy; the
 * macOS-level opt-in is a prerequisite. But a user who ticks "let the agent
 * control the computer" plainly expects the agent to be able to — so when
 * computer use is enabled and the user has never *explicitly* chosen a mode
 * (`permissionModeSet`), the mode follows the switch.
 *
 * An explicit choice always wins, in either direction.
 */
function normalizePermissionMode(settings) {
  const explicit = ['read-only', 'workspace', 'computer'].includes(settings?.permissionMode)
    ? settings.permissionMode
    : 'workspace';
  if (settings?.permissionModeSet === true) return explicit;
  if (settings?.allowComputerUse === true && explicit === 'workspace') return 'computer';
  return explicit;
}

function save(partial) {
  cached = { ...load(), ...partial };
  // A direct mode change is an explicit choice and stops the "allow computer
  // use" switch from overriding it.
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'permissionMode')) {
    cached.permissionModeSet = true;
  }
  cached.permissionMode = normalizePermissionMode(cached);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cached, null, 2));
  return redacted(cached);
}

function redacted(s) {
  return { ...s, apiKey: s.apiKey ? `${s.apiKey.slice(0, 6)}…${s.apiKey.slice(-4)}` : '' };
}

/** Normalized workspace root (never empty, never filesystem root). */
function workspaceRoot() {
  return load().workspaceRoot;
}

/**
 * Startup seed: create the workspace folder and persist it once, so the
 * renderer and the forked coordinator agree on a writable path even when the
 * app was launched with cwd `/`. Returns the usable root.
 */
function ensureWorkspaceRoot() {
  const root = workspaceRoot();
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* access check below reports honestly */ }
  try {
    const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (onDisk.workspaceRoot !== root) save({ workspaceRoot: root });
  } catch {
    try { save({ workspaceRoot: root }); } catch { /* read-only userData: in-memory root still works */ }
  }
  return root;
}

module.exports = {
  settingsService: { load, save, redacted, workspaceRoot, ensureWorkspaceRoot, defaultWorkspaceRoot },
};
