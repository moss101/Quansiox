'use strict';
/**
 * Screen transport bridge (unified-computer-runtime Phase 0).
 *
 * A per-session websockify-style bridge: the sandboxed renderer opens a
 * WebSocket (ws://127.0.0.1:<ephemeral>) carrying the RFB/remote-desktop byte
 * stream; we forward it bidirectionally to a per-session **target** (a Unix
 * socket or TCP host:port serving RFB). The target is the guest screen server,
 * which is supplied by the VM adapter once guest-graphics (Phase 1, Swift/VZ)
 * lands — until then the bridge is inert but fully wired + tested.
 *
 * Electron-free; backing transport is `ws`. See
 * docs/unified-computer-runtime.md for the full plan.
 */
const net = require('node:net');
const { WebSocketServer } = require('ws');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class ScreenBridge {
  constructor() {
    /** sessionId -> { wss, ready:Promise, port:number|null, target:{path}|{host,port}|null, clients:Set } */
    this.sessions = new Map();
  }

  _ensure(sessionId) {
    if (!ID_RE.test(String(sessionId || ''))) throw new Error('invalid session id');
    const sid = String(sessionId);
    const existing = this.sessions.get(sid);
    if (existing) return existing;
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    // noVNC/websockify negotiates the "binary" WebSocket subprotocol; accept it
    // so an RFB client handshake succeeds against the bridge.
    wss.handleProtocols = (protocols) => (protocols.has('binary') ? 'binary' : false);
    const entry = {
      wss, sid, port: null, target: null, clients: new Set(),
      ready: new Promise((resolve) => {
        const done = () => { entry.port = wss.address().port; resolve(); };
        if (wss._server?.listening) done();
        else wss.once('listening', done);
      }),
    };
    wss.on('connection', (ws) => this._onConnection(entry, ws));
    wss.on('error', () => {});
    this.sessions.set(sid, entry);
    return entry;
  }

  async attach(sessionId, target) {
    const entry = this._ensure(sessionId);
    if (target && !target.path && !(target.host && target.port)) throw new Error('target needs { path } or { host, port }');
    entry.target = target ? (target.path ? { path: String(target.path) } : { host: String(target.host || '127.0.0.1'), port: Number(target.port) }) : null;
    await entry.ready;
    return this.info(sessionId);
  }

  async info(sessionId) {
    const entry = this.sessions.get(String(sessionId || ''));
    if (!entry) return { sessionId, ready: false, port: null, target: null, clients: 0 };
    await entry.ready;
    return { sessionId, ready: true, port: entry.port, target: entry.target, clients: entry.clients.size };
  }

  url(sessionId) {
    const entry = this.sessions.get(String(sessionId || ''));
    return entry?.port ? `ws://127.0.0.1:${entry.port}` : null;
  }

  _onConnection(entry, ws) {
    if (!entry.target) { try { ws.close(1011, 'no screen target'); } catch {} return; }
    const backend = entry.target.path
      ? net.connect(entry.target.path)
      : net.connect(entry.target.port, entry.target.host || '127.0.0.1');
    entry.clients.add(ws);
    const teardown = () => { entry.clients.delete(ws); try { backend.destroy(); } catch {} };
    backend.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    backend.on('close', () => { try { ws.close(1011, 'backend closed'); } catch {} teardown(); });
    backend.on('error', () => { try { ws.close(1011, 'backend error'); } catch {} teardown(); });
    ws.on('message', (d) => { if (!backend.destroyed) backend.write(Buffer.isBuffer(d) ? d : Buffer.from(d)); });
    ws.on('close', teardown);
    ws.on('error', teardown);
  }

  close(sessionId) {
    const entry = this.sessions.get(String(sessionId || ''));
    if (!entry) return false;
    for (const ws of entry.clients) { try { ws.terminate(); } catch {} }
    entry.clients.clear();
    try { entry.wss.close(); } catch {}
    this.sessions.delete(String(sessionId));
    return true;
  }

  _shutdownAll() { for (const sid of [...this.sessions.keys()]) this.close(sid); }
}

module.exports = { screenBridge: new ScreenBridge(), ScreenBridge };
