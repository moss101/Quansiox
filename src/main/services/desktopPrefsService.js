'use strict';
/**
 * Desktop preferences — real settings + Electron effects for the desktop UI
 * surface (theme, language, spell-check, hardware acceleration, onboarding,
 * webauthn proxy toggle, auto-review instructions, title-bar overlay, macOS
 * access-permission checks).
 *
 * Persisted through settingsService; Electron-backed effects are applied when
 * Electron is present, and the stored preference is always the source of truth.
 */
const { settingsService } = require('./settingsService');

const THEMES = new Set(['system', 'light', 'dark']);
const LANG_RE = /^(system|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/;
const MAX_RULES = 64;
const MAX_RULE_LEN = 300;

function tryElectron() {
  try { return require('electron'); } catch { return null; }
}

// ---- theme ----
function effectiveTheme(preference) {
  if (preference !== 'system') return preference;
  const { nativeTheme } = tryElectron() ?? {};
  if (nativeTheme) return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return 'dark';
}
function getThemeState() {
  const preference = settingsService.load().themePreference ?? 'system';
  return { preference, effective: effectiveTheme(preference), theme: effectiveTheme(preference) };
}
function setThemePreference({ preference } = {}) {
  if (!THEMES.has(preference)) throw new Error('preference must be system|light|dark');
  settingsService.save({ themePreference: preference });
  const { nativeTheme } = tryElectron() ?? {};
  if (nativeTheme) { try { nativeTheme.themeSource = preference; } catch {} }
  return getThemeState();
}

// ---- language ----
function getLanguageState() {
  const preference = settingsService.load().languagePreference ?? 'system';
  const electron = tryElectron();
  let system = null;
  try { system = electron?.app?.getLocale?.() ?? null; } catch {}
  return { preference, system, available: ['system'] };
}
function setLanguagePreference({ preference } = {}) {
  if (!LANG_RE.test(String(preference ?? ''))) throw new Error('invalid language preference');
  settingsService.save({ languagePreference: String(preference) });
  return { ...getLanguageState(), relaunchRequired: true };
}

// ---- spell check ----
function getSpellCheckEnabled() {
  return { enabled: Boolean(settingsService.load().spellCheckEnabled) };
}
function setSpellCheckEnabled({ enabled } = {}) {
  const value = Boolean(enabled);
  settingsService.save({ spellCheckEnabled: value });
  try {
    const { windowManager } = require('../windowManager');
    windowManager.applySpellChecker(value);
  } catch {}
  return { enabled: value };
}

// ---- hardware acceleration ----
function getHardwareAcceleration() {
  const configured = settingsService.load().hardwareAccelerationEnabled !== false;
  const startup = global.__qxHwAccelStartup;
  return {
    enabled: typeof startup === 'boolean' ? startup : configured,
    configured,
    relaunchRequired: typeof startup === 'boolean' ? configured !== startup : false,
  };
}
function setHardwareAccelerationEnabled({ enabled } = {}) {
  const value = Boolean(enabled);
  settingsService.save({ hardwareAccelerationEnabled: value });
  return { ...getHardwareAcceleration(), enabled: value, relaunchRequired: true };
}

// ---- onboarding / webauthn proxy toggles ----
function getOnboardingSeen() {
  return { seen: Boolean(settingsService.load().onboardingSeen) };
}
function setOnboardingSeen({ seen } = {}) {
  settingsService.save({ onboardingSeen: Boolean(seen) });
  return { seen: Boolean(seen) };
}
function getWebauthnProxyEnabled() {
  return { enabled: Boolean(settingsService.load().webauthnProxyEnabled) };
}
function setWebauthnProxyEnabled({ enabled } = {}) {
  const value = Boolean(enabled);
  settingsService.save({ webauthnProxyEnabled: value });
  try { require('../ipc/emitEvent').emitEvent('settings', 'webauthnProxyChanged', { enabled: value }); } catch {}
  return { enabled: value };
}

// ---- auto-review instructions ----
function getAutoReviewInstructions() {
  const stored = settingsService.load().autoReviewInstructions ?? {};
  return {
    instructions: {
      isEnabled: Boolean(stored.isEnabled),
      allowInstructions: Array.isArray(stored.allowInstructions) ? stored.allowInstructions : [],
      blockInstructions: Array.isArray(stored.blockInstructions) ? stored.blockInstructions : [],
    },
    updatedAt: stored.updatedAt ?? null,
  };
}
function setAutoReviewInstructions({ instructions } = {}) {
  if (!instructions || typeof instructions !== 'object') throw new Error('instructions object is required');
  const clean = (list) => (Array.isArray(list) ? list : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, MAX_RULES)
    .map((s) => s.slice(0, MAX_RULE_LEN));
  const record = {
    isEnabled: Boolean(instructions.isEnabled),
    allowInstructions: clean(instructions.allowInstructions),
    blockInstructions: clean(instructions.blockInstructions),
    updatedAt: Date.now(),
  };
  settingsService.save({ autoReviewInstructions: record });
  return { instructions: record, updatedAt: record.updatedAt };
}

// ---- title bar overlay ----
function setTitleBarOverlayTone({ isOverlayTone } = {}) {
  const value = Boolean(isOverlayTone);
  settingsService.save({ titleBarOverlayTone: value });
  try {
    const { windowManager } = require('../windowManager');
    return { ...windowManager.setTitleBarOverlayTone(value), isOverlayTone: value };
  } catch (e) {
    return { applied: false, isOverlayTone: value, reason: String(e?.message ?? e) };
  }
}

// ---- macOS access checks (screen recording / mic / camera / accessibility) --
function getSandAccessFresh() {
  const electron = tryElectron();
  const out = { platform: process.platform, checkedAt: Date.now() };
  try {
    const { systemPreferences } = electron ?? {};
    if (systemPreferences?.getMediaAccessStatus) {
      out.screen = systemPreferences.getMediaAccessStatus('screen');
      out.microphone = systemPreferences.getMediaAccessStatus('microphone');
      out.camera = systemPreferences.getMediaAccessStatus('camera');
    }
    if (systemPreferences?.isTrustedAccessibilityClient) {
      out.accessibility = systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied';
    }
  } catch {}
  for (const key of ['screen', 'microphone', 'camera', 'accessibility']) {
    if (!(key in out)) out[key] = 'unknown';
  }
  return out;
}

// ---- machine identity ----
function getMachineId() {
  const stored = settingsService.load().machineId;
  if (typeof stored === 'string' && stored) return { machineId: stored };
  const machineId = require('node:crypto').randomUUID();
  settingsService.save({ machineId });
  return { machineId };
}

// ---- global search ----
function getGlobalSearchEnabled() {
  return { enabled: settingsService.load().globalSearchEnabled !== false };
}
function setGlobalSearchEnabled({ enabled } = {}) {
  const value = Boolean(enabled);
  settingsService.save({ globalSearchEnabled: value });
  return { enabled: value };
}

module.exports = {
  desktopPrefsService: {
    getThemeState, setThemePreference,
    getLanguageState, setLanguagePreference,
    getSpellCheckEnabled, setSpellCheckEnabled,
    getHardwareAcceleration, setHardwareAccelerationEnabled,
    getOnboardingSeen, setOnboardingSeen,
    getWebauthnProxyEnabled, setWebauthnProxyEnabled,
    getAutoReviewInstructions, setAutoReviewInstructions,
    setTitleBarOverlayTone, getSandAccessFresh,
    getMachineId, getGlobalSearchEnabled, setGlobalSearchEnabled,
  },
};
