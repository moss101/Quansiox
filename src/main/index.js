'use strict';
/**
 * Quansiox main entry — Manus-style bootstrap: services and IPC first,
 * then a single managed main window. Deep link quansiox:// handled simply.
 */
const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { windowManager } = require('./windowManager');
const { setupIpc, emitEvent } = require('./ipc/registry');
const { trayService } = require('./services/trayService');
const { shortcutService } = require('./services/shortcutService');
require('./ipc/namespaces');

// Lightweight file logger (electron-log style, zero deps).
function log(...args) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'quansiox.log'),
      `${new Date().toISOString()} ${args.join(' ')}\n`
    );
  } catch {}
}
process.on('uncaughtException', (e) => log('uncaughtException:', e.stack ?? e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection:', String(e)));

// Hardware-acceleration preference must be applied before GPU init.
try {
  const { settingsService } = require('./services/settingsService');
  const enabled = settingsService.load().hardwareAccelerationEnabled !== false;
  global.__qxHwAccelStartup = enabled;
  if (!enabled) app.disableHardwareAcceleration();
} catch {}

// The artifact protocol must be declared before the app is ready.
try {
  const { protocol } = require('electron');
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'qx-artifact',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true },
    },
  ]);
} catch (error) {
  console.error('artifact protocol registration failed', error);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const win = windowManager.getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Windows/Linux deep links arrive as argv.
    const link = argv.find((a) => a.startsWith('quansiox://'));
    if (link) handleDeepLink(link);
  });

  /** quansiox://session/<id> | quansiox://settings | quansiox://new */
  function handleDeepLink(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'quansiox:') return;
      // Non-special scheme: the route is the host, the id the first path segment.
      const route = parsed.hostname;
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      const deliver = require('./services/deepLinkService').deepLinkService.deliver;
      if (route === 'session' && id) deliver({ type: 'session', id });
      else if (route === 'settings') deliver({ type: 'settings' });
      else if (route === 'new') deliver({ type: 'new' });
    } catch {
      log('bad deep link:', url);
    }
  }
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleDeepLink(url);
  });

  // The canvas scheme must be registered BEFORE the app is ready.
try { require('./services/canvasBundleService').canvasBundleService.registerCanvasScheme(); } catch { /* canvas pages are optional */ }

