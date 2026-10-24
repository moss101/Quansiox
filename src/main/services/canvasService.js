'use strict';
/**
 * Canvas — the local implementation of Grok's "canvas" surface.
 *
 * In Grok a canvas is a page in a cloud store that can be shared with
 * people or a team. Quansiox is local-first, so a canvas here is an
 * *artifact* (an interactive HTML document the agent built) plus the
 * sharing state that belongs to it:
 *
 *  - a locator (`{kind:'store', storeId, canvasId}` or
 *    `{kind:'active-user-store', canvasId}`) identifies the canvas; the
 *    canvasId is the artifact id, and the store is the local workspace;
 *  - `visibility` is `private`, `team-view` or `public`, exactly as in
 *    Grok;
 *  - `access` is the list of principals (users and groups) the canvas is
 *    shared with, guarded by a state token so a stale client cannot
 *    silently overwrite somebody else's change.
 *
 * Where Grok shares a canvas through its cloud, Quansiox shares it as a
 * *file*: a public canvas can be exported as one self-contained HTML
 * document that anyone can open, with no account and no server. That is
 * strictly better for the user's data — nothing leaves the machine unless
 * the user hands the file over.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { artifactService } = require('./artifactService');

const VISIBILITIES = new Set(['private', 'team-view', 'public']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function userDataDir() {
  return require('./userData').userDataDir();
}
function stateDir() { return path.join(userDataDir(), 'canvases'); }
function statePath() { return path.join(stateDir(), 'state.json'); }

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o700 });
}

/**
 * The canvas id of a locator.
 *
 * Grok's locator is a union; both kinds carry a canvasId, so that is what
 * identifies the canvas. A missing locator is an error — silently sharing
 * "nothing" would be worse than saying so.
 */
function canvasIdOf(locator) {
  if (!locator || typeof locator !== 'object') throw new Error('a canvas locator is required');
  const id = String(locator.canvasId ?? '');
  if (!ID_RE.test(id)) throw new Error('the canvas locator has no valid canvasId');
  return id;
}

/** The store of a locator — the local workspace for a store locator. */
function storeOf(locator) {
  if (!locator || typeof locator !== 'object') return null;
  if (locator.kind === 'store') return String(locator.storeId ?? '');
  if (locator.kind === 'active-user-store') return 'active-user-store';
  return null;
}

/** The state of a canvas (share metadata), created on demand. */
function stateFor(canvasId) {
  const state = loadState();
  if (!state[canvasId]) {
    state[canvasId] = {
      canvasId,
      visibility: 'private',
      slug: null,
      pageAddress: null,
      principals: [],
      stateToken: `st_${crypto.randomBytes(6).toString('base64url')}`,
      updatedAt: Date.now(),
    };
    saveState(state);
  }
  return state[canvasId];
}

function updateState(canvasId, patch) {
  const state = loadState();
  const current = state[canvasId] ?? {
    canvasId,
    visibility: 'private',
    slug: null,
    pageAddress: null,
    principals: [],
    stateToken: `st_${crypto.randomBytes(6).toString('base64url')}`,
  };
  // The state token guards the access state: when the visibility or the
  // principals change, the token rotates, so a client that read the share
  // a while ago cannot silently overwrite the new state.
  const accessChanged = ('visibility' in patch && patch.visibility !== current.visibility)
    || ('principals' in patch && JSON.stringify(patch.principals) !== JSON.stringify(current.principals));
  const next = {
    ...current,
    ...patch,
    canvasId,
    updatedAt: Date.now(),
    stateToken: accessChanged
      ? `st_${crypto.randomBytes(6).toString('base64url')}`
      : current.stateToken,
  };
  state[canvasId] = next;
  saveState(state);
  return next;
}

/** The principals of a share, in Grok's shape. */
function normalisePrincipal(principal) {
  if (!principal || typeof principal !== 'object') return null;
  if (principal.kind === 'user') {
    const userId = Number(principal.userId);
    if (!Number.isFinite(userId)) return null;
    return { kind: 'user', userId };
  }
  if (principal.kind === 'group') {
    const groupId = String(principal.groupId ?? '').slice(0, 128);
    if (!groupId) return null;
    return { kind: 'group', groupId };
  }
  return null;
}

/**
 * The share state of a canvas.
 *
 * @returns {{ kind: 'ready', access: object }}
 */
function getShare(locator) {
  const id = canvasIdOf(locator);
  const artifact = artifactService.get(id);
  if (!artifact) return { kind: 'unavailable', reason: 'unknown canvas' };
  const state = stateFor(id);
  return {
    kind: 'ready',
    access: {
      visibility: state.visibility,
      principals: state.principals,
      stateToken: state.stateToken,
      slug: state.slug,
      pageAddress: state.pageAddress,
      title: artifact.title,
      kind: artifact.kind,
      updatedAt: state.updatedAt,
      store: storeOf(locator),
    },
  };
}

