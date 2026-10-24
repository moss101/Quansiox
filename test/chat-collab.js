'use strict';
/* Chat collaboration test — docs parity batch 7: per-message ids (auto-assign
 * + lazy backfill), reply-to persistence, reaction toggling on disk, and
 * queue promote (redirect in-flight work). Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-chat-'));
process.env.QUANSIOX_USER_DATA_DIR = profile;

const { sessionService } = require('../src/main/services/sessionService');
const { createRunQueue } = require('../src/main/services/runQueue');

// --- per-message ids: appendTurn assigns, legacy transcripts backfill on get
sessionService.ensure('chat-1');
sessionService.appendTurn('chat-1', { role: 'user', content: 'hello there' });
sessionService.appendTurn('chat-1', { role: 'assistant', content: 'hi, how can I help?' });
let session = sessionService.get('chat-1');
assert.match(session.turns[0].id, /^msg_/, 'user turn got an id');
assert.match(session.turns[1].id, /^msg_/, 'assistant turn got an id');
assert.notStrictEqual(session.turns[0].id, session.turns[1].id, 'ids unique');
const firstTurnId = session.turns[0].id;

// legacy transcript (no ids) — get() backfills and persists once.
const file = path.join(profile, 'sessions', 'chat-legacy.json');
fs.writeFileSync(file, JSON.stringify({
  id: 'chat-legacy', createdAt: Date.now(), updatedAt: Date.now(), title: 'Legacy',
  turns: [{ role: 'user', content: 'old one', at: Date.now() }, { role: 'assistant', content: 'old answer', at: Date.now() }],
}, null, 2));
session = sessionService.get('chat-legacy');
assert.match(session.turns[0].id, /^msg_/, 'legacy user turn backfilled');
assert.match(session.turns[1].id, /^msg_/, 'legacy assistant turn backfilled');
const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.match(onDisk.turns[0].id, /^msg_/, 'backfill persisted to disk');
assert.strictEqual(onDisk.turns[0].id, session.turns[0].id, 'stable across loads');

// --- reply-to persists with the user turn (id reused from the renderer)
sessionService.appendTurn('chat-1', {
  role: 'user', content: 'follow-up', id: 'msg_reply_target',
  replyTo: { messageId: firstTurnId, preview: 'hello there', author: 'You' },
});
session = sessionService.get('chat-1');
const replyTurn = session.turns[2];
assert.strictEqual(replyTurn.id, 'msg_reply_target', 'renderer messageId reused as turn id');
assert.strictEqual(replyTurn.replyTo.messageId, firstTurnId, 'reply parent persisted');
assert.strictEqual(replyTurn.replyTo.author, 'You');
assert.strictEqual(replyTurn.replyTo.preview, 'hello there');

// --- threads: root + replies + nested replies with assistant answers
sessionService.appendTurn('chat-1', { role: 'assistant', content: 'replying to the follow-up' });
sessionService.appendTurn('chat-1', { role: 'user', content: 'nested reply', id: 'msg_nested', replyTo: { messageId: 'msg_reply_target', preview: 'follow-up', author: 'You' } });
sessionService.appendTurn('chat-1', { role: 'assistant', content: 'nested answer' });
const thread = sessionService.thread('chat-1', firstTurnId);
assert.strictEqual(thread.rootId, firstTurnId);
assert.strictEqual(thread.turns[0].threadRoot, true, 'root first');
assert.deepStrictEqual(thread.turns.map((t) => t.content), ['hello there', 'follow-up', 'replying to the follow-up', 'nested reply', 'nested answer']);
assert.strictEqual(thread.count, 4);
const counts = sessionService.threadCounts('chat-1');
assert.strictEqual(counts[firstTurnId], 1);
assert.strictEqual(counts.msg_reply_target, 1);
assert.throws(() => sessionService.thread('chat-1', 'msg_missing'), /message not found/);

// --- reactions: toggle on/off, persist, reject junk
const target = session.turns[1].id;
let out = sessionService.react('chat-1', target, '👍');
assert.deepStrictEqual(out.reactions, ['👍'], 'reaction added');
session = sessionService.get('chat-1');
assert.deepStrictEqual(session.turns[1].reactions, ['👍'], 'persisted on the turn');
out = sessionService.react('chat-1', target, '🎉');
assert.deepStrictEqual(out.reactions, ['👍', '🎉'], 'second reaction stacks');
out = sessionService.react('chat-1', target, '👍');
assert.deepStrictEqual(out.reactions, ['🎉'], 'same emoji toggles off');
assert.throws(() => sessionService.react('chat-1', target, '💣'), /unsupported reaction/, 'emoji allowlist');
assert.throws(() => sessionService.react('chat-1', 'msg_nope', '👍'), /message not found/, 'unknown message');

// --- queue promote: redirect moves the message behind the active run to head
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
(async () => {
  const starts = [];
  const queue = createRunQueue((sessionId, task, meta) => {
    starts.push(task.opts.messageId);
    return task.deferred.promise;
  });
  const first = deferred(), second = deferred(), third = deferred();
  queue.run('s1', { opts: { messageId: 'm1' }, deferred: first }, () => {}); // starts now
  queue.run('s1', { opts: { messageId: 'm2' }, deferred: second }, () => {});
  queue.run('s1', { opts: { messageId: 'm3' }, deferred: third }, () => {});
  assert.deepStrictEqual(starts, ['m1'], 'only the first runs');
  assert.strictEqual(queue.promote('s1', 'm3'), true, 'promote finds the queued message');
  assert.strictEqual(queue.promote('s1', 'm404'), false, 'unknown message not promoted');
  assert.strictEqual(queue.promote('sX', 'm3'), false, 'unknown session not promoted');
  first.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(starts, ['m1', 'm3'], 'promoted message runs next (redirect)');
  third.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(starts, ['m1', 'm3', 'm2'], 'previously-second message still queued behind');
  second.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(queue.depth('s1'), 0, 'queue drains');

  console.log('chat-collab: all OK');
})();
