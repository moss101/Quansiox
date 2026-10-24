'use strict';
/**
 * User-interaction service — real local agent→user interaction primitives
 * matching Grok's host surface: tray notifications, structured user forms and
 * interactive widgets. The agent runtime (or any local service) queues an
 * entry via the `request*` helpers; the renderer is notified over the event
 * channel (`quansiox-ipc-event`) and the user answers through the grok
 * surface (`getTrays` / `submitUserForm` / `respondToWidget` / …).
 *
 * Pending entries persist at `userData/interactions.json` (0600); resolved
 * entries are pruned after 24 h. Like Grok's `saveToVault` flag, a submitted
 * form can be remembered in the encrypted secrets store for prefill.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 200;
const RESOLVED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_VALUE_BYTES = 8 * 1024;

function userDataDir() {
  return require('./userData').userDataDir();
}
function file() { return path.join(userDataDir(), 'interactions.json'); }

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (data && Array.isArray(data.entries)) return data;
  } catch {}
  return { entries: [] };
}
function save(state) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(state, null, 2), { mode: 0o600 });
}
function prune(state) {
  const now = Date.now();
  state.entries = state.entries
    .filter((e) => e.state === 'pending' || (now - (e.resolvedAt || e.createdAt)) < RESOLVED_TTL_MS)
    .slice(-MAX_ENTRIES);
}
function newId(kind) { return `${kind}_${crypto.randomBytes(8).toString('base64url')}`; }
function emit(event, payload) {
  try { require('../ipc/emitEvent').emitEvent('interactions', event, payload); } catch {}
}
function record(action, detail) {
  try { require('./diagnosticsService').diagnosticsService.record('interaction', { action, ...detail }); } catch {}
}
function clean(value, max = 4000) { return String(value ?? '').slice(0, max); }

const waiters = new Map();
function settleWaiters(id, outcome) {
  const list = waiters.get(id);
  if (!list) return;
  waiters.delete(id);
  for (const w of list) { clearTimeout(w.timer); w.resolve(outcome); }
}
function awaitEntry(id, timeoutMs = 5 * 60 * 1000) {
  // Poll the on-disk entry so an answer submitted by *another* process (the
  // main process handles renderer submits; the agent lives in the coordinator
  // fork) is observed.
  const limit = Math.max(1000, Number(timeoutMs) || 5 * 60 * 1000);
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const entry = pick(id);
      if (!entry) { resolve(null); return; }
      const settled = () => {
        const e = publicEntry(entry);
        return {
          ...e,
          alreadyResolved: true,
          submitted: e.state === 'submitted',
          responded: e.state === 'responded',
          dismissed: e.state === 'dismissed' || e.state === 'escalated',
        };
      };
      if (entry.state !== 'pending') { resolve(settled()); return; }
      if (Date.now() - started >= limit) { resolve({ ...publicEntry(entry), timedOut: true }); return; }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function publicEntry(entry) {
  return entry ? { ...entry } : null;
}
function pick(id) {
  if (!id) return null;
  return load().entries.find((e) => e.id === id) ?? null;
}
function resolveEntry(id, kind, state, extra) {
  const data = load();
  const entry = data.entries.find((e) => e.id === id && e.kind === kind);
  if (!entry) throw new Error(`unknown ${kind} entry: ${id}`);
  if (entry.state !== 'pending') throw new Error(`${kind} entry already ${entry.state}: ${id}`);
  Object.assign(entry, extra || {}, { state, resolvedAt: Date.now() });
  save(data);
  return entry;
}

// ---------------- trays ----------------
function listTrays() {
  const data = load();
  prune(data);
  save(data);
  return data.entries.filter((e) => e.kind === 'tray');
}
function createTray({ title, body, agentId, sessionId } = {}) {
  const data = load();
  const entry = {
    id: newId('tray'),
    kind: 'tray',
    state: 'pending',
    title: clean(title || body || 'Notification', 200),
    body: clean(body, 2000),
    agentId: agentId ? String(agentId) : null,
    sessionId: sessionId ? String(sessionId) : null,
    createdAt: Date.now(),
  };
  data.entries.push(entry);
  prune(data);
  save(data);
  emit('trayAdded', entry);
  return entry;
}
function dismissTray(id) {
  const data = load();
  const idx = data.entries.findIndex((e) => e.id === id && e.kind === 'tray');
  if (idx === -1) throw new Error(`unknown tray entry: ${id}`);
  const [entry] = data.entries.splice(idx, 1);
  save(data);
  settleWaiters(id, { id, kind: 'tray', dismissed: true });
  emit('trayDismissed', { id });
  record('dismiss-tray', { id: entry.id });
  return { id: entry.id, dismissed: true };
}
function clearTrays() {
  const data = load();
  const kept = [];
  const removed = [];
  for (const e of data.entries) (e.kind === 'tray' ? removed : kept).push(e);
  data.entries = kept;
  save(data);
  for (const e of removed) settleWaiters(e.id, { id: e.id, kind: 'tray', dismissed: true });
  emit('traysCleared', { count: removed.length });
  record('clear-trays', { count: removed.length });
  return removed.length;
}

// ---------------- user forms ----------------
function normalizeFields(fields) {
  if (!Array.isArray(fields)) throw new Error('fields must be an array');
  return fields.slice(0, 40).map((f) => {
    const name = clean(f?.name ?? '', 80);
    if (!name) throw new Error('each field needs a name');
    return {
      name,
      label: clean(f?.label ?? name, 120),
      type: clean(f?.type ?? 'text', 20),
      required: Boolean(f?.required),
      ...(Array.isArray(f?.options) ? { options: f.options.slice(0, 40).map((o) => clean(o, 120)) } : {}),
      ...(f?.placeholder ? { placeholder: clean(f.placeholder, 200) } : {}),
    };
  });
}
function requestForm({ agentId, sessionId, platform, title, fields } = {}) {
  if (!agentId) throw new Error('agentId is required');
  const data = load();
  const entry = {
    id: newId('form'),
    kind: 'form',
    state: 'pending',
    agentId: String(agentId),
    sessionId: sessionId ? String(sessionId) : null,
    platform: clean(platform || 'desktop', 40),
    title: clean(title || 'Input requested', 200),
    fields: normalizeFields(fields),
    createdAt: Date.now(),
  };
  data.entries.push(entry);
  prune(data);
  save(data);
  emit('formRequested', entry);
  record('request-form', { id: entry.id, agentId: entry.agentId, fields: entry.fields.length });
  return entry;
}
function submitForm({ entryId, values, saveToVault } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('values must be a { field: value } object');
  const cleaned = {};
  for (const [k, v] of Object.entries(values).slice(0, 40)) cleaned[clean(k, 80)] = clean(v, 8000);
  const entry = resolveEntry(entryId, 'form', 'submitted', { values: cleaned });
  if (saveToVault) {
    try {
      const secretName = `userform_${String(entry.agentId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}`;
      const nonEmpty = Object.fromEntries(Object.entries(cleaned).filter(([, v]) => String(v).length > 0));
      if (Object.keys(nonEmpty).length === 0) throw new Error('nothing to save (all values empty)');
      require('./secretsService').secretsService.set(secretName, nonEmpty, `User form: ${entry.title}`);
      entry.savedToVault = true;
    } catch (e) {
      entry.savedToVault = false;
      entry.saveToVaultError = String(e?.message ?? e);
    }
    const data = load();
    const stored = data.entries.find((e) => e.id === entry.id);
    if (stored) { stored.savedToVault = entry.savedToVault; if (entry.saveToVaultError) stored.saveToVaultError = entry.saveToVaultError; }
    save(data);
  }
  settleWaiters(entryId, { id: entryId, kind: 'form', submitted: true, values: cleaned, savedToVault: Boolean(entry.savedToVault) });
  emit('formSubmitted', { id: entryId, agentId: entry.agentId, values: cleaned, savedToVault: Boolean(entry.savedToVault) });
  record('submit-form', { id: entryId, agentId: entry.agentId, savedToVault: Boolean(entry.savedToVault) });
  return { entryId, state: 'submitted', savedToVault: Boolean(entry.savedToVault), values: cleaned };
}
function dismissForm({ entryId, mode, agentId, platform, sessionId } = {}) {
  const state = mode === 'escalated' ? 'escalated' : 'dismissed';
  const entry = resolveEntry(entryId, 'form', state, {
    ...(agentId ? { agentId: String(agentId) } : {}),
    ...(platform ? { platform: clean(platform, 40) } : {}),
    ...(sessionId ? { sessionId: String(sessionId) } : {}),
  });
  settleWaiters(entryId, { id: entryId, kind: 'form', dismissed: true, mode: state });
  emit('formDismissed', { id: entryId, mode: state, agentId: entry.agentId ?? null });
  record('dismiss-form', { id: entryId, mode: state, agentId: entry.agentId ?? null });
  return { entryId, state };
}
function listForms({ pendingOnly = true } = {}) {
  const data = load();
  prune(data);
  save(data);
  return data.entries.filter((e) => e.kind === 'form' && (!pendingOnly || e.state === 'pending'));
}
function listWidgets({ pendingOnly = true } = {}) {
  const data = load();
  prune(data);
  save(data);
  return data.entries.filter((e) => e.kind === 'widget' && (!pendingOnly || e.state === 'pending'));
}
/** Everything awaiting a user answer (renderer card surface). */
function pending() {
  return { forms: listForms(), widgets: listWidgets(), trays: listTrays() };
}

