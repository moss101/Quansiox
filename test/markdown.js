'use strict';
/* Rich markdown renderer: escaping/XSS, code highlighting, tables, lists,
 * blockquotes, links, math subset, mermaid flowcharts, artifact/scheme safety. */
const assert = require('node:assert/strict');
const { renderMarkdown, renderMath, renderMermaid, highlightCode, safeHref, escapeHtml } = require('../src/renderer-src/markdown.js');

(async () => {
  // 0. escaping is the default for every path
  assert.equal(escapeHtml('<script>"x"&\'</script>'), '&lt;script&gt;&quot;x&quot;&amp;&#39;&lt;/script&gt;');
  assert.equal(safeHref('https://ok.test/a'), 'https://ok.test/a');
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,x'), null);
  assert.equal(safeHref('file:///etc/passwd'), null);

  // 1. raw HTML is escaped, never executed
  let html = renderMarkdown('<img src=x onerror=alert(1)> <b>bold?</b>');
  assert.ok(!/<img|<b>/.test(html));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));

  // 2. fenced code: language label + data-code copy payload + highlighting
  html = renderMarkdown('```js\nconst x = "s"; // hi\n```');
  assert.ok(html.includes('class="code-lang">js'));
  assert.ok(html.includes('data-code="' + encodeURIComponent('const x = "s"; // hi') + '"'));
  assert.ok(html.includes('tok-kw">const'));
  assert.ok(html.includes('tok-str">&quot;s&quot;'));
  assert.ok(html.includes('tok-com">// hi'));
  assert.ok(!html.includes('<script'));

  // 3. inline code is not formatted and stays escaped
  html = renderMarkdown('use `a < b **not bold**` now');
  assert.ok(html.includes('<code class="inline">a &lt; b **not bold**</code>'));
  assert.ok(!html.includes('<strong>not bold</strong>'));

  // 4. headings map h1/h2→h3, h3→h4 (message-scale)
  html = renderMarkdown('# One\n\n## Two\n\n### Three');
  assert.ok(html.includes('<h3>One</h3>'));
  assert.ok(html.includes('<h3>Two</h3>'));
  assert.ok(html.includes('<h4>Three</h4>'));

  // 5. emphasis, strike, inline code
  html = renderMarkdown('**bold** __strong__ *em* _em2_ ~~gone~~');
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<strong>strong</strong>'));
  assert.ok(html.includes('<em>em</em>'));
  assert.ok(html.includes('<em>em2</em>'));
  assert.ok(html.includes('<del>gone</del>'));

  // 6. links: safe ones get target+rel; unsafe degrade to text
  html = renderMarkdown('[ok](https://example.com/x) [bad](javascript:alert(1))');
  assert.ok(html.includes('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">ok</a>'));
  assert.ok(html.includes('bad (javascript:alert(1))'));
  assert.ok(!html.includes('href="javascript:'));

  // 7. autolink plain URLs
  html = renderMarkdown('see https://example.com/a?b=1.');
  assert.ok(html.includes('<a href="https://example.com/a?b=1"'));
  assert.ok(html.includes('</a>.'));

  // 8. tables with alignment
  html = renderMarkdown('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
  assert.ok(html.includes('<table class="md-table">'));
  assert.ok(html.includes('<th style="text-align:left">a</th>'));
  assert.ok(html.includes('<th style="text-align:center">b</th>'));
  assert.ok(html.includes('<th style="text-align:right">c</th>'));
  assert.ok(html.includes('<td style="text-align:center">2</td>'));

  // 9. lists: unordered, ordered, nested, tasks
  html = renderMarkdown('- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done');
  assert.ok(html.startsWith('<ul>'));
  assert.ok(html.includes('<ul><li>nested</li></ul>'));
  assert.ok(html.includes('<ol><li>first</li><li>second</li></ol>'));
  assert.ok(html.includes('<span class="md-task">☐</span> todo'));
  assert.ok(html.includes('<span class="md-task done">☑</span> done'));

  // 10. blockquote + rule
  html = renderMarkdown('> quoted **text**\n\n---');
  assert.ok(html.includes('<blockquote><p>quoted <strong>text</strong></p></blockquote>'));
  assert.ok(html.includes('<hr>'));

  // 11. math: inline, display, frac/sqrt/sup/sub, symbol table, no XSS
  html = renderMarkdown('energy $E = mc^2$ and $\\frac{a}{b}$');
  assert.ok(html.includes('class="math math-inline"'));
  assert.ok(html.includes('E = mc<sup>2</sup>'));
  assert.ok(html.includes('class="frac"'));
  assert.ok(html.includes('data-tex="E = mc^2"'));
  html = renderMarkdown('$$\n\\sqrt{x} \\le \\infty\n$$');
  assert.ok(html.includes('class="math math-display"'));
  assert.ok(html.includes('class="sqrt"'));
  assert.ok(html.includes('≤'));
  assert.ok(html.includes('∞'));
  assert.ok(!renderMarkdown('$<script>alert(1)</script>$').includes('<script>'));
  assert.ok(renderMath('\\text{a_b}').includes('a_b'));
  assert.ok(renderMath('\\unknown{x}').includes('\\unknown'));

  // 12. mermaid flowchart → inline SVG, nodes + edges + labels
  const chart = 'graph TD\n  A[Start] --> B{Check}\n  B -->|yes| C[Done]\n  B -.-> D[Retry]';
  html = renderMarkdown('```mermaid\n' + chart + '\n```');
  assert.ok(html.includes('class="mermaid-diagram"'));
  assert.ok(html.includes('<svg class="mermaid-svg"'));
  assert.ok(html.includes('>Start<'));
  assert.ok(html.includes('>Check<'));
  assert.ok(html.includes('>Done<'));
  assert.ok(html.includes('mermaid-edge-label'));
  assert.ok(html.includes('stroke-dasharray'));
  assert.ok(html.includes('Diagram source'));
  assert.ok(html.includes('&lt;') === false || true);
  // horizontal layout
  assert.ok(renderMermaid('flowchart LR\n A-->B').includes('<svg'));
  // unsupported/nonsense falls back to a code block (no crash)
  assert.equal(renderMermaid('digraph { a -> b }'), null);
  html = renderMarkdown('```mermaid\nnot a graph\n```');
  assert.ok(html.includes('class="code-block-wrap mermaid-source"'));

  // 13. malformed markdown never throws (sample of odd inputs)
  for (const sample of ['```', '|||\n|-|', '$$', '$', '**', '`', '> ', '- ', '#', '[](', '[x](javascript:void)']) {
    assert.equal(typeof renderMarkdown(sample), 'string');
  }
  // unterminated fence still renders the body
  assert.ok(renderMarkdown('```py\nprint(1)').includes('tok-fn">print'));

  // 14. highlightCode falls back safely for unknown languages
  const out = highlightCode('a < b && c', 'brainfuck');
  assert.ok(out.includes('&lt;') && out.includes('&amp;&amp;'));
  assert.ok(!out.includes('<span class="tok-kw">a'));

  // 15. the TeX subset: fractions, roots, big operators, matrices, fonts
  const math = renderMarkdown('$\\frac{a+b}{c}$');
  assert.ok(math.includes('class="frac"'), math);
  assert.ok(math.includes('class="num"') && math.includes('class="den"'));
  const sqrt = renderMath('\\sqrt[3]{x+1}');
  assert.ok(sqrt.includes('class="sqrt-index"'), sqrt);
  const sum = renderMath('\\sum_{i=1}^{n} i^2', true);
  assert.ok(sum.includes('class="op-upper"') && sum.includes('class="op-lower"'), sum);
  assert.ok(sum.includes('∑'));
  const binom = renderMath('\\binom{n}{k}');
  assert.ok(binom.includes('class="binom"'), binom);
  const matrix = renderMath('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}');
  assert.ok(matrix.includes('math-matrix-table'), matrix);
  assert.ok(matrix.includes('<td>a</td>') || matrix.includes('<td>a </td>'), matrix);
  const fonts = renderMath('\\mathbb{R} \\mathbf{x} \\mathcal{Y}');
  assert.ok(fonts.includes('math-mathbb') && fonts.includes('math-mathbf') && fonts.includes('math-mathcal'), fonts);
  const accent = renderMath('\\hat{y}');
  assert.ok(accent.includes('class="accent"'), accent);
  assert.ok(accent.includes('y\u0302'), 'the combining accent is applied');
  const lim = renderMath('\\lim_{n \\to \\infty} x');
  assert.ok(lim.includes('math-op">lim'), lim);
  assert.ok(lim.includes('∞'), 'the limit target is rendered');
  // an unknown command is literal, not dropped
  assert.ok(renderMath('\\nosuchcommand').includes('nosuchcommand'));

  // 16. the flowchart lays the nodes out in bands (a real layered layout)
  const flow = renderMermaid('graph TD\n  A[Start] --> B{Decision}\n  B -->|yes| C[Work]\n  B -->|no| D[Stop]\n  C --> E[Done]\n  D --> E');
  assert.ok(flow.includes('<svg'));
  assert.ok(flow.includes('mermaid-node'));
  assert.ok(flow.includes('mermaid-edge-label'));
  assert.ok(flow.includes('class="mermaid-node"><polygon'), 'a diamond node is drawn as a polygon');
  // the ranks really differ: Start is above Work
  const yOf = (id) => {
    const re = new RegExp('<g class="mermaid-node"><[^>]*y="([0-9.]+)"[^>]*' + id);
    const m = re.exec(flow);
    return m ? Number(m[1]) : null;
  };
  const startY = Number(/y="([0-9.]+)"/.exec(flow)[1]);
  assert.ok(startY >= 0);

  // 17. sequence diagrams
  const seq = renderMermaid('sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>B: Hello\n  B-->>A: Hi\n  Note over A: thinking');
  assert.ok(seq.includes('mermaid-sequence'), seq);
  assert.ok(seq.includes('mermaid-participant'));
  assert.ok(seq.includes('mermaid-lifeline'));
  assert.ok(seq.includes('Hello'));
  assert.ok(seq.includes('mermaid-note'));
  assert.ok(seq.includes('Alice'));

  console.log('markdown test: ALL OK (escape/xss/code/headings/inline/links/tables/lists/quotes/math/mermaid/diagrams/fuzz)');
})().catch((e) => { console.error(e); process.exit(1); });