/** Set the visibility of a canvas. */
function setVisibility(locator, visibility) {
  const id = canvasIdOf(locator);
  const value = String(visibility ?? '');
  if (!VISIBILITIES.has(value)) throw new Error('visibility must be private|team-view|public');
  if (!artifactService.get(id)) return { kind: 'unavailable', reason: 'unknown canvas' };
  const state = updateState(id, { visibility: value });
  return { kind: 'ready', access: { visibility: state.visibility, principals: state.principals, stateToken: state.stateToken } };
}

/** The access (principals + token) of a canvas. */
function getShareAccess(locator) {
  const id = canvasIdOf(locator);
  if (!artifactService.get(id)) return { kind: 'unavailable', reason: 'unknown canvas' };
  const state = stateFor(id);
  return { kind: 'ready', access: { visibility: state.visibility, principals: state.principals, stateToken: state.stateToken } };
}

/**
 * Update who a canvas is shared with.
 *
 * The state token makes the write conditional: a client that read the
 * share a while ago cannot overwrite a newer change by accident.
 */
function updateShareAccess(locator, principals, expectedStateToken) {
  const id = canvasIdOf(locator);
  if (!artifactService.get(id)) return { kind: 'unavailable', reason: 'unknown canvas' };
  const state = stateFor(id);
  if (expectedStateToken && String(expectedStateToken) !== state.stateToken) {
    return { kind: 'changed', access: { visibility: state.visibility, principals: state.principals, stateToken: state.stateToken } };
  }
  const list = (Array.isArray(principals) ? principals : []).map(normalisePrincipal).filter(Boolean);
  const next = updateState(id, { principals: list });
  return { kind: 'applied', access: { visibility: next.visibility, principals: next.principals, stateToken: next.stateToken } };
}

/** Set the page address (the slug) of a canvas. */
function setPageAddress(locator, slug) {
  const id = canvasIdOf(locator);
  if (!artifactService.get(id)) return { kind: 'unavailable', reason: 'unknown canvas' };
  const value = String(slug ?? '').trim().slice(0, 128);
  if (value && !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(value)) {
    throw new Error('the page address must be a slug (letters, digits, dashes)');
  }
  const state = updateState(id, { pageAddress: value || null, slug: value || null });
  return { kind: 'ready', pageAddress: state.pageAddress };
}

/** Rename a canvas (the artifact title). */
function rename(locator, title) {
  const id = canvasIdOf(locator);
  const name = String(title ?? '').trim().slice(0, 160);
  if (!name) throw new Error('a canvas title is required');
  if (!artifactService.get(id)) return { kind: 'unavailable', reason: 'unknown canvas' };
  const artifact = artifactService.rename(id, name);
  const state = stateFor(id);
  return { kind: 'ready', title: artifact.title, stateToken: state.stateToken };
}

/**
 * Open a canvas.
 *
 * A `qx-artifact://` link opens the local canvas; any other URL is opened
 * externally, exactly like Grok's `openCanvasLink`.
 */
function openLink({ url } = {}) {
  const target = String(url ?? '').trim();
  if (!target) throw new Error('a url is required');
  if (target.startsWith('qx-artifact://')) {
    const id = target.slice('qx-artifact://'.length).split('/')[0];
    const artifact = artifactService.get(id);
    if (!artifact) return { status: 'error', reason: 'unknown canvas' };
    artifactService.open(id);
    return { status: 'ok', opened: true, id, title: artifact.title };
  }
  if (!/^https?:/i.test(target)) {
    return { status: 'error', reason: 'only http(s) links can be opened externally' };
  }
  try {
    const { shell } = require('electron');
    shell.openExternal(target);
    return { status: 'ok', opened: true, external: true, url: target };
  } catch {
    return { status: 'error', reason: 'no window manager available' };
  }
}

/**
 * Export a canvas as one self-contained HTML file the user can hand to
 * anyone. This is Quansiox's answer to Grok's cloud sharing: no account,
 * no server, no telemetry — just a file.
 */
function exportShareFile(canvasId, { targetPath } = {}) {
  const id = canvasIdOf({ canvasId });
  const artifact = artifactService.get(id);
  if (!artifact) throw new Error('unknown canvas');
  const html = artifactService.read(id);
  if (html === null) throw new Error('the canvas has no content');
  const state = stateFor(id);
  const dest = targetPath
    ? path.resolve(String(targetPath))
    : path.join(userDataDir(), 'canvases', `${state.pageAddress || id}.html`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, html, { mode: 0o600 });
  return {
    kind: 'ready',
    path: dest,
    bytes: Buffer.byteLength(html, 'utf8'),
    visibility: state.visibility,
    title: artifact.title,
  };
}

module.exports = {
  canvasService: {
    getShare, setVisibility, getShareAccess, updateShareAccess, setPageAddress,
    rename, openLink, exportShareFile, canvasIdOf, stateFor,
  },
};
