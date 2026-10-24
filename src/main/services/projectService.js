'use strict';
/**
 * Projects — the local-first implementation of Manus' "Projects" feature.
 *
 * A project is a persistent workspace that carries two things into every
 * task started inside it:
 *
 *   - a **master instruction** — a standing brief for the agent;
 *   - a **knowledge base** — a set of files the task can read.
 *
 * The propagation rules are the part that is easy to get wrong, so they are
 * spelled out here and encoded in the data model:
 *
 *   1. An **instruction update applies to the next message in the current
 *      task** (Manus: "Instruction updates apply the next time you send a
 *      message in your current task"). The instruction is therefore read
 *      LIVE at every turn — never snapshotted.
 *
 *   2. A **file update applies only to new tasks created after the update**
 *      (Manus: "File updates only take effect in new tasks created after the
 *      update"). Files are therefore snapshotted at task-creation time.
 *
 * To make (2) hold without copying bytes, project files are stored as
 * **immutable, content-addressed blobs**: replacing a knowledge-base file
 * creates a *new* blob id, and the old blob stays readable for the tasks
 * that snapshotted it. `gc()` reclaims blobs no project and no task
 * snapshot references any more.
 *
 * Projects are private by default and there is no cloud to share them with,
 * so "collaborators" are a local roster (PRJ-13..17): the project records
 * who may see the shared instruction and knowledge base, and a task inside a
 * project stays owned by whoever created it.
 *
 * Store: <userData>/projects.json (0600) + <userData>/project-files/<projectId>/<fileId>.
 * Electron-free so tests can drive it headlessly.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[a-zA-Z0-9_-]{3,64}$/;
const MAX_NAME = 120;
const MAX_INSTRUCTION = 20_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Files whose content is inlined into the prompt instead of being listed. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.sh', '.sql',
  '.html', '.css', '.xml', '.toml', '.ini', '.conf', '.env.example',
]);
const INLINE_BYTE_BUDGET = 24_000;

function userDataDir() {
  return require('./userData').userDataDir();
}
function storeFile() { return path.join(userDataDir(), 'projects.json'); }
function blobDir(projectId) {
  if (!ID_RE.test(String(projectId || ''))) throw new Error('invalid project id');
  return path.join(userDataDir(), 'project-files', projectId);
}
function newId() { return 'prj_' + crypto.randomBytes(9).toString('base64url'); }
function newBlobId() { return 'f_' + crypto.randomBytes(12).toString('base64url'); }

/* ------------------------------------------------------------------ store */

function loadAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveAll(list) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(list, null, 2), { mode: 0o600 });
}

/** Pinned first, then the manual drag-and-drop order, then newest last. */
function sortProjects(list) {
  return list
    .slice()
    .sort((a, b) => {
      const pin = (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0);
      if (pin) return pin;
      const order = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if (order) return order;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    });
}

/** The shape the renderer sees: no absolute paths, no blob contents. */
function reduced(project) {
  return {
    id: project.id,
    name: project.name,
    masterInstruction: project.masterInstruction ?? '',
    files: (project.files ?? []).map((f) => ({
      id: f.id, name: f.name, size: f.size, mime: f.mime ?? null, addedAt: f.addedAt,
    })),
    pinned: project.pinned === true,
    sortOrder: project.sortOrder ?? 0,
    createdAt: project.createdAt ?? 0,
    updatedAt: project.updatedAt ?? 0,
    configVersion: project.configVersion ?? 1,
    collaborators: (project.collaborators ?? []).map((c) => ({
      id: c.id, name: c.name, role: c.role ?? 'member',
    })),
    private: project.private !== false,
    taskCount: Number(project.taskCount ?? 0),
  };
}

/* --------------------------------------------------------------- projects */

function normalizeName(input) {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('project name required');
  return name.slice(0, MAX_NAME);
}
function normalizeInstruction(input) {
  return String(input ?? '').slice(0, MAX_INSTRUCTION);
}

function create({ name, masterInstruction = '', id } = {}) {
  const projectId = id && ID_RE.test(String(id)) ? String(id) : newId();
  const list = loadAll();
  if (list.some((p) => p.id === projectId)) throw new Error('project already exists');
  const now = Date.now();
  const project = {
    id: projectId,
    name: normalizeName(name),
    masterInstruction: normalizeInstruction(masterInstruction),
    files: [],
    pinned: false,
    sortOrder: list.length,
    createdAt: now,
    updatedAt: now,
    configVersion: 1,
    collaborators: [],
    private: true,
  };
  list.push(project);
  saveAll(list);
  return reduced(project);
}

