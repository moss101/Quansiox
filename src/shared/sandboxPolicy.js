'use strict';
/**
 * Sandbox policy — the declarative description of what a command may touch.
 *
 * The reference implementation carries a rich policy object through every
 * exec request. Its fields are worth having, because each one answers a
 * question a user will eventually ask:
 *
 *   type                     — insecure_none | workspace_readonly | workspace_readwrite
 *   read_boundary            — SYSTEM | WORKSPACE | NONE
 *   network_policy           — a default action plus allow/deny lists
 *   network_policy_strict    — enforce the deny list even for allow-listed deps
 *   allowlist_escalated      — the policy was widened past the allow list
 *   capture_denies           — record the denies
 *   disable_tmp_write        — no writes to /tmp
 *   additional_readwrite_paths / additional_readonly_paths / additional_read_paths
 *   enable_shared_build_cache
 *   debug_output_dir
 *
 * The reference's *client* carries the proto; the *server* (the box) holds
 * the sandbox helper. Quansiox is both, so the policy is a local module that
 * the seatbelt profile is generated from.
 *
 * Pure module — no Electron, no sandbox.
 */

/** The policy types. */
const TYPE = {
  /** No isolation at all. Only for a user who asked for it. */
  INSECURE_NONE: 'insecure_none',
  /** The workspace may be written; everything else is read-only. */
  WORKSPACE_READWRITE: 'workspace_readwrite',
  /** Nothing may be written. */
  WORKSPACE_READONLY: 'workspace_readonly',
};

/** Where the command may read from. */
const READ_BOUNDARY = {
  /** The whole filesystem may be read. */
  SYSTEM: 'system',
  /** Only the workspace (and the paths the policy adds). */
  WORKSPACE: 'workspace',
  /** Nothing beyond the explicit allow list. */
  NONE: 'none',
};

/** The network default. */
const NETWORK_DEFAULT = {
  ALLOW: 'allow',
  DENY: 'deny',
};

/**
 * The default policy for a mode.
 * @param {string} [mode] 'read-only' | 'workspace' | 'computer'
 */
function defaultPolicy(mode = 'workspace') {
  const readOnly = mode === 'read-only';
  return {
    version: 1,
    type: readOnly ? TYPE.WORKSPACE_READONLY : TYPE.WORKSPACE_READWRITE,
    readBoundary: READ_BOUNDARY.SYSTEM,
    networkPolicy: {
      version: 1,
      defaultAction: NETWORK_DEFAULT.DENY,
      allow: [],
      deny: [],
      logging: null,
    },
    networkPolicyStrict: false,
    allowlistEscalated: false,
    captureDenies: false,
    disableTmpWrite: readOnly,
    additionalReadwritePaths: [],
    additionalReadonlyPaths: [],
    additionalReadPaths: [],
    enableSharedBuildCache: false,
    skipStatsigDefaults: false,
    debugOutputDir: null,
  };
}

/** Normalize a stored or transmitted policy. */
function normalizePolicy(input = {}) {
  const base = defaultPolicy(input.mode);
  const type = Object.values(TYPE).includes(input.type) ? input.type : base.type;
  const network = input.networkPolicy ?? {};
  return {
    version: 1,
    type,
    readBoundary: Object.values(READ_BOUNDARY).includes(input.readBoundary)
      ? input.readBoundary
      : base.readBoundary,
    networkPolicy: {
      version: Number(network.version) || 1,
      defaultAction: network.defaultAction === NETWORK_DEFAULT.ALLOW
        ? NETWORK_DEFAULT.ALLOW
        : NETWORK_DEFAULT.DENY,
      allow: Array.isArray(network.allow) ? network.allow.map(String) : [],
      deny: Array.isArray(network.deny) ? network.deny.map(String) : [],
      logging: network.logging ?? null,
    },
    networkPolicyStrict: input.networkPolicyStrict === true,
    allowlistEscalated: input.allowlistEscalated === true,
    captureDenies: input.captureDenies === true,
    disableTmpWrite: input.disableTmpWrite === true,
    additionalReadwritePaths: Array.isArray(input.additionalReadwritePaths) ? input.additionalReadwritePaths.map(String) : [],
    additionalReadonlyPaths: Array.isArray(input.additionalReadonlyPaths) ? input.additionalReadonlyPaths.map(String) : [],
    additionalReadPaths: Array.isArray(input.additionalReadPaths) ? input.additionalReadPaths.map(String) : [],
    enableSharedBuildCache: input.enableSharedBuildCache === true,
    skipStatsigDefaults: input.skipStatsigDefaults === true,
    debugOutputDir: input.debugOutputDir ?? null,
  };
}

