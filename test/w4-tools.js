'use strict';
/* W4 — tool and execution depth.
 *
 *  W4.1  the flat tool family reports its truncation precisely
 *  W4.2  both tool families are offered and dispatched
 *  W4.3  MCP arguments can reference a file instead of inlining it
 *  W4.4  the hook points exist and a hook can veto, rewrite and add context
 *  W4.5  a per-domain egress allow-list is enforced by the proxy
 *  W4.6  the sandbox policy is rich and turns into a profile
 *  W4.7  secret values are masked out of tool output
 *  W4.8  conversation search says when it is rebuilding
 *  W4.9  the model reviewer proposes an allow rule
 *
 * Electron-free (the proxy and the sandbox are exercised as real processes). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-w4-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

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

const flat = require('../src/coordinator/flatTools');
const hooks = require('../src/coordinator/hooks');
const sandboxPolicy = require('../src/shared/sandboxPolicy');
const { seatbeltProfile } = require('../src/exec-daemon/seatbelt');
const { proxySeatbeltProfile, hostAllowed, startEgressProxy, proxyEnv } = require('../src/exec-daemon/egressProxy');
const { mcpService } = require('../src/main/services/mcpService');
const { secretsService } = require('../src/main/services/secretsService');
const conversationSearch = require('../src/main/services/conversationSearchService');
const { sessionService } = require('../src/main/services/sessionService');
const coordinator = require('../src/coordinator/index');

(async () => {
  /* ---------------------------------------------------------------- W4.1 */
  await test('W4.1 the flat family reports truncation precisely', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const result = flat.truncate(long, { maxLines: 10 });
    assert.equal(result.truncation.truncated, true);
    assert.equal(result.truncation.truncated_by, 'lines');
    assert.equal(result.truncation.total_lines, 50);
    assert.equal(result.truncation.output_lines, 10);
    assert.equal(result.truncation.last_line_partial, true);
  });

  await test('W4.1 a short result is not marked as truncated', () => {
    const result = flat.truncate('one\ntwo', { maxLines: 10 });
    assert.equal(result.truncation.truncated, false);
    assert.equal(result.truncation.total_lines, 2);
  });

  await test('W4.1 pi_read reports the range it returned', () => {
    const file = path.join(tmp, 'flat-read.txt');
    fs.writeFileSync(file, 'a\nb\nc\nd\ne\n');
    const result = flat.piRead({ path: file, offset: 1, limit: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'b\nc');
    assert.equal(result.totalLines, 5);
    assert.equal(result.offset, 1);
  });

  await test('W4.1 pi_write is atomic and pi_edit returns a diff', () => {
    const file = path.join(tmp, 'flat-write.txt');
    const written = flat.piWrite({ path: file, content: 'one\n' });
    assert.equal(written.ok, true);
    assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.includes('.tmp')), [], 'no temp file may be left behind');

    const edited = flat.piEdit({ path: file, edits: [{ old_string: 'one', new_string: 'two' }] });
    assert.equal(edited.ok, true);
    assert.match(edited.diff, /-one/);
    assert.match(edited.diff, /\+two/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'two\n');
  });

  await test('W4.1 a write-shaped tool can be rejected', () => {
    const file = path.join(tmp, 'flat-ambiguous.txt');
    fs.writeFileSync(file, 'x\nx\n');
    const rejected = flat.piEdit({ path: file, edits: [{ old_string: 'x', new_string: 'y' }] });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.rejected, true);
    assert.match(rejected.reason, /not unique/);
    // A read-shaped tool does not have a rejected form.
    const read = flat.piRead({ path: file });
    assert.equal(read.ok, true);
  });

  await test('W4.1 pi_grep and pi_find report their limits', () => {
    const dir = path.join(tmp, 'flat-dir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'alpha.txt'), 'needle here');
    fs.writeFileSync(path.join(dir, 'beta.txt'), 'nothing');
    const grep = flat.piGrep({ pattern: 'needle', path: dir });
    assert.equal(grep.ok, true);
    assert.match(grep.output, /alpha\.txt/);
    const find = flat.piFind({ pattern: 'alpha', path: dir });
    assert.match(find.output, /alpha\.txt/);
  });

  /* ---------------------------------------------------------------- W4.2 */
  await test('W4.2 both tool families are offered to the model', () => {
    const names = coordinator.allTools().map((t) => t.function.name);
    for (const rich of ['shell', 'read_file', 'write_file', 'edit_file', 'glob_files']) {
      assert.ok(names.includes(rich), `${rich} (the rich family) must be offered`);
    }
    for (const flatName of ['pi_bash', 'pi_read', 'pi_write', 'pi_edit', 'pi_grep', 'pi_find', 'pi_ls']) {
      assert.ok(names.includes(flatName), `${flatName} (the flat family) must be offered`);
    }
  });

  /* ---------------------------------------------------------------- W4.3 */
  await test('W4.3 an MCP argument can reference a file instead of inlining it', () => {
    const file = path.join(tmp, 'mcp-payload.txt');
    fs.writeFileSync(file, 'the file contents');
    const expanded = mcpService.expandSymbolicPaths({ body: `$file:${file}`, other: 'plain' });
    assert.equal(expanded.args.body, 'the file contents');
    assert.equal(expanded.args.other, 'plain');
    assert.equal(expanded.expanded.length, 1);
    assert.equal(expanded.expanded[0].bytes, 17);
    assert.ok(expanded.expanded[0].sha256);
  });

  await test('W4.3 a symbolic path that cannot be read is skipped, not fatal', () => {
    const expanded = mcpService.expandSymbolicPaths({ body: '$file:/no/such/file' });
    assert.equal(expanded.skipped.length, 1);
    assert.equal(expanded.args.body, '$file:/no/such/file', 'the reference is left as it was');
  });

  /* ---------------------------------------------------------------- W4.4 */
  await test('W4.4 every hook point is declared', () => {
    for (const name of [
      'beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought',
      'preToolUse', 'postToolUse', 'postToolUseFailure',
      'beforeShellExecution', 'afterShellExecution',
      'beforeMCPExecution', 'afterMCPExecution',
      'beforeReadFile', 'afterFileEdit', 'beforeTabFileRead', 'afterTabFileEdit',
      'preCompact', 'subagentStart', 'subagentStop', 'stop',
      'sessionStart', 'sessionEnd', 'workspaceOpen',
    ]) {
      assert.ok(hooks.HOOK_NAMES.includes(name), `${name} must be a hook point`);
    }
    assert.equal(hooks.HOOK_NAMES.length, 21);
  });

  await test('W4.4 a hook can veto, rewrite and add context', async () => {
    hooks.clear();
    hooks.register(hooks.HOOK.PRE_TOOL_USE, async () => ({ permission: 'deny', agent_message: 'not allowed here' }));
    const denied = await hooks.run(hooks.HOOK.PRE_TOOL_USE, { tool: 'shell' });
    assert.equal(denied.permission, 'deny');
    assert.match(denied.agent_message, /not allowed here/);

    hooks.clear();
    hooks.register(hooks.HOOK.PRE_TOOL_USE, async () => ({
      permission: 'allow',
      updated_input: { command: 'echo rewritten' },
      additional_context: 'the workspace is /srv',
    }));
    const allowed = await hooks.run(hooks.HOOK.PRE_TOOL_USE, { tool: 'shell' });
    assert.equal(allowed.permission, 'allow');
    assert.equal(allowed.updated_input.command, 'echo rewritten');
    assert.match(allowed.additional_context, /\/srv/);
    hooks.clear();
  });

  await test('W4.4 a broken hook is disabled and reported, not fatal', async () => {
    hooks.clear();
    let calls = 0;
    hooks.register(hooks.HOOK.PRE_TOOL_USE, async () => { calls += 1; throw new Error('boom'); });
    const first = await hooks.run(hooks.HOOK.PRE_TOOL_USE, { tool: 'shell' });
    assert.equal(first.errors.length, 1);
    assert.match(first.errors[0].error, /boom/);
    const second = await hooks.run(hooks.HOOK.PRE_TOOL_USE, { tool: 'shell' });
    assert.equal(second.errors.length, 0, 'a broken hook must not be called again');
    assert.equal(calls, 1);
    hooks.clear();
  });

  await test('W4.4 an unknown hook point is refused', () => {
    hooks.clear();
    assert.throws(() => hooks.register('notAHook', async () => ({})), /unknown hook point/);
  });

  /* ---------------------------------------------------------------- W4.5 */
  await test('W4.5 the allow-list wins over the default and the deny-list wins over both', () => {
    const policy = { allow: ['api.example.com'], deny: ['evil.example.com'], default: 'deny' };
    assert.equal(hostAllowed(policy, 'api.example.com').allowed, true);
    assert.equal(hostAllowed(policy, 'sub.api.example.com').allowed, true, 'a subdomain of an allowed host is allowed');
    assert.equal(hostAllowed(policy, 'evil.example.com').allowed, false);
    assert.equal(hostAllowed(policy, 'other.example.net').allowed, false);
  });

  await test('W4.5 the proxy refuses a host that is not on the list, and forwards one that is', async () => {
    // A real local server stands in for the allowed host.
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('allowed'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const proxy = await startEgressProxy({ allow: ['127.0.0.1'], deny: [], defaultAction: 'deny' });
    try {
      const allowed = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${port}/ok` }, (res) => {
          let body = '';
          res.on('data', (d) => { body += d; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
      });
      assert.equal(allowed.status, 200, 'an allowed host must be reachable');
      assert.equal(allowed.body, 'allowed');

      const denied = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: proxy.port, path: 'http://not-allowed.example.net/' }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode }));
        }).on('error', reject);
      });
      assert.equal(denied.status, 403, 'a host that is not on the list must be refused');
    } finally {
      proxy.close();
      server.close();
    }
  });

  await test('W4.5 the sandbox profile pins the network to the proxy', () => {
    const base = seatbeltProfile({ workspace: tmp, allowNetwork: true });
    const pinned = proxySeatbeltProfile(base);
    assert.match(pinned, /remote ip "localhost:\*"/);
    assert.equal(/allow network\*/.test(pinned), false, 'the open network must be gone');
    // The profile must be one sandbox-exec accepts.
    assert.equal(/\(remote ip "(?!localhost)/.test(pinned), false, 'SBPL only accepts * or localhost');
  });

  await test('W4.5 the proxy environment points the command at it', () => {
    const env = proxyEnv(1234);
    assert.equal(env.http_proxy, 'http://127.0.0.1:1234');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1234');
    assert.match(env.no_proxy, /localhost/);
  });

  /* ---------------------------------------------------------------- W4.6 */
  await test('W4.6 the sandbox policy is rich and normalizes', () => {
    const policy = sandboxPolicy.normalizePolicy({
      type: 'workspace_readwrite',
      readBoundary: 'workspace',
      networkPolicy: { defaultAction: 'deny', allow: ['a.example'], deny: ['b.example'] },
      networkPolicyStrict: true,
      captureDenies: true,
      disableTmpWrite: true,
      additionalReadwritePaths: ['/tmp/x'],
      additionalReadonlyPaths: ['/etc'],
    });
    assert.equal(policy.type, sandboxPolicy.TYPE.WORKSPACE_READWRITE);
    assert.equal(policy.readBoundary, sandboxPolicy.READ_BOUNDARY.WORKSPACE);
    assert.equal(policy.networkPolicy.allow[0], 'a.example');
    assert.equal(policy.networkPolicyStrict, true);
    assert.equal(policy.captureDenies, true);
    assert.equal(policy.disableTmpWrite, true);
  });

  await test('W4.6 a policy turns into a seatbelt profile', () => {
    const policy = sandboxPolicy.normalizePolicy({ type: 'workspace_readwrite' });
    const profile = sandboxPolicy.policyToSeatbelt({ policy, workspace: tmp });
    assert.match(profile, /\(version 1\)/);
    assert.match(profile, /\(deny default\)/);
    assert.match(profile, /file-write\*/);
  });

  await test('W4.6 an insecure policy is honestly insecure', () => {
    const profile = sandboxPolicy.policyToSeatbelt({
      policy: sandboxPolicy.normalizePolicy({ type: 'insecure_none' }),
      workspace: tmp,
    });
    assert.match(profile, /allow default/);
  });

  /* ---------------------------------------------------------------- W4.7 */
  await test('W4.7 a stored secret value is masked out of text', () => {
    secretsService.set('w4test', { token: 'super-secret-value-1234' });
    const { text, redacted } = secretsService.redact('the token is super-secret-value-1234 here');
    assert.equal(redacted, 1);
    assert.equal(text.includes('super-secret-value-1234'), false, 'the secret must not survive');
    assert.match(text, /•••/);
    // Unrelated text is untouched.
    const clean = secretsService.redact('nothing secret here');
    assert.equal(clean.redacted, 0);
    assert.equal(clean.text, 'nothing secret here');
  });

  /* ---------------------------------------------------------------- W4.8 */
  await test('W4.8 conversation search finds a turn and says when it is rebuilding', () => {
    sessionService.ensure('w4-search-session');
    sessionService.appendTurn('w4-search-session', { role: 'user', content: 'the quokka is a marsupial' });
    const found = conversationSearch.search({ query: 'quokka' });
    assert.ok(found.hits.length >= 1, 'the turn must be found');
    assert.match(found.hits[0].preview, /quokka/);
    assert.equal(typeof found.rebuilding, 'boolean');
    assert.equal(typeof found.partial, 'boolean');
  });

  await test('W4.8 a rebuild is announced', async () => {
    await conversationSearch.rebuild();
    const status = conversationSearch.status();
    assert.ok(status.builtAt > 0);
    assert.equal(status.building, false);
  });

  /* ---------------------------------------------------------------- W4.9 */
  await test('W4.9 the model reviewer can propose an allow rule', async () => {
    const autoReview = require('../src/coordinator/autoReviewClassifier');
    const verdict = await autoReview.reviewWithModel({
      action: { tool: 'shell', arguments: { command: 'git status' } },
      rules: { allowInstructions: [], blockInstructions: [] },
      complete: async () => JSON.stringify({
        decision: 'allow',
        reason: 'read-only git command',
        proposedAllowRule: '/^git (status|diff|log)$/',
      }),
    });
    assert.equal(verdict.decision, 'allow');
    assert.equal(verdict.proposedAllowRule, '/^git (status|diff|log)$/');
  });

  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nW4 tool-depth tests FAILED');
    process.exit(1);
  }
  console.log(`\nW4 tool depth: ${results.length} checks OK`);
})();
