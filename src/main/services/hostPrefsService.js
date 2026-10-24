'use strict';
/**
 * Host preferences service — per-host UI config (Grok getHostPinnedAgents /
 * setHostPinnedAgents / getHostSidebarSections / setHostSidebarSections),
 * local-first and persisted.
 *
 * Two durable configs under userData/host-prefs.json (0600, mtime-cached for the
 * forked coordinator):
 *   - `pinned`: ordered session ids the user pinned in the sidebar.
 *   - `sections`: visibility of sidepane sections (default: all on).
 * Electron-free; consumable via the `hostPrefs` IPC namespace.
 */
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PIN_CAP = 50;
// Known sidepane sections; unknown ones are accepted (forward-compatible).
const KNOWN_SECTIONS = ['computer', 'subagents', 'skills', 'secrets', 'automations', 'dock'];
const DEFAULT_SECTIONS = Object.fromEntries(KNOWN_SECTIONS.map((s) => [s, true]));

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'host-prefs.json'); }

let cache = null;
let cacheMtime = -1;
function read() {
  try {
    const mtimeMs = fs.statSync(file()).mtimeMs;
    if (cache && mtimeMs === cacheMtime) return cache;
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    cache = cache ?? {};
  }
  cache.pinned = Array.isArray(cache.pinned) ? cache.pinned : [];
  cache.sections = (cache.sections && typeof cache.sections === 'object') ? cache.sections : {};
  return cache;
}
function write(prefs) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(prefs, null, 2), { mode: 0o600 });
  cache = prefs;
  cacheMtime = fs.statSync(file()).mtimeMs;
}

// ---- pinned agents ----
function getPinned() { return [...read().pinned]; }
function setPinned(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String);
  const valid = [];
  for (const id of list) {
    if (!ID_RE.test(id)) throw new Error(`invalid pinned id: ${id}`);
    if (!valid.includes(id)) valid.push(id);
    if (valid.length > PIN_CAP) throw new Error(`too many pinned agents (max ${PIN_CAP})`);
  }
  const prefs = read();
  prefs.pinned = valid;
  write(prefs);
  return getPinned();
}
function pin(id) { if (!ID_RE.test(String(id || ''))) throw new Error('invalid id'); const prefs = read(); if (!prefs.pinned.includes(id)) { prefs.pinned.push(id); if (prefs.pinned.length > PIN_CAP) throw new Error(`too many pinned agents (max ${PIN_CAP})`); write(prefs); } return getPinned(); }
function unpin(id) { const prefs = read(); prefs.pinned = prefs.pinned.filter((p) => p !== id); write(prefs); return getPinned(); }

// ---- sidebar sections ----
function sections() { return { ...DEFAULT_SECTIONS, ...read().sections }; }
function setSections(map) {
  if (!map || typeof map !== 'object') throw new Error('sections must be an object');
  const prefs = read();
  const merged = { ...DEFAULT_SECTIONS };
  for (const [k, v] of Object.entries(map)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(k)) throw new Error(`invalid section: ${k}`);
    merged[k] = v === true || v === 'true' || v === 1;
  }
  prefs.sections = merged;
  write(prefs);
  return sections();
}
function toggleSection(name, on) { return setSections({ [name]: on }); }

module.exports = { hostPrefsService: { getPinned, setPinned, pin, unpin, sections, setSections, toggleSection, KNOWN_SECTIONS } };
