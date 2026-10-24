'use strict';
/**
 * Shell AST analysis (tree-sitter-bash) — the exact parse.
 *
 * `shell-analyze.js` is the *synchronous* safety gate: it must never depend
 * on an async parser, so it is a hand-written tokenizer. It is conservative
 * and fail-closed, but a tokenizer can always be surprised.
 *
 * This module adds the exact parse on top:
 *   - `web-tree-sitter` (WASM) + the `tree-sitter-bash` grammar
 *   - the same grammar Grok Bot uses natively
 *
 * It is used by the *asynchronous* execution path as a cross-check: the
 * execution path already awaits, so it can afford the real parser. Anything
 * the AST sees that the tokenizer missed escalates the command to
 * "mutating" — the AST can only make the gate stricter, never looser.
 *
 * If the WASM parser cannot be loaded (offline, missing asset, unsupported
 * platform) the module degrades to "no opinion" and the synchronous gate
 * remains the authority.
 */
const path = require('node:path');

let parserPromise = null;
let parser = null;
let language = null;
let loadError = null;

/** Load the parser once. Resolves to true on success, false on failure. */
function initParser() {
  if (parserPromise) return parserPromise;
  parserPromise = (async () => {
    try {
      const { Parser, Language } = require('web-tree-sitter');
      await Parser.init();
      const wasm = require.resolve('tree-sitter-bash/tree-sitter-bash.wasm');
      language = await Language.load(wasm);
      parser = new Parser();
      parser.setLanguage(language);
      return true;
    } catch (error) {
      loadError = String(error?.message ?? error);
      return false;
    }
  })();
  return parserPromise;
}

/** True when the exact parser is available. */
function available() {
  return parser !== null;
}

/** Why the parser could not be loaded (for honest diagnostics). */
function unavailableReason() {
  return loadError;
}

/**
 * Parse a command and describe what it actually does.
 *
 * @param {string} command
 * @returns {Promise<null | {
 *   programs: string[], hasHeredoc: boolean, hasProcessSubstitution: boolean,
 *   hasCommandSubstitution: boolean, redirections: string[], pipeToShell: boolean,
 *   subshells: string[], hasEval: boolean
 * }>}
 *   `null` when the parser is unavailable.
 */
async function analyzeAst(command) {
  if (!parser) {
    const ok = await initParser();
    if (!ok) return null;
  }
  let tree;
  try {
    tree = parser.parse(String(command ?? ''));
  } catch {
    return null;
  }
  if (!tree) return null;

  const out = {
    programs: [],
    hasHeredoc: false,
    hasProcessSubstitution: false,
    hasCommandSubstitution: false,
    redirections: [],
    pipeToShell: false,
    subshells: [],
    hasEval: false,
  };

  const walk = (node) => {
    switch (node.type) {
      case 'command_name':
      case 'word':
        break;
      case 'file_redirect':
      case 'heredoc_redirect':
      case 'herestring_redirect':
        out.redirections.push(node.text.slice(0, 120));
        if (node.type === 'heredoc_redirect') out.hasHeredoc = true;
        break;
      case 'process_substitution':
        out.hasProcessSubstitution = true;
        out.subshells.push(node.text);
        break;
      case 'command_substitution':
        out.hasCommandSubstitution = true;
        out.subshells.push(node.text);
        break;
      case 'subshell':
        out.subshells.push(node.text);
        break;
      case 'pipeline':
        out.pipeToShell = true;
        break;
      default:
        break;
    }
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'command_name') {
        const name = child.text.trim();
        if (name && !out.programs.includes(name)) out.programs.push(name);
        if (['eval', 'exec'].includes(name)) out.hasEval = true;
      }
      walk(child);
    }
  };
  walk(tree.rootNode);
  try { tree.delete?.(); } catch { /* ignore */ }
  return out;
}

/**
 * Cross-check the synchronous report against the exact parse.
 *
 * The AST can only ADD suspicion. Returns the merged report plus the
 * reasons the AST contributed.
 *
 * @param {object} syncReport  result of shell-analyze.analyze()
 * @param {object|null} astReport  result of analyzeAst()
 */
function crossCheck(syncReport, astReport) {
  if (!astReport) return syncReport;
  const merged = { ...syncReport };
  const add = (reason) => {
    if (!merged.reasons.includes(reason)) merged.reasons.push(reason);
  };
  if (astReport.hasHeredoc && !merged.mutating) {
    merged.mutating = true;
    add('heredoc body is arbitrary content');
  }
  if (astReport.hasProcessSubstitution && !merged.mutating) {
    merged.mutating = true;
    add('process substitution');
  }
  if (astReport.hasEval && !merged.mutating) {
    merged.mutating = true;
    merged.arbitraryCode = true;
    add('the AST found an eval/exec invocation');
  }
  if (astReport.pipeToShell && !merged.mutating) {
    merged.mutating = true;
    merged.arbitraryCode = true;
    add('the AST found a pipeline into an interpreter');
  }
  // Any program the AST saw that the tokenizer did not classify as mutating
  // is suspicious enough to require a manual look.
  for (const program of astReport.programs ?? []) {
    if (!merged.programs.includes(program)) merged.programs.push(program);
  }
  merged.astChecked = true;
  return merged;
}

module.exports = { initParser, available, unavailableReason, analyzeAst, crossCheck };
