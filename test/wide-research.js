'use strict';
/* Wide Research test — the local-first fan-out/fan-in engine.
 *
 * Covers the documented behaviour:
 *   - decomposition into independent items (WRS-01);
 *   - one dedicated agent per item, in parallel (WRS-02);
 *   - an ISOLATED context per item: a child never sees a sibling (WRS-03);
 *   - structured, multi-field extraction per item (WRS-06);
 *   - synthesis into the requested shape (WRS-05);
 *   - pattern/outlier detection (WRS-11);
 *   - post-hoc refinement over a subset (WRS-10);
 *   - the output packaged as a ZIP (WRS-08).
 *
 * The engine's pure parts (parsing, matrix building, rendering) are tested
 * directly; the fan-out itself is driven through a fake dispatcher so the
 * test needs no model.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-wideres-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const wide = require('../src/coordinator/wideResearch');
const { buildZip, toCsv } = require('../src/shared/zip');

async function run() {
  /* -- 1. item and field normalisation ---------------------------------- */
  const items = wide.normalizeItems([
    { id: 'a', label: 'Alpha', prompt: 'https://example.com/a' },
    { id: 'b', label: 'Beta', prompt: 'https://example.com/b' },
    'plain string item',
    { prompt: '   ' },
    null,
  ]);
  assert.strictEqual(items.length, 3, 'blank items are dropped');
  assert.strictEqual(items[0].id, 'a');
  assert.strictEqual(items[2].prompt, 'plain string item');
  assert.deepStrictEqual(wide.normalizeFields(['price', ' rating ', '', null]), ['price', 'rating']);
  assert.strictEqual(wide.normalizeItems(new Array(400).fill('x')).length, wide.MAX_ITEMS);

  /* -- 2. field extraction from a messy child answer -------------------- */
  const parsed = wide.parseFields('Here you go:\n```json\n{"price": "10", "rating": "4.5"}\n```', ['price', 'rating']);
  assert.strictEqual(parsed.price, '10');
  assert.strictEqual(parsed.rating, '4.5');
  // Prose with no JSON still lands in the matrix.
  const loose = wide.parseFields('price: 20\nrating: 3', ['price', 'rating']);
  assert.strictEqual(loose.price, '20');
  assert.strictEqual(loose.rating, '3');
  // A JSON body buried in prose is found.
  const buried = wide.parseFields('Sure! {"price":"7"} — done.', ['price']);
  assert.strictEqual(buried.price, '7');

  /* -- 3. the fan-out: one child per item, in parallel ------------------- */
  const seen = [];
  let inFlight = 0;
  let peak = 0;
  const dispatch = async (spec) => {
    seen.push(spec);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    // The child answers with a JSON object of the requested fields.
    const itemId = spec.description;
    const price = itemId === 'Alpha' ? '10' : itemId === 'Beta' ? '20' : '30';
    return JSON.stringify({
      summary: `{"price":"${price}","rating":"${itemId === 'Beta' ? '2' : '5'}"}`,
      success: true,
    });
  };

  const result = await wide.runWideResearch({
    instruction: 'find the price and rating',
    items: [
      { id: 'a', label: 'Alpha', prompt: 'https://example.com/a' },
      { id: 'b', label: 'Beta', prompt: 'https://example.com/b' },
      { id: 'c', label: 'Gamma', prompt: 'https://example.com/c' },
      { id: 'd', label: 'Delta', prompt: 'https://example.com/d' },
    ],
    fields: ['price', 'rating'],
    output: 'table',
    concurrency: 3,
  }, { sessionId: 'wr-session' }, dispatch);

  assert.strictEqual(result.items, 4);
  assert.strictEqual(result.succeeded, 4);
  assert.strictEqual(result.failed, 0);
  assert.strictEqual(seen.length, 4, 'one child per item');
  assert.ok(peak > 1, 'the items really ran in parallel');
  assert.ok(peak <= 3, 'the concurrency cap is honoured');
  assert.deepStrictEqual(result.fields, ['price', 'rating']);

  /* -- 4. isolation: no child sees a sibling ---------------------------- */
  for (const spec of seen) {
    assert.match(spec.prompt, /https:\/\/example\.com\//);
    assert.ok(!/example\.com\/b/.test(spec.prompt) || spec.description === 'Beta',
      'a child only ever sees its own item');
    assert.match(spec.prompt, /price, rating/, 'every child is asked for the same fields');
  }
  // And each child prompt names exactly one item.
  assert.strictEqual(seen.filter((s) => (s.prompt.match(/example\.com/g) || []).length === 1).length, 4);

  /* -- 5. the matrix ---------------------------------------------------- */
  assert.strictEqual(result.matrix.length, 4);
  const alpha = result.matrix.find((row) => row.label === 'Alpha');
  assert.strictEqual(alpha.price, '10');
  assert.strictEqual(alpha.rating, '5');
  assert.strictEqual(alpha._ok, true);
  assert.match(result.table, /price \| rating/);
  assert.match(result.table, /Alpha/);

  /* -- 6. pattern detection (WRS-11) ------------------------------------- */
  assert.strictEqual(result.stats.price.filled, 4);
  // Gamma and Delta both came back at 30, so there are three distinct prices.
  assert.strictEqual(result.stats.price.unique, 3);
  assert.strictEqual(result.stats.price.top, '30');
  assert.strictEqual(result.stats.rating.filled, 4);
  // "5" occurs three times → it is the most common value.
  assert.strictEqual(result.stats.rating.top, '5');
  // The outlier (Beta's rating of 2) is the one that is not the mode.
  assert.strictEqual(result.stats.rating.unique, 2);

  /* -- 7. output shapes (WRS-05) ----------------------------------------- */
  const asReport = await wide.runWideResearch({
    instruction: 'x', items: ['one', 'two'], fields: ['price'], output: 'report',
  }, { sessionId: 'wr-session' }, async () => JSON.stringify({ summary: '{"price":"1"}' }));
  assert.match(asReport.report, /# Wide Research result/);
  assert.match(asReport.report, /## Findings/);
  assert.match(asReport.report, /\*\*price\*\*/);
  const asCsv = await wide.runWideResearch({
    instruction: 'x', items: ['one', 'two'], fields: ['price'], output: 'csv',
  }, { sessionId: 'wr-session' }, async () => JSON.stringify({ summary: '{"price":"1"}' }));
  assert.match(asCsv.csv, /item,price/);
  assert.match(asCsv.csv, /one,1/);

  /* -- 8. post-hoc refinement over a subset (WRS-10) --------------------- */
  const refined = await wide.runWideResearch({
    instruction: 'price only',
    items: [
      { id: 'a', label: 'Alpha', prompt: 'A' },
      { id: 'b', label: 'Beta', prompt: 'B' },
    ],
    fields: ['price'],
    refine: { items: ['b'], instruction: 'price AND currency' },
  }, { sessionId: 'wr-session' }, async (spec) => {
    // The refinement uses a different instruction for the targeted item.
    if (spec.description === 'Beta') {
      assert.match(spec.prompt, /price AND currency/);
      return JSON.stringify({ summary: '{"price":"20","currency":"EUR"}' });
    }
    return JSON.stringify({ summary: '{"price":"10"}' });
  });
  const beta = refined.matrix.find((row) => row.label === 'Beta');
  assert.strictEqual(beta.price, '20');
  assert.strictEqual(beta.currency, 'EUR', 'the refinement adds a column');
  const alphaRefined = refined.matrix.find((row) => row.label === 'Alpha');
  assert.strictEqual(alphaRefined.currency, undefined, 'untouched items are not re-run');
  assert.strictEqual(refined.matrix.length, 2);

  /* -- 9. the ZIP package (WRS-08) --------------------------------------- */
  const packaged = await wide.runWideResearch({
    instruction: 'x', items: ['one', 'two'], fields: ['price'], output: 'table', package: true,
  }, { sessionId: 'wr-session' }, async () => JSON.stringify({ summary: '{"price":"1"}' }));
  assert.ok(packaged.artifacts?.files?.length >= 3, 'csv, markdown and a zip');
  const zipPath = packaged.artifacts.files.find((f) => f.endsWith('.zip'));
  assert.ok(fs.existsSync(zipPath));
  const bytes = fs.readFileSync(zipPath);
  assert.strictEqual(bytes.readUInt32LE(0), 0x04034b50, 'a real ZIP local file header');
  assert.ok(bytes.includes(Buffer.from('PK')), 'the archive carries the PK signature');

  /* -- 10. the ZIP writer itself ---------------------------------------- */
  const archive = buildZip([{ name: 'a.txt', data: 'hello world' }, { name: 'b/c.txt', data: Buffer.from('x'.repeat(500)) }]);
  assert.strictEqual(archive.readUInt32LE(0), 0x04034b50);
  // The end-of-central-directory record is last.
  const eocdOffset = archive.length - 22;
  assert.strictEqual(archive.readUInt32LE(eocdOffset), 0x06054b50);
  assert.strictEqual(archive.readUInt16LE(eocdOffset + 8), 2, 'two entries');
  assert.ok(archive.length < 500 * 2, 'the long entry is deflated');
  assert.strictEqual(toCsv([['a', 'b,c'], ['d"e', 'f']]), 'a,"b,c"\r\n"d""e",f');

  /* -- 11. guard rails --------------------------------------------------- */
  const one = await wide.runWideResearch({ items: ['only one'] }, { sessionId: 'wr' }, async () => '{}');
  assert.match(one.error, /at least two items/);
  const none = await wide.runWideResearch({ items: [] }, { sessionId: 'wr' }, async () => '{}');
  assert.match(none.error, /at least one item/);
  const capped = await wide.runWideResearch(
    { items: ['a', 'b'], concurrency: 999 },
    { sessionId: 'wr' },
    async () => JSON.stringify({ summary: '{}' })
  );
  assert.strictEqual(capped.concurrency, wide.MAX_CONCURRENCY);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('wide-research test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
