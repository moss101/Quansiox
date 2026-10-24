'use strict';
/* Memory test — local long-term memory: remember/recall/list/forget, dedupe,
 * keyword recall ranking, 0600, the system-prompt injection shape (guarded +
 * unchanged when empty), read-only gating of `remember`, and compat routing.
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mem-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const memory = require('../src/main/services/memoryService').memoryService;
const { guardTool } = require('../src/coordinator/permissions');

// ---- store ----
assert.deepStrictEqual(memory.list(), []);
const a = memory.remember('The deploy target for project-x is the eu-west cluster', { tags: ['project-x'] });
assert.match(a.id, /^mem_/);
memory.remember('User prefers dark mode and terse answers', { tags: ['preference'] });
memory.remember('Never run migrations without a backup', { tags: ['safety'] });
assert.strictEqual(memory.list().length, 3);
assert.strictEqual(fs.statSync(path.join(tmp, 'memory.json')).mode & 0o777, 0o600, 'memory is 0600');

// dedupe: re-remembering the same text refreshes (uses++), doesn't add
const before = memory.list().length;
const again = memory.remember('user prefers dark mode and terse answers', { tags: ['preference'] });
assert.strictEqual(memory.list().length, before, 'no duplicate fact');
assert.strictEqual(again.id, memory.list().find((m) => /dark mode/i.test(m.text)).id, 'same fact refreshed');

// recall: query + tags rank the right facts to the top
const r1 = memory.recall('deploy eu-west', {});
assert.strictEqual(r1[0].text, 'The deploy target for project-x is the eu-west cluster', 'keyword hit ranks first');
const r2 = memory.recall('dark mode answers', {});
assert.ok(/dark mode/i.test(r2[0].text), 'keyword hit ranks first');
const r3 = memory.recall('', { tags: ['safety'] });
assert.ok(r3.some((m) => /Never run migrations/.test(m.text)), 'tag filter recall');
assert.deepStrictEqual(memory.recall('zzzznomatch', {}), [], 'no false hits');

// relevant: most-recent, capped
assert.strictEqual(memory.relevant({ limit: 2 }).length, 2);

// ---- per-bot scoping (docs: per-Bot memory granularity) ----
const botA = memory.remember('Bot A deployment freeze is Friday', { scope: 'sess-a' });
const botB = memory.remember('Bot B uses the blue theme', { scope: 'sess-b' });
assert.equal(botA.scope, 'sess-a');
assert.equal(botB.scope, 'sess-b');
const forA = memory.list({ scope: 'sess-a' });
assert.ok(forA.some((m) => /deployment freeze/.test(m.text)), "bot A sees its own fact");
assert.ok(forA.some((m) => /deploy target/.test(m.text)), 'bot A also sees global facts');
assert.ok(!forA.some((m) => /blue theme/.test(m.text)), "bot A does not see bot B's fact");
const recA = memory.recall('blue theme', { scope: 'sess-a' });
assert.deepStrictEqual(recA, [], 'scoped recall excludes other bots');
assert.ok(memory.recall('blue theme', { scope: 'sess-b' }).some((m) => /blue theme/.test(m.text)));
assert.ok(memory.relevant({ scope: 'sess-a' }).every((m) => m.scope !== 'sess-b'), 'injection never leaks another bot');
assert.ok(memory.relevant({ scope: 'sess-a' }).some((m) => m.scope === 'sess-a'), 'injection includes the bot facts');
// dedupe is per scope, not global
const aDup = memory.remember('BOT A deployment freeze is Friday', { scope: 'sess-a' });
assert.equal(memory.list({ scope: 'sess-a' }).filter((m) => /freeze is friday/i.test(m.text)).length, 1, 'scoped dedupe');
memory.remember('Bot B uses the blue theme', { scope: 'sess-b' });
assert.equal(memory.list().filter((m) => /blue theme/i.test(m.text)).length, 1, 'cross-scope dedupe stays inside scope');
memory.forget(aDup.id);

// forget
memory.forget(again.id);
assert.ok(!memory.list().some((m) => /dark mode/i.test(m.text)), 'forgotten fact removed');

// validation
memory.remember('x', {});
assert.throws(() => memory.remember('', {}), /needs text/);
assert.throws(() => memory.remember('a'.repeat(2001), {}), /too long/);

// ---- read-only gating of `remember` (recall is read-only-safe) ----
const RO = { permissive: false, permissionMode: 'read-only', enableFileMutation: false, allowlist: ['read_file', 'recall', 'remember'] };
assert.ok(/read-only subagent cannot write \(remember\)/.test(guardTool('remember', { text: 'x' }, RO) || ''), 'remember refused in read-only');
assert.strictEqual(guardTool('recall', { query: 'x' }, RO), null, 'recall allowed in read-only');
assert.strictEqual(guardTool('remember', { text: 'x' }, { permissive: true }), null, 'remember allowed on permissive turn');

// ---- Grok compat surface ----
(async () => {
  const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
  let env = await grokCompatService.dispatch('listGrokBotUserBotMemories', {});
  assert.strictEqual(env.status, 'ok'); assert.ok(Array.isArray(env.memories) && env.memories.length >= 1);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('memory test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
