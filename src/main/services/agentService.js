'use strict';
/**
 * Agent service (main process) — thin proxy to the forked coordinator child
 * (src/coordinator/index.js). Handles:
 *  - supervised fork with restart (Grok Bot's named-service pattern)
 *  - request multiplexing by reqId
 *  - relaying child events to the requesting window as scoped agent:* events
 *  - finish notifications (notify messages from the child)
 */
const { fork } = require('node:child_process');
const path = require('node:path');
const { emitScopedEvent } = require('../ipc/emitEvent');

const COORDINATOR = path.join(__dirname, '..', '..', 'coordinator', 'index.js');

let child = null;
let ready = null;
let nextReqId = 1;
/** reqId -> { resolve, reject } */
const pending = new Map();
/** reqId -> webContents of the requesting window (for scoped events) */
const requestSenders = new Map();

function log(...args) {
  console.log('[coordinator]', ...args);
}

// Events frequent enough that the invoke/event relay is worth bypassing.
const PORT_EVENTS = new Set(['onDelta', 'onToolCall', 'onToolResult', 'onScreenshot', 'onSubagentDelta', 'onRoute']);

/** Post a hot event over the window's MessagePort; false when unavailable. */
function sendViaPort(sender, event, sessionId, args) {
  if (!PORT_EVENTS.has(event)) return false;
  try {
    if (!sender || sender.isDestroyed?.()) return false;
    const { windowManager } = require('../windowManager');
    const port = windowManager.dataPortFor(sender);
    if (!port) return false;
    port.postMessage(['port', 'agent', event, sessionId, ...(args ?? [])]);
    return true;
  } catch { return false; }
}

/**
 * Hand the vault key to the coordinator without ever writing it to disk in
 * plaintext-adjacent places: the main process unwraps it with Electron
 * safeStorage (when available) and passes it once through the fork env.
 */
function secretsKeyEnv() {
  if (process.env.QUANSIOX_SECRETS_KEY) return process.env.QUANSIOX_SECRETS_KEY;
  try {
    const { secretsService } = require('./secretsService');
    secretsService.wrapKeyWithSafeStorage?.();
    return secretsService.exportKeyHex?.() ?? undefined;
  } catch { return undefined; }
}

