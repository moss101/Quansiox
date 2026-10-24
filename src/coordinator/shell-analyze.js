'use strict';
/**
 * Shell command analyzer — a structural tokenizer + classifier used by the
 * permission gate instead of a regex over the raw string.
 *
 * Why: `echo "a > b"` is not a redirection, `echo 'rm -rf /'` deletes nothing,
 * but `$(curl x|sh)` and `a=b cmd` do. A structural pass (quotes, escapes,
 * substitutions, pipelines) is what makes read-only/workspace gating honest.
 *
 * This is the *synchronous* safety gate. It must never depend on an async
 * parser, so it is a hand-written tokenizer with an explicit
 * fail-closed policy: anything it cannot parse is treated as mutating.
 *
 * The exact tree-sitter AST analysis lives in `shellAst.js` and is used by
 * the async execution path as a cross-check (and to derive the egress
 * policy). Grok Bot uses native `tree-sitter` + `tree-sitter-bash` for the
 * same job.
 *
 * Covered syntax:
 *  - whitespace splitting with 'single', "double" and $'ansi-c' quoting
 *  - control operators: ; && || | |& & newline
 *  - redirections: > >> < << <<< n> n>& 2>&1
 *  - command substitution: $(...) and `...` (recursively analyzed)
 *  - process substitution: <(...) and >(...) (recursively analyzed)
 *  - parameter expansion ${...} and arithmetic $((...))
 *  - heredocs (<<WORD ... WORD) — the body is arbitrary content
 *  - simple variable assignments (FOO=bar) before the program
 */

/* Programs that change the filesystem / repo / system state by themselves. */
const MUTATING_PROGRAMS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'install', 'mkdir', 'touch', 'truncate', 'dd',
  'chmod', 'chown', 'chgrp', 'ln', 'tee', 'rsync', 'shred', 'unlink',
  'sed', 'perl', 'python', 'python3', 'node', 'ruby', 'awk', 'ed', 'ex',
  'patch', 'tar', 'unzip', 'gunzip', 'gzip', 'zip', 'xz', 'pigz',
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'cargo', 'go', 'make',
  'cmake', 'docker', 'kubectl', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'apk',
  'gem', 'poetry', 'uv', 'composer', 'npx', 'touch', 'mktemp',
]);

/* (program, subcommand) pairs where only some subcommands mutate. */
const MUTATING_SUBCOMMANDS = {
  git: new Set(['commit', 'add', 'reset', 'checkout', 'switch', 'restore', 'clean', 'push', 'rebase', 'merge', 'am', 'apply', 'rm', 'mv', 'stash', 'cherry-pick', 'revert', 'tag', 'branch', 'init', 'clone', 'config', 'gc', 'submodule', 'worktree', 'filter-branch', 'update-ref']),
  npm: new Set(['install', 'i', 'ci', 'uninstall', 'remove', 'rm', 'update', 'add', 'link', 'publish', 'pack', 'version']),
  pnpm: new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'link', 'publish', 'pack']),
  yarn: new Set(['install', 'add', 'remove', 'upgrade', 'publish', 'pack']),
  bun: new Set(['install', 'add', 'remove', 'update', 'publish', 'x', 'pm']),
  pip: new Set(['install', 'uninstall']),
  pip3: new Set(['install', 'uninstall']),
  cargo: new Set(['install', 'add', 'remove', 'publish', 'fix', 'clean', 'update']),
  go: new Set(['install', 'get', 'generate', 'clean', 'mod', 'fix']),
  make: new Set(['install', 'clean']),
  docker: new Set(['run', 'rm', 'rmi', 'build', 'push', 'pull', 'exec', 'create', 'start', 'stop', 'kill', 'prune', 'volume', 'system', 'tag', 'cp', 'compose']),
  kubectl: new Set(['apply', 'delete', 'create', 'replace', 'patch', 'edit', 'scale', 'rollout', 'drain', 'exec', 'cp', 'annotate', 'label']),
  brew: new Set(['install', 'uninstall', 'upgrade', 'link', 'unlink', 'tap', 'services', 'reinstall']),
  apt: new Set(['install', 'remove', 'purge', 'update', 'upgrade', 'autoremove', 'dist-upgrade']),
  'apt-get': new Set(['install', 'remove', 'purge', 'update', 'upgrade', 'autoremove', 'dist-upgrade']),
  'systemctl': new Set(['start', 'stop', 'restart', 'enable', 'disable', 'mask', 'unmask', 'reload']),
  launchctl: new Set(['load', 'unload', 'bootstrap', 'bootout', 'enable', 'disable', 'kickstart']),
  gem: new Set(['install', 'uninstall', 'push', 'build']),
  composer: new Set(['install', 'update', 'remove', 'require', 'publish']),
  poetry: new Set(['install', 'add', 'remove', 'update', 'publish']),
  uv: new Set(['pip', 'sync', 'add', 'remove', 'publish']),
  sed: new Set(['-i']),
  tar: new Set(['-x', '-xf', '-xf', 'c', '-c', '--extract', '--create']),
};

