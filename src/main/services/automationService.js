'use strict';
/**
 * Automations & workflows service — Grok Bot's agent automations/workflows,
 * local-first.
 *
 *  - `automation`: a scheduled agent turn — an agent prompt that runs on an
 *    interval (min 60s) against a session, in the background.
 *  - `workflow`: an ordered list of prompt steps run sequentially in one
 *    session (a deterministic multi-step orchestration you define up front).
 *
 * Store: <userData>/automations.json (0600), Electron-free so tests run it.
 * The agent runner is injectable (setRunner) — the live app injects
 * agentService.run for headless (sender-less) background runs; tests inject a
 * fake. Nothing here phones home; webhooks are verified locally by token.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { next: cronNext, validate: cronValidate } = require('./cron');
const cronParse = cronValidate;

const ID_RE = /^[a-zA-Z0-9_-]{6,64}$/;
const MIN_INTERVAL_MS = 60_000;

function userDataDir() {
  return require('./userData').userDataDir();
}

function file() { return path.join(userDataDir(), 'automations.json'); }
function newId() { return 'auto_' + crypto.randomBytes(9).toString('base64url'); }
function loadAll() { try { const a = JSON.parse(fs.readFileSync(file(), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveAll(a) { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(a, null, 2), { mode: 0o600 }); }
function reduced(a) { const { webhookToken, runs, ...rest } = a; return { ...rest, hasWebhook: !!webhookToken, historyCount: Array.isArray(runs) ? runs.length : 0 }; }

let runFn = null;
function setRunner(fn) { runFn = typeof fn === 'function' ? fn : null; }

async function defaultRun(sessionId, message) {
  const { agentService } = require('../agentService');
  return agentService.run({ sender: null }, { sessionId, message }); // headless background run
}

function normalize(input) {
  if (!input || typeof input !== 'object') throw new Error('automation spec required');
  const prompt = String(input.prompt ?? input.message ?? input.instruction ?? '').trim();
  const steps = Array.isArray(input.steps) ? input.steps.map((s) => String(s).trim()).filter(Boolean) : [];
  const kind = input.kind === 'workflow' ? 'workflow' : (input.kind === 'automation' ? 'automation' : (steps.length ? 'workflow' : 'automation'));
  if (kind === 'automation' && !prompt) throw new Error('automation needs a prompt');
  if (kind === 'workflow' && !prompt && steps.length === 0) throw new Error('workflow needs a prompt or steps');
  const sessionId = String(input.sessionId || input.agentId || 'automations').slice(0, 64) || 'automations';
  const cron = input.cron ? String(input.cron).trim() : null;
  if (cron) cronParse(cron); // throws on a bad expression
  return {
    id: input.id && ID_RE.test(input.id) ? input.id : newId(),
    kind,
    sessionId,
    name: String(input.name || input.title || prompt || (steps[0] || 'Workflow')).slice(0, 120),
    prompt,
    steps,
    enabled: input.enabled === undefined ? true : !!input.enabled,
    cron,
    intervalMs: Math.max(MIN_INTERVAL_MS, Number(input.intervalMs) || MIN_INTERVAL_MS),
    source: input.source ? String(input.source).slice(0, 512) : null,
    webhookToken: null,
    createdAt: Date.now(),
    lastRunAt: null,
    runCount: 0,
    lastStatus: 'idle',
    lastResult: null,
  };
}

function list(sessionId) {
  return loadAll().filter((a) => !sessionId || a.sessionId === sessionId).map(reduced);
}
function get(id) { return loadAll().find((a) => a.id === id) || null; }
function create(input) { const a = normalize(input); const all = loadAll(); all.push(a); saveAll(all); return reduced(a); }
function update(id, patch) {
  const all = loadAll();
  const i = all.findIndex((a) => a.id === id);
  if (i === -1) throw new Error('unknown automation');
  const cur = all[i];
  const next = {
    ...cur,
    ...(patch.name != null ? { name: String(patch.name).slice(0, 120) } : {}),
    ...(patch.prompt != null ? { prompt: String(patch.prompt) } : {}),
    ...(Array.isArray(patch.steps) ? { steps: patch.steps.map((s) => String(s).trim()).filter(Boolean) } : {}),
    ...(patch.enabled != null ? { enabled: !!patch.enabled } : {}),
    ...(patch.cron !== undefined ? { cron: patch.cron ? (cronParse(String(patch.cron).trim()), String(patch.cron).trim()) : null } : {}),
    ...(patch.intervalMs != null ? { intervalMs: Math.max(MIN_INTERVAL_MS, Number(patch.intervalMs) || MIN_INTERVAL_MS) } : {}),
    ...(patch.sessionId != null ? { sessionId: String(patch.sessionId).slice(0, 64) } : {}),
    updatedAt: Date.now(),
  };
  all[i] = next;
  saveAll(all);
  return reduced(next);
}
function remove(id) { const all = loadAll().filter((a) => a.id !== id); saveAll(all); return true; }
function setEnabled(id, enabled) { return update(id, { enabled: !!enabled }); }

const RUNNING = new Set();
const MAX_RUNS = 20;
function summarize(text) { return String(text ?? '').replace(/\s+/g, ' ').slice(0, 400); }

/**
 * Run an automation/workflow now.
 * opts.trigger: manual | schedule | webhook | test (recorded in history).
 * opts.schedule: whether this run advances the schedule (a Test run does not).
 */
