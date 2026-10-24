'use strict';
/* Desktop prefs & UI — theme (via nativeTheme), language, spell-check,
 * hardware acceleration (startup snapshot), onboarding, webauthn proxy,
 * auto-review instructions + approvals, title-bar overlay tone, macOS access
 * checks, maximize toggle. Electron is stubbed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-prefs-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const fakeElectron = {
  nativeTheme: { shouldUseDarkColors: true, themeSource: 'system' },
  app: { getLocale: () => 'en-US' },
  systemPreferences: {
    getMediaAccessStatus: (kind) => (kind === 'screen' ? 'granted' : 'not-determined'),
    isTrustedAccessibilityClient: () => true,
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, parent, isMain);
};

const { settingsService } = require('../src/main/services/settingsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { autoReviewService } = require('../src/main/services/autoReviewService');

(async () => {
  // theme — persisted + applied to nativeTheme
  const t0 = await grokCompatService.dispatch('getThemeState', {});
  assert.strictEqual(t0.preference, 'system');
  assert.strictEqual(t0.effective, 'dark', 'follows nativeTheme');
  const t1 = await grokCompatService.dispatch('setThemePreference', { preference: 'light' });
  assert.strictEqual(t1.preference, 'light');
  assert.strictEqual(t1.effective, 'light');
  assert.strictEqual(fakeElectron.nativeTheme.themeSource, 'light', 'nativeTheme updated');
  assert.strictEqual((await grokCompatService.dispatch('getThemeState', {})).preference, 'light');
  const t2 = await grokCompatService.dispatch('setThemePreference', { preference: 'neon' });
  assert.strictEqual(t2.status, 'error');

  // language
  const l0 = await grokCompatService.dispatch('getLanguageState', {});
  assert.strictEqual(l0.preference, 'system');
  assert.strictEqual(l0.system, 'en-US');
  const l1 = await grokCompatService.dispatch('setLanguagePreference', { preference: 'de-DE' });
  assert.strictEqual(l1.preference, 'de-DE');
  assert.strictEqual(l1.relaunchRequired, true);
  assert.strictEqual((await grokCompatService.dispatch('setLanguagePreference', { preference: '!!' })).status, 'error');

  // spell check — default off (matches window webPreferences), toggle persists
  assert.strictEqual((await grokCompatService.dispatch('getSpellCheckEnabled', {})).enabled, false);
  await grokCompatService.dispatch('setSpellCheckEnabled', { enabled: true });
  assert.strictEqual((await grokCompatService.dispatch('getSpellCheckEnabled', {})).enabled, true);
  assert.strictEqual(settingsService.load().spellCheckEnabled, true);

  // hardware acceleration — startup snapshot vs configured
  global.__qxHwAccelStartup = true;
  const h0 = await grokCompatService.dispatch('getHardwareAcceleration', {});
  assert.strictEqual(h0.enabled, true);
  assert.strictEqual(h0.configured, true);
  assert.strictEqual(h0.relaunchRequired, false);
  const h1 = await grokCompatService.dispatch('setHardwareAccelerationEnabled', { enabled: false });
  assert.strictEqual(h1.enabled, false);
  assert.strictEqual(h1.relaunchRequired, true);
  const h2 = await grokCompatService.dispatch('getHardwareAcceleration', {});
  assert.strictEqual(h2.enabled, true, 'still running with acceleration until relaunch');
  assert.strictEqual(h2.configured, false);

  // onboarding + webauthn proxy
  assert.strictEqual((await grokCompatService.dispatch('getOnboardingSeen', {})).seen, false);
  await grokCompatService.dispatch('setOnboardingSeen', { seen: true });
  assert.strictEqual((await grokCompatService.dispatch('getOnboardingSeen', {})).seen, true);
  await grokCompatService.dispatch('setWebauthnProxyEnabled', { enabled: true });
  assert.strictEqual((await grokCompatService.dispatch('getWebauthnProxyEnabled', {})).enabled, true);

  // auto-review instructions — validated + capped
  const r0 = await grokCompatService.dispatch('getAutoReviewInstructions', {});
  assert.deepStrictEqual(r0.instructions, { isEnabled: false, allowInstructions: [], blockInstructions: [] });
  const r1 = await grokCompatService.dispatch('setAutoReviewInstructions', { instructions: {
    isEnabled: true,
    allowInstructions: ['npm test', 42, ''].map(String),
    blockInstructions: ['rm -rf /'],
  } });
  assert.strictEqual(r1.instructions.isEnabled, true);
  assert.deepStrictEqual(r1.instructions.blockInstructions, ['rm -rf /']);
  assert.ok(r1.updatedAt > 0);
  const r2 = await grokCompatService.dispatch('setAutoReviewInstructions', {});
  assert.strictEqual(r2.status, 'error');

  // auto-review approvals — request → settle wakes the waiter
  const req = (await grokCompatService.dispatch('requestAutoReviewApproval', { entryId: 'ar-1', agentId: 'sess-1', command: 'git push' })).request;
  assert.strictEqual(req.settled, null);
  const waitP = autoReviewService.awaitRequest({ requestId: req.requestId, waitMs: 5_000 });
  const bad = await grokCompatService.dispatch('resolveAutoReviewApproval', { requestId: req.requestId, resolution: 'maybe', agentId: 'sess-1' });
  assert.strictEqual(bad.status, 'error');
  const ok = await grokCompatService.dispatch('resolveAutoReviewApproval', { requestId: req.requestId, resolution: 'always', agentId: 'sess-1', approvedCommand: 'git push' });
  assert.strictEqual(ok.resolved, true);
  assert.strictEqual((await waitP).resolution, 'always');
  const none = await grokCompatService.dispatch('resolveAutoReviewApproval', { entryId: 'nope', resolution: 'denied' });
  assert.strictEqual(none.resolved, false);

  // title-bar overlay tone + maximize (no window in tests → honest no-op)
  const tone = await grokCompatService.dispatch('setTitleBarOverlayTone', { isOverlayTone: true });
  assert.strictEqual(tone.applied, false);
  assert.strictEqual(tone.reason, 'no main window');
  assert.strictEqual(settingsService.load().titleBarOverlayTone, true);
  const max = await grokCompatService.dispatch('toggleMaximizeWindow', {});
  assert.strictEqual(max.maximized, false);
  assert.strictEqual(max.reason, 'no main window');

  // sand access — real macOS permission statuses (stubbed systemPreferences)
  const access = await grokCompatService.dispatch('getSandAccessFresh', {});
  assert.strictEqual(access.platform, process.platform);
  assert.strictEqual(access.screen, 'granted');
  assert.strictEqual(access.microphone, 'not-determined');
  assert.strictEqual(access.accessibility, 'granted');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('desktop-prefs test: ALL OK (theme/language/spellcheck/hwaccel/onboarding/auto-review/overlay/permissions)');
})().catch((e) => { console.error(e); process.exit(1); });
