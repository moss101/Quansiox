'use strict';
/**
 * VM snapshots — cheap checkpoints and branches of a bot's Linux box.
 *
 * Because Quansiox runs the guest on the Mac (Virtualization.framework) and
 * shares the session directory over virtiofs, a snapshot is cheap:
 *
 *   1. the guest is quiesced — its filesystems are flushed and the VM is
 *      paused through the VM host's control socket;
 *   2. the session's /share directory is cloned copy-on-write with APFS
 *      `clonefile` (a `COPYFILE_FICLONE` copy is O(1) and shares the
 *      blocks until one side writes).
 *
 * Restoring puts the clone back and boots the guest again, so the session
 * continues exactly where the snapshot was taken.
 *
 * Note on the hypervisor: Virtualization.framework traps (SIGTRAP) when the
 * machine state of a kernel-boot guest is saved, so the VM's own memory is
 * deliberately NOT saved — the share (the work) is what a snapshot means
 * here, and it is the part that matters.
 *
 * The VM adapter is injectable, so the logic is unit-tested without
 * booting a guest.
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_SNAPSHOTS = 20;

function userDataDir() {
  return require('./userData').userDataDir();
}

function root() { return path.join(userDataDir(), 'vm-snapshots'); }
function catalogFile() { return path.join(root(), 'catalog.json'); }

/** sessionId -> snapshot list (persisted). */
function readCatalog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCatalog(catalog) {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(catalogFile(), JSON.stringify(catalog, null, 2), { mode: 0o700 });
}

/**
 * Clone a directory with APFS copy-on-write.
 *
 * `COPYFILE_FICLONE` asks the kernel for `clonefile(2)`: on APFS this is a
 * metadata-only operation that shares the blocks, so a snapshot of a 2 GB
 * workspace costs almost nothing and branches are instant.
 */
function cloneDirectory(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    copyFile: fs.constants.COPYFILE_FICLONE,
    force: true,
    errorOnExist: false,
  });
  return dest;
}

/**
 * Talk to the VM host's control socket.
 * @param {string} sockPath
 * @param {string} command
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
function control(sockPath, command, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath);
    let buffer = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already gone */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('VM control timed out')), timeoutMs);
    sock.on('connect', () => sock.write(`${command}\n`));
    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      if (line.startsWith('OK')) finish(resolve, { ok: true, message: line.slice(2).trim() });
      else finish(resolve, { ok: false, message: line.replace(/^ERR\s*/, '') });
    });
    sock.on('error', (error) => finish(reject, error));
    sock.on('close', () => finish(reject, new Error('VM control connection closed')));
  });
}

/** The size of a directory tree (bytes), for the snapshot listing. */
function directoryBytes(dir) {
  let total = 0;
  const walk = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try { total += fs.statSync(full).size; } catch { /* best effort */ }
      }
    }
  };
  walk(dir);
  return total;
}

/* ---------------- the service ---------------- */

/** The VM adapter (injectable for tests). */
let adapter = {
  /** The control socket of a session's VM host, or null. */
  controlSocket: (sessionId) => {
    try {
      const { desktopVmService } = require('./desktopVmService');
      return desktopVmService.controlSockFor(sessionId);
    } catch { return null; }
  },
  /** The live share directory of a session. */
  shareDir: (sessionId) => {
    // The VM's own directory wins — it is what the guest actually mounts.
    try {
      const { desktopVmService } = require('./desktopVmService');
      const entry = desktopVmService.get(sessionId);
      if (entry?.shareDir) return entry.shareDir;
    } catch { /* the VM is not running */ }
    try {
      const { sandboxService } = require('./sandboxService');
      return sandboxService.sandboxRoot(sessionId);
    } catch { return null; }
  },
  /** Stop a session's VM. */
  stop: async (sessionId) => {
    const { desktopVmService } = require('./desktopVmService');
    return desktopVmService.stop(sessionId);
  },
  /** Boot a session's VM again. */
  boot: async (sessionId, shareDir) => {
    const { desktopVmService } = require('./desktopVmService');
    return desktopVmService.boot({ sessionId, shareDir });
  },
  /** Ask the guest to flush its filesystems (best effort). */
  flush: async (sessionId) => {
    try {
      const { desktopVmService } = require('./desktopVmService');
      await desktopVmService.call(sessionId, 'exec', { command: 'sync' }, { timeoutMs: 8000 });
      return true;
    } catch { return false; }
  },
};

function setAdapter(next = {}) { adapter = { ...adapter, ...next }; }
function resetAdapter() { setAdapter({}); }

function snapshotDir(sessionId) { return path.join(root(), sessionId); }

/**
 * Take a snapshot of a session's Linux box.
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {string} [opts.name]  a human name (generated when omitted)
 * @returns {{ id: string, name: string, createdAt: number, sharePath: string }}
 */