/* Programs that permanently alter the machine when invoked with any args. */
const ALWAYS_DESTRUCTIVE = new Set([
  'mkfs', 'mkfs.ext4', 'mkfs.xfs', 'mkfs.apfs', 'halt', 'poweroff',
  'reboot', 'shutdown', 'diskutil', 'newfs', 'asr', 'diskutil',
]);

/* Programs that run arbitrary code from a string. */
const ARBITRARY_CODE_PROGRAMS = new Set(['eval', 'exec', 'source', '.'], );

/* macOS: osascript/applescript can run shell commands. */
const SCRIPTING_PROGRAMS = new Set(['osascript', 'applescript']);

/* Programs that can execute whatever they are handed. */
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun', 'osascript', 'applescript', 'pwsh', 'powershell', 'cmd', 'cmd.exe']);

/* Programs that read from the network. */
const NETWORK_PROGRAMS = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'telnet', 'ftp', 'gh', 'aws', 'gcloud', 'az', 'docker', 'kubectl', 'git', 'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'brew', 'aria2c', 'http', 'httpie']);

/* Wrappers that run another program. */
const SHELL_PROGRAMS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'env', 'sudo', 'doas', 'nohup', 'time', 'timeout', 'nice', 'ionice', 'stdbuf', 'command', 'exec']);

const HOME_OR_ROOT = /^(\/|~|\$HOME)/;

/**
 * Does an inline interpreter snippet contain a write primitive?
 *
 * Used so a read-only analysis one-liner (`python3 -c "print(1)"`) still
 * runs, while anything that could touch the filesystem fails closed.
 * Returns the name of the primitive that matched, or null.
 */