function get(id) {
  const project = loadAll().find((p) => p.id === id);
  return project ? reduced(project) : null;
}

function raw(id) {
  return loadAll().find((p) => p.id === id) ?? null;
}

function update(id, patch = {}) {
  const list = loadAll();
  const index = list.findIndex((p) => p.id === id);
  if (index === -1) throw new Error('project not found');
  const project = list[index];
  if (patch.name !== undefined) project.name = normalizeName(patch.name);
  if (patch.masterInstruction !== undefined) {
    project.masterInstruction = normalizeInstruction(patch.masterInstruction);
    // An instruction edit bumps the config version but never invalidates a
    // task snapshot: instructions are read live (PRJ-18).
    project.configVersion = (project.configVersion ?? 1) + 1;
  }
  if (patch.pinned !== undefined) project.pinned = patch.pinned === true;
  if (patch.private !== undefined) project.private = patch.private !== false;
  project.updatedAt = Date.now();
  list[index] = project;
  saveAll(list);
  return reduced(project);
}

function remove(id) {
  const list = loadAll();
  const index = list.findIndex((p) => p.id === id);
  if (index === -1) return { removed: false };
  const [project] = list.splice(index, 1);
  saveAll(list);
  try { fs.rmSync(blobDir(project.id), { recursive: true, force: true }); } catch { /* best effort */ }
  return { removed: true, id: project.id };
}

/** Pinning hoists a project above the manual order (PRJ-07). */
function setPinned(id, pinned) {
  return update(id, { pinned: !!pinned });
}

/**
 * Manual ordering by drag and drop (PRJ-08). The incoming array is the new
 * visual order; it is written back as `sortOrder` so it survives restarts.
 */
function reorder(ids = []) {
  const list = loadAll();
  const wanted = ids.map(String).filter((id) => ID_RE.test(id));
  let cursor = 0;
  for (const id of wanted) {
    const project = list.find((p) => p.id === id);
    if (project) project.sortOrder = cursor++;
  }
  // Anything not named keeps its relative order after the named ones.
  for (const project of list) {
    if (!wanted.includes(project.id)) project.sortOrder = cursor++;
  }
  saveAll(list);
  return sortProjects(list).map(reduced);
}

/* ---------------------------------------------------------- knowledge base */

