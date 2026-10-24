'use strict';
/**
 * Shell session service — a persistent interactive bash session per window,
 * wrapped in a real pseudo-terminal via macOS `/usr/bin/script -q /dev/null`
 * (no native module needed). Prompts, colors, and interactive programs work
 * because bash sees a TTY. Output streams to the owning window via scoped
 * `shellSession:onOutput` events.
 */
const { spawn } = require('node:child_process');
const { emitScopedEvent } = require('../ipc/emitEvent');
const { settingsService } = require('./settingsService');

/** @type {Map<number, { child: import('node:child_process').ChildProcess, mode: string }>} */
const sessions = new Map();

function emit(sender, kind, data) {
  emitScopedEvent(sender, 'shellSession', 'onOutput', { kind, data });
}

function register(senderId, child, mode) {
  sessions.set(senderId, { child, mode });
}

function spawnShell(cwd, pty) {
  if (pty && process.platform === 'darwin') {
    // Real pseudo-terminal: prompts, colors, interactive programs.
    return spawn('/usr/bin/script', ['-q', '/dev/null', '/bin/bash', '--login', '-i'], {
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        NO_COLOR: undefined,
        PS1: '\\[\\e[1;34m\\]\\w\\[\\e[0m\\] \\[\\e[32m\\]\\$\\[\\e[0m\\] ',
        QUANSIOX_SHELL: 'pty',
      },
    });
  }
  // Fallback: plain pipes (no TTY) — used where ptys are unavailable
  // (e.g. restricted execution contexts). Detached so the shell owns its
  // process group and SIGINT can reach foreground children.
  return spawn('/bin/bash', ['-i'], {
    cwd,
    detached: true,
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', PS1: '$ ', QUANSIOX_SHELL: 'pipes' },
  });
}

function create(event) {
  const cwd = settingsService.load().workspaceRoot || process.cwd();
  if (sessions.has(event.sender.id)) return true;

  let mode = 'pty';
  let child = spawnShell(cwd, true);
  let settled = false;

  const attach = (c) => {
    c.stdout.on('data', (d) => emit(event.sender, 'stdout', d.toString()));
    c.stderr.on('data', (d) => emit(event.sender, 'stderr', d.toString()));
  };
  const onGone = () => {
    sessions.delete(event.sender.id);
    try { child.kill('SIGHUP'); } catch {}
  };

  child.on('exit', (code) => {
    if (mode === 'pty' && !settled) {
      // script couldn't allocate a pty (restricted context) — degrade to pipes.
      settled = true;
      mode = 'pipes';
      child = spawnShell(cwd, false);
      attach(child);
      child.on('exit', () => {
        emit(event.sender, 'exit', 'session exited');
        onGone();
      });
      // Ctrl-C in pipes mode kills the whole process group (no tty ISIG);
      // respawn so the terminal panel always has a live shell.
      child.on('exit', () => setTimeout(() => create(event), 300));
      register(event.sender.id, child, 'pipes');
      emit(event.sender, 'stdout', '(pseudo-terminal unavailable — plain shell mode)\n');
      return;
    }
    emit(event.sender, 'exit', `session exited (${code ?? 'signal'})`);
    onGone();
  });
  // pty stayed alive past the first moment -> it's a real tty
  setTimeout(() => { settled = true; }, 1000);

  attach(child);
  register(event.sender.id, child, 'pty');
  event.sender.once('destroyed', onGone);
  return true;
}

function write(event, { input }) {
  const session = sessions.get(event.sender.id);
  if (!session) throw new Error('no shell session');
  session.child.stdin.write(String(input));
  return true;
}

/** Send a control character (e.g. \x03 = SIGINT, \x04 = EOF). */
function control(event, { key }) {
  const session = sessions.get(event.sender.id);
  if (!session) throw new Error('no shell session');
  const ctrl = String(key ?? '\x03');
  if (session.mode === 'pty') {
    session.child.stdin.write(ctrl);
  } else {
    // No tty ISIG here: interrupting a foreground child reliably is not
    // possible, so Ctrl-C resets the shell (SIGKILL group) and the session
    // auto-respawns — the panel always ends up with a fresh prompt.
    try {
      process.kill(-session.child.pid, 'SIGKILL');
    } catch {
      try { session.child.kill('SIGKILL'); } catch {}
    }
  }
  return true;
}

function close(event) {
  const session = sessions.get(event.sender.id);
  if (session) {
    try { session.child.kill('SIGHUP'); } catch {}
    sessions.delete(event.sender.id);
  }
  return true;
}

function resize() {
  // `script` owns the pty size; resizing the window is a no-op here.
  return true;
}

module.exports = { shellSessionService: { create, write, control, close, resize } };