function start() {
  if (child && child.exitCode === null) return child;
  const secretsKey = secretsKeyEnv();
  child = fork(COORDINATOR, [], {
    env: {
      ...process.env,
      // Services in the child read this instead of electron's app.getPath.
      QUANSIOX_USER_DATA_DIR: process.env.QUANSIOX_USER_DATA_DIR ?? getUserDataDir(),
      ...(secretsKey ? { QUANSIOX_SECRETS_KEY: secretsKey } : {}),
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const origin = child;
  const reply = (payload) => { if (origin.connected) origin.send(payload, () => {}); };
  ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('coordinator startup timeout')), 15_000);
    const onReady = (msg) => {
      if (msg?.type === 'ready') {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.once('message', onReady);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`coordinator exited during startup (${code})`));
    });
  });
  ready.catch(() => {}); // avoid unhandled rejection if startup fails

  child.on('message', async (msg) => {
    if (msg.type === 'event') {
      const sender = requestSenders.get(msg.sessionId) ?? null;
      // Hot events (streaming tokens, tool results, screenshots) go straight to
      // the window's data port; everything else uses the scoped event channel.
      if (sender && !sendViaPort(sender, msg.event, msg.sessionId, msg.args)) {
        emitScopedEvent(sender, 'agent', msg.event, msg.sessionId, ...msg.args);
      }
      // Live playback (Cue pattern): forward agent screenshots to any open
      // playback window for that session as playback:onFrame.
      if (msg.event === 'onScreenshot') {
        try {
          const { windowManager } = require('../windowManager');
          const { emitScopedEvent: scoped } = require('../ipc/emitEvent');
          for (const entry of windowManager.windowsOfType('playback')) {
            if (entry.sessionId === msg.sessionId) {
              scoped(entry.win, 'playback', 'onFrame', msg.sessionId, ...(msg.args ?? []));
            }
          }
        } catch { /* playback is best-effort */ }
      }
      // Failed runs raise a troubleshooting notice with a request ID.
      if (msg.event === 'onDone' && msg.args?.[0]?.ok === false) {
        try {
          require('./noticeService').noticeService.raise({
            title: 'Run failed',
            body: String(msg.args[0].error ?? 'unknown error'),
            kind: 'error',
            sessionId: msg.sessionId,
          });
        } catch { /* notices are best-effort */ }
      }
      return;
    }
    if (msg.type === 'notify') {
      maybeNotify(msg.ok, msg.text);
      return;
    }
    if (msg.type === 'computerCall') {
      // Computer use needs desktopCapturer — execute in this (main) process.
      // Trust overlays: border glow + stop pill while the agent drives.
      try {
        const { trustOverlayService } = require('./trustOverlayService');
        trustOverlayService.show(() => {
          for (const waiter of pending.values()) waiter.reject(new Error('user stopped computer control'));
          reply({ type: 'computerResult', id: msg.id, error: 'user stopped computer control' });
        });
      } catch { /* overlays are best-effort */ }
      // Per-bot computer: a bot's computer_* targets ITS OWN Linux guest. The
      // first such call lazily provisions the session's desktop (screen + RFB
      // input) so the agent acts on the VM, not on the user's Mac. Explicit
      // QUANSIOX_COMPUTER_TARGET=host keeps the old host-Mac behavior.
      const { guestComputerBridge } = require('./guestComputerBridge');
      const { computerRuntimeService } = require('./computerRuntimeService');
      const guestMethods = new Set(['screenshot', 'click', 'rightClick', 'scroll', 'move', 'typeText', 'pressKey']);
      const target = String(process.env.QUANSIOX_COMPUTER_TARGET || '').toLowerCase();
      // The guest is an isolated Linux VM, so it does not need the host Mac's
      // Accessibility/Screen-Recording opt-in (allowComputerUse). That setting
      // still gates the host-Mac fallback. Auto-provision only in the real
      // Electron main: plain-node test harnesses keep the host/fake path (no
      // 4 GB VM per scripted `computer_*` call). `=guest` forces it for E2E.
      const inElectron = Boolean(process.versions.electron);
      const wantGuest = target !== 'host' && (target === 'guest' || inElectron) && guestMethods.has(msg.method);
      (async () => {
        let provisionError = null;
        if (wantGuest && msg.sessionId && !guestComputerBridge.isAttached(msg.sessionId)) {
          try {
            // Take a pool lease for this session's guest. Siblings that share a
            // session share one guest (refcounted); a delegated child gets its
            // own session id and therefore its own guest.
            const { computerPool } = require('./computerPool');
            await computerPool.acquire(msg.sessionId);
            await computerRuntimeService.ensure(msg.sessionId, { reason: `agent:${msg.method}` });
          } catch (error) { provisionError = error; }
        }
        // A host that can run the guest must not silently fall back to driving
        // the user's Mac when provisioning failed — report the failure instead.
        if (provisionError && computerRuntimeService.canProvide()) throw provisionError;
        const useGuest = Boolean(msg.sessionId) && guestComputerBridge.isAttached(msg.sessionId);
        const source = useGuest ? guestComputerBridge : require('./computerUseService').computerUseService;
        return useGuest
          ? guestComputerBridge.computer(msg.sessionId, msg.method, msg.args ?? {})
          : source[msg.method](msg.args ?? {});
      })()
        .then((result) => reply({ type: 'computerResult', id: msg.id, result }))
        .catch((error) =>
          reply({ type: 'computerResult', id: msg.id, error: String(error?.message ?? error) }));
      return;
    }
    if (msg.type === 'confirmRequest') {
      // Coordinator asks to run a gated action. Relay a structured approval
      // request to the owning window and bridge the reply (fail-closed on
      // timeout). The request carries the action, the target and a redacted
      // argument preview so the card can show what is being asked for.
      try {
        const { confirmationService } = require('./confirmationService');
        const { emitScopedEvent } = require('../ipc/emitEvent');
        const sender = requestSenders.get(msg.sessionId);
        const opened = confirmationService.request(
          msg.sessionId, msg.tool, msg.args, msg.cwd, msg.timeoutMs, msg.request ?? null,
        );
        try {
          emitScopedEvent(sender, 'agent', 'onConfirm', msg.sessionId, {
            id: opened.id,
            tool: msg.tool,
            args: msg.args,
            cwd: msg.cwd,
            timeoutMs: msg.timeoutMs,
            request: opened.request,
          });
        } catch {}
        opened.promise.then((approved) => reply({ type: 'confirmResult', id: msg.id, approved: approved === true }));
      } catch (error) {
        reply({ type: 'confirmResult', id: msg.id, approved: false }); // fail closed
      }
      return;
    }
    if (msg.type === 'browserCall') {
      // Browser tools need WebContentsView/CDP — execute in this (main) process
      // (Manus browser-driver pattern: the agent browser lives in Electron).
      const { browserService } = require('./browserService');
      const { browserRouter } = require('./browserRouter');
      const { guestBrowserService } = require('./guestBrowserService');
      const { sessionId, ...rest } = msg.args ?? {};
      (async () => {
        // Bots with their own Linux VM browse with the guest Chromium over CDP
        // (no screenshots/RFB); default sessions keep the embedded host browser.
        const runtime = await browserRouter.resolve(sessionId, { reason: `agent:${msg.method}` });
        const driver = runtime === 'guest' ? guestBrowserService : browserService;
        if (msg.method === 'open') return driver.open(sessionId, rest);
        if (msg.method === 'snapshot') return driver.snapshot(sessionId);
        if (msg.method === 'act') return driver.act(sessionId, rest.method, rest.args ?? {});
        if (msg.method === 'credentials') {
          // Vault password is read and injected here; it never crosses back to
          // the coordinator or into the transcript.
          return require('./browserCredentialsService').browserCredentialsService.fillCredentials(sessionId, rest.args ?? {}, driver);
        }
        if (msg.method === 'importCookies') {
          const { cookieImportService } = require('./cookieImportService');
          // Read in the worker thread: the Keychain prompt + sqlite3 scan must
          // never block the Electron main thread.
          const plan = await cookieImportService.planChromeImportAsync(sessionId, { browser: rest.args?.browser, domains: rest.args?.domains });
          const applied = await cookieImportService.applyPlan(sessionId, plan, driver);
          return {
            browser: plan.browser, parsed: plan.parsed, granted: plan.granted, skipped: plan.skipped,
            set: applied.set ?? 0, failed: applied.failed ?? 0, unmatchedOrigins: plan.unmatchedOrigins,
          };
        }
        if (msg.method === 'tabs') return driver.tabs(sessionId, rest.action, rest.args);
        throw new Error(`unknown browser call: ${msg.method}`);
      })()
        .then((result) => reply({ type: 'browserResult', id: msg.id, result }))
        .catch((error) =>
          reply({ type: 'browserResult', id: msg.id, error: String(error?.message ?? error) }));
      return;
    }
    if (msg.type === 'skillReplay') {
      const { skillRecordingService } = require('./skillRecordingService');
      skillRecordingService.replay(msg.artifactId)
        .then((result) => reply({ type: 'browserResult', id: msg.id, result }))
        .catch((error) =>
          reply({ type: 'browserResult', id: msg.id, error: String(error?.message ?? error) }));
      return;
    }
    if (msg.type === 'renderCall') {
      // Offscreen render-to-PDF/PNG (Manus utilityHost render pattern).
      const { renderService } = require('./renderService');
      renderService[msg.method === 'render_pdf' ? 'renderPdf' : 'renderPng'](msg.args ?? {})
        .then((result) => reply({ type: 'browserResult', id: msg.id, result }))
        .catch((error) =>
          reply({ type: 'browserResult', id: msg.id, error: String(error?.message ?? error) }));
      return;
    }
    if (msg.type === 'sandboxCall') {
      try {
        const { sandboxService } = require('./sandboxService');
        const entry = sandboxService.get(msg.sessionId) ?? (await sandboxService.ensure(msg.sessionId));
        if (msg.method === 'ensure') {
          if (entry && entry.status !== 'ready') throw new Error('session sandbox unavailable');
          if (msg.params?.forkedFrom) {
            const fs = require('node:fs');
            const { taskStore } = require('../../coordinator/task-store');
            const original = taskStore.get(msg.params.forkedFrom, msg.params.parentSessionId);
            const root = entry?.root || sandboxService.sandboxRoot(msg.sessionId);
            fs.mkdirSync(root, { recursive: true });
            // Fork a task workspace once; resume must keep its subsequent edits.
            const marker = path.join(root, '.qx-fork-origin');
            if (!fs.existsSync(marker) && original.workspaceRoot && original.workspaceRoot !== root) {
              const entries = await fs.promises.readdir(original.workspaceRoot);
              for (const name of entries) {
                if (name === '.quansiox' || name === '.qx-fork-origin') continue;
                await fs.promises.cp(path.join(original.workspaceRoot, name), path.join(root, name), {
                  recursive: true, dereference: false, mode: fs.constants.COPYFILE_FICLONE,
                  filter: (source) => {
                    const stat = fs.lstatSync(source);
                    return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
                  },
                });
              }
              fs.writeFileSync(marker, original.id);
            }
          }
          reply({ type: 'sandboxResult', id: msg.id, result: { active: !!entry, root: entry?.root || sandboxService.sandboxRoot(msg.sessionId) } });
          return;
        }
        if (!entry || entry.status !== 'ready') throw new Error('session sandbox unavailable');
        const result = await sandboxService.call(entry, msg.method, msg.params, msg.sessionId);
        reply({ type: 'sandboxResult', id: msg.id, result });
      } catch (error) {
        reply({ type: 'sandboxResult', id: msg.id, error: String(error?.message ?? error) });
      }
      return;
    }
    if (msg.type === 'result') {
      try { require('./trustOverlayService').trustOverlayService.hide(); } catch {}
      const waiter = pending.get(msg.reqId);
      if (!waiter) return;
      pending.delete(msg.reqId);
      requestSenders.delete(msg.reqId);
      if (msg.error) waiter.reject(new Error(msg.error));
      else waiter.resolve(msg.result);
    }
  });

  child.on('exit', (code) => {
    if (child !== origin) return;
    const error = new Error(`coordinator exited (${code ?? 'signal'})`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    requestSenders.clear();
    child = null;
    ready = null;
    // The crash is reported: the coordinator dying is an internal failure,
    // not a user error, and it should show up in the reliability log with
    // the last span it was in.
    try {
      const telemetry = require('../../shared/telemetry.js');
      telemetry.reportFailure(error, {
        phase: 'coordinator',
        exitCode: code ?? null,
        signal: code == null ? 'signal' : null,
      });
    } catch { /* reporting is best-effort */ }
    log('exited, will restart on next request');
  });
  return child;
}

