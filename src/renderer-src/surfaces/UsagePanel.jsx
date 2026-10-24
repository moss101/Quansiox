import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * UsagePanel — tokens, requests and what they cost.
 *
 * The numbers come from the same code the agent runs: every turn adds its
 * token usage to the session, and `pricingService` prices a session against
 * the rates of the model that ran it. The panel shows the totals, the cost
 * grouped by model, and a per-session breakdown.
 *
 * There is no `pricing` namespace — the cost model is exposed through the
 * session surface (`sessions.cost`, `sessions.rates`, `sessions.stats`) and
 * the aggregate (`settings.usageSummary`).
 *
 * Props:
 *   - active?: boolean — when false the panel stops polling (default true).
 *   - limit?: number — how many sessions to break down (default 50).
 *
 * The panel is read-only, so it takes no notification sink: every problem it
 * has is shown in place (the error state) rather than as a toast.
 */

/** 1 234 → "1.2k" so a column of numbers stays readable. */
function compact(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** A cost in dollars, or an em dash when the model is unknown. */
function money(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value) || 0;
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function UsagePanel({ active = true, limit = 50 }) {
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [rates, setRates] = useState(null);
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const [totals, list, settings] = await Promise.all([
        api.settings.usageSummary(),
        api.sessions.list(),
        api.settings.get(),
      ]);
      setSummary(totals ?? null);
      const currentModel = settings?.model ?? '';
      setModel(currentModel);

      const targets = (Array.isArray(list) ? list : []).slice(0, Math.max(1, limit));
      const details = await Promise.all(targets.map(async (session) => {
        const [stats, cost] = await Promise.all([
          api.sessions.stats({ id: session.id }).catch(() => null),
          api.sessions.cost({ id: session.id }).catch(() => null),
        ]);
        return {
          id: session.id,
          title: session.title || session.id,
          updatedAt: session.updatedAt,
          turns: session.turnCount,
          usage: stats?.usage ?? null,
          estimatedCost: stats?.estimatedCost ?? cost?.cost ?? null,
          model: cost?.rates?.matched ?? null,
        };
      }));
      setRows(details);

      if (currentModel) {
        const matched = await api.sessions.rates({ model: currentModel }).catch(() => null);
        setRates(matched);
      } else {
        setRates(null);
      }
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    if (!active) return undefined;
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  /** The cost grouped by the model that ran the session. */
  const byModel = useMemo(() => {
    const groups = new Map();
    for (const row of rows) {
      const key = row.model || 'unknown';
      const group = groups.get(key) ?? { model: key, sessions: 0, promptTokens: 0, completionTokens: 0, requests: 0, cost: 0, priced: 0 };
      group.sessions += 1;
      group.promptTokens += row.usage?.promptTokens ?? 0;
      group.completionTokens += row.usage?.completionTokens ?? 0;
      group.requests += row.usage?.requests ?? 0;
      if (row.estimatedCost !== null && row.estimatedCost !== undefined) {
        group.cost += Number(row.estimatedCost) || 0;
        group.priced += 1;
      }
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.cost - a.cost);
  }, [rows]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => (b.estimatedCost ?? -1) - (a.estimatedCost ?? -1)),
    [rows],
  );

  const totals = summary ?? {};
  const hasUsage = Boolean(summary && (summary.requests > 0 || summary.promptTokens > 0));

  return (
    <section className="sfx-panel" data-surface="usage">
      <header className="sfx-head">
        <span className="surface-label">Usage &amp; cost</span>
        <div className="sfx-head-actions">
          <button type="button" className="ibtn" title="Refresh" disabled={busy} onClick={refresh}>
            <Icon.Refresh />
          </button>
        </div>
      </header>

      <div className="sfx-body">
        {error ? (
          <div className="sfx-error" data-surface="usage-error">
            <Icon.Info />
            <span>{error}</span>
            <button type="button" className="btn btn-secondary btn-mini" onClick={refresh}>Retry</button>
          </div>
        ) : null}

        {loading && !summary ? <div className="sfx-loading">Reading the usage…</div> : null}

        {!loading && !hasUsage && !error ? (
          <div className="sfx-empty" data-surface="usage-empty">
            <p>Nothing has been billed yet.</p>
            <p className="sfx-hint">
              Once the agent runs a turn, its tokens show up here with the cost the configured model
              would charge.
            </p>
          </div>
        ) : null}

        <div className="sfx-stats" data-surface="usage-totals">
          <div className="sfx-stat">
            <span className="sfx-stat-value">{compact(totals.sessions ?? 0)}</span>
            <span className="sfx-stat-label">sessions</span>
          </div>
          <div className="sfx-stat">
            <span className="sfx-stat-value">{compact(totals.turns ?? 0)}</span>
            <span className="sfx-stat-label">turns</span>
          </div>
          <div className="sfx-stat">
            <span className="sfx-stat-value">{compact(totals.promptTokens ?? 0)}</span>
            <span className="sfx-stat-label">tokens in</span>
          </div>
          <div className="sfx-stat">
            <span className="sfx-stat-value">{compact(totals.completionTokens ?? 0)}</span>
            <span className="sfx-stat-label">tokens out</span>
          </div>
          <div className="sfx-stat">
            <span className="sfx-stat-value">{compact(totals.requests ?? 0)}</span>
            <span className="sfx-stat-label">requests</span>
          </div>
          <div className="sfx-stat">
            <span className="sfx-stat-value">{money(totals.costUsd ?? null)}</span>
            <span className="sfx-stat-label">estimated cost</span>
          </div>
        </div>

        <details className="sfx-section" data-surface="usage-rates" open>
          <summary className="surface-label">Rates — {model || 'no model set'}</summary>
          {rates ? (
            <div className="sfx-row">
              <span className="sfx-title">{rates.matched}</span>
              <span className="sfx-tag">in ${rates.input}/1M</span>
              <span className="sfx-tag">out ${rates.output}/1M</span>
              {rates.custom ? <span className="sfx-tag">custom rate</span> : null}
            </div>
          ) : (
            <p className="sfx-hint">
              No rate matches this model — set one under Settings → pricing, or the cost stays unknown.
            </p>
          )}
        </details>

        <details className="sfx-section" data-surface="usage-by-model" open>
          <summary className="surface-label">Cost by model ({byModel.length})</summary>
          {byModel.length === 0 ? (
            <p className="sfx-hint">No session has been priced yet.</p>
          ) : byModel.map((group) => (
            <div key={group.model} className="sfx-row" data-model={group.model}>
              <span className="sfx-title">{group.model}</span>
              <span className="sfx-tag">{group.sessions} sessions</span>
              <span className="sfx-tag">↑{compact(group.promptTokens)}</span>
              <span className="sfx-tag">↓{compact(group.completionTokens)}</span>
              <span className="sfx-mono">{money(group.priced ? group.cost : null)}</span>
            </div>
          ))}
        </details>

        <details className="sfx-section" data-surface="usage-sessions" open>
          <summary className="surface-label">Per session ({rows.length})</summary>
          {sorted.length === 0 ? (
            <p className="sfx-hint">No sessions to break down.</p>
          ) : sorted.map((row) => (
            <div key={row.id} className="sfx-row" data-session={row.id}>
              <span className="sfx-title">{row.title}</span>
              <span className="sfx-tag">{row.turns ?? 0} turns</span>
              <span className="sfx-tag">↑{compact(row.usage?.promptTokens ?? 0)}</span>
              <span className="sfx-tag">↓{compact(row.usage?.completionTokens ?? 0)}</span>
              <span className="sfx-tag">{row.usage?.requests ?? 0} requests</span>
              <span className="sfx-mono">{money(row.estimatedCost ?? null)}</span>
            </div>
          ))}
          <p className="sfx-hint">
            An estimate, not an invoice: it is the token usage of the session priced with the rates
            that match the model it ran on.
          </p>
          {summary?.sessions > rows.length ? (
            <p className="sfx-hint">
              The {summary.sessions - rows.length} older sessions are in the totals above but not in
              this breakdown.
            </p>
          ) : null}
        </details>
      </div>
    </section>
  );
}

export default UsagePanel;
