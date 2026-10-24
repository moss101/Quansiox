'use strict';
/* Subagent blackboard — shared scratchpad semantics (set/append/list/digest,
 * caps, persistence) and the agent-facing board_* tools. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-board-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const Module = require('node:module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return require.resolve('./stub-electron.js');
  return origResolve.call(this, request, ...rest);
};

const { Blackboard, getBoard, resetBoard, normalizeValue, MAX_KEYS } = require('../src/coordinator/blackboard');

// 1. set/get/list semantics
const board = new Blackboard({ sessionId: 'run-1' });
board.set('api-map', { endpoints: ['/a', '/b'] }, 'explore-1');
assert.deepStrictEqual(board.get('api-map').value, { endpoints: ['/a', '/b'] });
assert.equal(board.get('api-map').rev, 1);
board.set('api-map', { endpoints: ['/a'] }, 'explore-2');
assert.equal(board.get('api-map').rev, 2, 'rev increments on replace');
assert.equal(board.get('missing'), null);

// 2. append keeps history and count
board.append('findings', 'first', 'a');
board.append('findings', 'second', 'b');
const findings = board.get('findings');
assert.equal(findings.mode, 'append');
assert.deepStrictEqual(findings.history, ['first', 'second']);
assert.equal(findings.count, 2);
assert.equal(board.list().find((r) => r.key === 'findings').count, 2);

// 3. digest gives siblings a compact view
const digest = board.digest();
assert.match(digest, /api-map/);
assert.match(digest, /findings/);
assert.match(digest, /2 entries/);

// 4. values are normalized (truncation + JSON-safe)
const long = 'x'.repeat(5000);
const entry = board.set('long', long);
assert.ok(entry.value.length <= 4100, 'long strings truncated');
assert.equal(normalizeValue(undefined), undefined);
assert.deepStrictEqual(normalizeValue({ a: 1n, b: () => 1, c: [1, 'two'] }), { a: '1', c: [1, 'two'] }, 'non-JSON values dropped');

// 5. key caps
const small = new Blackboard({ sessionId: 'cap' });
for (let i = 0; i < MAX_KEYS; i += 1) small.set(`k${i}`, i);
assert.throws(() => small.set('one-too-many', 1), /board is full/);
assert.throws(() => new Blackboard({}).set('', 1), /key is required/);
assert.throws(() => new Blackboard({}).set('x'.repeat(121), 1), /too long/);

// 6. persistence (atomic write + reload)
const dir = path.join(tmp, 'board-dir');
const persisted = new Blackboard({ sessionId: 'persist', dir });
persisted.set('decision', 'use vitest', 'parent');
persisted.flush ? persisted.flush() : null;
setTimeout(() => {
  const reloaded = new Blackboard({ sessionId: 'persist', dir });
  assert.equal(reloaded.get('decision').value, 'use vitest');
  const mode = fs.statSync(path.join(dir, 'blackboard.json')).mode & 0o777;
  assert.equal(mode, 0o600, 'board file is owner-only');

  // 7. agent tools through executeTool
  const { executeTool } = require('../src/coordinator/index');
  const policy = { permissive: false, permissionMode: 'workspace', allowlist: ['board_write', 'board_read', 'board_list', 'shell'] };
  resetBoard('root-sess');
  (async () => {
    const written = await executeTool('board_write', { key: 'nums', value: [1, 2] }, tmp, 'tool-sess', policy, null, null, null, 'root-sess');
    assert.match(written, /board nums set/);
    const appended = await executeTool('board_write', { key: 'log', value: 'step1', mode: 'append' }, tmp, 'tool-sess', policy, null, null, null, 'root-sess');
    assert.match(appended, /appended/);
    const read = await executeTool('board_read', { key: 'nums' }, tmp, 'tool-sess', policy, null, null, null, 'root-sess');
    assert.match(read, /1,\n  2/);
    const listed = await executeTool('board_list', {}, tmp, 'tool-sess', policy, null, null, null, 'root-sess');
    assert.match(listed, /nums/);
    assert.match(listed, /log/);
    assert.match(await executeTool('board_read', { key: 'nope' }, tmp, 'tool-sess', policy, null, null, null, 'root-sess'), /no blackboard entry/);

    // read-only cannot publish, but can read
    const ro = { permissive: false, permissionMode: 'read-only', allowlist: ['board_write', 'board_read', 'board_list'] };
    // The refusal now comes from the governance catalogue (W1.7): it says
    // what did not happen, that it must not be retried, and what to do
    // instead — the old wording was a bare "refused:".
    const roWrite = await executeTool('board_write', { key: 'x', value: 1 }, tmp, 'tool-sess', ro, null, null, null, 'root-sess');
    assert.match(roWrite, /refused/);
    assert.match(roWrite, /read-only/);
    assert.match(roWrite, /Do not retry/);
    assert.doesNotMatch(await executeTool('board_read', { key: 'nums' }, tmp, 'tool-sess', ro, null, null, null, 'root-sess'), /refused/);

    // getBoard returns the same instance for a root key
    assert.strictEqual(getBoard('root-sess'), getBoard('root-sess'));
    console.log('blackboard test: ALL OK (set/append/digest/caps/persistence/tools)');
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}, 120);
