'use strict';
/**
 * Support bundle — a local, redacted diagnostics archive (docs troubleshooting).
 *
 * Collects app/host metadata, redacted settings, the diagnostics log, notices,
 * feature flags and session *summaries* (never transcripts), writes them into a
 * temp directory, and zips it with ditto. Secrets and credential-shaped fields
 * are scrubbed; nothing is uploaded.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function userDataDir() {
  return require('./userData').userDataDir();
}
function appVersion() {
  try { return require('../../../package.json').version; } catch { return '0.0.0'; }
}
const SECRET_KEY = /(api[-_]?key|token|password|passwd|secret|authorization|bearer|cookie|private[-_]?key)/i;
const SECRET_SHAPE = /^(sk-|ghp_|xox[baprs]-|Bearer\s)/i;

/** Deep-scrub credential-shaped keys and values. */
function scrub(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') {
    if (SECRET_SHAPE.test(value)) return '…';
    return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 200)) {
    out[k] = SECRET_KEY.test(k) ? '…' : scrub(v, depth + 1);
  }
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * Build a bundle. Returns { path, bytes, files, createdAt }.
 * opts.outDir overrides the destination directory (tests).
 */
function create({ outDir } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = outDir ? path.resolve(outDir) : path.join(userDataDir(), 'support-bundles');
  fs.mkdirSync(root, { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-support-'));
  const files = [];

  const write = (name, data) => {
    const body = typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`;
    fs.writeFileSync(path.join(stage, name), body, { mode: 0o600 });
    files.push(name);
  };

  const settings = require('./settingsService').settingsService.redacted(
    require('./settingsService').settingsService.load()
  );
  let installId = null;
  try { installId = require('./installIdService').installIdService.getOrCreate(); } catch { /* optional */ }
  let flags = null;
  try { flags = require('./flagsService').flagsService.snapshot(); } catch { /* optional */ }
  let diagnostics = [];
  try { diagnostics = require('./diagnosticsService').diagnosticsService.list({ limit: 500 }); } catch { /* optional */ }
  let notices = [];
  try { notices = require('./noticeService').noticeService.list(); } catch { /* optional */ }
  let sessions = [];
  try {
    sessions = require('./sessionService').sessionService.list().map((s) => ({
      id: s.id, title: s.title, kind: s.kind ?? 'single', turns: s.turnCount,
      updatedAt: s.updatedAt, pinned: s.pinned, muted: s.muted,
    }));
  } catch { /* optional */ }

  write('manifest.json', {
    product: 'Quansiox',
    version: appVersion(),
    createdAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    installId,
    note: 'Local-only support bundle. Settings and credential-shaped fields are scrubbed; transcripts are excluded.',
  });
  // The reliability log (W7.7): the spans and the classified failures.
  // It is the part of the bundle that actually explains what went wrong.
  let reliability = null;
  try {
    const telemetry = require('../../shared/telemetry.js');
    reliability = {
      summary: telemetry.summary(),
      spans: telemetry.recentSpans({ limit: 200 }),
      reports: telemetry.recentReports({ limit: 200 }),
    };
  } catch { /* optional */ }

  write('settings.json', scrub(settings));
  write('diagnostics.json', scrub(diagnostics));
  if (reliability) write('reliability.json', scrub(reliability));
  write('notices.json', scrub(notices));
  write('sessions.json', sessions);
  write('flags.json', scrub(flags));
  write('README.txt', [
    'Quansiox support bundle',
    '======================',
    '',
    'Included: app/host manifest, redacted settings, diagnostics events, open notices,',
    'feature flags, and session summaries (ids/titles/counts only).',
    '',
    'Excluded: conversation transcripts, attachments, secrets, browser cookies,',
    'and workspace file contents. Credential-shaped keys/values are replaced with "…".',
    '',
    `Created: ${new Date().toISOString()}`,
  ].join('\n'));

  const zip = path.join(root, `quansiox-support-${stamp}.zip`);
  const zipped = spawnSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', stage, zip], { encoding: 'utf8' });
  if (zipped.status !== 0) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error(`could not create the support zip: ${String(zipped.stderr ?? '').trim() || `ditto exited ${zipped.status}`}`);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  const bytes = fs.statSync(zip).size;
  return { path: zip, bytes, files, createdAt: Date.now() };
}

module.exports = { supportBundleService: { create, scrub } };
