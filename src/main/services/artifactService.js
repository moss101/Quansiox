'use strict';
/**
 * Artifacts — interactive documents the agent builds and the user explores.
 *
 * An artifact is a self-contained HTML document: a chart, a calculator, a
 * small tool, a report. It is stored locally, opened in its own sandboxed
 * window, and it is deliberately *cut off from everything else*:
 *
 *  - a dedicated `qx-artifact://` protocol serves it, so the document never
 *    touches the app's origin, cookies or storage;
 *  - the window has no preload — the artifact gets no `window.quansiox` API,
 *    so it cannot drive the agent, read files or open dialogs;
 *  - the response carries a CSP with `connect-src 'none'`, so the artifact
 *    cannot phone home. It is a local-first app and its artifacts stay local;
 *  - the window is sandboxed (`sandbox: true`, `contextIsolation: true`,
 *    `nodeIntegration: false`) and lives in its own session partition.
 *
 * Artifacts are plain files on disk, so the user can open them anywhere.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_HTML_BYTES = 4 * 1024 * 1024;   // 4 MB
const MAX_ARTIFACTS = 200;

function userDataDir() {
  return require('./userData').userDataDir();
}
function artifactsDir() { return path.join(userDataDir(), 'artifacts'); }
function indexPath() { return path.join(artifactsDir(), 'index.json'); }

const KINDS = new Set(['html', 'chart', 'form', 'report', 'game', 'diagram', 'code']);

function loadIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveIndex(entries) {
  fs.mkdirSync(artifactsDir(), { recursive: true });
  fs.writeFileSync(indexPath(), JSON.stringify(entries, null, 2), { mode: 0o700 });
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Strip the handful of things that would let a document break out of its
 * sandbox or talk to the app. The CSP does the heavy lifting; this is
 * belt-and-braces for the file on disk (the user may open it elsewhere).
 */
function sanitize(html) {
  let out = String(html ?? '');
  // <base> would change how relative URLs resolve.
  out = out.replace(/<base\b[^>]*>/gi, '');
  // Inline event handlers are allowed (artifacts are interactive), but a
  // javascript: URL in an href/src is not.
  out = out.replace(/\s(href|src|action|formaction)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, ' $1="#"');
  return out;
}

