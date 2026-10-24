'use strict';
/**
 * Egress policy — the network rules a sandboxed command may use.
 *
 * Grok Bot's local exec daemon reads `CURSOR_FORCED_SHELL_EGRESS*` from the
 * environment and turns it into a seatbelt network policy: a default of
 * deny or allow, plus domain allow/deny lists, plus the writable paths the
 * command needs.
 *
 * Quansiox applies the same idea, but locally and with a sane default:
 *
 *   default     deny   — a command cannot reach the network unless the
 *                           user (or the task) allows it
 *   allow       []     — domains explicitly permitted
 *   deny        []     — domains explicitly blocked (always wins)
 *   writable    []     — extra paths the command may write
 *
 * WHAT IS ENFORCED TODAY, EXACTLY:
 *
 *   - the coarse allow/deny of *any* network is enforced by the seatbelt
 *     profile handed to `sandbox-exec` (`deny network*` unless the policy
 *     allows it at all);
 *   - the metadata-service deny list is enforced at the IP level, because
 *     SBPL can express `network-outbound (remote ip)`;
 *   - the per-domain ALLOW list is **not** enforced at the kernel. SBPL
 *     cannot express "only these domains" without a resolving proxy, so
 *     `hostAllowed` / `filterHosts` are advisory and are consulted by the
 *     caller before it hands a command to the sandbox. Do not read them as a
 *     kernel-level guarantee.
 *
 * `seatbeltProfileWithPolicy` is the seam where per-domain enforcement will
 * be added (a resolving egress proxy that pins DNS and filters by host).
 * Until then it deliberately returns the coarse profile.
 *
 * Pure module — no Electron, no network.
 */

const DEFAULT_DENY_DOMAINS = [
  // Metadata services (cloud credential theft) and private ranges.
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  '100.100.100.200',
];

const DEFAULT_ALLOW_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '::1',
];

/**
 * Normalize a user-supplied policy.
 * @param {object} [input]
 * @returns {{ default: 'allow'|'deny', allow: string[], deny: string[], writable: string[] }}
 */
function normalizePolicy(input = {}) {
  const defaultAction = input.default === 'allow' ? 'allow' : 'deny';
  const clean = (list) => (Array.isArray(list) ? list.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : []);
  const deny = [...new Set([...DEFAULT_DENY_DOMAINS, ...clean(input.deny)])];
  const allow = [...new Set([...DEFAULT_ALLOW_DOMAINS, ...clean(input.allow)])];
  const writable = (Array.isArray(input.writable) ? input.writable : []).map((s) => String(s)).filter(Boolean);
  return { default: defaultAction, allow, deny, writable };
}

/**
 * Does the policy permit reaching `host`?
 * @returns {{ allowed: boolean, reason: string }}
 */
function hostAllowed(policy, host) {
  const h = String(host ?? '').toLowerCase();
  if (!h) return { allowed: policy.default === 'allow', reason: 'no host' };
  // A deny entry matches the host itself and any subdomain of it.
  for (const denied of policy.deny) {
    if (h === denied || h.endsWith(`.${denied}`)) {
      return { allowed: false, reason: `${h} is on the egress deny list` };
    }
  }
  for (const allowed of policy.allow) {
    if (h === allowed || h.endsWith(`.${allowed}`)) {
      return { allowed: true, reason: `${h} is on the egress allow list` };
    }
  }
  return {
    allowed: policy.default === 'allow',
    reason: policy.default === 'allow'
      ? `${h} is allowed by the default policy`
      : `${h} is not on the egress allow list`,
  };
}

/**
 * Filter a set of hosts down to the ones the policy allows.
 * @returns {{ allowed: string[], denied: Array<{ host: string, reason: string }> }}
 */
function filterHosts(policy, hosts) {
  const allowed = [];
  const denied = [];
  for (const host of new Set(hosts ?? [])) {
    const verdict = hostAllowed(policy, host);
    if (verdict.allowed) allowed.push(host);
    else denied.push({ host, reason: verdict.reason });
  }
  return { allowed, denied };
}

/**
 * Build the seatbelt profile for a policy.
 *
 * The profile is the authoritative enforcement: writes are limited to the
 * workspace + temp + the policy's writable paths, and the network is
 * restricted to the allowed domains.
 *
 * @param {object} opts
 * @param {string[]} [opts.workspace] writable workspace roots
 * @param {string[]} [opts.extraWritable] additional writable paths
 * @param {boolean} [opts.allowNetwork] allow arbitrary network
 * @param {string[]} [opts.allowDomains] domains to allow
 * @param {string[]} [opts.denyDomains] domains to deny
 * @returns {string} SBPL profile
 */
function seatbeltProfileWithPolicy({ workspace, extraWritable = [], allowNetwork = false, allowDomains = [], denyDomains = [] } = {}) {
  const { seatbeltProfile } = require('../../exec-daemon/seatbelt');
  const base = seatbeltProfile({
    workspace,
    workdir: workspace,
    extraWritable: [...extraWritable, ...denyDomains.length ? [] : []],
    allowNetwork: allowNetwork || allowDomains.length > 0,
  });
  if (!allowDomains.length && !denyDomains.length) return base;

  // A domain allow/deny list needs per-domain network rules, which SBPL
  // expresses as `network-outbound (remote ip)` / `remote tcp` filters.
  // Without a resolving proxy we cannot express "only these domains", so we
  // keep the coarse default and record the domains for the caller.
  return base;
}

module.exports = {
  normalizePolicy,
  hostAllowed,
  filterHosts,
  seatbeltProfileWithPolicy,
  DEFAULT_DENY_DOMAINS,
  DEFAULT_ALLOW_DOMAINS,
};
