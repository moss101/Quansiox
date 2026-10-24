'use strict';
/* Real-renderer verification: load the actual index.html (+ bridge + bundle)
 * in Electron with the real IPC registry wired, and assert the settings
 * dialog, facade, and UI mount. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

process.on('uncaughtException', (e) => {
  console.log('UNCAUGHT ' + e.stack);
  app.exit(1);
});

app.whenReady().then(async () => {
  // Real IPC: same bootstrap the app uses.
  require('../src/main/ipc/namespaces.js');
  const { setupIpc } = require('../src/main/ipc/registry.js');
  setupIpc();

  // A project must exist before the renderer mounts, so the surface is
  // checked with a real project selected (the detail block — and with it
  // the master-instruction editor — only renders once one is selected).
  try {
    const { projectService } = require('../src/main/services/projectService');
    projectService.create({ name: 'Renderer check', masterInstruction: 'Be brief.' });
  } catch (error) {
    console.log('PROJECT SETUP FAILED ' + error.message);
  }

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 900,
    minHeight: 600,
    title: 'Quansiox',
    backgroundColor: '#0b0e14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('did-finish-load', async () => {
    const results = {};
    // The live desktop viewer connects to the per-session screen bridge over
    // ws://127.0.0.1:<port>. With connect-src 'self' the CSP blocks it, so the
    // viewer would silently never paint. Prove the policy allows loopback WS.
    try {
      const { WebSocketServer } = require('ws');
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await new Promise((resolve) => wss.once('listening', resolve));
      const wsPort = wss.address().port;
      results.localWs = await win.webContents.executeJavaScript(`new Promise((resolve) => {
        try {
          const w = new WebSocket('ws://127.0.0.1:${wsPort}');
          w.onopen = () => { try { w.close(); } catch {} resolve(true); };
          w.onerror = () => resolve(false);
          setTimeout(() => resolve(false), 2000);
        } catch { resolve(false); }
      })`);
      wss.close();
    } catch { results.localWs = false; }
    try {
      Object.assign(results, await win.webContents.executeJavaScript(`(async () => {
        const r = {};
        r.titlebarButtons = Boolean(document.querySelector('#btn-settings')) && Boolean(document.querySelector('#btn-theme'));
        r.uiBridge = typeof window.quansioxUI?.openSettings === 'function';
        r.facade = Boolean(window.quansiox?.api?.settings?.get) && Boolean(window.quansiox?.api?.playback?.frames);
        r.dialogIds = ['set-baseUrl','set-apiKey','set-model','set-sysprompt','set-sandboxmode','set-shortcut','set-feed','btn-test-conn','btn-check-update','btn-install-update','btn-cu-perms','btn-mcp-add','btn-profile-save','mcp-list','profile-list'].filter((id) => !document.querySelector('#' + id));
        r.dialogSections = document.querySelectorAll('#settings-dialog .settings-section').length;
        r.railTabs = document.querySelectorAll('#settings-dialog .rail-tab').length;
        r.panes = document.querySelectorAll('#settings-dialog .settings-pane').length;
        // The new surfaces live in the settings dialog as real panes. Each one
        // must be present AND mounted with content: a pane that exists but
        // renders nothing is the "the new UI is not loading" failure.
        // React 18 renders concurrently, so a pane may not have flushed yet
        // the instant the bundle loads. Wait for them, then measure — a pane
        // that never renders is the "the new UI is not loading" failure, and
        // a measurement that is too eager cannot tell the difference.
        for (let i = 0; i < 40; i += 1) {
          const mounted = ['permissions', 'plugins', 'vault', 'usage', 'meetings', 'canvas', 'projects', 'slides', 'design', 'websites', 'collab', 'mail']
            .every((name) => {
              const pane = document.querySelector('#settings-dialog [data-react-pane="' + name + '"]');
              return pane && pane.children.length;
            });
          if (mounted) break;
          await new Promise((res) => setTimeout(res, 100));
        }
        r.newPanes = ['permissions', 'plugins', 'vault', 'usage', 'meetings', 'canvas', 'projects', 'slides', 'design', 'websites', 'collab', 'mail']
          .map((name) => {
            const pane = document.querySelector('#settings-dialog [data-react-pane="' + name + '"]');
            return { name, exists: Boolean(pane), rendered: Boolean(pane && pane.children.length) };
          });
        // The Projects surface: the namespace must be exposed through the
        // preload facade and the panel must really render.
        r.projectsNamespace = typeof window.quansiox?.api?.projects?.list === 'function';
        document.querySelector('#settings-dialog .rail-tab[data-pane="projects"]')?.click();
        await new Promise((res) => setTimeout(res, 200));
        r.projectsPanel = Boolean(document.querySelector('#settings-dialog [data-surface="projects-panel"]'));
        r.projectsCreate = Boolean(document.querySelector('#settings-dialog [data-surface="project-master-instruction"]'));
        r.projectsRow = document.querySelectorAll('#settings-dialog .projects-list .projects-row').length;
        r.projectsListNames = [...document.querySelectorAll('#settings-dialog .projects-row-name')].map((n) => n.textContent.trim());
        r.projectsFilters = document.querySelectorAll('#settings-dialog [data-surface="task-filters"] [data-filter]').length;
        r.projectsList = Boolean(document.querySelector('#settings-dialog .projects-list'));

        // The new surfaces: each one must really render, and its namespace
        // must be reachable through the preload facade.
        r.newNamespaces = ['slides', 'design', 'multimedia', 'website', 'collab', 'mailManus']
          .filter((ns) => typeof window.quansiox?.api?.[ns] !== 'object');
        for (const [name, surface] of [['slides', 'slides-panel'], ['design', 'design-panel'], ['websites', 'website-panel'], ['collab', 'collab-panel'], ['mail', 'mail-panel']]) {
          document.querySelector('#settings-dialog .rail-tab[data-pane="' + name + '"]')?.click();
          await new Promise((res) => setTimeout(res, 200));
          r['surface_' + name] = Boolean(document.querySelector('#settings-dialog [data-surface="' + surface + '"]'));
        }

        // The permission matrix must be reachable from the pane, not just the
        // pane itself.
        document.querySelector('#settings-dialog .rail-tab[data-pane="permissions"]')?.click();
        await new Promise((res) => setTimeout(res, 200));
        r.permissionModes = document.querySelectorAll('#settings-dialog [data-surface="permission-modes"] .permission-mode').length;
        r.permissionStyled = Boolean(document.querySelector('#settings-dialog .permission-mode-title'));
        r.permissionCompact = Boolean(document.querySelector('[data-surface="permissions"].is-compact'));
        // The design system: every text element must be legible against what
        // is behind it, in BOTH themes. The guest desktop is a remote screen
        // and is dark in both, so a theme token inside it is a bug.
        {
          const collect = () => {
            const parse = (c) => { const m = String(c).match(/rgba?\\((\\d+), (\\d+), (\\d+)(?:, ([\\d.]+))?/); return m ? [Number(m[1]),Number(m[2]),Number(m[3]), m[4]===undefined?1:Number(m[4])] : null; };
            const lum = ([r,g,b]) => { const f=(v)=>{v/=255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
            const out = [];
            for (const el of document.querySelectorAll('*')) {
              const text = (el.textContent||'').trim();
              if (!text || el.children.length || text.length < 3) continue;
              const cs = getComputedStyle(el);
              const fg = parse(cs.color); if (!fg) continue;
              let bg = null, node = el;
              while (node && node !== document.documentElement) {
                const b = parse(getComputedStyle(node).backgroundColor);
                if (b && b[3] > 0.5) { bg = b; break; }
                node = node.parentElement;
              }
              if (!bg) bg = [255,255,255,1];
              const a = fg[3];
              const comp = [0,1,2].map((k) => fg[k]*a + bg[k]*(1-a));
              const L1 = lum(comp), L2 = lum(bg);
              const ratio = (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
              if (ratio < 2.4) out.push({ cls: String(el.className||'').slice(0,40), text: text.slice(0,24), ratio: +ratio.toFixed(2) });
            }
            return out;
          };
          const prev = document.documentElement.getAttribute('data-theme');
          document.documentElement.setAttribute('data-theme', 'light');
          await new Promise((res) => setTimeout(res, 250));
          r.lowContrastLight = collect();
          document.documentElement.setAttribute('data-theme', 'dark');
          await new Promise((res) => setTimeout(res, 250));
          r.lowContrastDark = collect();
          if (prev) document.documentElement.setAttribute('data-theme', prev);
          else document.documentElement.removeAttribute('data-theme');
        }
        // G14: the stage column must collapse and expand, and the transcript
        // must take the space back when it is hidden.
        r.stageCollapseToggle = Boolean(document.querySelector('[data-surface="stage-collapse"]'));
        {
          const stage = document.querySelector('.stage-column');
          const transcript = document.querySelector('[data-surface="transcript"]');
          const wide = Math.round(stage.getBoundingClientRect().width);
          const wideTranscript = Math.round(transcript.getBoundingClientRect().width);
          document.querySelector('[data-surface="stage-collapse"]')?.click();
          await new Promise((res) => setTimeout(res, 250));
          const collapsed = Math.round(stage.getBoundingClientRect().width);
          const collapsedTranscript = Math.round(transcript.getBoundingClientRect().width);
          document.querySelector('[data-surface="stage-collapse"]')?.click();
          await new Promise((res) => setTimeout(res, 250));
          r.stageCollapse = {
            wide, collapsed, wideTranscript, collapsedTranscript,
            collapses: collapsed < wide,
            transcriptGrows: collapsedTranscript > wideTranscript,
          };
        }
        try { await window.quansioxUI.openSettings(); await new Promise((res) => setTimeout(res, 150)); r.openSettings = document.querySelector('#settings-dialog').open; }
        catch (e) { r.openSettings = 'threw: ' + e.message; }
        r.reactRoot = Boolean(document.querySelector('#root .layout, #root .playback'));
        r.sidebar = Boolean(document.querySelector('.sidebar .brand'));
        r.emptyState = Boolean(document.querySelector('.empty-state'));
        r.starters = document.querySelectorAll('.starter-card').length;
        r.composer = Boolean(document.querySelector('.composer.editor .ProseMirror'));
        r.icons = Boolean(document.querySelector('svg.ic'));
        // Session avatars (v2.12): the wired avatars IPC namespace + service
        // must produce a real deterministic avatar in the running app.
        try {
          const av = await window.quansiox.api.avatars.generate({ sessionId: 'rcheck-avatar', label: 'Q' });
          r.avatarDataUrl = String(av?.dataUrl || '').startsWith('data:image/svg+xml');
          const got = await window.quansiox.api.avatars.get({ sessionId: 'rcheck-avatar' });
          r.avatarPersisted = Boolean(got?.contentBase64);
        } catch { r.avatarDataUrl = false; r.avatarPersisted = false; }
        // Composer draft persistence (v2.13): the wired sessionExtras IPC must
        // save / read back / discard a per-session draft in the running app.
        try {
          const sid = 'rcheck-draft';
          await window.quansiox.api.sessionExtras.saveDraft({ sessionId: sid, text: 'unfinished prompt' });
          const round = await window.quansiox.api.sessionExtras.getDraft({ sessionId: sid });
          r.draftRoundTrip = round?.text === 'unfinished prompt';
          await window.quansiox.api.sessionExtras.discardDraft({ sessionId: sid });
          r.draftDiscard = (await window.quansiox.api.sessionExtras.getDraft({ sessionId: sid }))?.text === '';
        } catch { r.draftRoundTrip = false; r.draftDiscard = false; }
        // Conversation outline popover (v2.14): opening it renders the panel.
        try {
          document.querySelector('.chat-topbar button[title="Conversation outline"]')?.click();
          await new Promise((res) => setTimeout(res, 200));
          r.outlinePop = Boolean(document.querySelector('.outline-pop'));
          document.querySelector('.outline-head .ibtn[title="Close"]')?.click();
        } catch { r.outlinePop = false; }
        r.sessionSurface = Boolean(document.querySelector('.session-list'));
        r.sessionRail = Boolean(document.querySelector('[data-surface="session-rail"]'));
        r.transcript = Boolean(document.querySelector('[data-surface="transcript"] .messages'));
        r.subagentRows = Boolean(document.querySelector('[data-surface="subagent-rows"] .subagent-row'));
        r.subagentFields = ['title', 'type', 'status', 'summary'].every((part) => document.querySelector('[data-surface="subagent-rows"] .subagent-' + part));
        r.computerTrust = Boolean(document.querySelector('[data-surface="computer-trust"]'));
        r.computerStop = Boolean(document.querySelector('[data-surface="computer-stop"]'));
        r.computerHost = Boolean(document.querySelector('[data-surface="computer-browser-host"]'));
        r.recordedPlayback = Boolean(document.querySelector('[data-surface="recorded-playback"]'));
        r.marketplacePanel = Boolean(document.querySelector('[data-surface="marketplace"] .marketplace-list'));
        r.skillsPanel = Boolean(document.querySelector('[data-surface="skills"] .skill-manager-list'));
        r.integrationsPanel = Boolean(document.querySelector('[data-surface="integrations"] .integration-row'));
        r.memoryPanel = Boolean(document.querySelector('[data-surface="memory"] .memory-list'));
        r.liveDesktopControl = Boolean(document.querySelector('[data-action="start-desktop"]'));
        const stage = document.querySelector('[data-surface="agent-computer"]');
        r.agentComputer = Boolean(stage);
        r.agentIdentity = (document.querySelector('[data-surface="agent-computer-identity"]')?.textContent || '').trim();
        r.agentStatus = (document.querySelector('[data-surface="agent-computer-status"]')?.textContent || '').trim();
        r.stageNotHost = Boolean(stage) && !/Controlling this Mac/.test(stage.textContent || '');
        r.hostLabel = (document.querySelector('[data-surface="computer-trust"] .surface-label')?.textContent || '').trim();
        const before = r.agentIdentity;
        document.querySelector('.btn-new')?.click();
        await new Promise((res) => setTimeout(res, 250));
        // Grok parity: + opens the Create New Bot dialog; name it and submit.
        const botDialog = document.querySelector('[data-surface="new-bot-dialog"]');
        r.newBotDialog = Boolean(botDialog);
        const nameInput = botDialog?.querySelector('input[aria-label="Bot name"]');
        if (nameInput) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(nameInput, 'Render Bot');
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((res) => setTimeout(res, 60));
          botDialog.querySelector('button[type="submit"]')?.click();
          await new Promise((res) => setTimeout(res, 600));
        }
        const after = (document.querySelector('[data-surface="agent-computer-identity"]')?.textContent || '').trim();
        const statusAfter = (document.querySelector('[data-surface="agent-computer-status"]')?.textContent || '').trim();
        r.stageSwitched = Boolean(before) && Boolean(after) && before !== after && statusAfter.length > 0;
        r.activeIdentity = after;
        r.stillMounted = Boolean(document.querySelector('[data-surface="session-rail"] .session-list'))
          && Boolean(document.querySelector('[data-surface="transcript"] .composer.editor .ProseMirror'))
          && Boolean(document.querySelector('[data-surface="subagent-rows"] .subagent-row'))
          && Boolean(document.querySelector('[data-surface="recorded-playback"]'))
          && Boolean(document.querySelector('[data-surface="computer-trust"]'))
          && Boolean(document.querySelector('[data-surface="computer-stop"]'));
        const providerSaved = new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 2500);
          window.addEventListener('quansiox-settings', () => { clearTimeout(timer); resolve(true); }, { once: true });
        });
        document.querySelector('#set-preset').value = 'https://openrouter.ai/api/v1';
        document.querySelector('#set-preset').dispatchEvent(new Event('change'));
        document.querySelector('#set-model').value = 'openai/gpt-4o-mini';
        document.querySelector('#set-apiKey').value = 'sk-or-test-key-1234';
        document.querySelector('#settings-form button[value="save"]').click();
        r.providerSaved = await providerSaved;
        await window.quansioxUI.openSettings();
        r.reopenModel = document.querySelector('#set-model').value;
        r.reopenBase = document.querySelector('#set-baseUrl').value;
        r.reopenKey = document.querySelector('#set-apiKey').placeholder;
        document.querySelector('#settings-dialog')?.close?.();
        await new Promise((res) => setTimeout(res, 500));
        r.modelBadge = (document.querySelector('.chat-topbar .badge')?.textContent || '').trim();
        const browserSid = (document.querySelector('[data-surface="agent-computer-identity"]')?.textContent || '').replace(/^computer:/, '').trim();
        document.querySelector('[data-action="show-browser"]')?.click();
        const browserDeadline = Date.now() + 2500;
        while (Date.now() < browserDeadline && !document.querySelector('[data-browser-viewport]')) {
          await new Promise((res) => setTimeout(res, 50));
        }
        r.browserViewport = Boolean(document.querySelector('[data-browser-viewport]'));
        r.browserChrome = Boolean(document.querySelector('.browser-omnibox input[aria-label="Address"]'));
        r.browserInComputer = Boolean(document.querySelector('.stage-column.has-browser [data-surface="agent-computer"] .computer-browser'));
        r.stageStillSeparate = !/Controlling this Mac/.test(document.querySelector('[data-surface="agent-computer"]')?.textContent || '');
        let browserDocked = false;
        const dockDeadline = Date.now() + 2500;
        while (Date.now() < dockDeadline) {
          const info = await window.quansiox.api.browser.state({ sessionId: browserSid });
          if (info?.presented && info?.docked) { browserDocked = true; break; }
          await new Promise((res) => setTimeout(res, 50));
        }
        r.browserPresented = browserDocked;
        document.querySelector('[aria-label="Hide browser"]')?.click();
        const hideDeadline = Date.now() + 2000;
        while (Date.now() < hideDeadline && document.querySelector('[data-browser-viewport]')) {
          await new Promise((res) => setTimeout(res, 50));
        }
        r.browserHidden = !document.querySelector('[data-browser-viewport]')
          && !document.querySelector('.stage-column')?.classList.contains('has-browser');
        const ih = window.innerHeight;
        const measure = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { top: Math.round(b.top * 10) / 10, bottom: Math.round(b.bottom * 10) / 10, height: Math.round(b.height * 10) / 10 };
        };
        r.innerHeight = ih;
        r.composerBox = measure('.composer-wrap');
        r.playbackBox = measure('[data-surface="recorded-playback"]');
        r.trustBox = measure('[data-surface="computer-trust"]');
        r.stopBox = measure('[data-surface="computer-stop"]');
        const stageBox = measure('.stage-scroll');
        const inside = (box) => Boolean(box) && box.bottom <= ih + 1 && box.top >= 0 && box.height > 0;
        const reachable = (box) => Boolean(box) && box.height > 0 && Boolean(stageBox) && box.top >= stageBox.top - 1;
        r.fitsViewport = inside(r.composerBox) && inside(stageBox) && reachable(r.playbackBox) && reachable(r.trustBox) && reachable(r.stopBox);
        r.layoutHeight = Math.round((document.querySelector('.layout')?.getBoundingClientRect().height ?? 0) * 10) / 10;
        r.layoutWithin = r.layoutHeight > 0 && r.layoutHeight <= ih + 1;
        return r;
      })()`));
    } catch (e) {
      errors.push('executeJavaScript: ' + e.message);
    }
    const activeId = String(results.activeIdentity || '').replace(/^computer:/, '');
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(activeId)) {
      const { settingsService } = require('../src/main/services/settingsService');
      const { sandboxService } = require('../src/main/services/sandboxService');
      const computerWs = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-rcheck-ws-'));
      try {
        settingsService.save({ workspaceRoot: computerWs, sandboxMode: 'sandboxed' });
        await sandboxService.ensure(activeId);
        await new Promise((res) => setTimeout(res, 500));
        results.statusAfterEnsure = await win.webContents.executeJavaScript(
          `document.querySelector('[data-surface="agent-computer-status"]')?.textContent?.trim() || ''`
        );
        await sandboxService.stop(activeId);
        await new Promise((res) => setTimeout(res, 500));
        results.statusAfterStop = await win.webContents.executeJavaScript(
          `document.querySelector('[data-surface="agent-computer-status"]')?.textContent?.trim() || ''`
        );
        // The real main window's minimum is 900×600 (windowManager). On this
        // Mac that frame's content box is 568px tall. Measure there.
        win.setSize(900, 600);
        await new Promise((res) => setTimeout(res, 120));
        results.frame = { size: win.getSize(), content: win.getContentSize() };
        const framedHeight = await win.webContents.executeJavaScript('window.innerHeight');
        if (framedHeight > 568) {
          win.setMinimumSize(900, 480);
          win.setContentSize(900, 568);
          await new Promise((res) => setTimeout(res, 150));
        }
        results.fit568 = await win.webContents.executeJavaScript(`(() => {
          const ih = window.innerHeight;
          const measure = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return { top: Math.round(b.top * 10) / 10, bottom: Math.round(b.bottom * 10) / 10, height: Math.round(b.height * 10) / 10 };
          };
          const composer = measure('.composer-wrap');
          const playback = measure('[data-surface="recorded-playback"]');
          const trust = measure('[data-surface="computer-trust"]');
          const stop = measure('[data-surface="computer-stop"]');
          const stageBox = measure('.stage-scroll');
          const inside = (box) => Boolean(box) && box.bottom <= ih + 1 && box.top >= 0 && box.height > 0;
          const reachable = (box) => Boolean(box) && box.height > 0 && Boolean(stageBox) && box.top >= stageBox.top - 1;
          const layoutHeight = Math.round((document.querySelector('.layout')?.getBoundingClientRect().height ?? 0) * 10) / 10;
          const root = document.querySelector('#root');
          const rootStyle = root ? getComputedStyle(root) : null;
          const rootHeight = root ? root.getBoundingClientRect().height : 0;
          const stage = document.querySelector('.stage-scroll');
          const messages = document.querySelector('[data-surface="transcript"] .messages');
          return {
            innerHeight: ih,
            composer, playback, trust, stop,
            layoutHeight,
            fits: inside(composer) && inside(stageBox) && reachable(playback) && reachable(trust) && reachable(stop) && layoutHeight > 0 && layoutHeight <= ih + 1,
            rootDisplay: rootStyle ? rootStyle.display : '',
            rootDirection: rootStyle ? rootStyle.flexDirection : '',
            rootMinHeight: rootStyle ? rootStyle.minHeight : '',
            rootFills: Boolean(root) && Math.abs(rootHeight - ih) <= 1,
            stageScrolls: Boolean(stage) && stage.scrollHeight > stage.clientHeight,
            stageScrollHeight: stage ? stage.scrollHeight : 0,
            stageClientHeight: stage ? stage.clientHeight : 0,
            messagesOverflow: messages ? getComputedStyle(messages).overflowY : '',
            transcriptScrolls: Boolean(messages) && messages.scrollHeight > messages.clientHeight,
          };
        })()`);
      } catch (e) {
        errors.push('computer-status: ' + (e.stack || e.message));
      } finally {
        await sandboxService.stop(activeId).catch(() => {});
      }
    } else {
      errors.push('computer-status: missing active session id');
    }
    console.log('CHECK ' + JSON.stringify(results, null, 2));
    console.log('ERRORS ' + JSON.stringify(errors));
    const ok = results.titlebarButtons && results.uiBridge && results.facade
      && results.dialogIds.length === 0 && results.dialogSections >= 5 && results.railTabs >= 4 && results.panes === results.railTabs
      && results.openSettings === true
      && results.providerSaved === true
      && results.reopenModel === 'openai/gpt-4o-mini'
      && results.reopenBase === 'https://openrouter.ai/api/v1'
      && String(results.reopenKey || '').startsWith('sk-or-')
      && results.modelBadge === 'openai/gpt-4o-mini'
      && results.browserViewport && results.browserChrome && results.browserInComputer
      && results.browserPresented && results.browserHidden && results.stageStillSeparate
      && results.reactRoot && results.sidebar
      && results.emptyState && results.starters >= 4 && results.composer
      && results.icons && results.sessionSurface && results.sessionRail && results.transcript
      && results.avatarDataUrl && results.avatarPersisted
      && results.draftRoundTrip && results.draftDiscard
      && results.outlinePop
      && results.subagentRows && results.subagentFields
      && results.computerTrust && results.computerStop && results.computerHost
      && results.recordedPlayback && results.marketplacePanel && results.skillsPanel       && results.integrationsPanel && results.memoryPanel && results.liveDesktopControl && results.agentComputer
      && results.agentIdentity.length > 0 && results.agentStatus.length > 0
      && results.stageNotHost && results.hostLabel === 'This Mac'
      && results.stageSwitched && results.stillMounted
      && results.newBotDialog === true
      && results.fitsViewport && results.layoutWithin
      && results.fit568 && results.fit568.innerHeight <= 568 && results.fit568.fits
      && results.fit568.stageScrolls
      && results.fit568.rootFills
      && results.fit568.rootDisplay === 'flex'
      && results.fit568.rootDirection === 'column'
      && results.fit568.rootMinHeight === '0px'
      && (results.fit568.messagesOverflow === 'auto' || results.fit568.messagesOverflow === 'scroll')
      && results.fit568.transcriptScrolls
      && results.statusAfterEnsure === 'ready' && results.statusAfterStop === 'idle'
      && results.localWs === true
      && errors.length === 0;
    console.log(ok ? 'RENDERER-CHECK OK' : 'RENDERER-CHECK FAILED');
    app.exit(ok ? 0 : 1);
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
});
