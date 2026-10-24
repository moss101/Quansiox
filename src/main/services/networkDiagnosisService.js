'use strict';
/**
 * Network diagnosis — why can this machine not reach that host?
 *
 * The reference implementation answers a surprisingly hard question with a
 * four-way DNS probe: it resolves the same name through the system
 * resolver, through an independent resolver, through a wildcard of the
 * provider's domain, and through a known-good baseline host. Comparing the
 * four tells you whether the problem is your resolver, your network, the
 * endpoint, or the provider.
 *
 * The diagnoses it produces are:
 *
 *   system_path_failure     — the system resolver fails, the others work
 *   independent_path_failure — the independent resolver fails, the system works
 *   endpoint_failure        — every resolver fails for this host
 *   cursorvm_failure       — the provider's own domain does not resolve
 *   general_dns_failure     — nothing resolves
 *   resolved_before_probe   — the name already resolved (nothing to diagnose)
 *   inconclusive            — the probes could not be run
 *
 * The local-first translation keeps the shape and drops the vendor: the
 * "provider domain" probe becomes a wildcard of the host being diagnosed,
 * and the baseline is a well-known public resolver.
 */
const dns = require('node:dns').promises;
const net = require('node:net');
const { randomUUID } = require('node:crypto');

/** The diagnoses. */
const DIAGNOSIS = {
  SYSTEM_PATH_FAILURE: 'system_path_failure',
  INDEPENDENT_PATH_FAILURE: 'independent_path_failure',
  ENDPOINT_FAILURE: 'endpoint_failure',
  PROVIDER_FAILURE: 'provider_failure',
  GENERAL_DNS_FAILURE: 'general_dns_failure',
  RESOLVED_BEFORE_PROBE: 'resolved_before_probe',
  INCONCLUSIVE: 'inconclusive',
  OK: 'ok',
};

/** The baseline: a resolver that is always there. */
const BASELINE_HOST = 'one.one.one.one';

/** A host that is always there, used to test the network path. */
const BASELINE_URL_HOST = 'example.com';

/** The resolvers to try. */
const RESOLVERS = ['1.1.1.1', '8.8.8.8'];

