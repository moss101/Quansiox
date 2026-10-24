'use strict';
/**
 * Guest browser driver — drives the per-bot Linux VM's Chromium over CDP.
 *
 * The desktop guest runs Chromium with `--remote-debugging-port=9222`; the VM
 * publishes that loopback port as a 0600 Unix socket (`<sockDir>/9222.sock`)
 * over virtio-vsock. No screenshots or RFB pixel traffic are involved: the
 * agent calls the same browser_* tools (open/snapshot/click/type/fill/…), and
 * this service speaks the DevTools protocol to the guest Chromium.
 *
 * The ref/staleness model is shared with the host WebContentsView browser
 * (`browserSnapshot.js`), so a snapshot from either runtime is acted on the
 * same way. One CDP page target is active per bot; extra targets are tabs.
 */
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { buildBrowserSnapshot } = require('./browserSnapshot');
const { KEYCODES, MODBITS, normalizeUrl } = require('./browserProtocol');

const CONNECT_TIMEOUT_MS = 12_000;
const COMMAND_TIMEOUT_MS = 20_000;
const CONSOLE_CAP = 100;
const CONSOLE_LINE_CAP = 500;
const TEXT_CAP = 100_000;

function browserError(code, extra = '') {
  return { __browserError: code, message: `${code}${extra ? ` — ${extra}` : ''}` };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpJson(sockPath, path, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sockPath, path, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`CDP ${path} returned non-JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`CDP ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

/** Poll /json/version until the guest Chromium answers over the vsock socket. */
async function discoverBrowser(sockPath, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const info = await httpJson(sockPath, '/json/version');
      if (info?.webSocketDebuggerUrl) return info;
      last = new Error('CDP endpoint has no webSocketDebuggerUrl');
    } catch (error) { last = error; }
    await sleep(150);
  }
  throw new Error(`guest Chromium CDP did not answer on the VM socket${last ? ` (${last.message})` : ''}`);
}

class CdpClient {
  constructor(sockPath, wsUrl, ws) {
    this.sockPath = sockPath;
    this.wsUrl = wsUrl;
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.on('message', (data) => this._onMessage(data));
    ws.on('close', () => this._onClose(new Error('guest CDP connection closed')));
    ws.on('error', (error) => this._onClose(error));
  }