function safeName(input) {
  const name = path
    .basename(String(input ?? 'file'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
  return name || 'file';
}
function isTextual(name) {
  return TEXT_EXTENSIONS.has(path.extname(String(name)).toLowerCase());
}

/**
 * Add knowledge-base files. Each upload becomes an immutable blob, so
 * replacing a file later does not change what existing tasks see (PRJ-19).
 *
 * The metadata of every blob ever added to the project is kept in
 * `fileIndex`, because a task that froze an older file must still be able to
 * READ it after the file was replaced.
 */
function addFiles(id, files = []) {
  const list = loadAll();
  const index = list.findIndex((p) => p.id === id);
  if (index === -1) throw new Error('project not found');
  const project = list[index];
  project.fileIndex = project.fileIndex ?? {};
  const added = [];
  fs.mkdirSync(blobDir(project.id), { recursive: true });
  for (const entry of files) {
    const name = safeName(entry?.name);
    const buffer = toBuffer(entry?.content);
    if (!buffer) continue;
    if (buffer.length > MAX_FILE_BYTES) throw new Error(`file too large: ${name}`);
    const fileId = newBlobId();
    fs.writeFileSync(path.join(blobDir(project.id), fileId), buffer, { mode: 0o600 });
    const record = {
      id: fileId,
      name,
      size: buffer.length,
      mime: entry?.mime ? String(entry.mime).slice(0, 120) : null,
      addedAt: Date.now(),
    };
    project.fileIndex[fileId] = {
      name: record.name, size: record.size, mime: record.mime, addedAt: record.addedAt,
    };
    project.files = project.files.filter((f) => f.name !== name);
    project.files.push(record);
    added.push(record);
  }
  project.configVersion = (project.configVersion ?? 1) + 1;
  project.updatedAt = Date.now();
  list[index] = project;
  saveAll(list);
  return { project: reduced(project), added: added.map((f) => ({ id: f.id, name: f.name, size: f.size })) };
}

function toBuffer(content) {
  if (content == null) return null;
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (typeof content?.data === 'string') return Buffer.from(content.data, 'base64');
  return null;
}

/** Remove a file from the project's *current* set. Old snapshots keep it. */
function removeFile(id, fileId) {
  const list = loadAll();
  const index = list.findIndex((p) => p.id === id);
  if (index === -1) throw new Error('project not found');
  const project = list[index];
  const before = project.files.length;
  project.files = project.files.filter((f) => f.id !== fileId);
  if (project.files.length !== before) {
    project.configVersion = (project.configVersion ?? 1) + 1;
    project.updatedAt = Date.now();
  }
  list[index] = project;
  saveAll(list);
  return reduced(project);
}

function blobPath(projectId, fileId) {
  if (!ID_RE.test(String(projectId || ''))) throw new Error('invalid project id');
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(String(fileId || ''))) throw new Error('invalid file id');
  return path.join(blobDir(projectId), fileId);
}

/**
 * Read a knowledge-base file as text. Binary files are refused, not mangled.
 *
 * A file that was replaced but is still frozen in some task's snapshot stays
 * readable — the blob is immutable and its metadata lives in `fileIndex`.
 */
function readFile(id, fileId) {
  const project = raw(id);
  if (!project) throw new Error('project not found');
  const record = (project.files ?? []).find((f) => f.id === fileId)
    ?? (project.fileIndex ?? {})[fileId];
  if (!record) throw new Error('file not found in project');
  const buffer = fs.readFileSync(blobPath(project.id, fileId));
  return {
    id: fileId,
    name: record.name,
    size: record.size ?? buffer.length,
    text: isTextual(record.name) ? buffer.toString('utf8') : null,
    binary: !isTextual(record.name),
  };
}

/* ---------------------------------------------------------- config & tasks */

/**
 * Freeze the project's *file* set for a task. Called when a task is created
 * in a project (PRJ-05) or moved into one (PRJ-20).
 *
 * The snapshot is the file list only — the bytes stay in the immutable blob
 * store, so the snapshot is cheap and still exact.
 */
function snapshotFor(projectId) {
  const project = raw(projectId);
  if (!project) return null;
  return {
    projectId: project.id,
    takenAt: Date.now(),
    configVersion: project.configVersion ?? 1,
    files: (project.files ?? []).map((f) => ({
      id: f.id, name: f.name, size: f.size, mime: f.mime ?? null, addedAt: f.addedAt,
    })),
  };
}

/**
 * The effective configuration for a task:
 *
 *   - the instruction is LIVE (PRJ-18);
 *   - the files are the SNAPSHOT taken when the task joined the project
 *     (PRJ-19), falling back to the project's current set for a task that
 *     has never been snapshotted.
 */
function taskConfig(task = {}) {
  const projectId = task.projectId ?? null;
  if (!projectId) return null;
  const project = raw(projectId);
  if (!project) return null;
  const snapshot = task.projectConfigSnapshot ?? null;
  const files = snapshot?.files ?? (project.files ?? []);
  return {
    projectId,
    projectName: project.name,
    instruction: project.masterInstruction ?? '',
    files: files.map((f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime ?? null })),
    stale: !snapshot,
    snapshotAt: snapshot?.takenAt ?? null,
  };
}

/** The prompt block injected into every turn of a task inside a project. */
function promptBlock(task = {}) {
  const config = taskConfig(task);
  if (!config) return '';
  const parts = [];
  if (config.instruction.trim()) {
    parts.push(
      `You are working inside the project "${config.projectName}".\n`
      + 'Follow this master instruction for every task in this project:\n'
      + '"""\n'
      + config.instruction.trim()
      + '\n"""'
    );
  }
  if (config.files.length) {
    const lines = config.files.map((f) => `- ${f.name} (${f.size} bytes)`);
    parts.push(
      `Project knowledge base (${config.files.length} file${config.files.length === 1 ? '' : 's'}). `
      + 'Use the project_knowledge tool to list or read them:\n'
      + lines.join('\n')
    );
  }
  return parts.join('\n\n');
}

