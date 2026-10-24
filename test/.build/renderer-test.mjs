var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/renderer-src/markdown.js
var require_markdown = __commonJS({
  "src/renderer-src/markdown.js"(exports, module) {
    "use strict";
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }
    var SAFE_SCHEME = /^(https?:|mailto:)/i;
    function safeHref(raw) {
      const url = String(raw ?? "").trim();
      if (!url) return null;
      if (SAFE_SCHEME.test(url)) return url;
      return null;
    }
    var KEYWORDS = {
      js: "const let var function return if else for while do switch case break continue class extends new this super async await try catch finally throw typeof instanceof in of delete void yield import export from default static get set null true false undefined",
      ts: "const let var function return if else for while do switch case break continue class extends new this super async await try catch finally throw typeof instanceof in of delete void yield import export from default static get set null true false undefined interface type enum implements readonly public private protected namespace declare as satisfies",
      py: "def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False self async await",
      sh: "if then else elif fi for while do done case esac function return in export local readonly echo cd set unset source exit sudo",
      json: "true false null",
      sql: "select from where join left right inner outer on group by order limit insert into values update set delete create table alter drop index view as and or not null primary key foreign references distinct count sum avg min max",
      html: "",
      css: "",
      go: "package import func return if else for range switch case break continue type struct interface map chan go defer select var const nil true false",
      rust: "fn let mut pub use crate mod impl trait struct enum match if else loop while for in return self Self where async await move ref dyn const static unsafe type as true false None Some Ok Err"
    };
    KEYWORDS.javascript = KEYWORDS.js;
    KEYWORDS.typescript = KEYWORDS.ts;
    KEYWORDS.python = KEYWORDS.py;
    KEYWORDS.bash = KEYWORDS.sh;
    KEYWORDS.shell = KEYWORDS.sh;
    KEYWORDS.zsh = KEYWORDS.sh;
    function highlightCode(code, langRaw) {
      const lang = String(langRaw || "").toLowerCase();
      const keywords = new Set((KEYWORDS[lang] ?? "").split(/\s+/).filter(Boolean));
      const lineComment = ["py", "python", "sh", "bash", "shell", "zsh", "rb", "ruby", "yaml", "yml", "toml"].includes(lang) ? "#" : "//";
      const source = String(code ?? "");
      let out = "";
      let i = 0;
      const n = source.length;
      const isIdent = (c) => /[A-Za-z_$]/.test(c);
      const isWord = (c) => /[A-Za-z0-9_$]/.test(c);
      while (i < n) {
        const ch = source[i];
        const two = source.slice(i, i + 2);
        if (lineComment === "#" ? ch === "#" : two === "//") {
          const end = source.indexOf("\n", i);
          const stop = end === -1 ? n : end;
          out += `<span class="tok-com">${escapeHtml(source.slice(i, stop))}</span>`;
          i = stop;
          continue;
        }
        if (two === "/*") {
          const end = source.indexOf("*/", i + 2);
          const stop = end === -1 ? n : end + 2;
          out += `<span class="tok-com">${escapeHtml(source.slice(i, stop))}</span>`;
          i = stop;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          let j = i + 1;
          while (j < n && source[j] !== ch) {
            if (source[j] === "\\") j += 1;
            j += 1;
          }
          const stop = Math.min(n, j + 1);
          out += `<span class="tok-str">${escapeHtml(source.slice(i, stop))}</span>`;
          i = stop;
          continue;
        }
        if (/[0-9]/.test(ch) && !isWord(source[i - 1] ?? "")) {
          let j = i;
          while (j < n && /[0-9a-fA-FxX._eE+-]/.test(source[j])) j += 1;
          out += `<span class="tok-num">${escapeHtml(source.slice(i, j))}</span>`;
          i = j;
          continue;
        }
        if (isIdent(ch)) {
          let j = i + 1;
          while (j < n && isWord(source[j])) j += 1;
          const word = source.slice(i, j);
          if (keywords.has(word)) out += `<span class="tok-kw">${escapeHtml(word)}</span>`;
          else if (source[j] === "(") out += `<span class="tok-fn">${escapeHtml(word)}</span>`;
          else out += escapeHtml(word);
          i = j;
          continue;
        }
        out += escapeHtml(ch);
        i += 1;
      }
      return out;
    }
    var GREEK = {
      alpha: "\u03B1",
      beta: "\u03B2",
      gamma: "\u03B3",
      delta: "\u03B4",
      epsilon: "\u03B5",
      zeta: "\u03B6",
      eta: "\u03B7",
      theta: "\u03B8",
      iota: "\u03B9",
      kappa: "\u03BA",
      lambda: "\u03BB",
      mu: "\u03BC",
      nu: "\u03BD",
      xi: "\u03BE",
      pi: "\u03C0",
      rho: "\u03C1",
      sigma: "\u03C3",
      tau: "\u03C4",
      upsilon: "\u03C5",
      phi: "\u03C6",
      chi: "\u03C7",
      psi: "\u03C8",
      omega: "\u03C9",
      varepsilon: "\u03B5",
      vartheta: "\u03D1",
      varphi: "\u03C6",
      Gamma: "\u0393",
      Delta: "\u0394",
      Theta: "\u0398",
      Lambda: "\u039B",
      Xi: "\u039E",
      Pi: "\u03A0",
      Sigma: "\u03A3",
      Upsilon: "\u03A5",
      Phi: "\u03A6",
      Psi: "\u03A8",
      Omega: "\u03A9"
    };
    var SYMBOLS = {
      times: "\xD7",
      div: "\xF7",
      cdot: "\xB7",
      pm: "\xB1",
      mp: "\u2213",
      le: "\u2264",
      leq: "\u2264",
      ge: "\u2265",
      geq: "\u2265",
      ne: "\u2260",
      neq: "\u2260",
      approx: "\u2248",
      equiv: "\u2261",
      sim: "\u223C",
      simeq: "\u2243",
      cong: "\u2245",
      propto: "\u221D",
      infty: "\u221E",
      partial: "\u2202",
      nabla: "\u2207",
      rightarrow: "\u2192",
      to: "\u2192",
      leftarrow: "\u2190",
      gets: "\u2190",
      Rightarrow: "\u21D2",
      Leftarrow: "\u21D0",
      Leftrightarrow: "\u21D4",
      leftrightarrow: "\u2194",
      implies: "\u27F9",
      mapsto: "\u21A6",
      forall: "\u2200",
      exists: "\u2203",
      nexists: "\u2204",
      in: "\u2208",
      notin: "\u2209",
      ni: "\u220B",
      subset: "\u2282",
      subseteq: "\u2286",
      supset: "\u2283",
      supseteq: "\u2287",
      cup: "\u222A",
      cap: "\u2229",
      setminus: "\u2216",
      emptyset: "\u2205",
      varnothing: "\u2205",
      land: "\u2227",
      wedge: "\u2227",
      lor: "\u2228",
      vee: "\u2228",
      neg: "\xAC",
      lnot: "\xAC",
      langle: "\u27E8",
      rangle: "\u27E9",
      lceil: "\u2308",
      rceil: "\u2309",
      lfloor: "\u230A",
      rfloor: "\u230B",
      ldots: "\u2026",
      cdots: "\u22EF",
      vdots: "\u22EE",
      ddots: "\u22F1",
      dots: "\u2026",
      aleph: "\u2135",
      hbar: "\u210F",
      ell: "\u2113",
      Re: "\u211C",
      Im: "\u2111",
      prime: "\u2032",
      therefore: "\u2234",
      because: "\u2235",
      angle: "\u2220",
      perp: "\u22A5",
      parallel: "\u2225",
      therefore_: "\u2234",
      oplus: "\u2295",
      ominus: "\u2296",
      otimes: "\u2297",
      odot: "\u2299",
      star: "\u22C6",
      dagger: "\u2020",
      section: "\xA7",
      paragraph: "\xB6",
      degree: "\xB0",
      colon: ":",
      quad: " ",
      qquad: "  ",
      thinspace: " ",
      medspace: " ",
      lbrace: "{",
      rbrace: "}",
      backslash: "\\",
      vert: "|",
      Vert: "\u2016"
    };
    var FUNCS = {
      sin: "sin",
      cos: "cos",
      tan: "tan",
      cot: "cot",
      sec: "sec",
      csc: "csc",
      arcsin: "arcsin",
      arccos: "arccos",
      arctan: "arctan",
      sinh: "sinh",
      cosh: "cosh",
      tanh: "tanh",
      exp: "exp",
      ln: "ln",
      log: "log",
      lg: "lg",
      det: "det",
      dim: "dim",
      ker: "ker",
      deg: "deg",
      gcd: "gcd",
      arg: "arg",
      hom: "hom",
      lim: "lim",
      limsup: "lim sup",
      liminf: "lim inf",
      Pr: "Pr",
      mod: "mod",
      inf: "inf",
      sup: "sup",
      max: "max",
      min: "min"
    };
    var BIG_OPS = {
      sum: "\u2211",
      prod: "\u220F",
      coprod: "\u2210",
      int: "\u222B",
      iint: "\u222C",
      iiint: "\u222D",
      oint: "\u222E",
      bigcup: "\u22C3",
      bigcap: "\u22C2",
      bigsqcup: "\u2A06",
      bigoplus: "\u2A01",
      bigotimes: "\u2A02",
      bigodot: "\u2A00",
      biguplus: "\u2A04"
    };
    var ACCENTS = {
      hat: "\u0302",
      widehat: "\u0302",
      bar: "\u0304",
      overline: "\u0304",
      vec: "\u20D7",
      tilde: "\u0303",
      widetilde: "\u0303",
      dot: "\u0307",
      ddot: "\u0308",
      check: "\u030C",
      breve: "\u0306",
      acute: "\u0301",
      grave: "\u0300"
    };
    var FONTS = {
      mathbb: "bb",
      mathbf: "bf",
      mathit: "it",
      mathcal: "cal",
      mathrm: "rm",
      mathsf: "sf",
      mathtt: "tt",
      boldsymbol: "bf",
      pmb: "bf"
    };
    var FONT_CLASS = { bb: "math-mathbb", bf: "math-mathbf", it: "math-mathit", cal: "math-mathcal", rm: "math-mathrm", sf: "math-sans", tt: "math-mono" };
    function renderMath(texRaw, display = false) {
      const tex = String(texRaw ?? "").trim();
      if (!tex) return "";
      const cls = display ? "math math-display" : "math math-inline";
      return '<span class="' + cls + '" data-tex="' + escapeHtml(tex) + '">' + mathBody(tex, display) + "</span>";
    }
    function mathBody(tex, display = false) {
      try {
        const state = { tex: String(tex ?? ""), i: 0, display: Boolean(display) };
        const out = parseSequence(state, null);
        return out;
      } catch {
        return escapeHtml(String(tex ?? ""));
      }
    }
    function readGroup(state) {
      const { tex } = state;
      if (state.i >= tex.length) return null;
      if (tex[state.i] !== "{") {
        const ch = tex[state.i];
        state.i += 1;
        return ch;
      }
      let depth = 0;
      const start = state.i + 1;
      while (state.i < tex.length) {
        if (tex[state.i] === "{") depth += 1;
        else if (tex[state.i] === "}") {
          depth -= 1;
          if (depth === 0) {
            state.i += 1;
            return tex.slice(start, state.i - 1);
          }
        }
        state.i += 1;
      }
      return null;
    }
    function readRawArgument(state) {
      const { tex } = state;
      if (state.i >= tex.length) return "";
      if (tex[state.i] === "{") return readGroup(state) ?? "";
      if (tex[state.i] === "\\") {
        const m = /^\\([A-Za-z]+|.)/.exec(tex.slice(state.i));
        if (m) {
          state.i += m[0].length;
          return "\\" + m[1];
        }
      }
      const ch = tex[state.i];
      state.i += 1;
      return ch;
    }
    function readArgument(state) {
      const { tex } = state;
      if (state.i >= tex.length) return "";
      if (tex[state.i] === "{") {
        const group = readGroup(state);
        return mathBody(group ?? "", false);
      }
      if (tex[state.i] === "\\") {
        const m = /^\\([A-Za-z]+|.)/.exec(tex.slice(state.i));
        if (m) {
          state.i += m[0].length;
          const name = m[1];
          if (GREEK[name]) return '<span class="math-greek">' + GREEK[name] + "</span>";
          if (SYMBOLS[name]) return escapeHtml(SYMBOLS[name]);
          if (BIG_OPS[name]) return '<span class="big-op">' + escapeHtml(BIG_OPS[name]) + "</span>";
          if (FUNCS[name]) return '<span class="math-op">' + escapeHtml(FUNCS[name]) + "</span>";
          if (name === "{" || name === "}" || name === "%" || name === "_" || name === "&") return escapeHtml(name);
          if (name === "," || name === ";") return " ";
          return escapeHtml("\\" + name);
        }
      }
      const ch = tex[state.i];
      state.i += 1;
      return escapeHtml(ch);
    }
    function parseSequence(state, stopAt) {
      let out = "";
      while (state.i < state.tex.length) {
        const ch = state.tex[state.i];
        if (stopAt === "}" && ch === "}") break;
        if (stopAt === "row" && ch === "\\") break;
        if (ch === "}") {
          out += escapeHtml("}");
          state.i += 1;
          continue;
        }
        if (ch === "\\") {
          const m = /^\\([A-Za-z]+|.)/.exec(state.tex.slice(state.i));
          if (!m) {
            out += escapeHtml("\\");
            state.i += 1;
            continue;
          }
          const name = m[1];
          state.i += m[0].length;
          if (name === "\\") {
            out += "\\\\";
            continue;
          }
          if (name === "{" || name === "}" || name === "%" || name === "_" || name === "&" || name === "#") {
            out += escapeHtml(name);
            continue;
          }
          if (name === "," || name === ";" || name === " " || name === ":") {
            out += " ";
            continue;
          }
          if (name === "left" || name === "right") {
            const delim = readGroup(state);
            const glyph = { "(": "\u27E8", ")": "\u27E9", "[": "[", "]": "]", "|": "|", ".": "" }[delim] ?? (delim ?? "");
            out += escapeHtml(glyph);
            continue;
          }
          if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "binom" || name === "dbinom" || name === "choose") {
            const a = readGroup(state);
            const b = readGroup(state);
            if (a == null || b == null) {
              out += escapeHtml("\\" + name);
              continue;
            }
            const top = mathBody(a, state.display);
            const bottom = mathBody(b, state.display);
            if (name === "binom" || name === "dbinom" || name === "choose") {
              out += '<span class="binom"><span class="paren">(</span><span class="binom-body"><span class="num">' + top + '</span><span class="den">' + bottom + '</span></span><span class="paren">)</span></span>';
            } else {
              out += '<span class="frac"><span class="num">' + top + '</span><span class="den">' + bottom + "</span></span>";
            }
            continue;
          }
          if (name === "sqrt") {
            let index = null;
            if (state.tex[state.i] === "[") {
              const close = state.tex.indexOf("]", state.i);
              if (close !== -1) {
                index = state.tex.slice(state.i + 1, close);
                state.i = close + 1;
              }
            }
            const body = readGroup(state);
            if (body == null) {
              out += escapeHtml("\\sqrt");
              continue;
            }
            const radical = '<span class="sqrt">\u221A<span class="radicand">' + mathBody(body, state.display) + "</span></span>";
            out += index == null ? radical : '<span class="sqrt-index">' + mathBody(index, state.display) + radical + "</span>";
            continue;
          }
          if (name === "text" || name === "textrm" || name === "textbf" || name === "textit" || name === "mbox") {
            const body = readGroup(state);
            out += '<span class="math-text">' + escapeHtml((body ?? "").replace(/[_-]/g, " ")) + "</span>";
            continue;
          }
          if (name === "operatorname" || name === "operatorname*") {
            const body = readGroup(state);
            out += '<span class="math-op">' + escapeHtml(body ?? "") + "</span>";
            continue;
          }
          if (name === "begin" || name === "end") {
            const env = readGroup(state);
            if (name === "end") {
              out += parseEnvironmentEnd(state, env);
              continue;
            }
            out += parseEnvironment(state, env);
            continue;
          }
          if (FONTS[name]) {
            const body = readGroup(state);
            if (body == null) {
              out += escapeHtml("\\" + name);
              continue;
            }
            out += '<span class="' + FONT_CLASS[FONTS[name]] + '">' + mathBody(body, state.display) + "</span>";
            continue;
          }
          if (ACCENTS[name]) {
            const body = readGroup(state);
            if (body == null) {
              out += escapeHtml("\\" + name);
              continue;
            }
            out += '<span class="accent">' + mathBody(body, state.display) + FONT_COMBINING[name] + "</span>";
            continue;
          }
          if (BIG_OPS[name]) {
            const op = BIG_OPS[name];
            let lower = null;
            let upper = null;
            for (; ; ) {
              const save = state.i;
              const ch2 = state.tex[state.i];
              if (ch2 === "_") {
                state.i += 1;
                lower = readRawArgument(state);
                continue;
              }
              if (ch2 === "^") {
                state.i += 1;
                upper = readRawArgument(state);
                continue;
              }
              state.i = save;
              break;
            }
            const glyph = '<span class="big-op">' + escapeHtml(op) + "</span>";
            if (state.display) {
              out += '<span class="big-op-wrap"><span class="op-upper">' + (upper == null ? "" : mathBody(upper, false)) + "</span>" + glyph + '<span class="op-lower">' + (lower == null ? "" : mathBody(lower, false)) + "</span></span>";
            } else {
              out += glyph + (upper == null ? "" : "<sup>" + mathBody(upper, false) + "</sup>") + (lower == null ? "" : "<sub>" + mathBody(lower, false) + "</sub>");
            }
            continue;
          }
          if (FUNCS[name]) {
            out += '<span class="math-op">' + escapeHtml(FUNCS[name]) + "</span>";
            continue;
          }
          if (GREEK[name]) {
            out += '<span class="math-greek">' + GREEK[name] + "</span>";
            continue;
          }
          if (SYMBOLS[name]) {
            out += escapeHtml(SYMBOLS[name]);
            continue;
          }
          if (name === "quad") {
            out += "&nbsp;&nbsp;";
            continue;
          }
          if (name === "qquad") {
            out += "&nbsp;&nbsp;&nbsp;&nbsp;";
            continue;
          }
          if (name === "hspace") {
            const w = readGroup(state);
            out += w ? escapeHtml(w) : "";
            continue;
          }
          if (name === "boxed") {
            const body = readGroup(state);
            out += '<span class="math-boxed">' + mathBody(body ?? "", state.display) + "</span>";
            continue;
          }
          if (name === "overline" || name === "underline") {
            const body = readGroup(state);
            out += '<span class="math-' + name + '">' + mathBody(body ?? "", state.display) + "</span>";
            continue;
          }
          if (name === "label" || name === "notag" || name === "nonumber" || name === "displaystyle") {
            continue;
          }
          out += escapeHtml("\\" + name);
          continue;
        }
        if (ch === "^" || ch === "_") {
          state.i += 1;
          const body = readArgument(state);
          out += ch === "^" ? "<sup>" + body + "</sup>" : "<sub>" + body + "</sub>";
          continue;
        }
        if (ch === "{") {
          const body = readGroup(state);
          out += mathBody(body ?? "", state.display);
          continue;
        }
        if (ch === "&") {
          state.i += 1;
          continue;
        }
        if (ch === "*") {
          out += "\xB7";
          state.i += 1;
          continue;
        }
        out += escapeHtml(ch);
        state.i += 1;
      }
      return out;
    }
    var FONT_COMBINING = {
      hat: "\u0302",
      widehat: "\u0302",
      bar: "\u0304",
      overline: "\u0304",
      vec: "\u20D7",
      tilde: "\u0303",
      widetilde: "\u0303",
      dot: "\u0307",
      ddot: "\u0308",
      check: "\u030C",
      breve: "\u0306",
      acute: "\u0301",
      grave: "\u0300"
    };
    function parseEnvironmentEnd(state, env) {
      const closers = {
        pmatrix: ")",
        bmatrix: "]",
        bmatrixr: "]",
        vmatrix: "|",
        Vmatrix: "\u2016",
        matrix: "",
        smallmatrix: "",
        cases: "",
        aligned: "",
        align: "",
        gather: "",
        gathered: "",
        split: "",
        array: ""
      };
      const closer = closers[String(env ?? "")] ?? "";
      return closer ? '<span class="math-delim">' + escapeHtml(closer) + "</span>" : "";
    }
    function parseEnvironment(state, env) {
      const name = String(env ?? "").trim();
      const source = readRawEnvironment(state, name);
      if (source == null) return escapeHtml("\\begin{" + name + "}");
      const rows = source.split(/\\\\/).map((r) => r.trim()).filter((r, idx, arr) => r !== "" || arr.length === 1);
      const cells = rows.map((row) => row.split("&").map((c) => mathBody(c, state.display)));
      if (name === "cases" || name === "aligned" || name === "align" || name === "gathered" || name === "gather" || name === "split") {
        const body2 = cells.map((row) => '<span class="env-row">' + row.join("") + "</span>").join("");
        return '<span class="math-env math-' + escapeHtml(name) + '">' + body2 + "</span>";
      }
      const delims = {
        pmatrix: ["(", ")"],
        bmatrix: ["[", "]"],
        bmatrixr: ["]", "["],
        vmatrix: ["|", "|"],
        Vmatrix: ["\u2016", "\u2016"],
        matrix: ["", ""],
        smallmatrix: ["", ""]
      };
      const [open, close] = delims[name] ?? ["", ""];
      const body = cells.map((row) => "<tr>" + row.map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("");
      return '<span class="math-matrix">' + escapeHtml(open) + '<table class="math-matrix-table"><tbody>' + body + "</tbody></table>" + escapeHtml(close) + "</span>";
    }
    function readRawEnvironment(state, name) {
      const marker = "\\end{" + name + "}";
      const close = state.tex.indexOf(marker, state.i);
      if (close === -1) return null;
      const body = state.tex.slice(state.i, close);
      state.i = close + marker.length;
      return body;
    }
    function renderMermaid(codeRaw) {
      const lines = String(codeRaw ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const first = lines[0] ?? "";
      if (/^sequenceDiagram\b/i.test(first)) return renderSequenceDiagram(lines, codeRaw);
      const header = /^(graph|flowchart)\s+(TD|TB|LR|BT|RL)\b/i.exec(first);
      if (!header) return null;
      const dir = header[2].toUpperCase();
      const horizontal = dir === "LR" || dir === "RL";
      return renderFlowchart(lines.slice(1), dir, horizontal, codeRaw);
    }
    function parseNode(text) {
      const raw = String(text ?? "").trim();
      const idMatch = /^([A-Za-z0-9_]+)/.exec(raw);
      const id = idMatch ? idMatch[1] : raw;
      let label = "";
      let shape = "rect";
      const rest = raw.slice(id.length).trim();
      const shapes = [
        [/\[\[(.*)\]\]$/s, "subroutine"],
        [/\(\((.*)\)\)$/s, "circle"],
        [/\(\[(.*)\]\)$/s, "stadium"],
        [/\[(.*)\]$/s, "rect"],
        [/\((.*)\)$/s, "round"],
        [/\{(.*)\}$/s, "diamond"],
        [/>(.*)\]$/s, "flag"]
      ];
      for (const [pattern, kind] of shapes) {
        const m = pattern.exec(rest);
        if (m) {
          shape = kind;
          label = m[1];
          break;
        }
      }
      if (!label) label = rest.replace(/^[[({>]+/, "").replace(/[\])}]+$/, "");
      label = label.replace(/^["']|["']$/g, "").trim() || id;
      return { id, label, shape };
    }
    function renderFlowchart(lines, dir, horizontal, codeRaw) {
      const nodes = /* @__PURE__ */ new Map();
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
          addNode(left);
          addNode(right);
          const arrow = edge[2];
          edges.push({
            from: left.id,
            to: right.id,
            label: (edge[3] ?? "").trim(),
            dashed: arrow.includes("-.") || arrow === "--x",
            thick: arrow.startsWith("=")
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
      const bands = /* @__PURE__ */ new Map();
      for (const id of ids) {
        const r = rank.get(id) ?? 0;
        if (!bands.has(r)) bands.set(r, []);
        bands.get(r).push(id);
      }
      const ranks = [...bands.keys()].sort((a, b) => a - b);
      for (const node of list) {
        const chars = Math.max(4, Math.min(22, node.label.length));
        node.w = Math.max(78, chars * 7.4 + 26);
        node.h = node.shape === "diamond" ? 46 : 36;
      }
      const GAP_MAIN = 58;
      const GAP_CROSS = 26;
      const PAD = 20;
      const pos = /* @__PURE__ */ new Map();
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
          pos.set(id, horizontal ? { x: main, y: cross - node.h / 2, w: node.w, h: node.h } : { x: cross - node.w / 2, y: main, w: node.w, h: node.h });
          offset += node.w + GAP_CROSS;
        }
      });
      const width = horizontal ? mainTotal + PAD * 2 : crossTotal + PAD * 2;
      const height = horizontal ? crossTotal + PAD * 2 : mainTotal + PAD * 2;
      const label = (t) => escapeHtml(String(t ?? "")).slice(0, 40);
      const cx = (p2) => p2.x + p2.w / 2;
      const cy = (p2) => p2.y + p2.h / 2;
      let svg = '<svg class="mermaid-svg" viewBox="0 0 ' + Math.max(width, 80) + " " + Math.max(height, 60) + '" role="img" aria-label="diagram" xmlns="http://www.w3.org/2000/svg">';
      svg += '<defs><marker id="qx-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker><marker id="qx-arrow-open" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M1,1 L8,4.5 L1,8" fill="none" stroke="currentColor" stroke-width="1.3"/></marker></defs>';
      for (const e of edges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) continue;
        const marker = e.dashed ? "url(#qx-arrow-open)" : "url(#qx-arrow)";
        const stroke = e.thick ? ' stroke-width="2.4"' : "";
        const dash = e.dashed ? ' stroke-dasharray="5 4"' : "";
        let path = "";
        let lx = 0;
        let ly = 0;
        if (horizontal) {
          const x1 = a.x + a.w;
          const y1 = cy(a);
          const x2 = b.x;
          const y2 = cy(b);
          if (b.x >= a.x + a.w) {
            const mid = (x1 + x2) / 2;
            path = "M" + x1 + " " + y1 + " L" + mid + " " + y1 + " L" + mid + " " + y2 + " L" + x2 + " " + y2;
            lx = mid;
            ly = (y1 + y2) / 2 - 5;
          } else {
            const detour = Math.max(a.y, b.y) + 34;
            path = "M" + x1 + " " + y1 + " C" + (x1 + 26) + " " + (y1 + 40) + " " + (x2 - 26) + " " + (detour + 20) + " " + x2 + " " + y2;
            lx = (x1 + x2) / 2;
            ly = detour;
          }
        } else {
          const x1 = cx(a);
          const y1 = a.y + a.h;
          const x2 = cx(b);
          const y2 = b.y;
          if (b.y >= a.y + a.h) {
            const mid = (y1 + y2) / 2;
            path = "M" + x1 + " " + y1 + " L" + x1 + " " + mid + " L" + x2 + " " + mid + " L" + x2 + " " + y2;
            lx = (x1 + x2) / 2;
            ly = mid - 5;
          } else {
            const detour = Math.min(a.x, b.x) - 30;
            path = "M" + x1 + " " + y1 + " C" + (x1 + 30) + " " + (y1 + 24) + " " + (detour - 20) + " " + (y2 + 30) + " " + x2 + " " + y2;
            lx = detour;
            ly = (y1 + y2) / 2;
          }
        }
        svg += '<path class="mermaid-edge" d="' + path + '" fill="none" marker-end="' + marker + '"' + dash + stroke + "/>";
        if (e.label) svg += '<text class="mermaid-edge-label" x="' + lx + '" y="' + ly + '" text-anchor="middle">' + label(e.label) + "</text>";
      }
      for (const node of list) {
        const p2 = pos.get(node.id);
        svg += '<g class="mermaid-node">';
        if (node.shape === "diamond") {
          const cxm = p2.x + p2.w / 2;
          const cym = p2.y + p2.h / 2;
          svg += '<polygon points="' + cxm + "," + p2.y + " " + (p2.x + p2.w) + "," + cym + " " + cxm + "," + (p2.y + p2.h) + " " + p2.x + "," + cym + '"/>';
        } else if (node.shape === "circle") {
          svg += '<ellipse cx="' + (p2.x + p2.w / 2) + '" cy="' + (p2.y + p2.h / 2) + '" rx="' + p2.w / 2 + '" ry="' + p2.h / 2 + '"/>';
        } else if (node.shape === "stadium") {
          svg += '<rect x="' + p2.x + '" y="' + p2.y + '" width="' + p2.w + '" height="' + p2.h + '" rx="' + p2.h / 2 + '"/>';
        } else if (node.shape === "subroutine") {
          svg += '<rect x="' + p2.x + '" y="' + p2.y + '" width="' + p2.w + '" height="' + p2.h + '" rx="6"/>';
          svg += '<line x1="' + (p2.x + 8) + '" y1="' + p2.y + '" x2="' + (p2.x + 8) + '" y2="' + (p2.y + p2.h) + '"/>';
          svg += '<line x1="' + (p2.x + p2.w - 8) + '" y1="' + p2.y + '" x2="' + (p2.x + p2.w - 8) + '" y2="' + (p2.y + p2.h) + '"/>';
        } else if (node.shape === "flag") {
          svg += '<path d="M' + p2.x + " " + p2.y + " L" + (p2.x + p2.w) + " " + p2.y + " L" + (p2.x + p2.w - 10) + " " + (p2.y + p2.h / 2) + " L" + (p2.x + p2.w) + " " + (p2.y + p2.h) + " L" + p2.x + " " + (p2.y + p2.h) + ' Z"/>';
        } else {
          svg += '<rect x="' + p2.x + '" y="' + p2.y + '" width="' + p2.w + '" height="' + p2.h + '" rx="' + (node.shape === "round" ? 16 : 6) + '"/>';
        }
        svg += '<text x="' + (p2.x + p2.w / 2) + '" y="' + (p2.y + p2.h / 2 + 4) + '" text-anchor="middle">' + label(node.label) + "</text>";
        svg += "</g>";
      }
      svg += "</svg>";
      return '<div class="mermaid-diagram" data-surface="diagram">' + svg + '<details class="diagram-source"><summary>Diagram source</summary><pre>' + escapeHtml(codeRaw) + "</pre></details></div>";
    }
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
          if (candidate !== rank.get(id)) {
            rank.set(id, candidate);
            changed = true;
          }
        }
        if (!changed) break;
      }
      return rank;
    }
    function renderSequenceDiagram(lines, codeRaw) {
      const participants = [];
      const seen = /* @__PURE__ */ new Set();
      const events2 = [];
      const blocks = [];
      const stack = [];
      const participantOf = (id, alias) => {
        const key = id.trim();
        if (!seen.has(key)) {
          seen.add(key);
          participants.push({ id: key, label: alias ? alias.trim() : key });
        } else if (alias) {
          const found = participants.find((p2) => p2.id === key);
          if (found) found.label = alias.trim();
        }
        return key;
      };
      for (const line of lines.slice(1)) {
        if (/^(autonumber|activate|deactivate|end)\b/i.test(line)) {
          if (/^end\b/i.test(line)) {
            blocks.pop();
            stack.pop();
          }
          continue;
        }
        const pm = /^participant\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
        if (pm) {
          participantOf(pm[1], pm[2]);
          continue;
        }
        const am = /^actor\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
        if (am) {
          participantOf(am[1], am[2]);
          continue;
        }
        const note = /^Note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i.exec(line);
        if (note) {
          const who = note[2].split(",").map((w) => participantOf(w)).filter(Boolean);
          events2.push({ kind: "note", who, text: note[3] ?? "", block: stack[stack.length - 1] ?? null });
          continue;
        }
        const alt = /^(alt|else|opt|loop|par|critical|rect|box)\b\s*(.*)$/i.exec(line);
        if (alt) {
          const kind = alt[1].toLowerCase();
          if (kind === "else") {
            const block2 = blocks[blocks.length - 1];
            if (block2) {
              block2.branches.push({ label: alt[2] ?? "", events: [] });
            }
            continue;
          }
          const block = { kind, label: alt[2] ?? "", branches: [{ label: alt[2] ?? "", events: [] }] };
          blocks.push(block);
          stack.push(block);
          continue;
        }
        const msg = /^([^\s:]+)\s*(-{1,2}>>?|<<-{1,2}|--x|-\)|--\))\s*([^\s:]+)\s*:\s*(.*)$/.exec(line);
        if (msg) {
          const from = participantOf(msg[1]);
          const to = participantOf(msg[3]);
          const arrow = msg[2];
          events2.push({
            kind: "message",
            from,
            to,
            text: msg[4] ?? "",
            dashed: arrow.includes("--") || arrow === "->",
            open: arrow.includes("<<"),
            block: stack[stack.length - 1] ?? null
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
      const index = new Map(participants.map((p2, i) => [p2.id, i]));
      const x = (id) => PAD + (index.get(id) ?? 0) * (BOX_W + GAP) + BOX_W / 2;
      let row = 0;
      const placed = [];
      for (const event of events2) {
        if (event.kind === "note") {
          placed.push({ ...event, row: row += 1 });
          continue;
        }
        placed.push({ ...event, row: row += 1 });
      }
      const height = TOP + BOX_H + 20 + row * ROW + PAD;
      const label = (t) => escapeHtml(String(t ?? "")).slice(0, 90);
      let svg = '<svg class="mermaid-svg mermaid-sequence" viewBox="0 0 ' + (PAD * 2 + participants.length * (BOX_W + GAP) - GAP) + " " + height + '" role="img" aria-label="sequence diagram" xmlns="http://www.w3.org/2000/svg">';
      svg += '<defs><marker id="qx-seq-arrow" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="currentColor"/></marker><marker id="qx-seq-open" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M1,1 L9,5 L1,9" fill="none" stroke="currentColor" stroke-width="1.3"/></marker></defs>';
      for (const p2 of participants) {
        svg += '<line class="mermaid-lifeline" x1="' + x(p2.id) + '" y1="' + (TOP + BOX_H) + '" x2="' + x(p2.id) + '" y2="' + (height - PAD) + '" stroke-dasharray="4 5"/>';
      }
      for (const event of placed) {
        if (event.kind !== "message") continue;
        const y = TOP + BOX_H + 26 + event.row * ROW;
        const x1 = x(event.from);
        const x2 = x(event.to);
        const marker = event.open ? "url(#qx-seq-open)" : "url(#qx-seq-arrow)";
        const dash = event.dashed ? ' stroke-dasharray="5 4"' : "";
        svg += '<path class="mermaid-msg" d="M' + x1 + " " + y + " L" + x2 + " " + y + '" fill="none" marker-end="' + marker + '"' + dash + "/>";
        if (event.text) {
          svg += '<text class="mermaid-msg-label" x="' + (x1 + x2) / 2 + '" y="' + (y - 7) + '" text-anchor="middle">' + label(event.text) + "</text>";
        }
      }
      for (const event of placed) {
        if (event.kind !== "note") continue;
        const y = TOP + BOX_H + 26 + event.row * ROW - 16;
        const who = event.who.length ? event.who : [participants[0].id];
        const x1 = Math.min(...who.map(x)) - 46;
        const x2 = Math.max(...who.map(x)) + 46;
        svg += '<rect class="mermaid-note" x="' + x1 + '" y="' + y + '" width="' + (x2 - x1) + '" height="30" rx="4"/>';
        svg += '<text class="mermaid-note-label" x="' + (x1 + x2) / 2 + '" y="' + (y + 19) + '" text-anchor="middle">' + label(event.text) + "</text>";
      }
      for (const p2 of participants) {
        svg += '<g class="mermaid-participant"><rect x="' + (x(p2.id) - BOX_W / 2) + '" y="' + TOP + '" width="' + BOX_W + '" height="' + BOX_H + '" rx="6"/>';
        svg += '<text x="' + x(p2.id) + '" y="' + (TOP + BOX_H / 2 + 4) + '" text-anchor="middle">' + label(p2.label) + "</text></g>";
      }
      svg += "</svg>";
      return '<div class="mermaid-diagram" data-surface="diagram">' + svg + '<details class="diagram-source"><summary>Diagram source</summary><pre>' + escapeHtml(codeRaw) + "</pre></details></div>";
    }
    function emphasize(escaped) {
      return escaped.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>").replace(/~~([^~\n]+)~~/g, "<del>$1</del>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
    }
    function inline(raw) {
      const codes = [];
      let text = String(raw ?? "").replace(/`([^`\n]+)`/g, (_, code) => {
        codes.push(code);
        return `\0C${codes.length - 1}\0`;
      });
      const links = [];
      text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/g, (_, label, href, title) => {
        links.push({ label, href: href.replace(/&amp;/g, "&"), title: title ?? "" });
        return `\0L${links.length - 1}\0`;
      });
      const maths = [];
      text = text.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (m, pre, body) => {
        maths.push(body);
        return `${pre}\0M${maths.length - 1}\0`;
      });
      text = escapeHtml(text);
      text = text.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
        const m = /^(.+?)([.,;:!?]+)?$/.exec(url);
        const href = m ? m[1] : url;
        const tail = m && m[2] ? m[2] : "";
        if (!safeHref(href)) return url;
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>${tail}`;
      });
      text = emphasize(text);
      text = text.replace(/\u0000M(\d+)\u0000/g, (_, k) => renderMath(maths[Number(k)], false));
      text = text.replace(/\u0000C(\d+)\u0000/g, (_, k) => `<code class="inline">${escapeHtml(codes[Number(k)])}</code>`);
      text = text.replace(/\u0000L(\d+)\u0000/g, (_, k) => {
        const link = links[Number(k)];
        const labelHtml = emphasize(escapeHtml(link.label));
        const safe = safeHref(link.href);
        if (!safe) return `${labelHtml} (${escapeHtml(link.href)})`;
        const title = link.title ? ` title="${escapeHtml(link.title)}"` : "";
        return `<a href="${escapeHtml(safe)}"${title} target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
      });
      return text;
    }
    function artifactChip(body) {
      const lines = String(body ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      let id = "";
      let title = "";
      if (lines.length === 1 && lines[0].includes("|")) {
        [id, title] = lines[0].split("|");
      } else {
        id = lines[0] ?? "";
        title = lines[1] ?? "";
      }
      id = id.trim();
      title = (title || "Artifact").trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
      return `<button type="button" class="artifact-chip" data-artifact-id="${escapeHtml(id)}" title="Open the artifact"><span class="artifact-chip-icon">\u25C8</span><span class="artifact-chip-title">${escapeHtml(title)}</span><span class="artifact-chip-hint">Open</span></button>`;
    }
    function codeBlock(lang, body, opts = {}) {
      const langLabel = String(lang || "text");
      const highlighted = opts.mermaid === true ? body : highlightCode(body, langLabel);
      const copy = encodeURIComponent(body);
      return `<div class="code-block-wrap${opts.mermaid ? " mermaid-source" : ""}"><div class="code-block-head"><span class="code-lang">${escapeHtml(langLabel)}</span><button class="code-copy" data-code="${copy}">\u29C9 Copy</button></div><pre class="code-block">${highlighted}</pre></div>`;
    }
    function tableHtml(lines) {
      const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(lines[0]);
      const sep = cells(lines[1]);
      const align = sep.map((s) => /^:.*:$/.test(s) ? "center" : /:$/.test(s) ? "right" : /^:/.test(s) ? "left" : null);
      const rows = lines.slice(2).map(cells);
      let out = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
      header.forEach((h, i) => {
        out += `<th${align[i] ? ` style="text-align:${align[i]}"` : ""}>${inline(h)}</th>`;
      });
      out += "</tr></thead><tbody>";
      for (const row of rows) {
        out += "<tr>";
        header.forEach((_, i) => {
          out += `<td${align[i] ? ` style="text-align:${align[i]}"` : ""}>${inline(row[i] ?? "")}</td>`;
        });
        out += "</tr>";
      }
      return `${out}</tbody></table></div>`;
    }
    function listHtml(lines) {
      const items = lines.map((line) => {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
        const indent = m ? m[1].replace(/\t/g, "  ").length : 0;
        const ordered = m ? /\d/.test(m[2]) : false;
        let body = m ? m[3] : line.trim();
        let task = null;
        const t = /^\[( |x|X)\]\s+(.*)$/.exec(body);
        if (t) {
          task = t[1] !== " ";
          body = t[2];
        }
        return { depth: Math.floor(indent / 2), ordered, body, task };
      });
      if (!items.length) return "";
      const min = Math.min(...items.map((i2) => i2.depth));
      for (const item of items) item.depth -= min;
      const build = (start, depth) => {
        const ordered = items[start].ordered;
        const open = ordered ? "ol" : "ul";
        let html = `<${open}>`;
        let i2 = start;
        while (i2 < items.length && items[i2].depth === depth && items[i2].ordered === ordered) {
          const item = items[i2];
          const checkbox = item.task == null ? "" : `<span class="md-task${item.task ? " done" : ""}">${item.task ? "\u2611" : "\u2610"}</span> `;
          let inner = checkbox + inline(item.body);
          i2 += 1;
          if (i2 < items.length && items[i2].depth > depth) {
            const child = build(i2, items[i2].depth);
            inner += child.html;
            i2 = child.next;
          }
          html += `<li${item.task == null ? "" : ' class="md-task-item"'}>${inner}</li>`;
        }
        return { html: `${html}</${open}>`, next: i2 };
      };
      let out = "";
      let i = 0;
      while (i < items.length) {
        const chunk = build(i, items[i].depth);
        out += chunk.html;
        i = chunk.next;
      }
      return out;
    }
    var isTableSep = (line) => /^\s*\|?[\s:-]*\|[\s|:-]*\|?\s*$/.test(line) && line.includes("-");
    var isRule = (line) => /^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line);
    var isFence = (line) => /^\s*```/.test(line);
    var isHeading = (line) => /^\s{0,3}(#{1,6})\s+/.test(line);
    var isListItem = (line) => /^\s*([-*+]|\d+[.)])\s+/.test(line);
    var isQuote = (line) => /^\s*>\s?/.test(line);
    function renderMarkdown2(text) {
      const src = String(text ?? "").replace(/\r\n?/g, "\n");
      const lines = src.split("\n");
      const out = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
          i += 1;
          continue;
        }
        const fence = /^\s*```(\S*)\s*$/.exec(line);
        if (fence) {
          const lang = fence[1] || "text";
          const body = [];
          i += 1;
          while (i < lines.length && !isFence(lines[i])) {
            body.push(lines[i]);
            i += 1;
          }
          i += 1;
          const code = body.join("\n");
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
        if (/^\s*\$\$/.test(line)) {
          const rest = line.replace(/^\s*\$\$/, "");
          if (/\$\$\s*$/.test(rest)) {
            out.push(renderMath(rest.replace(/\$\$\s*$/, ""), true));
            i += 1;
            continue;
          }
          const body = [rest];
          i += 1;
          while (i < lines.length && !/\$\$\s*$/.test(lines[i])) {
            body.push(lines[i]);
            i += 1;
          }
          if (i < lines.length) body.push(lines[i].replace(/\$\$\s*$/, ""));
          out.push(renderMath(body.join("\n"), true));
          i += 1;
          continue;
        }
        const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          const level = Math.min(6, Math.max(1, heading[1].length));
          const tag = level <= 2 ? "h3" : `h${Math.min(6, level + 1)}`;
          out.push(`<${tag}>${inline(heading[2].replace(/\s#+\s*$/, ""))}</${tag}>`);
          i += 1;
          continue;
        }
        if (isRule(line)) {
          out.push("<hr>");
          i += 1;
          continue;
        }
        if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          const block = [lines[i], lines[i + 1]];
          i += 2;
          while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
            block.push(lines[i]);
            i += 1;
          }
          out.push(tableHtml(block));
          continue;
        }
        if (isQuote(line)) {
          const body = [];
          while (i < lines.length && isQuote(lines[i])) {
            body.push(lines[i].replace(/^\s*>\s?/, ""));
            i += 1;
          }
          out.push(`<blockquote>${renderMarkdown2(body.join("\n"))}</blockquote>`);
          continue;
        }
        if (isListItem(line)) {
          const block = [];
          while (i < lines.length && (isListItem(lines[i]) || lines[i].trim() && /^\s{2,}/.test(lines[i]) && block.length)) {
            block.push(lines[i]);
            i += 1;
          }
          out.push(listHtml(block));
          continue;
        }
        const para = [line];
        i += 1;
        while (i < lines.length && lines[i].trim() && !isFence(lines[i]) && !isHeading(lines[i]) && !isListItem(lines[i]) && !isQuote(lines[i]) && !isRule(lines[i]) && !/^\s*\$\$/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
          para.push(lines[i]);
          i += 1;
        }
        out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      }
      return out.join("");
    }
    module.exports = { renderMarkdown: renderMarkdown2, inline, renderMath, renderMermaid, highlightCode, escapeHtml, safeHref, artifactChip };
  }
});

