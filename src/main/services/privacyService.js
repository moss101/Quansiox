'use strict';
/**
 * Privacy mode (parity plan P4.4 — the differentiator) — enforced locally.
 *
 * Grok's PrivacyMode needs its server; Quansiox can enforce the same intent
 * on the machine: when privacy mode is on, provider runs are REFUSED at the
 * coordinator gate (the same place the API-key check lives), so no prompt,
 * transcript, or tool output ever leaves for a model provider. Local
 * machinery keeps working — the refusal names what to do (turn privacy off
 * or use a local provider). Persisted via settings (privacyMode).
 */
const fs = require('node:fs');
const path = require('node:path');

function userDataDir() {
  return require('./userData').userDataDir();
}

/** Whether privacy mode is on. Reads settings so the single source of truth
 * is the settings store (the toggle and the gate see the same bytes). */
function isEnabled() {
  try {
    return require('./settingsService').settingsService.load().privacyMode === true;
  } catch {
    return false;
  }
}

/** Set privacy mode. Returns the new value. */
function setEnabled(on) {
  const { settingsService } = require('./settingsService');
  const value = on === true;
  settingsService.save({ ...settingsService.load(), privacyMode: value });
  return value;
}

/**
 * The run gate. Pure decision over the settings row.
 * @returns {{allowed: boolean, reason?: string}}
 */
function gateRun(settings, { hasLocalProvider = false } = {}) {
  if (settings?.privacyMode !== true) return { allowed: true };
  if (hasLocalProvider) {
    return { allowed: true, note: 'privacy mode: local provider only' };
  }
  return {
    allowed: false,
    reason: 'Privacy mode is on — nothing was sent anywhere. Turn privacy mode off in the title bar, or configure a local provider (Ollama / LM Studio) to keep working privately.',
  };
}

module.exports = { privacyService: { isEnabled, setEnabled, gateRun } };
