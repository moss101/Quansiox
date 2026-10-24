'use strict';
/**
 * Troubleshooting notice stack (docs: "request-ID surface for errors").
 * Small in-memory ring of notices, each with a request ID the user can copy
 * and quote when reporting an issue. Broadcast to every window; node-safe so
 * the coordinator-adjacent services can raise notices too.
 */
const crypto = require('node:crypto');

const MAX = 20;
const notices = [];

function raise({ title, body = '', kind = 'error', sessionId = null, requestId } = {}) {
  const id = requestId ?? `req_${crypto.randomBytes(6).toString('base64url')}`;
  const entry = {
    id,
    requestId: id,
    title: String(title ?? 'Notice').slice(0, 200),
    body: String(body).slice(0, 2000),
    kind,
    sessionId: sessionId == null ? null : String(sessionId),
    at: Date.now(),
  };
  notices.push(entry);
  if (notices.length > MAX) notices.splice(0, notices.length - MAX);
  try { require('../ipc/emitEvent').emitEvent('system', 'onNotice', entry); } catch { /* no windows */ }
  return entry;
}

function list() {
  return [...notices];
}

function dismiss({ id } = {}) {
  const index = notices.findIndex((n) => n.id === id);
  if (index < 0) return { dismissed: false };
  notices.splice(index, 1);
  return { dismissed: true };
}

function clear() {
  const cleared = notices.length;
  notices.length = 0;
  return { cleared };
}

module.exports = { noticeService: { raise, list, dismiss, clear } };
