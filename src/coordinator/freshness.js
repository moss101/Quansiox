'use strict';
/**
 * Freshness gates shared by computer-use and the in-app browser.
 * Pure: no Electron. Screenshot tokens, snapshot ids, frame hashes, and
 * browser ref checks live here so the agent loop and the Node tests call
 * the same functions the services use.
 */
const crypto = require('node:crypto');

const SCREENSHOT_REQUIRED =
  'SCREENSHOT_REQUIRED — call computer_screenshot first and pass its coordinate_token.';
const STALE_COORDINATE =
  'coordinate_token invalid or stale — take a fresh computer_screenshot and use the new token (recommended: retry).';
const SESSION_REQUIRED = 'SESSION_REQUIRED — call computer_ax_tree first.';
const STALE_SNAPSHOT = 'snapshot_id stale — re-read the tree with computer_ax_tree.';

const STALE_PAGE_MISMATCH =
  'STALE_PAGE — snapshot_id is not the latest; re-run browser_snapshot and use the new refs';
const STALE_PAGE_MISSING =
  'STALE_PAGE — no snapshot on record; run browser_snapshot first';

/**
 * 8x8 difference hash over a BGRA buffer that is `width` pixels wide.
 * The computer service passes the 9x8 thumbnail (one extra column so each
 * of 8 samples has a left neighbor).
 */
function frameHashFromBgra(data, width, height) {
  if (!data || width < 2 || height < 1 || data.length < width * height * 4) return null;
  const gray = (x, y) => {
    const i = (y * width + x) * 4;
    return data[i] * 0.114 + data[i + 1] * 0.587 + data[i + 2] * 0.299;
  };
  const rows = Math.min(8, height);
  const cols = Math.min(8, width - 1);
  let bits = '';
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      bits += gray(x + 1, y) > gray(x, y) ? '1' : '0';
    }
  }
  if (!bits) return null;
  let hash = 0n;
  for (const bit of bits) hash = (hash << 1n) | BigInt(bit);
  return hash.toString(16).padStart(16, '0');
}

/** Stable non-empty fingerprint when the only available bytes are a data URL or string. */
function frameHashFromBytes(value) {
  const text = value == null ? '' : Buffer.isBuffer(value) ? value.toString('base64') : String(value);
  if (!text) return null;
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

class FreshnessGate {
  constructor() {
    this.coordinateToken = null;
    this.snapshotToken = null;
    this.lastFrameHash = null;
  }

  /** Issue a coordinate token for a screenshot. `frameHash` is required. */
  issueCoordinate(frameHash) {
    if (!frameHash) throw new Error('frame hash missing');
    const token = `ct-${crypto.randomBytes(6).toString('hex')}`;
    const screenChanged = this.lastFrameHash !== null && frameHash !== this.lastFrameHash;
    this.lastFrameHash = frameHash;
    this.coordinateToken = token;
    return { token, frameHash, screenChanged };
  }

  /** Null when `provided` is the latest coordinate token. Otherwise a refusal string. */
  requireCoordinate(provided) {
    if (!this.coordinateToken) return SCREENSHOT_REQUIRED;
    if (!provided || provided !== this.coordinateToken) return STALE_COORDINATE;
    return null;
  }

  issueSnapshot() {
    const token = `snap-${crypto.randomBytes(6).toString('hex')}`;
    this.snapshotToken = token;
    return { token };
  }

  /**
   * Adopt a snapshot id issued by the native helper.
   *
   * The native helper keeps the element registry (element id → AXUIElement),
   * so an action must be presented with *its* snapshot id. The JS gate adopts
   * that id so the model's `snapshot_id` is validated against the same token
   * the helper will accept.
   */
  setSnapshot(token) {
    if (!token) return null;
    this.snapshotToken = String(token);
    return this.snapshotToken;
  }

  /**
   * Empty `provided` is allowed once a snapshot exists (callers that omit
   * the id). A present id that is not the latest is refused.
   */
  requireSnapshot(provided) {
    if (!this.snapshotToken) return SESSION_REQUIRED;
    if (provided && provided !== this.snapshotToken) return STALE_SNAPSHOT;
    return null;
  }

  /** Drop the snapshot token (used when the helper releases its handles). */
  clearSnapshot() {
    this.snapshotToken = null;
  }
}

/**
 * Browser snapshot id check. Returns a STALE_PAGE string or null.
 * Omitting snapshotId does not refuse (the caller may be a coordinate click).
 */
function browserStaleness(snapshotId, currentSnapshotId) {
  if (snapshotId && currentSnapshotId && snapshotId !== currentSnapshotId) return STALE_PAGE_MISMATCH;
  if (snapshotId && !currentSnapshotId) return STALE_PAGE_MISSING;
  return null;
}

function staleRefMessage(ref) {
  return `unknown ref ${ref} — re-run browser_snapshot`;
}

module.exports = {
  FreshnessGate,
  frameHashFromBgra,
  frameHashFromBytes,
  browserStaleness,
  staleRefMessage,
  SCREENSHOT_REQUIRED,
  STALE_COORDINATE,
  STALE_PAGE_MISMATCH,
  STALE_PAGE_MISSING,
};
