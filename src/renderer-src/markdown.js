'use strict';
/**
 * Renderer-side markdown. Dependency-free and safe by construction: every
 * piece of user/model text is HTML-escaped before any tag is emitted, link
 * targets are restricted to http(s)/mailto, and remote images are never
 * fetched (they render as link chips instead — privacy + no exfiltration).
 *
 * Supports: fenced code with lightweight syntax highlighting, headings,
 * lists (incl. tasks + nesting), blockquotes, tables, rules, links/autolinks,
 * bold/italic/strike/inline code, inline + display math (small TeX subset),
 * mermaid-style flowcharts, and artifact chips.
 *
 * Plain CommonJS so the same code runs in the esbuild bundle and in node tests.
 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const SAFE_SCHEME = /^(https?:|mailto:)/i;

function safeHref(raw) {
  const url = String(raw ?? '').trim();
  if (!url) return null;
  if (SAFE_SCHEME.test(url)) return url;
  return null;
}

/* ---------------- syntax highlighting ---------------- */

const KEYWORDS = {
  js: 'const let var function return if else for while do switch case break continue class extends new this super async await try catch finally throw typeof instanceof in of delete void yield import export from default static get set null true false undefined',
  ts: 'const let var function return if else for while do switch case break continue class extends new this super async await try catch finally throw typeof instanceof in of delete void yield import export from default static get set null true false undefined interface type enum implements readonly public private protected namespace declare as satisfies',
  py: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False self async await',
  sh: 'if then else elif fi for while do done case esac function return in export local readonly echo cd set unset source exit sudo',
  json: 'true false null',
  sql: 'select from where join left right inner outer on group by order limit insert into values update set delete create table alter drop index view as and or not null primary key foreign references distinct count sum avg min max',
  html: '',
  css: '',
  go: 'package import func return if else for range switch case break continue type struct interface map chan go defer select var const nil true false',
  rust: 'fn let mut pub use crate mod impl trait struct enum match if else loop while for in return self Self where async await move ref dyn const static unsafe type as true false None Some Ok Err',
};
KEYWORDS.javascript = KEYWORDS.js;
KEYWORDS.typescript = KEYWORDS.ts;
KEYWORDS.python = KEYWORDS.py;
KEYWORDS.bash = KEYWORDS.sh;
KEYWORDS.shell = KEYWORDS.sh;
KEYWORDS.zsh = KEYWORDS.sh;