/** Inline textual knowledge files into the prompt, within a byte budget. */
function inlineText(task = {}, budget = INLINE_BYTE_BUDGET) {
  const config = taskConfig(task);
  if (!config || !config.files.length) return '';
  const chunks = [];
  let used = 0;
  for (const file of config.files) {
    if (used >= budget) break;
    if (!isTextual(file.name)) continue;
    let text = '';
    try {
      text = fs.readFileSync(blobPath(config.projectId, file.id), 'utf8');
    } catch {
      continue;
    }
    const room = budget - used;
    if (text.length > room) text = `${text.slice(0, room)}\n…(truncated)`;
    used += text.length;
    chunks.push(`--- ${file.name} ---\n${text}`);
  }
  return chunks.join('\n\n');
}

/* --------------------------------------------------------- collaborators */

function addCollaborator(id, { name, role = 'member' } = {}) {
  const list = loadAll();
  const index = list.findIndex((p) => p.id === id);
  if (index === -1) throw new Error('project not found');
  const project = list[index];
  const collaboratorId = String(name || '').trim().slice(0, 80);
  if (!collaboratorId) throw new Error('collaborator name required');
  project.collaborators = project.collaborators.filter((c) => c.id !== collaboratorId);
  project.collaborators.push({ id: collaboratorId, name: collaboratorId, role: String(role || 'member').slice(0, 40) });
  project.updatedAt = Date.now();
  list[index] = project;
  saveAll(list);
  return reduced(project);
}

function removeCollaborator(id, collaboratorId) {
  const list = loadAll();
  const index = list.findIndex((p) => p.id === id);
  if (index === -1) throw new Error('project not found');
  const project = list[index];
  project.collaborators = project.collaborators.filter((c) => c.id !== String(collaboratorId || ''));
  project.updatedAt = Date.now();
  list[index] = project;
  saveAll(list);
  return reduced(project);
}

/* ---------------------------------------------------------------- filters */

/**
 * The task filters from the Manus sidebar (PRJ-09..12).
 *
 *   - `all`         — every task, project tasks and standalone ones;
 *   - `standalone`  — only tasks that belong to no project;
 *   - `favorites`   — only tasks the user starred;
 *   - `scheduled`   — only tasks that have a scheduled automation attached.
 *
 * `sessionService` and `automationService` are injected by the caller to
 * keep this module free of cross-service imports (and of import cycles).
 */
function filterTasks(tasks = [], filter = 'all', { favorites = [], scheduledSessionIds = [] } = {}) {
  switch (filter) {
    case 'standalone':
      return tasks.filter((t) => !t.projectId);
    case 'favorites':
      return tasks.filter((t) => favorites.includes(t.id) || t.favorite === true);
    case 'scheduled':
      return tasks.filter((t) => scheduledSessionIds.includes(t.id));
    case 'all':
    default:
      return tasks.slice();
  }
}

/* --------------------------------------------------------------------- gc */

/**
 * Reclaim blobs no project lists and no task snapshot references.
 * Called opportunistically after file removals.
 */
function gc(snapshots = []) {
  const projects = loadAll();
  const live = new Set();
  for (const project of projects) {
    for (const file of project.files ?? []) live.add(`${project.id}/${file.id}`);
  }
  for (const snapshot of snapshots) {
    for (const file of snapshot?.files ?? []) live.add(`${snapshot.projectId}/${file.id}`);
  }
  let removed = 0;
  for (const project of projects) {
    let entries = [];
    try {
      entries = fs.readdirSync(blobDir(project.id));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!live.has(`${project.id}/${entry}`)) {
        try { fs.rmSync(path.join(blobDir(project.id), entry), { force: true }); removed += 1; } catch { /* ignore */ }
        // The metadata goes with it — otherwise the index would grow forever.
        if (project.fileIndex) delete project.fileIndex[entry];
      }
    }
  }
  if (removed) saveAll(projects);
  return { removed };
}

/* ---------------------------------------------------------------- exports */

module.exports = {
  projectService: {
    list() { return sortProjects(loadAll()).map(reduced); },
    get,
    create,
    update,
    remove,
    setPinned,
    reorder,
    addFiles,
    removeFile,
    readFile,
    snapshotFor,
    taskConfig,
    promptBlock,
    inlineText,
    addCollaborator,
    removeCollaborator,
    filterTasks,
    gc,
    // exposed for tests and for the session layer
    _raw: raw,
    _blobPath: blobPath,
    _isTextual: isTextual,
  },
};
