'use strict';
/**
 * Browser service — Quansiox's port of Manus Studio's in-app browser
 * (dist/browser/WebContentsViewBrowserDriver.js pattern):
 *
 *  - one embedded browser per agent session (WebContentsView), shown inside
 *    that session's agent computer. The live page is a child view of the
 *    workspace window, aligned to the computer screen. A separate host
 *    window is optional; detaching it keeps browsing alive.
 *  - tab model (t1, t2, …) with only the active tab attached
 *  - hybrid a11y snapshots over the Chromium DevTools protocol
 *    (`webContents.debugger`): DOMSnapshot.captureSnapshot (geometry,
 *    one round-trip) + Accessibility.getFullAXTree (semantics) joined on
 *    backendNodeId — refs `e1…eN` point at interactable nodes with rects
 *  - staleness via generation counters (Manus taxonomy): documentRevision
 *    bumps on navigations, mutationGeneration on observed DOM mutations
 *    (Runtime.addBinding + MutationObserver); actions with a stale
 *    snapshot_id are refused with STALE_PAGE / STALE_REF guidance
 *  - input via CDP `Input.dispatch*` (click/press/scroll) and native-setter
 *    fills via `Runtime.callFunctionOn` that dispatch real input/change
 *    events (the Manus fill snippet pattern)
 *  - console ring buffer, JS evaluation, dialog queue, downloads
 *
 * Gated by `settings.allowBrowser` (default ON — the browser is embedded
 * and visible, unlike raw computer control).
 */
const { WebContentsView } = require('electron');
const path = require('node:path');
const { settingsService } = require('./settingsService');
const { buildBrowserSnapshot } = require('./browserSnapshot');
const { KEYCODES, MODBITS, normalizeUrl } = require('./browserProtocol');
const downloadSessions = new WeakSet();

const DEBUGGER_PROTOCOL = '1.3';
const TEXT_CAP = 100_000;
const CONSOLE_CAP = 100;
const CONSOLE_LINE_CAP = 500;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TABS = 8;

/** ref -> node record inside a snapshot */
function browserError(code, extra = '') {
  return { __browserError: code, message: `${code}${extra ? ` — ${extra}` : ''}` };
}

