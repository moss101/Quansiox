'use strict';
/**
 * The egress proxy — the only way a sandboxed command may reach the network.
 *
 * SBPL cannot express "only these domains". Its network filters accept
 * `*` or `localhost` as the host, and nothing else:
 *
 *     sandbox-exec: host must be * or localhost in network address
 *
 * So the enforcement is split in two:
 *
 *   1. The **seatbelt** pins the sandboxed command's outbound network to
 *      `localhost` — it can reach nothing else, not even by IP.
 *   2. The **proxy** on localhost decides, per request, whether the host
 *      being asked for is on the allow-list. A denied request is refused
 *      before a socket is opened.
 *
 * The proxy is not a TLS interceptor: for `CONNECT` it reads the target
 * hostname from the request line, checks it, and then pipes the tunnel
 * through opaquely. The TLS payload is never decrypted, so the proxy cannot
 * see what is inside — it only gates *which* hosts may be reached.
 *
 * That is the same shape as a corporate egress proxy, and it is the honest
 * answer to "this command may only reach these domains".
 */
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns').promises;

/** The maximum time a tunnel may stay open. */
const TUNNEL_IDLE_MS = 5 * 60 * 1000;

function normalizeHost(host) {
  let h = String(host ?? '').trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^[a-z]+:\/\//, '');
  h = h.split('/')[0];
  h = h.split(':')[0];
  h = h.replace(/\.$/, '');
  return h || null;
}

/**
 * Is a host permitted?
 *
 * A deny entry always wins. An allow entry covers the host and its
 * subdomains. Otherwise the default decides.
 */
function hostAllowed(policy, host) {
  const name = normalizeHost(host);
  if (!name) return { allowed: false, reason: 'no host' };
  for (const denied of policy.deny ?? []) {
    const d = normalizeHost(denied);
    if (d && (name === d || name.endsWith(`.${d}`))) {
      return { allowed: false, reason: `${name} is on the egress deny list` };
    }
  }
  for (const allowed of policy.allow ?? []) {
    const a = normalizeHost(allowed);
    if (a && (name === a || name.endsWith(`.${a}`))) {
      return { allowed: true, reason: `${name} is on the egress allow list` };
    }
  }
  return {
    allowed: policy.default === 'allow',
    reason: policy.default === 'allow'
      ? `${name} is allowed by the default policy`
      : `${name} is not on the egress allow list`,
  };
}

/**
 * Start the proxy.
 *
 * @param {object} opts
 * @param {string[]} [opts.allow]
 * @param {string[]} [opts.deny]
 * @param {'allow'|'deny'} [opts.defaultAction]
 * @param {Function} [opts.onDecision]  ({ host, allowed, reason }) => void
 * @returns {Promise<{ port: number, close: () => void, stats: () => object }>}
 */
function startEgressProxy({ allow = [], deny = [], defaultAction = 'deny', onDecision } = {}) {
  const policy = { allow, deny, default: defaultAction };
  const stats = { allowed: 0, denied: 0, tunnels: 0, requests: 0 };

  const decide = (host) => {
    const verdict = hostAllowed(policy, host);
    if (verdict.allowed) stats.allowed += 1;
    else stats.denied += 1;
    if (onDecision) {
      try { onDecision({ host: normalizeHost(host), ...verdict }); } catch { /* reporting is best-effort */ }
    }
    return verdict;
  };

  const server = http.createServer((req, res) => {
    stats.requests += 1;
    // An absolute-URI request: http://host/path
    let target = null;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('this proxy only accepts absolute-URI requests');
      return;
    }
    const verdict = decide(target.hostname);
    if (!verdict.allowed) {
      res.writeHead(403, { 'content-type': 'text/plain', 'x-quansiox-egress': 'denied' });
      res.end(`egress denied: ${verdict.reason}`);
      return;
    }
    const upstream = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`upstream error: ${error.message}`);
    });
    req.pipe(upstream);
  });

  // CONNECT: the target hostname is in the request line.
  server.on('connect', (req, clientSocket, head) => {
    stats.requests += 1;
    stats.tunnels += 1;
    const [rawHost, rawPort] = String(req.url || '').split(':');
    const verdict = decide(rawHost);
    if (!verdict.allowed) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nx-quansiox-egress: denied\r\n\r\n');
      clientSocket.end(`egress denied: ${verdict.reason}`);
      return;
    }
    const port = Number(rawPort) || 443;
    const upstream = net.connect({ host: rawHost, port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const idle = setTimeout(() => { clientSocket.destroy(); upstream.destroy(); }, TUNNEL_IDLE_MS);
    if (idle.unref) idle.unref();
    const done = () => { clearTimeout(idle); clientSocket.destroy(); upstream.destroy(); };
    upstream.on('error', () => done());
    clientSocket.on('error', () => done());
    clientSocket.on('close', () => done());
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        close: () => {
          try { server.close(); } catch { /* already closed */ }
        },
        stats: () => ({ ...stats, port }),
      });
    });
  });
}

/**
 * The environment variables that point a command at the proxy.
 */
function proxyEnv(port, extra = {}) {
  const url = `http://127.0.0.1:${port}`;
  return {
    ...extra,
    http_proxy: url,
    https_proxy: url,
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    no_proxy: 'localhost,127.0.0.1,::1',
    NO_PROXY: 'localhost,127.0.0.1,::1',
  };
}

/**
 * The seatbelt profile for a command that may only use the proxy.
 * The network is pinned to localhost — the proxy — and nothing else.
 */
function proxySeatbeltProfile(baseProfile) {
  const lines = String(baseProfile).trimEnd().split('\n');
  const out = [];
  for (const line of lines) {
    if (line.includes('(allow network*)')) continue;
    if (line.includes('(deny network-outbound') && !line.includes('remote ip')) continue;
    if (line.includes('(deny network-inbound') && !line.includes('remote ip')) continue;
    if (line.trim() === '(deny network*)') continue;
    out.push(line);
  }
  out.push('; the network is reachable only through the local egress proxy');
  out.push('(allow network-outbound (remote ip "localhost:*"))');
  out.push('(allow network-inbound (remote ip "localhost:*"))');
  return `${out.join('\n')}\n`;
}

module.exports = {
  TUNNEL_IDLE_MS,
  hostAllowed,
  normalizeHost,
  proxyEnv,
  proxySeatbeltProfile,
  startEgressProxy,
};
