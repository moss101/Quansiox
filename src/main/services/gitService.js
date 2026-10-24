'use strict';
/**
 * Git service — workspace repo operations via execFile('git').
 * Powers the Git panel (status/diff/commit) and agent checkpoints
 * (auto-commit before each agent turn so agent changes are undoable).
 */
const { execFile } = require('node:child_process');
const { settingsService } = require('./settingsService');

function git(args, { cwd, maxBuffer = 10 * 1024 * 1024 } = {}) {
  const root = cwd || settingsService.load().workspaceRoot || process.cwd();
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message).trim();
        reject(new Error(message || `git ${args[0]} failed`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function root() {
  return settingsService.load().workspaceRoot || process.cwd();
}

async function isRepo() {
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/** Parse `git status --porcelain=v1 -z` into structured entries. */
async function status() {
  if (!(await isRepo())) return { repo: false, branch: null, entries: [] };
  const [raw, branch] = await Promise.all([
    git(['status', '--porcelain=v1', '-z']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD'),
  ]);
  const entries = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    // Format: XY <path> or XY <path>\0<renamed-from> (rename has \0 inside)
    const xy = record.slice(0, 2);
    let p = record.slice(3);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    entries.push({
      index: xy[0] === ' ' ? null : xy[0],
      worktree: xy[1] === ' ' ? null : xy[1],
      path: p,
    });
  }
  return { repo: true, branch: branch.trim(), entries };
}

/** Unified diff; `staged` selects --cached. */
async function diff({ staged = false, pathspec } = {}) {
  const args = ['diff', '--no-color', '--unified=3'];
  if (staged) args.push('--cached');
  if (pathspec) args.push('--', pathspec);
  return git(args);
}

async function stage(paths) {
  return git(['add', '--', ...(Array.isArray(paths) ? paths : [paths])]);
}

async function unstage(paths) {
  return git(['reset', 'HEAD', '--', ...(Array.isArray(paths) ? paths : [paths])]);
}

async function commit(message) {
  const clean = String(message).replace(/["`$\\]/g, '').slice(0, 200);
  if (!clean.trim()) throw new Error('empty commit message');
  await git(['commit', '-m', clean]);
  return (await git(['rev-parse', '--short', 'HEAD'])).trim();
}

async function discard(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  await git(['checkout', '--', ...list]);
  return true;
}

/** Recent commits: [{hash, subject, date, author}] */
async function log(limit = 30) {
  const raw = await git([
    'log', `-n`, String(limit), '--pretty=format:%h%x1f%s%x1f%ad%x1f%an%x1e', '--date=short',
  ]);
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, date, author] = r.split('\x1f');
      return { hash, subject, date, author };
    });
}

/**
 * Agent checkpoint: snapshot all changes before an agent turn. Creates the
 * repo on first use inside a workspace without one (opt-in via settings).
 * Returns {committed: bool, hash} — skipped silently when autoCheckpoint is off.
 */
async function checkpoint(taskSummary) {
  const settings = settingsService.load();
  if (!settings.autoCheckpoint) return { committed: false, reason: 'disabled' };
  if (!(await isRepo())) {
    if (!settings.autoInitRepo) return { committed: false, reason: 'no-repo' };
    await git(['init', '--quiet']);
  }
  const statusResult = await status();
  if (!statusResult.entries.length) return { committed: false, reason: 'clean' };
  const subject = String(taskSummary ?? 'agent turn').slice(0, 60).replace(/["`$\\]/g, '');
  await git(['add', '-A']);
  await git(['commit', '-m', `quansiox checkpoint: before "${subject}"`, '--quiet']);
  return { committed: true, hash: (await git(['rev-parse', '--short', 'HEAD'])).trim() };
}

/**
 * Add a detached worktree at `dir` from `ref` (default HEAD). Used to give an
 * isolated subagent a real private checkout while sharing the object store.
 */
async function worktreeAdd(dir, { cwd, ref = 'HEAD' } = {}) {
  const target = String(dir || '').trim();
  if (!target) throw new Error('worktree path is required');
  await git(['worktree', 'add', '--detach', target, ref], { cwd });
  return target;
}

async function worktreeRemove(dir, { cwd, force = true } = {}) {
  const target = String(dir || '').trim();
  if (!target) return false;
  await git(['worktree', 'remove', ...(force ? ['--force'] : []), target], { cwd });
  return true;
}

async function worktreeList({ cwd } = {}) {
  const out = await git(['worktree', 'list', '--porcelain'], { cwd });
  return String(out).trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const row = {};
    for (const line of block.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp === -1) row[line] = true;
      else row[line.slice(0, sp)] = line.slice(sp + 1);
    }
    return { path: row.worktree, head: row.HEAD || null, branch: row.branch ? String(row.branch).replace('refs/heads/', '') : null, detached: !!row.detached, bare: !!row.bare };
  });
}

module.exports = {
  gitService: {
    isRepo, status, diff, stage, unstage, commit, discard, log, checkpoint,
    worktreeAdd, worktreeRemove, worktreeList,
  },
};