function ensureShell(html) {
  const body = String(html ?? '');
  if (/<html[\s>]/i.test(body)) return body;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifact</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: rgba(127,127,127,.12); padding: 12px; border-radius: 8px; overflow: auto; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function artifactPath(id) { return path.join(artifactsDir(), id, 'index.html'); }

/**
 * Save (or update) an artifact.
 *
 * @param {object} input
 * @param {string} [input.id]     update this artifact instead of creating one
 * @param {string} input.title
 * @param {string} input.html
 * @param {string} [input.kind]
 */
/**
 * Save an artifact.
 *
 * The store is CONTENT-ADDRESSED, the way the reference implementation's
 * box store is: every artifact carries a `sha256` of its document and an
 * `etag`, and a write may declare the `ifMatch` etag it read. A write whose
 * etag has moved on is REFUSED with a conflict rather than silently
 * clobbering somebody else's edit.
 *
 * @param {object} opts
 * @param {string} [opts.id]
 * @param {string} [opts.title]
 * @param {string} opts.html
 * @param {string} [opts.kind]
 * @param {string} [opts.sessionId]
 * @param {string} [opts.ifMatch]  the etag the writer read
 */
function save({ id, title, html, kind = 'html', sessionId = null, ifMatch = null } = {}) {
  const body = String(html ?? '');
  if (!body.trim()) throw new Error('the artifact has no content');
  if (Buffer.byteLength(body, 'utf8') > MAX_HTML_BYTES) {
    throw new Error(`the artifact is too large (max ${Math.round(MAX_HTML_BYTES / 1024)} KB)`);
  }
  if (kind && !KINDS.has(String(kind))) throw new Error(`unknown artifact kind: ${kind}`);

  const entries = loadIndex();
  // The caller's id is honoured when it is a valid one. Previously only an
  // EXISTING artifact's id was used, so `save({ id })` silently created a
  // new artifact every time — which made the store impossible to update,
  // and made the conditional write meaningless.
  const requestedId = id != null && ID_RE.test(String(id)) ? String(id) : null;
  const existing = requestedId ? entries.find((e) => e.id === requestedId) : null;
  if (!existing && entries.length >= MAX_ARTIFACTS) {
    throw new Error(`too many artifacts (${MAX_ARTIFACTS}) — delete one first`);
  }
  const artifactId = existing?.id ?? requestedId ?? `art_${crypto.randomBytes(8).toString('base64url')}`;
  if (!ID_RE.test(artifactId)) throw new Error('invalid artifact id');

  // A conditional write: if the caller declares the etag it read, and the
  // artifact has moved on, the write is refused. Two agents editing the same
  // artifact must not silently lose one of the edits.
  if (ifMatch && existing && existing.etag && existing.etag !== String(ifMatch)) {
    const conflict = new Error(`the artifact changed since you read it (etag ${existing.etag})`);
    conflict.code = 'ARTIFACT_CONFLICT';
    conflict.currentEtag = existing.etag;
    conflict.yourEtag = String(ifMatch);
    throw conflict;
  }

  const dir = path.join(artifactsDir(), artifactId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const document = ensureShell(sanitize(body));
  const sha256 = crypto.createHash('sha256').update(document, 'utf8').digest('hex');
  fs.writeFileSync(artifactPath(artifactId), document, { mode: 0o600 });

  const record = {
    id: artifactId,
    title: String(title || existing?.title || 'Artifact').slice(0, 160),
    kind: String(kind || 'html'),
    sessionId: sessionId ?? existing?.sessionId ?? null,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    bytes: Buffer.byteLength(document, 'utf8'),
    // The content address and the version tag.
    sha256,
    etag: `"${sha256.slice(0, 16)}"`,
    contentAddressed: true,
  };
  const next = existing ? entries.map((e) => (e.id === artifactId ? record : e)) : [...entries, record];
  saveIndex(next);
  return record;
}

/**
 * Find an artifact by its content address.
 *
 * Two artifacts with the same content share an address, so a caller can ask
 * "do I already have this?" without keeping a second copy.
 */
function byContent(sha256) {
  const wanted = String(sha256 ?? '').toLowerCase();
  if (!wanted) return null;
  return loadIndex().find((e) => (e.sha256 ?? '').toLowerCase() === wanted) ?? null;
}

/**
 * Rename an artifact (the title only — the document is untouched).
 */
function rename(id, title) {
  const entries = loadIndex();
  const record = entries.find((e) => e.id === id);
  if (!record) throw new Error(`unknown artifact: ${id}`);
  const name = String(title ?? '').trim().slice(0, 160);
  if (!name) throw new Error('a title is required');
  record.title = name;
  record.updatedAt = Date.now();
  saveIndex(entries);
  return { ...record };
}

/** The artifacts, newest first. */
function list({ sessionId } = {}) {
  const entries = loadIndex();
  const filtered = sessionId ? entries.filter((e) => e.sessionId === sessionId) : entries;
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
}

function get(id) {
  return loadIndex().find((e) => e.id === id) ?? null;
}

/** The HTML of an artifact. */
function read(id) {
  const record = get(id);
  if (!record) return null;
  try { return fs.readFileSync(artifactPath(id), 'utf8'); } catch { return null; }
}

function remove(id) {
  const entries = loadIndex();
  const record = entries.find((e) => e.id === id);
  if (!record) return { removed: false, id };
  saveIndex(entries.filter((e) => e.id !== id));
  try { fs.rmSync(path.join(artifactsDir(), id), { recursive: true, force: true }); } catch { /* best effort */ }
  return { removed: true, id };
}

/** The URL an artifact window loads. */
function urlFor(id) {
  return `qx-artifact://${id}/index.html`;
}

/**
 * Open an artifact in its own window.
 *
 * The window deliberately has no preload: the artifact has no way to call
 * back into the app.
 */
function open(id, { width = 1000, height = 720 } = {}) {
  const record = get(id);
  if (!record) throw new Error(`unknown artifact: ${id}`);
  const { windowManager } = require('../windowManager');
  const win = windowManager.createArtifactWindow({
    url: urlFor(id),
    title: record.title,
    width,
    height,
  });
  return { id, title: record.title, opened: true, windowId: win?.id ?? null };
}

/**
 * The CSP every artifact is served with.
 *
 * `connect-src 'none'` is the important line: the document cannot fetch,
 * XHR, WebSocket or send beacons. It is a local artifact.
 */
function contentSecurityPolicy() {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
    "style-src 'unsafe-inline' data:",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * Serve the artifacts over `qx-artifact://<id>/index.html`.
 *
 * The response carries the strict CSP (no network) and is served only from
 * the artifacts directory — never from anywhere else on the disk.
 */
function installArtifactProtocol() {
  const { protocol } = require('electron');
  if (protocol.__qxArtifactInstalled) return;
  protocol.handle('qx-artifact', async (request) => {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split('/').filter(Boolean);
      const id = url.hostname || segments[0] || '';
      if (!ID_RE.test(id)) return new Response('not found', { status: 404 });
      const record = get(id);
      if (!record) return new Response('not found', { status: 404 });
      const html = read(id);
      if (html === null) return new Response('not found', { status: 404 });
      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': contentSecurityPolicy(),
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('bad request', { status: 400 });
    }
  });
  protocol.__qxArtifactInstalled = true;
}

module.exports = {
  artifactService: {
    installArtifactProtocol,
    save, rename, list, get, read, remove, open, urlFor, sanitize, ensureShell, byContent,
    contentSecurityPolicy, artifactsDir,
  },
};
