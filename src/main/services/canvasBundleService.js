'use strict';
/**
 * Canvas bundles — a canvas as a live JavaScript application.
 *
 * The reference implementation's canvas is not a document. Its page imports
 * two modules as blob URLs — a *runtime* module and a *user* module — and the
 * runtime's `mountCanvas(userUrl)` loads the user module and hands it an API:
 *
 *   window.__cursorCanvas = {
 *     tokenParam: string,
 *     state:      Map<string, unknown>,
 *     data:       Map<string, unknown>,
 *     reportError(error): void,
 *   }
 *
 * Quansiox's canvas was a static HTML artifact in a sandboxed frame: safe,
 * but not programmable, and the agent could not change how it behaved.
 *
 * This module stores the bundle and serves the page in the same shape, with
 * the local product's names (`__quansioxCanvas`). The security model is
 * unchanged and is still strict:
 *
 *   - the page is served from a dedicated custom protocol, so it has NO
 *     access to the app's origin, its storage, or its IPC;
 *   - the CSP allows `blob:` for the module imports and nothing else;
 *   - `connect-src` is empty: a canvas cannot phone home;
 *   - the link guard strips `javascript:` URLs, exactly as the reference does.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MODULE_BYTES = 512 * 1024;

/** Where the bundles live. */
function bundlesDir() {
  const base = process.env.QUANSIOX_USER_DATA_DIR
    ? path.join(process.env.QUANSIOX_USER_DATA_DIR, 'canvas-bundles')
    : path.join(require('./userData').userDataDir(), 'canvas-bundles');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function bundlePath(id) {
  if (!ID_RE.test(String(id ?? ''))) throw new Error('invalid canvas id');
  return path.join(bundlesDir(), `${id}.json`);
}

/**
 * The built-in runtime.
 *
 * It is loaded from the app's own renderer assets so a canvas always has a
 * runtime, even if the user did not ship one. The renderer serves it as a
 * module; here it is inlined as a string so the canvas page can import it
 * from a blob URL with no network and no extra fetch.
 */
function builtInRuntime() {
  const file = path.join(__dirname, '..', '..', 'renderer', 'canvas-runtime.js');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    // The runtime asset is not present in a stripped build; the page then
    // reports the failure rather than rendering a blank canvas.
    return 'export async function mountCanvas(){throw new Error("the canvas runtime is unavailable");}';
  }
}

/**
 * Store a canvas bundle.
 *
 * @param {object} bundle
 * @param {string} [bundle.id]
 * @param {string} bundle.userModule   the user's ES module
 * @param {string} [bundle.runtimeEsm] the runtime module; the built-in one by default
 * @param {object} [bundle.data]       the data the agent passes to the canvas
 * @param {object} [bundle.state]      the canvas's own state
 * @param {string} [bundle.title]
 */
function save(bundle = {}) {
  const id = ID_RE.test(String(bundle.id ?? '')) ? String(bundle.id) : `cnv_${crypto.randomBytes(8).toString('base64url')}`;
  const userModule = String(bundle.userModule ?? '');
  if (!userModule.trim()) throw new Error('a canvas needs a user module');
  if (Buffer.byteLength(userModule, 'utf8') > MAX_MODULE_BYTES) {
    throw new Error(`the canvas module is too large (max ${Math.round(MAX_MODULE_BYTES / 1024)} KB)`);
  }
  const runtimeEsm = String(bundle.runtimeEsm ?? builtInRuntime());
  if (Buffer.byteLength(runtimeEsm, 'utf8') > MAX_MODULE_BYTES) {
    throw new Error(`the canvas runtime is too large (max ${Math.round(MAX_MODULE_BYTES / 1024)} KB)`);
  }
  const record = {
    id,
    kind: 'canvas-bundle',
    title: String(bundle.title ?? 'Canvas').slice(0, 160),
    userModule,
    runtimeEsm,
    data: bundle.data && typeof bundle.data === 'object' ? bundle.data : {},
    state: bundle.state && typeof bundle.state === 'object' ? bundle.state : {},
    createdAt: bundle.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(bundlePath(id), JSON.stringify(record, null, 2), { mode: 0o600 });
  return publicRecord(record);
}

/** Read a bundle's record (the modules and the data). */
function get(id) {
  try {
    return JSON.parse(fs.readFileSync(bundlePath(id), 'utf8'));
  } catch {
    return null;
  }
}

/** The public shape — the modules are large, so list() omits them. */
function publicRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    data: record.data,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    userModuleBytes: Buffer.byteLength(record.userModule ?? '', 'utf8'),
  };
}

