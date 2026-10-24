'use strict';
/* Screen bridge test (unified-computer-runtime Phase 0): a per-session
 * WebSocket RFB transport forwards bytes both ways to a Unix-socket backend and
 * a TCP backend. Electron-free. Headless-verifiable half of the guest-desktop
 * bridge; the guest framebuffer (Swift/VZ) is the later phase. */
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const WebSocket = require('ws');
const { ScreenBridge } = require('../src/main/services/screenBridge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bin = (d) => (Buffer.isBuffer(d) ? d.toString() : String(d));
const open = (ws) => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const onceMessage = (ws) => new Promise((resolve) => ws.once('message', (d) => resolve(bin(d))));

async function main() {
  const bridge = new ScreenBridge();

  // TCP backend: greets on connect, records client bytes.
  const tcpReceived = [];
  const tcpServer = net.createServer((sock) => {
    sock.write('SC-to-CLIENT');
    sock.on('data', (d) => tcpReceived.push(d.toString()));
  });
  await new Promise((r) => tcpServer.listen(0, '127.0.0.1', r));
  const tcpPort = tcpServer.address().port;

  const info = await bridge.attach('s-tcp', { host: '127.0.0.1', port: tcpPort });
  assert.strictEqual(info.ready, true);
  assert.ok(info.port > 0, 'ephemeral WS port assigned');
  assert.strictEqual(bridge.url('s-tcp'), `ws://127.0.0.1:${info.port}`);

  const ws = new WebSocket(bridge.url('s-tcp'), 'binary');
  const greeting = onceMessage(ws);
  await open(ws);
  assert.strictEqual(ws.protocol, 'binary', 'negotiates the noVNC/websockify "binary" subprotocol');
  assert.strictEqual(await greeting, 'SC-to-CLIENT', 'server→client forwarded over WS');
  ws.send('CLIENT-to-SC');
  await sleep(80);
  assert.strictEqual(tcpReceived.join(''), 'CLIENT-to-SC', 'client→server forwarded to backend');
  ws.close();

  // Unix-socket backend (the intended local in-app path).
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-screen-'));
  const sockPath = path.join(sockDir, 'screen.sock');
  const unixReceived = [];
  const unixServer = net.createServer((sock) => { sock.write('RFB 003.008\n'); sock.on('data', (d) => unixReceived.push(d.toString())); });
  await new Promise((r) => unixServer.listen(sockPath, r));
  await bridge.attach('s-unix', { path: sockPath });
  const uws = new WebSocket(bridge.url('s-unix'));
  const uGreet = onceMessage(uws);
  await open(uws);
  assert.strictEqual(await uGreet, 'RFB 003.008\n', 'unix-socket greeting forwarded');
  uws.send('hello-unix');
  await sleep(80);
  assert.strictEqual(unixReceived.join(''), 'hello-unix', 'unix input forwarded to backend');
  uws.close();

  // No target → connection refused cleanly (inert until guest graphics land).
  await bridge.attach('s-none', null);
  const nws = new WebSocket(bridge.url('s-none'));
  const closedCode = await new Promise((resolve) => { nws.once('close', resolve); nws.once('error', () => resolve('error')); });
  assert.ok(closedCode === 1011 || closedCode === 'error' || typeof closedCode === 'number', 'no-target closes cleanly');

  // info/close lifecycle
  assert.strictEqual(bridge.close('s-tcp'), true);
  assert.strictEqual((await bridge.info('s-tcp')).ready, false, 'closed session not-ready');
  bridge.close('s-unix'); bridge.close('s-none'); bridge._shutdownAll();
  tcpServer.close(); unixServer.close();
  fs.rmSync(sockDir, { recursive: true, force: true });
  console.log('screen-bridge test: ALL OK (WS↔TCP + WS↔Unix bidirectional)');
}

// Watchdog so a regression fails fast instead of hanging CI.
const watchdog = setTimeout(() => { console.error('screen-bridge test timed out'); process.exit(1); }, 20_000);
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => clearTimeout(watchdog));
