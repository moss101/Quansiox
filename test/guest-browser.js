'use strict';
/* Guest browser driver — speaks CDP to the bot Linux VM's Chromium over the
 * vsock Unix socket. Uses a fake CDP browser endpoint (no VM, no Electron) to
 * verify navigation, ref snapshots, staleness, input, tabs, cookies and the
 * host-vs-guest router. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { guestBrowserService } = require('../src/main/services/guestBrowserService');
const { browserRouter } = require('../src/main/services/browserRouter');

function startFakeCdp(sockPath) {
  const state = {
    url: 'file:///usr/share/quansiox/welcome.html',
    title: 'Quansiox VM',
    nextTarget: 2,
    targets: new Map([['T1', { targetId: 'T1', type: 'page', url: 'file:///usr/share/quansiox/welcome.html', title: 'Quansiox VM' }]]),
    clicks: [],
    keys: [],
    text: [],
    wheels: [],
    cookies: [],
    dialogs: [],
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ Browser: 'Chromium/140', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/fake' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const broadcast = (method, params = {}) => {
    const payload = JSON.stringify({ method, params });
    for (const ws of wss.clients) { try { ws.send(payload); } catch {} }
  };
  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      const { id, method, params = {}, sessionId } = msg;
      const reply = (result) => ws.send(JSON.stringify({ id, result }));
      const fail = (code, message) => ws.send(JSON.stringify({ id, error: { code, message } }));
      if (method === 'Target.setDiscoverTargets') return reply({});
      if (method === 'Target.getTargets') {
        return reply({ targetInfos: [...state.targets.values()] });
      }
      if (method === 'Target.attachToTarget') {
        return reply({ sessionId: `S-${params.targetId}` });
      }
      if (method === 'Target.createTarget') {
        const targetId = `T${state.nextTarget++}`;
        state.targets.set(targetId, { targetId, type: 'page', url: params.url || 'about:blank', title: '' });
        return reply({ targetId });
      }
      if (method === 'Target.activateTarget') return reply({});
      if (method === 'Target.closeTarget') {
        state.targets.delete(params.targetId);
        broadcast('Target.targetDestroyed', { targetId: params.targetId });
        return reply({ success: true });
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('__qxMutInstalled')) return reply({ result: { value: undefined } });
        if (expr === 'document.readyState') return reply({ result: { value: 'complete' } });
        if (expr === 'location.href') return reply({ result: { value: state.url } });
        if (expr.includes('JSON.stringify') && expr.includes('document.title')) {
          return reply({ result: { value: JSON.stringify({ url: state.url, title: state.title }) } });
        }
        if (expr.startsWith('Boolean(document.querySelector')) return reply({ result: { value: true } });
        if (expr.includes('innerText.includes')) return reply({ result: { value: true } });
        return reply({ result: { value: 'ok' } });
      }
      if (method === 'DOMSnapshot.captureSnapshot') {
        return reply({
          documents: [{
            nodes: { backendNodeId: [1, 2] },
            layout: { nodeIndex: [0, 1], bounds: [[0, 0, 300, 200], [10, 10, 80, 24]] },
            scrollOffsetX: 0,
            scrollOffsetY: 0,
          }],
        });
      }
      if (method === 'Accessibility.getFullAXTree') {
        return reply({
          nodes: [
            { nodeId: 1, role: { value: 'RootWebArea' }, name: { value: state.title }, childIds: [2], backendDOMNodeId: 1 },
            { nodeId: 2, role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 2, parentId: 1 },
          ],
        });
      }
      if (method === 'DOM.resolveNode') return reply({ object: { objectId: `obj-${params.backendNodeId}` } });
      if (method === 'DOM.getBoxModel') return reply({ model: { content: [10, 10, 90, 10, 90, 34, 10, 34] } });
      if (method === 'Runtime.callFunctionOn') {
        const src = String(params.functionDeclaration || '');
        if (src.includes('not_fillable')) return reply({ result: { value: { ok: true } } });
        if (src.includes('not_select')) return reply({ result: { value: { ok: true } } });
        return reply({ result: { value: undefined } });
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mouseWheel') state.wheels.push(params);
        else state.clicks.push(params);
        return reply({});
      }
      if (method === 'Input.insertText') { state.text.push(params.text); return reply({}); }
      if (method === 'Input.dispatchKeyEvent') { state.keys.push(params); return reply({}); }
      if (method === 'Page.navigate') {
        state.url = params.url;
        state.title = 'Example Domain';
        broadcast('Page.frameNavigated', { frame: { id: 'F1', url: state.url } });
        return reply({ frameId: 'F1' });
      }
      if (method === 'Page.captureScreenshot') return reply({ data: 'iVBORw0KGgo=' });
      if (method === 'Page.getLayoutMetrics') return reply({ cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } });
      if (method === 'Page.handleJavaScriptDialog') { state.dialogs.push(params); return reply({}); }
      if (method === 'Network.setCookie') {
        if (params.name === 'bad') return fail(-32000, 'invalid cookie');
        state.cookies.push(params);
        return reply({ success: true });
      }
      if (['Page.enable', 'Runtime.enable', 'Accessibility.enable', 'DOM.enable', 'Network.enable', 'Runtime.addBinding'].includes(method)) {
        return reply({});
      }
      return reply({});
    });
  });
  server.listen(sockPath);
  return {
    state,
    mutate: () => broadcast('Runtime.bindingCalled', { name: '__qxMut', payload: 'm' }),
    dialog: (message) => broadcast('Page.javascriptDialogOpening', { message, type: 'alert' }),
    close: () => {
      for (const ws of wss.clients) { try { ws.close(); } catch {} }
      wss.close();
      server.close();
    },
  };
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-guest-browser-'));
  const sockPath = path.join(tmp, '9222.sock');
  const fake = startFakeCdp(sockPath);
  guestBrowserService.setSocketProvider(() => sockPath);

  // 1. open navigates the guest Chromium and reports the final page.
  const opened = await guestBrowserService.open('vm-bot', { url: 'example.com' });
  assert.match(opened, /^opened https:\/\/example\.com/);
  assert.match(opened, /title: Example Domain/);

  // 2. snapshot builds the same ref model as the host browser.
  const snap = await guestBrowserService.snapshot('vm-bot');
  assert.match(snap.text, /snapshot_id=snap_/);
  assert.match(snap.text, /button "Go" \[ref=e2\]/);
  assert.ok(snap.refCount >= 2);
  const ref = snap.text.match(/button "Go" \[ref=(e\d+)\]/)[1];

  // 3. click by ref dispatches real CDP mouse input at the node center.
  const clicked = await guestBrowserService.act('vm-bot', 'click', { ref, snapshot_id: snap.snapshotId });
  assert.match(clicked, /clicked ref=e\d+/);
  assert.ok(fake.state.clicks.some((c) => c.type === 'mousePressed' && c.x === 50 && c.y === 22));

  // 4. DOM mutation goes stale; a fresh snapshot is required.
  fake.mutate();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stale = await guestBrowserService.act('vm-bot', 'click', { ref, snapshot_id: snap.snapshotId });
  assert.match(stale.message, /STALE_PAGE/);
  assert.match(stale.message, /browser_snapshot again/);

  // 5. fill/type/select/key/scroll/js/wait all speak CDP on the fresh snapshot.
  const snap2 = await guestBrowserService.snapshot('vm-bot');
  const fill = await guestBrowserService.act('vm-bot', 'fill', { ref, value: 'hello', snapshot_id: snap2.snapshotId });
  assert.match(fill, /filled ref=e\d+ with 5 chars/);
  const typed = await guestBrowserService.act('vm-bot', 'type', { text: 'abc' });
  assert.match(typed, /typed 3 chars/);
  assert.ok(fake.state.text.includes('abc'));
  const selected = await guestBrowserService.act('vm-bot', 'select', { ref, value: 'x' });
  assert.match(selected, /selected "x"/);
  const key = await guestBrowserService.act('vm-bot', 'press_key', { key: 'Enter' });
  assert.match(key, /pressed Enter/);
  assert.ok(fake.state.keys.some((k) => k.key === 'Enter' && k.type === 'rawKeyDown'));
  const scrolled = await guestBrowserService.act('vm-bot', 'scroll', { direction: 'down', amount: 300 });
  assert.match(scrolled, /scrolled down 300/);
  assert.ok(fake.state.wheels.some((w) => w.deltaY === 300));
  const js = await guestBrowserService.act('vm-bot', 'js', { code: '1 + 1' });
  assert.equal(js, 'ok');
  const waited = await guestBrowserService.act('vm-bot', 'wait', { selector: '#ready', timeoutMs: 1500 });
  assert.match(waited, /matched selector #ready/);

  // 6. screenshot is CDP Page.captureScreenshot (not an RFB screen grab).
  const shot = await guestBrowserService.act('vm-bot', 'screenshot', {});
  assert.match(shot.data, /^data:image\/png;base64,/);
  assert.equal(shot.width, 1280);

  // 7. dialogs are queued and handled through Page.handleJavaScriptDialog.
  fake.dialog('sure?');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const handled = await guestBrowserService.act('vm-bot', 'handle_dialog', { accept: true });
  assert.match(handled, /accepted dialog: "sure\?"/);
  assert.ok(fake.state.dialogs.some((d) => d.accept === true));

  // 8. tabs are CDP targets; state reports the guest runtime.
  const created = await guestBrowserService.tabs('vm-bot', 'new', { url: 'https://example.org' });
  assert.match(created, /opened tab T2 at https:\/\/example\.org/);
  let list = await guestBrowserService.tabs('vm-bot', 'list');
  assert.equal(list.length, 2);
  assert.ok(list.some((t) => t.active));
  const activated = await guestBrowserService.tabs('vm-bot', 'activate', { tabId: 'T2' });
  assert.match(activated, /activated T2/);
  const guestState = await guestBrowserService.state('vm-bot');
  assert.equal(guestState.runtime, 'linux-vm');
  assert.equal(guestState.activeTabId, 'T2');
  const closed = await guestBrowserService.tabs('vm-bot', 'close', { tabId: 'T2' });
  assert.match(closed, /closed T2/);
  list = await guestBrowserService.tabs('vm-bot', 'list');
  assert.equal(list.length, 1);

  // 9. cookies go through Network.setCookie; values are never echoed.
  const cookies = await guestBrowserService.applyCookies('vm-bot', [
    { domain: '.example.com', name: 'sid', value: 'secret', path: '/', secure: true, httpOnly: true, expires: 1900000000 },
    { domain: 'example.com', name: 'bad', value: 'x' },
  ]);
  assert.deepEqual(cookies, { set: 1, failed: 1 });
  assert.equal(fake.state.cookies[0].name, 'sid');
  assert.equal(fake.state.cookies[0].url, 'https://example.com/');
  assert.ok(!JSON.stringify(cookies).includes('secret'));

  // 10. no CDP socket → honest error (no host fallback invented here).
  guestBrowserService.setSocketProvider(() => null);
  await assert.rejects(() => guestBrowserService.open('no-vm', { url: 'example.com' }), /no Linux VM CDP endpoint/);

  // 11. router: host by default/env, guest when the bot VM is live or vm-mode.
  delete process.env.QUANSIOX_BROWSER_TARGET;
  let ensured = 0;
  browserRouter.setDeps({
    settings: () => ({ sandboxMode: 'sandboxed' }),
    status: () => ({ phase: 'off' }),
    desktopGet: () => null,
    desktopAvailable: () => true,
    ensureComputer: async () => { ensured += 1; return {}; },
  });
  assert.equal(await browserRouter.resolve('bot-1'), 'host');

  browserRouter.setDeps({
    settings: () => ({ sandboxMode: 'sandboxed' }), status: () => ({ phase: 'ready' }),
    desktopGet: () => null, desktopAvailable: () => true, ensureComputer: async () => ({}),
  });
  assert.equal(await browserRouter.resolve('bot-1'), 'guest');

  browserRouter.setDeps({
    settings: () => ({ sandboxMode: 'vm' }), status: () => ({ phase: 'off' }), desktopGet: () => null,
    desktopAvailable: () => true, ensureComputer: async () => { ensured += 1; return {}; },
  });
  assert.equal(await browserRouter.resolve('bot-2', { reason: 'test' }), 'guest');
  assert.equal(ensured, 1);

  browserRouter.setDeps({
    settings: () => ({ sandboxMode: 'vm' }), status: () => ({ phase: 'off' }), desktopGet: () => null,
    desktopAvailable: () => false, ensureComputer: async () => { ensured += 1; return {}; },
  });
  assert.equal(await browserRouter.resolve('bot-3'), 'host');
  assert.equal(ensured, 1);

  browserRouter.setDeps({
    settings: () => ({ sandboxMode: 'sandboxed' }), status: () => ({ phase: 'off' }), desktopGet: () => null,
    desktopAvailable: () => false, ensureComputer: async () => { ensured += 1; return {}; },
  });
  process.env.QUANSIOX_BROWSER_TARGET = 'host';
  assert.equal(await browserRouter.resolve('bot-4'), 'host');
  process.env.QUANSIOX_BROWSER_TARGET = 'guest';
  assert.equal(await browserRouter.resolve('bot-5'), 'guest');
  assert.equal(ensured, 2);
  delete process.env.QUANSIOX_BROWSER_TARGET;
  browserRouter.resetDeps();

  // 12. a live desktop is also the bot's terminal: shell/files redirect into
  // the same guest even when the configured sandbox is the process jail.
  const { sandboxService } = require('../src/main/services/sandboxService');
  const { desktopVmService } = require('../src/main/services/desktopVmService');
  const origGet = desktopVmService.get;
  const origCall = desktopVmService.call;
  desktopVmService.get = () => ({ ready: true });
  desktopVmService.call = async (sid, method, params) => ({ redirected: true, sid, method, command: params.command });
  const shell = await sandboxService.call({ status: 'ready' }, 'exec', { command: 'uname -a' }, 'vm-bot');
  assert.deepEqual(shell, { redirected: true, sid: 'vm-bot', method: 'exec', command: 'uname -a' });
  const cancel = await sandboxService.call({ status: 'ready' }, 'exec.cancel', { jobId: 'j1' }, 'vm-bot');
  assert.equal(cancel.cancelled, false);
  desktopVmService.get = origGet;
  desktopVmService.call = origCall;

  guestBrowserService.destroy('vm-bot');
  guestBrowserService.shutdownAll();
  fake.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log('guest-browser test: ALL OK (CDP open/snapshot/act/tabs/cookies + vm router)');
}

run().catch((error) => { console.error(error); process.exit(1); });