function getUserDataDir() {
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch {
    return path.join(process.env.HOME ?? '.', 'Library', 'Application Support', 'Quansiox');
  }
}

async function request(type, payload, senderWebContents) {
  start();
  await ready;
  const reqId = nextReqId++;
  if (senderWebContents && payload.sessionId) {
    requestSenders.set(payload.sessionId, senderWebContents);
  }
  // Runs get their sandbox computer ensured first (desired-state supervise).
  if (type === 'run' || type === 'retry' || (type === 'taskControl' && ['start', 'resume', 'fork'].includes(payload.action))) {
    try {
      const { sandboxService } = require('./sandboxService');
      const entry = await sandboxService.ensure(payload.sessionId);
      if (entry && entry.status !== 'ready') throw new Error(`sandbox is ${entry.status}`);
      payload.sandbox = entry
        ? { active: entry.status === 'ready', root: entry.root }
        : { active: false, root: null };
    } catch (error) {
      notifyComputer(senderWebContents, payload.sessionId);
      throw new Error(`Session sandbox could not start: ${error.message}`);
    }
    notifyComputer(senderWebContents, payload.sessionId);
  }
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    child.send({ type, reqId, ...payload }, (error) => {
      if (error) {
        pending.delete(reqId);
        reject(error);
      }
    });
  });
}

