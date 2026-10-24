'use strict';
/* Update + notification controls test — Grok update-track / auto-update /
 * quit-and-install / notification preferences, real (updaterService + settings).
 * Electron-free except the stubbed app version; quit-and-install is guarded to
 * not actually steal control without a feed. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-upd-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const { settingsService } = require('../src/main/services/settingsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  // 1. update status reflects settings + a version
  let env = await grokCompatService.dispatch('getUpdateStatus', {});
  assert.strictEqual(env.status, 'ok');
  assert.ok(env.version, 'version reported');
  assert.strictEqual(env.updateFeedUrl, '');
  assert.strictEqual(env.autoUpdateWhenIdle, false);

  // 2. setUpdateTrack persists feed + channel
  env = await grokCompatService.dispatch('setUpdateTrack', { url: 'https://example.test/latest.json', track: 'beta' });
  assert.strictEqual(env.updateFeedUrl, 'https://example.test/latest.json');
  assert.strictEqual(env.updateChannel, 'beta');
  env = await grokCompatService.dispatch('getUpdateStatus', {});
  assert.strictEqual(env.updateFeedUrl, 'https://example.test/latest.json');
  assert.strictEqual(env.updateChannel, 'beta');

  // 3. setAutoUpdateWhenIdle toggles + persists
  await grokCompatService.dispatch('setAutoUpdateWhenIdle', { enabled: true });
  assert.strictEqual((await grokCompatService.dispatch('getUpdateStatus', {})).autoUpdateWhenIdle, true);

  // 4. notification preferences
  await grokCompatService.dispatch('setDesktopNotificationPreferences', { notifyOnDone: false });
  assert.strictEqual((await grokCompatService.dispatch('getDesktopNotificationPreferences', {})).notifyOnDone, false);
  await grokCompatService.dispatch('setDesktopNotificationPreferences', { notifyOnDone: true });
  assert.strictEqual((await grokCompatService.dispatch('getDesktopNotificationPreferences', {})).notifyOnDone, true);

  // 5. quit-and-install: guarded (no feed → error, no real install)
  settingsService.save({ updateFeedUrl: '' });
  env = await grokCompatService.dispatch('quitAndInstallUpdate', {});
  assert.strictEqual(env.status, 'error');
  assert.match(env.error, /no update feed/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('update-notify test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