// src/renderer-src/cards/Cards.jsx
import React, { useMemo as useMemo2, useState as useState2 } from "react";

// src/renderer-src/lib.js
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
var import_markdown = __toESM(require_markdown());
var { api, events } = window.quansiox;

// src/renderer-src/Icons.jsx
import { jsx, jsxs } from "react/jsx-runtime";
var p = { className: "ic", viewBox: "0 0 24 24", "aria-hidden": true };
var Icon = {
  Plus: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M12 5v14M5 12h14" }) }),
  Search: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("circle", { cx: "11", cy: "11", r: "7" }),
    /* @__PURE__ */ jsx("path", { d: "m20 20-3.5-3.5" })
  ] }),
  Settings: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "3" }),
    /* @__PURE__ */ jsx("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" })
  ] }),
  Send: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "m3 11 18-8-8 18-2.5-7.5L3 11z" }) }),
  Stop: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("rect", { x: "6", y: "6", width: "12", height: "12", rx: "2", fill: "currentColor", stroke: "none" }) }),
  Paperclip: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M21 12.5 12.5 21a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 19a2 2 0 0 1-3-3l8-8" }) }),
  Link: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }),
    /* @__PURE__ */ jsx("path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" })
  ] }),
  Camera: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z" }),
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "13", r: "3.5" })
  ] }),
  Star: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "m12 3 2.7 5.6 6.3.9-4.5 4.4 1 6.1-5.5-2.9-5.5 2.9 1-6.1L3 9.5l6.3-.9L12 3z" }) }),
  Play: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M7 4.5v15l12-7.5-12-7.5z" }) }),
  Pause: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M7 4v16M17 4v16" }) }),
  SkipBack: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M19 5v14L8 12l11-7z" }),
    /* @__PURE__ */ jsx("path", { d: "M5 5v14" })
  ] }),
  SkipFwd: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M5 5v14l11-7L5 5z" }),
    /* @__PURE__ */ jsx("path", { d: "M19 5v14" })
  ] }),
  Expand: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" }) }),
  Popout: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M14 3h7v7" }),
    /* @__PURE__ */ jsx("path", { d: "M21 3 10 14" }),
    /* @__PURE__ */ jsx("path", { d: "M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" })
  ] }),
  Copy: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("rect", { x: "9", y: "9", width: "12", height: "12", rx: "2" }),
    /* @__PURE__ */ jsx("path", { d: "M5 15V5a2 2 0 0 1 2-2h10" })
  ] }),
  Check: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "m4.5 12.5 5 5 10-11" }) }),
  X: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M6 6l12 12M18 6 6 18" }) }),
  ChevronRight: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "m9 5 7 7-7 7" }) }),
  ChevronLeft: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "m15 5-7 7 7 7" }) }),
  ChevronDown: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "m5 9 7 7 7-7" }) }),
  Refresh: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M21 12a9 9 0 1 1-2.6-6.4" }),
    /* @__PURE__ */ jsx("path", { d: "M21 3v6h-6" })
  ] }),
  Undo: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M3 12a9 9 0 1 0 2.6-6.4" }),
    /* @__PURE__ */ jsx("path", { d: "M3 3v6h6" })
  ] }),
  Terminal: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "m5 7 5 5-5 5" }),
    /* @__PURE__ */ jsx("path", { d: "M13 17h6" }),
    /* @__PURE__ */ jsx("rect", { x: "2", y: "3", width: "20", height: "18", rx: "2" })
  ] }),
  File: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" }),
    /* @__PURE__ */ jsx("path", { d: "M14 2v6h6" })
  ] }),
  Folder: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" }) }),
  Git: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("circle", { cx: "6", cy: "6", r: "2.5" }),
    /* @__PURE__ */ jsx("circle", { cx: "6", cy: "18", r: "2.5" }),
    /* @__PURE__ */ jsx("circle", { cx: "18", cy: "12", r: "2.5" }),
    /* @__PURE__ */ jsx("path", { d: "M6 8.5v7M8.5 6h4a3 3 0 0 1 3 3v.8" })
  ] }),
  Brain: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M9.5 2A2.5 2.5 0 0 0 7 4.5v.6A3.5 3.5 0 0 0 4.5 8.5c0 .7.2 1.3.5 1.8A3.5 3.5 0 0 0 3 13.5 3.5 3.5 0 0 0 6.5 17h.5v.5A2.5 2.5 0 0 0 9.5 20h.5V2h-.5z" }),
    /* @__PURE__ */ jsx("path", { d: "M14.5 2A2.5 2.5 0 0 1 17 4.5v.6a3.5 3.5 0 0 1 2.5 3.4c0 .7-.2 1.3-.5 1.8a3.5 3.5 0 0 1 2 3.2 3.5 3.5 0 0 1-3.5 3.5h-.5v.5a2.5 2.5 0 0 1-2.5 2.5h-.5V2h.5z" })
  ] }),
  ListChecks: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "m3 6 2 2 3-3M3 13l2 2 3-3M3 20l2 2 3-3", transform: "translate(0,-2)" }),
    /* @__PURE__ */ jsx("path", { d: "M12 5h9M12 12h9M12 19h9" })
  ] }),
  Sparkle: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" }) }),
  Zap: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M13 2 4 14h6l-1 8 9-12h-6l1-8z" }) }),
  Globe: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ jsx("path", { d: "M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" })
  ] }),
  Clock: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ jsx("path", { d: "M12 7v5l3 2" })
  ] }),
  Trash: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" }) }),
  Edit: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" }) }),
  Info: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ jsx("path", { d: "M12 8h.01M11 12h1v5h1" })
  ] }),
  Sun: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "4" }),
    /* @__PURE__ */ jsx("path", { d: "M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" })
  ] }),
  Moon: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" }) }),
  Command: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("path", { d: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6z" }) }),
  Dot: () => /* @__PURE__ */ jsx("svg", { ...p, children: /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "4", fill: "currentColor", stroke: "none" }) }),
  Sidebar: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }),
    /* @__PURE__ */ jsx("path", { d: "M9.5 4v16" })
  ] }),
  Pin: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M12 17v5" }),
    /* @__PURE__ */ jsx("path", { d: "M9 3h6l-1 7 3 3v2H7v-2l3-3-1-7z" })
  ] }),
  EyeOff: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M3 3l18 18" }),
    /* @__PURE__ */ jsx("path", { d: "M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7-.3.8-1 1.9-2 3M6.6 6.6C4.6 7.9 3 9.9 2 12c1 2.5 5 7 10 7 1.5 0 2.9-.4 4.2-1" }),
    /* @__PURE__ */ jsx("path", { d: "M9.9 9.9a3 3 0 0 0 4.2 4.2" })
  ] }),
  Eye: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7s-9-4.5-10-7z" }),
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "3" })
  ] }),
  Mic: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("rect", { x: "9", y: "3", width: "6", height: "11", rx: "3" }),
    /* @__PURE__ */ jsx("path", { d: "M5 11a7 7 0 0 0 14 0" }),
    /* @__PURE__ */ jsx("path", { d: "M12 18v3" })
  ] }),
  Speaker: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "M4 9.5v5h3.5L12 18V6L7.5 9.5H4z" }),
    /* @__PURE__ */ jsx("path", { d: "M15.5 9a4.5 4.5 0 0 1 0 6" }),
    /* @__PURE__ */ jsx("path", { d: "M18 6.5a8 8 0 0 1 0 11" })
  ] }),
  Reply: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("path", { d: "m9 14-5-5 5-5" }),
    /* @__PURE__ */ jsx("path", { d: "M4 9h10a6 6 0 0 1 6 6v4" })
  ] }),
  Smile: () => /* @__PURE__ */ jsxs("svg", { ...p, children: [
    /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "9" }),
    /* @__PURE__ */ jsx("path", { d: "M8 14s1.5 2 4 2 4-2 4-2" }),
    /* @__PURE__ */ jsx("path", { d: "M9.2 9.2h.01M14.8 9.2h.01" })
  ] })
};

