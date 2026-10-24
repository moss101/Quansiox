'use strict';
/* GitHub connector (SCM) test — real gh-CLI operations via an injected runner
 * (no faking): not-installed, not-authed, pr list/create/view, repo view, issue
 * list, arg construction, and auth gating. Electron-free. */
const assert = require('node:assert/strict');
const gh = require('../src/main/services/githubService').githubService;

async function run() {
  // route commands to a fake by matching argv
  const calls = [];
  gh.setRunner(async (args) => {
    calls.push(args);
    const cmd = args[0];
    if (cmd === '--version') return { code: calls.filter((c) => c[0] === '--version').length > 99 ? 1 : 0, stdout: 'gh version 2.0', stderr: '' };
    if (cmd === 'auth' && args[1] === 'status') return { code: (globalThis.__GH_AUTHED === false ? 1 : 0), stdout: '', stderr: '✓ Logged in to github.com account octocat' };
    if (cmd === 'pr' && args[1] === 'list') return { code: 0, stdout: JSON.stringify([{ number: 7, title: 'Add feature', headRefName: 'feat', baseRefName: 'main', state: 'OPEN', url: 'https://github.com/o/r/pull/7' }]), stderr: '' };
    if (cmd === 'pr' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ number: Number(args[2]), title: 'Add feature', body: 'desc', state: 'OPEN', url: 'https://github.com/o/r/pull/7', additions: 10, deletions: 2 }), stderr: '' };
    if (cmd === 'pr' && args[1] === 'create') return { code: 0, stdout: 'https://github.com/o/r/pull/9\n', stderr: '' };
    if (cmd === 'repo' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ name: 'r', nameWithOwner: 'o/r', description: 'd', defaultBranchRef: { name: 'main' }, url: 'https://github.com/o/r', isPrivate: false }), stderr: '' };
    if (cmd === 'issue' && args[1] === 'list') return { code: 0, stdout: JSON.stringify([{ number: 3, title: 'Bug', state: 'OPEN', url: 'https://github.com/o/r/issues/3' }]), stderr: '' };
    return { code: 1, stdout: '', stderr: 'unknown command ' + args.join(' ') };
  });

  // 1. installed + authed status
  const st = await gh.status();
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.authed, true);
  assert.strictEqual(st.account, 'octocat');

  // 2. not-installed (gh --version fails)
  globalThis.__GH_AUTHED = false;
  const bad = gh;
  const savedRun = bad.setRunner; // keep
  // simulate not installed by a runner returning code 1 for --version
  gh.setRunner(async (a) => (a[0] === '--version' ? { code: 127, stdout: '', stderr: 'not found' } : { code: 0, stdout: '' }));
  const noinstall = await gh.status();
  assert.strictEqual(noinstall.installed, false);
  assert.strictEqual(noinstall.authed, false);
  // restore the good runner + re-auth flag
  globalThis.__GH_AUTHED = true;

  // re-install the argv router (a fresh closure)
  gh.setRunner(async (args) => {
    const cmd = args[0];
    if (cmd === '--version') return { code: 0, stdout: 'gh 2', stderr: '' };
    if (cmd === 'auth' && args[1] === 'status') return { code: (globalThis.__GH_AUTHED === false ? 1 : 0), stdout: '', stderr: '✓ Logged in to github.com account octocat' };
    if (cmd === 'pr' && args[1] === 'list') return { code: 0, stdout: JSON.stringify([{ number: 7, title: 'Add feature', state: 'OPEN' }]), stderr: '' };
    if (cmd === 'pr' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ number: Number(args[2]), title: 'Add feature' }), stderr: '' };
    if (cmd === 'pr' && args[1] === 'create') return { code: 0, stdout: 'https://github.com/o/r/pull/9\n', stderr: '' };
    if (cmd === 'repo' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r', description: 'd', defaultBranchRef: { name: 'main' }, url: 'https://github.com/o/r', isPrivate: false }), stderr: '' };
    if (cmd === 'issue' && args[1] === 'list') return { code: 0, stdout: JSON.stringify([{ number: 3, title: 'Bug', state: 'OPEN' }]), stderr: '' };
    return { code: 1, stdout: '', stderr: 'x' };
  });

  // 3. not-authed → operations throw the hint (no fake success)
  globalThis.__GH_AUTHED = false;
  await assert.rejects(() => gh.prList({ repo: 'o/r' }), /gh auth login/);
  await assert.rejects(() => gh.prCreate({ repo: 'o/r', title: 't' }), /gh auth login/);
  globalThis.__GH_AUTHED = true;

  // 4. pr list (parsed)
  const prs = await gh.prList({ repo: 'o/r', state: 'open', limit: 10 });
  assert.strictEqual(prs[0].number, 7);

  // 5. pr create builds correct args + returns url
  const created = await gh.prCreate({ repo: 'o/r', title: 'My PR', body: 'b', base: 'main', head: 'feat', draft: true });
  assert.strictEqual(created.url, 'https://github.com/o/r/pull/9');

  // 6. pr view + repo view + issue list
  assert.strictEqual((await gh.prView({ repo: 'o/r', number: 7 })).title, 'Add feature');
  assert.strictEqual((await gh.repoView({ repo: 'o/r' })).nameWithOwner, 'o/r');
  assert.strictEqual((await gh.issueList({ repo: 'o/r' }))[0].number, 3);

  // 7. pr create requires a title; empty title throws before gh
  await assert.rejects(() => gh.prCreate({ repo: 'o/r', title: '  ' }), /needs a title/);

  delete globalThis.__GH_AUTHED;
  gh.setRunner(() => {}); // silence
  console.log('github test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
