'use strict';
/* Surgical file tools + background shells.
 *
 *  - edit_file: exact replacement, non-unique detection, whitespace-tolerant
 *    matching, unified diff output, atomic write
 *  - glob_files: `**`, `*`, `?`, `{a,b}` patterns, ignore list
 *  - read_file ranges: offset/limit, line accounting
 *  - background shell: promotion of a long-running command, output capture,
 *    stdin writing, termination
 *
 * Pure Node — no Electron. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-filetools-'));
const fileTools = require('../src/coordinator/fileTools');
const { BackgroundShellManager } = require('../src/coordinator/backgroundShell');

(async () => {
  /* ---------------- edit_file ---------------- */
  const target = path.join(tmp, 'sample.js');
  fs.writeFileSync(target, [
    'const a = 1;',
    'const b = 2;',
    'const c = 3;',
    '',
  ].join('\n'));

  // 1. exact replacement produces a diff and leaves the rest untouched
  const r1 = fileTools.applyEdit(target, 'const b = 2;', 'const b = 22;');
  assert.equal(r1.ok, true);
  assert.equal(r1.replaced, 1);
  assert.match(r1.diff, /-const b = 2;/);
  assert.match(r1.diff, /\+const b = 22;/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'const a = 1;\nconst b = 22;\nconst c = 3;\n');

  // 2. a non-unique snippet is refused (with the occurrence count)
  fs.writeFileSync(target, 'x\nx\ny\n');
  const r2 = fileTools.applyEdit(target, 'x', 'z');
  assert.equal(r2.ok, false);
  assert.match(r2.error, /not unique/);
  assert.equal(r2.occurrences, 2);

  // 3. replace_all rewrites every occurrence
  const r3 = fileTools.applyEdit(target, 'x', 'z', { replaceAll: true });
  assert.equal(r3.ok, true);
  assert.equal(r3.replaced, 2);
  assert.equal(fs.readFileSync(target, 'utf8'), 'z\nz\ny\n');

  // 4. a missing snippet fails with a helpful message (and changes nothing)
  const r4 = fileTools.applyEdit(target, 'nope', 'z');
  assert.equal(r4.ok, false);
  assert.match(r4.error, /not found/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'z\nz\ny\n');

  // 5. whitespace-tolerant matching (trailing spaces differ)
  fs.writeFileSync(target, 'function f() {   \n  return 1;\n}\n');
  const r5 = fileTools.applyEdit(target, 'function f() {\n  return 1;', 'function f() {\n  return 2;');
  assert.equal(r5.ok, true);
  assert.match(fs.readFileSync(target, 'utf8'), /return 2;/);

  // 6. identical old/new is refused
  const r6 = fileTools.applyEdit(target, 'return 2;', 'return 2;');
  assert.equal(r6.ok, false);
  assert.match(r6.error, /identical/);

  // 7. the diff is a real unified diff
  const before = 'a\nb\nc\n';
  const after = 'a\nB\nc\n';
  const diff = fileTools.unifiedDiff(before, after, 'x.txt');
  assert.match(diff, /^--- a\/x\.txt/);
  assert.match(diff, /\+\+\+ b\/x\.txt/);
  assert.match(diff, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.match(diff, /^-b$/m);
  assert.match(diff, /^\+B$/m);

  // 8. an unchanged file produces no diff
  assert.equal(fileTools.unifiedDiff('same\n', 'same\n', 'x.txt'), '');

  /* ---------------- read_file ranges ---------------- */
  const many = path.join(tmp, 'many.txt');
  fs.writeFileSync(many, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const r = fileTools.readFileRange(many, { offset: 4, limit: 3 });
  assert.equal(r.startLine, 4, 'offset is 1-based');
  assert.equal(r.totalLines, 20);
  assert.equal(r.text, 'line 4\nline 5\nline 6');
  assert.equal(r.truncated, true);

  // a full read reports the true line count (no phantom trailing line)
  const full = fileTools.readFileRange(many, {});
  assert.equal(full.totalLines, 20);
  assert.equal(full.truncated, false);

  /* ---------------- glob_files ---------------- */
  fs.mkdirSync(path.join(tmp, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'x');
  fs.writeFileSync(path.join(tmp, 'src', 'b.js'), 'x');
  fs.writeFileSync(path.join(tmp, 'src', 'deep', 'c.ts'), 'x');
  fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'node_modules', 'ignored.ts'), 'x');

  const tsFiles = fileTools.globFiles(tmp, '**/*.ts').map((f) => f.relative);
  assert.deepEqual(tsFiles, ['src/a.ts', 'src/deep/c.ts']);
  assert.ok(!tsFiles.some((f) => f.includes('node_modules')), 'node_modules is ignored');

  const braceFiles = fileTools.globFiles(tmp, 'src/*.{ts,js}').map((f) => f.relative);
  assert.deepEqual(braceFiles, ['src/a.ts', 'src/b.js']);

  // the glob→regex translation itself
  assert.ok(fileTools.globToRegExp('**/*.js').test('a/b/c.js'));
  assert.ok(!fileTools.globToRegExp('*.js').test('a/b.js'));
  assert.ok(fileTools.globToRegExp('src/?.ts').test('src/a.ts'));

  /* ---------------- background shell ---------------- */
  const shells = new BackgroundShellManager();
  const started = shells.start('sleep 0.2 && echo done-from-bg', { cwd: tmp });
  assert.ok(started.shellId);
  assert.ok(started.pid > 0);
  const done = await shells.await(started.shellId, { timeoutMs: 10_000 });
  assert.equal(done.exited, true);
  assert.equal(done.exitCode, 0);
  assert.match(done.output, /done-from-bg/);

  // stdin: a process that reads a line
  const reader = shells.start('read line; echo "got:$line"', { cwd: tmp });
  await new Promise((r) => setTimeout(r, 200));
  shells.write(reader.shellId, 'hello\n');
  const read = await shells.await(reader.shellId, { timeoutMs: 10_000 });
  assert.equal(read.exited, true);
  assert.match(read.output, /got:hello/);

  // a long-running process stays alive and can be read while running
  const slow = shells.start('sleep 30', { cwd: tmp });
  const pending = shells.await(slow.shellId, { timeoutMs: 300 });
  const timedOut = await pending;
  assert.equal(timedOut.exited, false);
  assert.equal(timedOut.timedOut, true);
  const live = shells.read(slow.shellId);
  assert.equal(live.exited, false);
  assert.equal(shells.stop(slow.shellId).stopped, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(shells.read(slow.shellId).exited, true);

  // unknown shell ids are refused honestly
  assert.throws(() => shells.read('nope'), /unknown shell/);
  assert.throws(() => shells.write('nope', 'x'), /unknown shell/);

  // list() reports the fleet
  assert.ok(shells.list().length >= 3);

  console.log('file-tools test: ALL OK (edit/glob/read-range/background-shell)');
})().catch((e) => { console.error(e); process.exit(1); });