// src/renderer-src/cards/registry.js
var KIND = {
  SEND_MESSAGE: "send-message",
  EVENT: "event",
  MESSAGE: "message",
  USER_ATTACHMENT: "user-attachment",
  MCP_APP: "mcp-app",
  NOTICE: "notice",
  FEEDBACK: "feedback",
  VOICE_CALL: "voice-call"
};
var RESOLUTION = {
  NONE: "none",
  /** The user answers an approval prompt in the transcript. */
  CONFIRM: "confirm",
  /** The user fills a form in the transcript. */
  FORM: "form",
  /** The user answers a multiple-choice widget. */
  WIDGET: "widget",
  /** The user edits a draft and sends it. */
  DRAFT: "draft",
  /** The user provides a secret. */
  SECRET: "secret"
};
var RENDER = {
  CARD: "card",
  OUTCOME: "outcome",
  SILENT: "silent"
};
var SEND_MESSAGE = {
  text: { title: "Message", fields: ["content", "images"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  attachment: { title: "Attachment", fields: ["url", "file_name", "channel"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  widget: { title: "Question", fields: ["widget"], resolution: RESOLUTION.WIDGET, render: RENDER.CARD },
  "cursor-agent": { title: "Cloud agent", fields: ["bcId", "title"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "secret-request": { title: "Secret needed", fields: ["secretRequest"], resolution: RESOLUTION.SECRET, render: RENDER.CARD },
  "credential-request": { title: "Credential needed", fields: ["credentialRequest"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "user-form": { title: "Input requested", fields: ["formRequest"], resolution: RESOLUTION.FORM, render: RENDER.CARD },
  "email-draft": { title: "Email draft", fields: ["draft"], resolution: RESOLUTION.DRAFT, render: RENDER.CARD },
  "slack-draft": { title: "Slack draft", fields: ["draft"], resolution: RESOLUTION.DRAFT, render: RENDER.CARD },
  "meeting-chat-draft": { title: "Meeting message draft", fields: ["draft"], resolution: RESOLUTION.DRAFT, render: RENDER.CARD },
  "calendar-event": { title: "Calendar event", fields: ["event"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "permission-request": { title: "Permission needed", fields: ["permission"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  connector: { title: "Connect a service", fields: ["connector", "variant"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  connectors: { title: "Connect services", fields: ["connectors"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "listener-connect": { title: "Connect a listener", fields: ["platform"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "scm-connect": { title: "Connect a repository", fields: ["provider", "intent", "reason"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "onepassword-connect": { title: "Connect 1Password", fields: [], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "team-access": { title: "Share with the team", fields: ["reason"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "slack-connect": { title: "Connect Slack", fields: ["reason"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "bot-template-share": { title: "Publish this agent", fields: ["shareId", "name", "body"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "auto-review-approval": { title: "Safety review", fields: ["approval"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "meeting-join-consent": { title: "Join this meeting?", fields: ["approval"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "connector-grant": { title: "Share data with a connector", fields: ["ask"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "local-tool-permission": { title: "Run this on your computer", fields: ["ask"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "virtual-card-approval": { title: "Approve this purchase", fields: ["approval"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "cookie-origin-approval": { title: "Read cookies for this site", fields: ["approval"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "publish-approval": { title: "Publish this app", fields: ["approval"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "app-secrets-request": { title: "The app needs secrets", fields: ["request"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  "mobile-tool-permission": { title: "Run this on a paired device", fields: ["permission"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  // The local-first addition: the agent hands the conversation to another
  // agent. The reference implementation has no equivalent — its agents live
  // in a cloud and hand off through a backend.
  handoff: { title: "Handing over", fields: ["handoff"], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD }
};
var EVENT = {
  "name-changed": { title: "Renamed", fields: ["name"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "channel-connected": { title: "Channel connected", fields: ["channel"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "channel-disconnected": { title: "Channel disconnected", fields: ["channel"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "automation-changed": { title: "Automation changed", fields: ["automation"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "task-changed": { title: "Task changed", fields: ["task"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "team-shared": { title: "Shared with the team", fields: ["agent"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "team-bot-publish": { title: "Published to the team", fields: ["agent"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "person-added": { title: "Someone joined", fields: ["person"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "person-removed": { title: "Someone left", fields: ["person"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "person-left": { title: "Someone left", fields: ["person"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "bot-added": { title: "Agent added", fields: ["bot"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "bot-removed": { title: "Agent removed", fields: ["bot"], resolution: RESOLUTION.NONE, render: RENDER.CARD }
};
var OTHER = {
  message: { kind: KIND.MESSAGE, title: "Message", fields: ["content", "role", "channel", "fromAgent", "toAgent", "author", "replyTo", "branched", "batchId", "isStreaming"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "user-attachment": { kind: KIND.USER_ATTACHMENT, title: "Your attachment", fields: ["file_path", "replyTo"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "mcp-app": { kind: KIND.MCP_APP, title: "App", fields: ["resourceUri"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  notice: { kind: KIND.NOTICE, title: "Notice", fields: ["text"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  feedback: { kind: KIND.FEEDBACK, title: "Feedback", fields: ["state", "sentiment"], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  "voice-call": { kind: KIND.VOICE_CALL, title: "Voice call", fields: ["call"], resolution: RESOLUTION.NONE, render: RENDER.CARD }
};
var REGISTRY = {
  [KIND.SEND_MESSAGE]: SEND_MESSAGE,
  [KIND.EVENT]: EVENT,
  [KIND.MESSAGE]: { message: OTHER.message },
  [KIND.USER_ATTACHMENT]: { "user-attachment": OTHER["user-attachment"] },
  [KIND.MCP_APP]: { "mcp-app": OTHER["mcp-app"] },
  [KIND.NOTICE]: { notice: OTHER.notice },
  [KIND.FEEDBACK]: { feedback: OTHER.feedback },
  [KIND.VOICE_CALL]: { "voice-call": OTHER["voice-call"] }
};
function cardKey(kind, type) {
  return `${kind}:${type}`;
}
function describeCard(kind, type) {
  const group = REGISTRY[kind];
  const descriptor = group?.[type];
  if (!descriptor) return null;
  return { kind, type, ...descriptor };
}
function allCards() {
  const out = [];
  for (const [kind, group] of Object.entries(REGISTRY)) {
    for (const type of Object.keys(group)) {
      out.push(describeCard(kind, type));
    }
  }
  return out;
}
function isPending(card, resolutionState) {
  if (!card) return false;
  if (card.resolution === RESOLUTION.NONE) return false;
  if (!resolutionState) return true;
  return resolutionState.pending === true;
}

// src/renderer-src/cards/Cards.jsx
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function Field({ label, value }) {
  if (value == null || value === "") return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /* @__PURE__ */ jsxs2("div", { className: "card-field", "data-field": label, children: [
    /* @__PURE__ */ jsx2("span", { className: "card-field-label", children: label }),
    /* @__PURE__ */ jsx2("span", { className: "card-field-value", children: text.slice(0, 600) })
  ] });
}
function Decision({ entry, onDone, children }) {
  const [busy, setBusy] = useState2(false);
  const [decided, setDecided] = useState2(null);
  const pending = isPending(describeCard(entry.kind, entry.type), entry.resolution);
  const answer = async (approved, scope = "once") => {
    setBusy(true);
    try {
      if (entry.resolutionId) {
        await api.confirmations.respond({ id: entry.resolutionId, approved, scope });
      } else if (entry.interactionId) {
        if (approved) await api.interactions.submitForm({ entryId: entry.interactionId, values: entry.values ?? {} });
        else await api.interactions.dismissForm({ entryId: entry.interactionId, mode: "denied" });
      }
      setDecided(approved ? "allowed" : "denied");
      onDone?.(approved);
    } catch (error) {
      setDecided("error");
    } finally {
      setBusy(false);
    }
  };
  if (decided) {
    return /* @__PURE__ */ jsxs2("div", { className: "card-outcome", "data-outcome": decided, children: [
      /* @__PURE__ */ jsx2("span", { className: "card-outcome-icon", children: decided === "allowed" ? /* @__PURE__ */ jsx2(Icon.Check, {}) : /* @__PURE__ */ jsx2(Icon.X, {}) }),
      /* @__PURE__ */ jsx2("span", { children: decided === "allowed" ? "Allowed" : decided === "denied" ? "Denied" : "Could not be answered" })
    ] });
  }
  if (!pending) {
    const text = entry.resolution?.text ?? entry.resolution?.reason ?? (entry.resolution?.state ? `Settled \u2014 ${entry.resolution.state}` : "Settled");
    return /* @__PURE__ */ jsx2("div", { className: "card-outcome", "data-outcome": "settled", children: /* @__PURE__ */ jsx2("span", { children: text }) });
  }
  return /* @__PURE__ */ jsxs2("div", { className: "card-actions", children: [
    children,
    /* @__PURE__ */ jsx2("button", { className: "btn btn-primary", disabled: busy, onClick: () => answer(true, "once"), children: "Allow once" }),
    /* @__PURE__ */ jsx2("button", { className: "btn btn-secondary", disabled: busy, onClick: () => answer(true, "always"), children: "Always allow" }),
    /* @__PURE__ */ jsx2("button", { className: "btn btn-danger", disabled: busy, onClick: () => answer(false, "once"), children: "Deny" })
  ] });
}
function Widget({ entry, onDone }) {
  const [busy, setBusy] = useState2(false);
  const widget = entry.payload?.widget ?? {};
  const options = Array.isArray(widget.options) ? widget.options : [];
  if (!options.length) return null;
  const answer = async (option) => {
    setBusy(true);
    try {
      await api.interactions.respondWidget({ id: entry.interactionId, value: option.value ?? option });
      onDone?.();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsx2("div", { className: "card-actions", "data-surface": "widget-options", children: options.map((option) => /* @__PURE__ */ jsx2(
    "button",
    {
      className: "btn btn-secondary",
      disabled: busy,
      onClick: () => answer(option),
      children: option.label ?? option.title ?? String(option.value ?? option)
    },
    String(option.value ?? option)
  )) });
}
function Form({ entry, onDone }) {
  const request = entry.payload?.formRequest ?? {};
  const fields = Array.isArray(request.fields) ? request.fields : [];
  const [values, setValues] = useState2({});
  const [busy, setBusy] = useState2(false);
  if (!fields.length) return null;
  const submit = async () => {
    setBusy(true);
    try {
      await api.interactions.submitForm({ entryId: entry.interactionId, values });
      onDone?.();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsxs2("div", { className: "card-form", "data-surface": "card-form", children: [
    fields.map((field) => /* @__PURE__ */ jsxs2("label", { className: "card-form-field", children: [
      /* @__PURE__ */ jsx2("span", { children: field.label ?? field.name }),
      field.type === "checkbox" ? /* @__PURE__ */ jsx2("input", { type: "checkbox", checked: Boolean(values[field.name]), onChange: (e) => setValues((v) => ({ ...v, [field.name]: e.target.checked })) }) : /* @__PURE__ */ jsx2(
        "input",
        {
          type: field.type === "password" ? "password" : "text",
          value: values[field.name] ?? "",
          onChange: (e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))
        }
      )
    ] }, field.name)),
    /* @__PURE__ */ jsxs2("div", { className: "card-actions", children: [
      /* @__PURE__ */ jsx2("button", { className: "btn btn-primary", disabled: busy, onClick: submit, children: "Send" }),
      /* @__PURE__ */ jsx2(
        "button",
        {
          className: "btn btn-danger",
          disabled: busy,
          onClick: () => api.interactions.dismissForm({ entryId: entry.interactionId, mode: "dismissed" }).then(() => onDone?.()),
          children: "Dismiss"
        }
      )
    ] })
  ] });
}
function Draft({ entry, onDone, kind }) {
  const draft = entry.payload?.draft ?? {};
  const [text, setText] = useState2(draft.body ?? "");
  const [busy, setBusy] = useState2(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.interactions.sendDraft?.({ id: entry.interactionId, draft: { ...draft, body: text } });
      onDone?.();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsxs2("div", { className: "card-draft", "data-surface": `card-draft-${kind}`, children: [
    /* @__PURE__ */ jsx2(Field, { label: "to", value: draft.to ?? draft.target ?? draft.workspace }),
    /* @__PURE__ */ jsx2(Field, { label: "subject", value: draft.subject ?? draft.thread }),
    /* @__PURE__ */ jsx2("textarea", { className: "card-draft-body", value: text, onChange: (e) => setText(e.target.value), rows: 6 }),
    /* @__PURE__ */ jsxs2("div", { className: "card-actions", children: [
      /* @__PURE__ */ jsx2("button", { className: "btn btn-primary", disabled: busy, onClick: send, children: "Send" }),
      /* @__PURE__ */ jsx2(
        "button",
        {
          className: "btn btn-danger",
          disabled: busy,
          onClick: () => api.interactions.dismissDraft?.({ id: entry.interactionId }).then(() => onDone?.()),
          children: "Discard"
        }
      )
    ] })
  ] });
}
function SecretRequest({ entry, onDone }) {
  const request = entry.payload?.secretRequest ?? {};
  const [value, setValue] = useState2("");
  const [busy, setBusy] = useState2(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.interactions.submitSecret?.({ id: entry.interactionId, value, name: request.label });
      onDone?.();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ jsxs2("div", { className: "card-secret", "data-surface": "card-secret", children: [
    /* @__PURE__ */ jsx2("p", { children: request.description ?? request.label ?? "The agent needs a secret." }),
    /* @__PURE__ */ jsx2("input", { type: "password", value, onChange: (e) => setValue(e.target.value), placeholder: "value" }),
    /* @__PURE__ */ jsxs2("div", { className: "card-actions", children: [
      /* @__PURE__ */ jsx2("button", { className: "btn btn-primary", disabled: busy || !value, onClick: submit, children: "Provide" }),
      /* @__PURE__ */ jsx2(
        "button",
        {
          className: "btn btn-danger",
          disabled: busy,
          onClick: () => api.interactions.dismissSecret?.({ id: entry.interactionId }).then(() => onDone?.()),
          children: "Skip"
        }
      )
    ] })
  ] });
}
function CalendarEvent({ entry, onDone }) {
  const event = entry.payload?.event ?? {};
  const when = event.startMs ? new Date(Number(event.startMs)).toLocaleString() : event.subject ?? "";
  return /* @__PURE__ */ jsxs2(Fragment, { children: [
    /* @__PURE__ */ jsx2(Field, { label: "subject", value: event.subject }),
    /* @__PURE__ */ jsx2(Field, { label: "when", value: when }),
    /* @__PURE__ */ jsx2(Field, { label: "guests", value: event.guests }),
    /* @__PURE__ */ jsx2(Field, { label: "location", value: event.location?.name ?? event.location?.address }),
    /* @__PURE__ */ jsx2(Decision, { entry, onDone })
  ] });
}
function VoiceCall({ payload }) {
  const call = payload?.call ?? {};
  const minutes = Math.floor((Number(call.durationMs) || 0) / 6e4);
  const seconds = Math.floor((Number(call.durationMs) || 0) % 6e4 / 1e3);
  return /* @__PURE__ */ jsxs2("div", { className: "card-voice-call", "data-surface": "card-voice-call", children: [
    /* @__PURE__ */ jsx2(Icon.Command, {}),
    /* @__PURE__ */ jsxs2("span", { children: [
      minutes,
      ":",
      String(seconds).padStart(2, "0")
    ] }),
    call.ending ? /* @__PURE__ */ jsx2("span", { className: "card-voice-ending", children: call.ending }) : null
  ] });
}
function Feedback({ payload }) {
  return /* @__PURE__ */ jsxs2("div", { className: "card-feedback", "data-surface": "card-feedback", children: [
    /* @__PURE__ */ jsx2(Field, { label: "state", value: payload?.state }),
    /* @__PURE__ */ jsx2(Field, { label: "sentiment", value: payload?.sentiment })
  ] });
}
function McpApp({ payload }) {
  const uri = payload?.resourceUri ?? "";
  if (!uri) return null;
  return /* @__PURE__ */ jsx2("div", { className: "card-mcp-app", "data-surface": "card-mcp-app", children: /* @__PURE__ */ jsx2("iframe", { className: "card-mcp-frame", title: "app", src: uri, sandbox: "allow-scripts allow-same-origin" }) });
}
function UserAttachment({ payload }) {
  const file = payload?.file_path ?? "";
  if (!file) return null;
  return /* @__PURE__ */ jsxs2("div", { className: "card-attachment", "data-surface": "card-attachment", children: [
    /* @__PURE__ */ jsx2(Icon.File, {}),
    /* @__PURE__ */ jsx2("span", { children: file.split("/").pop() })
  ] });
}
function BotTemplateShare({ entry, payload, onDone }) {
  return /* @__PURE__ */ jsxs2(Fragment, { children: [
    /* @__PURE__ */ jsx2(Field, { label: "name", value: payload?.name }),
    /* @__PURE__ */ jsx2("p", { className: "card-body", children: String(payload?.body ?? "").slice(0, 600) }),
    /* @__PURE__ */ jsx2(Decision, { entry, onDone })
  ] });
}
function AutoReviewApproval({ entry, payload, onDone }) {
  const approval = payload?.approval ?? {};
  const rule = approval.proposedAllowRule ?? approval.command ?? null;
  return /* @__PURE__ */ jsxs2(Fragment, { children: [
    /* @__PURE__ */ jsx2(Field, { label: "surface", value: approval.surface }),
    /* @__PURE__ */ jsx2(Field, { label: "action", value: approval.command ?? approval.action }),
    rule ? /* @__PURE__ */ jsxs2("p", { className: "card-hint", children: [
      "Approving also allows: ",
      /* @__PURE__ */ jsx2("code", { children: rule })
    ] }) : null,
    /* @__PURE__ */ jsx2(Decision, { entry, onDone })
  ] });
}
function LocalToolPermission({ entry, payload, onDone }) {
  const ask = payload?.ask ?? {};
  return /* @__PURE__ */ jsxs2(Fragment, { children: [
    /* @__PURE__ */ jsx2(Field, { label: "action", value: ask.action }),
    /* @__PURE__ */ jsx2(Field, { label: "target", value: ask.target }),
    /* @__PURE__ */ jsx2(Field, { label: "description", value: ask.description }),
    /* @__PURE__ */ jsx2(Field, { label: "on", value: ask.recipientName ?? ask.machineLabel }),
    /* @__PURE__ */ jsx2(Decision, { entry, onDone })
  ] });
}
function AppSecrets({ entry, payload, onDone }) {
  const request = payload?.request ?? {};
  const secrets = Array.isArray(request.secrets) ? request.secrets : [];
  return /* @__PURE__ */ jsxs2(Fragment, { children: [
    /* @__PURE__ */ jsxs2("p", { className: "card-body", children: [
      "This app needs ",
      secrets.length,
      " secret",
      secrets.length === 1 ? "" : "s",
      "."
    ] }),
    secrets.map((s) => /* @__PURE__ */ jsx2(Field, { label: s.name, value: s.description }, s.name)),
    /* @__PURE__ */ jsx2(Decision, { entry, onDone })
  ] });
}
function Handoff({ entry, payload, onDone }) {
  const handoff = payload?.handoff ?? {};
  return /* @__PURE__ */ jsxs2(Fragment, { children: [
    /* @__PURE__ */ jsx2(Field, { label: "to", value: handoff.agentName ?? handoff.agentId }),
    /* @__PURE__ */ jsx2(Field, { label: "why", value: handoff.reason }),
    /* @__PURE__ */ jsx2(Decision, { entry, onDone })
  ] });
}
function Card({ kind, type, payload, resolutionId, interactionId, resolution, onDone }) {
  const descriptor = useMemo2(() => describeCard(kind, type), [kind, type]);
  if (!descriptor) {
    return /* @__PURE__ */ jsx2("div", { className: "card unknown", "data-surface": "card-unknown", "data-card": `${kind}:${type}`, children: /* @__PURE__ */ jsx2("pre", { children: JSON.stringify(payload ?? {}, null, 2).slice(0, 2e3) }) });
  }
  const entry = { kind, type, payload, resolutionId, interactionId, resolution };
  const body = () => {
    switch (type) {
      case "text":
        return /* @__PURE__ */ jsx2("p", { className: "card-body", children: String(payload?.content ?? "").slice(0, 4e3) });
      case "attachment":
        return /* @__PURE__ */ jsxs2("div", { className: "card-attachment", children: [
          /* @__PURE__ */ jsx2(Icon.File, {}),
          /* @__PURE__ */ jsx2("span", { children: payload?.file_name ?? payload?.url })
        ] });
      case "widget":
        return /* @__PURE__ */ jsx2(Widget, { entry, onDone });
      case "user-form":
        return /* @__PURE__ */ jsx2(Form, { entry, onDone });
      case "email-draft":
      case "slack-draft":
      case "meeting-chat-draft":
        return /* @__PURE__ */ jsx2(Draft, { entry, onDone, kind: type });
      case "secret-request":
        return /* @__PURE__ */ jsx2(SecretRequest, { entry, onDone });
      case "calendar-event":
        return /* @__PURE__ */ jsx2(CalendarEvent, { entry, onDone });
      case "auto-review-approval":
        return /* @__PURE__ */ jsx2(AutoReviewApproval, { entry, payload, onDone });
      case "local-tool-permission":
      case "mobile-tool-permission":
        return /* @__PURE__ */ jsx2(LocalToolPermission, { entry, payload, onDone });
      case "app-secrets-request":
        return /* @__PURE__ */ jsx2(AppSecrets, { entry, payload, onDone });
      case "bot-template-share":
        return /* @__PURE__ */ jsx2(BotTemplateShare, { entry, payload, onDone });
      case "handoff":
        return /* @__PURE__ */ jsx2(Handoff, { entry, payload, onDone });
      case "voice-call":
        return /* @__PURE__ */ jsx2(VoiceCall, { payload });
      case "feedback":
        return /* @__PURE__ */ jsx2(Feedback, { payload });
      case "mcp-app":
        return /* @__PURE__ */ jsx2(McpApp, { payload });
      case "user-attachment":
        return /* @__PURE__ */ jsx2(UserAttachment, { payload });
      case "notice":
        return /* @__PURE__ */ jsx2("p", { className: "card-body", children: String(payload?.text ?? "") });
      default:
        break;
    }
    const fields = (descriptor.fields ?? []).map((field) => /* @__PURE__ */ jsx2(Field, { label: field, value: payload?.[field] }, field));
    return /* @__PURE__ */ jsxs2(Fragment, { children: [
      fields,
      descriptor.resolution === RESOLUTION.CONFIRM ? /* @__PURE__ */ jsx2(Decision, { entry, onDone }) : null
    ] });
  };
  return /* @__PURE__ */ jsxs2("div", { className: "card", "data-surface": "card", "data-card": `${kind}:${type}`, "data-kind": kind, "data-type": type, children: [
    /* @__PURE__ */ jsx2("div", { className: "card-header", children: /* @__PURE__ */ jsx2("span", { className: "card-title", children: descriptor.title }) }),
    body()
  ] });
}

// src/renderer-src/DiffView.jsx
import React2, { useMemo as useMemo3, useState as useState3 } from "react";
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function parseDiff(diff) {
  const text = String(diff ?? "");
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const hunks = [];
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    const header = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { header: line, section: header[3].trim(), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      continue;
    }
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), old: null, new: newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "remove", text: line.slice(1), old: oldLine, new: null });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: line.slice(1), old: null, new: null });
    } else {
      hunk.lines.push({ kind: "context", text: line.slice(1), old: oldLine, new: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks.filter((h) => h.lines.length);
}
function Hunk({ hunk, initiallyCollapsed }) {
  const [collapsed, setCollapsed] = useState3(initiallyCollapsed);
  const added = hunk.lines.filter((l) => l.kind === "add").length;
  const removed = hunk.lines.filter((l) => l.kind === "remove").length;
  return /* @__PURE__ */ jsxs3("div", { className: "diff-hunk", "data-surface": "diff-hunk", "data-added": added, "data-removed": removed, children: [
    /* @__PURE__ */ jsxs3(
      "button",
      {
        type: "button",
        className: "diff-hunk-header",
        "aria-expanded": !collapsed,
        onClick: () => setCollapsed((v) => !v),
        children: [
          /* @__PURE__ */ jsx3("span", { className: "diff-hunk-title", children: hunk.header }),
          /* @__PURE__ */ jsxs3("span", { className: "diff-hunk-counts", children: [
            added ? /* @__PURE__ */ jsxs3("span", { className: "diff-count add", children: [
              "+",
              added
            ] }) : null,
            removed ? /* @__PURE__ */ jsxs3("span", { className: "diff-count remove", children: [
              "\u2212",
              removed
            ] }) : null
          ] })
        ]
      }
    ),
    !collapsed ? /* @__PURE__ */ jsx3("div", { className: "diff-lines", children: hunk.lines.map((line, index) => /* @__PURE__ */ jsxs3("div", { className: `diff-line diff-${line.kind}`, "data-kind": line.kind, children: [
      /* @__PURE__ */ jsx3("span", { className: "diff-gutter old", children: line.old ?? "" }),
      /* @__PURE__ */ jsx3("span", { className: "diff-gutter new", children: line.new ?? "" }),
      /* @__PURE__ */ jsx3("span", { className: "diff-marker", children: line.kind === "add" ? "+" : line.kind === "remove" ? "\u2212" : " " }),
      /* @__PURE__ */ jsx3("span", { className: "diff-text", children: line.text })
    ] }, `${line.kind}-${index}`)) }) : null
  ] });
}
function DiffView({ diff, collapsible = true }) {
  const hunks = useMemo3(() => parseDiff(diff), [diff]);
  if (!hunks.length) {
    return /* @__PURE__ */ jsx3("div", { className: "diff-view diff-empty", "data-surface": "diff-view", children: /* @__PURE__ */ jsx3("span", { className: "diff-empty-text", children: "No changes" }) });
  }
  return /* @__PURE__ */ jsx3("div", { className: "diff-view", "data-surface": "diff-view", children: hunks.map((hunk, index) => /* @__PURE__ */ jsx3(Hunk, { hunk, initiallyCollapsed: collapsible && hunks.length > 2 && index > 0 }, `${hunk.header}-${index}`)) });
}
export {
  Card,
  DiffView,
  KIND,
  REGISTRY,
  RENDER,
  RESOLUTION,
  allCards,
  cardKey,
  describeCard,
  isPending,
  parseDiff
};
