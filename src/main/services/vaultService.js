'use strict';
/**
 * Vault service — real local credential vault (Grok Bot Vault parity, local-first).
 *
 *  - Credentials: title/username/notes/sites metadata in a 0600 JSON index;
 *    passwords/secrets encrypted via secretsService (AES-GCM vault file).
 *  - Cards: card metadata (label/brand/last4/expiry/holder/billing) only —
 *    no PAN is ever persisted locally.
 *  - Credential requests: pending registry with approve/deny resolution that
 *    releases the requested secret to the waiting caller (agent/browser fill).
 *  - Service-account mints: local tokens minted for box/bot use, tracked so
 *    `detectCredentialMint` can report them.
 *  - Provider connections: OAuth (PKCE) against user-configured providers with
 *    token secrets + connection bookkeeping.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { secretsService } = require('./secretsService');
const { settingsService } = require('./settingsService');
const { oauthClient } = require('./oauthClient');

const CARD_RESOLUTIONS = new Set(['approved', 'denied', 'failed', 'expired']);

function userDataDir() {
  return require('./userData').userDataDir();
}
function vaultDir() { return path.join(userDataDir(), 'vault'); }
function indexPath() { return path.join(vaultDir(), 'index.json'); }
function providersFile() { return path.join(vaultDir(), 'provider-connections.json'); }
function oauthPendingFile() { return path.join(vaultDir(), 'provider-oauth-pending.json'); }

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(indexPath(), 'utf8')); } catch { return { credentials: [], cards: [], mints: [] }; }
}
function saveIndex(index) {
  fs.mkdirSync(vaultDir(), { recursive: true });
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2), { mode: 0o600 });
}
function newId(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('base64url')}`; }
const secretNameFor = (id) => `vault_cred_${id}`;

// ---------------- credentials ----------------
function redactCredential(rec) { const { secretName, ...rest } = rec; void secretName; return rest; }

function getCredentialsState() {
  const index = loadIndex();
  const providers = loadConnections();
  return {
    credentials: index.credentials.map(redactCredential),
    cards: index.cards,
    mints: index.mints.map(({ secretName, ...m }) => m),
    providers: providers.connections.map(({ secretName, ...c }) => ({ ...c, connected: Boolean(secretsService.get(secretName)) })),
    pendingRequests: [...pending.values()].filter((p) => !p.settled).map((p) => publicRequest(p)),
  };
}

function putGrokBotVaultCredential({ id, title, username, notes, sites, password } = {}) {
  if (!title && !id) throw new Error('title is required for a new credential');
  const index = loadIndex();
  const existing = id ? index.credentials.find((c) => c.id === id) : null;
  const rec = existing ?? { id: id || newId('cred'), createdAt: Date.now(), secretName: null };
  rec.secretName = rec.secretName || secretNameFor(rec.id);
  rec.title = String(title ?? rec.title ?? 'Credential').slice(0, 160);
  rec.username = String(username ?? rec.username ?? '');
  rec.notes = String(notes ?? rec.notes ?? '').slice(0, 2000);
  rec.sites = Array.isArray(sites) ? sites.map(String).slice(0, 20) : (rec.sites ?? []);
  rec.updatedAt = Date.now();
  if (password) secretsService.set(rec.secretName, { password: String(password) }, `Vault credential: ${rec.title}`);
  if (!existing) index.credentials.push(rec);
  saveIndex(index);
  return { ...redactCredential(rec), hasPassword: Boolean(password) || Boolean(secretsService.get(rec.secretName)) };
}

/**
 * Internal (unredacted) credential lookup for the browser fill flow. The
 * secretName never leaves the main process; callers get values only through
 * secretsService at the point of filling the page.
 */
function internalCredentialById(id) {
  if (!id) return null;
  return loadIndex().credentials.find((c) => c.id === id) ?? null;
}

/** Find the vault credential that matches a page origin (host suffix match). */
function credentialForOrigin(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  const creds = loadIndex().credentials;
  const matches = (site) => {
    const s = String(site ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!s) return false;
    return host === s || host.endsWith(`.${s}`);
  };
  return creds.find((c) => (c.sites ?? []).some(matches)) ?? null;
}

function deleteGrokBotVaultCredential({ id } = {}) {
  const index = loadIndex();
  const rec = index.credentials.find((c) => c.id === id);
  if (!rec) return { deleted: false, id };
  index.credentials = index.credentials.filter((c) => c.id !== id);
  saveIndex(index);
  try { secretsService.remove(rec.secretName); } catch {}
  return { deleted: true, id };
}

