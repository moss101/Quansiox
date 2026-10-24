'use strict';
/* Coordinator tool surface — the new surgical/background tools as the model
 * actually reaches them.
 *
 *  - edit_file through executeTool (the model-facing path)
 *  - glob_files
 *  - read_file with a line range
 *  - shell promotion into a background job (shellId handed back)
 *  - the new tools are present in the advertised tool list
 *
 * Electron-free: the coordinator child runs in plain Node. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-coord-tools-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const coordinator = require('../src/coordinator/index');

(async () => {
  const names = coordinator.allTools().map((t) => t.function.name);
  for (const tool of ['edit_file', 'glob_files', 'await_shell', 'read_shell_output', 'write_shell_input']) {
    assert.ok(names.includes(tool), `${tool} is advertised to the model`);
  }
  // read_file grew offset/limit
  const readSpec = coordinator.allTools().find((t) => t.function.name === 'read_file');
  assert.ok(readSpec.function.parameters.properties.offset, 'read_file supports a line offset');
  assert.ok(readSpec.function.parameters.properties.limit, 'read_file supports a line limit');

  // --- edit_file ---
  const target = path.join(tmp, 'edit-me.txt');
  fs.writeFileSync(target, 'alpha\nbeta\ngamma\n');
  const edit = await coordinator.executeTool(
    'edit_file',
    { path: target, old_string: 'beta', new_string: 'BETA' },
    tmp, 'coord-tools', { permissive: true }, null, null, null, null,
  );
  assert.match(edit, /^edited /);
  assert.match(edit, /\+BETA/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'alpha\nBETA\ngamma\n');

  // a failed edit is reported, not thrown
  const failed = await coordinator.executeTool(
    'edit_file',
    { path: target, old_string: 'does-not-exist', new_string: 'x' },
    tmp, 'coord-tools', { permissive: true }, null, null, null, null,
  );
  assert.match(failed, /^edit failed: /);

  // --- glob_files ---
  fs.mkdirSync(path.join(tmp, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'pkg', 'one.ts'), 'x');
  fs.writeFileSync(path.join(tmp, 'pkg', 'two.ts'), 'x');
  const globbed = await coordinator.executeTool(
    'glob_files', { pattern: 'pkg/*.ts' }, tmp, 'coord-tools', { permissive: true }, null, null, null, null,
  );
  assert.match(globbed, /pkg\/one\.ts/);
  assert.match(globbed, /pkg\/two\.ts/);

  // --- read_file with a range ---
  fs.writeFileSync(path.join(tmp, 'lines.txt'), Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') + '\n');
  const ranged = await coordinator.executeTool(
    'read_file', { path: 'lines.txt', offset: 3, limit: 2 }, tmp, 'coord-tools', { permissive: true }, null, null, null, null,
  );
  assert.match(ranged, /lines 3-4 of 10/);
  assert.match(ranged, /L3/);
  assert.match(ranged, /L4/);
  assert.ok(!ranged.includes('L5'), 'the range stops where it was told to');

  // --- shell promotion into a background job ---
  const promoted = await coordinator.executeTool(
    'shell',
    { command: 'sleep 30', background_after_ms: 250 },
    tmp, 'coord-tools', { permissive: true }, null, null, null, null,
  );
  assert.match(promoted, /still running in the background/);
  const shellId = /shell_id: ([^\s,\]]+)/.exec(promoted)?.[1];
  assert.ok(shellId, 'a shell id is handed back');

  // the background job can be polled …
  const polled = await coordinator.executeTool(
    'read_shell_output', { shell_id: shellId }, tmp, 'coord-tools', { permissive: true }, null, null, null, null,
  );
  assert.match(polled, new RegExp(`shell ${shellId} running`));

  // … and terminated through the manager
  coordinator.backgroundShells.stop(shellId);

  // a short command finishes in the foreground
  const quick = await coordinator.executeTool(
    'shell', { command: 'echo quick-result' }, tmp, 'coord-tools', { permissive: true }, null, null, null, null,
  );
  assert.match(quick, /quick-result/);

  console.log('coordinator-tools test: ALL OK (edit_file/glob_files/read range/shell promotion)');
})().catch((e) => { console.error(e); process.exit(1); });
