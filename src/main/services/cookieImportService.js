'use strict';
/**
 * Cookie import service — authenticated browser sessions for the in-app
 * browser (Grok importChromeCookies / cookie origin grants), local-first and
 * deliberately safe:
 *
 *  - Parses a **user-supplied** Netscape `cookies.txt` (text or a
 *    workspace/userData-confined file). It does NOT scrape Chrome's Keychain or
 *    read other browsers' private databases.
 *  - Enforces a per-session **origin grant** allowlist: only cookies whose
 *    domain matches a granted origin are imported. Grants persist in a 0600
 *    JSON file.
 *
 * The risky logic (parse, grant filtering, confinement) is pure and testable;
 * the actual `session.cookies.set` lives in browserService.applyCookies.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TEXT = 2 * 1024 * 1024; // 2MB cookies.txt cap

function userDataDir() {
  return require('./userData').userDataDir();
}
function grantsFile() { return path.join(userDataDir(), 'cookie-grants.json'); }

function readGrants() { try { return JSON.parse(fs.readFileSync(grantsFile(), 'utf8')) || {}; } catch { return {}; } }
function writeGrants(o) { fs.mkdirSync(path.dirname(grantsFile()), { recursive: true }); fs.writeFileSync(grantsFile(), JSON.stringify(o, null, 2), { mode: 0o600 }); }

function normalizeOrigin(o) {
  return String(o || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\.+/, '');
}
function domainMatch(cookieDomain, grantOrigin) {
  const d = String(cookieDomain || '').toLowerCase().replace(/^\.+/, '');
  const g = normalizeOrigin(grantOrigin);
  return !!g && (d === g || d.endsWith('.' + g));
}

/** Parse a Netscape-format cookies.txt into records. */
function parseNetscape(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw;
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice('#HttpOnly_'.length); }
    else if (!line.trim() || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const [domain, , cookiePath, secure, expires, name, ...rest] = f;
    if (!domain || !name) continue;
    out.push({
      domain: domain.replace(/^\.+/, ''),
      path: cookiePath || '/',
      secure: /^(TRUE|true)$/.test(secure),
      httpOnly,
      expires: Number(expires) || 0,
      name,
      value: rest.join('\t'),
    });
  }
  return out;
}

function getGrants(sessionId) {
  const s = NormalizeSession(sessionId);
  return readGrants()[s] || [];
}
function putGrants(sessionId, { add = [], remove = [] } = {}) {
  const s = NormalizeSession(sessionId);
  const all = readGrants();
  const set = new Set(all[s] || []);
  for (const o of add) { const n = normalizeOrigin(o); if (n) set.add(n); }
  for (const o of remove) set.delete(normalizeOrigin(o));
  all[s] = [...set].sort();
  writeGrants(all);
  return all[s];
}

// Grantees are keyed by a sanitized session id so a bogus id can't escape.
function NormalizeSession(sessionId) {
  const s = String(sessionId ?? 'default');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error('invalid session id');
  return s;
}

function confinedPath(p) {
  const roots = [userDataDir()];
  try { const { settingsService } = require('./settingsService'); const r = settingsService.load().workspaceRoot; if (r) roots.push(r); } catch {}
  const abs = path.resolve(String(p || ''));
  return roots.some((root) => abs === root || abs.startsWith(root + path.sep)) ? abs : null;
}

/** Parse + filter a cookies.txt against the session's grants. */
function planImport(sessionId, text) {
  NormalizeSession(sessionId);
  const parsed = parseNetscape(text);
  const origins = getGrants(sessionId);
  const records = parsed.filter((c) => origins.some((o) => domainMatch(c.domain, o)));
  const unmatched = [...new Set(parsed.filter((c) => !origins.some((o) => domainMatch(c.domain, o))).map((c) => c.domain))];
  return { parsed: parsed.length, granted: records.length, skipped: parsed.length - records.length, records, unmatchedOrigins: unmatched, grantedOrigins: origins };
}

