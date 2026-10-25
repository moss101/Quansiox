'use strict';
/**
 * Usage spend-limit model (parity plan P3.12) — pure.
 *
 * Grok's usage panel shows spend-limit cards (weekly limit, on-demand,
 * auto-top-up). Quansiox's version is LOCAL MATH ONLY on token costs: the
 * limit is a settings field, the spend is the sum of estimated session
 * costs in the current week, and the states are honest thresholds. There is
 * no billing integration and never a fabricated charge (P3.8 policy).
 */

/** ISO week bucket key: the Monday-date of the week containing `ts`. */
export function weekKey(ts, now = Date.now()) {
  const d = new Date(Number.isFinite(ts) ? ts : now);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Week-to-date estimated spend. `rows` carry {estimatedCost?, updatedAt?}. */
export function weekToDate(rows, now = Date.now()) {
  const key = weekKey(now, now);
  let sum = 0;
  let sessions = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (weekKey(row?.updatedAt ?? row?.at ?? 0, now) !== key) continue;
    const cost = Number(row?.estimatedCost);
    if (Number.isFinite(cost) && cost > 0) { sum += cost; sessions += 1; }
  }
  return { week: key, spend: +sum.toFixed(4), sessions };
}

/**
 * @param {{limit?: number|null}} settings  spendLimitWeekly (null = off)
 * @param {{spend: number}} wtd week-to-date
 * @returns {{enabled: boolean, limit: number|null, pct: number, state: 'off'|'ok'|'warning'|'exceeded', remaining: number|null}}
 */
export function limitState(settings, wtd) {
  const limit = Number(settings?.spendLimitWeekly);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { enabled: false, limit: null, pct: 0, state: 'off', remaining: null };
  }
  const pct = Math.max(0, Math.round((wtd.spend / limit) * 100));
  const state = wtd.spend >= limit ? 'exceeded' : pct >= 80 ? 'warning' : 'ok';
  return { enabled: true, limit, pct, state, remaining: +Math.max(0, limit - wtd.spend).toFixed(4) };
}

/** The card the panel renders — authored copy, local-only honesty. */
export function cardModel(settings, wtd, now = Date.now()) {
  const state = limitState(settings, wtd);
  return {
    ...state,
    title: 'Weekly spend limit',
    spentLabel: `$${wtd.spend.toFixed(2)} this week${state.enabled ? ` of $${state.limit.toFixed(2)}` : ''}`,
    note: state.enabled
      ? 'Local estimate on token costs — no billing is connected.'
      : 'Set a weekly limit to track estimated spend. Local math only — no billing is connected.',
    topUp: { label: 'Auto top-up', status: 'off', note: 'requires purchase rails (fail-closed by policy)' },
    onDemand: { label: 'On demand', status: 'off', note: 'no plan gating locally — every configured provider is pay-as-you-go on your own keys' },
  };
}