/** Normalise a hostname. */
function normalize(host) {
  return String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/** Is this an address rather than a name? */
function isAddress(host) {
  const h = normalize(host);
  return net.isIP(h) !== 0;
}

/**
 * Resolve a name with the system resolver.
 * @returns {Promise<{ ok: boolean, addresses: string[], error: string|null }>}
 */
async function resolveWithSystem(host) {
  try {
    const addresses = await dns.lookup(normalize(host), { all: true });
    return { ok: true, addresses: addresses.map((a) => a.address), error: null };
  } catch (error) {
    return { ok: false, addresses: [], error: String(error?.message ?? error) };
  }
}

/**
 * Resolve a name with an independent resolver.
 *
 * `dns.Resolver` talks to a specific server, so it bypasses the system
 * configuration (a search domain, a VPN resolver, `/etc/resolv.conf`).
 */
async function resolveWith(host, server) {
  try {
    const resolver = new dns.Resolver();
    resolver.setServers([server]);
    const addresses = await resolver.resolve4(normalize(host));
    return { ok: true, addresses, error: null };
  } catch (error) {
    return { ok: false, addresses: [], error: String(error?.message ?? error) };
  }
}

/**
 * Diagnose a host.
 *
 * @param {string} host
 * @param {object} [opts]
 * @param {boolean} [opts.probeNetwork] also test the TCP path
 * @returns {Promise<object>}
 */
async function diagnose(host, { probeNetwork = true } = {}) {
  const name = normalize(host);
  const at = Date.now();
  if (!name) {
    return { host: name, at, diagnosis: DIAGNOSIS.INCONCLUSIVE, reason: 'no host was given', probes: [] };
  }
  if (isAddress(name)) {
    // An address needs no resolution; the only question is whether the
    // network path to it works.
    const tcp = probeNetwork ? await probeTcp(name, 443) : null;
    return {
      host: name,
      at,
      diagnosis: tcp?.ok ? DIAGNOSIS.OK : DIAGNOSIS.ENDPOINT_FAILURE,
      reason: tcp?.ok ? 'the address is reachable' : `the address is not reachable (${tcp?.error ?? 'no probe'})`,
      probes: tcp ? [tcp] : [],
    };
  }

  const probes = [];
  const system = await resolveWithSystem(name);
  probes.push({ path: 'system', ok: system.ok, addresses: system.addresses, error: system.error });

  // If the system resolver already worked, there is nothing to diagnose:
  // the name resolves. The interesting case is when it does not.
  if (system.ok) {
    const tcp = probeNetwork ? await probeTcp(system.addresses[0], 443) : null;
    if (tcp) probes.push(tcp);
    return {
      host: name,
      at,
      diagnosis: DIAGNOSIS.RESOLVED_BEFORE_PROBE,
      reason: 'the name resolves through the system resolver',
      probes,
    };
  }

  // The system resolver failed. Now find out whose fault that is.
  const independent = [];
  for (const server of RESOLVERS) {
    const result = await resolveWith(name, server);
    independent.push({ path: 'independent', server, ok: result.ok, addresses: result.addresses, error: result.error });
  }
  probes.push(...independent);

  // The baseline: can this machine resolve ANYTHING?
  const baseline = await resolveWithSystem(BASELINE_HOST);
  probes.push({ path: 'baseline', host: BASELINE_HOST, ok: baseline.ok, addresses: baseline.addresses, error: baseline.error });

  // The wildcard: does the provider's own domain resolve?
  const wildcardLabel = `qx-dns-probe-${randomUUID().slice(0, 8)}.${name}`;
  const wildcard = await resolveWithSystem(wildcardLabel);
  probes.push({ path: 'wildcard', host: wildcardLabel, ok: wildcard.ok, addresses: wildcard.addresses, error: wildcard.error });

  const anyIndependent = independent.some((p) => p.ok);
  const baselineOk = baseline.ok;

  let diagnosis = DIAGNOSIS.INCONCLUSIVE;
  let reason = 'the probes did not settle the question';

  if (!baselineOk) {
    // Nothing resolves at all: the machine has no working DNS.
    diagnosis = DIAGNOSIS.GENERAL_DNS_FAILURE;
    reason = 'no name resolves on this machine, including the baseline — the resolver is not working';
  } else if (anyIndependent) {
    // The system resolver is broken but an independent one works.
    diagnosis = DIAGNOSIS.SYSTEM_PATH_FAILURE;
    reason = 'the system resolver fails but an independent resolver works — the machine\'s DNS configuration is the problem';
  } else if (wildcard.ok) {
    // The provider's own domain resolves, so DNS works — this endpoint does not.
    diagnosis = DIAGNOSIS.PROVIDER_FAILURE;
    reason = 'the domain itself does not resolve, although the machine can resolve other names';
  } else {
    diagnosis = DIAGNOSIS.ENDPOINT_FAILURE;
    reason = 'the host does not resolve from any resolver tried';
  }

  return { host: name, at, diagnosis, reason, probes };
}

/**
 * Test the TCP path to an address.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function probeTcp(address, port) {
  return new Promise((resolve) => {
    if (!address) { resolve({ ok: false, error: 'no address' }); return; }
    const socket = net.connect({ host: address, port });
    const done = (ok, error) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, error: error ?? null, address, port });
    };
    socket.setTimeout(4000);
    socket.once('connect', () => done(true, null));
    socket.once('timeout', () => done(false, 'the connection timed out'));
    socket.once('error', (error) => done(false, String(error?.message ?? error)));
  });
}

module.exports = {
  BASELINE_HOST,
  DIAGNOSIS,
  RESOLVERS,
  diagnose,
  isAddress,
  normalize,
  probeTcp,
  resolveWith,
  resolveWithSystem,
};
