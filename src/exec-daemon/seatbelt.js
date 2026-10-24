'use strict';
/**
 * Seatbelt (sandbox-exec) profile generator for the local-exec daemon.
 *
 * Grok Bot runs agent shell commands inside a deny-by-default sandbox. This
 * module builds the equivalent macOS SBPL profile: reads are broad (so tools
 * can load libraries, runtimes and the toolchain), writes are restricted to
 * the workspace root, temp dirs and a small allowlist, and network access is
 * opt-in. It is pure (returns a string) so it can be unit-tested without
 * spawning anything.
 */

/**
 * Resolve symlinks (notably /var → /private/var on macOS) so profile paths
 * match what the kernel sees; fall back to the literal path when unresolved.
 */
function canonical(p) {
  const s = String(p);
  try { return require('node:fs').realpathSync(s); } catch { return s; }
}

function sbplEscape(value) {
  // SBPL string literals use double quotes; escape backslashes and quotes.
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * @param {object} opts
 * @param {string} [opts.workspace]   writable workspace root
 * @param {boolean} [opts.allowNetwork] permit outbound/inbound sockets
 * @param {string[]} [opts.extraWritable] additional writable paths
 * @param {boolean} [opts.allowMach]  permit mach-lookup (IPC); default true
 * @param {string} [opts.workdir]     the cwd, always writable
 * @param {string[]} [opts.denyNetworkHosts] hosts that must never be reached
 * @param {string[]} [opts.allowedIps] the addresses the network may reach.
 *   When given, the profile PINS the network to those addresses: SBPL speaks
 *   in addresses, so this is how a per-domain allow-list is enforced at the
 *   kernel.
 * @returns {string} SBPL profile
 */
function seatbeltProfile({ workspace, allowNetwork = false, extraWritable = [], allowMach = true, workdir, denyNetworkHosts = [], allowedIps = [] } = {}) {
  const writable = [...new Set([workspace, workdir, ...extraWritable].filter(Boolean).map(canonical))];
  const lines = [
    '(version 1)',
    '(deny default)',
    '; process + sysctl: required for any normal tool to start',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow signal (target self))',
    '; reads are broad: runtimes, dylibs, toolchains, /dev/urandom, etc.',
    '(allow file-read*)',
    '; writes: only the workspace, cwd, temp and explicit allowlist',
    '(allow file-write*',
    '  (subpath "/private/tmp")',
    '  (subpath "/private/var/tmp")',
    '  (subpath "/tmp")',
  ];
  if (process.env.TMPDIR) lines.push(`  (subpath "${sbplEscape(canonical(process.env.TMPDIR))}")`);
  for (const p of writable) {
    // Allow the path itself (as a file and as a directory) plus its subtree.
    lines.push(`  (literal "${sbplEscape(p)}")`);
    lines.push(`  (subpath "${sbplEscape(p)}")`);
  }
  lines.push(')');
  if (allowMach) lines.push('(allow mach-lookup)', '(allow ipc-posix-shm)');
  if (allowNetwork) {
    if (allowedIps.length) {
      // The network is PINNED: only these remote addresses are reachable.
      // This is how a per-domain allow-list is enforced — SBPL has no notion
      // of a hostname.
      lines.push('; the network is pinned to the resolved addresses of the allowed domains');
      lines.push('(deny network-outbound)');
      lines.push('(allow network-outbound');
      for (const ip of allowedIps) lines.push(`  (remote ip "${sbplEscape(String(ip))}")`);
      lines.push(')');
      lines.push('(allow network-inbound)');
    } else {
      lines.push('(allow network*)');
    }
    // HOST-LEVEL DENIAL IS NOT EXPRESSIBLE IN SBPL.
    //
    // `sandbox-exec` accepts only `*` or `localhost` as the host of a
    // network filter:
    //
    //     sandbox-exec: host must be * or localhost in network address
    //
    // So `(deny network-outbound (remote ip "169.254.169.254"))` is not a
    // rule — it is a profile that sandbox-exec REFUSES to load, which turns
    // every sandboxed command into an immediate exit 65. The metadata
    // endpoints are therefore denied by the egress proxy, not by the
    // seatbelt; the seatbelt's job is to pin the network to the proxy.
    if (denyNetworkHosts.length) {
      lines.push('; host-level denials are enforced by the egress proxy, not by SBPL');
    }
  } else {
    lines.push('; no network unless explicitly requested');
    lines.push('(deny network*)');
  }
  lines.push('(allow system-socket)'); // needed by many runtimes for local resolution
  return `${lines.join('\n')}\n`;
}

/** True when the host can actually enforce a profile (macOS + sandbox-exec). */
function seatbeltAvailable() {
  if (process.platform !== 'darwin') return false;
  try {
    const fs = require('node:fs');
    return fs.existsSync('/usr/bin/sandbox-exec');
  } catch {
    return false;
  }
}

module.exports = { seatbeltProfile, seatbeltAvailable, sbplEscape };
