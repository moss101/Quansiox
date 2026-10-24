'use strict';
/**
 * Confirmation service — interactive tool-approval prompts (the local half of
 * Grok's approveCredentialRequest / resolveLocalToolPermission). The
 * coordinator asks the main process before running an action that the
 * permission ladder says needs a human; main relays an `agent:onConfirm`
 * scoped event to the owning renderer, which shows an Approve/Deny prompt.
 *
 * The request is a STRUCTURED object (W1.8): the approval card needs the
 * action, the target, a redacted argument preview and an expiry — not just a
 * tool name.
 *
 * It is fail-closed: no response within the timeout ⇒ denied, and every
 * failure path resolves to "not approved".
 *
 * Main-only (needs windowManager/events).
 */
let pending = new Map(); // id -> { resolve, timer, tool, sessionId, args, cwd, request }
let nextId = 1;

// Tools that mutate state, touch the OS, or reach the network — anything whose
// side effects the user may want to gate mid-run.
const GATED = new Set([
  'shell', 'write_file', 'submit_secret', 'computer_click', 'computer_type',
  'computer_key', 'computer_scroll', 'computer_set_value', 'computer_open_app',
  'browser_fill', 'browser_click', 'browser_fill_credentials', 'browser_import_cookies', 'github_pr_create', 'slack_post_message', 'email_send', 'messages_send',
]);
function isGated(tool) { return GATED.has(String(tool)); }

/**
 * Open a confirmation; the caller relays the event and drives the reply.
 *
 * @param {string} sessionId
 * @param {string} tool
 * @param {object} args
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {object} [request] the structured request from the coordinator
 */
function request(sessionId, tool, args, cwd, timeoutMs = 120_000, request = null) {
  const id = `cfm_${nextId++}`;
  const structured = request && typeof request === 'object'
    ? { ...request, id: request.id || id, sessionId: request.sessionId ?? sessionId, tool: request.tool ?? tool }
    : {
        id,
        tool: String(tool ?? 'action'),
        action: String(tool ?? 'action'),
        target: '',
        targetKind: 'unknown',
        description: '',
        argsPreview: args ?? {},
        cwd: cwd ?? null,
        sessionId: sessionId ?? null,
        expiresAtMs: Date.now() + (Number(timeoutMs) || 120_000),
      };
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        resolve(false);
        // Fail-closed denials are user-visible: raise a notice with a request ID.
        try {
          require('./noticeService').noticeService.raise({
            title: 'Approval timed out — action denied',
            body: `No response for ${tool} within ${Math.round((Number(timeoutMs) || 120_000) / 1000)}s; denied to stay safe.`,
            kind: 'warn',
            sessionId,
          });
        } catch { /* notices are best-effort */ }
      }
    }, Math.max(0, Number(timeoutMs) || 120_000));
    pending.set(id, { id, resolve, timer, sessionId, tool, args, cwd, request: structured });
  });
  return { id, promise, request: structured };
}

/**
 * Renderer approves/denies.
 *
 * `scope` is 'once' (this action only) or 'always' (record a standing grant
 * for this exact action). Returns true if the id was pending.
 */
function respond(id, approved, scope = 'once') {
  const entry = pending.get(id || '');
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  if (approved === true && scope === 'always') {
    // Record the standing grant so the next identical action is not asked
    // again. The grant is bound to the tool AND its target.
    try {
      const { standingGrantsService } = require('./standingGrantsService');
      const request = entry.request ?? {};
      standingGrantsService.add({
        scope: 'action',
        action: request.tool ?? entry.tool,
        target: request.target ?? '',
        tool: request.tool ?? entry.tool,
      });
    } catch { /* a missing grant store must not break the approval */ }
  }
  entry.resolve(approved === true);
  return true;
}

function list() {
  return [...pending.values()].map((p) => ({
    id: p.id,
    sessionId: p.sessionId,
    tool: p.tool,
    request: p.request,
  }));
}

module.exports = { confirmationService: { request, respond, isGated, list, GATED } };
