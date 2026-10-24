'use strict';
/**
 * Network helpers for the Grok-compat surface:
 *  - getLinkMetadata: real fetch + HTML head parse (title / og / favicon) for
 *    link previews, capped and timeout-guarded.
 *  - runNetworkDiagnostics: real DNS + TCP reachability checks.
 *
 * Electron-free; no state.
 */
const dns = require('node:dns').promises;
const net = require('node:net');

const FETCH_TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 512 * 1024;

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re) || html.match(re2);
  return m ? decodeEntities(m[1]).slice(0, 500) : null;
}

async function getLinkMetadata({ url } = {}) {
  let parsed;
  try { parsed = new URL(String(url ?? '')); } catch { return { status: 'ok', metadata: null, reason: 'invalid url' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { status: 'ok', metadata: null, reason: 'only http(s) links are previewed' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Quansiox/1.0 (+link-preview)', Accept: 'text/html,*/*' },
    });
    const body = (await res.text()).slice(0, MAX_HTML_BYTES);
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const faviconMatch = body.match(/<link[^>]+rel=["'](?:icon|shortcut icon)["'][^>]+href=["']([^"']+)["']/i);
    let favicon = faviconMatch ? decodeEntities(faviconMatch[1]) : null;
    try { if (favicon) favicon = new URL(favicon, parsed.href).href; } catch { favicon = null; }
    let ogImage = metaContent(body, 'og:image');
    try { if (ogImage) ogImage = new URL(ogImage, parsed.href).href; } catch { ogImage = null; }
    return {
      status: 'ok',
      metadata: {
        url: parsed.href,
        finalUrl: res.url || parsed.href,
        title: metaContent(body, 'og:title') ?? (titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 300) : null),
        description: metaContent(body, 'og:description') ?? metaContent(body, 'description'),
        siteName: metaContent(body, 'og:site_name') ?? parsed.hostname,
        image: ogImage,
        favicon,
        contentType: res.headers.get('content-type') || null,
      },
    };
  } catch (e) {
    return { status: 'ok', metadata: null, reason: e?.name === 'AbortError' ? 'timed out' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    const done = (ok, reason) => {
      const ms = Date.now() - started;
      sock.destroy();
      resolve({ host, port, ok, ms, ...(reason ? { reason } : {}) });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, String(e?.code ?? e?.message ?? e)));
  });
}

async function runNetworkDiagnostics({ hosts } = {}) {
  const targets = Array.isArray(hosts) && hosts.length ? hosts.map(String) : ['api.x.ai', 'github.com'];
  const started = Date.now();
  const dnsChecks = await Promise.all(targets.map(async (host) => {
    const t0 = Date.now();
    try {
      const addresses = await dns.lookup(host, { all: true });
      return { host, ok: true, ms: Date.now() - t0, addresses: addresses.map((a) => a.address) };
    } catch (e) {
      return { host, ok: false, ms: Date.now() - t0, reason: String(e?.code ?? e?.message ?? e) };
    }
  }));
  const tcpChecks = await Promise.all(targets.map((host) => tcpProbe(host, 443)));
  const allUp = dnsChecks.every((c) => c.ok) && tcpChecks.every((c) => c.ok);
  return {
    status: 'ok',
    healthy: allUp,
    dns: dnsChecks,
    tcp: tcpChecks,
    totalMs: Date.now() - started,
    checkedAt: Date.now(),
  };
}

module.exports = { netDiagnosticsService: { getLinkMetadata, runNetworkDiagnostics } };