  static async connect(sockPath, opts = {}) {
    const info = await discoverBrowser(sockPath, opts);
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(info.webSocketDebuggerUrl, {
        createConnection: () => net.connect(sockPath),
        perMessageDeflate: false,
        handshakeTimeout: opts.timeoutMs || CONNECT_TIMEOUT_MS,
      });
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
    return new CdpClient(sockPath, info.webSocketDebuggerUrl, ws);
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message || `CDP error ${msg.error.code}`));
      else waiter.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    for (const listener of this.listeners) {
      try { listener(msg.method, msg.params ?? {}, msg.sessionId); } catch { /* listener errors are isolated */ }
    }
  }

  _onClose(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) {
      try { listener('__closed', {}, undefined); } catch { /* ignore */ }
    }
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  send(method, params = {}, sessionId, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('guest CDP connection is not open'));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`guest CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(payload)); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    try { this.ws.close(); } catch {}
    this._onClose(new Error('guest CDP connection closed'));
  }
}

class GuestTab {
  constructor(sessionId, cdp) {
    this.sessionId = sessionId;
    this.cdp = cdp;
    this.client = null;
    this.targets = new Map();
    this.sessions = new Map();
    this.activeTargetId = null;
    this.enabled = new Set();
    this.documentRevision = 0;
    this.mutationGeneration = 0;
    this.lastSnapshot = null;
    this.console = [];
    this.dialog = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client && !this.client.closed) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const sockPath = socketProvider(this.sessionId);
      if (!sockPath) throw new Error('guest browser unavailable: this bot has no Linux VM CDP endpoint');
      const client = await CdpClient.connect(sockPath);
      this.client = client;
      client.onEvent((method, params, sessionId) => this._onEvent(method, params, sessionId));
      await client.send('Target.setDiscoverTargets', { discover: true });
      await this.refreshTargets();
      if (!this.activeTargetId) {
        const first = [...this.targets.keys()][0] || null;
        this.activeTargetId = first;
      }
      if (this.activeTargetId) await this.attach(this.activeTargetId);
    })();
    try { await this.connecting; } finally { this.connecting = null; }
  }

  async refreshTargets() {
    const out = await this.client.send('Target.getTargets');
    const pages = (out.targetInfos ?? []).filter(
      (t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
    this.targets = new Map(pages.map((t) => [t.targetId, {
      targetId: t.targetId, url: t.url || 'about:blank', title: t.title || '',
    }]));
    if (this.activeTargetId && !this.targets.has(this.activeTargetId)) this.activeTargetId = null;
    if (!this.activeTargetId) this.activeTargetId = pages[0]?.targetId ?? null;
  }

  async attach(targetId) {
    if (!targetId) throw new Error('guest browser has no page target');
    let sessionId = this.sessions.get(targetId);
    if (sessionId) return sessionId;
    const out = await this.client.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = out.sessionId;
    if (!sessionId) throw new Error('guest CDP did not attach to the page');
    this.sessions.set(targetId, sessionId);
    return sessionId;
  }

  async _pageSession() {
    await this.connect();
    await this.attach(this.activeTargetId);
    return this.sessions.get(this.activeTargetId);
  }

  async _enableDomains(sessionId) {
    if (this.enabled.has(sessionId)) return;
    await Promise.all([
      this.cdpSend('Page.enable', {}, sessionId),
      this.cdpSend('Runtime.enable', {}, sessionId),
      this.cdpSend('Accessibility.enable', {}, sessionId),
      this.cdpSend('DOM.enable', {}, sessionId),
      this.cdpSend('Network.enable', {}, sessionId),
    ]);
    this.enabled.add(sessionId);
  }


  cdpSend(method, params = {}, sessionId, opts) {
    return this.client.send(method, params, sessionId, opts);
  }

  async page(method, params = {}, opts) {
    const sessionId = await this._pageSession();
    await this._enableDomains(sessionId);
    return this.cdpSend(method, params, sessionId, opts);
  }

  async _installMutationObserver() {
    await this.page('Runtime.enable');
    await this.page('Runtime.addBinding', { name: '__qxMut' });
    await this.page('Runtime.evaluate', {
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

  _onEvent(method, params, sessionId) {
    if (method === '__closed') {
      this.client = null;
      this.sessions.clear();
      this.enabled.clear();
      this.lastSnapshot = null;
      return;
    }
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = params.targetInfo;
      if (info?.type === 'page' && !String(info.url || '').startsWith('devtools://')) {
        this.targets.set(info.targetId, {
          targetId: info.targetId, url: info.url || 'about:blank', title: info.title || '',
        });
      } else if (info?.type === 'page') {
        this.targets.delete(info.targetId);
      }
      return;
    }
    if (method === 'Target.targetDestroyed') {
      this.targets.delete(params.targetId);
      this.sessions.delete(params.targetId);
      if (this.activeTargetId === params.targetId) this.activeTargetId = [...this.targets.keys()][0] ?? null;
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      for (const [targetId, sid] of this.sessions) {
        if (sid === params.sessionId) { this.sessions.delete(targetId); this.enabled.delete(sid); }
      }
      return;
    }
    if (sessionId && sessionId !== this.sessions.get(this.activeTargetId)) return;
    if (method === 'Page.frameNavigated') {
      if (!params.frame?.parentId) this.documentRevision += 1;
      return;
    }
    if (method === 'Page.navigatedWithinDocument') { this.documentRevision += 1; return; }
    if (method === 'Runtime.bindingCalled' && params.name === '__qxMut') { this.mutationGeneration += 1; return; }
    if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
      this.console.push(String(text).slice(0, CONSOLE_LINE_CAP));
      if (this.console.length > CONSOLE_CAP) this.console.splice(0, this.console.length - CONSOLE_CAP);
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const detail = params.exceptionDetails;
      this.console.push(String(detail?.exception?.description || detail?.text || 'exception').slice(0, CONSOLE_LINE_CAP));
      if (this.console.length > CONSOLE_CAP) this.console.splice(0, this.console.length - CONSOLE_CAP);
      return;
    }
    if (method === 'Page.javascriptDialogOpening') {
      this.dialog = { message: String(params.message ?? ''), type: String(params.type ?? 'alert') };
      return;
    }
    if (method === 'Page.javascriptDialogClosed') { this.dialog = null; }
  }

  async open({ url }) {
    const target = normalizeUrl(url);
    await this.connect();
    const out = await this.page('Page.navigate', { url: target });
    if (out?.errorText) throw new Error(`navigation failed: ${out.errorText}`);
    await this._waitForLoad(8000);
    const meta = await this._evaluate(`JSON.stringify({ url: location.href, title: document.title })`);
    let parsed = null;
    try { parsed = JSON.parse(meta); } catch { /* page returned odd metadata */ }
    this.documentRevision += 1;
    return `opened ${parsed?.url || target} (title: ${parsed?.title || '—'})`;
  }

  async snapshot() {
    await this._installMutationObserver();
    await this.page('Accessibility.enable');
    const [dom, ax] = await Promise.all([
      this.page('DOMSnapshot.captureSnapshot', {
        computedStyles: [],
        includeDOMRects: true,
        includePaintOrder: false,
      }, { timeoutMs: 30_000 }),
      this.page('Accessibility.getFullAXTree', {}, { timeoutMs: 30_000 }),
    ]);
    const snapshotId = `snap_${crypto.randomUUID()}`;
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

  _staleness(snapshotId) {
    const { browserStaleness } = require('../../coordinator/freshness');
    const refusal = browserStaleness(snapshotId, this.lastSnapshot?.snapshotId ?? null);
    if (refusal) return refusal;
    if (!this.lastSnapshot) return null;
    if (this.lastSnapshot.documentRevision !== this.documentRevision
      || this.lastSnapshot.mutationGeneration !== this.mutationGeneration) {
      return 'page changed since this snapshot — run browser_snapshot again';
    }
    return null;
  }

  _resolveRef(ref) {
    return this.lastSnapshot?.refs.get(String(ref)) ?? null;
  }

  async _evaluate(expression, { awaitPromise = false } = {}) {
    const out = await this.page('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    return out?.result?.value;
  }

  async _scrollIntoView(backend) {
    const resolved = await this.page('DOM.resolveNode', { backendNodeId: backend });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return;
    await this.page('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { this.scrollIntoView({ block: "center", inline: "nearest" }); }',
      awaitPromise: false,
    });
  }

  async _showAgentCursor(x, y) {
    const px = Math.round(Number(x) || 0);
    const py = Math.round(Number(y) || 0);
    try {
      await this._evaluate(`(() => {
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
      })()`);
    } catch { /* pointer is cosmetic */ }
  }

  async click({ ref, x, y, snapshot_id }) {
    const stale = this._staleness(snapshot_id);
    if (stale) return browserError('STALE_PAGE', stale);
    let cx;
    let cy;
    if (ref !== undefined) {
      const node = this._resolveRef(ref);
      if (!node) return browserError('STALE_REF', `unknown ref ${ref}`);
      await this._scrollIntoView(node.backend);
      const model = await this.page('DOM.getBoxModel', { backendNodeId: node.backend }).catch(() => null);
      const q = model?.model?.content ?? model?.model?.border;
      if (q && q.length >= 6) {
        cx = (q[0] + q[2]) / 2;
        cy = (q[1] + q[5]) / 2;
      } else if (node.box) {
        cx = node.box.x + node.box.width / 2;
        cy = node.box.y + node.box.height / 2;
      } else return browserError('REF_NOT_INTERACTABLE', `ref ${ref} has no rect`);
    } else {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return browserError('INVALID_COORDINATES', 'provide ref or x/y');
      }
      cx = x;
      cy = y;
    }
    await this._showAgentCursor(cx, cy);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.page('Input.dispatchMouseEvent', {
        type, x: Math.round(cx), y: Math.round(cy), button: 'left', clickCount: 1,
      });
    }
    return `clicked ${ref ? `ref=${ref}` : `(${Math.round(cx)}, ${Math.round(cy)})`}`;
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
    await this.page('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(cx), y: Math.round(cy),
    });
    return `hovered ref=${ref}`;
  }

  async type({ ref, text, submit = false, snapshot_id }) {
    const stale = this._staleness(snapshot_id);
    if (stale) return browserError('STALE_PAGE', stale);
    if (typeof text !== 'string' || !text) return browserError('INVALID_ARGUMENT', 'text required');
    if (ref !== undefined) {
      const clicked = await this.click({ ref, snapshot_id });
      if (clicked?.__browserError) return clicked;
    }
    await this.page('Input.insertText', { text });
    if (submit) {
      await this.pressKey({ key: 'Enter' });
      await this._waitForLoad();
    }
    return `typed ${text.length} chars${submit ? ' + Enter' : ''}`;
  }

  async fill({ ref, value, snapshot_id }) {
    const stale = this._staleness(snapshot_id);
    if (stale) return browserError('STALE_PAGE', stale);
    const node = this._resolveRef(ref);
    if (!node) return browserError('STALE_REF', `unknown ref ${ref}`);
    const resolved = await this.page('DOM.resolveNode', { backendNodeId: node.backend });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return browserError('STALE_REF', 'node detached');
    const out = await this.page('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (value) {
        const el = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
        if (!el || !('value' in el)) return { ok: false, reason: 'not_fillable' };
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        desc && desc.set ? desc.set.call(el, value) : (el.value = value);
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
    const resolved = await this.page('DOM.resolveNode', { backendNodeId: node.backend });
    const objectId = resolved?.object?.objectId;
    const out = await this.page('Runtime.callFunctionOn', {
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
    await this.page('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      key, code: code.name ?? key, windowsVirtualKeyCode: code.code,
      nativeVirtualKeyCode: code.code, modifiers: modBits, text: text || undefined,
    });
    if (text) {
      await this.page('Input.dispatchKeyEvent', {
        type: 'char', key, windowsVirtualKeyCode: code.code, modifiers: modBits, text,
      });
    }
    await this.page('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code: code.name ?? key,
      windowsVirtualKeyCode: code.code, modifiers: modBits,
    });
    return `pressed ${key}`;
  }

  async scroll({ direction = 'down', amount = 600, ref }) {
    const deltas = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const [dx, dy] = deltas[String(direction).toLowerCase()] ?? deltas.down;
    let x = 100;
    let y = 100;
    if (ref !== undefined) {
      const node = this._resolveRef(ref);
      if (node?.box) { x = node.box.x + node.box.width / 2; y = node.box.y + node.box.height / 2; }
    }
    await this.page('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(x), y: Math.round(y),
      deltaX: dx * Math.max(1, amount), deltaY: dy * Math.max(1, amount),
    });
    return `scrolled ${direction} ${amount}`;
  }

  async screenshot() {
    const [shot, metrics] = await Promise.all([
      this.page('Page.captureScreenshot', { format: 'png' }),
      this.page('Page.getLayoutMetrics').catch(() => null),
    ]);
    const viewport = metrics?.cssVisualViewport ?? metrics?.visualViewport ?? {};
    return {
      id: `bshot-${Date.now().toString(36)}`,
      data: `data:image/png;base64,${shot?.data ?? ''}`,
      width: Math.round(viewport.clientWidth ?? 0),
      height: Math.round(viewport.clientHeight ?? 0),
    };
  }

  async js({ code, timeoutMs = 10_000 }) {
    if (typeof code !== 'string' || !code.trim()) return browserError('INVALID_ARGUMENT', 'code required');
    const timeout = Math.min(30_000, Math.max(1000, Number(timeoutMs) || 10_000));
    const out = await this.page('Runtime.evaluate', {
      expression: code, awaitPromise: true, returnByValue: true,
    }, { timeoutMs: timeout }).catch((error) => ({ exceptionDetails: { text: String(error?.message ?? error) } }));
    if (out?.exceptionDetails) {
      const d = out.exceptionDetails;
      return browserError('JS_ERROR', `${d.text ?? ''} ${d.exception?.description ?? ''}`.slice(0, 500));
    }
    const value = out?.result?.value;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return (text ?? 'undefined').slice(0, TEXT_CAP);
  }

  async wait({ text, ms, selector, timeoutMs = 10_000 }) {
    const started = Date.now();
    const deadline = started + Math.min(30_000, Math.max(1000, Number(timeoutMs) || 10_000));
    if (Number.isFinite(ms) && ms > 0) {
      await sleep(Math.min(30_000, ms));
      return `waited ${ms}ms`;
    }
    if (text || selector) {
      const expr = selector
        ? `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        : `document.body && document.body.innerText.includes(${JSON.stringify(text)})`;
      while (Date.now() < deadline) {
        const matched = await this._evaluate(expr);
        if (matched === true) {
          return `matched ${selector ? `selector ${selector}` : `text "${text}"`} after ${Date.now() - started}ms`;
        }
        await sleep(250);
      }
      return browserError('WAIT_TIMEOUT', `${selector ? `selector ${selector}` : `text "${text}"`} not found`);
    }
    return browserError('INVALID_ARGUMENT', 'provide text, selector, or ms');
  }

  async handleDialog({ accept = true, text = '' } = {}) {
    if (!this.dialog) return browserError('STALE_DIALOG', 'no dialog pending');
    const { message } = this.dialog;
    await this.page('Page.handleJavaScriptDialog', { accept: Boolean(accept), promptText: String(text ?? '') });
    this.dialog = null;
    return `${accept ? 'accepted' : 'dismissed'} dialog: "${message.slice(0, 200)}"`;
  }

  console_({ limit = 20 } = {}) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.console.slice(-n);
  }

  async _waitForLoad(ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const ready = await this._evaluate('document.readyState');
        if (ready === 'complete' || ready === 'interactive') return;
      } catch { /* navigation may be in flight */ }
      await sleep(100);
    }
  }

  async act(method, args = {}) {
    const fn = {
      click: () => this.click(args),
      hover: () => this.hover(args),
      type: () => this.type(args),
      fill: () => this.fill(args),
      select: () => this.select(args),
      press_key: () => this.pressKey(args),
      scroll: () => this.scroll(args),
      screenshot: () => this.screenshot(args),
      console: () => this.console_(args),
      js: () => this.js(args),
      wait: () => this.wait(args),
      handle_dialog: () => this.handleDialog(args),
    }[method];
    if (!fn) throw new Error(`unknown browser method: ${method}`);
    return fn();
  }

  async tabs(action, args = {}) {
    await this.connect();
    await this.refreshTargets();
    if (action === 'list') {
      return [...this.targets.values()].map((t) => ({
        tabId: t.targetId, url: t.url, title: t.title, active: t.targetId === this.activeTargetId,
      }));
    }
    if (action === 'new') {
      const url = args?.url ? normalizeUrl(args.url) : 'about:blank';
      const out = await this.cdpSend('Target.createTarget', { url });
      this.activeTargetId = out.targetId;
      await this.attach(out.targetId);
      return `opened tab ${out.targetId}${args?.url ? ` at ${args.url}` : ''}`;
    }
    if (action === 'activate') {
      const id = String(args?.tabId ?? '');
      if (!this.targets.has(id)) throw new Error(`no tab ${id}`);
      this.activeTargetId = id;
      await this.cdpSend('Target.activateTarget', { targetId: id }).catch(() => {});
      await this.attach(id);
      return `activated ${id}`;
    }
    if (action === 'close') {
      const id = String(args?.tabId ?? this.activeTargetId);
      if (!this.targets.has(id)) throw new Error(`no tab ${id}`);
      await this.cdpSend('Target.closeTarget', { targetId: id });
      this.targets.delete(id);
      this.sessions.delete(id);
      if (this.activeTargetId === id) this.activeTargetId = [...this.targets.keys()][0] ?? null;
      if (!this.activeTargetId) {
        const created = await this.cdpSend('Target.createTarget', { url: 'about:blank' });
        this.activeTargetId = created.targetId;
        await this.attach(created.targetId);
      }
      return `closed ${id}`;
    }
    throw new Error(`unknown tab action: ${action}`);
  }

  async state() {
    await this.connect();
    await this.refreshTargets();
    const tab = this.targets.get(this.activeTargetId);
    let title = tab?.title ?? null;
    let url = tab?.url ?? null;
    try {
      const meta = await this._evaluate('JSON.stringify({ url: location.href, title: document.title })');
      const parsed = JSON.parse(meta);
      url = parsed.url ?? url;
      title = parsed.title ?? title;
    } catch { /* the page may be navigating */ }
    return {
      sessionId: this.sessionId,
      active: true,
      presented: true,
      docked: false,
      runtime: 'linux-vm',
      url,
      title,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      activeTabId: this.activeTargetId,
      tabs: [...this.targets.values()].map((t) => ({
        tabId: t.targetId, url: t.url, title: t.title,
      })),
      dialog: this.dialog ? { message: this.dialog.message, type: this.dialog.type } : null,
      windowOpen: false,
    };
  }

  async applyCookies(records = []) {
    await this.connect();
    let set = 0;
    let failed = 0;
    for (const c of records) {
      try {
        const domain = String(c.domain || '').replace(/^\.+/, '');
        if (!domain || !c.name) throw new Error('missing cookie fields');
        const params = {
          name: String(c.name),
          value: String(c.value ?? ''),
          url: `${c.secure ? 'https' : 'http'}://${domain}${c.path || '/'}`,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
        };
        const expires = Number(c.expires);
        if (expires > 0 && expires < 2e10) params.expires = expires;
        await this.page('Network.setCookie', params);
        set += 1;
      } catch { failed += 1; }
    }
    return { set, failed };
  }

  destroy() {
    try { this.client?.close(); } catch {}
    this.client = null;
  }
}

