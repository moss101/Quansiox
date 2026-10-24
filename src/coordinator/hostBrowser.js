'use strict';
/**
 * Web pages belong in the session's Electron browser (WebContentsView).
 * These classifiers catch the Mac paths that would otherwise launch Safari.
 */

const HOST_BROWSER_REFUSAL = 'Web pages open in the Electron browser inside this session\'s computer. Call browser_open with the URL. Do not launch Safari or another Mac browser.';

const HOST_BROWSERS = new Set([
  'safari', 'google chrome', 'chrome', 'chromium', 'firefox',
  'arc', 'brave', 'brave browser', 'microsoft edge', 'edge',
  'orion', 'dia', 'opera', 'vivaldi',
]);

const FILE_EXT = /\.(txt|md|pdf|png|jpe?g|gif|webp|html?|json|js|jsx|ts|tsx|css|zip|csv|log|app|dmg|pkg)$/i;

function normalizeAppName(name) {
  return String(name || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
}

function asUrl(value) {
  const raw = String(value || '').trim().replace(/[)"'>]+$/, '');
  if (/^https?:\/\//i.test(raw)) return raw;
  return null;
}

/** @returns {{kind:'browser-app', message:string}|{kind:'url', url:string}|null} */
function classifyAppName(name) {
  const n = normalizeAppName(name);
  if (!n) return null;
  if (HOST_BROWSERS.has(n)) return { kind: 'browser-app', message: HOST_BROWSER_REFUSAL };
  const url = asUrl(n);
  if (url) return { kind: 'url', url };
  if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(n) && !FILE_EXT.test(n) && !n.startsWith('.') && !n.includes(' ')) {
    return { kind: 'url', url: `https://${n}` };
  }
  return null;
}

const BROWSER_WORD = /\b(Safari|Google Chrome|Chromium|Firefox|Arc|Brave Browser|Brave|Microsoft Edge|Orion|Opera|Vivaldi|Dia)\b/;
const BROWSER_APP_PATH = /\/Applications\/(?:Safari|Google Chrome|Chromium|Firefox|Arc|Brave Browser|Microsoft Edge|Orion|Opera|Vivaldi|Dia)\.app\b/;
const LAUNCH = /(?:^|[\s;&|`(])(?:\/usr\/bin\/)?open\b|\bosascript\b|webbrowser\.open\s*\(|\/Applications\/(?:Safari|Google Chrome|Chromium|Firefox|Arc|Brave Browser|Microsoft Edge|Orion|Opera|Vivaldi|Dia)\.app\b/;

function firstHttpUrl(raw) {
  const match = String(raw).match(/https?:\/\/[^\s"'<>]+/i);
  return match ? asUrl(match[0]) : null;
}

/** A shell command that would open a URL or a Mac browser on the host. */
function classifyShell(command) {
  const raw = String(command || '').trim();
  if (!raw) return null;
  const url = firstHttpUrl(raw);
  const namesBrowser = BROWSER_WORD.test(raw) || BROWSER_APP_PATH.test(raw);
  const launches = LAUNCH.test(raw);
  if (namesBrowser && launches) {
    if (url) return { kind: 'url', url };
    return { kind: 'browser-app', message: HOST_BROWSER_REFUSAL };
  }
  if (/(?:^|[\s;&|`(])(?:\/usr\/bin\/)?open\b/.test(raw) && url) {
    return { kind: 'url', url };
  }
  if (/webbrowser\.open\s*\(/.test(raw)) {
    if (url) return { kind: 'url', url };
    return { kind: 'browser-app', message: HOST_BROWSER_REFUSAL };
  }
  if (/[|&;`$<>]/.test(raw) || /\n/.test(raw)) return null;
  const quoted = raw.match(/^(?:\/usr\/bin\/)?open(?:\s+-g)?\s+(?:"(https?:\/\/[^"]+)"|'(https?:\/\/[^']+)'|(https?:\/\/\S+))\s*$/i);
  if (quoted) return { kind: 'url', url: asUrl(quoted[1] || quoted[2] || quoted[3]) };
  const bare = raw.match(/^(?:\/usr\/bin\/)?open(?:\s+-g)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i);
  if (!bare) return null;
  const target = bare[1] || bare[2] || bare[3];
  if (!target || target.startsWith('/') || target.startsWith('.') || target.startsWith('~') || FILE_EXT.test(target)) {
    return null;
  }
  if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(target)) {
    return { kind: 'url', url: `https://${target}` };
  }
  return null;
}

module.exports = { classifyAppName, classifyShell, HOST_BROWSER_REFUSAL };
