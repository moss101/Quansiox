'use strict';
/**
 * Auto-review approvals — pending registry for agent actions that require a
 * reviewed approval (Grok resolveAutoReviewApproval parity, ['approved',
 * 'denied', 'always']). Quansiox extension `requestAutoReviewApproval` opens a
 * request; resolution settles it and wakes any waiting caller.
 */
const crypto = require('node:crypto');

const RESOLUTIONS = new Set(['approved', 'denied', 'always']);
const pending = new Map();

function emit(method, payload) {
  try { require('../ipc/emitEvent').emitEvent('autoReview', method, payload); } catch {}
}
function publicEntry(e) {
  return {
    entryId: e.entryId, requestId: e.requestId, agentId: e.agentId, command: e.command,
    settled: e.settled?.resolution ?? null, createdAt: e.createdAt,
  };
}
function newId(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('base64url')}`; }

function request({ entryId, requestId, agentId, command } = {}) {
  const id = String(requestId || newId('arq'));
  if (pending.has(id)) return publicEntry(pending.get(id));
  const entry = {
    entryId: entryId ?? newId('are'),
    requestId: id,
    agentId: agentId ?? null,
    command: command ? String(command).slice(0, 2000) : null,
    createdAt: Date.now(),
    settled: null,
    waiters: [],
  };
  pending.set(id, entry);
  emit('requested', publicEntry(entry));
  return publicEntry(entry);
}

function awaitRequest({ requestId, waitMs = 120_000 } = {}) {
  const entry = pending.get(String(requestId || ''));
  if (!entry) return Promise.resolve(null);
  if (entry.settled) return Promise.resolve(entry.settled);
  const wait = Math.max(0, Number(waitMs) || 120_000);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(null), wait); timer.unref?.();
    entry.waiters.push(finish);
  });
}

function resolve({ entryId, requestId, resolution, agentId, approvedCommand, sessionId } = {}) {
  if (!RESOLUTIONS.has(resolution)) throw new Error("resolution must be 'approved', 'denied' or 'always'");
  let entry = pending.get(String(requestId || ''));
  if (!entry) {
    entry = [...pending.values()].find((e) => !e.settled
      && (entryId ? e.entryId === entryId : true)
      && (agentId ? !e.agentId || e.agentId === agentId : true));
  }
  if (!entry) return { resolved: false, reason: 'no matching pending auto-review approval', entryId: entryId ?? null, requestId: requestId ?? null };
  const detail = {
    resolution,
    at: Date.now(),
    agentId: agentId ?? entry.agentId,
    approvedCommand: approvedCommand ?? null,
    sessionId: sessionId ?? null,
  };
  entry.settled = detail;
  for (const wake of entry.waiters.splice(0)) wake(detail);
  emit('settled', { ...publicEntry(entry), resolution, approvedCommand: detail.approvedCommand });
  return { resolved: true, entryId: entry.entryId, requestId: entry.requestId, resolution };
}

function list() {
  return [...pending.values()].map(publicEntry);
}

module.exports = { autoReviewService: { request, awaitRequest, resolve, list } };
