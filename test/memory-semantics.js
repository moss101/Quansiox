'use strict';
/* Local memory — supersession and phrase-aware recall.
 *
 *  - a new fact about the same subject replaces the old one
 *  - superseded facts drop out of list/relevant/recall
 *  - the subject is inferred from natural phrasing ("my api key is in ...")
 *  - recall scores phrases, not just single tokens
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-memory-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { memoryService } = require('../src/main/services/memoryService');

(async () => {
  // 1. plain storage
  const a = memoryService.remember('the deployment runs on Fly.io', { tags: ['infra'] });
  assert.equal(a.text, 'the deployment runs on Fly.io');
  assert.deepEqual(a.tags, ['infra']);
  assert.equal(memoryService.list().length, 1);

  // 2. the same text refreshes rather than duplicating
  memoryService.remember('the deployment runs on Fly.io');
  assert.equal(memoryService.list().length, 1);
  assert.equal(memoryService.list()[0].uses, 2);

  // 3. subject inference
  assert.equal(memoryService.guessSubject('my api key is in 1password'), 'api key');
  assert.equal(memoryService.guessSubject('the api key is in 1password'), 'api key');
  assert.equal(memoryService.guessSubject('the cache lives in redis'), 'cache');
  assert.equal(memoryService.guessSubject('no pattern here'), null);

  // 4. supersession: a new fact about the same subject replaces the old one
  memoryService.remember('my api key is in 1password', { scope: 's1' });
  // a scoped list also shows the global facts — count only the scoped ones
  const scopedOnly = (scope) => memoryService.list({ scope }).filter((f) => f.scope === scope);
  assert.equal(scopedOnly('s1').length, 1);
  memoryService.remember('my api key is in the vault now', { scope: 's1' });
  const live = scopedOnly('s1');
  assert.equal(live.length, 1, 'the old fact is superseded, not kept alongside');
  assert.match(live[0].text, /vault now/);
  // the superseded fact is gone from recall too
  const hits = memoryService.recall('api key', { scope: 's1' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /vault now/);
  assert.ok(!hits.some((h) => /1password/.test(h.text)), 'the superseded value never resurfaces');

  // 5. an explicit subject also supersedes
  memoryService.remember('value A', { scope: 's2', subject: 'db-host' });
  memoryService.remember('value B', { scope: 's2', subject: 'db-host' });
  const s2 = scopedOnly('s2');
  assert.equal(s2.length, 1);
  assert.equal(s2[0].text, 'value B');

  // 6. scopes are independent
  memoryService.remember('my api key is in keychain', { scope: 's3' });
  assert.ok(memoryService.list({ scope: 's3' }).length >= 1);
  assert.ok(memoryService.list({ scope: 's1' }).length >= 1);

  // 7. phrase-aware recall: a multi-word phrase scores higher
  memoryService.remember('the staging database lives in a separate cluster', { scope: 's4' });
  const phrase = memoryService.recall('staging database', { scope: 's4' });
  assert.ok(phrase.length >= 1);
  assert.match(phrase[0].text, /staging database/);

  // 8. an unrelated query finds nothing
  assert.equal(memoryService.recall('zzz-nothing-matches-here', { scope: 's4' }).length, 0);

  // 9. tags still work
  memoryService.remember('the user prefers tabs', { scope: 's5', tags: ['preference'] });
  const tagged = memoryService.recall('anything', { scope: 's5', tags: ['preference'] });
  assert.ok(tagged.length >= 1, 'a tag match is a genuine match');

  // 10. forget works
  const victim = memoryService.remember('temporary fact', { scope: 's6' });
  assert.equal(memoryService.forget(victim.id).removed, true);
  assert.equal(scopedOnly('s6').length, 0);

  // 11. the store is 0600
  const stat = fs.statSync(path.join(tmp, 'memory.json'));
  assert.equal(stat.mode & 0o777, 0o600);

  console.log('memory-semantics test: ALL OK (store/supersede/subject/phrase recall/tags/forget/0600)');
})().catch((e) => { console.error(e); process.exit(1); });