function inlineCodeWrites(code) {
  const text = String(code ?? '');
  if (!text.trim()) return 'empty inline code';
  const patterns = [
    // python
    /\bopen\s*\([^)]*['"][wa+]/, /\bos\.(remove|unlink|rename|replace|mkdir|makedirs|rmdir|chmod|chown|truncate|symlink|link)\b/,
    /\bshutil\.(rmtree|move|copy|copy2|copyfile|make_archive)\b/, /\bpathlib\b/,
    /\bsend2trash\b/, /\btruncate\s*\(/, /\bos\.system\s*\(/, /\bsubprocess\.(run|call|Popen|check_output)\b/,
    // node
    /\bfs\.(writeFile|appendFile|unlink|rmdir|rename|copyFile|mkdir|chmod|symlink|truncate|createWriteStream)\b/,
    /\bwriteFileSync\b/, /\bappendFileSync\b/, /\bunlinkSync\b/, /\bmkdirSync\b/, /\brmSync\b/,
    /\brequire\s*\(\s*['"]fs['"]\s*\)/, /\bfrom\s+['"]fs['"]/, /\bimport\s+.*\bfs\b/,
    // ruby / perl
    /\bFile\.(open|write|delete|rename|unlink|mkdir|chmod|new)\b/, /\bIO\.write\b/,
    /\bunlink\s*\(/, /\brmdir\s*\(/, /\bmkdir\s*\(/, /\bsystem\s*\(/, /\bexec\s*\(/, /\bqx\s*\(/,
    // shell inside the snippet
    /(^|[;&|])\s*(rm|mv|cp|dd|mkdir|touch|chmod|ln|truncate)\s/,
    /\brm\s+-rf\b/,
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) return m[0].trim().slice(0, 40);
  }
  return null;
}

/**
 * Structural destructive check for one simple command. Quoted text cannot
 * trigger this because the analyzer only looks at program + argument words.
 */
function segmentDestructive(segment) {
  const program = basename(segment.program || '');
  const args = segment.args || [];
  if (!program) return false;
  if (ALWAYS_DESTRUCTIVE.has(program)) return true;
  if (program.startsWith('mkfs')) return true;
  if (program === 'rm') {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const targets = args.filter((a) => !a.startsWith('-'));
    if (/[rf]/.test(flags) && targets.some((t) => HOME_OR_ROOT.test(t))) return true;
    if (args.includes('--no-preserve-root')) return true;
    return false;
  }
  if (program === 'dd') {
    if (args.some((a) => /^of=\/dev\//.test(a))) return true;
    // dd if=... of=file is a full-disk overwrite of the target
    return args.some((a) => /^of=/.test(a));
  }
  if (program === 'chmod') {
    if (args.some((a) => /^(777|-R)$/.test(a)) && args.some((a) => a === '/' || a === '-R')) return true;
    return false;
  }
  if (program === 'chown') {
    return args.some((a) => /^(root|:0)$/.test(a)) && args.some((a) => a === '/' || a.startsWith('/etc'));
  }
  if (program === 'git') {
    if (args[0] === 'push' && args.some((a) => a === '-f' || a === '--force' || a === '--force-with-lease' || a === '--force-if-includes')) return true;
    if (args[0] === 'clean' && args.some((a) => /^-[a-zA-Z]*[fdx]/.test(a))) return true;
    if (args[0] === 'reset' && args.some((a) => a === '--hard')) return true;
    return false;
  }
  if (program === 'diskutil') {
    return args[0] === 'erase' || args[0] === 'reformat' || args[0] === 'partitionDisk' || args[0] === 'apfs';
  }
  if (program === 'launchctl') {
    return args[0] === 'load' || args[0] === 'unload' || args[0] === 'bootstrap' || args[0] === 'bootout';
  }
  if (program === 'crontab') return true;
  if (program === 'defaults') return args[0] === 'write' || args[0] === 'delete';
  if (program === 'systemsetup') return true;
  if (program === 'visudo') return true;
  return false;
}

/**
 * Tokenize a shell command into words and control operators.
 * Quotes and escapes are consumed; the raw text of substitutions is kept so
 * they can be analyzed recursively. Never throws — malformed input degrades
 * to one token.
 */
function tokenize(command) {
  const src = String(command ?? '');
  const tokens = [];
  let i = 0;
  const pushWord = (word, raw) => { if (word !== '' || raw !== '') tokens.push({ type: 'word', value: word, raw: raw ?? word }); };

  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; continue; }
    if (ch === '\\' && src[i + 1] === '\n') { i += 2; continue; } // line continuation

    // Here-string / heredoc: <<< word   /  << WORD  /  <<- WORD
    // (checked before the generic control operators, which also list `<<`)
    if (ch === '<' && src[i + 1] === '<') {
      if (src[i + 2] === '<') {
        tokens.push({ type: 'op', value: '<<<' });
        i += 3;
        continue;
      }
      const stripTabs = src[i + 2] === '-';
      const m = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i + (stripTabs ? 3 : 2)));
      tokens.push({ type: 'heredoc', value: m ? m[1] : '', stripTabs });
      i += (stripTabs ? 3 : 2) + (m ? m[1].length : 0);
      continue;
    }

    // Control operators (longest match wins).
    const op = CONTROL_OPS.find((candidate) => src.startsWith(candidate, i));
    if (op) { tokens.push({ type: 'op', value: op }); i += op.length; continue; }

    // Process substitution: <( ... )  and  >( ... )
    if ((ch === '<' || ch === '>') && src[i + 1] === '(') {
      const body = readBalanced(src, i + 2, '(', ')');
      tokens.push({ type: 'process-substitution', value: body.text });
      i = body.end + 1;
      continue;
    }

    if (ch === '#') { // comment to end of line
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }

    let word = '';
    let raw = '';
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') break;
      if (CONTROL_OPS.some((candidate) => src.startsWith(candidate, i))) break;
      if ((c === '<' || c === '>') && src[i + 1] === '(') break;
      if (c === '\\') { // escape next char (line continuation included)
        raw += src.slice(i, i + 2);
        if (src[i + 1] !== '\n') word += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        const body = end === -1 ? src.slice(i + 1) : src.slice(i + 1, end);
        raw += `'${body}'`;
        word += body; // single quotes are literal
        i = end === -1 ? src.length : end + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === "'") { // $'ansi-c' quoting
        const end = src.indexOf("'", i + 2);
        const body = end === -1 ? src.slice(i + 2) : src.slice(i + 2, end);
        raw += `$'${body}'`;
        word += decodeAnsiC(body);
        i = end === -1 ? src.length : end + 1;
        continue;
      }
      if (c === '"') {
        let body = '';
        let j = i + 1;
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\') { body += src.slice(j, j + 2); j += 2; continue; }
          if (src[j] === '$' && (src[j + 1] === '(' || src[j + 1] === '{' || src[j + 1] === '[')) {
            const sub = readBalanced(src, j + 1, '(', ')');
            body += src.slice(j, sub.end + 1);
            j = sub.end + 1;
            continue;
          }
          body += src[j];
          j += 1;
        }
        raw += `"${body}"`;
        word += body; // substitution detection uses `raw`
        i = j < src.length ? j + 1 : src.length;
        continue;
      }
      if (c === '`') {
        const end = src.indexOf('`', i + 1);
        const body = end === -1 ? src.slice(i + 1) : src.slice(i + 1, end);
        raw += `\`${body}\``;
        word += ' $SUB ';
        i = end === -1 ? src.length : end + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === '(') {
        // $(( arithmetic )) is not a command substitution
        if (src[i + 2] === '(') {
          const sub = readBalanced(src, i + 2, '(', ')');
          raw += src.slice(i, sub.end + 1);
          word += ' $ARITH ';
          i = sub.end + 1;
          continue;
        }
        const sub = readBalanced(src, i + 2, '(', ')');
        raw += `$(${sub.text})`;
        word += ' $SUB ';
        i = sub.end + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        const sub = readBalanced(src, i + 1, '{', '}');
        raw += src.slice(i, sub.end + 1);
        word += ' $PARAM ';
        i = sub.end + 1;
        continue;
      }
      raw += c;
      word += c;
      i += 1;
    }
    pushWord(word, raw);
  }
  return tokens;
}

/**
 * Read a balanced region starting at `start` (just after the opening
 * bracket). Returns { text, end } where `end` is the index of the closing
 * bracket.
 */
function readBalanced(src, start, open, close) {
  let depth = 1;
  let j = start;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === "'") {
      const end = src.indexOf("'", j + 1);
      j = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) { depth -= 1; if (depth === 0) break; }
    j += 1;
  }
  return { text: src.slice(start, j), end: j };
}

/** Decode a `$'...'` ANSI-C quoted string. */
function decodeAnsiC(body) {
  return String(body ?? '')
    .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
    .replace(/\\0/g, '\0').replace(/\\\\/g, '\\').replace(/\\'/g, "'");
}

const CONTROL_OPS = [
  ';;&', '|&', '&&', '||', ';;', ';&', '<<', '>>>', '>>', '>|', '<&', '>&',
  '<', '>', '|', ';', '&', '\n',
];

/** Split token list into simple-command segments (pipelines and sequences). */
function splitSegments(tokens) {
  const segments = [];
  let argv = [];
  let rawArgs = [];
  let ops = [];
  const flush = () => {
    if (argv.length || ops.length) segments.push({ argv, rawArgs, ops, raw: argv.join(' ') });
    argv = [];
    rawArgs = [];
    ops = [];
  };
  for (const token of tokens) {
    if (token.type === 'op') {
      ops.push(token.value);
      if (['&&', '||', ';', '&', '|', '|&', '\n', ';&', ';;', ';;&'].includes(token.value)) flush();
    } else if (token.type === 'process-substitution') {
      // a process substitution is part of the enclosing command
      rawArgs.push(`<(${token.value})`);
      argv.push('$SUBST');
    } else if (token.type === 'heredoc') {
      ops.push('<<');
      rawArgs.push(`<<${token.value}`);
      argv.push('$HEREDOC');
    } else {
      argv.push(token.value);
      rawArgs.push(token.raw);
    }
  }
  flush();
  return segments;
}

/** Extract `$(...)` / backtick bodies from a raw word for recursion. */
function substitutionsOf(raw) {
  const out = [];
  const src = String(raw ?? '');
  let i = 0;
  while (i < src.length) {
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      out.push(src.slice(i + 1, end === -1 ? src.length : end));
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (src[i] === '$' && src[i + 1] === '(') {
      if (src[i + 2] === '(') { i += 3; continue; }
      const sub = readBalanced(src, i + 2, '(', ')');
      out.push(sub.text);
      i = sub.end + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Resolve the effective program of a segment.
 *
 * Wrappers (sudo/env/nohup/timeout/xargs) are unwrapped, but we STOP at a
 * shell program: `sudo bash -c 'rm -rf /'` must keep `bash` as the program so
 * the caller can analyze the `-c` payload. Unwrapping past the shell was a
 * real bug — it hid the payload from the destructive check.
 */
function programOf(argv) {
  let index = 0;
  // Skip leading VAR=value assignments and wrappers (sudo/env/time/nohup).
  while (index < argv.length) {
    const word = argv[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { index += 1; continue; }
    break;
  }
  let program = argv[index] ?? '';
  let rest = argv.slice(index + 1);
  if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(program)) {
    return { program, args: rest };
  }
  if (SHELL_PROGRAMS.has(program)) {
    // unwrap: sudo -u x cmd / env FOO=1 cmd / nohup cmd
    let guard = 0;
    while (SHELL_PROGRAMS.has(program) && rest.length && guard < 8) {
      guard += 1;
      if (['sudo', 'doas'].includes(program)) {
        // drop sudo flags (-u user, -E, -n, -H, -g group, ...)
        while (rest.length && (rest[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) {
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) { rest = rest.slice(1); continue; }
          // `-u user` takes a value
          if (/^-[ug]$/.test(rest[0]) && rest.length > 1) { rest = rest.slice(2); continue; }
          rest = rest.slice(1);
        }
      }
      const nextIndex = rest.findIndex((w) => !w.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      if (nextIndex === -1) break;
      const next = rest[nextIndex];
      if (program === 'xargs') { program = next; rest = rest.slice(nextIndex + 1); break; }
      program = next;
      rest = rest.slice(nextIndex + 1);
      // If we landed on a shell, stop — its -c payload is analyzed separately.
      if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(program)) break;
    }
    if (program === 'env' || program === 'eval' || program === 'exec') program = rest[0] ?? program;
  }
  return { program: String(program), args: rest };
}

function basename(p) {
  const s = String(p ?? '');
  const slash = s.lastIndexOf('/');
  return slash === -1 ? s : s.slice(slash + 1);
}

/**
 * Analyze a command string. Returns a structural report.
 * @param {string} command
 * @param {number} [depth] recursion guard for nested substitutions
 */
function analyze(command, depth = 0) {
  const report = {
    segments: [], mutating: false, destructive: false, network: false,
    privileged: false, pipeToShell: false, substitutions: [], reasons: [],
    unparsed: false, programs: [], domains: [], heredocs: false,
    processSubstitution: false, arbitraryCode: false,
  };
  if (depth > 4) { report.mutating = true; report.unparsed = true; report.reasons.push('nesting too deep'); return report; }
  const tokens = tokenize(command);
  if (!tokens.length) return report;
  const segments = splitSegments(tokens);
  const raw = String(command ?? '');

  if (/\bsudo\b|\bdoas\b/.test(raw)) { report.privileged = true; report.mutating = true; report.reasons.push('privileged (sudo/doas)'); }

  for (const segment of segments) {
    const { program: rawProgram, args } = programOf(segment.argv);
    const program = basename(rawProgram);
    segment.program = program;
    segment.args = args;
    report.segments.push({ program, args: args.slice(0, 20) });
    if (program && !report.programs.includes(program)) report.programs.push(program);

    // process substitution and heredocs
    for (const token of tokens) {
      if (token.type === 'process-substitution') {
        report.processSubstitution = true;
        const nested = analyze(token.value, depth + 1);
        report.substitutions.push(nested);
        if (nested.mutating) { report.mutating = true; report.reasons.push('process substitution'); }
        if (nested.destructive) report.destructive = true;
        if (nested.network) report.network = true;
      }
      if (token.type === 'heredoc') {
        report.heredocs = true;
        report.mutating = true;
        report.reasons.push('heredoc body is arbitrary content');
      }
    }

    if (program && MUTATING_PROGRAMS.has(program)) {
      const sub = args[0];
      const subcommands = MUTATING_SUBCOMMANDS[program];
      // Programs with a subcommand set (git/npm/docker/…) mutate only when a
      // mutating subcommand is present; bare ones (rm/mv/cp/…) always mutate.
      const mutates = subcommands ? args.some((a) => subcommands.has(a)) : true;
      if (program === 'sed') {
        if (args.some((a) => a === '-i' || /^-i/.test(a))) { report.mutating = true; report.reasons.push('in-place edit (sed -i)'); }
      } else if (['python', 'python3', 'node', 'ruby', 'perl', 'awk', 'ed', 'ex'].includes(program)) {
        // Interpreters can write. Inline code (`-c` / `-e`) is inspected for
        // write primitives: a read-only analysis one-liner must still work,
        // but anything that could touch the filesystem fails closed.
        const inline = args.find((a) => a === '-c' || a === '-e');
        if (inline) {
          const code = args[args.indexOf(inline) + 1] ?? '';
          const writes = inlineCodeWrites(code);
          if (writes) {
            report.mutating = true;
            report.reasons.push(`inline ${program} code writes (${writes})`);
          }
        } else {
          report.mutating = true;
          report.reasons.push(`${program} script may write`);
        }
      } else if (mutates) { report.mutating = true; report.reasons.push(`${program} ${sub ?? ''}`.trim()); }
    }

    // `eval` / `exec` with a string run arbitrary code.
    if (program && ARBITRARY_CODE_PROGRAMS.has(program)) {
      report.arbitraryCode = true;
      report.mutating = true;
      report.reasons.push(`${program} runs arbitrary code`);
    }

    // macOS scripting bridges to the shell.
    if (program && SCRIPTING_PROGRAMS.has(program)) {
      const script = args.join(' ');
      if (/do shell script/i.test(script)) {
        report.arbitraryCode = true;
        report.mutating = true;
        report.destructive = true;
        report.reasons.push(`${program} "do shell script" runs arbitrary code`);
        const m = /do shell script\s+"([\s\S]*?)"/i.exec(script);
        if (m) {
          const nested = analyze(m[1], depth + 1);
          report.substitutions.push(nested);
          if (nested.destructive) report.destructive = true;
        }
      }
    }

    // `find ... -exec <prog>` runs another program.
    if (program === 'find') {
      const execIndex = args.findIndex((a) => a === '-exec' || a === '-execdir');
      if (execIndex !== -1) {
        const target = basename(args[execIndex + 1] ?? '');
        report.mutating = true;
        report.reasons.push(`find -exec ${target}`);
        if (MUTATING_PROGRAMS.has(target) || INTERPRETERS.has(target)) {
          const nested = analyze(args[execIndex + 1], depth + 1);
          report.substitutions.push(nested);
          if (nested.destructive) report.destructive = true;
        }
      }
    }

    // `xargs <prog>` runs another program.
    if (program === 'xargs') {
      const target = basename(args.find((a) => !a.startsWith('-')) ?? '');
      if (target && (MUTATING_PROGRAMS.has(target) || INTERPRETERS.has(target))) {
        report.mutating = true;
        report.reasons.push(`xargs ${target}`);
        if (INTERPRETERS.has(target)) report.arbitraryCode = true;
      }
    }

    // A shell invocation with -c: analyze the payload.
    if (program && ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(program)) {
      const cIndex = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a) || a === '--command');
      if (cIndex !== -1 && args[cIndex + 1]) {
        const nested = analyze(args[cIndex + 1], depth + 1);
        report.substitutions.push(nested);
        if (nested.mutating) { report.mutating = true; report.reasons.push('nested shell -c'); }
        if (nested.destructive) report.destructive = true;
        if (nested.arbitraryCode) report.arbitraryCode = true;
      }
    }

    if (program && NETWORK_PROGRAMS.has(program)) report.network = true;

    // Collect the network targets so the egress policy can allow/deny them.
    for (const word of segment.rawArgs || []) {
      for (const host of hostsOf(word)) {
        if (!report.domains.includes(host)) report.domains.push(host);
      }
    }

    for (const word of segment.rawArgs || []) {
      for (const body of substitutionsOf(word)) {
        const nested = analyze(body, depth + 1);
        report.substitutions.push(nested);
        if (nested.mutating) { report.mutating = true; report.reasons.push('command substitution'); }
        if (nested.destructive) report.destructive = true;
        if (nested.network) report.network = true;
        if (nested.arbitraryCode) report.arbitraryCode = true;
        for (const host of nested.domains) if (!report.domains.includes(host)) report.domains.push(host);
      }
    }
  }

  // Structural mutating signals independent of the program.
  const flatOps = tokens.filter((t) => t.type === 'op').map((t) => t.value);
  if (flatOps.some((op) => ['>', '>>', '>|', '&>', '>&'].includes(op))) {
    report.mutating = true;
    report.reasons.push('output redirection');
  }
  if (segments.some((s) => s.argv.some((w) => />>?$/.test(w) || /^>>?/.test(w)) && !/^2>&1$/.test(w))) {
    report.mutating = true;
    if (!report.reasons.includes('output redirection')) report.reasons.push('output redirection');
  }

  for (const segment of segments) {
    if (segmentDestructive(segment)) {
      report.destructive = true;
      report.mutating = true;
      report.reasons.push(`destructive: ${segment.program}`);
    }
  }
  for (const nested of report.substitutions) {
    if (nested.destructive) { report.destructive = true; report.mutating = true; }
  }

  // `… | sh` — piping a download/stream into a shell executes arbitrary code.
  for (const segment of segments) {
    const program = basename(segment.program || '');
    if (INTERPRETERS.has(program) && segments.indexOf(segment) > 0) {
      const piped = flatOps.includes('|') || flatOps.includes('|&');
      if (piped) {
        report.pipeToShell = true;
        report.mutating = true;
        report.destructive = true;
        report.arbitraryCode = true;
        report.reasons.push('pipe to shell');
        break;
      }
    }
  }
  if (/\b:\(\)\s*\{\s*:\|:&\s*\};/.test(raw)) { report.destructive = true; report.mutating = true; report.reasons.push('fork bomb'); }
  return report;
}

/** Extract http(s) hostnames from a word (used by the egress policy). */
function hostsOf(word) {
  const out = [];
  const re = /\bhttps?:\/\/([A-Za-z0-9._-]+)(?::\d+)?/g;
  let m;
  const text = String(word ?? '');
  while ((m = re.exec(text)) !== null) out.push(m[1].toLowerCase());
  // bare host:port arguments for curl/wget/ssh
  if (/^(curl|wget|aria2c|http|httpie)$/.test(basename(text))) { /* handled by the caller */ }
  return out;
}

/** Backwards-compatible boolean used by the permission gate. */
function mutating(command) {
  return analyze(command).mutating;
}

module.exports = { analyze, tokenize, mutating, splitSegments, substitutionsOf, programOf, hostsOf, MUTATING_PROGRAMS, NETWORK_PROGRAMS, INTERPRETERS };
