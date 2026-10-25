'use strict';
/**
 * Feature-flag service — local device flags + experiment overrides
 * (Grok getExperimentsSnapshot / applyExperimentOverride / refreshFeatureFlags /
 * applyFeatureFlagOverride / exposeFeatureGate), local-first.
 *
 * A small default map (reflecting real Quansiox feature states) plus a
 * persisted override map (userData/flags.json, 0600, mtime-cached so the forked
 * coordinator observes saves). `evaluate(flag, default)` is the primitive callers
 * use to gate behavior; `snapshot()` reports every flag with its effective value
 * and source. Overrides win over defaults.
 */
const fs = require('node:fs');
const path = require('node:path');

const FLAG_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

// Defaults mirror the current codebase reality; updated as features ship.
const DEFAULTS = {
  nestedDelegation: true,       // children may spawn children (depth-capped)
  delegationModelParams: true,  // per-child model_parameters
  longTermMemory: true,         // remember/recall + prompt injection
  cookieImport: true,           // authenticated browser sessions
  automations: true,            // scheduled/background agent runs
  automationsWebhook: true,     // local webhook receiver
  screenBridge: true,           // unified-runtime Phase 0 transport
  unifiedComputerRuntime: false,// guest framebuffer/input (native, not shipped)
  skillRecordingCapture: false, // human-action capture (native, not shipped)
  // ---- Grok experiment names, registered as documented no-op-local
  // defaults (P3.15): the names/ids are extraction facts; the VALUES are
  // quansiox's truthful local state — true only where the feature shipped
  // here, false otherwise. No experiment network traffic exists; overrides
  // still win locally.
  'grok_bot_library_v2': true,        // typed library shipped (P2.5)
  'grok_bot_library_pins': true,      // pins shipped (P2.5)
  'grok_bot_library_hover_cards': true, // hover cards shipped (P2.5)
  'grok_bot_library_pages': false,    // pages surface pending
  'grok_bot_library_external_docs': false,
  'grok_bot_pages_search': false,
  'grok_bot_memory_import': false,    // import flow pending
  'grok_bot_multiplayer': false,
  'grok_bot_team_bot_details_panel': false,
  'grok_bot_canvas_design_mode': false,
  'grok_bot_glean_remote_mcp_setup_enabled': false,
  'sand_enable_visualizations': false, // P2.7 pending
  'sand_mcp_apps': false,              // P2.9 pending
  'sand_simplified_right_pane': false,
  'sand_area': false,
};

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'flags.json'); }

let cache = null;
let cacheMtime = -1;
function overrides() {
  try {
    const mtimeMs = fs.statSync(file()).mtimeMs;
    if (cache && mtimeMs === cacheMtime) return cache;
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    cache = cache ?? {};
  }
  return cache;
}
function writeOverrides(o) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(o, null, 2), { mode: 0o600 });
  cache = o;
  cacheMtime = fs.statSync(file()).mtimeMs;
}

function evaluate(name, fallback) {
  if (!FLAG_RE.test(String(name || ''))) return fallback;
  const o = overrides();
  if (name in o) return o[name];
  return name in DEFAULTS ? DEFAULTS[name] : fallback;
}

function override(name, value) {
  if (!FLAG_RE.test(String(name || ''))) throw new Error('invalid flag name');
  const o = overrides();
  o[name] = value;
  writeOverrides(o);
  return { name, value, source: 'override' };
}
function clearOverride(name) {
  if (!FLAG_RE.test(String(name || ''))) throw new Error('invalid flag name');
  const o = overrides();
  delete o[name];
  writeOverrides(o);
  return { name, cleared: true };
}

/** Full snapshot: every known + overridden flag, its effective value + source. */
function snapshot() {
  const o = overrides();
  const names = [...new Set([...Object.keys(DEFAULTS), ...Object.keys(o)])].sort();
  return {
    flags: names.map((name) => ({
      name,
      value: name in o ? o[name] : DEFAULTS[name] ?? null,
      source: name in o ? 'override' : 'default',
      hasOverride: name in o,
    })),
    overrides: Object.keys(o).length,
    generatedAt: Date.now(),
  };
}

function refresh() { try { fs.statSync(file()).mtimeMs; } catch {} cache = null; cacheMtime = -1; return snapshot(); }

module.exports = { flagsService: { evaluate, override, clearOverride, snapshot, refresh, DEFAULTS } };
