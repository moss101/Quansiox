'use strict';
/**
 * Guest computer bridge — routes the coordinator's Mac-style computer_* methods
 * to the live guest over the RFB socket (via the rfbClient from v2.40) when a
 * guest RFB client is attached for the session. Main owns the RFB connection
 * (attached on desktop boot), so routing here ALWAYS replies (no fork-loop proxy
 * that can hang). ASCII typing uses keySym == code point; \n/Return = 0xff0d.
 *
 * Client factory + connect/typing are injectable → mapping + routing are unit
 * tested offline; driving a live guest X is hardware-gated (prototyped).
 */
let clientFactory = null; // (sessionId, rfbSock, opts) => Promise<client>
function setClientFactory(fn) { clientFactory = typeof fn === 'function' ? fn : null; }

/** Built-in factory: connect the guest RFB socket and complete the handshake.
 * The app used to install this only from main/index.js, which left the runtime
 * screen-only when it booted before that hook; a default keeps boot paths whole. */
function defaultClientFactory(sessionId, rfbSock) {
  const net = require('node:net');
  const { rfbClient } = require('./rfbClient');
  return new Promise((resolve, reject) => {
    const dup = net.connect(rfbSock);
    const client = rfbClient.connect(dup);
    dup.on('error', reject);
    client.handshake().then(() => {
      client.close = () => { try { dup.end(); } catch {} };
      resolve(client);
    }).catch(reject);
  });
}

/** sessionId -> rfb client (handshake completed) */
const clients = new Map();
function get(sessionId) { return clients.get(String(sessionId)) || null; }

async function attach(sessionId, rfbSock, opts = {}) {
  const existing = clients.get(String(sessionId));
  if (existing) return existing;
  if (!clientFactory) clientFactory = defaultClientFactory;
  const client = await clientFactory(sessionId, rfbSock, opts);
  clients.set(String(sessionId), client);
  return client;
}
function isAttached(sessionId) { return clients.has(String(sessionId)); }
function detach(sessionId) {
  try { clients.get(String(sessionId))?.close?.(); } catch {}
  clients.delete(String(sessionId));
  gates.delete(String(sessionId));
}

const keySym = (ch) => (ch === '\n' || ch === '\r' ? 0xff0d : ch.charCodeAt(0));
const { FreshnessGate, frameHashFromBytes } = require('../../coordinator/freshness');
const { encodePNG } = require('./pngEncode');

/** Per-session coordinate-token gate — same contract as the Mac computer service. */
const gates = new Map();
function gateFor(sessionId) {
  const sid = String(sessionId);
  let gate = gates.get(sid);
  if (!gate) { gate = new FreshnessGate(); gates.set(sid, gate); }
  return gate;
}
async function typeText(client, text) {
  for (const ch of String(text ?? '')) {
    const k = keySym(ch);
    client.keyEvent(k, true);
    // tiny pacing so the guest X key repeat doesn't coalesce
    await new Promise((r) => setTimeout(r, 4));
    client.keyEvent(k, false);
  }
}

/**
 * Route a Mac-style computer method into the guest. Result shapes match the Mac
 * service where the agent consumes them: `screenshot` returns
 * `{ id, data, width, height, coordinateToken, frameHash, screenChanged }`, and
 * coordinate actions gate on that token (model-facing refusal text).
 */
async function computer(sessionId, method, args = {}) {
  const sid = String(sessionId);
  const client = clients.get(sid);
  if (!client) throw new Error(`no attached guest for session ${sessionId}`);
  const gate = gateFor(sid);
  switch (method) {
    case 'screenshot': {
      const frame = await client.capture(); // RFB FramebufferUpdate → RGBA
      const png = encodePNG(frame.rgba, frame.width, frame.height);
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      const frameHash = frameHashFromBytes(png);
      const issued = gate.issueCoordinate(frameHash);
      return {
        id: `shot-${Date.now().toString(36)}`,
        data: dataUrl,
        dataUrl,
        width: frame.width,
        height: frame.height,
        bytes: png.length,
        coordinateToken: issued.token,
        frameHash: issued.frameHash,
        screenChanged: issued.screenChanged,
      };
    }
    case 'click': {
      const provided = args.coordinate_token ?? args.coordinateToken;
      const refusal = gate.requireCoordinate(provided);
      if (refusal) return refusal;
      const x = Math.round(Number(args.x) || 0);
      const y = Math.round(Number(args.y) || 0);
      client.leftClick(x, y);
      return `clicked (${x}, ${y})`;
    }
    case 'rightClick': client.rightClick(args.x, args.y); return { ok: true, method: 'rightClick' };
    case 'scroll': client.scroll(args.x, args.y, args.deltaY); return `scrolled ${Number(args.deltaY) > 0 ? 'up' : 'down'} at (${Math.round(Number(args.x) || 0)}, ${Math.round(Number(args.y) || 0)})`;
    case 'move': client.move(args.x, args.y); return { ok: true, method: 'move' };
    case 'typeText': await typeText(client, args.text); return `typed ${String(args.text ?? '').length} chars`;
    case 'pressKey': {
      const mods = (args.modifiers || []).map((m) => MOD_KEYSYM[m.toLowerCase()]).filter(Boolean);
      const k = keySymFor(args.key);
      for (const m of mods) client.keyEvent(m, true);
      client.keyEvent(k, true); await new Promise((r) => setTimeout(r, 8)); client.keyEvent(k, false);
      for (const m of mods.reverse()) client.keyEvent(m, false);
      return `pressed ${args.key}${args.modifiers?.length ? ` (+${args.modifiers.join(',')})` : ''}`;
    }
    default:
      // ax_tree/find/set_value/open_app/list_apps are Mac-AX specific; the guest
      // has no accessibility tree — report honestly.
      return { ok: false, reason: `guest computer does not provide ${method} (no accessibility tree); use screenshot + click/type` };
  }
}

const MOD_KEYSYM = { command: 0xffe9, meta: 0xffe7, shift: 0xffe1, control: 0xffe3, ctrl: 0xffe3, alt: 0xffe9, option: 0xffea, super: 0xffeb };
function keySymFor(key) {
  const k = String(key ?? '');
  if (/^[ -~]$/.test(k)) return k.charCodeAt(0); // printable ASCII
  const named = { Return: 0xff0d, Enter: 0xff0d, Tab: 0xff09, Escape: 0xff1b, Backspace: 0xff08, Delete: 0xffff, Up: 0xff52, Down: 0xff54, Left: 0xff51, Right: 0xff53, Space: 0x0020 };
  return named[k] ?? k.charCodeAt(0);
}

module.exports = { guestComputerBridge: { setClientFactory, attach, isAttached, detach, computer, get } };
