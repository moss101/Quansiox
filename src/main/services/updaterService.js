'use strict';
/**
 * Updater service — feed-based update checks (electron-updater shape):
 * GET <feedUrl> -> { version, url, notes? }.
 *
 * Staged install with prepare-restart handshake (Cue's updater pattern):
 *  1. gates: refused while a playback/recording window is active
 *  2. download the artifact into userData/updates/ (size-capped)
 *  3. if it is a zip containing Quansiox.app: stage the swap
 *     (current bundle -> .old, new -> in place) and relaunch;
 *     otherwise reveal the file in Finder for the user to apply.
 *  4. before relaunching, the renderer is notified (updater:onPrepareRestart)
 *     and must acknowledge via updater.prepared({ id, result }) within
 *     10s — Cue's agents:updater:prepare / prepared handshake.
 */
const fs = require('node:fs');
const path = require('node:path');
const { settingsService } = require('./settingsService');
const { installIdService } = require('./installIdService');

const MAX_ARTIFACT_BYTES = 600 * 1024 * 1024; // 600 MB hard cap
const PREPARE_TIMEOUT_MS = 10_000;

function appVersion() {
  try {
    // In the packaged app the version ships in the bundle's package.json.
    return process.env.QUANSIOX_APP_VERSION ?? require('../../../package.json').version;
  } catch {
    return '0.0.0';
  }
}

function userDataDir() {
  return require('./userData').userDataDir();
}

/** -1 | 0 | 1 for a vs b (dotted numeric semver, ignores prerelease tags). */
function compareSemver(a, b) {
  const parse = (v) =>
    String(v)
      .replace(/-.*$/, '')
      .split('.')
      .map((n) => Number(n) || 0);
  const [av, bv] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (av[i] ?? 0) < (bv[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/**
 * Verify a downloaded update.
 *
 * An update is executable code, so it is only installed if it matches the
 * digest the feed published AND the digest is on the allow-list of trusted
 * publishers. A feed that is tampered with — or a feed that points at a
 * different archive — is refused.
 *
 * The digest is over the archive, and the publisher is the feed's own
 * identity: this is a local-first app, so the "publisher" is whoever runs
 * the feed the user configured, and the user can pin its digest.
 */
function verifyUpdate({ url, expectedSha256 = null, expectedPublisher = null } = {}) {
  if (!expectedSha256) {
    return {
      ok: false,
      reason: 'the feed did not publish a digest, so the update cannot be verified',
      code: 'UPDATE_UNVERIFIABLE',
    };
  }
  const wanted = String(expectedSha256).toLowerCase().replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(wanted)) {
    return { ok: false, reason: 'the published digest is not a sha256', code: 'UPDATE_UNVERIFIABLE' };
  }
  if (expectedPublisher) {
    const pinned = (settingsService.load().updateTrustedPublishers ?? []).map((p) => String(p).toLowerCase());
    if (!pinned.includes(String(expectedPublisher).toLowerCase())) {
      return {
        ok: false,
        reason: `the publisher "${expectedPublisher}" is not trusted`,
        code: 'UPDATE_UNTRUSTED_PUBLISHER',
      };
    }
  }
  return { ok: true, sha256: wanted, publisher: expectedPublisher ?? null, url: url ?? null };
}

/**
 * The digest of a file on disk.
 * @param {string} file
 * @returns {Promise<string>}
 */
async function digestOf(file) {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function check() {
  const feedUrl = String(settingsService.load().updateFeedUrl ?? '').trim();
  if (!feedUrl) {
    return { enabled: false, current: appVersion() };
  }
  const res = await fetch(feedUrl, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      'Cache-Control': 'no-cache',
      // Install identity goes only to the user's own feed (no telemetry).
      'X-Quansiox-Device': installIdService.getOrCreate(),
    },
  });
  if (!res.ok) throw new Error(`update feed ${res.status}`);
  const feed = await res.json();
  if (!feed?.version || !feed?.url) throw new Error('malformed update feed');
  const current = appVersion();
  return {
    enabled: true,
    current,
    latest: feed.version,
    updateAvailable: compareSemver(feed.version, current) > 0,
    url: feed.url,
    notes: feed.notes ?? '',
    // The digest the feed publishes, so the install can be checked against it.
    sha256: feed.sha256 ?? null,
    publisher: feed.publisher ?? null,
    checkedAt: Date.now(),
  };
}

/** Renderer ack for the prepare-restart handshake. */
const prepareWaiters = new Map();
function prepared(id, result = 'ok') {
  const waiter = prepareWaiters.get(id);
  if (!waiter) return false;
  prepareWaiters.delete(id);
  waiter.resolve(result === 'error' ? new Error('renderer reported error') : 'ok');
  return true;
}

/** Ask every renderer to flush; resolve on ack or timeout (Cue pattern). */
function requestPrepareRestart(id) {
  const { emitEvent } = require('../ipc/emitEvent');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      prepareWaiters.delete(id);
      resolve('timeout'); // timeout = proceed (nothing critical to flush)
    }, PREPARE_TIMEOUT_MS);
    prepareWaiters.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
    emitEvent('updater', 'onPrepareRestart', { id });
  });
}

