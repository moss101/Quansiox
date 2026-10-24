'use strict';
/**
 * Cookie-origin approval service — the real local flow behind Grok 0.71's
 * request/present/await/cancelCookieOriginApproval quartet.
 *
 * Semantics (single-process, event-driven):
 *  - request(requestId, origins) → registers a pending approval, broadcasts
 *    `cookieOriginApproval:requested` to renderers.
 *  - present(requestId, origins) → shows the REAL approval UI (native Electron
 *    dialog per origin); the user's decision settles the request and, when
 *    granted, persists origin grants through cookieImportService.
 *  - await(requestId, waitMs) → resolves with the decision once settled, or
 *    reports `pending` after waitMs.
 *  - cancel(requestId) → settles as `cancelled`.
 *
 * Fail-closed: no decision ⇒ nothing is granted. Electron-free tests can stub
 * the dialog module; without Electron `present` parks the request for
 * await/cancel.
 */
const crypto = require('node:crypto');

const SETTLED_TTL_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_MS = 120_000;

const pending = new Map(); // requestId -> entry

function emit(namespace, method, payload) {
  try {
    const { emitEvent } = require('../ipc/emitEvent');
    emitEvent(namespace, method, payload);
  } catch {}
}

function grantOrigins(agentId, origins) {
  try {
    const { cookieImportService } = require('./cookieImportService');
    const list = origins.map((o) => (typeof o === 'string' ? o : o?.origin)).filter(Boolean);
    if (agentId && list.length) cookieImportService.putGrants(agentId, { add: list });
    return true;
  } catch { return false; }
}

function settle(entry, decision) {
  if (entry.settled) return { ...entry.settled, requestId: entry.requestId };
  clearTimeout(entry.timer);
  entry.settled = { ...decision, settledAt: Date.now() };
  entry.settledExpiry = setTimeout(() => pending.delete(entry.requestId), SETTLED_TTL_MS);
  entry.settledExpiry.unref?.();
  for (const resolve of entry.waiters.splice(0)) resolve(entry.settled);
  emit('cookieOriginApproval', 'settled', { requestId: entry.requestId, ...entry.settled });
  return { ...entry.settled, requestId: entry.requestId };
}

function ensure({ requestId, origins = [], agentId } = {}) {
  const id = String(requestId || '');
  if (!id) throw new Error('requestId is required');
  let entry = pending.get(id);
  if (entry) return entry;
  entry = { requestId: id, origins, agentId: agentId ?? null, createdAt: Date.now(), settled: null, waiters: [], presented: false };
  entry.timer = setTimeout(() => settle(entry, { kind: 'expired', reason: 'no decision within 10 minutes' }), SETTLED_TTL_MS);
  entry.timer.unref?.();
  pending.set(id, entry);
  return entry;
}

function request({ requestId, origins, agentId } = {}) {
  const entry = ensure({ requestId, origins, agentId });
  if (!entry.settled) emit('cookieOriginApproval', 'requested', { requestId: entry.requestId, origins: entry.origins, agentId: entry.agentId });
  return {
    requestId: entry.requestId,
    status: entry.settled ? entry.settled.kind : 'pending',
    origins: entry.origins,
    agentId: entry.agentId,
    ...(entry.settled ? { decision: entry.settled } : {}),
  };
}

async function present({ requestId, origins, agentId } = {}) {
  const entry = ensure({ requestId, origins: origins ?? pending.get(String(requestId))?.origins ?? [], agentId });
  entry.presented = true;
  let dialog = null;
  try { ({ dialog } = require('electron')); } catch {}
  if (!dialog?.showMessageBox) {
    // No UI host in this process — park; await/cancel drive the outcome.
    emit('cookieOriginApproval', 'requested', { requestId: entry.requestId, origins: entry.origins, agentId: entry.agentId });
    return { requestId: entry.requestId, kind: 'pending', presented: true, origins: entry.origins };
  }
  for (const o of entry.origins) {
    const origin = typeof o === 'string' ? o : o?.origin;
    const profileId = typeof o === 'object' ? o?.profileId : undefined;
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Deny', 'Allow'],
      defaultId: 1,
      cancelId: 0,
      message: `Allow Quansiox to import cookies for ${origin}?`,
      detail: profileId ? `Chrome profile: ${profileId}` : 'Cookies are only imported for origins you allow.',
    });
    if (response !== 1) return settle(entry, { kind: 'refused', reason: 'user denied', origin });
  }
  const persisted = grantOrigins(entry.agentId, entry.origins);
  return settle(entry, { kind: 'granted', message: `granted ${entry.origins.length} origin(s)`, grantsPersisted: persisted });
}

function awaitDecision({ requestId, waitMs } = {}) {
  const entry = pending.get(String(requestId || ''));
  if (!entry) return Promise.resolve({ requestId: String(requestId || ''), kind: 'unknown', reason: 'no such request' });
  if (entry.settled) return Promise.resolve({ requestId: entry.requestId, ...entry.settled });
  const wait = Math.max(0, Number(waitMs) || DEFAULT_WAIT_MS);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish({ requestId: entry.requestId, kind: 'pending', waitedMs: wait }), wait); timer.unref?.();
    entry.waiters.push((decision) => finish({ requestId: entry.requestId, ...decision }));
  });
}

function cancel({ requestId } = {}) {
  const entry = pending.get(String(requestId || ''));
  if (!entry) return { requestId: String(requestId || ''), cancelled: false, reason: 'no such request' };
  if (entry.settled) return { requestId: entry.requestId, cancelled: false, already: entry.settled.kind };
  return { requestId: entry.requestId, cancelled: true, ...settle(entry, { kind: 'cancelled', reason: 'cancelled by requestor' }) };
}

function list() {
  return [...pending.values()].map((e) => ({ requestId: e.requestId, origins: e.origins, agentId: e.agentId, settled: e.settled?.kind ?? null, presented: e.presented, createdAt: e.createdAt }));
}

module.exports = { cookieApprovalService: { request, present, await: awaitDecision, cancel, list, _settle: settle } };
