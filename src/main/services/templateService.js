'use strict';
/**
 * Local bot templates (GPA / docs "share a bot", local analog).
 *
 * A template snapshots a session's bot profile (title/label/description) plus
 * an optional starter prompt. Templates are local: "publish" stores them in
 * this catalog, "share" exports a JSON file the user can hand to someone else,
 * and importing merges one back. No marketplace/account backend.
 *
 * Store: <userData>/bot-templates.json (0600). Electron-free.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sessionService } = require('./sessionService');

const MAX_TEMPLATES = 100;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 600;
const MAX_PROMPT = 4000;
const ID_RE = /^tpl_[a-z0-9]{6,32}$/;
const VISIBILITIES = new Set(['private', 'shared']);

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'bot-templates.json'); }
function loadAll() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.templates)) return data.templates;
  } catch { /* first publish */ }
  return [];
}
function saveAll(templates) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ templates }, null, 2), { mode: 0o600 });
}
function clean(value, max) { return String(value ?? '').trim().slice(0, max); }
function newId() { return `tpl_${crypto.randomBytes(8).toString('hex')}`; }

function reduced(t) {
  return {
    id: t.id, name: t.name, description: t.description, visibility: t.visibility,
    profile: t.profile, prompt: t.prompt || '', version: t.version,
    sourceSessionId: t.sourceSessionId ?? null, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}
function validVisibility(v) {
  if (!VISIBILITIES.has(String(v))) throw new Error('visibility must be private or shared');
  return String(v);
}

/** Snapshot a session as a template ("publish"/"share"). */
function publishFromSession({ sessionId, name, description, prompt, visibility } = {}) {
  if (!sessionId) throw new Error('sessionId is required');
  const session = sessionService.get(String(sessionId));
  if (session.kind === 'group') throw new Error('a group chat cannot be saved as a bot template');
  const templates = loadAll();
  if (templates.length >= MAX_TEMPLATES) throw new Error(`template catalog is full (max ${MAX_TEMPLATES})`);
  const now = Date.now();
  const existing = templates.find((t) => t.sourceSessionId === sessionId && t.name === clean(name || session.title, MAX_NAME));
  const template = {
    id: existing?.id ?? newId(),
    name: clean(name || session.title || 'Bot template', MAX_NAME),
    description: clean(description ?? existing?.description ?? session.description, MAX_DESCRIPTION),
    visibility: validVisibility(visibility ?? existing?.visibility ?? 'private'),
    profile: {
      title: clean(session.title, 80),
      label: clean(session.label, 60),
      description: clean(session.description, 400),
    },
    prompt: clean(prompt ?? existing?.prompt, MAX_PROMPT),
    sourceSessionId: String(sessionId),
    version: (existing?.version ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (!template.name) throw new Error('template needs a name');
  if (existing) templates.splice(templates.indexOf(existing), 1, template);
  else templates.push(template);
  saveAll(templates);
  return reduced(template);
}

function list({ visibility } = {}) {
  return loadAll()
    .filter((t) => !visibility || t.visibility === visibility)
    .map(reduced)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function get(id) {
  if (!ID_RE.test(String(id ?? ''))) return null;
  const t = loadAll().find((x) => x.id === id);
  return t ? reduced(t) : null;
}
function getPublic(id) {
  const t = get(id);
  if (!t) return null;
  if (t.visibility !== 'shared') throw new Error('template is private');
  return t;
}
function getForSourceAgent(sessionId) {
  const matches = loadAll().filter((x) => x.sourceSessionId === String(sessionId ?? ''));
  const t = matches.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  return t ? reduced(t) : null;
}
function setVisibility(id, visibility) {
  const templates = loadAll();
  const t = templates.find((x) => x.id === id);
  if (!t) throw new Error('unknown template');
  t.visibility = validVisibility(visibility);
  t.updatedAt = Date.now();
  saveAll(templates);
  return reduced(t);
}
function remove(id) {
  const templates = loadAll();
  const index = templates.findIndex((x) => x.id === id);
  if (index === -1) throw new Error('unknown template');
  templates.splice(index, 1);
  saveAll(templates);
  return true;
}

/** Validate an imported/exported template document. */
function normalizeDocument(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('template document must be an object');
  const body = doc.template ?? doc;
  const profile = body.profile && typeof body.profile === 'object' ? body.profile : {};
  const template = {
    id: ID_RE.test(String(body.id ?? '')) ? String(body.id) : newId(),
    name: clean(body.name, MAX_NAME),
    description: clean(body.description, MAX_DESCRIPTION),
    visibility: VISIBILITIES.has(body.visibility) ? body.visibility : 'private',
    profile: {
      title: clean(profile.title, 80),
      label: clean(profile.label, 60),
      description: clean(profile.description, 400),
    },
    prompt: clean(body.prompt, MAX_PROMPT),
    sourceSessionId: null,
    version: Math.max(1, Number(body.version) || 1),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (!template.name) throw new Error('template document has no name');
  return template;
}
function exportDocument(id) {
  const t = get(id);
  if (!t) throw new Error('unknown template');
  return { format: 'quansiox.bot-template', version: 1, exportedAt: new Date().toISOString(), template: t };
}
function importDocument(doc) {
  const template = normalizeDocument(doc);
  const templates = loadAll();
  if (templates.length >= MAX_TEMPLATES) throw new Error(`template catalog is full (max ${MAX_TEMPLATES})`);
  // Importing never overwrites an existing template; it gets a fresh id.
  template.id = newId();
  templates.push(template);
  saveAll(templates);
  return reduced(template);
}

/** Create a new local bot session from a template. */
function createFromTemplate({ templateId, name } = {}) {
  const t = templateId ? get(templateId) : null;
  if (!t) throw new Error('unknown template');
  const id = crypto.randomUUID();
  sessionService.ensure(id);
  const title = clean(name || t.profile.title || t.name, 80) || 'New bot';
  sessionService.update(id, {
    title,
    label: t.profile.label,
    description: t.profile.description || t.description,
  });
  return { session: sessionService.get(id), template: t, prompt: t.prompt || '' };
}

function exportPolicy() {
  return {
    exportable: true,
    formats: ['json'],
    visibility: ['private', 'shared'],
    note: 'Local templates export as a JSON document; sharing is a file handoff, not a cloud link.',
  };
}
function version(id) {
  const t = get(id);
  if (!t) throw new Error('unknown template');
  return { id: t.id, version: t.version };
}

module.exports = {
  templateService: {
    publishFromSession, list, get, getPublic, getForSourceAgent, setVisibility, remove,
    exportDocument, importDocument, createFromTemplate, exportPolicy, version, normalizeDocument,
  },
};
