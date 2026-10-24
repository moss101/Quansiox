'use strict';
/* Search service test — grep-style workspace code search (substring + regex +
 * context + skip dirs + caps/cap), media listing, and session-title search.
 * Node-only. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { searchService } = require('../src/main/services/searchService');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-search-'));
fs.writeFileSync(path.join(ws, 'a.js'), 'const x = 1;\nfunction foo() { return TODO; }\ntodo item here');
fs.writeFileSync(path.join(ws, 'b.txt'), 'nothing to see\ntodo: buy milk');
fs.mkdirSync(path.join(ws, 'src'));
fs.writeFileSync(path.join(ws, 'src/c.js'), 'todo in nested\n// todo again');
fs.mkdirSync(path.join(ws, 'node_modules'));
fs.writeFileSync(path.join(ws, 'node_modules/junk.js'), 'todo should be skipped');
fs.writeFileSync(path.join(ws, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));

async function run() {
  // 1. substring search across files, skipping node_modules + binary
  let r = searchService.searchFiles('TODO', ws);
  assert.ok(r.results.some((x) => x.path === 'a.js' && x.line === 2), 'finds TODO in a.js:2');
  assert.ok(r.results.every((x) => !x.path.includes('node_modules')), 'skips node_modules');
  assert.ok(r.results.every((x) => !x.path.endsWith('.png')), 'skips binary files');

  // 2. substring is exact — lowercase todo matches b.txt + nested src/c.js
  r = searchService.searchFiles('todo', ws);
  assert.ok(r.results.some((x) => x.path === 'b.txt'), 'lowercase todo matches b.txt');
  assert.ok(r.results.some((x) => x.path.endsWith('src/c.js')), 'searches nested files');

  // 3. regex
  r = searchService.searchFiles('func[t]ion', ws, { regex: true });
  assert.ok(r.results.some((x) => x.path === 'a.js' && x.line === 2), 'regex matches function');

  // 4. bad regex → honest error, no crash
  r = searchService.searchFiles('(', ws, { regex: true });
  assert.ok(r.error, 'bad regex reports an error');

  // 5. context lines
  r = searchService.searchFiles('buy milk', ws, { context: 1 });
  assert.match(r.results[0].text, /nothing to see \| todo: buy milk/, 'context includes neighbour');

  // 6. missing root → empty, no crash
  r = searchService.searchFiles('x', '/nonexistent-dir-xyz', {});
  assert.deepStrictEqual(r.results, []);

  // 7. listMedia (query + skip node_modules)
  const media = searchService.listMedia('', ws);
  assert.ok(media.some((m) => m.name === 'img.png'), 'lists media');
  assert.ok(media.every((m) => !m.path.includes('node_modules')), 'media skips node_modules');
  assert.deepStrictEqual(searchService.listMedia('zzz', ws), [], 'media query filter');

  // 8. searchAgents (title/id match)
  const list = [{ id: 's1', title: 'Fix login bug' }, { id: 'abc', title: 'Refactor api' }];
  assert.deepStrictEqual(searchService.searchAgents('login', list).map((a) => a.id), ['s1']);
  assert.deepStrictEqual(searchService.searchAgents('abc', list).map((a) => a.id), ['abc']);

  fs.rmSync(ws, { recursive: true, force: true });
  console.log('search test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