/** Session ids with a run in flight (drives the grace-close gate). */
const runningSessions = new Set();

/**
 * When the last run settles, release the computer helper's element handles.
 * A snapshot from one run must not remain actionable in the next, and the
 * helper's registry is bounded. Best-effort: finishing cleanup never fails
 * a run, and it is a no-op when the helper was never started.
 */
async function releaseComputerHandles() {
  try {
    await require('./computerUseService').computerUseService.finish();
  } catch { /* cleanup is best-effort */ }
}

const { createRunQueue } = require('./runQueue');

/**
 * Start one turn. Queued turns enter here too (meta.dequeued true) — the
 * renderer uses `onRunStart` to flip a message bubble out of its queued state.
 */
function startRun(sessionId, task, { dequeued }) {
  runningSessions.add(sessionId);
  // Keep the Mac awake while the agent works (Manus keepAwake pattern).
  try { require('./keepAwakeService').keepAwakeService.ensureAwake('agent run'); } catch {}
  try {
    emitScopedEvent(task.sender, 'agent', 'onRunStart', sessionId, {
      messageId: task.opts?.messageId ?? null,
      dequeued: dequeued === true,
    });
  } catch { /* reporting is best-effort */ }
  // A failed turn (no API key, a provider error, a crashed coordinator) is
  // reported to the session AND still rejects for its caller — a caller
  // that awaits the run must see the failure.
  return request('run', task.opts, task.sender)
    .catch((error) => {
      const message = String(error?.message ?? error);
      try { require('./diagnosticsService').diagnosticsService.record('agent-run-failed', { sessionId, error: message }); } catch {}
      try { emitScopedEvent(task.sender, 'agent', 'onRunError', sessionId, { error: message }); } catch {}
      try { emitScopedEvent(task.sender, 'agent', 'onRunEnd', sessionId, { ok: false, error: message }); } catch {}
      throw error;
    })
    .finally(async () => {
      runningSessions.delete(sessionId);
      notifyComputer(task.sender, sessionId);
      if (runningSessions.size === 0) {
        try { require('./keepAwakeService').keepAwakeService.release(); } catch {}
        // Await cleanup before the run settles, so a queued turn cannot have
        // its first snapshot token cleared by this run's release.
        await releaseComputerHandles();
      }
    });
}