// ---------------- widgets ----------------
function requestWidget({ agentId, sessionId, title, widgetType, value } = {}) {
  if (!agentId) throw new Error('agentId is required');
  const data = load();
  const entry = {
    id: newId('widget'),
    kind: 'widget',
    state: 'pending',
    agentId: String(agentId),
    sessionId: sessionId ? String(sessionId) : null,
    title: clean(title || 'Widget', 200),
    widgetType: clean(widgetType || 'generic', 60),
    value: value === undefined ? null : clean(value, MAX_VALUE_BYTES),
    createdAt: Date.now(),
  };
  data.entries.push(entry);
  prune(data);
  save(data);
  emit('widgetRequested', entry);
  record('request-widget', { id: entry.id, agentId: entry.agentId, widgetType: entry.widgetType });
  return entry;
}
function respondWidget({ entryId, value, agentId, sessionId } = {}) {
  const entry = resolveEntry(entryId, 'widget', 'responded', {
    value: clean(value, MAX_VALUE_BYTES),
    ...(agentId ? { agentId: String(agentId) } : {}),
    ...(sessionId ? { sessionId: String(sessionId) } : {}),
  });
  settleWaiters(entryId, { id: entryId, kind: 'widget', responded: true, value: entry.value });
  emit('widgetResponded', { id: entryId, value: entry.value, agentId: entry.agentId });
  record('respond-widget', { id: entryId, agentId: entry.agentId });
  return { entryId, state: 'responded', value: entry.value };
}
function dismissWidget({ entryId, agentId, sessionId } = {}) {
  const entry = resolveEntry(entryId, 'widget', 'dismissed', {
    ...(agentId ? { agentId: String(agentId) } : {}),
    ...(sessionId ? { sessionId: String(sessionId) } : {}),
  });
  settleWaiters(entryId, { id: entryId, kind: 'widget', dismissed: true });
  emit('widgetDismissed', { id: entryId, agentId: entry.agentId });
  record('dismiss-widget', { id: entryId, agentId: entry.agentId });
  return { entryId, state: 'dismissed' };
}