function highlightCode(code, langRaw) {
  const lang = String(langRaw || '').toLowerCase();
  const keywords = new Set((KEYWORDS[lang] ?? '').split(/\s+/).filter(Boolean));
  const lineComment = ['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'rb', 'ruby', 'yaml', 'yml', 'toml'].includes(lang) ? '#' : '//';
  const source = String(code ?? '');
  let out = '';
  let i = 0;
  const n = source.length;
  const isIdent = (c) => /[A-Za-z_$]/.test(c);
  const isWord = (c) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    // comments
    if (lineComment === '#' ? ch === '#' : two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += `<span class="tok-com">${escapeHtml(source.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += `<span class="tok-com">${escapeHtml(source.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    // strings (template literals keep their ${} intact as tokens are not parsed)
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && source[j] !== ch) {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      const stop = Math.min(n, j + 1);
      out += `<span class="tok-str">${escapeHtml(source.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    // numbers
    if (/[0-9]/.test(ch) && !isWord(source[i - 1] ?? '')) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX._eE+-]/.test(source[j])) j += 1;
      out += `<span class="tok-num">${escapeHtml(source.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // identifiers / keywords
    if (isIdent(ch)) {
      let j = i + 1;
      while (j < n && isWord(source[j])) j += 1;
      const word = source.slice(i, j);
      if (keywords.has(word)) out += `<span class="tok-kw">${escapeHtml(word)}</span>`;
      else if (source[j] === '(') out += `<span class="tok-fn">${escapeHtml(word)}</span>`;
      else out += escapeHtml(word);
      i = j;
      continue;
    }
    out += escapeHtml(ch);
    i += 1;
  }
  return out;
}

/* ---------------- math (a real TeX subset) ---------------- */

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ',
  psi: 'ψ', omega: 'ω', varepsilon: 'ε', vartheta: 'ϑ', varphi: 'φ',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const SYMBOLS = {
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', le: '≤', leq: '≤',
  ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼',
  simeq: '≃', cong: '≅', propto: '∝', infty: '∞', partial: '∂', nabla: '∇',
  rightarrow: '→', to: '→', leftarrow: '←', gets: '←', Rightarrow: '⇒',
  Leftarrow: '⇐', Leftrightarrow: '⇔', leftrightarrow: '↔', implies: '⟹',
  mapsto: '↦', forall: '∀', exists: '∃', nexists: '∄', in: '∈', notin: '∉',
  ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', neg: '¬', lnot: '¬',
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…',
  aleph: 'ℵ', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', prime: '′',
  therefore: '∴', because: '∵', angle: '∠', perp: '⊥', parallel: '∥',
  therefore_: '∴', oplus: '⊕', ominus: '⊖', otimes: '⊗', odot: '⊙',
  star: '⋆', dagger: '†', section: '§', paragraph: '¶', degree: '°',
  colon: ':', quad: ' ', qquad: '  ', thinspace: ' ', medspace: ' ',
  lbrace: '{', rbrace: '}', backslash: '\\', vert: '|', Vert: '‖',
};

/** Upright function names. */
const FUNCS = {
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan', sinh: 'sinh',
  cosh: 'cosh', tanh: 'tanh', exp: 'exp', ln: 'ln', log: 'log', lg: 'lg',
  det: 'det', dim: 'dim', ker: 'ker', deg: 'deg', gcd: 'gcd', arg: 'arg',
  hom: 'hom', lim: 'lim', limsup: 'lim sup', liminf: 'lim inf', Pr: 'Pr',
  mod: 'mod', inf: 'inf', sup: 'sup', max: 'max', min: 'min',
};

/** Operators that take limits above and below in display mode. */
const BIG_OPS = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭',
  oint: '∮', bigcup: '⋃', bigcap: '⋂', bigsqcup: '⨆', bigoplus: '⨁',
  bigotimes: '⨂', bigodot: '⨀', biguplus: '⨄',
};

/** Combining marks for the accents. */
const ACCENTS = {
  hat: '̂', widehat: '̂', bar: '̄', overline: '̄', vec: '⃗',
  tilde: '̃', widetilde: '̃', dot: '̇', ddot: '̈', check: '̌',
  breve: '̆', acute: '́', grave: '̀',
};

/** Font commands. */
const FONTS = {
  mathbb: 'bb', mathbf: 'bf', mathit: 'it', mathcal: 'cal',
  mathrm: 'rm', mathsf: 'sf', mathtt: 'tt', boldsymbol: 'bf', pmb: 'bf',
};

const FONT_CLASS = { bb: 'math-mathbb', bf: 'math-mathbf', it: 'math-mathit', cal: 'math-mathcal', rm: 'math-mathrm', sf: 'math-sans', tt: 'math-mono' };

/** Render a TeX subset; never throws and always escapes literal text. */
function renderMath(texRaw, display = false) {
  const tex = String(texRaw ?? '').trim();
  if (!tex) return '';
  const cls = display ? 'math math-display' : 'math math-inline';
  return '<span class="' + cls + '" data-tex="' + escapeHtml(tex) + '">' + mathBody(tex, display) + '</span>';
}

/**
 * The TeX parser.
 *
 * It understands the constructs that actually show up in a chat answer:
 * fractions, roots (with an index), big operators with limits, binomials,
 * matrices, sub/superscripts, accents, fonts, upright function names and the
 * usual symbol zoo. Anything it does not know is rendered as literal text
 * rather than dropped.
 */
function mathBody(tex, display = false) {
  try {
    const state = { tex: String(tex ?? ''), i: 0, display: Boolean(display) };
    const out = parseSequence(state, null);
    return out;
  } catch {
    return escapeHtml(String(tex ?? ''));
  }
}

/** Read a {...} group (or a single character) — returns the raw source. */
function readGroup(state) {
  const { tex } = state;
  if (state.i >= tex.length) return null;
  if (tex[state.i] !== '{') {
    const ch = tex[state.i];
    state.i += 1;
    return ch;
  }
  let depth = 0;
  const start = state.i + 1;
  while (state.i < tex.length) {
    if (tex[state.i] === '{') depth += 1;
    else if (tex[state.i] === '}') {
      depth -= 1;
      if (depth === 0) { state.i += 1; return tex.slice(start, state.i - 1); }
    }
    state.i += 1;
  }
  return null;
}

/**
 * The raw source of one atom: a braced group, a command, or a character.
 */
function readRawArgument(state) {
  const { tex } = state;
  if (state.i >= tex.length) return '';
  if (tex[state.i] === '{') return readGroup(state) ?? '';
  if (tex[state.i] === '\\') {
    const m = /^\\([A-Za-z]+|.)/.exec(tex.slice(state.i));
    if (m) { state.i += m[0].length; return '\\' + m[1]; }
  }
  const ch = tex[state.i];
  state.i += 1;
  return ch;
}

/**
 * The argument of a ^ or _ — exactly one atom, as in TeX: a command, a
 * braced group, or a single character.
 */
function readArgument(state) {
  const { tex } = state;
  if (state.i >= tex.length) return '';
  if (tex[state.i] === '{') {
    const group = readGroup(state);
    return mathBody(group ?? '', false);
  }
  if (tex[state.i] === '\\') {
    const m = /^\\([A-Za-z]+|.)/.exec(tex.slice(state.i));
    if (m) {
      state.i += m[0].length;
      const name = m[1];
      if (GREEK[name]) return '<span class="math-greek">' + GREEK[name] + '</span>';
      if (SYMBOLS[name]) return escapeHtml(SYMBOLS[name]);
      if (BIG_OPS[name]) return '<span class="big-op">' + escapeHtml(BIG_OPS[name]) + '</span>';
      if (FUNCS[name]) return '<span class="math-op">' + escapeHtml(FUNCS[name]) + '</span>';
      if (name === '{' || name === '}' || name === '%' || name === '_' || name === '&') return escapeHtml(name);
      if (name === ',' || name === ';') return ' ';
      return escapeHtml('\\' + name);
    }
  }
  const ch = tex[state.i];
  state.i += 1;
  return escapeHtml(ch);
}

/** Parse until the end of the source or a closing brace / \\\\ in a matrix. */
function parseSequence(state, stopAt) {
  let out = '';
  while (state.i < state.tex.length) {
    const ch = state.tex[state.i];
    if (stopAt === '}' && ch === '}') break;
    if (stopAt === 'row' && ch === '\\') break;
    if (ch === '}') { out += escapeHtml('}'); state.i += 1; continue; }
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(state.tex.slice(state.i));
      if (!m) { out += escapeHtml('\\'); state.i += 1; continue; }
      const name = m[1];
      state.i += m[0].length;
      if (name === '\\') { out += '\\\\'; continue; }         // a row break
      if (name === '{' || name === '}' || name === '%' || name === '_' || name === '&' || name === '#') {
        out += escapeHtml(name); continue;
      }
      if (name === ',' || name === ';' || name === ' ' || name === ':') { out += ' '; continue; }
      if (name === 'left' || name === 'right') {
        const delim = readGroup(state);
        const glyph = { '(': '⟨', ')': '⟩', '[': '[', ']': ']', '|': '|', '.': '' }[delim] ?? (delim ?? '');
        out += escapeHtml(glyph);
        continue;
      }
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'binom' || name === 'dbinom' || name === 'choose') {
        const a = readGroup(state);
        const b = readGroup(state);
        if (a == null || b == null) { out += escapeHtml('\\' + name); continue; }
        const top = mathBody(a, state.display);
        const bottom = mathBody(b, state.display);
        if (name === 'binom' || name === 'dbinom' || name === 'choose') {
          out += '<span class="binom"><span class="paren">(</span><span class="binom-body"><span class="num">' + top + '</span><span class="den">' + bottom + '</span></span><span class="paren">)</span></span>';
        } else {
          out += '<span class="frac"><span class="num">' + top + '</span><span class="den">' + bottom + '</span></span>';
        }
        continue;
      }
      if (name === 'sqrt') {
        // an optional index comes first
        let index = null;
        if (state.tex[state.i] === '[') {
          const close = state.tex.indexOf(']', state.i);
          if (close !== -1) { index = state.tex.slice(state.i + 1, close); state.i = close + 1; }
        }
        const body = readGroup(state);
        if (body == null) { out += escapeHtml('\\sqrt'); continue; }
        const radical = '<span class="sqrt">√<span class="radicand">' + mathBody(body, state.display) + '</span></span>';
        out += index == null ? radical : '<span class="sqrt-index">' + mathBody(index, state.display) + radical + '</span>';
        continue;
      }
      if (name === 'text' || name === 'textrm' || name === 'textbf' || name === 'textit' || name === 'mbox') {
        const body = readGroup(state);
        out += '<span class="math-text">' + escapeHtml((body ?? '').replace(/[_-]/g, ' ')) + '</span>';
        continue;
      }
      if (name === 'operatorname' || name === 'operatorname*') {
        const body = readGroup(state);
        out += '<span class="math-op">' + escapeHtml(body ?? '') + '</span>';
        continue;
      }
      if (name === 'begin' || name === 'end') {
        const env = readGroup(state);
        if (name === 'end') { out += parseEnvironmentEnd(state, env); continue; }
        out += parseEnvironment(state, env);
        continue;
      }
      if (FONTS[name]) {
        const body = readGroup(state);
        if (body == null) { out += escapeHtml('\\' + name); continue; }
        out += '<span class="' + FONT_CLASS[FONTS[name]] + '">' + mathBody(body, state.display) + '</span>';
        continue;
      }
      if (ACCENTS[name]) {
        const body = readGroup(state);
        if (body == null) { out += escapeHtml('\\' + name); continue; }
        out += '<span class="accent">' + mathBody(body, state.display) + FONT_COMBINING[name] + '</span>';
        continue;
      }
      if (BIG_OPS[name]) {
        const op = BIG_OPS[name];
        // limits above and below in display mode
        let lower = null; let upper = null;
        for (;;) {
          const save = state.i;
          const ch2 = state.tex[state.i];
          if (ch2 === '_') { state.i += 1; lower = readRawArgument(state); continue; }
          if (ch2 === '^') { state.i += 1; upper = readRawArgument(state); continue; }
          state.i = save;
          break;
        }
        const glyph = '<span class="big-op">' + escapeHtml(op) + '</span>';
        if (state.display) {
          out += '<span class="big-op-wrap"><span class="op-upper">' + (upper == null ? '' : mathBody(upper, false)) + '</span>' + glyph + '<span class="op-lower">' + (lower == null ? '' : mathBody(lower, false)) + '</span></span>';
        } else {
          out += glyph
            + (upper == null ? '' : '<sup>' + mathBody(upper, false) + '</sup>')
            + (lower == null ? '' : '<sub>' + mathBody(lower, false) + '</sub>');
        }
        continue;
      }
      if (FUNCS[name]) {
        // A function name is upright and takes no arguments.
        out += '<span class="math-op">' + escapeHtml(FUNCS[name]) + '</span>';
        continue;
      }
      if (GREEK[name]) { out += '<span class="math-greek">' + GREEK[name] + '</span>'; continue; }
      if (SYMBOLS[name]) { out += escapeHtml(SYMBOLS[name]); continue; }
      if (name === 'quad') { out += '&nbsp;&nbsp;'; continue; }
      if (name === 'qquad') { out += '&nbsp;&nbsp;&nbsp;&nbsp;'; continue; }
      if (name === 'hspace') { const w = readGroup(state); out += w ? escapeHtml(w) : ''; continue; }
      if (name === 'boxed') {
        const body = readGroup(state);
        out += '<span class="math-boxed">' + mathBody(body ?? '', state.display) + '</span>';
        continue;
      }
      if (name === 'overline' || name === 'underline') {
        const body = readGroup(state);
        out += '<span class="math-' + name + '">' + mathBody(body ?? '', state.display) + '</span>';
        continue;
      }
      if (name === 'label' || name === 'notag' || name === 'nonumber' || name === 'displaystyle') { continue; }
      out += escapeHtml('\\' + name);
      continue;
    }
    if (ch === '^' || ch === '_') {
      state.i += 1;
      const body = readArgument(state);
      out += ch === '^' ? '<sup>' + body + '</sup>' : '<sub>' + body + '</sub>';
      continue;
    }
    if (ch === '{') {
      const body = readGroup(state);
      out += mathBody(body ?? '', state.display);
      continue;
    }
    if (ch === '&') { state.i += 1; continue; }   // alignment marker
    if (ch === '*') { out += '·'; state.i += 1; continue; }
    out += escapeHtml(ch);
    state.i += 1;
  }
  return out;
}

/** Combining marks for the accents (used above). */
const FONT_COMBINING = {
  hat: '̂', widehat: '̂', bar: '̄', overline: '̄', vec: '⃗',
  tilde: '̃', widetilde: '̃', dot: '̇', ddot: '̈', check: '̌',
  breve: '̆', acute: '́', grave: '̀',
};

/** The closing bracket of an environment. */
function parseEnvironmentEnd(state, env) {
  const closers = {
    pmatrix: ')', bmatrix: ']', bmatrixr: ']', vmatrix: '|', Vmatrix: '‖',
    matrix: '', smallmatrix: '', cases: '', aligned: '', align: '',
    gather: '', gathered: '', split: '', array: '',
  };
  const closer = closers[String(env ?? '')] ?? '';
  return closer ? '<span class="math-delim">' + escapeHtml(closer) + '</span>' : '';
}

/**
 * A matrix / cases / aligned environment.
 *
 * The rows are separated by \\ and the columns by &, exactly like LaTeX.
 */
function parseEnvironment(state, env) {
  const name = String(env ?? '').trim();
  const source = readRawEnvironment(state, name);
  if (source == null) return escapeHtml('\\begin{' + name + '}');
  const rows = source.split(/\\\\/).map((r) => r.trim()).filter((r, idx, arr) => r !== '' || arr.length === 1);
  const cells = rows.map((row) => row.split('&').map((c) => mathBody(c, state.display)));

  if (name === 'cases' || name === 'aligned' || name === 'align' || name === 'gathered' || name === 'gather' || name === 'split') {
    const body = cells.map((row) => '<span class="env-row">' + row.join('') + '</span>').join('');
    return '<span class="math-env math-' + escapeHtml(name) + '">' + body + '</span>';
  }

  const delims = {
    pmatrix: ['(', ')'], bmatrix: ['[', ']'], bmatrixr: [']', '['],
    vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], matrix: ['', ''], smallmatrix: ['', ''],
  };
  const [open, close] = delims[name] ?? ['', ''];
  const body = cells.map((row) => '<tr>' + row.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('');
  return '<span class="math-matrix">' + escapeHtml(open) + '<table class="math-matrix-table"><tbody>' + body + '</tbody></table>' + escapeHtml(close) + '</span>';
}

/** Read the raw body of an environment (up to the matching \end). */
function readRawEnvironment(state, name) {
  const marker = '\\end{' + name + '}';
  const close = state.tex.indexOf(marker, state.i);
  if (close === -1) return null;
  const body = state.tex.slice(state.i, close);
  state.i = close + marker.length;
  return body;
}

/* ---------------- mermaid-style diagrams ---------------- */

/**
 * A dependency-free diagram renderer.
 *
 * Two dialects are supported:
 *  - flowcharts (graph / flowchart) with a real layered layout: the nodes
 *    are ranked by their longest path from a source and laid out in bands,
 *    so the picture actually reflects the structure;
 *  - sequence diagrams (sequenceDiagram) with participants, lifelines,
 *    messages, notes and alt/else blocks.
 *
 * Anything else falls back to a plain code block.
 */
function renderMermaid(codeRaw) {
  const lines = String(codeRaw ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  if (/^sequenceDiagram\b/i.test(first)) return renderSequenceDiagram(lines, codeRaw);
  const header = /^(graph|flowchart)\s+(TD|TB|LR|BT|RL)\b/i.exec(first);
  if (!header) return null;
  const dir = header[2].toUpperCase();
  const horizontal = dir === 'LR' || dir === 'RL';
  return renderFlowchart(lines.slice(1), dir, horizontal, codeRaw);
}

/** The shapes a node can have. */
function parseNode(text) {
  const raw = String(text ?? '').trim();
  const idMatch = /^([A-Za-z0-9_]+)/.exec(raw);
  const id = idMatch ? idMatch[1] : raw;
  let label = '';
  let shape = 'rect';
  const rest = raw.slice(id.length).trim();
  const shapes = [
    [/\[\[(.*)\]\]$/s, 'subroutine'],
    [/\(\((.*)\)\)$/s, 'circle'],
    [/\(\[(.*)\]\)$/s, 'stadium'],
    [/\[(.*)\]$/s, 'rect'],
    [/\((.*)\)$/s, 'round'],
    [/\{(.*)\}$/s, 'diamond'],
    [/>(.*)\]$/s, 'flag'],
  ];
  for (const [pattern, kind] of shapes) {
    const m = pattern.exec(rest);
    if (m) { shape = kind; label = m[1]; break; }
  }
  if (!label) label = rest.replace(/^[[({>]+/, '').replace(/[\])}]+$/, '');
  label = label.replace(/^["']|["']$/g, '').trim() || id;
  return { id, label, shape };
}

function renderFlowchart(lines, dir, horizontal, codeRaw) {
  const nodes = new Map();
  const edges = [];
  const addNode = (node) => {
    const existing = nodes.get(node.id);
    if (!existing) nodes.set(node.id, { ...node });
    else if (node.label && node.label !== node.id) existing.label = node.label;
  };

  for (const line of lines) {
    if (/^(subgraph|end|classDef|class|style|click|linkStyle|direction)\b/i.test(line)) continue;
    const edge = /^(.+?)\s*(-{2,}>|-{3,}|={2,}>|-\.->|--x|-->|---|-\.-)\s*(?:\|([^|]*)\|\s*)?(.+)$/.exec(line);
    if (edge) {
      const left = parseNode(edge[1]);
      const right = parseNode(edge[4]);
      if (!left.id || !right.id) continue;
      addNode(left); addNode(right);
      const arrow = edge[2];
      edges.push({
        from: left.id,
        to: right.id,
        label: (edge[3] ?? '').trim(),
        dashed: arrow.includes('-.') || arrow === '--x',
        thick: arrow.startsWith('='),
      });
      continue;
    }
    const node = parseNode(line);
    if (node.id) addNode(node);
  }
  if (!nodes.size) return null;

  const list = [...nodes.values()];
  const ids = list.map((n) => n.id);
  const rank = assignRanks(ids, edges);

  // group by rank
  const bands = new Map();
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    if (!bands.has(r)) bands.set(r, []);
    bands.get(r).push(id);
  }
  const ranks = [...bands.keys()].sort((a, b) => a - b);

  // size the nodes
  for (const node of list) {
    const chars = Math.max(4, Math.min(22, node.label.length));
    node.w = Math.max(78, chars * 7.4 + 26);
    node.h = node.shape === 'diamond' ? 46 : 36;
  }

  const GAP_MAIN = 58;
  const GAP_CROSS = 26;
  const PAD = 20;

  // position
  const pos = new Map();
  let maxCross = 0;
  const bandSizes = ranks.map((r) => {
    const row = bands.get(r);
    const total = row.reduce((sum, id) => sum + (nodes.get(id).w + GAP_CROSS), 0) - GAP_CROSS;
    maxCross = Math.max(maxCross, total);
    return total;
  });
  const crossTotal = maxCross;
  const mainTotal = ranks.reduce((sum, r, index) => sum + bandSizes[index] + GAP_MAIN, 0) - GAP_MAIN;

  ranks.forEach((r, bandIndex) => {
    const row = bands.get(r);
    const rowWidth = bandSizes[bandIndex];
    let offset = (crossTotal - rowWidth) / 2;
    for (const id of row) {
      const node = nodes.get(id);
      const cross = offset + node.w / 2;
      const main = bandIndex * (GAP_MAIN + 44);
      pos.set(id, horizontal
        ? { x: main, y: cross - node.h / 2, w: node.w, h: node.h }
        : { x: cross - node.w / 2, y: main, w: node.w, h: node.h });
      offset += node.w + GAP_CROSS;
    }
  });

  const width = horizontal ? mainTotal + PAD * 2 : crossTotal + PAD * 2;
  const height = horizontal ? crossTotal + PAD * 2 : mainTotal + PAD * 2;
  const label = (t) => escapeHtml(String(t ?? '')).slice(0, 40);
  const cx = (p) => p.x + p.w / 2;
  const cy = (p) => p.y + p.h / 2;

  let svg = '<svg class="mermaid-svg" viewBox="0 0 ' + Math.max(width, 80) + ' ' + Math.max(height, 60) + '" role="img" aria-label="diagram" xmlns="http://www.w3.org/2000/svg">';
  svg += '<defs>'
    + '<marker id="qx-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker>'
    + '<marker id="qx-arrow-open" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M1,1 L8,4.5 L1,8" fill="none" stroke="currentColor" stroke-width="1.3"/></marker>'
    + '</defs>';

  // edges first (under the nodes)
  for (const e of edges) {
    const a = pos.get(e.from); const b = pos.get(e.to);
    if (!a || !b) continue;
    const marker = e.dashed ? 'url(#qx-arrow-open)' : 'url(#qx-arrow)';
    const stroke = e.thick ? ' stroke-width="2.4"' : '';
    const dash = e.dashed ? ' stroke-dasharray="5 4"' : '';
    let path = ''; let lx = 0; let ly = 0;
    if (horizontal) {
      const x1 = a.x + a.w; const y1 = cy(a);
      const x2 = b.x; const y2 = cy(b);
      if (b.x >= a.x + a.w) {
        const mid = (x1 + x2) / 2;
        path = 'M' + x1 + ' ' + y1 + ' L' + mid + ' ' + y1 + ' L' + mid + ' ' + y2 + ' L' + x2 + ' ' + y2;
        lx = mid; ly = (y1 + y2) / 2 - 5;
      } else {
        const detour = Math.max(a.y, b.y) + 34;
        path = 'M' + x1 + ' ' + y1 + ' C' + (x1 + 26) + ' ' + (y1 + 40) + ' ' + (x2 - 26) + ' ' + (detour + 20) + ' ' + x2 + ' ' + y2;
        lx = (x1 + x2) / 2; ly = detour;
      }
    } else {
      const x1 = cx(a); const y1 = a.y + a.h;
      const x2 = cx(b); const y2 = b.y;
      if (b.y >= a.y + a.h) {
        const mid = (y1 + y2) / 2;
        path = 'M' + x1 + ' ' + y1 + ' L' + x1 + ' ' + mid + ' L' + x2 + ' ' + mid + ' L' + x2 + ' ' + y2;
        lx = (x1 + x2) / 2; ly = mid - 5;
      } else {
        const detour = Math.min(a.x, b.x) - 30;
        path = 'M' + x1 + ' ' + y1 + ' C' + (x1 + 30) + ' ' + (y1 + 24) + ' ' + (detour - 20) + ' ' + (y2 + 30) + ' ' + x2 + ' ' + y2;
        lx = detour; ly = (y1 + y2) / 2;
      }
    }
    svg += '<path class="mermaid-edge" d="' + path + '" fill="none" marker-end="' + marker + '"' + dash + stroke + '/>';
    if (e.label) svg += '<text class="mermaid-edge-label" x="' + lx + '" y="' + ly + '" text-anchor="middle">' + label(e.label) + '</text>';
  }

  // nodes
  for (const node of list) {
    const p = pos.get(node.id);
    svg += '<g class="mermaid-node">';
    if (node.shape === 'diamond') {
      const cxm = p.x + p.w / 2; const cym = p.y + p.h / 2;
      svg += '<polygon points="' + cxm + ',' + p.y + ' ' + (p.x + p.w) + ',' + cym + ' ' + cxm + ',' + (p.y + p.h) + ' ' + p.x + ',' + cym + '"/>';
    } else if (node.shape === 'circle') {
      svg += '<ellipse cx="' + (p.x + p.w / 2) + '" cy="' + (p.y + p.h / 2) + '" rx="' + (p.w / 2) + '" ry="' + (p.h / 2) + '"/>';
    } else if (node.shape === 'stadium') {
      svg += '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '" rx="' + (p.h / 2) + '"/>';
    } else if (node.shape === 'subroutine') {
      svg += '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '" rx="6"/>';
      svg += '<line x1="' + (p.x + 8) + '" y1="' + p.y + '" x2="' + (p.x + 8) + '" y2="' + (p.y + p.h) + '"/>';
      svg += '<line x1="' + (p.x + p.w - 8) + '" y1="' + p.y + '" x2="' + (p.x + p.w - 8) + '" y2="' + (p.y + p.h) + '"/>';
    } else if (node.shape === 'flag') {
      svg += '<path d="M' + p.x + ' ' + p.y + ' L' + (p.x + p.w) + ' ' + p.y + ' L' + (p.x + p.w - 10) + ' ' + (p.y + p.h / 2) + ' L' + (p.x + p.w) + ' ' + (p.y + p.h) + ' L' + p.x + ' ' + (p.y + p.h) + ' Z"/>';
    } else {
      svg += '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '" rx="' + (node.shape === 'round' ? 16 : 6) + '"/>';
    }
    svg += '<text x="' + (p.x + p.w / 2) + '" y="' + (p.y + p.h / 2 + 4) + '" text-anchor="middle">' + label(node.label) + '</text>';
    svg += '</g>';
  }
  svg += '</svg>';
  return '<div class="mermaid-diagram" data-surface="diagram">' + svg + '<details class="diagram-source"><summary>Diagram source</summary><pre>' + escapeHtml(codeRaw) + '</pre></details></div>';
}

/** The longest-path rank of every node (a cycle-safe approximation). */
function assignRanks(ids, edges) {
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (incoming.has(e.to) && e.from !== e.to) incoming.get(e.to).push(e.from);
  }
  const rank = new Map(ids.map((id) => [id, 0]));
  for (let iteration = 0; iteration < ids.length + 2; iteration += 1) {
    let changed = false;
    for (const id of ids) {
      let candidate = 0;
      for (const from of incoming.get(id)) {
        candidate = Math.max(candidate, (rank.get(from) ?? 0) + 1);
      }
      if (candidate !== rank.get(id)) { rank.set(id, candidate); changed = true; }
    }
    if (!changed) break;
  }
  return rank;
}

/**
 * A sequence diagram: participants, lifelines, messages, notes and
 * alt/else blocks.
 */
function renderSequenceDiagram(lines, codeRaw) {
  const participants = [];
  const seen = new Set();
  const events = [];
  const blocks = [];
  const stack = [];

  const participantOf = (id, alias) => {
    const key = id.trim();
    if (!seen.has(key)) {
      seen.add(key);
      participants.push({ id: key, label: alias ? alias.trim() : key });
    } else if (alias) {
      const found = participants.find((p) => p.id === key);
      if (found) found.label = alias.trim();
    }
    return key;
  };

  for (const line of lines.slice(1)) {
    if (/^(autonumber|activate|deactivate|end)\b/i.test(line)) {
      if (/^end\b/i.test(line)) { blocks.pop(); stack.pop(); }
      continue;
    }
    const pm = /^participant\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (pm) { participantOf(pm[1], pm[2]); continue; }
    const am = /^actor\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (am) { participantOf(am[1], am[2]); continue; }
    const note = /^Note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i.exec(line);
    if (note) {
      const who = note[2].split(',').map((w) => participantOf(w)).filter(Boolean);
      events.push({ kind: 'note', who, text: note[3] ?? '', block: stack[stack.length - 1] ?? null });
      continue;
    }
    const alt = /^(alt|else|opt|loop|par|critical|rect|box)\b\s*(.*)$/i.exec(line);
    if (alt) {
      const kind = alt[1].toLowerCase();
      if (kind === 'else') {
        const block = blocks[blocks.length - 1];
        if (block) { block.branches.push({ label: alt[2] ?? '', events: [] }); }
        continue;
      }
      const block = { kind, label: alt[2] ?? '', branches: [{ label: alt[2] ?? '', events: [] }] };
      blocks.push(block);
      stack.push(block);
      continue;
    }
    const msg = /^([^\s:]+)\s*(-{1,2}>>?|<<-{1,2}|--x|-\)|--\))\s*([^\s:]+)\s*:\s*(.*)$/.exec(line);
    if (msg) {
      const from = participantOf(msg[1]);
      const to = participantOf(msg[3]);
      const arrow = msg[2];
      events.push({
        kind: 'message',
        from,
        to,
        text: msg[4] ?? '',
        dashed: arrow.includes('--') || arrow === '->',
        open: arrow.includes('<<'),
        block: stack[stack.length - 1] ?? null,
      });
      continue;
    }
  }
  if (!participants.length) return null;

  const BOX_W = 132;
  const BOX_H = 34;
  const TOP = 18;
  const GAP = 34;
  const ROW = 40;
  const PAD = 18;

  const index = new Map(participants.map((p, i) => [p.id, i]));
  const x = (id) => PAD + (index.get(id) ?? 0) * (BOX_W + GAP) + BOX_W / 2;

  // lay the events out in rows
  let row = 0;
  const placed = [];
  for (const event of events) {
    if (event.kind === 'note') { placed.push({ ...event, row: row += 1 }); continue; }
    placed.push({ ...event, row: row += 1 });
  }
  const height = TOP + BOX_H + 20 + row * ROW + PAD;

  const label = (t) => escapeHtml(String(t ?? '')).slice(0, 90);

  let svg = '<svg class="mermaid-svg mermaid-sequence" viewBox="0 0 ' + (PAD * 2 + participants.length * (BOX_W + GAP) - GAP) + ' ' + height + '" role="img" aria-label="sequence diagram" xmlns="http://www.w3.org/2000/svg">';
  svg += '<defs><marker id="qx-seq-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="currentColor"/></marker>'
    + '<marker id="qx-seq-open" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M1,1 L9,5 L1,9" fill="none" stroke="currentColor" stroke-width="1.3"/></marker></defs>';

  // lifelines
  for (const p of participants) {
    svg += '<line class="mermaid-lifeline" x1="' + x(p.id) + '" y1="' + (TOP + BOX_H) + '" x2="' + x(p.id) + '" y2="' + (height - PAD) + '" stroke-dasharray="4 5"/>';
  }

  // messages
  for (const event of placed) {
    if (event.kind !== 'message') continue;
    const y = TOP + BOX_H + 26 + event.row * ROW;
    const x1 = x(event.from);
    const x2 = x(event.to);
    const marker = event.open ? 'url(#qx-seq-open)' : 'url(#qx-seq-arrow)';
    const dash = event.dashed ? ' stroke-dasharray="5 4"' : '';
    svg += '<path class="mermaid-msg" d="M' + x1 + ' ' + y + ' L' + x2 + ' ' + y + '" fill="none" marker-end="' + marker + '"' + dash + '/>';
    if (event.text) {
      svg += '<text class="mermaid-msg-label" x="' + ((x1 + x2) / 2) + '" y="' + (y - 7) + '" text-anchor="middle">' + label(event.text) + '</text>';
    }
  }

  // notes
  for (const event of placed) {
    if (event.kind !== 'note') continue;
    const y = TOP + BOX_H + 26 + event.row * ROW - 16;
    const who = event.who.length ? event.who : [participants[0].id];
    const x1 = Math.min(...who.map(x)) - 46;
    const x2 = Math.max(...who.map(x)) + 46;
    svg += '<rect class="mermaid-note" x="' + x1 + '" y="' + y + '" width="' + (x2 - x1) + '" height="30" rx="4"/>';
    svg += '<text class="mermaid-note-label" x="' + ((x1 + x2) / 2) + '" y="' + (y + 19) + '" text-anchor="middle">' + label(event.text) + '</text>';
  }

  // participant boxes
  for (const p of participants) {
    svg += '<g class="mermaid-participant"><rect x="' + (x(p.id) - BOX_W / 2) + '" y="' + TOP + '" width="' + BOX_W + '" height="' + BOX_H + '" rx="6"/>';
    svg += '<text x="' + x(p.id) + '" y="' + (TOP + BOX_H / 2 + 4) + '" text-anchor="middle">' + label(p.label) + '</text></g>';
  }

  svg += '</svg>';
  return '<div class="mermaid-diagram" data-surface="diagram">' + svg + '<details class="diagram-source"><summary>Diagram source</summary><pre>' + escapeHtml(codeRaw) + '</pre></details></div>';
}