const runQueue = createRunQueue(startRun);

function isRunning(sessionId) {
  // A session with queued turns is still busy for the grace-close gate.
  return runningSessions.has(sessionId) || runQueue.depth(sessionId) > 0;
}

function _testSetRunning(sessionId, running) {
  if (running) runningSessions.add(sessionId);
  else runningSessions.delete(sessionId);
}

function notifyComputer(sender, sessionId) {
  if (!sender || !sessionId || sender.isDestroyed?.()) return;
  try { emitScopedEvent(sender, 'sandbox', 'onStatus', sessionId); } catch {}
}

function run(event, opts) {
  // Reply metadata (docs: reply to a specific message) — clamp before it is
  // persisted with the turn.
  if (opts?.replyTo) {
    const rt = opts.replyTo;
    opts = { ...opts, replyTo: {
      messageId: typeof rt.messageId === 'string' ? rt.messageId.slice(0, 80) : null,
      preview: String(rt.preview ?? '').slice(0, 200),
      author: String(rt.author ?? '').slice(0, 40) || 'Quansiox',
    } };
  }
  const sender = event?.sender ?? null;
  return runQueue.run(opts.sessionId, { opts, sender }, (position) => {
    try {
      emitScopedEvent(sender, 'agent', 'onQueued', opts.sessionId, {
        messageId: opts.messageId ?? null,
        position,
      });
    } catch { /* reporting is best-effort */ }
  });
}

function retry(event, { sessionId }) {
  runningSessions.add(sessionId);
  try { require('./keepAwakeService').keepAwakeService.ensureAwake('agent retry'); } catch {}
  return request('retry', { sessionId }, event?.sender ?? null).finally(async () => {
    runningSessions.delete(sessionId);
    notifyComputer(event?.sender ?? null, sessionId);
    if (runningSessions.size === 0) {
      try { require('./keepAwakeService').keepAwakeService.release(); } catch {}
      await releaseComputerHandles();
    }
  });
}

function abort(event, { sessionId }) {
  return request('abort', { sessionId }, event?.sender ?? null).finally(() => {
    notifyComputer(event?.sender ?? null, sessionId);
  });
}

/**
 * Redirect in-flight work (docs): promote a queued message to the front and
 * abort the current turn so the promoted message starts immediately. Actions
 * the bot already completed are not undone.
 */
async function steer(event, { sessionId, messageId }) {
  if (!sessionId || !messageId) throw new Error('sessionId and messageId are required');
  const promoted = runQueue.promote(sessionId, messageId);
  if (!promoted) return { promoted: false, aborted: false };
  const wasRunning = runningSessions.has(sessionId);
  if (wasRunning) {
    await request('abort', { sessionId }, event?.sender ?? null).catch(() => {});
  }
  return { promoted: true, aborted: wasRunning };
}

function task(event, opts) {
  return request('taskControl', opts, event?.sender ?? null);
}

/** macOS notification when a turn finishes while the window is unfocused. */
function maybeNotify(ok, text) {
  try {
    const { BrowserWindow, Notification } = require('electron');
    const win = BrowserWindow.getFocusedWindow();
    // Only notify when no Quansiox window is focused.
    if (win) return;
    if (!Notification.isSupported()) return;
    const note = new Notification({
      title: ok ? 'Quansiox — task finished' : 'Quansiox — task failed',
      body: String(text).slice(0, 120),
    });
    note.on('click', () => {
      const main = BrowserWindow.getAllWindows()[0];
      if (main && !main.isDestroyed()) {
        if (main.isMinimized()) main.restore();
        main.focus();
      }
    });
    note.show();
  } catch {
    /* notifications must never break a run */
  }
}

module.exports = { agentService: { run, retry, abort, steer, task, isRunning, _testSetRunning } };
