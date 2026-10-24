'use strict';
/* Prior-links search test — docs "Find prior work": the palette finds links
 * shared in conversations. URLs extracted from text, deduped globally
 * (newest mention wins), query-matched, anchored to a message. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-linksearch-'));
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
seed('s-old', 'Docs dig', [
  { role: 'user', content: 'the spec lives at https://example.com/specs/agent-v2.' },
  { role: 'assistant', content: 'Noted — see also (https://example.com/specs/agent-v2) for the addendum.' },
], now - 86_400_000);
seed('s-new', 'Release prep', [
  { role: 'assistant', content: 'Changelog at https://example.com/specs/agent-v2 and the tracker at https://tracker.example.org/QX-42).' },
  { role: 'user', content: [{ type: 'text', text: 'artifacts: https://cdn.example.net/build/9.zip' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }] },
], now);

// 1. extraction with prose punctuation trimmed, deduped across sessions
let hits = sessionService.searchLinks('specs');
assert.strictEqual(hits.length, 1, `spec link deduped across sessions, got ${hits.length}`);
hits = sessionService.searchLinks('example');
assert.strictEqual(hits.length, 3, `three distinct example hosts, got ${hits.length}`);
assert.deepStrictEqual(hits.map((h) => h.url).sort(), [
  'https://cdn.example.net/build/9.zip',
  'https://example.com/specs/agent-v2',
  'https://tracker.example.org/QX-42',
]);
assert.ok(!hits.some((h) => h.url.endsWith('.') || h.url.endsWith(')')), 'trailing punctuation trimmed');

// 2. duplicate URL keeps the newest mention (jump target in the newer session)
const spec = sessionService.searchLinks('agent-v2')[0];
assert.strictEqual(spec.sessionId, 's-new', 'newest mention wins');
assert.strictEqual(spec.messageId, 'msg_s-new_0', 'anchored to the mentioning message');
assert.strictEqual(spec.title, 'Release prep');

// 3. data: URLs never leak in
assert.deepStrictEqual(sessionService.searchLinks('base64'), [], 'no data: payloads');

// 4. query matching + guards
hits = sessionService.searchLinks('tracker');
assert.strictEqual(hits.length, 1, 'match by host/path');
assert.strictEqual(hits[0].url, 'https://tracker.example.org/QX-42');
assert.deepStrictEqual(sessionService.searchLinks('h'), [], 'min 2 chars');
assert.deepStrictEqual(sessionService.searchLinks(''), [], 'empty query');
assert.strictEqual(sessionService.searchLinks('example', { limit: 1 }).length, 1, 'limit honored');

// 5. no link in plain text → nothing
assert.deepStrictEqual(sessionService.searchLinks('spec lives'), [], 'plain prose is not a link');

console.log('search-links: all OK');