async function run(id, { trigger = 'manual', schedule = true } = {}) {
  const all = loadAll();
  const a = all.find((x) => x.id === id);
  if (!a) throw new Error('unknown automation');
  if (RUNNING.has(a.id)) return { status: 'already-running', id: a.id };
  RUNNING.add(a.id);
  const startedAt = Date.now();
  try {
    const runner = runFn || defaultRun;
    let summary;
    if (a.kind === 'workflow' && a.steps.length) {
      const results = [];
      for (const step of a.steps) results.push(await runner(a.sessionId, step));
      summary = `${a.steps.length} steps · ${results.map((r) => summarize(typeof r === 'string' ? r : r?.text ?? r?.summary ?? '').slice(0, 60)).join(' | ')}`;
    } else {
      const result = await runner(a.sessionId, a.prompt);
      summary = summarize(typeof result === 'string' ? result : result?.text ?? result?.summary ?? '');
    }
    const patch = { lastStatus: 'ok', lastResult: summary };
    if (schedule) { patch.runCount = (a.runCount || 0) + 1; patch.lastRunAt = Date.now(); }
    recordRun(id, { at: startedAt, durationMs: Date.now() - startedAt, status: 'ok', trigger, summary }, patch);
    emitStatus();
    return { status: 'ok', id: a.id, summary, ran: a.kind === 'workflow' ? a.steps.length : 1, trigger };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 300);
    const patch = { lastStatus: 'error', lastResult: message };
    if (schedule) patch.lastRunAt = Date.now();
    recordRun(id, { at: startedAt, durationMs: Date.now() - startedAt, status: 'error', trigger, error: message }, patch);
    emitStatus();
    return { status: 'error', id: a.id, error: message, trigger };
  } finally {
    RUNNING.delete(a.id);
  }
}

/** Append a bounded run-history entry and apply the status patch atomically. */
function recordRun(id, entry, patch = {}) {
  const all = loadAll();
  const i = all.findIndex((a) => a.id === id);
  if (i === -1) return;
  const runs = Array.isArray(all[i].runs) ? all[i].runs : [];
  runs.push(entry);
  all[i] = { ...all[i], ...patch, runs: runs.slice(-MAX_RUNS) };
  saveAll(all);
}

/** Run history, newest first (docs: routine run history). */
function history(id, { limit = MAX_RUNS } = {}) {
  const a = loadAll().find((x) => x.id === id);
  if (!a) throw new Error('unknown automation');
  return (Array.isArray(a.runs) ? a.runs : []).slice(-Math.max(1, Math.min(MAX_RUNS, Number(limit) || MAX_RUNS))).reverse();
}

/** Test run: executes now without advancing the schedule or runCount. */
function testRun(id) { return run(id, { trigger: 'test', schedule: false }); }

function record(id, patch) {
  const all = loadAll();
  const i = all.findIndex((a) => a.id === id);
  if (i !== -1) { all[i] = { ...all[i], ...patch }; saveAll(all); }
}

