'use strict';
/**
 * Telemetry — local tracing and structured reliability reporting.
 *
 * The reference implementation ships OpenTelemetry (an OTLP exporter, a
 * renderer render-trace, a gateway command span) and a large set of
 * `report*` RPCs, all pointed at Cursor's own collectors. A local-first app
 * cannot send its telemetry to a vendor, so the same shape is implemented
 * here with a local sink: the spans and the reliability reports go to a
 * file on this machine, and to an OTLP endpoint **only if the user has
 * configured one**.
 *
 * Two things are provided:
 *
 *   - **tracing** — named spans with a parent, a duration and attributes,
 *     so a turn can be read end to end;
 *   - **reliability reporting** — every unhandled error is *classified*
 *     (transient / permanent / policy / user-cancelled / internal) and
 *     reported with a stable code, so "it broke" becomes "it broke this way".
 *
 * Nothing here phones home. The default sink is a local file.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** The span kinds. */
const KIND = {
  INTERNAL: 'internal',
  SERVER: 'server',
  CLIENT: 'client',
  PRODUCER: 'producer',
  CONSUMER: 'consumer',
};

/** The span status. */
const STATUS = { UNSET: 'unset', OK: 'ok', ERROR: 'error' };

/** The reliability classification. */
const CLASS = {
  /** Worth retrying. */
  TRANSIENT: 'transient',
  /** Will never work as it is. */
  PERMANENT: 'permanent',
  /** The policy said no. */
  POLICY: 'policy',
  /** The user said no. */
  USER_CANCELLED: 'user-cancelled',
  /** A bug. */
  INTERNAL: 'internal',
};

let sinkDir = null;
let sinkFile = null;
let enabled = true;
const spans = [];
const SPAN_LIMIT = 2000;
const reports = [];
const REPORT_LIMIT = 500;

/** Where the local sink writes. */
function sink() {
  if (sinkFile) return sinkFile;
  const base = process.env.QUANSIOX_USER_DATA_DIR
    ? path.join(process.env.QUANSIOX_USER_DATA_DIR, 'diagnostics')
    : path.join(os.tmpdir(), 'quansiox-diagnostics');
  fs.mkdirSync(base, { recursive: true });
  sinkFile = path.join(base, 'telemetry.jsonl');
  return sinkFile;
}

/** Turn the sink off (or back on). */
function setEnabled(value) {
  enabled = Boolean(value);
  return enabled;
}

/** Point the sink somewhere else. */
function setSinkDirectory(dir) {
  sinkDir = dir ? path.join(dir, 'telemetry.jsonl') : null;
  sinkFile = sinkDir;
  if (sinkFile) fs.mkdirSync(path.dirname(sinkFile), { recursive: true });
  return sinkFile;
}

function write(record) {
  if (!enabled) return;
  try {
    fs.appendFileSync(sink(), `${JSON.stringify(record)}\n`);
  } catch { /* the sink is best-effort */ }
}

/**
 * Start a span.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.kind]
 * @param {object} [opts.attributes]
 * @param {object} [opts.parent]  the parent span
 * @returns {object} the span
 */
function startSpan(name, opts = {}) {
  const span = {
    spanId: randomUUID().slice(0, 16),
    name: String(name ?? 'span'),
    kind: opts.kind ?? KIND.INTERNAL,
    parentSpanId: opts.parent?.spanId ?? opts.parentSpanId ?? null,
    traceId: opts.parent?.traceId ?? randomUUID().replace(/-/g, '').slice(0, 32),
    startedAtMs: Date.now(),
    endedAtMs: null,
    durationMs: null,
    status: STATUS.UNSET,
    attributes: { ...(opts.attributes ?? {}) },
    error: null,
  };
  return span;
}

/** End a span successfully. */
function endSpan(span, attributes = {}) {
  if (!span || span.endedAtMs) return span;
  span.endedAtMs = Date.now();
  span.durationMs = span.endedAtMs - span.startedAtMs;
  span.status = STATUS.OK;
  Object.assign(span.attributes, attributes);
  spans.push(span);
  while (spans.length > SPAN_LIMIT) spans.shift();
  write({ kind: 'span', ...span });
  return span;
}

