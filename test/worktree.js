'use strict';
/* Git worktree isolation — isolated subagents can get a private checkout of the
 * workspace repo so parallel edits do not collide, while sharing objects. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-worktree-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-worktree-userdata-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const Module = require('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return require.resolve('./stub-electron.js');
  return origResolve.call(this, request, ...rest);
};

const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' })?.trim();

(async () => {
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);

  const { settingsService } = require('../src/main/services/settingsService');
  settingsService.save({ workspaceRoot: repo });
  const { gitService } = require('../src/main/services/gitService');

  assert.equal(await gitService.isRepo(), true);
  const wt = path.join(repo, '.git', 'qx-worktrees', 'sub-a');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  await gitService.worktreeAdd(wt);
  assert.ok(fs.existsSync(path.join(wt, 'README.md')), 'worktree has the base checkout');

  // isolated edits stay out of the main working tree
  fs.writeFileSync(path.join(wt, 'agent.txt'), 'from child\n');
  assert.equal(fs.existsSync(path.join(repo, 'agent.txt')), false, 'main tree untouched');
  assert.equal(git(['status', '--porcelain'], wt).includes('agent.txt'), true, 'child change is in its worktree');
  assert.equal(git(['status', '--porcelain']), '', 'parent tree stays clean');

  // HEAD is shared: a commit in the parent is visible to the worktree
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'parent\n');
  git(['add', 'shared.txt']);
  git(['commit', '-q', '-m', 'parent commit']);
  assert.equal(fs.existsSync(path.join(wt, 'shared.txt')), false, 'worktree keeps its own snapshot until updated');

  const list = await gitService.worktreeList();
  assert.ok(list.some((w) => w.path === fs.realpathSync(wt)), 'worktree list includes the child checkout');
  assert.ok(list.some((w) => w.path === fs.realpathSync(repo)), 'worktree list includes the main checkout');

  const realWt = fs.realpathSync(wt);
  // removal is explicit (the child's work must not vanish silently)
  assert.equal(await gitService.worktreeRemove(wt), true);
  assert.equal(fs.existsSync(wt), false);
  const after = await gitService.worktreeList();
  assert.ok(!after.some((w) => w.path === realWt));

  // the parent commit is intact
  assert.equal(git(['log', '--oneline', '-1']).includes('parent commit'), true);

  console.log('worktree test: ALL OK (add/list/remove + isolation)');
})().catch((e) => { console.error(e); process.exit(1); });