class Tab {
  constructor(tabId, sessionId) {
    this.tabId = tabId;
    this.sessionId = sessionId;
    this.view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // GPA G6: background input. Hidden sessions keep their renderer
        // unthrottled so CDP pointer/keyboard input and page JS keep landing
        // while the view is not on screen (unattended agent work).
        backgroundThrottling: false,
        partition: `persist:quansiox-browser-${require('node:crypto').createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`,
      },
    });
    const wc = this.view.webContents;
    wc.__qxAgentBrowser = true;
    this.documentRevision = 0;
    this.mutationGeneration = 0;
    this.crashed = false;
    this.console = [];
    this.dialog = null; // {message, type, respond}
    this.lastSnapshot = null; // { snapshotId, documentRevision, mutationGeneration, refs: Map }
    wc.on('did-navigate', () => { this.documentRevision += 1; this._notify(); });
    wc.on('did-navigate-in-page', () => { this.documentRevision += 1; this._notify(); });
    wc.on('page-title-updated', () => this._notify());
    wc.on('render-process-gone', (_e, details) => {
      this.crashed = details?.reason !== 'clean-exit';
      this._notify();
    });
    wc.on('unresponsive', () => this._notify());
    wc.on('responsive', () => this._notify());
    wc.on('console-message', (_e, _level, message) => {
      this.console.push(String(message).slice(0, CONSOLE_LINE_CAP));
      if (this.console.length > CONSOLE_CAP) this.console.splice(0, this.console.length - CONSOLE_CAP);
    });
    wc.on('dialog', (event, dialogType, message, _defaultText, callback) => {
      // Queue exactly one dialog; the page is blocked until it is handled
      // (browser_handle_dialog) or auto-dismissed after the grace period.
      event.preventDefault();
      const respond = (accept, text) => {
        try { callback(accept, text); } catch { /* dialog already gone */ }
      };
      this.dialog = { message: String(message), type: dialogType, respond };
      this._notify();
      setTimeout(() => this._dismissDialog(false), 30_000).unref?.();
    });
    wc.setWindowOpenHandler(({ url }) => {
      // Agent-browser popups become tabs (Manus gesture model, simplified).
      if (/^https?:/i.test(url)) this._openBackgroundTab(url);
      return { action: 'deny' };
    });
    // Downloads land in the session's browser-downloads dir and are tracked
    // for the renderer's download list (GPA G7).
    try {
      if (!downloadSessions.has(wc.session)) {
      downloadSessions.add(wc.session);
      wc.session.on('will-download', (_event, item) => {
        try { require('./browserService').browserService._trackDownload(sessionId, item); }
        catch { /* download tracking is best-effort; still save the file */ }
      });
      }
    } catch { /* session reuse across views — handler already set */ }
  }

  _dismissDialog(accept, text) {
    const dialog = this.dialog;
    if (!dialog) return;
    this.dialog = null;
    dialog.respond(accept, text);
    this._notify();
  }

  _openBackgroundTab(url) {
    const { browserService } = require('./browserService');
    browserService._openTab(this.sessionId, url).catch(() => {});
  }

  _notify() {
    const { browserService } = require('./browserService');
    browserService._notifyState(this.sessionId);
    if (!this.crashed) return;
  }

  /* ---- CDP ---- */

  _debugger() {
    const wc = this.view.webContents;
    if (!wc.debugger.isAttached?.()) wc.debugger.attach(DEBUGGER_PROTOCOL);
    return wc.debugger;
  }

  async _cdp(method, params = {}) {
    return this._debugger().sendCommand(method, params);
  }

  /** Install the mutation reporter (bumps mutationGeneration on DOM changes). */
  async _installMutationObserver() {
    const dbg = this._debugger();
    if (!this.mutationReporterAttached) {
      dbg.on('message', (_event, method, params) => {
        if (method === 'Runtime.bindingCalled' && params?.name === '__qxMut') {
          this.mutationGeneration += 1;
        }
      });
      this.mutationReporterAttached = true;
    }
    await this._cdp('Runtime.enable');
    await this._cdp('Runtime.addBinding', { name: '__qxMut' });
    await this._cdp('Runtime.evaluate', {
      expression: `(() => {
        if (window.__qxMutInstalled) return;
        window.__qxMutInstalled = true;
        const send = () => window.__qxMut && window.__qxMut('m');
        new MutationObserver(send).observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, characterData: true,
        });
      })()`,
    });
  }

  /**
   * Hybrid snapshot: one DOMSnapshot.captureSnapshot (geometry for every
   * backend node) + one Accessibility.getFullAXTree (semantics), joined on
   * backendNodeId. Returns { snapshotId, text, refs }.
   */
  async snapshot() {
    await this._installMutationObserver();
    await this._cdp('Accessibility.enable');
    const [dom, ax] = await Promise.all([
      this._cdp('DOMSnapshot.captureSnapshot', {
        computedStyles: [],
        includeDOMRects: true,
        includePaintOrder: false,
      }),
      this._cdp('Accessibility.getFullAXTree'),
    ]);
    const snapshotId = `snap_${require('node:crypto').randomUUID()}`;
    const built = buildBrowserSnapshot({
      dom, ax, snapshotId,
      documentRevision: this.documentRevision,
      mutationGeneration: this.mutationGeneration,
    });
    this.lastSnapshot = {
      snapshotId,
      documentRevision: this.documentRevision,
      mutationGeneration: this.mutationGeneration,
      refs: built.refs,
    };
    return {
      snapshotId,
      documentRevision: this.documentRevision,
      text: built.text,
      refCount: built.refCount,
    };
  }

  /** Manus-style staleness gate for actions. Returns error string or null. */
  _staleness(snapshotId) {
    const { browserStaleness } = require('../../coordinator/freshness');
    const refusal = browserStaleness(snapshotId, this.lastSnapshot?.snapshotId ?? null);
    if (refusal) return refusal;
    // Coordinate-only actions (no ref snapshot yet) have nothing to be stale
    // against; ref-based actions are refused by _resolveRef below.
    if (!this.lastSnapshot) return null;
    if (this.lastSnapshot.documentRevision !== this.documentRevision
      || this.lastSnapshot.mutationGeneration !== this.mutationGeneration) {
      return 'page changed since this snapshot — run browser_snapshot again';
    }
    return null;
  }

  _resolveRef(ref) {
    const snap = this.lastSnapshot;
    if (!snap) return null;
    return snap.refs.get(String(ref)) ?? null;
  }

  async _scrollIntoView(backend) {
    const resolved = await this._cdp('DOM.resolveNode', { backendNodeId: backend });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return;
    await this._cdp('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { this.scrollIntoView({ block: "center", inline: "nearest" }); }',
      awaitPromise: false,
    });
  }

  /** Keep a hidden page input-capable (focus + lifecycle emulation). */
  async _enableBackgroundInput() {
    try { this.view.webContents.focus?.(); } catch { /* hidden view may refuse focus */ }
    await this._cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this._cdp('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  }

  async click({ ref, x, y, snapshot_id }) {
    const stale = this._staleness(snapshot_id);
    if (stale) return browserError('STALE_PAGE', stale);
    let cx, cy;
    if (ref !== undefined) {
      const node = this._resolveRef(ref);
      if (!node) {
        const { staleRefMessage } = require('../../coordinator/freshness');
        return browserError('STALE_REF', staleRefMessage(ref));
      }
      await this._scrollIntoView(node.backend);
      // re-read the rect post-scroll
      const model = await this._cdp('DOM.getBoxModel', { backendNodeId: node.backend }).catch(() => null);
      const q = model?.model?.content ?? model?.model?.border;
      if (q && q.length >= 4) {
        cx = (q[0] + q[2]) / 2; cy = (q[1] + q[5]) / 2;
      } else if (node.box) {
        cx = node.box.x + node.box.width / 2; cy = node.box.y + node.box.height / 2;
      } else return browserError('REF_NOT_INTERACTABLE', `ref ${ref} has no rect`);
    } else {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return browserError('INVALID_COORDINATES', 'provide ref or x/y');
      }
      cx = x; cy = y;
    }
    await this._showAgentCursor(cx, cy);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this._cdp('Input.dispatchMouseEvent', {
        type, x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 1,
      });
    }
    return `clicked ${ref ? `ref=${ref}` : `(${Math.round(cx)}, ${Math.round(cy)})`}`;
  }

  /** Paint the agent's pointer on the page so the computer shows the action. */
  async _showAgentCursor(x, y) {
    const px = Math.round(Number(x) || 0);
    const py = Math.round(Number(y) || 0);
    try {
      await this._cdp('Runtime.evaluate', {
        expression: `(() => {
          const root = document.documentElement || document.body;
          if (!root) return;
          let el = document.getElementById('__qx_agent_cursor');
          if (!el) {
            el = document.createElement('div');
            el.id = '__qx_agent_cursor';
            el.setAttribute('aria-hidden', 'true');
            el.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:16px;margin:-3px 0 0 -3px;border-radius:50%;border:2px solid #fff;background:rgba(124,140,248,.9);box-shadow:0 1px 4px rgba(0,0,0,.45);pointer-events:none;z-index:2147483646;transform:translate(-40px,-40px)';
            root.appendChild(el);
          }
          el.style.transform = 'translate(${px}px, ${py}px)';
        })()`,
      });
    } catch { /* the pointer is visual; the click still lands */ }
  }

  async hover({ ref, snapshot_id }) {
    const stale = this._staleness(snapshot_id);
    if (stale) return browserError('STALE_PAGE', stale);
    const node = this._resolveRef(ref);
    if (!node) return browserError('STALE_REF', `unknown ref ${ref}`);
    await this._scrollIntoView(node.backend);
    const cx = node.box.x + node.box.width / 2;
    const cy = node.box.y + node.box.height / 2;
    await this._showAgentCursor(cx, cy);
    await this._cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(cx), y: Math.round(cy),
    });
    return `hovered ref=${ref}`;
  }

  async type({ ref, text, submit = false, snapshot_id }) {
    const stale = this._staleness(snapshot_id);
    if (stale) return browserError('STALE_PAGE', stale);
    if (typeof text !== 'string' || !text) return browserError('INVALID_ARGUMENT', 'text required');
    if (ref !== undefined) {
      const node = this._resolveRef(ref);
      if (!node) return browserError('STALE_REF', `unknown ref ${ref}`);
      await this.click({ ref, snapshot_id });
    }
    await this._cdp('Input.insertText', { text });
    if (submit) {
      await this.pressKey({ key: 'Enter' });
      await this._waitForLoad();
    }
    return `typed ${text.length} chars${submit ? ' + Enter' : ''}`;
  }

  /**
   * Native-setter fill (Manus fill pattern): set .value through the property
   * descriptor, then dispatch input+change so frameworks observe it.
   */
  async fill({ ref, value, snapshot_id }) {
    const stale = this._staleness(snapshot_id);
    if (stale) return browserError('STALE_PAGE', stale);
    const node = this._resolveRef(ref);
    if (!node) return browserError('STALE_REF', `unknown ref ${ref}`);
    const resolved = await this._cdp('DOM.resolveNode', { backendNodeId: node.backend });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return browserError('STALE_REF', 'node detached');
    const out = await this._cdp('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (value) {
        const el = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
        if (!el || !('value' in el)) return { ok: false, reason: 'not_fillable' };
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        desc?.set ? desc.set.call(el, value) : (el.value = value);
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return { ok: true };
      }`,
      arguments: [{ value: String(value ?? '') }],
      returnByValue: true,
    });
    const result = out?.result?.value;
    if (!result?.ok) return browserError('REF_NOT_INTERACTABLE', result?.reason ?? 'fill failed');
    return `filled ref=${ref} with ${String(value).length} chars`;
  }

  async select({ ref, value, snapshot_id }) {
    const stale = this._staleness(snapshot_id);
    if (stale) return browserError('STALE_PAGE', stale);
    const node = this._resolveRef(ref);
    if (!node) return browserError('STALE_REF', `unknown ref ${ref}`);
    const resolved = await this._cdp('DOM.resolveNode', { backendNodeId: node.backend });
    const objectId = resolved?.object?.objectId;
    const out = await this._cdp('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (value) {
        const el = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
        if (!(el instanceof HTMLSelectElement)) return { ok: false, reason: 'not_select' };
        const byValue = [...el.options].find((o) => o.value === value);
        const byLabel = byValue ?? [...el.options].find((o) => o.label.trim() === value);
        const option = byValue ?? byLabel;
        if (!option) return { ok: false, reason: 'no_match', options: [...el.options].map((o) => o.value) };
        el.selectedIndex = el.options.indexOf(option);
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return { ok: true };
      }`,
      arguments: [{ value: String(value ?? '') }],
      returnByValue: true,
    });
    const result = out?.result?.value;
    if (!result?.ok) {
      return browserError('REF_NOT_INTERACTABLE',
        `${result?.reason ?? 'select failed'}${result?.options ? `; options: ${result.options.join(', ')}` : ''}`);
    }
    return `selected "${value}" in ref=${ref}`;
  }

  async pressKey({ key, modifiers = [] }) {
    const code = KEYCODES[String(key).toLowerCase()];
    if (code === undefined) return browserError('INVALID_KEY', `unknown key ${key}`);
    const modBits = (Array.isArray(modifiers) ? modifiers : [modifiers])
      .map((m) => MODBITS[String(m).toLowerCase()] ?? 0)
      .reduce((a, b) => a | b, 0);
    const text = /^([a-z0-9]| |[,.;:'"/\\`!@#$%^&*()[\]_+=<>?-])$/.test(key) ? key : '';
    await this._cdp('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      key, code: code.name ?? key, windowsVirtualKeyCode: code.code,
      nativeVirtualKeyCode: code.code, modifiers: modBits, text: text || undefined,
    });
    if (text) {
      await this._cdp('Input.dispatchKeyEvent', {
        type: 'char', key, windowsVirtualKeyCode: code.code, modifiers: modBits, text,
      });
    }
    await this._cdp('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code: code.name ?? key,
      windowsVirtualKeyCode: code.code, modifiers: modBits,
    });
    return `pressed ${key}`;
  }

  async scroll({ direction = 'down', amount = 600, ref }) {
    const deltas = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const [dx, dy] = deltas[String(direction).toLowerCase()] ?? deltas.down;
    let x = 100, y = 100;
    if (ref !== undefined) {
      const node = this._resolveRef(ref);
      if (node?.box) { x = node.box.x + node.box.width / 2; y = node.box.y + node.box.height / 2; }
    }
    await this._cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(x), y: Math.round(y),
      deltaX: dx * Math.max(1, amount), deltaY: dy * Math.max(1, amount),
    });
    return `scrolled ${direction} ${amount}`;
  }

  async screenshot() {
    const image = await this.view.webContents.capturePage();
    const size = image.getSize();
    return {
      id: `bshot-${Date.now().toString(36)}`,
      data: image.toDataURL(),
      width: size.width,
      height: size.height,
    };
  }

  console_({ limit = 20 } = {}) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.console.slice(-n);
  }

  async js({ code, timeoutMs = 10_000 }) {
    if (typeof code !== 'string' || !code.trim()) {
      return browserError('INVALID_ARGUMENT', 'code required');
    }
    const timeout = Math.min(30_000, Math.max(1000, Number(timeoutMs) || 10_000));
    const cap = Date.now() + timeout;
    const out = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(
        new Error(`JS evaluation timed out after ${timeout}ms`), { code: 'WAIT_TIMEOUT' })), timeout);
      this._cdp('Runtime.evaluate', {
        expression: code,
        awaitPromise: true,
        returnByValue: true,
      }).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
      void cap;
    }).catch((error) => ({ exceptionDetails: { text: String(error?.message ?? error) } }));
    if (out?.exceptionDetails) {
      const d = out.exceptionDetails;
      return browserError('JS_ERROR', `${d.text ?? ''} ${d.exception?.description ?? ''}`.slice(0, 500));
    }
    const value = out?.result?.value;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return (text ?? 'undefined').slice(0, TEXT_CAP);
  }

  async wait({ text, ms, selector, timeoutMs = 10_000 }) {
    const deadline = Date.now() + Math.min(30_000, Math.max(1000, Number(timeoutMs) || 10_000));
    if (Number.isFinite(ms) && ms > 0) {
      await new Promise((r) => setTimeout(r, Math.min(30_000, ms)));
      return `waited ${ms}ms`;
    }
    if (text || selector) {
      const expr = selector
        ? `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        : `document.body && document.body.innerText.includes(${JSON.stringify(text)})`;
      while (Date.now() < deadline) {
        const out = await this._cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
        if (out?.result?.value === true) {
          return `matched ${selector ? `selector ${selector}` : `text "${text}"`} after ${Date.now() - (deadline - Math.min(30_000, timeoutMs * 1000))}ms`;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return browserError('WAIT_TIMEOUT', `${selector ? `selector ${selector}` : `text "${text}"`} not found`);
    }
    return browserError('INVALID_ARGUMENT', 'provide text, selector, or ms');
  }

  handleDialog({ accept = true, text = '' } = {}) {
    if (!this.dialog) return browserError('STALE_DIALOG', 'no dialog pending');
    const { message } = this.dialog;
    this._dismissDialog(Boolean(accept), String(text ?? ''));
    return `${accept ? 'accepted' : 'dismissed'} dialog: "${message.slice(0, 200)}"`;
  }

  _waitForLoad(ms = 5000) {
    return new Promise((resolve) => {
      const wc = this.view.webContents;
      if (!wc.isLoadingMainFrame()) return resolve();
      const done = () => { wc.removeListener('did-stop-loading', done); resolve(); };
      wc.once?.('did-stop-loading', done);
      setTimeout(resolve, ms).unref?.();
    });
  }

  url() { return this.view.webContents.getURL(); }
  title() { return this.view.webContents.getTitle(); }

  destroy() {
    this._dismissDialog(false);
    try { this.view.webContents.debugger.isAttached?.() && this.view.webContents.debugger.detach(); } catch {}
    try { this.view.webContents.close(); } catch {}
  }
}

class BrowserService {
  constructor() {
    /** sessionId -> { sessionId, tabs, activeTabId, window, presented, dockBounds } */
    this.browsers = new Map();
    this.nextTabId = 1;
    this.foregroundSessionId = null;
    /** sessionId -> bounded download records (newest last). */
    this.downloads = new Map();
    this.nextDownloadId = 1;
    this._downloadTimers = new Map();
  }

  get(sessionId) { return this.browsers.get(sessionId) ?? null; }

  /* ---- downloads (GPA G7) ---- */

  _trackDownload(sessionId, item) {
    const fs = require('node:fs');
    const dir = path.join(process.env.QUANSIOX_USER_DATA_DIR ?? '.', 'browser-downloads', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.basename(String(item.getFilename?.() || 'download'));
    const savePath = path.join(dir, `${Date.now()}-${filename}`);
    const rec = {
      id: `dl_${Date.now().toString(36)}_${this.nextDownloadId++}`,
      sessionId,
      filename,
      savePath,
      url: (() => { try { return item.getURL?.() ?? ''; } catch { return ''; } })(),
      mime: (() => { try { return item.getMimeType?.() ?? ''; } catch { return ''; } })(),
      totalBytes: (() => { try { return item.getTotalBytes?.() ?? 0; } catch { return 0; } })(),
      receivedBytes: 0,
      state: 'progressing',
      startedAt: Date.now(),
      completedAt: null,
    };
    const list = this.downloads.get(sessionId) ?? [];
    list.push(rec);
    if (list.length > 50) list.splice(0, list.length - 50);
    this.downloads.set(sessionId, list);
    try { item.setSavePath(savePath); } catch { /* Electron picks the name */ }
    const sync = (state) => {
      rec.receivedBytes = (() => { try { return item.getReceivedBytes?.() ?? rec.receivedBytes; } catch { return rec.receivedBytes; } })();
      rec.state = state;
      if (state === 'completed') rec.completedAt = Date.now();
      this._notifyDownload(sessionId, rec);
    };
    item.on?.('updated', (_e, state) => sync(state === 'interrupted' ? 'interrupted' : 'progressing'));
    item.once?.('done', (_e, state) => sync(state));
    this._notifyDownload(sessionId, rec);
    return rec;
  }

  _notifyDownload(sessionId, rec) {
    try {
      const { emitEvent } = require('../ipc/emitEvent');
      emitEvent('browser', 'onDownload', { sessionId, download: { ...rec } });
    } catch { /* events are best-effort */ }
  }

  /** Download history for a session, newest first. */
  downloadsFor(sessionId) {
    return [...(this.downloads.get(sessionId) ?? [])].reverse();
  }

  async openDownload(sessionId, id) {
    const rec = (this.downloads.get(sessionId) ?? []).find((d) => d.id === id);
    if (!rec) throw new Error('unknown download');
    if (rec.state !== 'completed') throw new Error(`download is ${rec.state}`);
    const { shell } = require('electron');
    const error = await shell.openPath(rec.savePath);
    if (error) throw new Error(error);
    return true;
  }

  revealDownload(sessionId, id) {
    const rec = (this.downloads.get(sessionId) ?? []).find((d) => d.id === id);
    if (!rec) throw new Error('unknown download');
    require('electron').shell.showItemInFolder(rec.savePath);
    return true;
  }

  clearDownloads(sessionId) {
    this.downloads.set(sessionId, (this.downloads.get(sessionId) ?? []).filter((d) => d.state === 'progressing'));
    return this.downloadsFor(sessionId);
  }

  _assertAllowed() {
    const settings = settingsService.load();
    if (settings.allowBrowser === false) {
      throw new Error('browser tools are disabled — enable them in Settings');
    }
  }

  /** Ensure a session browser exists. The page stays headless until it is presented. */
  ensure(sessionId) {
    this._assertAllowed();
    let browser = this.browsers.get(sessionId);
    if (!browser) {
      browser = {
        sessionId, tabs: new Map(), activeTabId: null, window: null,
        presented: false, dockBounds: null,
      };
      this.browsers.set(sessionId, browser);
    }
    if (!browser.activeTabId) this._createTab(browser);
    return browser;
  }

  /** The session whose computer is on screen. http(s) popups land here. */
  focusSession(sessionId) {
    this.foregroundSessionId = sessionId;
    return true;
  }

  ownsContents(contents) {
    return Boolean(this.sessionIdForContents(contents));
  }

  /** The persistent Electron partition backing a session's browser tabs. */
  partitionFor(sessionId) {
    return `persist:quansiox-browser-${require('node:crypto').createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 24)}`;
  }

  /**
   * Import already-parsed, grant-filtered cookie records into the session's
   * browser partition (authenticated browsing). Returns { set, failed }.
   */
  async applyCookies(sessionId, records = []) {
    let session;
    try { ({ session } = require('electron')); } catch { return { set: 0, failed: records.length, error: 'electron unavailable' }; }
    if (!session?.fromPartition) return { set: 0, failed: records.length, error: 'electron session unavailable' };
    const ses = session.fromPartition(this.partitionFor(sessionId));
    let set = 0; let failed = 0;
    for (const c of records) {
      try {
        await ses.cookies.set({
          url: `${c.secure ? 'https' : 'http'}://${c.domain}${c.path || '/'}`,
          name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
          secure: !!c.secure, httpOnly: !!c.httpOnly,
          ...(c.expires && c.expires < 2e10 ? { expirationDate: c.expires } : {}),
        });
        set += 1;
      } catch { failed += 1; }
    }
    return { set, failed };
  }

  sessionIdForContents(contents) {
    if (!contents) return null;
    for (const browser of this.browsers.values()) {
      for (const tab of browser.tabs.values()) {
        if (tab.view?.webContents === contents) return browser.sessionId;
      }
    }
    return null;
  }

  /** A popup from the Electron browser becomes another tab. It does not open Safari. */
  acceptPopup(contents, url) {
    const sessionId = this.sessionIdForContents(contents) || this.foregroundSessionId;
    if (sessionId && /^https?:/i.test(String(url || ''))) {
      this._openTab(sessionId, url).catch(() => {});
    }
  }

  /** http(s) from the workspace shell opens in the foreground session's browser. */
  openForeground(url) {
    const sessionId = this.foregroundSessionId;
    if (!sessionId || !/^https?:/i.test(String(url || ''))) return false;
    this.open(sessionId, { url }).catch(() => {});
    return true;
  }

  /** Mark this session's browser as the computer screen and tell the workspace. */
  present(sessionId) {
    const browser = this.ensure(sessionId);
    browser.presented = true;
    this.foregroundSessionId = sessionId;
    this._notifyState(sessionId);
    return this.state(sessionId);
  }

  _createTab(browser) {
    if (browser.tabs.size >= MAX_TABS) throw new Error(`too many tabs (max ${MAX_TABS})`);
    const tabId = `t${this.nextTabId++}`;
    const tab = new Tab(tabId, browser.sessionId);
    browser.tabs.set(tabId, tab);
    browser.activeTabId = tabId;
    this._attachActive(browser);
    this._notifyState(browser.sessionId);
    return tab;
  }

  async _openTab(sessionId, url) {
    const browser = this.ensure(sessionId);
    const tab = this._createTab(browser);
    await tab.view.webContents.loadURL(url);
    return tab;
  }

  _activeTab(sessionId) {
    const browser = this.ensure(sessionId);
    return browser.tabs.get(browser.activeTabId);
  }

  /* ---- window management ---- */

  showWindow(sessionId) {
    const { windowManager } = require('../windowManager');
    windowManager.createBrowserWindow(sessionId);
  }

  attachWindow(sessionId, win) {
    const browser = this.ensure(sessionId);
    if (browser.window && browser.window !== win) {
      try { win_content_detach(browser); } catch { /* previous host already gone */ }
    }
    browser.window = win;
    browser.dockBounds = null;
    browser.presented = true;
    this._attachActive(browser);
    this._notifyState(sessionId);
  }

  detachWindow(sessionId) {
    const browser = this.browsers.get(sessionId);
    if (!browser) return;
    try { win_content_detach(browser); } catch { /* already gone */ }
    browser.window = null;
    browser.dockBounds = null;
    this._notifyState(sessionId);
  }

  /**
   * Lay the active tab over the agent-computer viewport in `win`.
   * `bounds` are CSS pixels from that window's content origin.
   */
  dock(sessionId, win, bounds) {
    const browser = this.browsers.get(sessionId);
    if (!browser || !win || win.isDestroyed?.()) return false;
    const next = clampBounds(win, bounds);
    const tab = browser.tabs.get(browser.activeTabId);
    if (!next || !tab) return false;
    const wasPresented = browser.presented;
    const sameHost = browser.window === win;
    const previous = browser.dockBounds;
    const sameBounds = previous
      && previous.x === next.x && previous.y === next.y
      && previous.width === next.width && previous.height === next.height;
    if (browser.window && browser.window !== win) {
      try { win_content_detach(browser); } catch { /* previous host already gone */ }
    }
    browser.window = win;
    browser.dockBounds = next;
    browser.presented = true;
    let attached = false;
    try {
      attached = sameHost && Boolean(win.contentView?.children?.includes?.(tab.view));
    } catch { attached = false; }
    if (!attached) this._attachActive(browser);
    else if (!sameBounds) tab.view.setBounds(next);
    if (!wasPresented) this._notifyState(sessionId);
    return true;
  }

  /** Remove the page from the computer screen. The tab stays alive. */
  undock(sessionId, win) {
    const browser = this.browsers.get(sessionId);
    if (!browser?.dockBounds) return false;
    if (win && browser.window && browser.window !== win) return false;
    try { win_content_detach(browser); } catch { /* already gone */ }
    browser.window = null;
    browser.dockBounds = null;
    return true;
  }

  /** Stop showing the browser. The agent can still drive the same tabs. */
  hide(sessionId) {
    const browser = this.browsers.get(sessionId);
    if (!browser) return this.state(sessionId);
    browser.presented = false;
    if (browser.dockBounds || browser.window) {
      try { win_content_detach(browser); } catch { /* already gone */ }
      browser.window = null;
      browser.dockBounds = null;
    }
    this._notifyState(sessionId);
    return this.state(sessionId);
  }

  syncBounds(sessionId) {
    const browser = this.browsers.get(sessionId);
    if (!browser?.window || browser.window.isDestroyed?.()) return;
    const tab = browser.tabs.get(browser.activeTabId);
    if (!tab) return;
    tab.view.setBounds(browser.dockBounds ?? fullWindowBounds(browser.window));
  }

  _attachActive(browser) {
    try { win_content_detach(browser); } catch { /* nothing attached */ }
    if (!browser.window || browser.window.isDestroyed?.()) return;
    const tab = browser.tabs.get(browser.activeTabId);
    if (!tab) return;
    browser.window.contentView.addChildView(tab.view);
    this.syncBounds(browser.sessionId);
    if (!browser.dockBounds) {
      try {
        browser.window.setTitle(`${tab.title() || tab.url() || 'about:blank'} — Quansiox Browser`);
      } catch { /* stage hosts keep the workspace title */ }
    }
  }

  _notifyState(sessionId) {
    if (!this.browsers.has(sessionId)) return;
    try {
      const { emitEvent } = require('../ipc/emitEvent');
      emitEvent('browser', 'onState', this.state(sessionId));
    } catch { /* events are best-effort */ }
  }

  /* ---- tool surface (called from agentService relays) ---- */

  async open(sessionId, { url }) {
    this._assertAllowed();
    const target = normalizeUrl(url);
    const browser = this.ensure(sessionId);
    browser.presented = true;
    this.foregroundSessionId = sessionId;
    const tab = browser.tabs.get(browser.activeTabId);
    await tab.view.webContents.loadURL(target);
    await tab._waitForLoad();
    tab.documentRevision += 1; // loadURL may not fire did-navigate on first load
    this._notifyState(sessionId);
    return `opened ${tab.url()} (title: ${tab.title() || '—'})`;
  }

  async history(sessionId, action) {
    const tab = this._activeTab(sessionId);
    const wc = tab.view.webContents;
    const nav = wc.navigationHistory ?? wc;
    if (action === 'back') { if (nav.canGoBack?.()) nav.goBack(); }
    else if (action === 'forward') { if (nav.canGoForward?.()) nav.goForward(); }
    else if (action === 'reload') wc.reload?.();
    else throw new Error(`unknown history action: ${action}`);
    this._notifyState(sessionId);
    return this.state(sessionId);
  }

  async snapshot(sessionId) {
    this._assertAllowed();
    return this._activeTab(sessionId).snapshot();
  }

  async act(sessionId, method, args) {
    this._assertAllowed();
    const tab = this._activeTab(sessionId);
    if (['click', 'hover', 'type', 'press_key', 'scroll'].includes(method)) {
      // GPA G6: pointer/keyboard input is background-capable. A hidden view
      // gets focus emulation so CDP input lands without the window on screen;
      // the dispatch below is still the real action, so failures surface.
      const host = this.get(sessionId)?.window;
      const onScreen = host && !host.isDestroyed?.() && host.isVisible?.() !== false;
      if (!onScreen) await tab._enableBackgroundInput();
    }
    const fn = {
      click: tab.click.bind(tab),
      hover: tab.hover.bind(tab),
      type: tab.type.bind(tab),
      fill: tab.fill.bind(tab),
      select: tab.select.bind(tab),
      press_key: tab.pressKey.bind(tab),
      scroll: tab.scroll.bind(tab),
      screenshot: tab.screenshot.bind(tab),
      console: tab.console_.bind(tab),
      js: tab.js.bind(tab),
      wait: tab.wait.bind(tab),
      handle_dialog: tab.handleDialog.bind(tab),
    }[method];
    if (!fn) throw new Error(`unknown browser method: ${method}`);
    return fn(args ?? {});
  }

  /** Tab management. */
  async tabs(sessionId, action, args) {
    this._assertAllowed();
    const browser = this.ensure(sessionId);
    if (action === 'new') {
      const tab = this._createTab(browser);
      if (args?.url) await tab.view.webContents.loadURL(normalizeUrl(args.url));
      return `opened tab ${tab.tabId}${args?.url ? ` at ${args.url}` : ''}`;
    }
    if (action === 'list') {
      return [...browser.tabs.values()].map((t) => ({
        tabId: t.tabId, url: t.url(), title: t.title(), active: t.tabId === browser.activeTabId,
      }));
    }
    if (action === 'activate') {
      const id = String(args?.tabId ?? '');
      if (!browser.tabs.has(id)) throw new Error(`no tab ${id}`);
      browser.activeTabId = id;
      this._attachActive(browser);
      this._notifyState(sessionId);
      return `activated ${id}`;
    }
    if (action === 'close') {
      const id = String(args?.tabId ?? browser.activeTabId);
      const tab = browser.tabs.get(id);
      if (!tab) throw new Error(`no tab ${id}`);
      browser.tabs.delete(id);
      tab.destroy();
      if (browser.activeTabId === id) {
        browser.activeTabId = [...browser.tabs.keys()].pop() ?? null;
        if (!browser.activeTabId && browser.tabs.size === 0) this._createTab(browser);
        this._attachActive(browser);
      }
      this._notifyState(sessionId);
      return `closed ${id}`;
    }
    throw new Error(`unknown tab action: ${action}`);
  }

  state(sessionId) {
    const browser = this.browsers.get(sessionId);
    if (!browser) {
      return { sessionId, active: false, presented: false, docked: false, tabs: [] };
    }
    const tab = browser.tabs.get(browser.activeTabId);
    const wc = tab?.view.webContents;
    const nav = wc?.navigationHistory ?? wc;
    return {
      sessionId,
      active: true,
      presented: Boolean(browser.presented),
      docked: Boolean(browser.dockBounds) && Boolean(browser.window) && !browser.window.isDestroyed?.(),
      url: tab?.url() ?? null,
      title: tab?.title() ?? null,
      loading: Boolean(wc?.isLoadingMainFrame?.()),
      canGoBack: Boolean(nav?.canGoBack?.()),
      canGoForward: Boolean(nav?.canGoForward?.()),
      activeTabId: browser.activeTabId,
      tabs: [...browser.tabs.values()].map((t) => ({ tabId: t.tabId, url: t.url(), title: t.title() })),
      dialog: tab?.dialog ? { message: tab.dialog.message, type: tab.dialog.type } : null,
      windowOpen: Boolean(browser.window) && !browser.window.isDestroyed?.(),
    };
  }

  /** Tear down a session's browser (session delete / app quit). */
  destroy(sessionId) {
    const browser = this.browsers.get(sessionId);
    if (!browser) return;
    try { win_content_detach(browser); } catch { /* host already gone */ }
    for (const tab of browser.tabs.values()) tab.destroy();
    this.browsers.delete(sessionId);
  }

  /** App-quit: destroy every session browser. */
  _shutdownAll() {
    for (const sessionId of [...this.browsers.keys()]) this.destroy(sessionId);
  }
}

