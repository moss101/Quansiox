'use strict';
/**
 * Where Quansiox keeps its data — one answer for every process.
 *
 * The app is an Electron app, but a lot of Quansiox runs outside Electron
 * too: the coordinator, the exec daemon, the tests, and the command line
 * tools. Those processes have no `app`, so asking Electron for the user
 * data directory would throw and take the whole service down.
 *
 * This module answers the question once, everywhere:
 *
 *   1. `QUANSIOX_USER_DATA_DIR` — an explicit override (the tests and the
 *      sandbox use it);
 *   2. Electron's own directory, when the app is running;
 *   3. the conventional per-user directory, otherwise.
 */
const os = require('node:os');
const path = require('node:path');

const APP_NAME = 'Quansiox';

/** The Electron app object, or null when we are not inside Electron. */
function electronApp() {
  try {
    const electron = require('electron');
    return electron && typeof electron === 'object' && electron.app ? electron.app : null;
  } catch {
    return null;
  }
}

/** The user data directory. */
function userDataDir() {
  const override = process.env.QUANSIOX_USER_DATA_DIR;
  if (override) return path.resolve(override);
  const app = electronApp();
  if (app) {
    try { return app.getPath('userData'); } catch { /* fall through */ }
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }
  if (process.platform === 'win32') {
    return path.join(os.environ.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME);
}

/** A directory inside the user data directory. */
function userDataPath(...parts) {
  return path.join(userDataDir(), ...parts);
}

/** Make sure a directory exists (0700 — it holds the user's data). */
function ensureDir(dir) {
  try { require('node:fs').mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  return dir;
}

module.exports = { userDataDir, userDataPath, ensureDir, electronApp, APP_NAME };