/* ---------------- block parsing ---------------- */

function emphasize(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
}

function inline(raw) {
  // 1. pull out code spans so their contents are never formatted
  const codes = [];
  let text = String(raw ?? '').replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  // 2. pull out links (so autolinking can never touch generated attributes)
  const links = [];
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/g, (_, label, href, title) => {
    links.push({ label, href: href.replace(/&amp;/g, '&'), title: title ?? '' });
    return `\u0000L${links.length - 1}\u0000`;
  });
  // 3. pull out math so $ / _ / ^ are not treated as emphasis
  const maths = [];
  text = text.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (m, pre, body) => {
    maths.push(body);
    return `${pre}\u0000M${maths.length - 1}\u0000`;
  });
  text = escapeHtml(text);
  // 4. autolinks (trailing sentence punctuation stays outside the anchor)
  text = text.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
    const m = /^(.+?)([.,;:!?]+)?$/.exec(url);
    const href = m ? m[1] : url;
    const tail = m && m[2] ? m[2] : '';
    if (!safeHref(href)) return url;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>${tail}`;
  });
  // 5. emphasis
  text = emphasize(text);
  // 6. restore math, code, links
  text = text.replace(/\u0000M(\d+)\u0000/g, (_, k) => renderMath(maths[Number(k)], false));
  text = text.replace(/\u0000C(\d+)\u0000/g, (_, k) => `<code class="inline">${escapeHtml(codes[Number(k)])}</code>`);
  text = text.replace(/\u0000L(\d+)\u0000/g, (_, k) => {
    const link = links[Number(k)];
    const labelHtml = emphasize(escapeHtml(link.label));
    const safe = safeHref(link.href);
    if (!safe) return `${labelHtml} (${escapeHtml(link.href)})`;
    const title = link.title ? ` title="${escapeHtml(link.title)}"` : '';
    return `<a href="${escapeHtml(safe)}"${title} target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
  });
  return text;
}