/** sessionId -> GuestTab */
const tabs = new Map();
let socketProvider = (sessionId) => {
  try { return require('./desktopVmService').desktopVmService.cdpSockFor(sessionId); } catch { return null; }
};

function setSocketProvider(fn) {
  socketProvider = typeof fn === 'function' ? fn : socketProvider;
}

function tabFor(sessionId) {
  const sid = String(sessionId ?? '');
  if (!sid) throw new Error('sessionId is required');
  let tab = tabs.get(sid);
  if (!tab) { tab = new GuestTab(sid); tabs.set(sid, tab); }
  return tab;
}

async function open(sessionId, args) { return tabFor(sessionId).open(args ?? {}); }
async function snapshot(sessionId) { return tabFor(sessionId).snapshot(); }
async function act(sessionId, method, args) { return tabFor(sessionId).act(method, args); }
async function tabsAction(sessionId, action, args) { return tabFor(sessionId).tabs(action, args); }
async function state(sessionId) { return tabFor(sessionId).state(); }
async function applyCookies(sessionId, records) { return tabFor(sessionId).applyCookies(records); }
function destroy(sessionId) {
  const tab = tabs.get(String(sessionId));
  if (tab) { tab.destroy(); tabs.delete(String(sessionId)); }
}
function shutdownAll() {
  for (const tab of tabs.values()) tab.destroy();
  tabs.clear();
}

module.exports = {
  guestBrowserService: {
    open, snapshot, act, tabs: tabsAction, state, applyCookies, destroy, shutdownAll,
    setSocketProvider, resetSocketProvider: () => { socketProvider = (sessionId) => {
      try { return require('./desktopVmService').desktopVmService.cdpSockFor(sessionId); } catch { return null; }
    }; },
  },
  GuestTab,
  _discoverBrowser: discoverBrowser,
};
