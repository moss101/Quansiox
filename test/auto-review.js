'use strict';
/* Auto-review rules — pure verdict engine used by the coordinator approval
 * gate (Settings → Security → Auto-review rules). */
const assert = require('node:assert');
const { autoReview } = require('../src/coordinator/autoReview');

const rules = (allow, block, isEnabled = true) => ({
  isEnabled,
  allowInstructions: allow,
  blockInstructions: block,
});

// disabled → no automated verdict
assert.strictEqual(autoReview.autoReviewVerdict(rules(['echo'], [], false), 'echo hi'), null, 'disabled falls through');
assert.strictEqual(autoReview.autoReviewVerdict(null, 'echo hi'), null, 'no rules falls through');
assert.strictEqual(autoReview.autoReviewVerdict(rules([], []), 'echo hi'), null, 'no match falls through');

// plain text, case-insensitive substring
assert.strictEqual(autoReview.autoReviewVerdict(rules(['npm test'], []), 'cd repo && npm test -- --watch'), 'allow', 'allow substring');
assert.strictEqual(autoReview.autoReviewVerdict(rules([], ['rm -rf']), 'sudo rm -rf /tmp/x'), 'deny', 'block substring');
assert.strictEqual(autoReview.autoReviewVerdict(rules(['RM'], []), 'rm file.txt'), 'allow', 'case-insensitive');

// block wins over allow
assert.strictEqual(
  autoReview.autoReviewVerdict(rules(['git'], ['git push']), 'git push origin main'),
  'deny',
  'block precedence'
);

// /regex/ form + invalid regex is inert
assert.strictEqual(autoReview.autoReviewVerdict(rules(['/^git (status|log)/'], []), 'git log -3'), 'allow', 'regex allow');
assert.strictEqual(autoReview.autoReviewVerdict(rules(['/[unclosed/'], []), 'anything'), null, 'invalid regex ignored');

// tool text: shell uses the command, others use JSON args
assert.strictEqual(autoReview.autoReviewText('shell', { command: 'ls -la' }), 'ls -la');
assert.ok(autoReview.autoReviewText('write_file', { path: 'a.txt', content: 'hi' }).includes('"path":"a.txt"'), 'json args text');
assert.strictEqual(
  autoReview.verdictForTool(rules([], ['secrets']), 'write_file', { path: 'secrets.txt', content: 'x' }),
  'deny',
  'verdictForTool matches path in args'
);
assert.strictEqual(
  autoReview.verdictForTool(rules(['notes/']), 'write_file', { path: 'notes/today.md', content: 'x' }),
  'allow',
  'verdictForTool allow via path'
);

// empty-string rules are inert
assert.strictEqual(autoReview.autoReviewVerdict(rules(['  '], []), 'anything'), null, 'blank rule ignored');

console.log('auto-review test: ALL OK');