async function snapshot(sessionId, opts = {}) {
  const sid = String(sessionId ?? '');
  if (!ID_RE.test(sid)) throw new Error('invalid session id');
  const name = String(opts.name ?? `snap-${new Date().toISOString().replace(/[:.]/g, '-')}`).slice(0, 64);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('invalid snapshot name');

  const share = adapter.shareDir(sid);
  if (!share) throw new Error('no share directory for this session');

  const catalog = readCatalog();
  const existing = catalog[sid] ?? [];
  if (existing.length >= MAX_SNAPSHOTS) {
    throw new Error(`too many snapshots for this session (${MAX_SNAPSHOTS}) — delete one first`);
  }

  // 1. quiesce the guest: flush its filesystems from the inside (the guest
  //    agent runs `sync`), then confirm the VM is alive.
  await adapter.flush(sid);
  const sock = adapter.controlSocket(sid);
  if (sock) {
    const prepared = await control(sock, `save ${name}`);
    if (!prepared.ok) throw new Error(`could not quiesce the VM: ${prepared.message}`);
  }

  // 2. the share, cloned copy-on-write
  const target = path.join(snapshotDir(sid), name);
  const sharePath = path.join(target, 'share');
  try {
    cloneDirectory(share, sharePath);
  } catch (error) {
    throw new Error(`could not clone the share: ${error.message}`);
  }

  const record = {
    id: `${sid}:${name}`,
    sessionId: sid,
    name,
    createdAt: Date.now(),
    sharePath,
    bytes: directoryBytes(sharePath),
  };
  catalog[sid] = [...existing, record];
  writeCatalog(catalog);
  return record;
}

/** The snapshots of a session (newest first). */
function list(sessionId) {
  const sid = String(sessionId ?? '');
  const catalog = readCatalog();
  return [...(catalog[sid] ?? [])].sort((a, b) => b.createdAt - a.createdAt);
}

function find(sessionId, name) {
  const sid = String(sessionId ?? '');
  return list(sid).find((s) => s.name === name || s.id === name) ?? null;
}

/**
 * Restore a session's Linux box to a snapshot.
 *
 * The share is replaced with the clone (the current share is kept aside so
 * nothing is lost), then the VM is restarted from the saved machine state.
 */
async function restore(sessionId, name) {
  const sid = String(sessionId ?? '');
  const record = find(sid, name);
  if (!record) throw new Error(`unknown snapshot: ${name}`);
  const share = adapter.shareDir(sid);
  if (!share) throw new Error('no share directory for this session');
  if (!fs.existsSync(record.sharePath)) throw new Error('the snapshot share is missing');

  // Stop the guest FIRST.
  //
  // The guest writes into the share while it runs, so replacing the share
  // under a live VM is a race: the guest recreates files as they are being
  // removed and the replace fails with ENOTEMPTY (or, worse, leaves a
  // half-replaced filesystem). Stop → replace → boot.
  try { await adapter.stop(sid); } catch { /* the VM may already be down */ }

  // Keep the current share as a safety copy before replacing it.
  const keep = path.join(snapshotDir(sid), `.pre-restore-${Date.now()}`);
  try { cloneDirectory(share, keep); } catch { /* best effort */ }

  // Replace the live share with the snapshot's clone.
  fs.rmSync(share, { recursive: true, force: true });
  cloneDirectory(record.sharePath, share);

  // Boot the guest again on top of the restored share.
  try { await adapter.boot(sid, share); } catch (error) {
    throw new Error(`the snapshot was restored but the VM did not start: ${error.message}`);
  }
  return { restored: true, sessionId: sid, name: record.name, previousShare: keep };
}

/**
 * Branch a snapshot into a new session's box.
 *
 * The new session gets its own VM, booted from the same kernel and initramfs
 * but sharing the snapshot's cloned directory — so it starts from the
 * snapshot's exact state without touching the original.
 */
async function branch(sourceSessionId, name, opts = {}) {
  const sid = String(sourceSessionId ?? '');
  const record = find(sid, name);
  if (!record) throw new Error(`unknown snapshot: ${name}`);
  const targetSession = String(opts.targetSessionId ?? `branch-${crypto.randomBytes(4).toString('hex')}`);
  if (!ID_RE.test(targetSession)) throw new Error('invalid target session id');

  const dest = path.join(snapshotDir(targetSession), 'live');
  cloneDirectory(record.sharePath, dest);
  return {
    sessionId: targetSession,
    from: { sessionId: sid, name: record.name },
    sharePath: dest,
  };
}

/** Delete a snapshot (and its clone). */
function remove(sessionId, name) {
  const sid = String(sessionId ?? '');
  const catalog = readCatalog();
  const list = catalog[sid] ?? [];
  const record = list.find((s) => s.name === name || s.id === name);
  if (!record) return { removed: false };
  catalog[sid] = list.filter((s) => s !== record);
  writeCatalog(catalog);
  try { fs.rmSync(path.join(snapshotDir(sid), record.name), { recursive: true, force: true }); } catch { /* best effort */ }
  return { removed: true, id: record.id };
}

module.exports = {
  vmSnapshotService: {
    snapshot, list, restore, branch, remove, find,
    setAdapter, resetAdapter, control, cloneDirectory,
  },
};