// ---------------- cards (metadata only, never a PAN) ----------------
function createGrokBotVaultCard({ values = {} } = {}) {
  const index = loadIndex();
  const card = {
    id: newId('card'),
    label: String(values.label ?? values.name ?? 'Card').slice(0, 80),
    brand: String(values.brand ?? '').slice(0, 40),
    last4: String(values.last4 ?? '').slice(-4),
    expiry: String(values.expiry ?? values.exp ?? '').slice(0, 10),
    holderName: String(values.holderName ?? '').slice(0, 120),
    billingAddress: values.billingAddress ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  index.cards.push(card);
  saveIndex(index);
  return card;
}

function updateGrokBotVaultCard({ id, holderName, expiry, billingAddress, label, brand, last4 } = {}) {
  const index = loadIndex();
  const card = index.cards.find((c) => c.id === id);
  if (!card) throw new Error(`unknown card: ${id}`);
  if (holderName !== undefined) card.holderName = String(holderName).slice(0, 120);
  if (expiry !== undefined) card.expiry = String(expiry).slice(0, 10);
  if (billingAddress !== undefined) card.billingAddress = billingAddress;
  if (label !== undefined) card.label = String(label).slice(0, 80);
  if (brand !== undefined) card.brand = String(brand).slice(0, 40);
  if (last4 !== undefined) card.last4 = String(last4).slice(-4);
  card.updatedAt = Date.now();
  saveIndex(index);
  return card;
}

// ---------------- biometric gate (Touch ID / passcode) ----------------
/**
 * Releasing a secret is gated behind a biometric prompt.
 *
 * The prompt lives in a separate, Apple-signed helper
 * (`native/QuansioxVaultApprover.swift`) so the approval is a real macOS
 * LocalAuthentication dialog with our own reason string — the secret itself
 * never reaches the helper.
 *
 * The gate is injectable so the flow can be tested without a Mac that has
 * Touch ID, and so a user can turn it off explicitly.
 */
let biometricGate = null;          // null = use the default helper
let biometricGateEnabled = true;

function approverBinary() {
  const candidates = [
    process.env.QUANSIOX_VAULT_APPROVER,
    path.join(__dirname, '..', '..', '..', 'build', 'QuansioxVaultApprover'),
    path.join(__dirname, '..', '..', '..', 'native', 'QuansioxVaultApprover'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The default gate: run the approver helper.
 *
 * The helper's exit codes carry the meaning:
 *   0 approved · 1 declined · 2 no hardware/passcode · 3 no console
 *   session · 4 shown but never answered.
 *
 * Only a real decline (1) or a timeout (4) blocks the release; "this machine
 * cannot prompt" falls back to the in-app approval, which already happened.
 */
function defaultBiometricGate(reason) {
  const bin = approverBinary();
  if (!bin) return Promise.resolve({ approved: true, skipped: 'no approver available' });
  // Without a GUI context there is nobody to answer the prompt, so do not
  // spawn it at all (this is the case in unit tests and headless runs).
  if (!process.versions.electron) {
    return Promise.resolve({ approved: true, skipped: 'no gui session' });
  }
  return new Promise((resolve) => {
    require('node:child_process').execFile(bin, ['--timeout', '45', reason], { timeout: 60_000 }, (error, _stdout, stderr) => {
      if (!error) { resolve({ approved: true }); return; }
      const code = error.code;
      if (code === 2) { resolve({ approved: true, skipped: 'no biometric hardware' }); return; }
      if (code === 3) { resolve({ approved: true, skipped: 'no interactive session' }); return; }
      resolve({ approved: false, reason: String(stderr || error.message || 'declined').trim() });
    });
  });
}

/** Replace the gate (tests). */
function setBiometricGate(fn) { biometricGate = typeof fn === 'function' ? fn : null; }
/** Turn the gate on/off (user preference). */
function setBiometricGateEnabled(on) { biometricGateEnabled = Boolean(on); }
function biometricGateState() { return { enabled: biometricGateEnabled, available: Boolean(approverBinary()) }; }

/** Ask for the user's biometric approval. */
async function requestBiometricApproval(reason) {
  if (!biometricGateEnabled) return { approved: true, skipped: 'disabled' };
  const gate = biometricGate ?? defaultBiometricGate;
  try {
    const result = await gate(reason);
    return result ?? { approved: false, reason: 'no decision' };
  } catch (error) {
    return { approved: false, reason: String(error?.message ?? error) };
  }
}

// ---------------- credential requests (agent asks → user approves/denies) ---
const pending = new Map(); // requestId -> entry

function publicRequest(e) {
  return { requestId: e.requestId, kind: e.kind, entryId: e.entryId, agentId: e.agentId, targetSite: e.targetSite ?? null, credentialId: e.credentialId ?? null, settled: e.settled?.resolution ?? null, createdAt: e.createdAt };
}
function emit(ns, method, payload) {
  try { require('../ipc/emitEvent').emitEvent(ns, method, payload); } catch {}
}
function settleRequest(entry, resolution, detail = {}) {
  if (entry.settled) return { ...entry.settled, already: true };
  entry.settled = { resolution, at: Date.now(), ...detail };
  for (const resolve of entry.waiters.splice(0)) resolve(entry.settled);
  emit('credentialRequest', 'settled', publicRequest(entry));
  return entry.settled;
}

/** Open a pending credential/card request (Quansiox extension for the renderer). */
function requestCredential({ requestId, kind = 'credential', entryId, agentId, targetSite, credentialId } = {}) {
  const id = String(requestId || newId('creq'));
  if (pending.has(id)) return publicRequest(pending.get(id));
  const entry = { requestId: id, kind, entryId: entryId ?? null, agentId: agentId ?? null, targetSite: targetSite ?? null, credentialId: credentialId ?? null, createdAt: Date.now(), settled: null, waiters: [] };
  pending.set(id, entry);
  emit('credentialRequest', 'requested', publicRequest(entry));
  return publicRequest(entry);
}

/** Wait for a decision (null on timeout). */
function awaitRequest({ requestId, waitMs = 120_000 } = {}) {
  const entry = pending.get(String(requestId || ''));
  if (!entry) return Promise.resolve(null);
  if (entry.settled) return Promise.resolve(entry.settled);
  const wait = Math.max(0, Number(waitMs) || 120_000);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(null), wait); timer.unref?.();
    entry.waiters.push(finish);
  });
}

async function approveCredentialRequest({ entryId, agentId, credentialId, targetSite } = {}) {
  const entry = [...pending.values()].find((e) => !e.settled && e.kind === 'credential'
    && (!entryId || e.entryId === entryId) && (!agentId || !e.agentId || e.agentId === agentId));
  if (!entry) return { approved: false, reason: 'no matching pending credential request' };
  const id = credentialId ?? entry.credentialId;
  let fields = null;
  let title = null;
  if (id) {
    const index = loadIndex();
    const rec = index.credentials.find((c) => c.id === id);
    if (rec) {
      title = rec.title;
      fields = secretsService.get(rec.secretName)?.fields ?? null;
    }
  }

  // A secret is only released after a biometric approval. Metadata-only
  // approvals (no secret to hand over) do not need the prompt.
  let biometric = null;
  if (fields) {
    const reason = `release the credential "${title ?? id}"${entry.targetSite ? ` for ${entry.targetSite}` : ''}`;
    biometric = await requestBiometricApproval(reason);
    if (!biometric.approved) {
      settleRequest(entry, 'denied', { reason: biometric.reason || 'biometric approval declined' });
      return { approved: false, reason: biometric.reason || 'biometric approval declined', requestId: entry.requestId };
    }
  }

  const resolution = settleRequest(entry, 'approved', { credentialId: id ?? null, targetSite: targetSite ?? entry.targetSite ?? null, hasFields: Boolean(fields) });
  return { approved: true, requestId: entry.requestId, credentialId: id ?? null, fields, biometric: biometric?.skipped ?? null, ...resolution };
}

function denyCredentialRequest({ entryId, agentId } = {}) {
  const entry = [...pending.values()].find((e) => !e.settled && e.kind === 'credential'
    && (!entryId || e.entryId === entryId) && (!agentId || !e.agentId || e.agentId === agentId));
  if (!entry) return { denied: false, reason: 'no matching pending credential request' };
  settleRequest(entry, 'denied');
  return { denied: true, requestId: entry.requestId };
}

function resolveVirtualCardApproval({ entryId, requestId, resolution, agentId, spendRequestId, failureReason, paymentMethod } = {}) {
  if (!CARD_RESOLUTIONS.has(resolution)) throw new Error('resolution must be approved|denied|failed|expired');
  let entry = pending.get(String(requestId || ''));
  if (!entry) entry = [...pending.values()].find((e) => !e.settled && e.kind === 'card' && entryId && e.entryId === entryId);
  if (!entry) {
    return { resolved: false, reason: 'no matching pending virtual-card approval', entryId: entryId ?? null, requestId: requestId ?? null };
  }
  const detail = { spendRequestId: spendRequestId ?? null, failureReason: failureReason ?? null, paymentMethod: paymentMethod ?? null, agentId: agentId ?? entry.agentId };
  settleRequest(entry, resolution, detail);
  return { resolved: true, requestId: entry.requestId, entryId: entry.entryId, resolution };
}

/**
 * Open a spend approval (Grok desktop `approvals.beginSpendApproval`,
 * args {entryId, agentId, requestId, paymentMethodId?} → record). Locally a
 * spend approval is a pending virtual-card request the UI resolves through
 * resolveVirtualCardApproval; an already-settled one reports its resolution.
 */
function beginSpendApproval({ entryId, agentId, requestId, paymentMethodId } = {}) {
  const id = String(requestId || '') || newId('spend');
  const existing = pending.get(id);
  if (existing?.settled) {
    const { resolution, at, ...detail } = existing.settled;
    return { state: resolution, requestId: id, entryId: existing.entryId ?? entryId ?? null, agentId: detail.agentId ?? agentId ?? null, resolvedAt: at, ...detail };
  }
  if (existing) return { state: 'open', requestId: id, entryId: existing.entryId ?? entryId ?? null, agentId: existing.agentId ?? agentId ?? null };
  requestCredential({ requestId: id, kind: 'card', entryId, agentId, credentialId: null });
  const entry = pending.get(id);
  if (entry && paymentMethodId != null) entry.paymentMethodId = String(paymentMethodId);
  return { state: 'open', requestId: id, entryId: entryId ?? null, agentId: agentId ?? null, paymentMethodId: paymentMethodId ?? null };
}

/**
 * List linked payment methods (Grok `approvals.listVirtualCardPaymentMethods`
 * → record). Quansiox replaces the cloud wallet: no methods are linked yet,
 * so the honest local view is an empty roster with nothing pending.
 */
function listVirtualCardPaymentMethods() {
  return { paymentMethods: [], unavailableCount: 0, needsAuth: false, lifecycle: 'local' };
}

// ---------------- service-account mints ----------------
function startCredentialMint(payload = {}) {
  const index = loadIndex();
  const id = newId('mint');
  const secretName = secretNameFor(id);
  if (payload.serviceAccountToken) {
    secretsService.set(secretName, { token: String(payload.serviceAccountToken) }, `Imported service-account token (${id})`);
  } else if (payload.accountUuid || payload.vaultName) {
    secretsService.set(secretName, { token: crypto.randomBytes(32).toString('hex') }, `Local service-account token (${id})`);
  } else {
    throw new Error('mint requires serviceAccountToken or accountUuid/vaultName');
  }
  const rec = {
    id,
    kind: payload.serviceAccountToken ? 'imported' : 'local',
    accountUuid: payload.accountUuid ?? null,
    vaultName: payload.vaultName ?? null,
    accountUrl: payload.accountUrl ?? null,
    accountEmail: payload.accountEmail ?? null,
    connectionId: payload.connectionId ?? null,
    secretName,
    local: !payload.serviceAccountToken,
    createdAt: Date.now(),
  };
  index.mints.push(rec);
  saveIndex(index);
  const secret = secretsService.get(secretName);
  return { minted: true, id, kind: rec.kind, local: rec.local, accountUuid: rec.accountUuid, vaultName: rec.vaultName, token: secret?.fields?.token ?? null };
}

function detectCredentialMint() {
  const index = loadIndex();
  const mints = index.mints.map(({ secretName, ...m }) => ({ ...m, hasToken: Boolean(secretsService.get(secretName)?.fields?.token) }));
  return { detected: mints.length, mints };
}

// ---------------- provider connections (PKCE OAuth) ----------------
function loadConnections() {
  try { return JSON.parse(fs.readFileSync(providersFile(), 'utf8')); } catch { return { connections: [] }; }
}
function saveConnections(data) {
  fs.mkdirSync(vaultDir(), { recursive: true });
  fs.writeFileSync(providersFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
}
function providerConfig(id) {
  return (settingsService.load().credentialProviders ?? []).find((p) => p.id === id) ?? null;
}

function connectCredentialProviderOAuth({ connectionId } = {}) {
  const providers = settingsService.load().credentialProviders ?? [];
  const provider = providers.find((p) => !connectionId || p.id === connectionId);
  if (!provider) return { ok: false, reason: providers.length ? `unknown provider: ${connectionId}` : 'no credential providers configured' };
  if (!provider.authorizationEndpoint || !provider.tokenEndpoint || !provider.clientId) return { ok: false, reason: `provider ${provider.id} is missing OAuth endpoints` };
  const { verifier, challenge } = oauthClient.pkce();
  const state = crypto.randomBytes(16).toString('base64url');
  oauthClient.putPending(oauthPendingFile(), state, {
    providerId: provider.id,
    tokenEndpoint: provider.tokenEndpoint,
    clientId: provider.clientId,
    redirectUri: provider.redirectUri ?? 'quansiox://oauth/credential-provider',
    codeVerifier: verifier,
  });
  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', provider.redirectUri ?? 'quansiox://oauth/credential-provider');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (provider.scopes) url.searchParams.set('scope', Array.isArray(provider.scopes) ? provider.scopes.join(' ') : String(provider.scopes));
  let opened = false;
  try { require('electron').shell.openExternal(url.href); opened = true; } catch {}
  return { ok: true, providerId: provider.id, state, authorizationUrl: url.href, opened };
}

function completeCredentialProviderOAuth({ code, state } = {}) {
  const taken = oauthClient.takePending(oauthPendingFile(), String(state ?? ''));
  if (!taken.ok) return { ok: false, reason: taken.reason };
  const { entry } = taken;
  return oauthClient.exchangeCode({ tokenEndpoint: entry.tokenEndpoint, clientId: entry.clientId, redirectUri: entry.redirectUri, code, codeVerifier: entry.codeVerifier })
    .then((result) => {
      if (!result.ok) return { ok: false, reason: result.reason, providerId: entry.providerId };
      const connections = loadConnections();
      const secretName = `credvault_${entry.providerId.replace(/[^A-Za-z0-9_-]/g, '_')}_oauth`;
      secretsService.set(secretName, {
        access_token: result.tokens.access_token,
        ...(result.tokens.refresh_token ? { refresh_token: result.tokens.refresh_token } : {}),
        ...(result.tokens.expires_in ? { expires_at: String(Date.now() + Number(result.tokens.expires_in) * 1000) } : {}),
      }, `Credential provider OAuth: ${entry.providerId}`);
      const conn = connections.connections.find((c) => c.providerId === entry.providerId) ?? { providerId: entry.providerId, createdAt: Date.now() };
      conn.secretName = secretName;
      conn.lastSyncedAt = null;
      if (!connections.connections.includes(conn)) connections.connections.push(conn);
      saveConnections(connections);
      return { ok: true, providerId: entry.providerId, secretName, hasRefreshToken: Boolean(result.tokens.refresh_token) };
    });
}

function cancelCredentialProviderOAuth() {
  const all = oauthClient.readPending(oauthPendingFile());
  const count = Object.keys(all).length;
  oauthClient.writePending(oauthPendingFile(), {});
  return { cancelled: count > 0, pending: count };
}

function disconnectCredentialProvider({ connectionId } = {}) {
  const connections = loadConnections();
  const conn = connections.connections.find((c) => c.providerId === connectionId || c.id === connectionId);
  if (!conn) return { disconnected: false, connectionId: connectionId ?? null };
  connections.connections = connections.connections.filter((c) => c !== conn);
  saveConnections(connections);
  try { secretsService.remove(conn.secretName); } catch {}
  return { disconnected: true, connectionId: conn.providerId };
}

function syncCredentialProvider() {
  const connections = loadConnections();
  const index = loadIndex();
  const out = connections.connections.map((c) => {
    const connected = Boolean(secretsService.get(c.secretName));
    if (connected) c.lastSyncedAt = Date.now();
    return { providerId: c.providerId, connected, lastSyncedAt: c.lastSyncedAt ?? null };
  });
  saveConnections(connections);
  return { connections: out, vault: { credentials: index.credentials.length, cards: index.cards.length, mints: index.mints.length } };
}

function list() { return getCredentialsState(); }

module.exports = {
  vaultService: {
    getCredentialsState, list, putGrokBotVaultCredential, deleteGrokBotVaultCredential,
    internalCredentialById, credentialForOrigin,
    createGrokBotVaultCard, updateGrokBotVaultCard,
    requestCredential, awaitRequest, approveCredentialRequest, denyCredentialRequest, resolveVirtualCardApproval,
    beginSpendApproval, listVirtualCardPaymentMethods,
    setBiometricGate, setBiometricGateEnabled, biometricGateState, requestBiometricApproval,
    startCredentialMint, detectCredentialMint,
    connectCredentialProviderOAuth, completeCredentialProviderOAuth, cancelCredentialProviderOAuth, disconnectCredentialProvider, syncCredentialProvider,
  },
};
