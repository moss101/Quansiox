'use strict';
/**
 * OAuth client helpers — real authorization-code exchange with PKCE, shared by
 * the MCP OAuth flow (completeMcpOAuth) and credential-provider connections.
 * Electron-free; network only at call time.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function userDataDir() {
  return require('./userData').userDataDir();
}

/** PKCE verifier + S256 challenge. */
function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function readPending(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writePending(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Store a pending OAuth flow keyed by `state`. */
function putPending(file, state, entry) {
  const all = readPending(file);
  all[state] = { ...entry, createdAtMs: Date.now() };
  writePending(file, all);
  return all[state];
}

/** Take (and consume) a pending flow; expired entries are dropped. */
function takePending(file, state, ttlMs = 15 * 60 * 1000) {
  const all = readPending(file);
  const entry = all[state];
  if (!entry) return { ok: false, reason: 'no pending OAuth flow for this state' };
  delete all[state];
  writePending(file, all);
  if (entry.createdAtMs && Date.now() - entry.createdAtMs > ttlMs) return { ok: false, reason: 'OAuth flow expired' };
  return { ok: true, entry };
}

/** Exchange an authorization code for tokens at `tokenEndpoint`. */
async function exchangeCode({ tokenEndpoint, clientId, redirectUri, code, codeVerifier, extra }) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(code ?? ''), client_id: String(clientId ?? ''), redirect_uri: String(redirectUri ?? '') });
  if (codeVerifier) body.set('code_verifier', String(codeVerifier));
  for (const [k, v] of Object.entries(extra ?? {})) body.set(k, String(v));
  try {
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      return { ok: false, reason: `token endpoint HTTP ${res.status}${json.error ? ` (${json.error})` : ''}` };
    }
    return { ok: true, tokens: json };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

module.exports = { oauthClient: { pkce, readPending, writePending, putPending, takePending, exchangeCode, userDataDir } };
