'use strict';
/**
 * Background shell manager — long-running commands (dev servers, builds,
 * watchers) that must not block a tool call.
 *
 * Grok Bot's controlled exec engine promotes an over-running shell into a
 * background job (`backgroundShellExecutor` + `backgrounded` stream event with
 * a `shellId`), then lets the model `await`, read output from, and write
 * input to it. Without that, a `npm run dev` would burn the whole turn
 * budget and the agent could never drive an interactive process.
 *
 * This module provides the same shape for Quansiox:
 *
 *   shell({ command, backgroundAfterMs })   → runs in the foreground; if it
 *                                            exceeds the budget it is
 *                                            promoted and a shellId is
 *                                            returned instead.
 *   await_shell({ shellId, timeoutMs })     → wait for exit / output
 *   read_shell_output({ shellId, limit })   → read the captured output
 *   write_shell_input({ shellId, data })    → write to the process stdin
 *
 * No Electron; the coordinator child owns it.
 */
const { spawn } = require('node:child_process');

const DEFAULT_BACKGROUND_AFTER_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 500_000;
const MAX_SHELLS = 32;

class BackgroundShellManager {
  constructor(opts = {}) {
    this.shells = new Map();   // shellId -> shell
    this.nextId = 1;
    this.now = opts.now || (() => Date.now());
  }

  _newId() {
    return `sh-${this.now().toString(36)}-${this.nextId++}`;
  }

  /**
   * Start a command.
   * @returns {{ shellId: string, pid: number, startedAt: number }}
   */
  start(command, { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, shell = '/bin/bash' } = {}) {
    if (this.shells.size >= MAX_SHELLS) {
      // Reap the oldest finished shell to make room.
      for (const [id, s] of this.shells) {
        if (s.exited) { this.shells.delete(id); break; }
      }
      if (this.shells.size >= MAX_SHELLS) {
        throw new Error(`too many background shells (${MAX_SHELLS}) — stop one first`);
      }
    }
    const id = this._newId();
    const child = spawn(shell, ['-lc', command], {
      cwd,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entry = {
      id,
      pid: child.pid,
      command,
      cwd,
      startedAt: this.now(),
      stdout: '',
      stderr: '',
      outputBytes: 0,
      exited: false,
      exitCode: null,
      signal: null,
      child,
      exitWaiters: [],
      outputWaiters: [],
    };
    const append = (stream) => (chunk) => {
      const text = chunk.toString();
      if (entry.outputBytes < MAX_OUTPUT_BYTES) {
        const room = MAX_OUTPUT_BYTES - entry.outputBytes;
        const slice = text.slice(0, room);
        entry[stream] = (entry[stream] + slice).slice(-MAX_OUTPUT_BYTES);
        entry.outputBytes += slice.length;
      }
      // Notify "output arrived" waiters — but NOT the exit waiters: a command
      // that prints something is not finished.
      for (const w of entry.outputWaiters.splice(0)) w();
    };
    child.stdout?.on('data', append('stdout'));
    child.stderr?.on('data', append('stderr'));
    const settle = () => {
      for (const w of entry.exitWaiters.splice(0)) w();
      for (const w of entry.outputWaiters.splice(0)) w();
    };
    child.on('close', (code, signal) => {
      entry.exited = true;
      entry.exitCode = code;
      entry.signal = signal ?? null;
      settle();
    });
    child.on('error', (error) => {
      entry.exited = true;
      entry.error = String(error?.message ?? error);
      settle();
    });
    this.shells.set(id, entry);
    return { shellId: id, pid: child.pid, startedAt: entry.startedAt };
  }

  get(shellId) {
    return this.shells.get(String(shellId ?? '')) ?? null;
  }

  list() {
    return [...this.shells.values()].map((s) => ({
      shellId: s.id,
      pid: s.pid,
      command: s.command,
      cwd: s.cwd,
      startedAt: s.startedAt,
      exited: s.exited,
      exitCode: s.exitCode,
      signal: s.signal,
      outputBytes: s.outputBytes,
    }));
  }

  /**
   * Wait for a shell to EXIT (or for `timeoutMs` to elapse).
   * @returns {{ exited: boolean, exitCode: number|null, signal: string|null, timedOut: boolean, output: string }}
   */
  async await(shellId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const entry = this.get(shellId);
    if (!entry) throw new Error(`unknown shell: ${shellId}`);
    if (entry.exited) {
      return { exited: true, exitCode: entry.exitCode, signal: entry.signal, timedOut: false, output: this.output(entry) };
    }
    const wait = Math.max(0, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 600_000));
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = entry.exitWaiters.indexOf(waiter);
        if (idx >= 0) entry.exitWaiters.splice(idx, 1);
        resolve();
      }, wait);
      const waiter = () => { clearTimeout(timer); resolve(); };
      entry.exitWaiters.push(waiter);
    });
    return {
      exited: entry.exited,
      exitCode: entry.exitCode,
      signal: entry.signal,
      timedOut: !entry.exited,
      output: this.output(entry),
    };
  }

  output(entry, limit = 20_000) {
    const text = `${entry.stdout}${entry.stderr ? `\n[stderr]\n${entry.stderr}` : ''}`;
    return text.length > limit ? text.slice(-limit) : text;
  }

  /** Read the captured output (tail by default). */
  read(shellId, { limit = 20_000 } = {}) {
    const entry = this.get(shellId);
    if (!entry) throw new Error(`unknown shell: ${shellId}`);
    return {
      shellId: entry.id,
      exited: entry.exited,
      exitCode: entry.exitCode,
      signal: entry.signal,
      output: this.output(entry, limit),
      outputBytes: entry.outputBytes,
    };
  }

  /** Write to the process stdin. */
  write(shellId, data) {
    const entry = this.get(shellId);
    if (!entry) throw new Error(`unknown shell: ${shellId}`);
    if (entry.exited) throw new Error(`shell ${shellId} already exited`);
    const text = String(data ?? '');
    if (!text) throw new Error('data is required');
    try {
      entry.child.stdin?.write(text);
    } catch (error) {
      throw new Error(`cannot write to shell ${shellId}: ${error.message}`);
    }
    return { shellId: entry.id, wrote: text.length };
  }

  /** Terminate a running shell. */
  stop(shellId, { signal = 'SIGTERM' } = {}) {
    const entry = this.get(shellId);
    if (!entry) return { stopped: false, reason: 'unknown shell' };
    if (entry.exited) return { stopped: false, reason: 'already exited' };
    try { entry.child.kill(signal); } catch { /* already gone */ }
    return { stopped: true, shellId: entry.id };
  }

  /** Stop every shell (used when the coordinator exits). */
  stopAll() {
    for (const entry of this.shells.values()) {
      if (!entry.exited) { try { entry.child.kill('SIGKILL'); } catch { /* ignore */ } }
    }
    this.shells.clear();
  }
}

module.exports = { BackgroundShellManager, DEFAULT_BACKGROUND_AFTER_MS, DEFAULT_TIMEOUT_MS, MAX_OUTPUT_BYTES };
