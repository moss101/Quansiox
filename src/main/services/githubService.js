'use strict';
/**
 * GitHub connector (SCM) — real GitHub operations via the `gh` CLI (no HTTP/keys
 * baked in; gh holds its own auth). The command runner is injectable so this is
 * testable in plain Node and honours a missing/unauthenticated `gh` gracefully
 * (status.installed / status.authed), never faking a response.
 *
 * Real prerequisite (flagged, not faked): the user must have `gh` installed and
 * `gh auth login` completed. Credentials pulled through gh, not stored here.
 */
const DEFAULT_RUN = (args) => new Promise((resolve) => {
  require('node:child_process').execFile('gh', args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

let run = DEFAULT_RUN;

function setRunner(fn) { run = typeof fn === 'function' ? fn : DEFAULT_RUN; }
function ghInstalled() {
  try {
    require('node:child_process').execFileSync('gh', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch { return false; }
}

async function status() {
  const ver = await run(['--version']);
  if (ver.code !== 0) return { installed: false, authed: false, hint: 'install the GitHub CLI (gh): https://cli.github.com' };
  const r = await run(['auth', 'status']);
  const authed = r.code === 0;
  const m = /Logged in to github\.com account (\S+)/.exec(`${r.stdout}\n${r.stderr}`);
  return { installed: true, authed, account: authed ? (m?.[1] ?? null) : null, hint: authed ? null : 'run: gh auth login' };
}

/** Current repo from the workspace, else an explicit owner/name. */
function repoSpec(repo) {
  if (repo) return repo;
  try {
    const { execFileSync } = require('node:child_process');
    const { settingsService } = require('./settingsService');
    const root = settingsService.load().workspaceRoot || process.cwd();
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

function requireRepo(repo) { const r = repoSpec(repo); if (!r) throw new Error('no GitHub repo (pass owner/name or set an origin remote)'); return r; }

async function prList({ repo, state = 'open', limit = 20 } = {}) {
  const st = await status();
  if (!st.authed) throw new Error(st.hint || 'gh not authenticated');
  const r = await run(['pr', 'list', '--repo', requireRepo(repo), '--state', state, '--limit', String(limit), '--json', 'number,title,headRefName,baseRefName,state,url']);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh pr list failed`);
  return JSON.parse(r.stdout || '[]');
}
async function prView({ repo, number } = {}) {
  const st = await status();
  if (!st.authed) throw new Error(st.hint || 'gh not authenticated');
  const r = await run(['pr', 'view', String(number), '--repo', requireRepo(repo), '--json', 'number,title,body,state,headRefName,baseRefName,url,additions,deletions']);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh pr view failed`);
  return JSON.parse(r.stdout);
}
async function prCreate({ repo, title, body = '', base = '', head = '', draft = false } = {}) {
  const st = await status();
  if (!st.authed) throw new Error(st.hint || 'gh not authenticated');
  if (!String(title || '').trim()) throw new Error('a PR needs a title');
  const args = ['pr', 'create', '--repo', requireRepo(repo), '--title', String(title), '--body', String(body)];
  if (base) args.push('--base', String(base));
  if (head) args.push('--head', String(head));
  if (draft) args.push('--draft');
  const r = await run(args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh pr create failed`);
  const url = (r.stdout.trim().match(/https?:\/\/\S+/) || [])[0] || null;
  return { url };
}
async function repoView({ repo } = {}) {
  const st = await status();
  if (!st.authed) throw new Error(st.hint || 'gh not authenticated');
  const r = await run(['repo', 'view', requireRepo(repo), '--json', 'name,nameWithOwner,description,defaultBranchRef,url,isPrivate']);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh repo view failed`);
  return JSON.parse(r.stdout);
}
async function issueList({ repo, state = 'open', limit = 20 } = {}) {
  const st = await status();
  if (!st.authed) throw new Error(st.hint || 'gh not authenticated');
  const r = await run(['issue', 'list', '--repo', requireRepo(repo), '--state', state, '--limit', String(limit), '--json', 'number,title,state,url']);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh issue list failed`);
  return JSON.parse(r.stdout || '[]');
}

module.exports = { githubService: { status, prList, prView, prCreate, repoView, issueList, setRunner, ghInstalled, repoSpec } };
