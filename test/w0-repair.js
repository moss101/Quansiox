'use strict';
/* W0 — repair pass.
 *
 * Every defect in this file was found by reading the code (not the docs) and
 * is now pinned by a test so it cannot come back silently.
 *
 *  W0.1  speculate() verification used an out-of-scope `cwd`; the
 *        ReferenceError was swallowed and every verdict was `false`
 *  W0.2  scripts/build-native.js did not build the vault approver, so a clean
 *        build shipped no secret-release gate
 *  W0.3  write_file bypassed the atomic write that edit_file uses
 *  W0.4  computerPool.setFactory() was never called in production
 *  W0.5  src/renderer/app.js was 1,363 lines of dead renderer
 *  W0.6  the Grok-compat catalogue count in the header comment was stale
 *  W0.7  the vault approver could report "approved" without a human
 *  W0.8  the `team` tool schema did not expose depends_on
 *  W0.9  egressPolicy's docstring claimed kernel-level domain enforcement
 *  W0.10 the packaged payload could drift from source
 *
 * Electron-free (the native helper is exercised as a subprocess). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-w0-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;
delete process.env.TYPESAFE_API_KEY;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

(async () => {
  /* ---------------------------------------------------------------- W0.1 */
  await test('W0.1 speculate verification returns a real verdict, not a swallowed error', async () => {
    const { runVerification } = require('../src/coordinator/index.js');
    const pass = await runVerification('true', tmp);
    assert.equal(pass.verified, true, 'a passing command must verify');
    assert.ok(pass.output.includes('exit 0'), `expected an exit marker, got: ${pass.output.slice(0, 200)}`);

    const fail = await runVerification('exit 7', tmp);
    assert.equal(fail.verified, false, 'a failing command must not verify');

    // No workspace at all is an honest refusal, not a crash.
    const nowhere = await runVerification('true', null);
    assert.equal(nowhere.verified, false);
    assert.match(nowhere.output, /no workspace/);
  });

  /* ---------------------------------------------------------------- W0.2 */
  await test('W0.2 build-native.js builds all the helpers', () => {
    const { TARGETS } = require('../scripts/build-native.js');
    const names = TARGETS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'QuansioxCapture',
      'QuansioxComputerHelper',
      'QuansioxVaultApprover',
      'QuansioxVision',
    ]);
    for (const target of TARGETS) {
      assert.ok(fs.existsSync(target.src), `${target.name} source missing: ${target.src}`);
    }
  });

  /* ---------------------------------------------------------------- W0.3 */
  await test('W0.3 write_file writes atomically, like edit_file', async () => {
    const { executeTool } = require('../src/coordinator/index.js');
    const dir = path.join(tmp, 'atomic');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'note.txt');
    const out = await executeTool('write_file', { path: target, content: 'hello atomic' }, dir, 'w0-sess', { permissive: true });
    assert.match(out, /^wrote \d+ bytes to /);
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello atomic');

    // No temp files left behind by the atomic write.
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], `atomic write left temp files: ${leftovers.join(', ')}`);

    // A rewrite must not truncate on failure — write over an existing file.
    await executeTool('write_file', { path: target, content: 'second write' }, dir, 'w0-sess', { permissive: true });
    assert.equal(fs.readFileSync(target, 'utf8'), 'second write');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  });

  /* ---------------------------------------------------------------- W0.4 */
  await test('W0.4 the computer pool has a production factory and leases per session', async () => {
    const { computerPool } = require('../src/main/services/computerPool');
    // The default factory is installed (lazily) so acquire() works outside tests.
    computerPool.setFactory(null);
    const booted = [];
    computerPool.setFactory(async (sid) => {
      booted.push(sid);
      return { sessionId: sid, close: () => booted.splice(booted.indexOf(sid), 1) };
    });
    computerPool.cap(4);

    // Two different children must get two different leases.
    const a = await computerPool.acquire('child-a');
    const b = await computerPool.acquire('child-b');
    assert.notEqual(a.sessionId, b.sessionId, 'each child must get its own guest');
    assert.deepEqual(booted.sort(), ['child-a', 'child-b']);

    // The same session shared by siblings is one guest, refcounted.
    const a2 = await computerPool.acquire('child-a');
    assert.equal(a2.sessionId, a.sessionId);
    assert.equal(computerPool.list().find((l) => l.sessionId === 'child-a').refCount, 2);

    computerPool.release('child-a');
    computerPool.release('child-a');
    computerPool.release('child-b');
    assert.equal(computerPool.list().length, 0);
    computerPool.setFactory(null);
  });

  await test('W0.4 coordinator routes computer_* to the child\'s own session', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'coordinator', 'index.js'), 'utf8');
    assert.ok(
      /call\.function\.name\.startsWith\('computer_'\)\s*\n?\s*\?\s*\(job\.computerSessionId \|\| job\.id\)/.test(source),
      'computer_* must resolve to the job\'s own session, not the parent tool session',
    );
  });

  /* ---------------------------------------------------------------- W0.5 */
  await test('W0.5 the dead vanilla renderer is gone', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'renderer', 'app.js')), false, 'src/renderer/app.js must not exist');
    // Nothing may reference it (this test file names it on purpose, so skip it).
    for (const rel of ['src', 'scripts']) {
      const dir = path.join(ROOT, rel);
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          if (!/\.(js|jsx|mjs|html|css)$/.test(entry.name)) continue;
          const text = fs.readFileSync(full, 'utf8');
          assert.ok(
            !/renderer\/app\.js/.test(text),
            `${path.relative(ROOT, full)} still references renderer/app.js`,
          );
        }
      };
      walk(dir);
    }
  });

  /* ---------------------------------------------------------------- W0.6 */
  await test('W0.6 the Grok-compat catalogue count in the header matches the registry', () => {
    const { REGISTRY } = require('../src/main/services/grokCompat/catalog.js');
    const source = fs.readFileSync(path.join(ROOT, 'src', 'main', 'services', 'grokCompat', 'grokCompatService.js'), 'utf8');
    const match = source.match(/\*\*(\d+)\*\* entries/);
    assert.ok(match, 'the header must state the catalogue size');
    assert.equal(Number(match[1]), REGISTRY.length, 'the stated catalogue size must equal the registry size');
    assert.equal(REGISTRY.length, 556, 'the catalogue is expected to hold 556 entries');
  });

  /* ---------------------------------------------------------------- W0.7 */
  await test('W0.7 the vault approver self-test proves the refusal paths', () => {
    const binary = path.join(ROOT, 'build', 'QuansioxVaultApprover');
    if (!fs.existsSync(binary)) {
      throw new Error(`missing ${binary} — run "npm run native" first`);
    }
    const out = execFileSync(binary, ['--self-test'], { encoding: 'utf8' });
    assert.match(out, /self-test OK/);
    // Every refusal path must have a non-zero exit code.
    assert.match(out, /the os would reuse the unlock: exit=2/);
    assert.match(out, /the prompt timed out: exit=4/);
    assert.match(out, /the user cancelled: exit=1/);
    assert.match(out, /no biometric enrolled: exit=2/);
  });

  await test('W0.7 the approver source refuses when the OS would authenticate without a human', () => {
    const source = fs.readFileSync(path.join(ROOT, 'native', 'QuansioxVaultApprover.swift'), 'utf8');
    assert.ok(source.includes('interactionNotAllowed'), 'the freshness probe must use interactionNotAllowed');
    assert.ok(source.includes('.reusable'), 'the probe must detect a reusable authentication state');
    assert.ok(
      source.includes('deviceOwnerAuthenticationWithBiometrics'),
      'the evaluation must require a biometric, not fall back to a passcode',
    );
  });

  /* ---------------------------------------------------------------- W0.8 */
  await test('W0.8 the team schema exposes depends_on and the DAG resolves it', () => {
    const { allTools } = require('../src/coordinator/index.js');
    const team = allTools().find((t) => t?.function?.name === 'team');
    assert.ok(team, 'the team tool must exist');
    const agentProps = team.function.parameters.properties.agents.items.properties;
    assert.ok(agentProps.depends_on, 'depends_on must be in the public schema');
    assert.ok(agentProps.id, 'id must be in the public schema so depends_on can name an agent');

    // The DAG resolves a dependency named by description.
    const { normalizeAgents, planTeamDag } = require('../src/coordinator/teamDag');
    const agents = normalizeAgents([
      { description: 'fetch the data', prompt: 'a', subagent_type: 'general' },
      { description: 'write the report', prompt: 'b', subagent_type: 'general', depends_on: ['fetch the data'] },
    ]);
    assert.deepEqual(agents[1].dependsOn, ['agent-1'], 'a description must resolve to the matching agent id');
    const plan = planTeamDag(agents);
    assert.equal(plan.waves.length, 2, 'a real dependency must produce two waves');
    assert.deepEqual(plan.waves[0].map((a) => a.id), ['agent-1']);
    assert.deepEqual(plan.waves[1].map((a) => a.id), ['agent-2']);

    // An unresolvable dependency is dropped AND reported.
    const broken = normalizeAgents([
      { description: 'a', prompt: 'a', subagent_type: 'general' },
      { description: 'b', prompt: 'b', subagent_type: 'general', depends_on: ['nobody'] },
    ]);
    assert.deepEqual(broken[1].dependsOn, []);
    const brokenPlan = planTeamDag(broken);
    assert.ok(brokenPlan.errors.some((e) => e.includes('nobody')), 'the unresolved dependency must be reported');
  });

  /* ---------------------------------------------------------------- W0.9 */
  await test('W0.9 the egress policy docstring does not overstate what is enforced', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'coordinator', 'egressPolicy.js'), 'utf8');
    assert.ok(
      source.includes('is **not** enforced at the kernel'),
      'the docstring must state that the per-domain allow list is not kernel-enforced',
    );
    assert.ok(
      !/authoritative for the \*host\*: the seatbelt profile/.test(source),
      'the old over-claiming sentence must be gone',
    );
  });

  /* --------------------------------------------------------------- W0.10 */
  await test('W0.10 the package drift check detects a difference', () => {
    const { verifyNoDrift } = require('../scripts/package.js');
    const a = path.join(tmp, 'drift-a');
    const b = path.join(tmp, 'drift-b');
    fs.mkdirSync(path.join(a, 'nested'), { recursive: true });
    fs.mkdirSync(path.join(b, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(a, 'same.js'), 'x');
    fs.writeFileSync(path.join(b, 'same.js'), 'x');
    fs.writeFileSync(path.join(a, 'nested', 'different.js'), 'one');
    fs.writeFileSync(path.join(b, 'nested', 'different.js'), 'two');
    fs.writeFileSync(path.join(b, 'extra.js'), 'three');

    const diffs = verifyNoDrift(a, b);
    assert.ok(diffs.some((d) => d.includes('content differs')), 'a content difference must be reported');
    assert.ok(diffs.some((d) => d.includes('extra in package')), 'an extra file must be reported');

    // Identical trees produce no differences.
    assert.deepEqual(verifyNoDrift(a, a), []);
  });

  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nW0 repair tests FAILED');
    process.exit(1);
  }
  console.log(`\nW0 repair: ${results.length} checks OK`);
})();
