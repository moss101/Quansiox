'use strict';
/**
 * Egress resolver — turn a domain allow-list into enforceable addresses.
 *
 * A per-domain allow-list cannot be expressed directly in a seatbelt
 * profile: SBPL speaks in remote *addresses*, not hostnames. So the list has
 * to be resolved to addresses first, and the profile pins those addresses.
 *
 * The pinning is imperfect and the imperfection is stated here rather than
 * hidden: a hostname whose address changes after the profile was built can
 * escape, and a shared address (a CDN, a proxy) can carry another host. The
 * mitigation is a short TTL and re-resolution per command, so the window is
 * small — and the honest description is "the command may reach the addresses
 * these domains currently resolve to", not "the command may reach these
 * domains".
 *
 * Electron-free.
 */
const dns = require('node:dns').promises;

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_HOSTS = 200;

/** host -> { ips: string[], at: number } */
const cache = new Map();

/** Normalize a hostname: no scheme, no path, no trailing dot. */
function normalizeHost(host) {
  let h = String(host ?? '').trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^[a-z]+:\/\//, '');
  h = h.split('/')[0];
  h = h.split(':')[0];
  h = h.replace(/\.$/, '');
  return h || null;
}

/** Is this host already an address? */
function isAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Resolve a hostname to its addresses.
 * @param {string} host
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]
 * @returns {Promise<string[]>}
 */
async function resolveHost(host, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const name = normalizeHost(host);
  if (!name) return [];
  if (isAddress(name)) return [name];

  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < ttlMs) return hit.ips;

  let ips = [];
  try {
    const v4 = await dns.resolve4(name);
    const v6 = await dns.resolve6(name).catch(() => []);
    ips = [...new Set([...v4, ...v6])];
  } catch {
    // A hostname that does not resolve contributes nothing. The caller
    // decides whether that is fatal.
    ips = [];
  }
  if (cache.size >= MAX_HOSTS) cache.delete(cache.keys().next().value);
  cache.set(name, { ips, at: Date.now() });
  return ips;
}

/**
 * Resolve a whole allow-list.
 * @param {string[]} domains
 * @returns {Promise<{ addresses: string[], byHost: Record<string, string[]>, unresolved: string[] }>}
 */
async function resolveAllowList(domains) {
  const list = (Array.isArray(domains) ? domains : []).map(normalizeHost).filter(Boolean);
  const byHost = {};
  const unresolved = [];
  const addresses = new Set();
  for (const host of list) {
    const ips = await resolveHost(host);
    if (!ips.length) { unresolved.push(host); continue; }
    byHost[host] = ips;
    for (const ip of ips) addresses.add(ip);
  }
  return { addresses: [...addresses], byHost, unresolved };
}

/**
 * Is a host permitted by a policy?
 * A deny entry always wins; an allow entry covers the host and its
 * subdomains; otherwise the policy's default decides.
 */
function hostAllowed(policy, host) {
  const name = normalizeHost(host);
  if (!name) return { allowed: policy.default === 'allow', reason: 'no host' };
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

/** Forget the cache (a settings change, or a test). */
function clear() {
  cache.clear();
}

module.exports = {
  DEFAULT_TTL_MS,
  clear,
  hostAllowed,
  isAddress,
  normalizeHost,
  resolveAllowList,
  resolveHost,
};