/**
 * An artifact chip — a link to an interactive artifact the agent built.
 *
 * The body is `<id>\n<title>` (the first line may also be `id|title`).
 */
function artifactChip(body) {
  const lines = String(body ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  let id = '';
  let title = '';
  if (lines.length === 1 && lines[0].includes('|')) {
    [id, title] = lines[0].split('|');
  } else {
    id = lines[0] ?? '';
    title = lines[1] ?? '';
  }
  id = id.trim();
  title = (title || 'Artifact').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return `<button type="button" class="artifact-chip" data-artifact-id="${escapeHtml(id)}" title="Open the artifact">`
    + `<span class="artifact-chip-icon">◈</span>`
    + `<span class="artifact-chip-title">${escapeHtml(title)}</span>`
    + `<span class="artifact-chip-hint">Open</span></button>`;
}

function codeBlock(lang, body, opts = {}) {
  const langLabel = String(lang || 'text');
  const highlighted = opts.mermaid === true ? body : highlightCode(body, langLabel);
  const copy = encodeURIComponent(body);
  return `<div class="code-block-wrap${opts.mermaid ? ' mermaid-source' : ''}"><div class="code-block-head"><span class="code-lang">${escapeHtml(langLabel)}</span><button class="code-copy" data-code="${copy}">⧉ Copy</button></div><pre class="code-block">${highlighted}</pre></div>`;
}

function tableHtml(lines) {
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const header = cells(lines[0]);
  const sep = cells(lines[1]);
  const align = sep.map((s) => (/^:.*:$/.test(s) ? 'center' : /:$/.test(s) ? 'right' : /^:/.test(s) ? 'left' : null));
  const rows = lines.slice(2).map(cells);
  let out = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
  header.forEach((h, i) => { out += `<th${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(h)}</th>`; });
  out += '</tr></thead><tbody>';
  for (const row of rows) {
    out += '<tr>';
    header.forEach((_, i) => { out += `<td${align[i] ? ` style="text-align:${align[i]}"` : ''}>${inline(row[i] ?? '')}</td>`; });
    out += '</tr>';
  }
  return `${out}</tbody></table></div>`;
}

function listHtml(lines) {
  // Indent-aware tree: 2 spaces (or one tab) per nesting level.
  const items = lines.map((line) => {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    const indent = m ? m[1].replace(/\t/g, '  ').length : 0;
    const ordered = m ? /\d/.test(m[2]) : false;
    let body = m ? m[3] : line.trim();
    let task = null;
    const t = /^\[( |x|X)\]\s+(.*)$/.exec(body);
    if (t) { task = t[1] !== ' '; body = t[2]; }
    return { depth: Math.floor(indent / 2), ordered, body, task };
  });
  if (!items.length) return '';
  const min = Math.min(...items.map((i) => i.depth));
  for (const item of items) item.depth -= min;

  const build = (start, depth) => {
    const ordered = items[start].ordered;
    const open = ordered ? 'ol' : 'ul';
    let html = `<${open}>`;
    let i = start;
    while (i < items.length && items[i].depth === depth && items[i].ordered === ordered) {
      const item = items[i];
      const checkbox = item.task == null ? '' : `<span class="md-task${item.task ? ' done' : ''}">${item.task ? '☑' : '☐'}</span> `;
      let inner = checkbox + inline(item.body);
      i += 1;
      if (i < items.length && items[i].depth > depth) {
        const child = build(i, items[i].depth);
        inner += child.html;
        i = child.next;
      }
      html += `<li${item.task == null ? '' : ' class="md-task-item"'}>${inner}</li>`;
    }
    return { html: `${html}</${open}>`, next: i };
  };

  let out = '';
  let i = 0;
  while (i < items.length) {
    const chunk = build(i, items[i].depth);
    out += chunk.html;
    i = chunk.next;
  }
  return out;
}

const isTableSep = (line) => /^\s*\|?[\s:-]*\|[\s|:-]*\|?\s*$/.test(line) && line.includes('-');
const isRule = (line) => /^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line);
const isFence = (line) => /^\s*```/.test(line);
const isHeading = (line) => /^\s{0,3}(#{1,6})\s+/.test(line);
const isListItem = (line) => /^\s*([-*+]|\d+[.)])\s+/.test(line);
const isQuote = (line) => /^\s*>\s?/.test(line);

/** Render markdown to safe HTML. */
function renderMarkdown(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    // fenced code / mermaid
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || 'text';
      const body = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence (or EOF)
      const code = body.join('\n');
      const isMermaid = /^(mermaid|flow)$/i.test(lang);
      const diagram = isMermaid ? renderMermaid(code) : null;
      if (/^artifact$/i.test(lang)) {
        const chip = artifactChip(code);
        out.push(chip ?? codeBlock(lang, code));
        continue;
      }
      out.push(diagram ?? codeBlock(lang, code, { mermaid: isMermaid && !diagram }));
      continue;
    }

    // display math $$...$$ (single or multi-line)
    if (/^\s*\$\$/.test(line)) {
      const rest = line.replace(/^\s*\$\$/, '');
      if (/\$\$\s*$/.test(rest)) {
        out.push(renderMath(rest.replace(/\$\$\s*$/, ''), true));
        i += 1;
        continue;
      }
      const body = [rest];
      i += 1;
      while (i < lines.length && !/\$\$\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      if (i < lines.length) body.push(lines[i].replace(/\$\$\s*$/, ''));
      out.push(renderMath(body.join('\n'), true));
      i += 1;
      continue;
    }

    // headings (h1/h2 map to h3 for message-scale typography)
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, Math.max(1, heading[1].length));
      const tag = level <= 2 ? 'h3' : `h${Math.min(6, level + 1)}`;
      out.push(`<${tag}>${inline(heading[2].replace(/\s#+\s*$/, ''))}</${tag}>`);
      i += 1;
      continue;
    }

    // horizontal rule
    if (isRule(line)) { out.push('<hr>'); i += 1; continue; }

    // table
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const block = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { block.push(lines[i]); i += 1; }
      out.push(tableHtml(block));
      continue;
    }

    // blockquote
    if (isQuote(line)) {
      const body = [];
      while (i < lines.length && isQuote(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    // lists (including nesting + tasks)
    if (isListItem(line)) {
      const block = [];
      while (i < lines.length && (isListItem(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i]) && block.length))) {
        block.push(lines[i]);
        i += 1;
      }
      out.push(listHtml(block));
      continue;
    }

    // paragraph: consume until a blank line or another block starter
    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim()
      && !isFence(lines[i]) && !isHeading(lines[i]) && !isListItem(lines[i])
      && !isQuote(lines[i]) && !isRule(lines[i]) && !/^\s*\$\$/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

module.exports = { renderMarkdown, inline, renderMath, renderMermaid, highlightCode, escapeHtml, safeHref, artifactChip };
