'use strict';
/* macOS Messages integration — permission probes (real paths, honest
 * statuses), enable toggle, app icon (injected sips), recipient allowlist,
 * grant request → await → resolve/cancel handshake (injected osascript).
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mac-messages-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { settingsService } = require('../src/main/services/settingsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { macMessagesService } = require('../src/main/services/macMessagesService');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478016360f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');

(async () => {
  settingsService.save({ workspaceRoot: tmp });

  // 0. deterministic osascript + sips via injected runner
  const calls = [];
  macMessagesService._setRunner((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'osascript') return 'Messages';
    if (cmd === 'sips') {
      const out = args[args.indexOf('--out') + 1];
      fs.writeFileSync(out, PNG);
      return '';
    }
    throw new Error(`unexpected command: ${cmd}`);
  });

  // 1. passive permission probe: honest statuses from real system paths
  const perms = await grokCompatService.dispatch('checkMessagesPermissions', {});
  assert.strictEqual(perms.status, 'ok');
  assert.strictEqual(perms.platform, process.platform);
  assert.ok(['granted', 'denied', 'missing'].includes(perms.fullDiskAccess));
  assert.ok(['granted', 'denied', 'missing'].includes(perms.contacts));
  assert.strictEqual(perms.automation, 'unknown', 'never probed → unknown');
  assert.strictEqual(calls.length, 0, 'passive check runs no commands');

  // 2. automation prompt runs osascript once and records the grant
  const prompted = await grokCompatService.dispatch('checkMessagesPermissions', { prompt: 'automation' });
  assert.strictEqual(prompted.automation, 'granted');
  assert.strictEqual(calls.filter((c) => c.cmd === 'osascript').length, 1);
  assert.strictEqual(settingsService.load().messagesAutomationGranted, true);
  assert.strictEqual((await grokCompatService.dispatch('checkMessagesPermissions', {})).automation, 'granted', 'grant sticks');

  // fullDiskAccess/contacts prompts give a System Settings hint, no command
  const fdaHint = await grokCompatService.dispatch('checkMessagesPermissions', { prompt: 'fullDiskAccess' });
  assert.match(fdaHint.hint, /Full Disk Access/);
  const contactsHint = await grokCompatService.dispatch('checkMessagesPermissions', { prompt: 'contacts' });
  assert.match(contactsHint.hint, /Contacts/);

  // 3. enable toggle persists + reports permissions
  assert.strictEqual((await grokCompatService.dispatch('getCurrentMachineMessagesEnabled', {})).messagesEnabled, false);
  const on = await grokCompatService.dispatch('updateCurrentMachineMessagesEnabled', { messagesEnabled: true });
  assert.strictEqual(on.messagesEnabled, true);
  assert.ok(on.permissions.fullDiskAccess);
  assert.strictEqual(settingsService.load().messagesEnabled, true);
  await grokCompatService.dispatch('updateCurrentMachineMessagesEnabled', { messagesEnabled: false });
  assert.strictEqual((await grokCompatService.dispatch('getCurrentMachineMessagesEnabled', {})).messagesEnabled, false);

  // 4. real app icon via sips (injected) → data URL
  const icon = await grokCompatService.dispatch('getMessagesAppIcon', {});
  assert.strictEqual(icon.status, 'ok');
  if (icon.icon) {
    assert.ok(icon.icon.startsWith('data:image/png;base64,'), 'icon data url');
    assert.strictEqual(Buffer.from(icon.icon.split(',')[1], 'base64').length, PNG.length);
  } else {
    assert.ok(icon.reason, 'icon unavailable carries a reason');
  }

  // 5. recipient allowlist
  assert.deepStrictEqual((await grokCompatService.dispatch('listMessagesAllowedRecipients', {})).recipients, []);
  const empty = await grokCompatService.dispatch('revokeMessagesAllowedRecipient', { recipient: '   ' });
  assert.strictEqual(empty.status, 'error');
  macMessagesService.allowRecipients(['+15551234567', 'mom@example.com']);
  const listed = await grokCompatService.dispatch('listMessagesAllowedRecipients', {});
  assert.deepStrictEqual(listed.recipients.sort(), ['+15551234567', 'mom@example.com']);
  const revoked = await grokCompatService.dispatch('revokeMessagesAllowedRecipient', { recipient: '+15551234567' });
  assert.strictEqual(revoked.removed, true);
  assert.deepStrictEqual(revoked.recipients, ['mom@example.com']);
  const revokeMissing = await grokCompatService.dispatch('revokeMessagesAllowedRecipient', { recipient: 'nobody@x.com' });
  assert.strictEqual(revokeMissing.removed, false);

  // 6. grants: request → resolve (automation auto-grants with injected runner)
  const badGrants = await grokCompatService.dispatch('requestMessagesGrants', { requestId: 'r1', grants: ['telepathy'] });
  assert.strictEqual(badGrants.status, 'error');
  const req = await grokCompatService.dispatch('requestMessagesGrants', { requestId: 'r1', grants: ['automation'] });
  assert.strictEqual(req.status, 'pending');
  const resolved = await grokCompatService.dispatch('resolveMessagesGrants', { requestId: 'r1' });
  assert.strictEqual(resolved.status, 'granted');
  assert.deepStrictEqual(resolved.granted, ['automation']);
  assert.deepStrictEqual(resolved.denied, []);
  const resolveAgain = await grokCompatService.dispatch('resolveMessagesGrants', { requestId: 'r1' });
  assert.strictEqual(resolveAgain.status, 'granted', 'resolve is idempotent for settled request');

  // 7. await → resolve race: awaiting caller gets the outcome
  await grokCompatService.dispatch('requestMessagesGrants', { requestId: 'r2', grants: ['contacts'] });
  const awaiting = grokCompatService.dispatch('awaitMessagesGrants', { requestId: 'r2', waitMs: 10000 });
  setTimeout(() => { macMessagesService.resolveGrants({ requestId: 'r2' }); }, 100);
  const outcome = await awaiting;
  assert.ok(['granted', 'denied'].includes(outcome.status), 'real probe decides');
  assert.ok(outcome.resolved.contacts);

  // 8. await → timeout stays honest (pending + timedOut)
  await grokCompatService.dispatch('requestMessagesGrants', { requestId: 'r3', grants: ['automation'] });
  const timedOut = await grokCompatService.dispatch('awaitMessagesGrants', { requestId: 'r3', waitMs: 1000 });
  assert.strictEqual(timedOut.timedOut, true);
  assert.strictEqual(timedOut.status, 'pending');
  const cancelled = await grokCompatService.dispatch('cancelMessagesGrants', { requestId: 'r3' });
  assert.strictEqual(cancelled.status, 'cancelled');
  const afterCancel = await grokCompatService.dispatch('awaitMessagesGrants', { requestId: 'r3', waitMs: 1000 });
  assert.strictEqual(afterCancel.status, 'error', 'cancelled request is gone');

  // 9. cancel settles a live awaiter
  await grokCompatService.dispatch('requestMessagesGrants', { requestId: 'r4', grants: ['automation'] });
  const liveAwait = grokCompatService.dispatch('awaitMessagesGrants', { requestId: 'r4', waitMs: 10000 });
  setTimeout(() => { macMessagesService.cancelGrants({ requestId: 'r4' }); }, 100);
  const cancelOutcome = await liveAwait;
  assert.strictEqual(cancelOutcome.status, 'cancelled');

  const unknownAwait = await grokCompatService.dispatch('awaitMessagesGrants', { requestId: 'never', waitMs: 1000 });
  assert.strictEqual(unknownAwait.status, 'error');

  console.log('mac-messages test: ALL OK (permissions/toggle/icon/allowlist/grants)');
})().catch((e) => { console.error(e); process.exit(1); });
