'use strict';
/* Two agent sessions own two computers. Drives the shipped sandbox via
 * sandboxService.ensure and sandboxService.call — the same path smoke.js
 * uses when a sandbox turn writes a file or runs a shell. */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-computer-user-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-computer-ws-'));
process.env.QUANSIOX_USER_DATA_DIR = userData;

const { settingsService } = require('../src/main/services/settingsService');
const { sandboxService } = require('../src/main/services/sandboxService');

const A = 'computer-a';
const B = 'computer-b';
const REL = 'notes/only-a.txt';
const MARKER = 'from-computer-a';

async function main() {
  settingsService.save({
    workspaceRoot: workspace,
    sandboxMode: 'sandboxed',
    allowComputerUse: false,
  });

  const idleA = sandboxService.describe(A);
  const idleB = sandboxService.describe(B);
  assert.strictEqual(idleA.status, 'idle');
  assert.strictEqual(idleB.status, 'idle');
  assert.strictEqual(idleA.identity, `computer:${A}`);
  assert.strictEqual(idleB.identity, `computer:${B}`);
  assert.notStrictEqual(idleA.identity, idleB.identity);
  assert.notStrictEqual(idleA.root, idleB.root);
  assert.strictEqual(idleA.kind, 'session-computer');
  assert.strictEqual(idleB.kind, 'session-computer');
  assert.strictEqual(idleA.distinctFrom, 'host-mac');
  assert.strictEqual(idleB.distinctFrom, 'host-mac');
  assert.ok(idleA.root.startsWith(workspace));
  assert.ok(idleB.root.startsWith(workspace));
  assert.ok(idleA.root.endsWith(path.join('.quansiox', 'sandboxes', A)));
  assert.ok(idleB.root.endsWith(path.join('.quansiox', 'sandboxes', B)));

  const entryA = await sandboxService.ensure(A);
  const entryB = await sandboxService.ensure(B);
  assert.strictEqual(entryA.status, 'ready', `A not ready: ${entryA.status}`);
  assert.strictEqual(entryB.status, 'ready', `B not ready: ${entryB.status}`);
  assert.notStrictEqual(entryA.root, entryB.root);
  assert.strictEqual(entryA.root, idleA.root);
  assert.strictEqual(entryB.root, idleB.root);

  const wrote = await sandboxService.call(entryA, 'fs.write', { p: REL, content: MARKER }, A);
  assert.strictEqual(wrote.bytes, Buffer.byteLength(MARKER));
  const fileA = path.join(entryA.root, REL);
  const fileB = path.join(entryB.root, REL);
  const fileHost = path.join(workspace, REL);
  assert.strictEqual(fs.readFileSync(fileA, 'utf8'), MARKER);
  assert.strictEqual(fs.existsSync(fileB), false, 'write leaked into the other computer');
  assert.strictEqual(fs.existsSync(fileHost), false, 'write leaked onto the workspace host');

  const shellA = await sandboxService.call(entryA, 'exec', { command: 'pwd && ls notes' }, A);
  const shellB = await sandboxService.call(entryB, 'exec', { command: 'pwd; ls notes 2>/dev/null || true' }, B);
  const rootA = path.join('.quansiox', 'sandboxes', A);
  const rootB = path.join('.quansiox', 'sandboxes', B);
  assert.ok(shellA.output.includes(rootA), `shell A cwd: ${shellA.output}`);
  assert.ok(shellA.output.includes('only-a.txt'), `shell A listing: ${shellA.output}`);
  assert.ok(shellB.output.includes(rootB), `shell B cwd: ${shellB.output}`);
  assert.ok(!shellB.output.includes(rootA), `shell B saw A: ${shellB.output}`);
  assert.ok(!shellB.output.includes('only-a.txt'), `shell B saw A's file: ${shellB.output}`);

  const liveA = sandboxService.describe(A);
  const liveB = sandboxService.describe(B);
  assert.strictEqual(liveA.status, 'ready');
  assert.strictEqual(liveB.status, 'ready');
  assert.strictEqual(liveA.identity, idleA.identity);
  assert.strictEqual(liveB.identity, idleB.identity);
  assert.notStrictEqual(liveA.root, liveB.root);
  assert.notStrictEqual(liveA.status, 'Controlling this Mac');

  const listed = sandboxService.status();
  assert.ok(listed.some((row) => row.sessionId === A && row.status === 'ready' && row.root === entryA.root));
  assert.ok(listed.some((row) => row.sessionId === B && row.status === 'ready' && row.root === entryB.root));

  console.log('COMPUTER OK');
  console.log(JSON.stringify({
    idleA, idleB, liveA, liveB,
    fileA,
    fileB: false,
    fileHost: false,
  }, null, 2));
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await sandboxService.stop(A).catch(() => {});
    await sandboxService.stop(B).catch(() => {});
  }
})();
