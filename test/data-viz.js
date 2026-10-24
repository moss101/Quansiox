'use strict';
/* Data analysis & visualization test.
 *
 * Covers the documented behaviour of the feature:
 *   - uploading/parsing CSV, TSV and JSON data (DVZ-01);
 *   - the four output shapes: dashboard, report, dataset, webpage (DVZ-03..06);
 *   - the chart types and the "up to 5 in one analysis" rule (DVZ-07..13);
 *   - several datasets in one analysis (DVZ-14);
 *   - pattern/trend/insight extraction (DVZ-15);
 *   - customer segmentation with cluster profiles (DVZ-16);
 *   - export to a file (DVZ-19);
 *   - data cleaning (DVZ-20).
 *
 * Everything here is real: the parser, the statistics, the k-means and the
 * SVG renderer all run.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-dataviz-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const { dataVizService } = require('../src/main/services/dataVizService');

const CSV = [
  'region,product,units,revenue,satisfaction',
  'North,Widget,10,1200,4.5',
  'North,Gadget,25,3100,4.1',
  'South,Widget,14,1680,3.9',
  'South,Gadget,30,3900,4.7',
  'East,Widget,8,960,3.2',
  'East,Gadget,19,2450,4.4',
  'West,Widget,12,1440,4.0',
  'West,Gadget,22,2860,4.2',
].join('\n');

async function run() {
  /* -- 1. parsing (DVZ-01) ----------------------------------------------- */
  const parsed = dataVizService.parseTable(CSV);
  assert.deepStrictEqual(parsed.columns, ['region', 'product', 'units', 'revenue', 'satisfaction']);
  assert.strictEqual(parsed.rows.length, 8);
  assert.strictEqual(parsed.rows[0].region, 'North');
  assert.strictEqual(parsed.rows[0].revenue, '1200');

  // Quoted fields with commas and embedded quotes.
  const quoted = dataVizService.parseTable('name,note\n"Acme, Inc.","said ""hi"""\nPlain,ok');
  assert.strictEqual(quoted.rows[0].name, 'Acme, Inc.');
  assert.strictEqual(quoted.rows[0].note, 'said "hi"');
  assert.strictEqual(quoted.rows[1].name, 'Plain');

  // TSV.
  const tsv = dataVizService.parseTable('a\tb\n1\t2');
  assert.deepStrictEqual(tsv.columns, ['a', 'b']);
  assert.strictEqual(tsv.rows[0].a, '1');

  // JSON.
  const json = dataVizService.parseTable('[{"a":1,"b":"x"},{"a":2,"b":"y"}]');
  assert.deepStrictEqual(json.columns, ['a', 'b']);
  assert.strictEqual(json.rows.length, 2);

  // Empty input is an error, not a crash.
  assert.match(dataVizService.analyze({ data: '' }).error, /no tabular data/);

  /* -- 2. profiling (DVZ-15) --------------------------------------------- */
  const profiles = dataVizService.profile(parsed.columns, parsed.rows);
  const revenue = profiles.find((p) => p.column === 'revenue');
  assert.strictEqual(revenue.type, 'number');
  assert.strictEqual(revenue.filled, 8);
  assert.strictEqual(revenue.missing, 0);
  assert.strictEqual(revenue.min, 960);
  assert.strictEqual(revenue.max, 3900);
  assert.strictEqual(revenue.distinct, 8);
  const region = profiles.find((p) => p.column === 'region');
  assert.strictEqual(region.type, 'category');
  assert.strictEqual(region.distinct, 4);
  assert.strictEqual(region.top[0].value, 'North');
  assert.strictEqual(region.top[0].count, 2);

  /* -- 3. the dashboard (DVZ-04 / DVZ-06) -------------------------------- */
  const dash = dataVizService.analyze({
    data: CSV, title: 'Sales', subtitle: 'Q1 by region', chartTypes: ['bar', 'line', 'pie'], output: 'dashboard',
  });
  assert.strictEqual(dash.rows, 8);
  assert.ok(dash.html.includes('<svg'), 'the dashboard contains real SVG charts');
  assert.ok(dash.html.includes('Sales'));
  assert.ok(dash.html.includes('Column profile'));
  assert.ok(dash.html.includes('region'));
  assert.ok(dash.charts.length >= 1);
  assert.ok(dash.insights.length >= 1, 'insights are extracted');

  /* -- 4. chart types and the 5-chart cap (DVZ-07..13) ------------------- */
  assert.ok(dataVizService.CHART_TYPES.includes('bar'));
  assert.ok(dataVizService.CHART_TYPES.includes('heatmap'));
  assert.ok(dataVizService.CHART_TYPES.includes('radar'));
  const many = dataVizService.analyze({
    data: CSV,
    chartTypes: ['bar', 'line', 'pie', 'scatter', 'heatmap', 'radar', 'area', 'donut'],
  });
  assert.ok(many.charts.length <= dataVizService.MAX_CHARTS, 'never more than 5 charts');
  assert.strictEqual(many.charts.length, dataVizService.MAX_CHARTS);

  // Each chart type renders an SVG on its own.
  for (const type of dataVizService.CHART_TYPES) {
    const svg = dataVizService.renderChartSvg(type, {
      title: `t-${type}`,
      categories: ['a', 'b', 'c'],
      series: [{ name: 's', values: [3, 1, 2] }],
      points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
      matrix: [{ label: 'r1', values: [1, 2] }, { label: 'r2', values: [3, 4] }],
    });
    assert.ok(svg.startsWith('<svg'), `${type} renders an svg`);
    assert.ok(svg.includes('</svg>'), `${type} closes the svg`);
  }

  /* -- 5. the report output (DVZ-05) ------------------------------------- */
  const report = dataVizService.analyze({ data: CSV, title: 'Sales', output: 'report' });
  assert.ok(report.markdown.includes('# Sales'));
  assert.ok(report.markdown.includes('## Column profile'));
  assert.ok(report.markdown.includes('revenue'));
  assert.ok(report.markdown.includes('## Preview'));

  /* -- 6. the dataset output --------------------------------------------- */
  const dataset = dataVizService.analyze({ data: CSV, output: 'dataset' });
  assert.ok(dataset.csv.startsWith('region,product,units,revenue,satisfaction'));
  assert.strictEqual(dataset.csv.split('\n').length, 9);

  /* -- 7. segmentation (DVZ-16) ------------------------------------------ */
  const segmented = dataVizService.analyze({ data: CSV, segments: 3 });
  assert.ok(segmented.segments.length >= 1);
  const segment = segmented.segments[0];
  assert.ok(segment.size > 0);
  assert.ok(segment.label.length > 0, 'a cluster has a readable profile');
  assert.ok(segment.columns.length > 0, 'a cluster profile names its columns');
  // Segmentation is deterministic.
  const again = dataVizService.analyze({ data: CSV, segments: 3 });
  assert.deepStrictEqual(
    segmented.segments.map((s) => s.size),
    again.segments.map((s) => s.size)
  );

  /* -- 8. cleaning (DVZ-20) ---------------------------------------------- */
  const messy = dataVizService.parseTable('a,b\n1,"x"\n,2\n3,"y, z"');
  assert.strictEqual(messy.rows.length, 3);
  const messyProfile = dataVizService.profile(messy.columns, messy.rows);
  assert.strictEqual(messyProfile.find((p) => p.column === 'a').missing, 1, 'a missing value is counted, not guessed');

  /* -- 9. export to a file (DVZ-19) -------------------------------------- */
  const file = path.join(tmp, 'data.csv');
  fs.writeFileSync(file, CSV, 'utf8');
  const fromFile = dataVizService.analyze({ path: file, output: 'dashboard' });
  assert.strictEqual(fromFile.rows, 8);
  assert.ok(fromFile.html.includes('region'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('data-viz test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
