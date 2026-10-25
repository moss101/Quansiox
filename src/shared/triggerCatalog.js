'use strict';
/**
 * The automation trigger catalog (parity plan P3.5) — shared, pure.
 *
 * Grok's trigger taxonomy is an extraction fact; the implementations follow
 * the Phase-P3 honesty policy: schedule + webhook are REAL locally (the
 * automations service already records webhook/manual/schedule runs and
 * verifies webhook tokens locally); the connector-fed kinds are honest
 * stubs until a real connector integration exists — same shape as
 * src/coordinator/grokActionMap.js.
 */

export const TRIGGERS = [
  {
    id: 'schedule', label: 'Schedule', status: 'local',
    fields: [{ name: 'cron', type: 'cron', required: true, note: 'NL presets or a raw expression' }],
    impl: 'automationService cron (validated locally)',
  },
  {
    id: 'webhook', label: 'Webhook', status: 'local',
    fields: [
      { name: 'method', type: 'enum', values: ['post'], note: 'POST only' },
      { name: 'headers', type: 'headers', note: 'arbitrary headers recorded with the token' },
      { name: 'key', type: 'token', note: 'local token verification (webhookToken)' },
    ],
    impl: 'webhookServer + per-automation token',
  },
  {
    id: 'calendar', label: 'Calendar events', status: 'approx',
    note: 'fires from the local calendar when one is configured; no calendar connector yet',
    impl: 'calendar events surface (pending local calendar source)',
  },
  { id: 'pr', label: 'Pull requests', status: 'stub', reason: 'scm-connector', events: ['open', 'merge', 'close', 'review-request', 'mergeable-check'] },
  { id: 'ci', label: 'CI', status: 'stub', reason: 'scm-connector', events: ['pass', 'fail'] },
  { id: 'linear', label: 'Linear', status: 'stub', reason: 'issue-connector', events: ['issue', 'cycle'] },
  { id: 'pagerduty', label: 'PagerDuty', status: 'stub', reason: 'incident-connector', events: ['trigger', 'resolve'] },
  { id: 'sentry', label: 'Sentry', status: 'stub', reason: 'issue-connector', events: ['issue'] },
  { id: 'teams-message', label: 'Teams message', status: 'stub', reason: 'teams-integration' },
];

export function triggerById(id) {
  return TRIGGERS.find((t) => t.id === id) ?? null;
}

/** The composer sample states (extraction fact labels). */
export const COMPOSER_STATES = ['Every hour', 'Every day', 'Every weekday', 'Custom schedule', 'Cron…'];

export function manifest() {
  const by = (s) => TRIGGERS.filter((t) => t.status === s).length;
  return { total: TRIGGERS.length, local: by('local'), approx: by('approx'), stub: by('stub') };
}