// ---- webhook credential (local, token-verified) ----
let urlBuilder = null; // (id, token) => url, injected by the main-side webhookService
function setUrlBuilder(fn) { urlBuilder = typeof fn === 'function' ? fn : null; }
function webhookToken(id) {
  const all = loadAll();
  const a = all.find((x) => x.id === id);
  if (!a) throw new Error('unknown automation');
  if (!a.webhookToken) { a.webhookToken = crypto.randomBytes(32).toString('hex'); saveAll(all); }
  const base = { id, token: a.webhookToken, method: 'POST' };
  if (urlBuilder) {
    const url = urlBuilder(id, a.webhookToken);
    if (url) base.url = url; else base.note = 'start the webhook server to get a URL';
  } else {
    base.note = 'local webhook server not started; token + verify path are real';
  }
  return base;
}
async function runByWebhook(id, token) {
  const a = get(id);
  if (!a || !a.webhookToken) throw new Error('unknown automation / no webhook');
  const provided = Buffer.from(String(token || ''));
  const expected = Buffer.from(a.webhookToken);
  const ok = provided.length === expected.length && crypto.timingSafeEqual(expected, provided);
  if (!ok) throw new Error('invalid webhook token');
  return run(a.id, { trigger: 'webhook' });
}

// ---- importer ----
function importWorkflowText(input) {
  const text = String(input?.text ?? input?.content ?? '');
  const name = String(input?.name ?? '');
  const lines = text.split(/\r?\n/);
  const steps = [];
  let title = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line) && !title) { title = line.replace(/^#+\s+/, ''); continue; }
    const m = /^(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
    if (m) steps.push(m[1].trim());
  }
  if (!steps.length && text.trim()) steps.push(text.trim());
  if (title && !name) return create({ kind: 'workflow', name: title, steps, prompt: steps[0] ?? title });
  if (name) return create({ kind: 'workflow', name, steps, prompt: steps[0] ?? name });
  return create({ kind: 'workflow', steps, prompt: steps[0] ?? 'Workflow' });
}
function importWorkflowUrl(input) {
  const content = input?.content ?? input?.text;
  if (typeof content === 'string' && content.trim()) return importWorkflowText({ text: content, name: input?.name });
  // Offline-first: accept a local file path or file:// URL; a remote URL is
  // fetched by the caller (no network from a local-first app).
  const url = String(input?.url ?? '');
  if (/^file:\/\//.test(url) || url.startsWith('/')) {
    try {
      const p = url.replace(/^file:\/\//, '');
      return importWorkflowText({ text: fs.readFileSync(p, 'utf8'), name: input?.name });
    } catch (error) { throw new Error(`cannot read local workflow: ${error.message}`); }
  }
  const a = create({ kind: 'workflow', name: String(input?.name || url || 'Workflow'), prompt: '', steps: [], source: url });
  return { ...a, pending: 'pass content, or a file:// path, to import steps' };
}

// ---- scheduler ----
let timer = null;
let statusListeners = [];
function onStatus(fn) { statusListeners.push(fn); }
function emitStatus() { const rows = list(); for (const fn of statusListeners) { try { fn(rows); } catch {} } }

/** An automation is due now? Cron automations use their schedule; others an interval. */
function isDue(a, now = Date.now()) {
  if (!a.enabled || a.kind !== 'automation' || RUNNING.has(a.id)) return false;
  if (a.cron) {
    const nextAt = cronNext(a.cron, new Date(a.lastRunAt || a.createdAt));
    return nextAt ? nextAt.getTime() <= now : false;
  }
  return (now - (a.lastRunAt || a.createdAt)) >= a.intervalMs;
}
function due(now = Date.now()) {
  return loadAll().filter((a) => isDue(a, now));
}
async function tick(now = Date.now()) {
  const fired = [];
  for (const a of due(now)) fired.push(await run(a.id, { trigger: 'schedule' }));
  return fired;
}
function startScheduler(periodMs = 30_000) {
  if (timer) return timer;
  timer = setInterval(() => { tick().catch(() => {}); }, Math.max(5_000, periodMs));
  if (timer.unref) timer.unref();
  return timer;
}
function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  automationService: {
    list, get, create, update, remove, setEnabled, run, testRun, history, webhookToken, runByWebhook,
    importWorkflowText, importWorkflowUrl,
    setRunner, setUrlBuilder, startScheduler, stopScheduler, tick, due, isDue, onStatus, MAX_RUNS,
  },
  MIN_INTERVAL_MS,
};
