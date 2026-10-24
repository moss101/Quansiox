'use strict';
/**
 * Grok compatibility surface — routes every method in the shipped Grok Bot
 * desktop/coordinator surface to either a real local handler (handlers.js) or
 * an explicit fail-closed stub. This makes Quansiox answer the whole surface
 * with correct semantics instead of pretending: local capabilities are real;
 * cloud/backend/account/vendor capabilities return a structured
 * "unavailable + scope" rather than a fake success.
 *
 * The catalogue in `catalog.js` is the authoritative count. As of the
 * 2026-10-20 reverse-engineering pass (Batch 17) it held 552 entries; the
 * 0.75.0 re-baseline added the four methods the missing list named
 * (beginSpendApproval, createThreadFromMessage, dismissAgentSuggestions,
 * listVirtualCardPaymentMethods), so it now holds **556** entries.
 * `test/grok-compat.js` asserts the number, so this comment cannot silently
 * drift away from the registry again.
 */
const { REGISTRY } = require('./catalog');
const { HANDLERS } = require('./handlers');

const BY_METHOD = new Map(REGISTRY.map((r) => [r.method, r]));

const SCOPE_REASON = {
  cloud: 'requires a cloud-box / remote-computer service (Quansiox VM is headless-local)',
  'cursor/account': 'requires a Cursor / Grok account + team backend',
  backend: 'requires a backend service Quansiox does not run',
  voice: 'requires a voice / vendor service',
  telemetry: 'telemetry/settings — no-op in local-first mode',
  'local-pending': 'planned local-first feature (not implemented yet)',
  'desktop-panel': 'Grok desktop overlay panel (mount/pet) — not implemented in Quansiox',
  devtool: 'developer tooling window — not implemented',
};

async function dispatch(method, params, ctx = {}) {
  const result = await route(method, params, ctx);
  try { require('../gatewayStateService').gatewayStateService.noteDispatch(method, result?.status ?? 'ok'); } catch {}
  return result;
}

async function route(method, params, ctx = {}) {
  const entry = BY_METHOD.get(method);
  if (!entry) return { status: 'not_found', method, hint: 'unknown Grok method' };
  let gateReason = null;
  try { gateReason = require('../gatewayStateService').gatewayStateService.gate(method); } catch {}
  if (gateReason) {
    return { status: 'unavailable', side: entry.side, method, impl: 'gateway', group: entry.group, scope: 'gateway', reason: gateReason };
  }
  if (entry.impl === 'local' && entry.handler) {
    const handler = HANDLERS[entry.handler];
    if (!handler) return { status: 'unimplemented', method, reason: `no handler for ${entry.handler}` };
    try {
      const out = await handler(params || {}, ctx);
      return { method, side: entry.side, group: entry.group, impl: 'local', ...(out && typeof out === 'object' ? out : { result: out }) };
    } catch (error) {
      return { status: 'error', method, impl: 'local', error: String(error?.message ?? error) };
    }
  }
  return {
    status: 'unavailable', side: entry.side, method, impl: 'stub', group: entry.group,
    scope: entry.scope, summary: entry.summary, reason: SCOPE_REASON[entry.scope] || 'not available in local-first mode',
  };
}

function catalog() {
  const byScope = {};
  const byGroup = {};
  for (const r of REGISTRY) {
    const s = r.impl === 'local' ? 'local' : r.scope;
    byScope[s] = (byScope[s] || 0) + 1;
    byGroup[r.group] = (byGroup[r.group] || 0) + 1;
  }
  return {
    total: REGISTRY.length,
    local: REGISTRY.filter((r) => r.impl === 'local').length,
    stub: REGISTRY.filter((r) => r.impl === 'stub').length,
    byScope, byGroup,
    methods: REGISTRY.map((r) => ({ method: r.method, side: r.side, group: r.group, impl: r.impl, scope: r.scope, summary: r.summary })),
  };
}

module.exports = { grokCompatService: { dispatch, catalog, REGISTRY } };