function list() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(bundlesDir()).filter((f) => f.endsWith('.json')); } catch { files = []; }
  for (const file of files) {
    const record = get(file.replace(/\.json$/, ''));
    if (record) out.push(publicRecord(record));
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function remove(id) {
  try { fs.rmSync(bundlePath(id), { force: true }); return true; } catch { return false; }
}

/**
 * The CSP for a canvas page.
 *
 * `blob:` is needed for the two module imports and nothing else. There is no
 * `connect-src`, so a canvas cannot reach the network at all.
 */
function contentSecurityPolicy() {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' blob:",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * The link guard: the reference injects one too. A canvas that links out
 * must not be able to navigate the canvas frame somewhere hostile.
 */
const LINK_GUARD = `
(function(){
  function guard(url){
    try {
      var u = new URL(url, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') return null;
      return u.href;
    } catch { return null; }
  }
  document.addEventListener('click', function(event){
    var el = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!el) return;
    var safe = guard(el.getAttribute('href') || '');
    if (!safe) { event.preventDefault(); return; }
    el.setAttribute('rel', 'noopener noreferrer');
  }, true);
})();
`;

/**
 * The canvas page, in the reference's shape.
 */
function page(record) {
  const data = JSON.stringify(record.data ?? {});
  const state = JSON.stringify(record.state ?? {});
  const bundle = JSON.stringify({ runtimeEsm: record.runtimeEsm, userModule: record.userModule });
  const title = String(record.title ?? 'Canvas').replace(/[<>&]/g, '');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, sans-serif; }
  #root { padding: 16px; }
  #status { color: #888; }
</style>
</head>
<body>
<div id="root"><div id="status">Loading canvas…</div></div>
<script>${LINK_GUARD}</script>
<script>
  window.__quansioxCanvasShowError = function () {
    var root = document.getElementById('root');
    if (root) root.innerHTML = '<div id="status">The canvas failed to load.</div>';
  };
  try {
    var dataJson = JSON.parse(${JSON.stringify(data)});
    var stateJson = JSON.parse(${JSON.stringify(state)});
    if (!dataJson || typeof dataJson !== 'object' || Array.isArray(dataJson)) throw new Error('bad data');
    window.__quansioxCanvas = {
      tokenParam: '',
      state: new Map(Object.entries(stateJson)),
      data: new Map(Object.entries(dataJson)),
      reportError: window.__quansioxCanvasShowError,
    };
    window.__quansioxCanvasBundle = ${bundle};
  } catch (e) {
    window.__quansioxCanvasShowError();
  }
</script>
<script type="module">
  async function mount() {
    var bundle = window.__quansioxCanvasBundle;
    if (!bundle) return;
    var runtimeUrl = URL.createObjectURL(new Blob([bundle.runtimeEsm], { type: 'text/javascript' }));
    try {
      var runtimeModule = await import(runtimeUrl);
      var userUrl = URL.createObjectURL(new Blob([bundle.userModule], { type: 'text/javascript' }));
      try { await runtimeModule.mountCanvas(userUrl); }
      finally { URL.revokeObjectURL(userUrl); }
    } finally { URL.revokeObjectURL(runtimeUrl); }
  }
  mount().catch(window.__quansioxCanvasShowError);
</script>
</body>
</html>
`;
}

/**
 * Register the `qx-canvas://` scheme.
 *
 * MUST be called BEFORE the app is ready: `registerSchemesAsPrivileged` is
 * only honoured at that point, and calling it later throws.
 */
function registerCanvasScheme() {
  let protocol;
  try {
    ({ protocol } = require('electron'));
  } catch {
    return false;
  }
  if (!protocol || protocol.__qxCanvasSchemeRegistered) return true;
  try {
    protocol.registerSchemesAsPrivileged([
      { scheme: 'qx-canvas', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    ]);
  } catch {
    // The app is already ready: the scheme was not registered in time, so
    // canvas pages will not be served. That is a degraded feature, not a
    // crash, and the app works without it.
    return false;
  }
  protocol.__qxCanvasSchemeRegistered = true;
  return true;
}

/**
 * Install the handler that serves canvas pages.
 *
 * `qx-canvas://<id>/` serves the page. The protocol is registered as
 * standard+secure, so it gets its own origin: a canvas cannot reach the
 * app's origin, its storage or its IPC.
 */
function installCanvasProtocol() {
  let protocol;
  try {
    ({ protocol } = require('electron'));
  } catch {
    return false;
  }
  if (!protocol || protocol.__qxCanvasInstalled) return true;
  registerCanvasScheme();
  protocol.handle('qx-canvas', async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.hostname || url.pathname.split('/').filter(Boolean)[0] || '';
      if (!ID_RE.test(id)) return new Response('not found', { status: 404 });
      const record = get(id);
      if (!record) return new Response('not found', { status: 404 });
      return new Response(page(record), {
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
  protocol.__qxCanvasInstalled = true;
  return true;
}

/** The URL of a canvas page. */
function urlFor(id) {
  return `qx-canvas://${id}/`;
}

module.exports = {
  canvasBundleService: {
    builtInRuntime, contentSecurityPolicy, get, installCanvasProtocol, list, page,
    registerCanvasScheme, remove, save, urlFor,
  },
};
