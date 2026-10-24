'use strict';
/**
 * Global shortcut service — configurable "toggle Quansiox" hotkey
 * (Manus shortcutService pattern). Accelerator comes from settings
 * (`globalShortcut`, e.g. "CommandOrControl+Shift+K"); empty = disabled.
 * Re-registering on settings change is safe (unregisters the old one).
 */
const { globalShortcut } = require('electron');
const { settingsService } = require('./settingsService');

let current = null; // registered accelerator string

function register(toggleMainWindow) {
  unregister();
  const accelerator = String(settingsService.load().globalShortcut ?? '').trim();
  if (!accelerator) return null;
  try {
    const ok = globalShortcut.register(accelerator, () => toggleMainWindow?.());
    if (!ok) {
      console.error('[shortcut] registration failed (already taken):', accelerator);
      return null;
    }
    current = accelerator;
    return current;
  } catch (error) {
    console.error('[shortcut] invalid accelerator:', accelerator, error.message);
    return null;
  }
}

function unregister() {
  if (current) {
    try {
      globalShortcut.unregister(current);
    } catch {}
    current = null;
  }
}

function active() {
  return current;
}

module.exports = { shortcutService: { register, unregister, active } };
