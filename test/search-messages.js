'use strict';
/* Cross-conversation message search test — docs "Find prior work": substring
 * over titles + user/assistant text across sessions, newest first, bounded,
 * with messageId for jump-back. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-msgsearch-'));
process.env.QUANSIOX_USER_DATA_DIR = profile;

const { sessionService } = require('../src/main/services/sessionService');

function seed(id, title, turns, updatedAt) {
  fs.mkdirSync(path.join(profile, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'sessions', `${id}.json`), JSON.stringify({
    id, title, createdAt: updatedAt, updatedAt,
    turns: turns.map((t, i) => ({ ...t, id: t.id ?? `msg_${id}_${i}`, at: updatedAt + i })),
    usage: { promptTokens: 0, completionTokens: 0, requests: 0 },
  }, null, 2));
}

const now = Date.now();
seed('s-old', 'Refactor api', [
  { role: 'user', content: 'please rename the deploy target to prod-green' },
  { role: 'assistant', content: 'Renamed the deploy target; CI now publishes prod-green.' },
], now - 86_400_000);
seed('s-new', 'Fix login bug', [
  { role: 'user', content: 'the login page rejects SSO users' },
  { role: 'assistant', content: 'Found it — the SSO cookie was dropped on redirect.' },
  { role: 'user', content: [{ type: 'text', text: 'also check the deploy script' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }] },
], now);

// 1. message hits across sessions, newest first, with jump target ids
let hits = sessionService.searchMessages('deploy');
assert.strictEqual(hits.length, 3, `three deploy hits, got ${hits.length}`);
assert.strictEqual(hits[0].sessionId, 's-new', 'newer session ranks first (recency)');
assert.strictEqual(hits[0].messageId, 'msg_s-new_2', 'hit carries the message id');
assert.match(hits[0].snippet, /deploy script/, 'snippet centers the match');
assert.strictEqual(hits[1].sessionId, 's-old', 'then the older session');
assert.strictEqual(hits[1].role, 'assistant');

// 2. multimodal parts flatten to text (+ type placeholder), no raw payloads
hits = sessionService.searchMessages('base64');
assert.deepStrictEqual(hits, [], 'no raw payload leakage from parts');
hits = sessionService.searchMessages('also check');
assert.strictEqual(hits.length, 1, 'text part matched');
assert.strictEqual(hits[0].role, 'user');

// 3. case-insensitive + assistant messages included
hits = sessionService.searchMessages('PROD-GREEN');
assert.ok(hits.some((h) => h.role === 'assistant'), 'assistant text searched');

// 4. title hits surface the conversation (with a jump target when possible)
hits = sessionService.searchMessages('login bug');
assert.ok(hits.some((h) => h.sessionId === 's-new' && /Conversation: Fix login bug/.test(h.snippet)), 'title hit anchors the conversation');
hits = sessionService.searchMessages('rejects SSO');
assert.ok(hits.some((h) => h.sessionId === 's-new' && h.role === 'user'), 'phrase hit inside a message');
hits = sessionService.searchMessages('refactor');
assert.ok(hits.some((h) => h.sessionId === 's-old' && h.messageId === 'msg_s-old_1'), 'title match anchors to last turn');

// 5. guards: short queries, empty query, limits
assert.deepStrictEqual(sessionService.searchMessages('d'), [], 'min 2 chars');
assert.deepStrictEqual(sessionService.searchMessages(''), [], 'empty query');
assert.strictEqual(sessionService.searchMessages('deploy', { limit: 1 }).length, 1, 'limit honored');

// 6. search does not bump session recency (id backfill write keeps updatedAt)
sessionService.searchMessages('deploy');
const raw = JSON.parse(fs.readFileSync(path.join(profile, 'sessions', 's-old.json'), 'utf8'));
assert.strictEqual(raw.updatedAt, now - 86_400_000, 'recency untouched by search');

console.log('search-messages: all OK');