app.whenReady().then(() => {
    // A Finder launch has cwd `/`. Seed/persist a writable workspace before any
    // service computes a sandbox root, otherwise tools try `/.quansiox/...`.
    try {
      const { settingsService } = require('./services/settingsService');
      log('workspace root:', settingsService.ensureWorkspaceRoot());
    } catch (error) { log('workspace root init failed:', String(error?.message ?? error)); }
    setupIpc();
    try { require('./services/canvasBundleService').canvasBundleService.installCanvasProtocol(); } catch (error) {
      // Canvas pages are optional; the app works without them.
    }
    try { require('./services/artifactService').artifactService.installArtifactProtocol(); } catch (error) {
      log('artifact protocol failed:', String(error?.message ?? error));
    }
    require('./appMenu').installAppMenu();
    app.setAsDefaultProtocolClient('quansiox');

    // http(s) always stays in the session's Electron browser. Safari is not
    // the agent browser. mailto and other non-web schemes may leave the app.
    app.on('web-contents-created', (_event, contents) => {
      contents.setWindowOpenHandler((details) => {
        const url = String(details?.url || '');
        try {
          const { browserService } = require('./services/browserService');
          if (contents.__qxAgentBrowser || browserService.ownsContents(contents)) {
            browserService.acceptPopup(contents, url);
            return { action: 'deny' };
          }
          if (/^https?:/i.test(url)) {
            browserService.openForeground(url);
            return { action: 'deny' };
          }
        } catch { /* browser service unavailable */ }
        if (url && !url.startsWith('file:') && !url.startsWith('devtools:')) {
          shell.openExternal(url);
        }
        return { action: 'deny' };
      });
    });

    const win = windowManager.createMainWindow();
    win.webContents.on('did-finish-load', () => {
      log('renderer did-finish-load');
      // Renderer can now receive navigation events; flush any queued deep links.
      try { require('./services/deepLinkService').deepLinkService.markReady(); } catch {}
    });

    // Playback windows (Cue computer:playback) share the window manager.
    const { playbackService } = require('./services/playbackService');
    playbackService.setWindowManager(windowManager);
    win.webContents.on('did-fail-load', (_e, code, desc, url) =>
      log('renderer did-fail-load', code, desc, url));
    win.webContents.on('console-message', (_e, level, message) =>
      log(`[renderer:${level}]`, message));
    log('main window created');

    // Cold-start deep link (macOS passes it in argv; Linux in second-instance).
    const coldLink = process.argv.find((a) => a.startsWith('quansiox://'));
    if (coldLink) handleDeepLink(coldLink);

    // Live guest desktop (unified-computer runtime): bridge the desktop VM's RFB
    // guest-input channel so computer_* can be driven into the guest. The RFB
    // client factory connects to the guest RFB unix socket; the coordinator routes
    // computer_* here (main always replies; the Mac helper is the fallback).
    try {
      const { guestComputerBridge } = require('./services/guestComputerBridge');
      const { rfbClient } = require('./services/rfbClient');
      const net = require('node:net');
      guestComputerBridge.setClientFactory((sessionId, rfbSock) => new Promise((resolve, reject) => {
        const dup = net.connect(rfbSock);
        const client = rfbClient.connect(dup);
        dup.on('error', reject);
        client.handshake().then(() => { client.close = () => { try { dup.end(); } catch {} }; resolve(client); }).catch(reject);
      }));
    } catch (error) { log('guest computer bridge init failed:', String(error?.message ?? error)); }

    // Wrap the vault key with the OS keychain (Electron safeStorage) when
    // available; the raw 0600 keyfile stays as the forked-child fallback.
    try {
      const { wrapped, available } = require('./services/secretsService').secretsService.wrapKeyWithSafeStorage();
      log(`secrets key: safeStorage ${available ? (wrapped ? 'wrapped' : 'available') : 'unavailable'}`);
    } catch (error) { log('secrets key wrap failed:', String(error?.message ?? error)); }

    // Local webhook receiver for automations (POST /hook/:id/:token → run).
    try {
      require('./services/webhookService').webhookService.ensureStarted()
        .then((port) => log(`automation webhook server at 127.0.0.1:${port}`))
        .catch((error) => log('automation webhook server failed:', String(error?.message ?? error)));
    } catch (error) { log('automation webhook server failed:', String(error?.message ?? error)); }

    // Tray + configurable global shortcut.
    const showMain = () => windowManager.focusMainWindow();
    trayService.start({
      onNewSession: () => {
        showMain();
        emitEvent('navigation', 'navigate', { type: 'new' });
      },
      onShowMain: showMain,
      onQuit: () => app.quit(),
    });
    shortcutService.register(showMain);
    log('tray + shortcuts wired');

    // Floating companion panel: restore it if an agent was mounted when the
    // app last closed, so the desktop bubble survives a restart.
    try {
      const { panelService } = require('./services/panelService');
      if (panelService.state().mounted) {
        windowManager.createPanelWindow();
        panelService.showWindow();
        log('companion panel restored');
      }
    } catch (error) { log('companion panel restore failed:', String(error?.message ?? error)); }

    // Automations & workflows (Grok createAgentAutomation, local-first):
    // scheduled/background agent runs + a token-verified local webhook path.
    try {
      const { automationService } = require('./services/automationService');
      automationService.setRunner((sessionId, message) =>
        require('./services/agentService').agentService.run({ sender: null }, { sessionId, message }));
      automationService.onStatus((rows) => emitEvent('automations', 'onStatus', rows));
      automationService.startScheduler();
      log('automation scheduler started');
    } catch (error) { log('automation scheduler failed:', String(error?.message ?? error)); }

    // Broadcasts (Grok broadcastToAgents): fan one message to many sessions.
    try {
      const { broadcastService } = require('./services/broadcastService');
      broadcastService.setRunner((sessionId, message) =>
        require('./services/agentService').agentService.run({ sender: null }, { sessionId, message }));
      log('broadcast runner wired');
    } catch (error) { log('broadcast runner failed:', String(error?.message ?? error)); }

    // Local webhook receiver for automations (POST /hook/:id/:token → run).
    try {
      require('./services/webhookService').webhookService.ensureStarted()
        .then((port) => log(`webhook receiver listening on 127.0.0.1:${port}`))
        .catch((error) => log('webhook receiver failed:', String(error?.message ?? error)));
    } catch (error) { log('webhook receiver failed:', String(error?.message ?? error)); }

    app.on('activate', () => {
      if (!windowManager.getMainWindow()) windowManager.createMainWindow();
    });
  });

  let quitArmed = false;
  app.on('before-quit', (event) => {
    // Recording-active gate (Cue pattern): the first quit attempt while a
    // playback window is open focuses it instead; a second attempt quits.
    try {
      const { playbackService } = require('./services/playbackService');
      if (!quitArmed && playbackService.hasActive()) {
        event.preventDefault();
        quitArmed = true;
        playbackService.focusActive();
        emitEvent('navigation', 'navigate', { type: 'quit-blocked-playback' });
        log('quit deferred: playback window active (quit again to force)');
        return;
      }
    } catch { /* playback unavailable — quit normally */ }
    quitArmed = true;
    shortcutService.unregister();
    trayService.stop();
    // Supervised helpers and embedded browsers die cleanly (Manus will-quit
    // pattern: stop services + terminate computer-use helpers).
    try { require('./services/computerHostService').computerHostService.shutdown(); } catch {}
    try { require('./services/browserService').browserService._shutdownAll(); } catch {}
    try { require('./services/computerRuntimeService').computerRuntimeService.reapAll(); } catch {}
    try { require('./services/screenBridge').screenBridge._shutdownAll(); } catch {}
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
