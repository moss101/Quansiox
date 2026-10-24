'use strict';
/**
 * Webhook server — a loopback HTTP server that turns authenticated webhook
 * calls into local actions (Grok's automation webhooks, local-first). Only
 * listens on 127.0.0.1; each route is `/hook/<id>/<token>`. The handler is
 * injected, so it's unit-tested without the real automation runtime. The
 * reply status is decided by the injected `dispatch(id, token)` result using a
 * uniform "rejection-as-error" convention: a thrown error with `.status`
 * (403/404) is used, else 202.
 */
let server = null;
let port = null;

function start(dispatch) {
  if (server) return { url: baseUrl(), port };
  server = require('node:http').createServer(async (req, res) => {
    const json = (code, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    };
    if (req.method !== 'POST' && req.method !== 'GET') return json(405, { error: 'method not allowed' });
    const m = /^\/hook\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{64})\/?$/.exec((req.url || '').split('?')[0]);
    if (!m) return json(404, { error: 'not found' });
    const [, id, token] = m;
    try {
      const result = await dispatch(id, token);
      return json(202, { status: 'accepted', id, result });
    } catch (error) {
      const code = error && Number.isInteger(error.status) ? error.status : 500;
      return json(code, { status: code === 202 ? 'accepted' : code === 500 ? 'error' : 'rejected', id, reason: String(error?.message ?? error) });
    }
  });
  server.listen(0, '127.0.0.1', () => { port = server.address().port; });
  return { pending: true };
}

function baseUrl() { return port ? `http://127.0.0.1:${port}` : null; }
function urlFor(id, token) { const b = baseUrl(); return b ? `${b}/hook/${id}/${token}` : null; }
function ensureStarted() { return new Promise((resolve) => { const check = () => (port !== null ? resolve(baseUrl()) : setImmediate(check)); check(); }); }
function stop() { try { server?.close(); } catch {} server = null; port = null; }

module.exports = { webhookServer: { start, baseUrl, urlFor, ensureStarted, stop } };