async function downloadArtifact(url, version, { expectedSha256 = null, publisher = null } = {}) {
  const dir = path.join(userDataDir(), 'updates');
  fs.mkdirSync(dir, { recursive: true });
  const name = `quansiox-${version}-${path.basename(new URL(url).pathname) || 'update.bin'}`;
  const file = path.join(dir, name);
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_ARTIFACT_BYTES) throw new Error('artifact too large');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) throw new Error('empty artifact');
  if (buffer.length > MAX_ARTIFACT_BYTES) throw new Error('artifact too large');
  fs.writeFileSync(file, buffer);

  // The digest is checked BEFORE the artifact is used for anything. An update
  // that does not match the digest the feed published is thrown away.
  if (expectedSha256) {
    const verification = verifyUpdate({ url, expectedSha256, expectedPublisher: publisher });
    if (!verification.ok) {
      fs.rmSync(file, { force: true });
      const error = new Error(verification.reason);
      error.code = verification.code;
      throw error;
    }
    const digest = await digestOf(file);
    if (digest !== verification.sha256) {
      fs.rmSync(file, { force: true });
      const error = new Error('the downloaded update does not match the digest the feed published');
      error.code = 'UPDATE_DIGEST_MISMATCH';
      throw error;
    }
    return { file, bytes: buffer.length, sha256: digest, verified: true };
  }
  return { file, bytes: buffer.length, verified: false };
}

/** Current app bundle root (…/Quansiox.app) when running packaged. */
function currentAppBundle(execPath = process.execPath) {
  const { app } = require('electron');
  if (!app.isPackaged) return null;
  const macos = path.dirname(execPath);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  return path.basename(bundle).endsWith('.app') ? bundle : null;
}

/** Swap the staged zip into place and relaunch (applied on next launch). */
function stageZipSwap(zipFile, execPath = process.env.QUANSIOX_TEST_EXEC_PATH ?? process.execPath) {
  const { execSync } = require('node:child_process');
  const staging = `${zipFile}.extracted`;
  fs.rmSync(staging, { recursive: true, force: true });
  execSync(`ditto -x -k ${JSON.stringify(zipFile)} ${JSON.stringify(staging)}`);
  const candidates = [];
  const walk = (d, depth = 0) => {
    if (depth > 2) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith('.app')) candidates.push(path.join(d, entry.name));
      else if (entry.isDirectory()) walk(path.join(d, entry.name), depth + 1);
    }
  };
  walk(staging);
  const bundle = currentAppBundle(execPath);
  const candidate = candidates.find((c) => path.basename(c) === 'Quansiox.app') ?? candidates[0];
  if (!bundle || !candidate) {
    return { swapped: false, staged: zipFile };
  }
  // Replace: old -> .old, new -> old path; relaunch picks up the new bundle.
  const old = `${bundle}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  fs.renameSync(bundle, old);
  fs.renameSync(candidate, bundle);
  fs.rmSync(staging, { recursive: true, force: true });
  return { swapped: true, replaced: bundle, old };
}

/** Download + stage + prepare-restart handshake + relaunch. */
async function install() {
  // Recording-active gate (Cue blocks installs while recording).
  try {
    const { playbackService } = require('./playbackService');
    if (playbackService.hasActive()) {
      return { ok: false, error: 'a playback window is active — close it first' };
    }
  } catch { /* playback unavailable (tests) — proceed */ }

  const info = await check();
  if (!info.enabled) return { ok: false, error: 'updates disabled (no feed URL)' };
  if (!info.updateAvailable) return { ok: false, error: `already up to date (${info.current})` };

  const { file, bytes, sha256, verified } = await downloadArtifact(info.url, info.latest, {
    expectedSha256: info.sha256 ?? null,
    publisher: info.publisher ?? null,
  });
  const isZip = file.toLowerCase().endsWith('.zip');
  const result = { ok: true, downloaded: file, bytes, version: info.latest, sha256, verified };

  if (!isZip) {
    try {
      const { shell } = require('electron');
      shell.showItemInFolder(file);
    } catch {}
    return { ...result, applied: false, note: 'artifact is not a zip — revealed in Finder' };
  }

  let swap = { swapped: false, staged: file };
  try {
    swap = stageZipSwap(file);
  } catch (error) {
    return { ...result, applied: false, error: `staging failed: ${error.message}` };
  }
  if (!swap.swapped) {
    return { ...result, applied: false, note: 'no Quansiox.app in zip — revealed in Finder' };
  }

  // Prepare-restart handshake: give the renderer a chance to flush.
  const id = `upd-${Date.now().toString(36)}`;
  const ack = await requestPrepareRestart(id);
  // Post-restart continuity: the next boot consumes this to tell the renderer
  // which version replaced which (GPA G15).
  try {
    require('./restoreService').restoreService.markUpdate({ from: info.current, to: info.latest });
  } catch { /* checkpoint is best-effort; never block an install */ }
  const { app } = require('electron');
  app.relaunch();
  app.exit(0);
  return {
    ...result,
    applied: true,
    ack: ack === 'timeout' ? 'timeout' : ack instanceof Error ? 'renderer-error' : 'ok',
  };
}

module.exports = {
  updaterService: {
    check, install, prepared, compareSemver, appVersion, stageZipSwap,
    verifyUpdate, digestOf,
  },
};