function win_content_detach(browser) {
  if (browser.window && !browser.window.isDestroyed?.()) {
    for (const tab of browser.tabs.values()) {
      try { browser.window.contentView.removeChildView(tab.view); } catch {}
    }
  }
}

function fullWindowBounds(win) {
  const [width, height] = win.getContentSize();
  return { x: 0, y: 0, width, height: Math.max(1, height) };
}

function clampBounds(win, bounds) {
  const x = Number(bounds?.x);
  const y = Number(bounds?.y);
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 1 || height < 1) return null;
  let cw = 1600;
  let ch = 1000;
  try {
    const size = win.getContentSize?.();
    if (Array.isArray(size) && size[0] > 0 && size[1] > 0) {
      cw = size[0];
      ch = size[1];
    }
  } catch { /* use the fallback content box */ }
  const nextWidth = Math.max(1, Math.min(Math.round(width), cw));
  const nextHeight = Math.max(1, Math.min(Math.round(height), ch));
  return {
    x: Math.max(0, Math.min(Math.round(x), Math.max(0, cw - nextWidth))),
    y: Math.max(0, Math.min(Math.round(y), Math.max(0, ch - nextHeight))),
    width: nextWidth,
    height: nextHeight,
  };
}

module.exports = { browserService: new BrowserService(), BrowserService, Tab };