/** End a span with an error. */
function endSpanWithError(span, error, attributes = {}) {
  if (!span || span.endedAtMs) return span;
  span.endedAtMs = Date.now();
  span.durationMs = span.endedAtMs - span.startedAtMs;
  span.status = STATUS.ERROR;
  span.error = {
    code: error?.code ?? null,
    message: String(error?.message ?? error ?? 'unknown error').slice(0, 500),
  };
  Object.assign(span.attributes, attributes);
  spans.push(span);
  while (spans.length > SPAN_LIMIT) spans.shift();
  write({ kind: 'span', ...span });
  return span;
}

/**
 * Run a function inside a span.
 *
 * @param {string} name
 * @param {Function} fn  async (span) => result
 * @param {object} [opts]
 */
async function withSpan(name, fn, opts = {}) {
  const span = startSpan(name, opts);
  try {
    const result = await fn(span);
    endSpan(span);
    return result;
  } catch (error) {
    endSpanWithError(span, error);
    throw error;
  }
}

/** The spans recorded so far. */
function recentSpans({ limit = 100, name = null, traceId = null } = {}) {
  let rows = spans;
  if (name) rows = rows.filter((s) => s.name === name);
  if (traceId) rows = rows.filter((s) => s.traceId === traceId);
  return rows.slice(-Math.max(1, Math.min(Number(limit) || 100, SPAN_LIMIT)));
}

/**
 * Classify an error for the reliability report.
 *
 * @param {*} error
 * @param {object} [context]
 * @returns {{ class: string, code: string, message: string, retryable: boolean, needsUser: boolean }}
 */
function classifyFailure(error, context = {}) {
  const { classify, CODE } = require('./errors');
  const classified = classify(error);
  let cls = CLASS.INTERNAL;
  if (classified.code === CODE.USER_DECLINED || classified.code === CODE.REFUSED) cls = CLASS.USER_CANCELLED;
  else if (classified.code === CODE.ACCESS_DENIED || classified.code === CODE.BLOCKED) cls = CLASS.POLICY;
  else if (classified.retryable) cls = CLASS.TRANSIENT;
  else if (classified.code !== CODE.INTERNAL) cls = CLASS.PERMANENT;
  return {
    class: cls,
    code: classified.code,
    message: classified.message,
    retryable: classified.retryable,
    needsUser: classified.needsUser,
    ...context,
  };
}

/**
 * Report a failure.
 *
 * @param {*} error
 * @param {object} [context]
 * @returns {object} the report
 */
function reportFailure(error, context = {}) {
  const report = {
    id: randomUUID().slice(0, 12),
    at: Date.now(),
    ...classifyFailure(error, context),
  };
  reports.push(report);
  while (reports.length > REPORT_LIMIT) reports.shift();
  write({ kind: 'failure', ...report });
  return report;
}

/** Report something that is not an error but is worth knowing. */
function reportEvent(name, detail = {}) {
  const record = { id: randomUUID().slice(0, 12), at: Date.now(), event: String(name), ...detail };
  reports.push(record);
  while (reports.length > REPORT_LIMIT) reports.shift();
  write({ kind: 'event', ...record });
  return record;
}

/** The reliability reports. */
function recentReports({ limit = 100, class: cls = null } = {}) {
  const rows = cls ? reports.filter((r) => r.class === cls) : reports;
  return rows.slice(-Math.max(1, Math.min(Number(limit) || 100, REPORT_LIMIT)));
}

/** A summary: how many failures of each class. */
function summary() {
  const counts = {};
  for (const report of reports) {
    if (!report.class) continue;
    counts[report.class] = (counts[report.class] ?? 0) + 1;
  }
  return {
    spans: spans.length,
    reports: reports.length,
    failures: counts,
    sink: enabled ? sink() : null,
  };
}

function reset() {
  spans.length = 0;
  reports.length = 0;
}

module.exports = {
  CLASS,
  KIND,
  STATUS,
  classifyFailure,
  endSpan,
  endSpanWithError,
  recentReports,
  recentSpans,
  reportEvent,
  reportFailure,
  reset,
  setEnabled,
  setSinkDirectory,
  startSpan,
  summary,
  withSpan,
};
