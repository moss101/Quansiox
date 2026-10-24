'use strict';
/**
 * Install identity — Cue's device-id pattern (CredentialStore's 0600
 * `device-id` UUID): a telemetry-free per-install identifier. It is never
 * sent anywhere except the user-configured update feed, where it lets the
 * feed distinguish installs without cookies or accounts.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let cached = null;

function userDataDir() {
  return require('./userData').userDataDir();
}

/** Stable per-install UUID (created on first use, stored 0600). */
function getOrCreate() {
  if (cached) return cached;
  const file = path.join(userDataDir(), 'device-id');
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f-]{36}$/i.test(existing)) {
        cached = existing;
        return cached;
      }
    }
    cached = crypto.randomUUID();
    fs.writeFileSync(file, cached, { mode: 0o600 });
  } catch {
    // Read-only or restricted environment: derive per-process identity.
    cached = cached ?? crypto.randomUUID();
  }
  return cached;
}

function resetCache() {
  cached = null;
}

module.exports = { installIdService: { getOrCreate, resetCache } };