/** Resolve the cookies text from `text` or a confined `path`. */
function resolveImportText({ text, path: p, content }) {
  if (typeof content === 'string' && content) return content;
  if (typeof text === 'string' && text) return text;
  if (p) {
    const abs = confinedPath(p);
    if (!abs) throw new Error('cookie file is outside the workspace/userData');
    const data = fs.readFileSync(abs, 'utf8');
    if (data.length > MAX_TEXT) throw new Error('cookie file too large');
    return data;
  }
  throw new Error('provide cookies text or a path');
}

/** Filter arbitrary cookie records (e.g. from Chrome) through the grants. */
function planRecords(sessionId, parsed = []) {
  const origins = getGrants(sessionId);
  const records = parsed.filter((c) => origins.some((o) => domainMatch(c.domain, o)));
  const unmatched = [...new Set(parsed.filter((c) => !origins.some((o) => domainMatch(c.domain, o))).map((c) => c.domain))];
  return { parsed: parsed.length, granted: records.length, skipped: parsed.length - records.length, records, unmatchedOrigins: unmatched, grantedOrigins: origins };
}

/**
 * Import cookies directly from an installed Chromium-family browser.
 * Requires the `chromeCookieImport` setting and a session origin grant —
 * refuses otherwise so a stray call cannot silently lift a whole cookie jar.
 *
 * Synchronous: keeps the existing (test-friendly) call shape.
 */
function planChromeImport(sessionId, { browser = 'chrome', dbPath, domains } = {}) {
  NormalizeSession(sessionId);
  let enabled = false;
  try { enabled = require('./settingsService').settingsService.load().chromeCookieImport === true; } catch {}
  if (!enabled) throw new Error('Chrome cookie import is disabled (enable it in Settings → Browser)');
  const origins = getGrants(sessionId);
  if (!origins.length) throw new Error('grant at least one origin for this session before importing cookies');
  const { chromeCookies } = require('./chromeCookies');
  const res = chromeCookies.readCookies({ browser, dbPath, domains: domains ?? origins });
  if (res.error) throw Object.assign(new Error(res.error), { code: res.needsKeychain ? 'NEEDS_KEYCHAIN' : 'COOKIE_IMPORT_FAILED', needsKeychain: res.needsKeychain === true });
  return { browser, ...planRecords(sessionId, res.cookies) };
}

/**
 * Async variant — the cookie jar is read in a worker thread so the
 * Keychain prompt and the sqlite3 scan never block the Electron main
 * thread (and therefore never freeze the window).
 */
async function planChromeImportAsync(sessionId, { browser = 'chrome', dbPath, domains } = {}) {
  NormalizeSession(sessionId);
  let enabled = false;
  try { enabled = require('./settingsService').settingsService.load().chromeCookieImport === true; } catch {}
  if (!enabled) throw new Error('Chrome cookie import is disabled (enable it in Settings → Browser)');
  const origins = getGrants(sessionId);
  if (!origins.length) throw new Error('grant at least one origin for this session before importing cookies');
  const { chromeCookies } = require('./chromeCookies');
  const res = await chromeCookies.readCookiesAsync({ browser, dbPath, domains: domains ?? origins });
  if (res.error) throw Object.assign(new Error(res.error), { code: res.needsKeychain ? 'NEEDS_KEYCHAIN' : 'COOKIE_IMPORT_FAILED', needsKeychain: res.needsKeychain === true });
  return { browser, ...planRecords(sessionId, res.cookies) };
}

/**
 * Push a plan's records into the session's browser (host Electron partition or
 * the bot's Linux-VM Chromium, depending on the driver chosen by the caller).
 */
async function applyPlan(sessionId, plan = {}, driver = null) {
  NormalizeSession(sessionId);
  const records = Array.isArray(plan.records) ? plan.records : [];
  if (driver) return driver.applyCookies(sessionId, records);
  const { browserService } = require('./browserService');
  return browserService.applyCookies(sessionId, records);
}

module.exports = { cookieImportService: { parseNetscape, getGrants, putGrants, planImport, planRecords, planChromeImport, planChromeImportAsync, applyPlan, resolveImportText, normalizeOrigin, domainMatch }, _normalizeSession: NormalizeSession };