// ---------------- drafts ----------------
/**
 * A draft the agent wants the user to review and send: an email, a Slack
 * message, a message in a meeting.
 *
 * The draft is a card in the transcript; the user edits it and sends it, or
 * discards it. Nothing is sent until the user says so.
 */
function requestDraft({ agentId, sessionId, channel = 'email', draft = {} } = {}) {
  if (!agentId) throw new Error('agentId is required');
  const data = load();
  const entry = {
    id: newId('draft'),
    kind: 'draft',
    state: 'pending',
    agentId: String(agentId),
    sessionId: sessionId ? String(sessionId) : null,
    channel: clean(channel || 'email', 40),
    draft: {
      to: clean(draft.to ?? draft.target ?? '', 400),
      subject: clean(draft.subject ?? draft.thread ?? '', 400),
      body: clean(draft.body ?? draft.text ?? '', 20_000),
      ...(draft.workspace ? { workspace: clean(draft.workspace, 200) } : {}),
      ...(draft.meetingId ? { meetingId: clean(draft.meetingId, 120) } : {}),
    },
    createdAt: Date.now(),
  };
  data.entries.push(entry);
  prune(data);
  save(data);
  emit('draftRequested', entry);
  record('request-draft', { id: entry.id, channel: entry.channel });
  return entry;
}

