'use strict';
/* 1Password integration + the Touch ID gate on the vault.
 *
 *  - the `op` CLI is discovered, and its JSON output is normalised
 *  - a secret is only read AFTER the approver approved it
 *  - a declined approval means the secret is never fetched
 *  - the vault's credential release is gated by the same approver
 *  - a metadata-only approval does not need the prompt
 *  - a 1Password item can be imported into the local vault
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-op-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { onePasswordService } = require('../src/main/services/onePasswordService');
const { vaultService } = require('../src/main/services/vaultService');

/** A fake `op` CLI. */
function fakeOp(responses) {
  const calls = [];
  const runner = async (bin, args) => {
    calls.push(args.join(' '));
    // "item list" and "item get" are different responses
    const key = args[0] === 'item' && args[1] ? `item ${args[1]}` : args[0];
    const reply = responses[key];
    if (reply === undefined) throw new Error(`unexpected op ${key}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'string' ? reply : JSON.stringify(reply);
  };
  return { runner, calls };
}

(async () => {
  // 1. the CLI is discovered (the fake runner stands in for it)
  process.env.QUANSIOX_OP_BIN = '/tmp/fake-op';
  const op = fakeOp({
    '--version': '2.30.0',
    account: [{ id: 'acct_1', email: 'me@example.com', name: 'me' }],
    vault: [{ id: 'v1', name: 'Private', type: 'USER_CREATED' }],
    'item list': [
      { id: 'i1', title: 'GitHub', vault: { name: 'Private' }, category: 'LOGIN', updatedAt: '2026-01-01T00:00:00Z' },
    ],
    'item get': { id: 'i1', title: 'GitHub', fields: { username: { value: 'bob' }, password: { value: 'hunter2' } } },
  });
  onePasswordService._setRunner(op.runner);

  const state = await onePasswordService.status();
  assert.equal(state.available, true);
  assert.equal(state.version, '2.30.0');
  assert.equal(state.signedIn, true);

  // 2. accounts / vaults / items are normalised
  const accounts = await onePasswordService.accounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].email, 'me@example.com');
  const vaults = await onePasswordService.vaults();
  assert.equal(vaults[0].name, 'Private');
  const items = await onePasswordService.items({ vault: 'Private' });
  assert.equal(items[0].title, 'GitHub');
  assert.equal(items[0].vault, 'Private');
  // the listing never carries a secret
  assert.equal(JSON.stringify(items).includes('password'), false);

  // 3. a declined approval means the secret is never fetched
  let approverCalls = 0;
  onePasswordService._setApprover(async () => { approverCalls += 1; return { approved: false, reason: 'declined' }; });
  const denied = await onePasswordService.readSecret({ item: 'i1', field: 'password' });
  assert.equal(denied.approved, false);
  assert.equal(denied.reason, 'declined');
  assert.equal(approverCalls, 1);
  assert.ok(!op.calls.some((c) => c.startsWith('item get')), 'the CLI was never asked for the secret');

  // 4. an approved read does fetch it, and the reason mentions the item
  let seenReason = null;
  onePasswordService._setApprover(async (reason) => { seenReason = reason; return { approved: true }; });
  const read = await onePasswordService.readSecret({ item: 'i1', field: 'password' });
  assert.equal(read.approved, true);
  assert.equal(read.record.fields.password.value, 'hunter2');
  assert.ok(seenReason.includes('i1'), 'the prompt explains what is being released');
  assert.ok(op.calls.some((c) => c.includes('item get i1')));

  // 5. a service account can be minted with an expiry
  const op2 = fakeOp({
    '--version': '2.30.0',
    'service-account': { id: 'sa_1', token: 'tok', expiresAt: '2026-02-01T00:00:00Z' },
  });
  onePasswordService._setRunner(op2.runner);
  const minted = await onePasswordService.mintServiceAccount({ vault: 'Private', name: 'Quansiox', expiresIn: '30d' });
  assert.equal(minted.id, 'sa_1');
  assert.ok(op2.calls.some((c) => c.includes('--expires-in 30d')), 'the expiry is requested');
  assert.ok(op2.calls.some((c) => c.includes('--vault Private')));

  // 6. importing an item into the local vault
  const op3 = fakeOp({
    '--version': '2.30.0',
    'item get': { id: 'i2', title: 'Example', fields: { username: { value: 'bob' }, password: { value: 's3cret' }, url: { value: 'example.com' } } },
  });
  onePasswordService._setRunner(op3.runner);
  onePasswordService._setApprover(async () => ({ approved: true }));
  const imported = await onePasswordService.importIntoVault({ item: 'i2' });
  assert.equal(imported.status, 'ok');
  const creds = vaultService.getCredentialsState().credentials;
  const stored = creds.find((c) => c.id === imported.id);
  assert.ok(stored, 'the credential is in the vault');
  assert.equal(stored.title, 'Example');
  assert.deepEqual(stored.sites, ['example.com']);
  // the password really landed in the encrypted vault (never in the index)
  const secretName = vaultService.internalCredentialById(imported.id).secretName;
  assert.ok(secretName, 'the credential points at an encrypted secret');
  assert.equal(JSON.stringify(creds).includes('s3cret'), false, 'the index holds no secret');

  // 7. the vault's credential release is gated
  const cred = vaultService.putGrokBotVaultCredential({ title: 'Gated', username: 'u', password: 'p', sites: ['gated.example'] });
  vaultService.requestCredential({ requestId: 'req-1', entryId: 'req-1', kind: 'credential', agentId: 'sess-1', credentialId: cred.id, targetSite: 'https://gated.example' });

  // a declined biometric check denies the request and releases nothing
  vaultService.setBiometricGate(async () => ({ approved: false, reason: 'no touch id' }));
  const gated = await vaultService.approveCredentialRequest({ entryId: 'req-1', agentId: 'sess-1' });
  assert.equal(gated.approved, false);
  assert.equal(gated.fields, undefined, 'no secret was released');

  // an approved biometric check releases it
  vaultService.requestCredential({ requestId: 'req-2', entryId: 'req-2', kind: 'credential', agentId: 'sess-1', credentialId: cred.id, targetSite: 'https://gated.example' });
  let gateReason = null;
  vaultService.setBiometricGate(async (reason) => { gateReason = reason; return { approved: true }; });
  const ok = await vaultService.approveCredentialRequest({ entryId: 'req-2', agentId: 'sess-1' });
  assert.equal(ok.approved, true);
  assert.equal(ok.fields.password, 'p');
  assert.ok(gateReason.includes('Gated'), 'the prompt names the credential');

  // 8. the gate can be turned off
  vaultService.setBiometricGateEnabled(false);
  vaultService.requestCredential({ requestId: 'req-3', entryId: 'req-3', kind: 'credential', agentId: 'sess-1', credentialId: cred.id });
  const ungated = await vaultService.approveCredentialRequest({ entryId: 'req-3', agentId: 'sess-1' });
  assert.equal(ungated.approved, true);
  assert.equal(ungated.biometric, 'disabled');
  vaultService.setBiometricGateEnabled(true);

  // 9. a request for a credential without a secret needs no prompt
  const noSecret = vaultService.putGrokBotVaultCredential({ title: 'Metadata only', username: 'u' });
  vaultService.requestCredential({ requestId: 'req-4', entryId: 'req-4', kind: 'credential', agentId: 'sess-1', credentialId: noSecret.id });
  let prompted = false;
  vaultService.setBiometricGate(async () => { prompted = true; return { approved: true }; });
  const meta = await vaultService.approveCredentialRequest({ entryId: 'req-4', agentId: 'sess-1' });
  assert.equal(meta.approved, true);
  assert.equal(prompted, false, 'a metadata-only approval does not prompt');

  onePasswordService._reset();
  vaultService.setBiometricGate(null);
  console.log('onepassword test: ALL OK (discover/list/gate/decline/import/vault gating/prompt reasons)');
})().catch((e) => { console.error(e); process.exit(1); });
