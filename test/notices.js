'use strict';
/* Notice service test — request-ID troubleshooting stack: raise assigns a
 * copyable req_* id, list is a bounded ring, dismiss/clear work, and raising
 * without any window is safe. Node-only. */
const assert = require('node:assert/strict');

const { noticeService } = require('../src/main/services/noticeService');

const a = noticeService.raise({ title: 'Run failed', body: 'boom', kind: 'error', sessionId: 's1' });
assert.match(a.id, /^req_[A-Za-z0-9_-]{8}$/, 'request id shape');
assert.strictEqual(a.requestId, a.id, 'requestId mirrors the id');
assert.strictEqual(a.title, 'Run failed');
assert.strictEqual(a.sessionId, 's1');
assert.strictEqual(noticeService.list().length, 1);

const b = noticeService.raise({ title: 'Approval timed out', kind: 'warn' });
assert.notStrictEqual(b.id, a.id, 'ids are unique');

// Bounded ring: cap at 20, oldest evicted.
for (let i = 0; i < 25; i++) noticeService.raise({ title: `n${i}` });
const list = noticeService.list();
assert.strictEqual(list.length, 20, 'ring caps at 20');
assert.strictEqual(list[list.length - 1].title, 'n24', 'newest kept');
assert.strictEqual(noticeService.list().some((n) => n.id === b.id), false, 'oldest evicted (b)');

// Dismiss one, clear the rest.
const victim = list[0];
assert.deepStrictEqual(noticeService.dismiss({ id: victim.id }), { dismissed: true });
assert.deepStrictEqual(noticeService.dismiss({ id: 'req_nope' }), { dismissed: false });
assert.strictEqual(noticeService.list().some((n) => n.id === victim.id), false, 'dismissed notice gone');
assert.deepStrictEqual(noticeService.clear(), { cleared: 19 });
assert.strictEqual(noticeService.list().length, 0);

console.log('notice service test: ALL OK');
