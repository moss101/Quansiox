'use strict';
/**
 * Skills service — a real, local skill/plugin catalog (the local analog of
 * Cursor/Manus skills). A skill is a named package with a SKILL.md-style body
 * (instructions the model can follow), optional tool hints, and an enable flag.
 * Stored as one JSON file per skill under userData/skills/ (0600), Electron-free
 * so the forked coordinator can read/inject the catalog.
 *
 * There is no remote store — "publish" installs into the local catalog, and
 * "targets" is the local catalog. Sync installs a batch.
 */
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_BODY = 16_000;
const MAX_SKILLS = 200;

function userDataDir() {
  return require('./userData').userDataDir();
}
function skillsDir() { return path.join(userDataDir(), 'skills'); }
function skillFile(id) { return path.join(skillsDir(), `${id}.json`); }

function validId(id) { return typeof id === 'string' && ID_RE.test(id); }

function read(id) {
  if (!validId(id)) throw new Error('invalid skill id');
  return JSON.parse(fs.readFileSync(skillFile(id), 'utf8'));
}
function write(skill) {
  fs.mkdirSync(skillsDir(), { recursive: true });
  fs.writeFileSync(skillFile(skill.id), JSON.stringify(skill, null, 2), { mode: 0o600 });
}
const summary = (s) => ({ id: s.id, name: s.name, description: s.description, version: s.version, enabled: s.enabled !== false, tools: s.tools || [], updatedAt: s.updatedAt });

function list() {
  const dir = skillsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean).map(summary).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function get(id) { if (!validId(id)) return null; try { return read(id); } catch { return null; } }

/** Install/publish into the local catalog (upsert). */
function install(spec = {}) {
  const id = String(spec.id ?? spec.slug ?? spec.name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!validId(id)) throw new Error('skill needs a valid id ([a-z0-9][a-z0-9_-])');
  const name = String(spec.name ?? spec.title ?? id);
  const body = String(spec.body ?? spec.prompt ?? spec.content ?? '');
  if (!body.trim()) throw new Error('skill needs a body (instructions)');
  if (body.length > MAX_BODY) throw new Error(`skill body too large (>${MAX_BODY})`);
  let existing = null;
  try { existing = read(id); } catch {}
  if (!existing && list().length >= MAX_SKILLS) throw new Error(`skill catalog full (max ${MAX_SKILLS})`);
  const now = Date.now();
  const skill = {
    id, name: name.slice(0, 120),
    description: String(spec.description ?? '').slice(0, 400),
    version: String(spec.version ?? (existing ? (existing.version || '1') : '1')),
    body,
    tools: Array.isArray(spec.tools) ? spec.tools.map(String).slice(0, 40) : (existing?.tools || []),
    enabled: spec.enabled === undefined ? (existing?.enabled ?? true) : spec.enabled === true,
    createdAt: existing?.createdAt ?? now, updatedAt: now,
  };
  write(skill);
  return skill;
}
function installBatch(packages = []) {
  const out = [];
  for (const p of (Array.isArray(packages) ? packages : [])) {
    try { out.push({ status: 'ok', id: install(p).id }); }
    catch (error) { out.push({ status: 'error', error: String(error?.message ?? error) }); }
  }
  return { installed: out.filter((r) => r.status === 'ok').length, failed: out.filter((r) => r.status === 'error').length, results: out };
}
function uninstall(id) { if (!validId(id)) throw new Error('invalid skill id'); fs.rmSync(skillFile(id), { force: true }); return { removed: id }; }
function setEnabled(id, enabled) { if (!validId(id)) throw new Error('invalid skill id'); const s = read(id); s.enabled = enabled === true; s.updatedAt = Date.now(); write(s); return summary(s); }

/** Publish targets: the local catalog is the only target (no remote store). */
function publishTargets() { return [{ target: 'local', label: 'This computer', skills: list().length }]; }

/** Status block for sync (Grok getPluginSyncStatus). */
function syncStatus() { const all = list(); return { catalog: 'skills', total: all.length, enabled: all.filter((s) => s.enabled).length, lastSyncAt: all.reduce((m, s) => Math.max(m, s.updatedAt || 0), 0) || null }; }

/** Block injected into the agent system prompt: enabled skills + how to use them. */
function catalogBlock() {
  const enabled = list().filter((s) => s.enabled);
  if (!enabled.length) return '';
  return `\n\nAvailable skills (local catalog). To follow one, call use_skill with its id:\n`
    + enabled.map((s) => `- **${s.name}** (id: ${s.id}): ${s.description || '(no description)'}`).join('\n');
}

module.exports = { skillsService: { list, get, install, installBatch, uninstall, setEnabled, publishTargets, syncStatus, catalogBlock } };