/**
 * Merge the environment-driven widenings the reference applies: the agent
 * store's files directory becomes readable, and the shared paths become
 * readable or writable.
 */
function mergeEnvironmentPaths(policy, env = {}) {
  const storeDir = env.CURSOR_AGENT_STORE_FILES_DIR;
  const sharedRaw = env.CURSOR_AGENT_STORE_SHARED_PATHS;
  let shared = [];
  if (sharedRaw) {
    try {
      const parsed = JSON.parse(sharedRaw);
      if (Array.isArray(parsed)) shared = parsed;
    } catch { /* a malformed env var is ignored, not fatal */ }
  }
  if (!storeDir && !shared.length) return policy;

  const next = { ...policy };
  const extraReadonly = [...policy.additionalReadonlyPaths];
  const extraReadwrite = [...policy.additionalReadwritePaths];
  if (storeDir) extraReadonly.push(String(storeDir));
  for (const entry of shared) {
    const p = String(entry?.path ?? '');
    if (!p) continue;
    if (!entry.readOnly && policy.type === TYPE.WORKSPACE_READWRITE) extraReadwrite.push(p);
    else extraReadonly.push(p);
  }
  next.additionalReadonlyPaths = [...new Set(extraReadonly)];
  next.additionalReadwritePaths = [...new Set(extraReadwrite)];
  return next;
}

/**
 * Turn a policy into the seatbelt profile that enforces it.
 *
 * @param {object} opts
 * @param {object} opts.policy
 * @param {string} [opts.workspace]
 * @param {string[]} [opts.allowedIps]  the resolved IPs the network may reach
 * @returns {string} SBPL
 */
function policyToSeatbelt({ policy, workspace, allowedIps = [] } = {}) {
  const { seatbeltProfile } = require('../exec-daemon/seatbelt');
  const p = normalizePolicy(policy);

  const extraWritable = [
    ...p.additionalReadwritePaths,
    ...(p.disableTmpWrite ? [] : []),
  ];

  if (p.type === TYPE.INSECURE_NONE) {
    // No isolation at all: the caller has asked for it.
    return '(version 1)\n(allow default)\n';
  }

  const allowNetwork = p.networkPolicy.defaultAction === NETWORK_DEFAULT.ALLOW
    || p.networkPolicy.allow.length > 0
    || allowedIps.length > 0;

  const profile = seatbeltProfile({
    workspace,
    workdir: workspace,
    extraWritable,
    allowNetwork,
    denyNetworkHosts: p.networkPolicy.deny,
  });

  if (!allowedIps.length) return profile;

  // Per-IP pinning: SBPL can express "this remote address and no other".
  // The lines go after the base profile's allow, so they narrow it.
  const lines = profile.trimEnd().split('\n');
  const allowIndex = lines.findIndex((l) => l.includes('(allow network*)'));
  const pinned = allowedIps.map((ip) => `  (remote ip "${String(ip)}")`);
  const strictBlock = [
    '; the network is pinned to the resolved addresses of the allowed domains',
    '(deny network-outbound)',
    '(allow network-outbound',
    ...pinned,
    ')',
  ];
  if (allowIndex >= 0 && p.networkPolicyStrict) {
    lines.splice(allowIndex, 1, ...strictBlock);
  } else if (allowIndex >= 0) {
    lines.splice(allowIndex + 1, 0, ...strictBlock);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  NETWORK_DEFAULT,
  READ_BOUNDARY,
  TYPE,
  defaultPolicy,
  mergeEnvironmentPaths,
  normalizePolicy,
  policyToSeatbelt,
};
