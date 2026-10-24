'use strict';
/* Vault & box secrets — encrypted credential store, cards (metadata only),
 * credential requests (approve/deny releases the secret), virtual-card
 * approval resolution, service-account mints, provider OAuth (PKCE, real
 * token exchange), box-secret carry. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-vault-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { secretsService } = require('../src/main/services/secretsService');
const { settingsService } = require('../src/main/services/settingsService');
const { vaultService } = require('../src/main/services/vaultService');
const { boxSecretService } = require('../src/main/services/boxSecretService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  // 1. box secrets — encrypted values + 0600 index
  const box = await grokCompatService.dispatch('setBoxSecrets', { secrets: { API_KEY: 'sk-box-1', DB_URL: 'postgres://x' } });
  assert.strictEqual(box.set, 2);
  assert.deepStrictEqual(box.names, ['API_KEY', 'DB_URL']);
  assert.strictEqual(secretsService.get('box_API_KEY').fields.value, 'sk-box-1');
  assert.strictEqual(fs.statSync(path.join(tmp, 'box-secrets.json')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(tmp, 'box-secrets.json'), 'utf8').includes('sk-box-1'), 'index holds names only');

  // carry box → bot, then a user secret → bot
  secretsService.set('USER_TOK', { value: 'u-1' }, 'user secret');
  const carried = await grokCompatService.dispatch('carryBoxSecretsToBot', { serverId: 'srv1', names: ['API_KEY'] });
  assert.deepStrictEqual(carried.carried, ['API_KEY']);
  assert.deepStrictEqual(carried.missing, []);
  await grokCompatService.dispatch('carryUserSecretsToGrokBot', { serverId: 'srv1', names: ['USER_TOK'] });
  const botSecrets = await grokCompatService.dispatch('listGrokBotSecrets', { serverId: 'srv1' });
  assert.deepStrictEqual(botSecrets.secrets.map((s) => s.name).sort(), ['API_KEY', 'USER_TOK']);
  assert.strictEqual(secretsService.get('grokbot_srv1_API_KEY').fields.value, 'sk-box-1');

  // 2. credentials — values encrypted, index redacted
  const put = await grokCompatService.dispatch('putGrokBotVaultCredential', {
    title: 'GitHub', username: 'mohsin', sites: ['github.com'], password: 'pw-hunter2', notes: 'work',
  });
  const cred = put.credential;
  assert.strictEqual(cred.hasPassword, true);
  assert.strictEqual(cred.password, undefined, 'never return the password');
  assert.strictEqual(secretsService.get(`vault_cred_${cred.id}`).fields.password, 'pw-hunter2');
  const indexRaw = fs.readFileSync(path.join(tmp, 'vault', 'index.json'), 'utf8');
  assert.ok(!indexRaw.includes('pw-hunter2'), 'index must not contain the password');
  assert.strictEqual(fs.statSync(path.join(tmp, 'vault', 'index.json')).mode & 0o777, 0o600);

  // update then delete
  const updatedCred = await grokCompatService.dispatch('putGrokBotVaultCredential', { id: cred.id, sites: ['github.com', 'gist.github.com'] });
  assert.deepStrictEqual(updatedCred.credential.sites, ['github.com', 'gist.github.com']);
  const state = await grokCompatService.dispatch('getCredentialsState', {});
  assert.strictEqual(state.credentials.length, 1);

  // 3. cards — metadata only
  const card = (await grokCompatService.dispatch('createGrokBotVaultCard', { values: { label: 'Work Visa', brand: 'visa', last4: '4242', expiry: '12/28' } })).card;
  assert.strictEqual(card.last4, '4242');
  const cardUpd = (await grokCompatService.dispatch('updateGrokBotVaultCard', { id: card.id, holderName: 'M S', billingAddress: { city: 'Karachi', country: 'PK' } })).card;
  assert.strictEqual(cardUpd.holderName, 'M S');
  assert.strictEqual(cardUpd.billingAddress.city, 'Karachi');

  // 4. credential requests — approve releases the secret to the waiting caller
  const req = (await grokCompatService.dispatch('requestCredentialApproval', { requestId: 'creq-1', entryId: 'gh', agentId: 'sess-1', targetSite: 'github.com' })).request;
  assert.strictEqual(req.settled, null);
  const waitP = vaultService.awaitRequest({ requestId: 'creq-1', waitMs: 5_000 });
  const approved = await grokCompatService.dispatch('approveCredentialRequest', { entryId: 'gh', agentId: 'sess-1', credentialId: cred.id });
  assert.strictEqual(approved.approved, true);
  assert.deepStrictEqual(approved.fields, { password: 'pw-hunter2' });
  assert.deepStrictEqual((await waitP).resolution, 'approved');
  const noMatch = await grokCompatService.dispatch('approveCredentialRequest', { entryId: 'nope' });
  assert.strictEqual(noMatch.approved, false);

  // deny path
  await grokCompatService.dispatch('requestCredentialApproval', { requestId: 'creq-2', entryId: 'bank', agentId: 'sess-2' });
  const denied = await grokCompatService.dispatch('denyCredentialRequest', { entryId: 'bank', agentId: 'sess-2' });
  assert.strictEqual(denied.denied, true);

  // 5. virtual-card approvals — resolution set + existing request settlement
  await grokCompatService.dispatch('requestCredentialApproval', { requestId: 'vcard-1', kind: 'card', entryId: 'shop', agentId: 'sess-3' });
  const resolved = await grokCompatService.dispatch('resolveVirtualCardApproval', { requestId: 'vcard-1', resolution: 'approved', spendRequestId: 'spend-9', agentId: 'sess-3' });
  assert.strictEqual(resolved.resolved, true);
  const badResolution = await grokCompatService.dispatch('resolveVirtualCardApproval', { requestId: 'vcard-1', resolution: 'maybe' });
  assert.strictEqual(badResolution.status, 'error');
  const nothing = await grokCompatService.dispatch('resolveVirtualCardApproval', { requestId: 'nope', resolution: 'denied' });
  assert.strictEqual(nothing.resolved, false);

  // 6. service-account mints — local tokens + imported tokens, detectable
  const minted = await grokCompatService.dispatch('startCredentialMint', { accountUuid: 'acc-1', vaultName: 'Personal', accountEmail: 'a@b.c' });
  assert.match(minted.token, /^[0-9a-f]{64}$/);
  assert.strictEqual(minted.local, true);
  const imported = await grokCompatService.dispatch('startCredentialMint', { serviceAccountToken: 'sat-xyz' });
  assert.strictEqual(imported.kind, 'imported');
  const detected = await grokCompatService.dispatch('detectCredentialMint', {});
  assert.strictEqual(detected.detected, 2);
  assert.ok(detected.mints.every((m) => m.hasToken));
  assert.ok(!JSON.stringify(detected).includes(minted.token), 'mint detection never leaks tokens');

  // 7. provider OAuth — real PKCE exchange against a local endpoint
  const tokenServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('code') !== 'prov-code' || params.get('grant_type') !== 'authorization_code') { res.writeHead(400); res.end('{"error":"invalid_grant"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'prov-at', refresh_token: 'prov-rt', expires_in: 60 }));
    });
  });
  await new Promise((r) => tokenServer.listen(0, '127.0.0.1', r));
  settingsService.save({
    credentialProviders: [{ id: 'prov1', name: 'Test Provider', authorizationEndpoint: 'https://prov.example/authorize', tokenEndpoint: `http://127.0.0.1:${tokenServer.address().port}/token`, clientId: 'client-1', redirectUri: 'http://127.0.0.1/cb', scopes: ['items:read'] }],
  });
  const begun = await grokCompatService.dispatch('connectCredentialProviderOAuth', { connectionId: 'prov1' });
  assert.strictEqual(begun.ok, true);
  const authUrl = new URL(begun.authorizationUrl);
  assert.strictEqual(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authUrl.searchParams.get('code_challenge'));
  assert.strictEqual(authUrl.searchParams.get('scope'), 'items:read');
  const completed = await grokCompatService.dispatch('completeCredentialProviderOAuth', { code: 'prov-code', state: begun.state });
  assert.strictEqual(completed.ok, true);
  assert.strictEqual(secretsService.get(completed.secretName).fields.access_token, 'prov-at');
  const sync = await grokCompatService.dispatch('syncCredentialProvider', {});
  assert.strictEqual(sync.connections[0].connected, true);
  assert.ok(sync.connections[0].lastSyncedAt > 0);
  const vaultState = await grokCompatService.dispatch('getCredentialsState', {});
  assert.strictEqual(vaultState.providers[0].connected, true);

  // cancel + disconnect
  await grokCompatService.dispatch('connectCredentialProviderOAuth', { connectionId: 'prov1' });
  const cancelled = await grokCompatService.dispatch('cancelCredentialProviderOAuth', {});
  assert.strictEqual(cancelled.cancelled, true);
  const stale = await grokCompatService.dispatch('completeCredentialProviderOAuth', { code: 'x', state: 'gone' });
  assert.strictEqual(stale.ok, false);
  const disc = await grokCompatService.dispatch('disconnectCredentialProvider', { connectionId: 'prov1' });
  assert.strictEqual(disc.disconnected, true);
  assert.strictEqual(secretsService.get(completed.secretName), null, 'tokens removed on disconnect');

  // 8. delete credential removes the encrypted secret too
  const del = await grokCompatService.dispatch('deleteGrokBotVaultCredential', { id: cred.id });
  assert.strictEqual(del.deleted, true);
  assert.strictEqual(secretsService.get(`vault_cred_${cred.id}`), null);

  tokenServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('vault test: ALL OK (box secrets/carry/credentials/cards/requests/mints/provider OAuth)');
})().catch((e) => { console.error(e); process.exit(1); });