/** The user edited the draft and sent it. */
function sendDraft({ entryId, draft } = {}) {
  const entry = resolveEntry(entryId, 'draft', 'sent', {
    ...(draft && typeof draft === 'object' ? { draft: { ...(draft.body != null ? { body: clean(draft.body, 20_000) } : {}) } } : {}),
  });
  settleWaiters(entryId, { id: entryId, kind: 'draft', sent: true, draft: entry.draft });
  emit('draftSent', { id: entryId, agentId: entry.agentId, channel: entry.channel });
  record('send-draft', { id: entryId, channel: entry.channel });
  return { entryId, state: 'sent', draft: entry.draft };
}

/** The user discarded the draft. */
function dismissDraft({ entryId, reason } = {}) {
  const entry = resolveEntry(entryId, 'draft', 'dismissed', { reason: clean(reason ?? '', 400) });
  settleWaiters(entryId, { id: entryId, kind: 'draft', dismissed: true });
  emit('draftDismissed', { id: entryId, agentId: entry.agentId });
  record('dismiss-draft', { id: entryId });
  return { entryId, state: 'dismissed' };
}

// ---------------- secret requests ----------------
/**
 * The agent needs a secret the user has to supply.
 *
 * The value goes straight into the vault; it is never echoed back into the
 * transcript.
 */
function requestSecret({ agentId, sessionId, name, label, description, fields } = {}) {
  if (!agentId) throw new Error('agentId is required');
  const data = load();
  const entry = {
    id: newId('secret'),
    kind: 'secret',
    state: 'pending',
    agentId: String(agentId),
    sessionId: sessionId ? String(sessionId) : null,
    name: clean(name ?? '', 80),
    label: clean(label ?? 'Secret needed', 200),
    description: clean(description ?? '', 600),
    fields: normalizeFields(fields ?? [{ name: 'value', label: 'value', type: 'password' }]),
    createdAt: Date.now(),
  };
  data.entries.push(entry);
  prune(data);
  save(data);
  emit('secretRequested', entry);
  record('request-secret', { id: entry.id, agentId: entry.agentId });
  return entry;
}

/** The user supplied the secret; it is stored in the vault, not returned. */
function submitSecret({ entryId, value, name } = {}) {
  const entry = pick(entryId);
  if (!entry) throw new Error(`unknown secret request: ${entryId}`);
  const secretName = clean(name || entry.name || `secret_${entry.id}`, 80);
  const values = {};
  for (const field of entry.fields ?? []) values[field.name] = clean(value ?? '', 8000);
  let stored = null;
  try {
    const { secretsService } = require('./secretsService');
    stored = secretsService.set(secretName, values, `requested by ${entry.agentId}`);
  } catch (error) {
    // The request is still settled: the user did their part, and the failure
    // is reported in the outcome.
    const settled = resolveEntry(entryId, 'secret', 'failed', { error: clean(error.message, 300) });
    settleWaiters(entryId, { id: entryId, kind: 'secret', failed: true });
    emit('secretFailed', { id: entryId, agentId: entry.agentId, error: settled.error });
    record('submit-secret-failed', { id: entryId });
    return { entryId, state: 'failed', error: settled.error };
  }
  const settled = resolveEntry(entryId, 'secret', 'submitted', { secretName });
  settleWaiters(entryId, { id: entryId, kind: 'secret', submitted: true, secretName });
  emit('secretSubmitted', { id: entryId, agentId: entry.agentId, secretName });
  record('submit-secret', { id: entryId, secretName });
  // The VALUE is never returned.
  return { entryId, state: 'submitted', secretName, fields: stored?.fields ?? [] };
}

/** The user skipped the secret request. */
function dismissSecret({ entryId, reason } = {}) {
  const entry = resolveEntry(entryId, 'secret', 'dismissed', { reason: clean(reason ?? '', 400) });
  settleWaiters(entryId, { id: entryId, kind: 'secret', dismissed: true });
  emit('secretDismissed', { id: entryId, agentId: entry.agentId });
  record('dismiss-secret', { id: entryId });
  return { entryId, state: 'dismissed' };
}

module.exports = {
  userInteractionService: {
    listTrays, createTray, dismissTray, clearTrays,
    requestForm, submitForm, dismissForm, listForms, listWidgets, pending,
    requestWidget, respondWidget, dismissWidget,
    requestDraft, sendDraft, dismissDraft,
    requestSecret, submitSecret, dismissSecret,
    awaitEntry,
    get: (id) => publicEntry(pick(id)),
    getTray: (id) => listTrays().find((t) => t.id === id) ?? null,
    getForm: (id) => pick(id),
    getWidget: (id) => pick(id),
  },
};
