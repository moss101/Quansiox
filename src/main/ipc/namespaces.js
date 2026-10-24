'use strict';
/**
 * Namespaced IPC handler modules — the Manus Studio pattern: each domain
 * contributes a { handlers, events } record registered with the registry.
 */
const { registerNamespace } = require('./registry');
const { emitScopedEvent, emitEvent } = require('./emitEvent');
const { windowManager } = require('../windowManager');
const { settingsService } = require('../services/settingsService');
const { agentService } = require('../services/agentService');
const { execService } = require('../services/execService');
const { sessionService } = require('../services/sessionService');
const { transcriptService } = require('../services/transcriptService');
const { fileService } = require('../services/fileService');
const { shellSessionService } = require('../services/shellSessionService');
const { mcpService } = require('../services/mcpService');
const { gitService } = require('../services/gitService');
const { shortcutService } = require('../services/shortcutService');
const { pricingService } = require('../services/pricingService');
const { updaterService } = require('../services/updaterService');
const { captureService } = require('../services/captureService');
const { computerUseService } = require('../services/computerUseService');
const { skillRecordingService } = require('../services/skillRecordingService');
const { sandboxService } = require('../services/sandboxService');
const { voiceService } = require('../services/voiceService');
const { playbackService } = require('../services/playbackService');
const { secretsService } = require('../services/secretsService');
const { confirmationService } = require('../services/confirmationService');
const { grokCompatService } = require('../services/grokCompat/grokCompatService');
const { automationService } = require('../services/automationService');
const { sessionExtrasService } = require('../services/sessionExtrasService');
const { screenBridge } = require('../services/screenBridge');
const { consentService } = require('../services/consentService');
const { toolPermissionsService } = require('../services/toolPermissionsService');
const { standingGrantsService } = require('../services/standingGrantsService');
const { agentIdentityService } = require('../services/agentIdentityService');
const { taskStateService } = require('../services/taskStateService');
const { asyncTaskService } = require('../services/asyncTaskService');
const governance = require('../../coordinator/governance');
const { broadcastService } = require('../services/broadcastService');
const { webhookService } = require('../services/webhookService');
const { memoryService } = require('../services/memoryService');
const { flagsService } = require('../services/flagsService');
const { hostPrefsService } = require('../services/hostPrefsService');
const { skillsService } = require('../services/skillsService');
const { marketplaceService } = require('../services/marketplaceService');
const { githubService } = require('../services/githubService');
const { slackService } = require('../services/slackService');
const { emailService } = require('../services/emailService');
const { desktopVmService } = require('../services/desktopVmService');
const { computerRuntimeService } = require('../services/computerRuntimeService');
const os = require('node:os');

registerNamespace('system', {
  handlers: {
    platform: () => process.platform,
    versions: () => process.versions,
    hostname: () => os.hostname(),
    // Dock badge for unread/attention activity (docs: "the sidebar and dock
    // badge still show unread activity").
    setBadge: (_event, { count } = {}) => {
      const { app } = require('electron');
      const n = Math.max(0, Number(count) || 0);
      try { app.dock?.setBadge?.(n > 0 ? String(n) : ''); } catch { /* non-dock platform */ }
      return true;
    },
    // OS notification when a Bot finishes or needs input while the app is not
    // focused. Clicking focuses the window and routes to the session.
    notify: (event, { title, body, sessionId } = {}) => {
      const { Notification } = require('electron');
      if (!Notification.isSupported()) return false;
      const note = new Notification({
        title: String(title || 'Quansiox'),
        body: String(body || ''),
        silent: false,
      });
      note.on('click', () => {
        try {
          const entry = windowManager.getWindowById(event.sender.id);
          const win = entry?.win;
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          }
          if (sessionId) emitScopedEvent(event.sender, 'navigation', 'navigate', { type: 'session', id: sessionId });
        } catch { /* window closed since */ }
      });
      note.show();
      return true;
    },
    // Troubleshooting notice stack — request-ID surface for errors.
    notices: () => require('../services/noticeService').noticeService.list(),
    dismissNotice: (_event, { id } = {}) => require('../services/noticeService').noticeService.dismiss({ id }),
    clearNotices: () => require('../services/noticeService').noticeService.clear(),
    // Local support bundle (docs troubleshooting): redacted zip, revealed in Finder.
    supportBundle: () => {
      const result = require('../services/supportBundleService').supportBundleService.create();
      try { require('electron').shell.showItemInFolder(result.path); } catch { /* headless */ }
      return result;
    },
  },
  events: ['onNotice'],
});

registerNamespace('window', {
  handlers: {
    minimize: (event) => windowManager.getWindowById(event.sender.id)?.win.minimize(),
    toggleMaximize: (event) => {
      const entry = windowManager.getWindowById(event.sender.id);
      if (!entry) return;
      entry.win.isMaximized() ? entry.win.unmaximize() : entry.win.maximize();
    },
    close: (event) => windowManager.getWindowById(event.sender.id)?.win.close(),
    // Renderer declines a grace close (Cue close-requested pattern).
    cancelClose: (event) => windowManager.cancelGraceClose(event.sender.id),
    // Pop a session out into its own window (one per session id).
    openSession: (_event, { sessionId }) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId ?? '')) throw new Error('invalid session id');
      windowManager.createSessionWindow(sessionId);
      return true;
    },
  },
  events: ['onCloseRequested'],
});

registerNamespace('settings', {
  handlers: {
    get: () => settingsService.redacted(settingsService.load()),
    // Note: apiKey is write-only through this API; get() returns it redacted
    // and only when the caller explicitly passes a new one does it change.
    save: async (_event, partial) => {
      const current = settingsService.load();
      const next = { ...partial };
      if (!next.apiKey || next.apiKey.includes('…')) next.apiKey = current.apiKey;
      if (!Array.isArray(next.mcpServers)) next.mcpServers = current.mcpServers ?? [];
      const result = settingsService.save(next);
      if (JSON.stringify(next.mcpServers) !== JSON.stringify(current.mcpServers ?? [])) {
        mcpService.reloadAll(); // fire and forget; status via mcp:status
      }
      if ((next.globalShortcut ?? '') !== (current.globalShortcut ?? '')) {
        shortcutService.register(() => windowManager.focusMainWindow());
      }
      return result;
    },
    resetApiKey: () => settingsService.save({ apiKey: '' }),
    // Local inference discovery (Ollama / LM Studio) for the provider picker.
    detectLocalProviders: () => require('../../coordinator/providers/local').detectLocalServers(),
    // Which wire protocol a baseUrl+model pair resolves to (for the UI badge).
    resolveProvider: (_event, { baseUrl, model, apiStyle, provider } = {}) => {
      const engine = require('../../coordinator/providers');
      const p = engine.detectProvider(baseUrl ?? settingsService.load().baseUrl, model ?? settingsService.load().model, { apiStyle, provider });
      return { id: p.id, label: p.label, baseUrl: p.baseUrl, endpoint: engine.endpointFor(p) };
    },
    // Auto-review rules fed to the coordinator approval gate (block wins).
    autoReviewGet: () => require('../services/desktopPrefsService').desktopPrefsService.getAutoReviewInstructions(),
    autoReviewSet: (_event, { instructions }) =>
      require('../services/desktopPrefsService').desktopPrefsService.setAutoReviewInstructions({ instructions }),
    // Aggregate transcript usage across all local sessions.
    usageSummary: () => {
      const sessions = sessionService.list();
      let promptTokens = 0; let completionTokens = 0; let requests = 0; let costUsd = 0;
      let costKnown = false; let turns = 0;
      for (const row of sessions) {
        try {
          const s = sessionService.get(row.id);
          turns += (s.turns ?? []).length;
          promptTokens += s.usage?.promptTokens ?? 0;
          completionTokens += s.usage?.completionTokens ?? 0;
          requests += s.usage?.requests ?? 0;
          const est = pricingService.estimate(s.lastModel ?? settingsService.load().model, s.usage ?? {});
          if (est) { costUsd += est.cost; costKnown = true; }
        } catch { /* skip unreadable session files */ }
      }
      return {
        sessions: sessions.length,
        turns,
        promptTokens,
        completionTokens,
        requests,
        costUsd: costKnown ? costUsd : null,
      };
    },
    // Verify credentials against a provider and list its models.
    test: async (_event, { baseUrl, apiKey, useSaved }) => {
      const saved = settingsService.load();
      const url = (baseUrl || saved.baseUrl).replace(/\/$/, '');
      const key = useSaved ? saved.apiKey : apiKey || saved.apiKey;
      const res = await fetch(`${url}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
      }
      const data = await res.json();
      const models = (data.data ?? data.models ?? [])
        .map((m) => m.id ?? m.name)
        .filter(Boolean)
        .sort();
      return { ok: true, models, count: models.length };
    },
  },
  events: [],
});

// Interactive tool-approval prompts (mid-run Approve/Deny; fail-closed on timeout).
registerNamespace('confirmations', {
  handlers: {
    // `scope` is 'once' or 'always'. 'always' records a standing grant bound
    // to this exact tool AND target, so "always allow git push" never becomes
    // "always allow shell".
    respond: (_e, { id, approved, scope } = {}) => confirmationService.respond(id, approved, scope),
    // Pending approvals, redacted — the thread status strip polls this so a
    // restart can no longer orphan a mid-run approval (P2.4).
    list: () => confirmationService.list(),
  },
  events: [],
});

registerNamespace('agent', {
  handlers: {
    run: (event, opts) => agentService.run(event, opts),
    retry: (event, opts) => agentService.retry(event, opts),
    abort: (event, opts) => agentService.abort(event, opts),
    steer: (event, opts) => agentService.steer(event, opts),
  },
  events: ['onDelta', 'onToolCall', 'onToolResult', 'onDone', 'onCheckpoint', 'onUsage', 'onPlan', 'onRetry', 'onCompacted', 'onScreenshot', 'onSubagent', 'onSubagentDelta', 'onRoute', 'onConfirm', 'onQueued', 'onRunStart'],
  schemas: {
    run: { fields: [{ name: 'sessionId', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }, { name: 'message', required: true }] },
    retry: { fields: [{ name: 'sessionId', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    abort: { fields: [{ name: 'sessionId', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    steer: { fields: [{ name: 'sessionId', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }, { name: 'messageId', type: 'string', required: true }] },
  },
});

registerNamespace('tasks', {
  handlers: Object.fromEntries(['list', 'get', 'start', 'resume', 'fork', 'interrupt', 'wait', 'artifact'].map((action) => [action, (event, options = {}) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.sessionId || '')) throw new Error('invalid parent session');
    if (action === 'start') sessionService.ensure(options.sessionId);
    return agentService.task(event, { ...options, action });
  }])),
  events: [],
});

// Automations & workflows (Grok createAgentAutomation / *Workflow, local).
registerNamespace('automations', {
  handlers: {
    list: (_e, { sessionId } = {}) => automationService.list(sessionId),
    get: (_e, { id } = {}) => automationService.get(id),
    create: (_e, spec = {}) => automationService.create(spec),
    update: (_e, { id, ...patch } = {}) => automationService.update(id, patch),
    remove: (_e, { id } = {}) => automationService.remove(id),
    setEnabled: (_e, { id, enabled } = {}) => automationService.setEnabled(id, enabled),
    run: async (_e, { id } = {}) => automationService.run(id),
    test: async (_e, { id } = {}) => automationService.testRun(id),
    history: (_e, { id, limit } = {}) => automationService.history(id, { limit }),
    webhook: (_e, { id } = {}) => automationService.webhookToken(id),
    importText: (_e, input = {}) => automationService.importWorkflowText(input),
  },
  events: ['onStatus', 'onRun'],
});

// Session conveniences (avatars, outline, media, drafts) — thin IPC over
// sessionExtrasService so the renderer can use them directly.
registerNamespace('avatars', {
  handlers: {
    get: (_e, { sessionId } = {}) => sessionExtrasService.getAvatar(sessionId),
    generate: (_e, { sessionId, label } = {}) => sessionExtrasService.generateAgentImage(sessionId, { label }),
  },
  events: [],
});

registerNamespace('sessionExtras', {
  handlers: {
    outline: (_e, { sessionId } = {}) => sessionExtrasService.outline(sessionId),
    saveDraft: (_e, { sessionId, text } = {}) => sessionExtrasService.saveDraft(sessionId, text),
    getDraft: (_e, { sessionId } = {}) => sessionExtrasService.getDraft(sessionId),
    discardDraft: (_e, { sessionId } = {}) => sessionExtrasService.discardDraft(sessionId),
  },
  events: [],
});

// Local standing-consent grants (Grok local-tool permissions, local-first):
// deny blocks a tool outright; allow is a standing approval overriding policy.
registerNamespace('consent', {
  handlers: {
    list: (_e, { scope } = {}) => consentService.listGrants(scope),
    get: (_e, { scope, subject } = {}) => ({ mode: consentService.getGrant(scope, subject) ?? 'ask' }),
    set: (_e, { scope, subject, mode } = {}) => consentService.setGrant(scope, subject, mode),
    revoke: (_e, { scope, subject } = {}) => consentService.revoke(scope, subject),
  },
  events: [],
});

// The agent lifecycle (W3): named agents, the roster, the durable checklist,
// the background-work registry and the transcript cursor.
registerNamespace('agents', {
  handlers: {
    list: () => agentIdentityService.list(),
    get: (_e, { agentId } = {}) => agentIdentityService.get(agentId),
    create: (_e, agent = {}) => agentIdentityService.create(agent),
    update: (_e, { agentId, ...patch } = {}) => agentIdentityService.update(agentId, patch),
    remove: (_e, { agentId } = {}) => agentIdentityService.remove(agentId),
    setPrimary: (_e, { agentId } = {}) => agentIdentityService.setPrimary(agentId),
    primary: () => agentIdentityService.primary(),
    publish: (_e, { agentId } = {}) => agentIdentityService.publish(agentId),
    unpublish: (_e, { agentId } = {}) => agentIdentityService.unpublish(agentId),
    convertToTeam: (_e, { agentId } = {}) => agentIdentityService.convertToTeam(agentId),
    offerAccess: (_e, { agentId, note } = {}) => agentIdentityService.offerAccess(agentId, { note }),
    clone: (_e, { agentId, name } = {}) => agentIdentityService.clone(agentId, { name }),
    attachSession: (_e, { agentId, sessionId } = {}) => agentIdentityService.attachSession(agentId, sessionId),
    agentForSession: (_e, { sessionId } = {}) => agentIdentityService.agentForSession(sessionId),
    remember: (_e, { agentId, text } = {}) => agentIdentityService.remember(agentId, text),
    forget: (_e, { agentId, memoryId } = {}) => agentIdentityService.forget(agentId, memoryId),
  },
  events: [],
});

registerNamespace('taskState', {
  handlers: {
    list: (_e, { scope, agentId, sessionId, includeDone } = {}) => taskStateService.listTasks({ scope, agentId, sessionId, includeDone }),
    get: (_e, { id } = {}) => taskStateService.getTask(id),
    create: (_e, task = {}) => taskStateService.createTask(task),
    update: (_e, { id, ...patch } = {}) => taskStateService.updateTask(id, patch),
    remove: (_e, { id } = {}) => taskStateService.deleteTask(id),
    markSeen: (_e, { id } = {}) => taskStateService.markSeen(id),
    listAgentTasks: (_e, { agentId } = {}) => taskStateService.listAgentTasks({ agentId }),
    createAgentTask: (_e, task = {}) => taskStateService.createAgentTask(task),
    updateAgentTask: (_e, { id, ...patch } = {}) => taskStateService.updateAgentTask(id, patch),
    getState: (_e, { scope, agentId, sessionId } = {}) => taskStateService.getState({ scope, agentId, sessionId }),
    updateState: (_e, { scope, agentId, sessionId, state } = {}) => taskStateService.updateState({ scope, agentId, sessionId, state }),
  },
  events: [],
});

registerNamespace('asyncTasks', {
  handlers: {
    list: (_e, { sessionId, includeFinished } = {}) => asyncTaskService.list({ sessionId, includeFinished }),
    active: () => asyncTaskService.active(),
    get: (_e, { id } = {}) => asyncTaskService.get(id),
    create: (_e, task = {}) => asyncTaskService.create(task),
    update: (_e, { id, ...patch } = {}) => asyncTaskService.update(id, patch),
    prune: (_e, { maxAgeMs } = {}) => asyncTaskService.prune(maxAgeMs),
  },
  events: [],
});

// The transcript cursor (W3.1): a client asks "what changed since".
registerNamespace('transcriptCursor', {
  handlers: {
    get: (_e, { sessionId } = {}) => sessionService.transcriptCursor(sessionId),
    since: (_e, { sessionId, cursor } = {}) => sessionService.transcriptSince(sessionId, cursor ?? {}),
  },
  events: [],
});

// The bounded-context map (W5.8): what the renderer is made of, and which
// namespaces each context depends on.
registerNamespace('contexts', {
  handlers: {
    list: () => require('../../shared/contexts.js').describe(),
    byId: (_e, { id } = {}) => require('../../shared/contexts.js').contextById(id),
    using: (_e, { port } = {}) => require('../../shared/contexts.js').contextsUsing(port),
  },
  events: [],
});

// Canvas bundles: a canvas as a live JavaScript application.
registerNamespace('canvasBundles', {
  handlers: {
    list: () => require('../services/canvasBundleService').canvasBundleService.list(),
    get: (_e, { id } = {}) => require('../services/canvasBundleService').canvasBundleService.get(id),
    save: (_e, bundle = {}) => require('../services/canvasBundleService').canvasBundleService.save(bundle),
    remove: (_e, { id } = {}) => ({ removed: require('../services/canvasBundleService').canvasBundleService.remove(id) }),
    urlFor: (_e, { id } = {}) => ({ url: require('../services/canvasBundleService').canvasBundleService.urlFor(id) }),
  },
  events: [],
});

// The permission surface (W1): the mode ladder, the per-tool matrix, the
// standing grants and the governance log. The renderer drives all of it from
// Settings → Permissions; the coordinator enforces it.
registerNamespace('permissions', {
  handlers: {
    // The whole permission state in one call, for the settings panel.
    state: () => ({
      mode: settingsService.load().permissionMode,
      modeSet: settingsService.load().permissionModeSet === true,
      autoReviewEnabled: settingsService.load().autoReviewEnabled !== false,
      autoReviewInstructions: settingsService.load().autoReviewInstructions ?? {
        isEnabled: false, allowInstructions: [], blockInstructions: [],
      },
      allowComputerUse: settingsService.load().allowComputerUse === true,
      allowBrowser: settingsService.load().allowBrowser !== false,
      enableFileMutation: settingsService.load().enableFileMutation !== false,
      matrix: toolPermissionsService.get({ scope: 'global', mode: settingsService.load().permissionMode }),
      grants: standingGrantsService.list(),
      scopes: toolPermissionsService.list().scopes,
    }),
    // The mode ladder.
    getMode: () => ({
      mode: settingsService.load().permissionMode,
      modeSet: settingsService.load().permissionModeSet === true,
    }),
    setMode: (_e, { mode } = {}) => {
      if (!['read-only', 'workspace', 'computer'].includes(mode)) throw new Error('invalid permission mode');
      settingsService.save({ permissionMode: mode });
      return { mode, modeSet: true };
    },
    // The per-tool matrix.
    getMatrix: (_e, { scope } = {}) => toolPermissionsService.get({ scope: scope || 'global' }),
    setMatrix: (_e, { scope, mode, matrix } = {}) => toolPermissionsService.set({ scope: scope || 'global', mode, matrix }),
    setTool: (_e, { scope, tool, level } = {}) => toolPermissionsService.setTool({ scope: scope || 'global', tool, level }),
    clearMatrix: (_e, { scope } = {}) => toolPermissionsService.clear({ scope: scope || 'global' }),
    listScopes: () => toolPermissionsService.list(),
    // Standing grants ("always allow this action").
    listGrants: (_e, { includeExpired } = {}) => standingGrantsService.list({ includeExpired }),
    addGrant: (_e, grant = {}) => standingGrantsService.add(grant),
    revokeGrant: (_e, { id } = {}) => standingGrantsService.revoke({ id }),
    revokeAllGrants: () => standingGrantsService.revokeAll(),
    // The auto-review rules and the model reviewer.
    getAutoReview: () => ({
      enabled: settingsService.load().autoReviewEnabled !== false,
      instructions: settingsService.load().autoReviewInstructions ?? {
        isEnabled: false, allowInstructions: [], blockInstructions: [],
      },
    }),
    setAutoReview: (_e, { enabled, instructions } = {}) => {
      const patch = {};
      if (typeof enabled === 'boolean') patch.autoReviewEnabled = enabled;
      if (instructions && typeof instructions === 'object') patch.autoReviewInstructions = instructions;
      settingsService.save(patch);
      return {
        enabled: settingsService.load().autoReviewEnabled !== false,
        instructions: settingsService.load().autoReviewInstructions ?? {
          isEnabled: false, allowInstructions: [], blockInstructions: [],
        },
      };
    },
    // The governance log: why did it refuse that?
    governanceLog: (_e, { sessionId, limit } = {}) => governance.governanceLog({ sessionId, limit }),
  },
  events: ['onGovernance'],
});

// Fan a message to many sessions concurrently (Grok broadcastToAgents, local).
registerNamespace('broadcast', {
  handlers: {
    send: async (_e, { message, ...opts } = {}) => broadcastService.broadcast({ message, ...opts }),
    roster: () => broadcastService.roster(),
  },
  events: ['onProgress'],
});

// Per-bot computer: one live Linux desktop per session, bound to the session's
// own sandbox share. The runtime decides readiness from a real RFB handshake.
registerNamespace('computer', {
  handlers: {
    available: () => ({ available: computerRuntimeService.canProvide() }),
    status: (_e, { sessionId } = {}) => computerRuntimeService.status(sessionId),
    ensure: async (_e, { sessionId, reason } = {}) => computerRuntimeService.ensure(sessionId, { reason }),
    screen: (_e, { sessionId } = {}) => computerRuntimeService.screen(sessionId),
    stop: (_e, { sessionId } = {}) => computerRuntimeService.stop(sessionId),
    recover: async (_e, { sessionId } = {}) => computerRuntimeService.recover(sessionId),
    reset: (_e, { sessionId } = {}) => computerRuntimeService.reset(sessionId),
    list: () => computerRuntimeService.list(),
  },
  events: ['onState'],
});

// Live guest desktop (unified-computer runtime): boots the desktop VM and
// bridges its RFB endpoint over the screen WebSocket for a noVNC viewer.
registerNamespace('desktop', {
  handlers: {
    available: () => ({ available: desktopVmService.available() }),
    boot: async (_e, { sessionId } = {}) => {
      const state = await computerRuntimeService.ensure(sessionId, { reason: 'ui' });
      return { url: state.url, rfbSock: state.rfbSock, cdpSock: state.cdpSock, input: state.input };
    },
    stop: (_e, { sessionId } = {}) => computerRuntimeService.stop(sessionId),
    info: async (_e, { sessionId } = {}) => {
      const state = computerRuntimeService.status(sessionId);
      return { ...state, desktopReady: state.phase === 'ready' };
    },
    computer: async (_e, { sessionId } = {}) => {
      const state = computerRuntimeService.status(sessionId);
      if (state.phase !== 'ready') throw new Error('no live guest desktop for this session');
      const attached = require('../services/guestComputerBridge').guestComputerBridge.isAttached(sessionId);
      return {
        supported: attached,
        rfbSock: state.rfbSock,
        cdpSock: state.cdpSock,
        ...(attached ? {} : { reason: 'guest input is not attached; the screen is viewable via noVNC' }),
      };
    },
    // Recover computer — restart the live pieces so the next run gets a clean
    // helper/guest/VM. Never destroys files.
    recover: async (_e, { sessionId } = {}) => {
      const out = { helper: null, desktopStopped: false, sandboxStopped: false };
      try {
        const { computerHostService } = require('../services/computerHostService');
        computerHostService.restart();
        out.helper = 'restarted';
      } catch (error) {
        out.helper = `skipped: ${String(error?.message ?? error)}`;
      }
      if (sessionId && /^[A-Za-z0-9_-]{1,64}$/.test(String(sessionId))) {
        try { out.desktopStopped = computerRuntimeService.stop(sessionId).phase === 'off'; } catch { /* no live desktop */ }
        try { out.sandboxStopped = Boolean(await sandboxService.stop(sessionId)); } catch { /* no live sandbox */ }
      }
      return out;
    },
    // Reset computer — stop everything and remove this session's sandbox tree
    // so the next run boots fresh. Scoped to sandboxService.sandboxRoot only.
    reset: async (_e, { sessionId } = {}) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(sessionId || ''))) throw new Error('invalid session id');
      try { computerRuntimeService.reset(sessionId); } catch { /* no live desktop */ }
      try { await sandboxService.stop(sessionId); } catch { /* no live sandbox */ }
      const removed = [];
      const root = sandboxService.sandboxRoot(sessionId);
      if (root) {
        try {
          const fs = require('node:fs');
          if (fs.existsSync(root)) {
            fs.rmSync(root, { recursive: true, force: true });
            removed.push(root);
          }
        } catch { /* report empty handed */ }
      }
      return { reset: true, removed };
    },
  },
  events: [],
});

// Email connector — IMAP read + SMTP send (creds from the encrypted vault).
// Caveat: SMTP/IMAP client verified against simulated protocol frames, not a
// live mail server — see emailService.
// macOS Messages — real chat.db reads (Full Disk Access) + allowlisted sends.
registerNamespace('messages', {
  handlers: {
    status: () => require('../services/macMessagesService').macMessagesService.readStatus(),
    enabled: () => require('../services/macMessagesService').macMessagesService.getEnabled(),
    setEnabled: (_e, o = {}) => require('../services/macMessagesService').macMessagesService.setEnabled(o.messagesEnabled),
    chats: (_e, o = {}) => require('../services/macMessagesService').macMessagesService.listChats(o),
    read: (_e, o = {}) => require('../services/macMessagesService').macMessagesService.readMessages(o),
    search: (_e, o = {}) => require('../services/macMessagesService').macMessagesService.searchMessages(o),
    recipients: () => require('../services/macMessagesService').macMessagesService.listRecipients(),
    allow: (_e, o = {}) => require('../services/macMessagesService').macMessagesService.allowRecipients(o),
    revoke: (_e, o = {}) => require('../services/macMessagesService').macMessagesService.revokeRecipient(o),
    send: (_e, o = {}) => require('../services/macMessagesService').macMessagesService.sendMessage(o),
  },
  schemas: {
    chats: { fields: [{ name: 'limit', type: 'integer', required: false }, { name: 'search', type: 'string', max: 200, required: false }] },
    read: { fields: [{ name: 'chatId', type: 'integer', required: false }, { name: 'handle', type: 'string', max: 200, required: false }, { name: 'limit', type: 'integer', required: false }] },
    search: { fields: [{ name: 'query', type: 'string', max: 200, required: true }] },
    send: { fields: [{ name: 'to', type: 'string', max: 200, required: true }, { name: 'text', type: 'string', max: 4000, required: true }] },
  },
  events: ['sent'],
});

// Browser session cookies — Netscape import + explicit Chrome import (grants).
registerNamespace('browserCookies', {
  handlers: {
    grants: (_e, o = {}) => require('../services/cookieImportService').cookieImportService.getGrants(o.sessionId),
    putGrants: (_e, o = {}) => require('../services/cookieImportService').cookieImportService.putGrants(o.sessionId, o),
    profiles: () => require('../services/chromeCookies').chromeCookies.listProfiles(),
    previewChrome: async (_e, o = {}) => {
      const plan = await require('../services/cookieImportService').cookieImportService.planChromeImportAsync(o.sessionId, o);
      return { browser: plan.browser, parsed: plan.parsed, granted: plan.granted, skipped: plan.skipped, unmatchedOrigins: plan.unmatchedOrigins, grantedOrigins: plan.grantedOrigins };
    },
    importText: (_e, o = {}) => {
      const svc = require('../services/cookieImportService').cookieImportService;
      const plan = svc.planImport(o.sessionId, svc.resolveImportText(o));
      return { parsed: plan.parsed, granted: plan.granted, skipped: plan.skipped, unmatchedOrigins: plan.unmatchedOrigins };
    },
    importChrome: async (_e, o = {}) => {
      const svc = require('../services/cookieImportService').cookieImportService;
      const plan = await svc.planChromeImportAsync(o.sessionId, o);
      const applied = await svc.applyPlan(o.sessionId, plan);
      return { browser: plan.browser, granted: plan.granted, skipped: plan.skipped, ...applied };
    },
    applyText: async (_e, o = {}) => {
      const svc = require('../services/cookieImportService').cookieImportService;
      const plan = svc.planImport(o.sessionId, svc.resolveImportText(o));
      return svc.applyPlan(o.sessionId, plan);
    },
  },
  schemas: {
    grants: { fields: [{ name: 'sessionId', type: 'string', pattern: /^[A-Za-z0-9_-]{1,64}$/, required: true }] },
    putGrants: { fields: [{ name: 'sessionId', type: 'string', pattern: /^[A-Za-z0-9_-]{1,64}$/, required: true }] },
    importChrome: { fields: [{ name: 'sessionId', type: 'string', pattern: /^[A-Za-z0-9_-]{1,64}$/, required: true }] },
  },
  events: [],
});

registerNamespace('email', {
  handlers: {
    status: () => { const c = emailService.config(); return { smtp: Boolean(c.smtp?.pass), imap: Boolean(c.imap?.pass) }; },
    send: (_e, o = {}) => { const c = emailService.config(); if (!c.smtp?.pass) throw new Error('email not configured (emailSmtp settings + password secret)'); return emailService.smtpSend({ ...c.smtp, to: o.to, from: o.from, subject: o.subject ?? '', text: o.text }); },
    search: (_e, o = {}) => { const c = emailService.config(); if (!c.imap?.pass) throw new Error('email not configured (emailImap settings + password secret)'); return emailService.imapSearch({ ...c.imap, criteria: o.criteria || 'ALL', mailbox: o.mailbox || 'INBOX', limit: o.limit }); },
  },
  events: [],
});

// Slack connector — real Web API calls (bot token from the encrypted vault).
registerNamespace('slack', {
  handlers: {
    status: () => slackService.status(),
    postMessage: (_e, o = {}) => slackService.chatPostMessage(o),
    channels: () => slackService.conversationsList(),
    history: (_e, o = {}) => slackService.conversationsHistory(o),
  },
  events: [],
});

// GitHub (SCM) connector — real gh-CLI operations on the user's account.
registerNamespace('github', {
  handlers: {
    status: () => githubService.status(),
    prList: (_e, o = {}) => githubService.prList(o),
    prView: (_e, o = {}) => githubService.prView(o),
    prCreate: (_e, o = {}) => githubService.prCreate(o),
    repo: (_e, o = {}) => githubService.repoView(o),
    issueList: (_e, o = {}) => githubService.issueList(o),
  },
  events: [],
});

// Marketplace: local curated catalog over skills + MCP servers (install/uninstall).
registerNamespace('marketplace', {
  handlers: {
    list: (_e, { kind, query } = {}) => marketplaceService.list({ kind, query }),
    install: (_e, { id } = {}) => marketplaceService.install(id),
    uninstall: (_e, { id } = {}) => marketplaceService.uninstall(id),
    installManifest: (_e, manifest = {}) => marketplaceService.installFromManifest(manifest),
  },
  events: ['onChanged'],
});

// Skills + plugin catalog (local; real install/publish/enable, agent-visible).
registerNamespace('skills', {
  handlers: {
    list: () => skillsService.list(),
    get: (_e, { id } = {}) => skillsService.get(id),
    publish: (_e, spec = {}) => skillsService.install(spec),
    uninstall: (_e, { id } = {}) => skillsService.uninstall(id),
    setEnabled: (_e, { id, enabled } = {}) => skillsService.setEnabled(id, enabled),
    sync: (_e, { skills } = {}) => skillsService.installBatch(skills),
    targets: () => skillsService.publishTargets(),
    syncStatus: () => skillsService.syncStatus(),
  },
  events: ['onChanged'],
});

// Local addon/extension system (GPA G13): signed bundles contributing skills
// and MCP servers. Install/trust mutations are main-window-only.
registerNamespace('addons', {
  handlers: {
    list: () => require('../services/addonService').addonService.list(),
    get: (_e, { id } = {}) => require('../services/addonService').addonService.get(id),
    install: async (event) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('addons are managed from the main window');
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      return require('../services/addonService').addonService.installFromDir(result.filePaths[0]);
    },
    enable: (_e, { id } = {}) => require('../services/addonService').addonService.enable(id),
    disable: (_e, { id } = {}) => require('../services/addonService').addonService.disable(id),
    uninstall: (_e, { id } = {}) => require('../services/addonService').addonService.uninstall(id),
    verify: (_e, { id } = {}) => require('../services/addonService').addonService.verify(id),
    trust: (event, { publisher, publicKeyPem } = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('addons are managed from the main window');
      return require('../services/addonService').addonService.trustPublisher(publisher, publicKeyPem);
    },
    trustedPublishers: () => require('../services/addonService').addonService.trustedPublishers(),
    policy: () => require('../services/addonService').addonService.policy(),
    setPolicy: (_e, { requireSignature } = {}) =>
      require('../services/addonService').addonService.setPolicy({ requireSignature }),
  },
  events: ['onChanged'],
});

// Host preferences: pinned sessions + configurable sidebar sections (persisted).
registerNamespace('hostPrefs', {
  handlers: {
    pinned: () => hostPrefsService.getPinned(),
    pin: (_e, { id } = {}) => hostPrefsService.pin(id),
    unpin: (_e, { id } = {}) => hostPrefsService.unpin(id),
    sections: () => hostPrefsService.sections(),
    setSections: (_e, sections = {}) => hostPrefsService.setSections(sections),
    toggleSection: (_e, { section, on } = {}) => hostPrefsService.toggleSection(section, on),
  },
  events: [],
});

// Device feature flags + experiment overrides (local-first).
registerNamespace('flags', {
  handlers: {
    snapshot: () => flagsService.snapshot(),
    evaluate: (_e, { flag, default: fallback } = {}) => ({ flag, value: flagsService.evaluate(flag, fallback) }),
    override: (_e, { flag, value } = {}) => flagsService.override(flag, value),
    clear: (_e, { flag } = {}) => flagsService.clearOverride(flag),
  },
  events: [],
});

// Agent→user interaction cards (trays, structured forms, widgets). The agent
// fork queues entries via userInteractionService; the renderer polls `pending`
// and answers here. Form/secret values are never returned on the list surface.
registerNamespace('interactions', {
  handlers: {
    pending: () => require('../services/userInteractionService').userInteractionService.pending(),
    submitForm: (_e, { entryId, values, saveToVault } = {}) =>
      require('../services/userInteractionService').userInteractionService.submitForm({ entryId, values, saveToVault }),
    dismissForm: (_e, payload = {}) =>
      require('../services/userInteractionService').userInteractionService.dismissForm(payload),
    respondWidget: (_e, payload = {}) =>
      require('../services/userInteractionService').userInteractionService.respondWidget(payload),
    dismissWidget: (_e, payload = {}) =>
      require('../services/userInteractionService').userInteractionService.dismissWidget(payload),
    dismissTray: (_e, { id } = {}) =>
      require('../services/userInteractionService').userInteractionService.dismissTray(id),
    clearTrays: () => require('../services/userInteractionService').userInteractionService.clearTrays(),
    // Drafts (W5.3): the user edits and sends, or discards.
    sendDraft: (_e, payload = {}) => require('../services/userInteractionService').userInteractionService.sendDraft(payload),
    dismissDraft: (_e, payload = {}) => require('../services/userInteractionService').userInteractionService.dismissDraft(payload),
    // Secret requests (W5.2): the value goes into the vault, never back.
    submitSecret: (_e, payload = {}) => require('../services/userInteractionService').userInteractionService.submitSecret(payload),
    dismissSecret: (_e, payload = {}) => require('../services/userInteractionService').userInteractionService.dismissSecret(payload),
  },
  events: ['onChanged'],
});

// The reliability surface (W7.1, W7.2): local tracing and classified
// failure reports. Nothing leaves this machine unless the user configures
// an OTLP endpoint.
registerNamespace('reliability', {
  handlers: {
    spans: (_e, { limit, name, traceId } = {}) => require('../../shared/telemetry.js').recentSpans({ limit, name, traceId }),
    reports: (_e, { limit, class: cls } = {}) => require('../../shared/telemetry.js').recentReports({ limit, class: cls }),
    summary: () => require('../../shared/telemetry.js').summary(),
    report: (_e, { error, class: cls, message, code } = {}) => require('../../shared/telemetry.js').reportFailure(
      Object.assign(new Error(message ?? 'reported failure'), { code: code ?? undefined }),
      cls ? { class: cls } : {},
    ),
    event: (_e, { name, detail } = {}) => require('../../shared/telemetry.js').reportEvent(name, detail ?? {}),
  },
  events: [],
});

// Screen recording (W6.3): start, capture, save or discard.
registerNamespace('screenRecord', {
  handlers: {
    start: (_e, { sessionId } = {}) =>
      require('../services/screenRecordService').start({ sessionId }),
    capture: (_e, { id, display } = {}) =>
      require('../services/screenRecordService').captureScreen(id, { display }),
    save: (_e, { id, saveAsFilename } = {}) =>
      require('../services/screenRecordService').save(id, { saveAsFilename }),
    discard: (_e, { id } = {}) =>
      require('../services/screenRecordService').discard(id),
    status: (_e, { id } = {}) =>
      require('../services/screenRecordService').status(id),
    list: () => require('../services/screenRecordService').list(),
  },
  events: [],
});

// Long-term memory (local-first analog of Grok bot memories): durable facts.
registerNamespace('memory', {
  handlers: {
    list: (_e, { scope } = {}) => memoryService.list({ scope }),
    recall: (_e, { query, tags, limit, scope } = {}) => memoryService.recall(query, { tags, limit, scope }),
    remember: (_e, { text, tags, scope } = {}) => memoryService.remember(text, { tags, scope }),
    forget: (_e, { id } = {}) => memoryService.forget(id),
  },
  events: [],
});

// Local webhook receiver for automations (POST /hook/:id/:token → run).
registerNamespace('webhooks', {
  handlers: {
    url: async (_e, { id } = {}) => webhookService.webhookUrl(id),
    ensure: async () => ({ port: await webhookService.ensureStarted() }),
  },
  events: [],
});

// Unified-computer-runtime: per-session screen transport info. The renderer's
// noVNC client reads the WS URL here; the guest framebuffer is attached by
// `computerRuntimeService` / `desktopVmService`, which boot the per-session
// Linux guest (Phase 1 Swift/VZ graphics) and expose its RFB stream.
registerNamespace('screen', {
  handlers: {
    info: async (_e, { sessionId } = {}) => ({ ...(await screenBridge.info(sessionId)), url: screenBridge.url(sessionId) }),
    detach: (_e, { sessionId } = {}) => ({ closed: screenBridge.close(sessionId) }),
  },
  events: [],
});

// Grok Bot compatibility surface — every shipped desktop method + coordinator
// command, routed to real local behavior or a fail-closed scoped stub.
registerNamespace('grok', {
  handlers: {
    invoke: (event, { method, params } = {}) => grokCompatService.dispatch(method, params, { event }),
    command: (event, { method, params } = {}) => grokCompatService.dispatch(method, params, { event }),
    catalog: () => grokCompatService.catalog(),
  },
  events: [],
});

// Secrets vault (Grok Bot submitSecret / `{{secret:name}}` model). Mutations
// and listing are main-window-only; values are never returned.
registerNamespace('secrets', {
  handlers: {
    list: (event) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('secrets are managed from the main window');
      return secretsService.list();
    },
    set: (event, opts = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('secrets are managed from the main window');
      return secretsService.set(opts.name, opts.fields, opts.note);
    },
    remove: (event, opts = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('secrets are managed from the main window');
      return secretsService.remove(opts.name);
    },
  },
  events: [],
});

registerNamespace('skill', {
  handlers: {
    status: () => skillRecordingService.status(),
    prepare: () => skillRecordingService.prepare(),
    begin: () => skillRecordingService.begin(),
    note: (_event, step) => skillRecordingService.note(step),
    stop: () => skillRecordingService.stop(),
    complete: () => skillRecordingService.complete(),
    cancel: () => skillRecordingService.cancel(),
    list: () => skillRecordingService.list(),
    replay: (_event, { id } = {}) => skillRecordingService.replay(id),
  },
  events: [],
});

// Human demonstration capture (GPA G3): native CGEventTap helper → artifact.
registerNamespace('humanCapture', {
  handlers: {
    status: () => require('../services/humanCaptureService').humanCaptureService.status(),
    start: (_e, { sessionId } = {}) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId ?? '')) throw new Error('invalid session id');
      return require('../services/humanCaptureService').humanCaptureService.start({ sessionId });
    },
    stop: () => require('../services/humanCaptureService').humanCaptureService.stop(),
    cancel: () => require('../services/humanCaptureService').humanCaptureService.cancel(),
  },
  events: [],
});

registerNamespace('shell', {
  handlers: {
    run: async (_event, { command, cwd }) => {
      const settings = settingsService.load();
      return execService.run(command, cwd || settings.workspaceRoot || process.cwd());
    },
  },
  events: [],
});

registerNamespace('sessions', {
  handlers: {
    create: (_event, { id, title, label, description } = {}) => sessionService.create({ id, title, label, description }),
    list: () => sessionService.list(),
    get: (_event, { id }) => sessionService.get(id),
    remove: (_event, { id }) => {
      const result = sessionService.remove(id);
      // Session gone → its embedded browser goes too.
      try { require('../services/browserService').browserService.destroy(id); } catch {}
      return result;
    },
    rename: (_event, { id, title }) => sessionService.rename(id, title),
    thread: (_event, { id, messageId }) => sessionService.thread(id, messageId),
    threadCounts: (_event, { id }) => sessionService.threadCounts(id),
    // Paginated transcript access (tail by default) for incremental loads.
    transcript: (_event, { id, offset = 0, limit = 80, tail = false } = {}) => {
      sessionService.ensure(id);
      const session = sessionService.get(id);
      const turns = Array.isArray(session.turns) ? session.turns : [];
      const size = Math.min(Math.max(Number(limit) || 80, 1), 500);
      const start = tail ? Math.max(0, turns.length - size) : Math.max(0, Number(offset) || 0);
      const slice = turns.slice(start, start + size);
      const todos = transcriptService.todos(id);
      return {
        id,
        title: session.title ?? id,
        total: turns.length,
        offset: start,
        hasMore: start > 0,
        turns: slice,
        usage: session.usage ?? null,
        plan: todos.steps,
      };
    },
    // Roll back the conversation to (and including) the target message.
    rollback: (_event, { id, toMessageId, toTurnIndex, lastUser } = {}) =>
      transcriptService.rollback(id, { toMessageId, toTurnIndex, lastUser }),
    // Sidebar management: title / pinned / hidden / muted flags.
    update: (_event, { id, ...patch }) => sessionService.update(id, patch),
    duplicate: (_event, { id }) => sessionService.duplicate(id),
    // Reactions (docs: lightweight acknowledgement). Broadcast so every open
    // window for the session chips in.
    react: (_event, { id, messageId, emoji }) => {
      const out = sessionService.react(id, messageId, emoji);
      try { emitEvent('sessions', 'onReaction', id, out); } catch { /* best-effort */ }
      return out;
    },
    // Cross-conversation search (docs: find prior messages, jump to place).
    searchMessages: (_event, { query, limit } = {}) => sessionService.searchMessages(query, { limit }),
    // Prior links shared in conversations (docs: palette finds links too).
    searchLinks: (_event, { query, limit } = {}) => sessionService.searchLinks(query, { limit }),
    // Estimated USD cost of a session (null when the model is unknown).
    cost: (_event, { id }) => {
      const session = sessionService.get(id);
      const model = session.lastModel ?? settingsService.load().model;
      return pricingService.estimate(model, session.usage ?? {});
    },
    // Current rates matched for a model (for the settings UI).
    rates: (_event, { model }) => pricingService.ratesFor(model),
    // Aggregate statistics over the transcript.
    stats: (_event, { id }) => {
      const session = sessionService.get(id);
      const turns = session.turns ?? [];
      const toolTurns = turns.filter((t) => t.role === 'tool' && t.name !== 'update_plan');
      const toolCounts = {};
      for (const t of toolTurns) toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
      const model = session.lastModel ?? settingsService.load().model;
      const cost = pricingService.estimate(model, session.usage ?? {});
      return {
        title: session.title,
        turns: turns.length,
        userMessages: turns.filter((t) => t.role === 'user').length,
        assistantMessages: turns.filter((t) => t.role === 'assistant' && t.content).length,
        toolCalls: toolTurns.length,
        toolCounts,
        filesTouched: [
          ...new Set(
            toolTurns
              .filter((t) => ['write_file'].includes(t.name))
              .map((t) => {
                try {
                  return JSON.parse(
                    turns.find((p) => p.role === 'assistant' && p.tool_calls?.some((c) => c.id === t.tool_call_id))?.tool_calls
                      .find((c) => c.id === t.tool_call_id).function.arguments ?? '{}'
                  ).path;
                } catch {
                  return null;
                }
              })
              .filter(Boolean)
          ),
        ],
        usage: session.usage ?? { promptTokens: 0, completionTokens: 0, requests: 0 },
        estimatedCost: cost?.cost ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    },
    // Export the transcript to a Markdown file chosen via save dialog.
    export: async (_event, { id }) => {
      const { dialog } = require('electron');
      const session = sessionService.get(id);
      const safe = (session.title ?? 'session').replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50) || 'session';
      const result = await dialog.showSaveDialog({
        defaultPath: `${safe}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) return null;
      const fs = require('node:fs');
      fs.writeFileSync(result.filePath, sessionService.toMarkdown(id), 'utf8');
      return result.filePath;
    },
  },
  events: ['onReaction'],
  schemas: {
    create: { fields: [{ name: 'title', type: 'string', max: 200 }] },
    get: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    remove: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    rename: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }, { name: 'title', type: 'string', required: true, max: 200 }] },
    thread: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }, { name: 'messageId', type: 'string', required: true }] },
    threadCounts: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    update: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    duplicate: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    react: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }, { name: 'messageId', type: 'string', required: true }, { name: 'emoji', type: 'string', required: true }] },
    transcript: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    rollback: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    searchMessages: { fields: [{ name: 'query', type: 'string', required: true, max: 400 }] },
    searchLinks: { fields: [{ name: 'query', type: 'string', required: true, max: 400 }] },
    cost: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    stats: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    export: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
  },
});

// Local bot templates (share/export analog; no marketplace backend).
registerNamespace('templates', {
  handlers: {
    list: (_e, { visibility } = {}) => require('../services/templateService').templateService.list({ visibility }),
    get: (_e, { id } = {}) => require('../services/templateService').templateService.get(id),
    publish: (_e, payload = {}) => require('../services/templateService').templateService.publishFromSession(payload),
    create: (_e, { templateId, name } = {}) =>
      require('../services/templateService').templateService.createFromTemplate({ templateId, name }),
    remove: (_e, { id } = {}) => require('../services/templateService').templateService.remove(id),
    setVisibility: (_e, { id, visibility } = {}) =>
      require('../services/templateService').templateService.setVisibility(id, visibility),
    export: async (event, { id } = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('templates are managed from the main window');
      const doc = require('../services/templateService').templateService.exportDocument(id);
      const { dialog } = require('electron');
      const result = await dialog.showSaveDialog({
        defaultPath: `${String(doc.template.name).replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50) || 'bot-template'}.json`,
        filters: [{ name: 'Quansiox template', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return null;
      require('node:fs').writeFileSync(result.filePath, `${JSON.stringify(doc, null, 2)}
`, 'utf8');
      return result.filePath;
    },
    import: async (event) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('templates are managed from the main window');
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Quansiox template', extensions: ['json'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      const doc = JSON.parse(require('node:fs').readFileSync(result.filePaths[0], 'utf8'));
      return require('../services/templateService').templateService.importDocument(doc);
    },
  },
  events: [],
});

// Local group chats (docs: 2–6 bots in one conversation).
registerNamespace('groups', {
  handlers: {
    create: (_e, { name, memberIds } = {}) => require('../services/groupService').groupService.create({ name, memberIds }),
    get: (_e, { id } = {}) => require('../services/groupService').groupService.get(id),
    setMembers: (_e, payload = {}) => require('../services/groupService').groupService.setMembers(payload),
    send: (_e, { id, message, mentionIds } = {}) =>
      require('../services/groupService').groupService.send({ id, message, mentionIds }),
    abort: (_e, { id } = {}) => require('../services/groupService').groupService.abort(id),
  },
  events: ['onReply', 'onDone', 'onError'],
});

registerNamespace('file', {
  handlers: {
    tree: () => fileService.tree(),
    read: (_event, { path }) => fileService.read(path),
    readMedia: (_event, { path }) => fileService.readMedia(path),
    write: (_event, { path, content }) => fileService.write(path, content),
    // Starts (or re-targets after workspace change) the recursive watcher;
    // change notifications arrive via the scoped file:onChange event.
    watch: (event) => {
      fileService.watch(event.sender);
      return true;
    },
  },
  events: ['onChange'],
});

registerNamespace('shellSession', {
  handlers: {
    create: (event) => shellSessionService.create(event),
    write: (event, opts) => shellSessionService.write(event, opts),
    control: (event, opts) => shellSessionService.control(event, opts),
    close: (event) => shellSessionService.close(event),
    resize: (event) => shellSessionService.resize(event),
  },
  events: ['onOutput'],
});

registerNamespace('mcp', {
  handlers: {
    status: () => mcpService.status(),
    reload: async () => mcpService.reloadAll(),
  },
  events: [],
});

registerNamespace('git', {
  handlers: {
    status: () => gitService.status(),
    diff: (_event, opts) => gitService.diff(opts ?? {}),
    stage: (_event, { paths }) => gitService.stage(paths),
    unstage: (_event, { paths }) => gitService.unstage(paths),
    commit: (_event, { message }) => gitService.commit(message),
    discard: (_event, { paths }) => gitService.discard(paths),
    log: (_event, { limit } = {}) => gitService.log(limit),
  },
  events: [],
});

registerNamespace('prompts', {
  handlers: {
    list: () => settingsService.load().prompts ?? [],
    // Save a template (new when id absent; title defaults to a body prefix).
    save: async (_event, { id, title, body }) => {
      const text = String(body ?? '').trim();
      if (!text) throw new Error('empty prompt body');
      const prompts = [...(settingsService.load().prompts ?? [])];
      const entry = {
        id: id ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        title: String(title ?? '').trim().slice(0, 60) || text.slice(0, 40),
        body: text.slice(0, 8000),
        createdAt: Date.now(),
      };
      const idx = prompts.findIndex((p) => p.id === entry.id);
      if (idx >= 0) {
        entry.createdAt = prompts[idx].createdAt;
        prompts[idx] = entry;
      } else {
        prompts.unshift(entry);
      }
      settingsService.save({ prompts });
      return entry;
    },
    remove: (_event, { id }) => {
      const prompts = (settingsService.load().prompts ?? []).filter((p) => p.id !== id);
      settingsService.save({ prompts });
      return true;
    },
  },
  events: [],
});

// Post-restart continuity (GPA G15): last route + pending-update checkpoint.
registerNamespace('restore', {
  handlers: {
    consume: () => require('../services/restoreService').restoreService.consume(),
    checkpoint: (_event, { type, id } = {}) =>
      require('../services/restoreService').restoreService.checkpoint({ type, id }),
    peek: () => require('../services/restoreService').restoreService.peek(),
    clear: () => require('../services/restoreService').restoreService.clear(),
  },
  events: [],
});

registerNamespace('updater', {
  handlers: {
    check: () => updaterService.check(),
    appVersion: () => updaterService.appVersion(),
    // Staged install: download -> gate -> prepare-restart handshake -> relaunch.
    install: () => updaterService.install(),
    // Renderer ack for updater:onPrepareRestart.
    prepared: (_event, { id, result }) => updaterService.prepared(id, result),
    // Telemetry-free install identity (sent only to the update feed).
    deviceId: () => require('../services/installIdService').installIdService.getOrCreate(),
  },
  events: ['onPrepareRestart'],
});

// Session playback (Cue computer:playback pattern, local recordings).
registerNamespace('playback', {
  handlers: {
    open: (_event, { sessionId }) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId ?? '')) throw new Error('invalid session id');
      return playbackService.open(sessionId);
    },
    // Frames from the persisted transcript (optionally from an index).
    frames: (_event, { sessionId, from }) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId ?? '')) throw new Error('invalid session id');
      return playbackService.frames(sessionId, Math.max(0, Number(from) || 0));
    },
    playingSessions: () => playbackService.playingSessions(),
    fit: (event, opts) => playbackService.fit(event.sender.id, opts ?? {}),
    fullscreen: (event) => playbackService.toggleFullscreen(event.sender.id),
  },
  events: ['onFrame', 'onChanged'],
});

registerNamespace('capture', {
  handlers: {
    screen: (_event, opts) => captureService.capture({ ...opts, target: 'screen' }),
    window: (_event, opts) => captureService.capture({ ...opts, target: 'window' }),
    listScreens: () => captureService.listSources('screen'),
    listWindows: () => captureService.listSources('window'),
  },
  events: [],
});

// Document library — persistent markdown artifacts the agent can save/read.
registerNamespace('library', {
  handlers: {
    list: () => require('../services/documentsService').documentsService.listLibraryDocs(),
    get: (_event, { id } = {}) => require('../services/documentsService').documentsService.getDocument(id),
    save: (_event, payload = {}) => require('../services/documentsService').documentsService.saveDocument(payload),
    setVisibility: (_event, { id, visibility } = {}) => require('../services/documentsService').documentsService.setDocumentVisibility(id, visibility),
    remove: (_event, { id } = {}) => require('../services/documentsService').documentsService.removeDocument(id),
    pages: () => require('../services/documentsService').documentsService.resolveLibraryPages(),
    assets: (_event, { id } = {}) => require('../services/documentsService').documentsService.getDocumentAssets(id),
  },
  events: [],
  schemas: {
    get: { fields: [{ name: 'id', type: 'string', required: true }] },
    save: { fields: [{ name: 'title', type: 'string', required: true, max: 160 }, { name: 'content', type: 'string', required: true }] },
    setVisibility: { fields: [{ name: 'id', type: 'string', required: true }, { name: 'visibility', type: 'string', required: true, enum: ['private', 'shared'] }] },
    remove: { fields: [{ name: 'id', type: 'string', required: true }] },
    assets: { fields: [{ name: 'id', type: 'string', required: true }] },
  },
});

// Attachments: real content-addressed ingest of composer files. The renderer
// stages bytes here, then the chips reference what's on disk by id/path.
registerNamespace('attachments', {
  handlers: {
    upload: (_event, { name, mimeType, dataBase64, sessionId, agentId } = {}) => {
      const { attachmentService } = require('../services/attachmentService');
      const stored = attachmentService.uploadAttachment({ agentId, filename: name, bytesBase64: dataBase64 });
      return { ...stored, mimeType: mimeType || stored.mime, sessionId: sessionId ?? null };
    },
    preupload: (_event, payload = {}) => require('../services/attachmentService').attachmentService.preuploadStagedAttachment(payload),
    release: (_event, payload = {}) => require('../services/attachmentService').attachmentService.releaseStagedAttachmentPreupload(payload),
    readChunk: (_event, payload = {}) => require('../services/attachmentService').attachmentService.readAttachmentChunk(payload),
    readImage: (_event, payload = {}) => require('../services/attachmentService').attachmentService.readAttachmentImage(payload),
    readText: (_event, payload = {}) => require('../services/attachmentService').attachmentService.readAttachmentText(payload),
    caption: (_event, payload = {}) => require('../services/attachmentService').attachmentService.precaptionStagedAttachment(payload),
    download: (_event, payload = {}) => require('../services/attachmentService').attachmentService.downloadAttachment(payload),
  },
  events: [],
  schemas: {
    upload: { fields: [{ name: 'name', type: 'string', required: true, max: 255 }, { name: 'dataBase64', type: 'string', required: true }] },
    preupload: { fields: [{ name: 'path', type: 'string', required: true }] },
    download: { fields: [{ name: 'url', type: 'string', required: true, max: 2048 }] },
  },
});

// Session browser. The live page is docked into the agent computer.
// `show` presents it there. `close` hides it and any pop-out host.
function browserSessionId(sessionId) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId ?? '')) throw new Error('invalid session id');
  return sessionId;
}

registerNamespace('browser', {
  handlers: {
    openWindow: (_event, { sessionId }) => {
      const { browserService } = require('../services/browserService');
      browserService.showWindow(browserSessionId(sessionId));
      return true;
    },
    show: (_event, { sessionId }) => {
      const { browserService } = require('../services/browserService');
      return browserService.present(browserSessionId(sessionId));
    },
    focusSession: (_event, { sessionId }) => {
      const { browserService } = require('../services/browserService');
      return browserService.focusSession(browserSessionId(sessionId));
    },
    state: (_event, { sessionId }) => {
      const { browserService } = require('../services/browserService');
      return browserService.state(browserSessionId(sessionId));
    },
    downloads: (_event, { sessionId }) => {
      const { browserService } = require('../services/browserService');
      return browserService.downloadsFor(browserSessionId(sessionId));
    },
    openDownload: (_event, { sessionId, id }) => {
      const { browserService } = require('../services/browserService');
      return browserService.openDownload(browserSessionId(sessionId), id);
    },
    revealDownload: (_event, { sessionId, id }) => {
      const { browserService } = require('../services/browserService');
      return browserService.revealDownload(browserSessionId(sessionId), id);
    },
    clearDownloads: (_event, { sessionId }) => {
      const { browserService } = require('../services/browserService');
      return browserService.clearDownloads(browserSessionId(sessionId));
    },
    dock: (event, { sessionId, bounds }) => {
      const { BrowserWindow } = require('electron');
      const { browserService } = require('../services/browserService');
      const win = BrowserWindow.fromWebContents?.(event.sender) ?? null;
      if (!win) throw new Error('no host window');
      return browserService.dock(browserSessionId(sessionId), win, bounds);
    },
    undock: (event, { sessionId }) => {
      const { BrowserWindow } = require('electron');
      const { browserService } = require('../services/browserService');
      const win = BrowserWindow.fromWebContents?.(event.sender) ?? null;
      return browserService.undock(browserSessionId(sessionId), win);
    },
    navigate: (_event, { sessionId, url }) => {
      const { browserService } = require('../services/browserService');
      return browserService.open(browserSessionId(sessionId), { url });
    },
    history: (_event, { sessionId, action }) => {
      const { browserService } = require('../services/browserService');
      return browserService.history(browserSessionId(sessionId), action);
    },
    tabs: (_event, { sessionId, action, tabId, url }) => {
      const { browserService } = require('../services/browserService');
      return browserService.tabs(browserSessionId(sessionId), action, { tabId, url });
    },
    dialog: (_event, { sessionId, accept, text }) => {
      const { browserService } = require('../services/browserService');
      return browserService.act(browserSessionId(sessionId), 'handle_dialog', { accept, text });
    },
    close: (_event, { sessionId }) => {
      const id = browserSessionId(sessionId);
      const { browserService } = require('../services/browserService');
      const { windowManager } = require('../windowManager');
      for (const entry of windowManager.windowsOfType('browser')) {
        if (entry.sessionId === id && !entry.win.isDestroyed()) entry.win.close();
      }
      return browserService.hide(id);
    },
  },
  events: ['onState', 'onDownload'],
});

registerNamespace('profiles', {
  handlers: {
    // Profiles store keys verbatim (redacted only when listed).
    list: () =>
      (settingsService.load().profiles ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        active: p.baseUrl === settingsService.load().baseUrl && p.model === settingsService.load().model,
        hasKey: Boolean(p.apiKey),
      })),
    save: async (_event, { id, name, baseUrl, apiKey, model }) => {
      if (!String(baseUrl ?? '').trim()) throw new Error('baseUrl required');
      const profiles = [...(settingsService.load().profiles ?? [])];
      const entry = {
        id: id ?? `prof-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: String(name ?? '').trim().slice(0, 40) || new URL(baseUrl).hostname,
        baseUrl: String(baseUrl).trim(),
        apiKey: String(apiKey ?? ''),
        model: String(model ?? '').trim() || 'gpt-4o-mini',
      };
      const idx = profiles.findIndex((p) => p.id === entry.id);
      if (idx >= 0) {
        // keep the stored key when the caller passes a redacted placeholder
        if (!entry.apiKey || entry.apiKey.includes('…')) entry.apiKey = profiles[idx].apiKey;
        profiles[idx] = entry;
      } else {
        profiles.push(entry);
      }
      settingsService.save({ profiles });
      return { id: entry.id, name: entry.name };
    },
    // Activate a profile: copy baseUrl/apiKey/model into live settings.
    activate: async (_event, { id }) => {
      const profile = (settingsService.load().profiles ?? []).find((p) => p.id === id);
      if (!profile) throw new Error('profile not found');
      settingsService.save({
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        model: profile.model,
      });
      return { baseUrl: profile.baseUrl, model: profile.model };
    },
    remove: (_event, { id }) => {
      const profiles = (settingsService.load().profiles ?? []).filter((p) => p.id !== id);
      settingsService.save({ profiles });
      return true;
    },
    // Save the current live settings as a new profile.
    saveCurrent: (_event, { name }) => {
      const s = settingsService.load();
      const profiles = [...(s.profiles ?? [])];
      profiles.push({
        id: `prof-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: String(name ?? '').trim().slice(0, 40) || new URL(s.baseUrl).hostname,
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
      });
      settingsService.save({ profiles });
      return { id: profiles.at(-1).id, name: profiles.at(-1).name };
    },
  },
  events: [],
});

registerNamespace('computerUse', {
  handlers: {
    checkPermissions: () => computerUseService.checkPermissions(),
    // Preview a screenshot in the UI (honors the opt-in gate).
    screenshot: () => computerUseService.screenshot(),
    // Take over / I'm done — user handoff of host control. While active every
    // agent computer action is refused (USER_TAKEOVER) until handed back.
    takeover: () => ({ active: computerUseService.isTakenOver() }),
    setTakeover: (_event, { active } = {}) => require('../services/controlHandoff').controlHandoff.setActive(active),
  },
  events: ['onTakeover'],
});

registerNamespace('sandbox', {
  handlers: {
    status: () => sandboxService.status(),
    describe: (_event, { sessionId } = {}) => sandboxService.describe(sessionId),
    stop: async (event, { sessionId } = {}) => {
      const stopped = await sandboxService.stop(sessionId);
      if (sessionId) {
        try { emitScopedEvent(event.sender, 'sandbox', 'onStatus', sessionId); } catch { /* sender already gone */ }
      }
      return stopped;
    },
  },
  events: ['onStatus'],
});

// Voice: local TTS (`say`) + local whisper.cpp dictation (honest-unavailable
// without a provider). Per-bot voice settings ride the session record.
registerNamespace('voice', {
  handlers: {
    status: () => voiceService.diagnose(),
    listVoices: () => voiceService.listVoices(),
    synthesize: (_event, { text, sessionId, voiceId, speed } = {}) => voiceService.synthesize({ text, sessionId, voiceId, speed }),
    transcribe: (_event, { audioBase64, mimeType } = {}) => voiceService.transcribe({ audioBase64, mimeType }),
    preview: (_event, { voiceId, greeting } = {}) => voiceService.preview({ voiceId, greeting }),
    setAgentVoice: (_event, payload = {}) => voiceService.setAgentVoice(payload),
  },
  events: [],
});

/**
 * Voice session — a full-duplex local voice loop.
 *
 * The renderer streams microphone frames; the main process segments speech,
 * transcribes it locally and speaks the replies back sentence by sentence,
 * cutting off when the user interrupts.
 */
registerNamespace('voiceSession', {
  handlers: {
    start: (_e, { sessionId, voiceId, speed } = {}) =>
      require('../services/voiceSessionService').voiceSessionService.start({ sessionId, voiceId, speed }),
    push: (_e, { token, pcmBase64 } = {}) =>
      require('../services/voiceSessionService').voiceSessionService.pushAudio({ token, pcmBase64 }),
    speak: (_e, { token, text, voiceId, speed } = {}) =>
      require('../services/voiceSessionService').voiceSessionService.speak({ token, text, voiceId, speed }),
    interrupt: (_e, { token } = {}) =>
      require('../services/voiceSessionService').voiceSessionService.interrupt({ token }),
    stop: (_e, { token } = {}) =>
      require('../services/voiceSessionService').voiceSessionService.stop({ token }),
    list: () => require('../services/voiceSessionService').voiceSessionService.list(),
  },
  events: ['state', 'transcript', 'partial', 'speaking', 'interrupted'],
});

/**
 * Voice calls — a real-time conversation with the agent, entirely local.
 */
registerNamespace('voiceCall', {
  handlers: {
    credential: (_e, { ttlMs } = {}) =>
      require('../services/voiceCallService').voiceCallService.mintCredential({ ttlMs }),
    start: (_e, { sessionId, credential, title } = {}) =>
      require('../services/voiceCallService').voiceCallService.start({ sessionId, credential, title }),
    get: (_e, { callId } = {}) =>
      require('../services/voiceCallService').voiceCallService.get(callId),
    list: () => require('../services/voiceCallService').voiceCallService.list(),
    record: (_e, { callId, from, text } = {}) =>
      require('../services/voiceCallService').voiceCallService.record(callId, { from, text }),
    sent: (_e, { callId } = {}) =>
      require('../services/voiceCallService').voiceCallService.sentMessages(callId),
    presence: (_e, { callId, presence } = {}) =>
      require('../services/voiceCallService').voiceCallService.setPresence(callId, presence),
    nudge: (_e, { callId } = {}) =>
      require('../services/voiceCallService').voiceCallService.nudge(callId),
    harness: (_e, { callId, sessionId } = {}) =>
      require('../services/voiceCallService').voiceCallService.harnessSession({ callId, sessionId }),
    end: (_e, { callId } = {}) =>
      require('../services/voiceCallService').voiceCallService.end(callId),
  },
  events: [],
  schemas: {
    record: { fields: [{ name: 'text', type: 'string', required: true, max: 4000 }] },
  },
});

/**
 * Meeting copilot — the local record of a meeting and what it means.
 */
registerNamespace('meeting', {
  handlers: {
    start: (_e, { title, sessionId, participants } = {}) =>
      require('../services/meetingService').meetingService.start({ title, sessionId, participants }),
    append: (_e, { meetingId, speaker, text } = {}) =>
      require('../services/meetingService').meetingService.appendTurn({ meetingId, speaker, text }),
    list: () => require('../services/meetingService').meetingService.list(),
    get: (_e, { meetingId } = {}) =>
      require('../services/meetingService').meetingService.get(meetingId),
    transcript: (_e, { meetingId } = {}) =>
      require('../services/meetingService').meetingService.transcript(meetingId),
    remove: (_e, { meetingId } = {}) =>
      require('../services/meetingService').meetingService.remove(meetingId),
  },
  events: [],
});

registerNamespace('workspace', {
  handlers: {
    pickRoot: async () => {
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      settingsService.save({ workspaceRoot: result.filePaths[0] });
      return result.filePaths[0];
    },
    effectiveRoot: () =>
      settingsService.load().workspaceRoot || process.cwd(),
    reveal: (_event, { path: rel }) => {
      const path = require('node:path');
      const { shell } = require('electron');
      const root = settingsService.load().workspaceRoot || process.cwd();
      const abs = path.resolve(root, rel ?? '.');
      if (!abs.startsWith(path.resolve(root))) throw new Error('path escapes workspace');
      shell.showItemInFolder(abs);
      return true;
    },
    open: async (_event, { path: rel }) => {
      const path = require('node:path');
      const { shell } = require('electron');
      const root = settingsService.load().workspaceRoot || process.cwd();
      const abs = path.resolve(root, rel ?? '.');
      if (!abs.startsWith(path.resolve(root))) throw new Error('path escapes workspace');
      const error = await shell.openPath(abs);
      if (error) throw new Error(error);
      return true;
    },
  },
  events: [],
});

// Local product feedback (Grok submitFeedback / voteFeedback parity), appended
// to userData/feedback.jsonl with 0600. Nothing leaves the machine.
registerNamespace('feedback', {
  handlers: {
    send: (event, opts = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('feedback is sent from the main window');
      const message = String(opts.message ?? '').trim();
      if (!message) throw new Error('feedback message is required');
      const payload = { ...opts, message: message.slice(0, 4000) };
      return require('../services/feedbackService').feedbackService.append(opts.kind === 'vote' ? 'vote' : 'feedback', payload);
    },
    list: (_event, opts = {}) => require('../services/feedbackService').feedbackService.list({ limit: opts.limit }),
  },
  events: [],
  schemas: {
    send: { fields: [{ name: 'message', type: 'string', required: true, max: 4000 }] },
  },
});

// Local diagnostics log (JSONL, rotated) surfaced in Settings → Troubleshooting.
registerNamespace('diagnostics', {
  handlers: {
    list: (_event, opts = {}) => require('../services/diagnosticsService').diagnosticsService.list({ limit: opts.limit, kind: opts.kind, sinceMs: opts.sinceMs }),
    summary: () => require('../services/diagnosticsService').diagnosticsService.summary(),
    clear: (event) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('diagnostics are cleared from the main window');
      return require('../services/diagnosticsService').diagnosticsService.clear();
    },
  },
  events: [],
  schemas: {
    list: {
      fields: [
        { name: 'kind', type: 'string', max: 80 },
        { name: 'limit', type: 'integer' },
        { name: 'sinceMs', type: 'number' },
      ],
    },
  },
});

// Link previews + connectivity probes used by the renderer (Grok parity).
registerNamespace('net', {
  handlers: {
    linkMetadata: (_event, opts = {}) => require('../services/netDiagnosticsService').netDiagnosticsService.getLinkMetadata(opts),
    // The four-way DNS diagnosis: is it your resolver, your network, the
    // endpoint, or the provider?
    diagnose: async (_event, opts = {}) => {
      const host = String(opts.host ?? '').trim();
      if (!host) throw new Error('a host is required');
      if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(host)) throw new Error(`invalid host: ${host}`);
      return require('../services/networkDiagnosisService').diagnose(host, {
        probeNetwork: opts.probeNetwork !== false,
      });
    },
    runDiagnostics: (_event, opts = {}) => {
      const hosts = Array.isArray(opts.hosts) ? opts.hosts.slice(0, 20).map(String) : [];
      for (const host of hosts) {
        if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error(`invalid host: ${host}`);
      }
      return require('../services/netDiagnosticsService').netDiagnosticsService.runNetworkDiagnostics({ hosts });
    },
  },
  events: [],
  schemas: {
    linkMetadata: { fields: [{ name: 'url', type: 'string', required: true, max: 2048 }] },
    runDiagnostics: { fields: [{ name: 'hosts', type: 'array' }] },
  },
});

// Secrets provisioned to the agent's box, plus carry-over to bot secrets.
// Values are write-only from the UI (never listed back).
registerNamespace('boxSecrets', {
  handlers: {
    status: (event) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('box secrets are managed from the main window');
      return require('../services/boxSecretService').boxSecretService.status();
    },
    set: (event, opts = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('box secrets are managed from the main window');
      return require('../services/boxSecretService').boxSecretService.setBoxSecrets(opts);
    },
    remove: (event, opts = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('box secrets are managed from the main window');
      return require('../services/boxSecretService').boxSecretService.removeBoxSecret(String(opts.name ?? ''));
    },
    list: (event, opts = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('box secrets are managed from the main window');
      const svc = require('../services/boxSecretService').boxSecretService;
      return opts.serverId ? svc.listBotSecrets(opts.serverId) : svc.listAllBotSecrets();
    },
    carry: (event, opts = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') throw new Error('box secrets are managed from the main window');
      const svc = require('../services/boxSecretService').boxSecretService;
      if (opts.user) return svc.carryUserSecretsToBot(opts.serverId, opts.names);
      return svc.carryToBot(opts.serverId, opts.names);
    },
  },
  events: [],
  schemas: {
    set: { fields: [{ name: 'secrets', type: 'object', required: true }] },
    remove: { fields: [{ name: 'name', type: 'string', required: true, max: 120 }] },
    carry: { fields: [{ name: 'serverId', type: 'string', required: true, max: 120 }] },
  },
});

// Per-agent files (bot parity): userData/agent-files/<agentId>, index 0600.
registerNamespace('agentFiles', {
  handlers: {
    list: (_event, opts = {}) => require('../services/agentFilesService').agentFilesService.listGrokBotAgentFiles(opts),
    upload: (_event, opts = {}) => require('../services/agentFilesService').agentFilesService.uploadGrokBotAgentFile(opts),
    remove: (_event, opts = {}) => require('../services/agentFilesService').agentFilesService.deleteGrokBotAgentFile(opts),
  },
  events: [],
  schemas: {
    list: { fields: [{ name: 'agentId', type: 'string', required: true, max: 120 }] },
    upload: {
      fields: [
        { name: 'agentId', type: 'string', required: true, max: 120 },
        { name: 'fileName', type: 'string', required: true, max: 200 },
      ],
    },
    remove: {
      fields: [
        { name: 'agentId', type: 'string', required: true, max: 120 },
        { name: 'name', type: 'string', required: true, max: 200 },
      ],
    },
  },
});

// Per-agent plugin bindings (MCP plugins/inline/config-update).
registerNamespace('agentPlugins', {
  handlers: {
    get: (_event, opts = {}) => require('../services/agentPluginsService').agentPluginsService.getPlugins(opts),
    set: (_event, opts = {}) => require('../services/agentPluginsService').agentPluginsService.setPlugins(opts),
    setVariables: (_event, opts = {}) => require('../services/agentPluginsService').agentPluginsService.setPluginVariables(opts),
  },
  events: [],
  schemas: {
    get: { fields: [{ name: 'agentId', type: 'string', required: true, max: 120 }] },
    set: {
      fields: [
        { name: 'agentId', type: 'string', required: true, max: 120 },
        { name: 'plugins', type: 'array', required: true },
      ],
    },
    setVariables: {
      fields: [
        { name: 'agentId', type: 'string', required: true, max: 120 },
        { name: 'pluginId', type: 'string', required: true, max: 120 },
      ],
    },
  },
});

// Per-agent skill bindings (installed catalog skills scoped to one agent).
registerNamespace('agentSkills', {
  handlers: {
    list: (_event, opts = {}) => require('../services/agentSkillsService').agentSkillsService.list(opts.agentId),
    add: (_event, opts = {}) => require('../services/agentSkillsService').agentSkillsService.add(opts),
    update: (_event, opts = {}) => require('../services/agentSkillsService').agentSkillsService.update(opts),
    remove: (_event, opts = {}) => require('../services/agentSkillsService').agentSkillsService.remove(opts),
  },
  events: [],
  schemas: {
    list: { fields: [{ name: 'agentId', type: 'string', required: true, max: 120 }] },
    add: {
      fields: [
        { name: 'agentId', type: 'string', required: true, max: 120 },
        { name: 'name', type: 'string', required: true, max: 120 },
        { name: 'content', type: 'string', required: true },
      ],
    },
    update: {
      fields: [
        { name: 'agentId', type: 'string', required: true, max: 120 },
        { name: 'name', type: 'string', required: true, max: 120 },
        { name: 'content', type: 'string', required: true },
      ],
    },
    remove: {
      fields: [
        { name: 'agentId', type: 'string', required: true, max: 120 },
        { name: 'name', type: 'string', required: true, max: 120 },
      ],
    },
  },
});

/**
 * Artifacts — interactive documents the agent builds and the user explores.
 *
 * Each artifact opens in its own sandboxed window with no access to the app
 * and no network access.
 */
registerNamespace('artifacts', {
  handlers: {
    list: (_e, { sessionId } = {}) =>
      require('../services/artifactService').artifactService.list({ sessionId }),
    save: (_e, { id, title, html, kind, sessionId } = {}) =>
      require('../services/artifactService').artifactService.save({ id, title, html, kind, sessionId }),
    read: (_e, { id } = {}) => {
      const svc = require('../services/artifactService').artifactService;
      return { record: svc.get(id), html: svc.read(id) };
    },
    open: (_e, { id } = {}) =>
      require('../services/artifactService').artifactService.open(id),
    // The content address of an artifact, and a lookup by it.
    byContent: (_e, { sha256 } = {}) =>
      require('../services/artifactService').artifactService.byContent(sha256),
    remove: (_e, { id } = {}) =>
      require('../services/artifactService').artifactService.remove(id),
    // The share state of a canvas (an artifact with a visibility and a
    // list of principals).
    share: (_e, { id } = {}) =>
      require('../services/canvasService').canvasService.getShare({ kind: 'store', storeId: 'local', canvasId: id }),
    setVisibility: (_e, { id, visibility } = {}) =>
      require('../services/canvasService').canvasService.setVisibility({ kind: 'store', storeId: 'local', canvasId: id }, visibility),
    setAddress: (_e, { id, slug } = {}) =>
      require('../services/canvasService').canvasService.setPageAddress({ kind: 'store', storeId: 'local', canvasId: id }, slug),
    export: (_e, { id } = {}) =>
      require('../services/canvasService').canvasService.exportShareFile(id),
  },
  events: [],
  schemas: {
    save: { fields: [{ name: 'html', type: 'string', required: true, max: 4000000 }] },
    open: { fields: [{ name: 'id', type: 'string', required: true, max: 64 }] },
    remove: { fields: [{ name: 'id', type: 'string', required: true, max: 64 }] },
  },
});

/**
 * 1Password — scoped access to the user's own CLI, gated by Touch ID.
 *
 * Secrets are only handed out after the QuansioxVaultApprover helper gets a
 * biometric approval, and nothing is ever sent off the machine.
 */
registerNamespace('onePassword', {
  handlers: {
    status: async () =>
      require('../services/onePasswordService').onePasswordService.status(),
    accounts: async () =>
      require('../services/onePasswordService').onePasswordService.accounts(),
    vaults: async () =>
      require('../services/onePasswordService').onePasswordService.vaults(),
    items: async (_e, { vault } = {}) =>
      require('../services/onePasswordService').onePasswordService.items({ vault }),
    mint: async (_e, { vault, name, expiresIn } = {}) =>
      require('../services/onePasswordService').onePasswordService.mintServiceAccount({ vault, name, expiresIn }),
    read: async (_e, { item, field, vault } = {}) =>
      require('../services/onePasswordService').onePasswordService.readSecret({ item, field, vault }),
    import: async (_e, { item, vault, credentialId } = {}) =>
      require('../services/onePasswordService').onePasswordService.importIntoVault({ item, vault, credentialId }),
    vaultGate: async () =>
      require('../services/vaultService').vaultService.biometricGateState(),
    setVaultGate: async (_e, { enabled } = {}) => {
      const { vaultService } = require('../services/vaultService');
      vaultService.setBiometricGateEnabled(Boolean(enabled));
      return vaultService.biometricGateState();
    },
  },
  events: [],
  schemas: {
    read: { fields: [{ name: 'item', type: 'string', required: true, max: 200 }] },
    import: { fields: [{ name: 'item', type: 'string', required: true, max: 200 }] },
  },
});

/**
 * VM snapshots — cheap checkpoints and branches of a bot's Linux box.
 *
 * Because the guest runs on the Mac and its files live on APFS, a snapshot is
 * a machine-state save plus a copy-on-write clone: nearly free, instantly
 * restorable, and branchable.
 */
registerNamespace('vmSnapshot', {
  handlers: {
    list: (_e, { sessionId } = {}) =>
      require('../services/vmSnapshotService').vmSnapshotService.list(sessionId),
    take: async (_e, { sessionId, name } = {}) =>
      require('../services/vmSnapshotService').vmSnapshotService.snapshot(sessionId, { name }),
    restore: async (_e, { sessionId, name } = {}) =>
      require('../services/vmSnapshotService').vmSnapshotService.restore(sessionId, name),
    branch: async (_e, { sessionId, name, targetSessionId } = {}) =>
      require('../services/vmSnapshotService').vmSnapshotService.branch(sessionId, name, { targetSessionId }),
    remove: (_e, { sessionId, name } = {}) =>
      require('../services/vmSnapshotService').vmSnapshotService.remove(sessionId, name),
  },
  events: [],
  schemas: {
    take: { fields: [{ name: 'sessionId', type: 'string', required: true, max: 64 }] },
    restore: { fields: [{ name: 'sessionId', type: 'string', required: true, max: 64 }, { name: 'name', type: 'string', required: true, max: 64 }] },
    branch: { fields: [{ name: 'sessionId', type: 'string', required: true, max: 64 }, { name: 'name', type: 'string', required: true, max: 64 }] },
  },
});

/**
 * Local AI-tool ecosystem discovery.
 *
 * The user already has MCP servers, skills and slash commands configured in
 * Claude Code / Codex / Cursor / OpenCode. This surfaces them so they can be
 * imported instead of re-typed.
 */
registerNamespace('ecosystem', {
  handlers: {
    catalog: () => require('../services/ecosystemService').ecosystemService.catalog(),
    import: async (_e, { id } = {}) =>
      require('../services/ecosystemService').ecosystemService.importItem(id),
  },
  events: [],
  schemas: {
    import: { fields: [{ name: 'id', type: 'string', required: true, max: 400 }] },
  },
});

registerNamespace('navigation', {
  handlers: {},
  // Main pushes deep-link routes here: { type: 'session'|'settings'|'new', id? }
  events: ['navigate'],
});

/**
 * Floating companion panel — the desktop "pet" window.
 *
 * The panel is a separate, frameless, always-on-top BrowserWindow; it talks
 * to the main process through this namespace so it can read its state, submit
 * a prompt, and offer the user the agent's quick choices without opening the
 * main window.
 */
registerNamespace('panel', {
  handlers: {
    state: () => require('../services/panelService').panelService.read(),
    submit: async (_e, { prompt } = {}) => {
      const svc = require('../services/panelService').panelService;
      const { agentId, prompt: text } = svc.submitPrompt({ prompt });
      // The prompt really starts a run on the mounted agent's session.
      require('../services/agentService').agentService
        .run({ sender: null }, { sessionId: agentId, message: text, attachments: [] })
        .catch(() => {});
      svc.setStatus({ status: 'working', message: text.slice(0, 200) });
      return { agentId, submitted: true };
    },
    choices: () => require('../services/panelService').panelService.readChoices(),
    setStatus: (_e, { status, message } = {}) =>
      require('../services/panelService').panelService.setStatus({ status, message }),
    unmountSelf: () => require('../services/panelService').panelService.unmountSelf(),
    switchTo: (_e, { agentId } = {}) =>
      require('../services/panelService').panelService.switchTo({ agentId }),
  },
  events: ['onStatus'],
  schemas: {
    submit: { fields: [{ name: 'prompt', type: 'string', required: true, max: 32768 }] },
  },
});

/**
 * Projects — persistent workspaces carrying a master instruction and a
 * knowledge base into every task started inside them (Manus "Projects").
 *
 * The propagation rules are the interesting part and they are implemented in
 * projectService: the instruction is read live on every turn (an edit
 * applies to the next message in the current task), while the knowledge-base
 * file set is frozen when the task joined the project (a later upload only
 * affects new tasks).
 */
registerNamespace('projects', {
  handlers: {
    list: () => require('../services/projectService').projectService.list(),
    get: (_e, { id } = {}) => require('../services/projectService').projectService.get(id),
    create: (_e, spec = {}) => require('../services/projectService').projectService.create(spec),
    update: (_e, { id, ...patch } = {}) =>
      require('../services/projectService').projectService.update(id, patch),
    remove: (_e, { id } = {}) => require('../services/projectService').projectService.remove(id),
    setPinned: (_e, { id, pinned } = {}) =>
      require('../services/projectService').projectService.setPinned(id, pinned),
    // Drag-and-drop ordering: the new visual order, top to bottom.
    reorder: (_e, { ids } = {}) => require('../services/projectService').projectService.reorder(ids),

    // Knowledge base. Text uploads go straight in; file uploads come from a
    // native picker in the main window.
    addFiles: (_e, { id, files } = {}) =>
      require('../services/projectService').projectService.addFiles(id, files ?? []),
    pickFiles: async (event, { id } = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') {
        throw new Error('knowledge-base files are managed from the main window');
      }
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths.length) return null;
      const fs = require('node:fs');
      const path = require('node:path');
      const files = result.filePaths.map((filePath) => ({
        name: path.basename(filePath),
        content: fs.readFileSync(filePath),
      }));
      return require('../services/projectService').projectService.addFiles(id, files);
    },
    removeFile: (_e, { id, fileId } = {}) =>
      require('../services/projectService').projectService.removeFile(id, fileId),
    readFile: (_e, { id, fileId } = {}) =>
      require('../services/projectService').projectService.readFile(id, fileId),

    // Move a task into (or out of) a project — projects behave as folders.
    assignTask: (_e, { sessionId, projectId } = {}) =>
      require('../services/sessionService').sessionService.assignProject(sessionId, projectId),
    taskConfig: (_e, { sessionId } = {}) => {
      const { sessionService } = require('../services/sessionService');
      const { projectService } = require('../services/projectService');
      return projectService.taskConfig(sessionService.get(sessionId));
    },

    // The sidebar task filters (All / Non-project / Favorites / Scheduled).
    filters: (_e, { filter = 'all' } = {}) => {
      const { sessionService } = require('../services/sessionService');
      const { projectService } = require('../services/projectService');
      const { automationService } = require('../services/automationService');
      const tasks = sessionService.list();
      const scheduledSessionIds = automationService
        .list()
        .filter((a) => a.enabled && (a.cron || a.intervalMs))
        .map((a) => a.sessionId);
      const favorites = tasks.filter((t) => t.favorite === true).map((t) => t.id);
      const visible = projectService.filterTasks(tasks, filter, { favorites, scheduledSessionIds });
      return {
        filter,
        counts: {
          all: tasks.length,
          standalone: tasks.filter((t) => !t.projectId).length,
          favorites: favorites.length,
          scheduled: scheduledSessionIds.length,
        },
        tasks: visible,
      };
    },

    // Local collaborator roster (there is no cloud to share a project with).
    addCollaborator: (_e, { id, name, role } = {}) =>
      require('../services/projectService').projectService.addCollaborator(id, { name, role }),
    removeCollaborator: (_e, { id, collaboratorId } = {}) =>
      require('../services/projectService').projectService.removeCollaborator(id, collaboratorId),
  },
  events: [],
  schemas: {
    create: { fields: [{ name: 'name', type: 'string', required: true, max: 120 }] },
    get: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{3,64}$/ }] },
    update: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{3,64}$/ }] },
    remove: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{3,64}$/ }] },
    assignTask: { fields: [
      { name: 'sessionId', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ },
      { name: 'projectId', type: 'string', required: false },
    ] },
  },
});

/**
 * Slides — decks with themes, speaker notes and real exports (Manus Slides).
 */
registerNamespace('slides', {
  handlers: {
    list: () => require('../services/slidesService').slidesService.list(),
    get: (_e, { id } = {}) => require('../services/slidesService').slidesService.get(id),
    create: (_e, spec = {}) => require('../services/slidesService').slidesService.create(spec),
    update: (_e, { id, ...patch } = {}) => require('../services/slidesService').slidesService.update(id, patch),
    remove: (_e, { id } = {}) => require('../services/slidesService').slidesService.remove(id),
    themes: () => require('../services/slidesService').slidesService.listThemes(),
    // Exports. The PDF export needs the renderer, so it is asynchronous.
    exportPptx: async (_e, { id } = {}) => require('../services/slidesService').slidesService.exportPptx(id),
    exportWeb: (_e, { id } = {}) => require('../services/slidesService').slidesService.exportWeb(id),
    exportNotes: (_e, { id } = {}) => require('../services/slidesService').slidesService.exportNotes(id),
    exportPdf: async (_e, { id } = {}) => require('../services/slidesService').slidesService.exportPdf(id),
    importTemplate: (_e, { id, path } = {}) =>
      require('../services/slidesService').slidesService.importTemplate(id, path),
    pickTemplate: async (event, { id } = {}) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') {
        throw new Error('templates are imported from the main window');
      }
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'PowerPoint', extensions: ['pptx'] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      return require('../services/slidesService').slidesService.importTemplate(id, result.filePaths[0]);
    },
    setChart: (_e, { id, slideIndex, path, data, chartType, title } = {}) =>
      require('../services/slidesService').slidesService.setChart(id, slideIndex, { path, data, chartType, title }),
  },
  events: [],
  schemas: {
    get: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^deck_[A-Za-z0-9_-]{1,64}$/ }] },
    remove: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^deck_[A-Za-z0-9_-]{1,64}$/ }] },
  },
});

/**
 * Design View — a canvas over an image with marked regions and real edits.
 */
registerNamespace('design', {
  handlers: {
    list: () => require('../services/designService').designService.list(),
    get: (_e, { id } = {}) => require('../services/designService').designService.get(id),
    create: (_e, { path, title, sessionId } = {}) =>
      require('../services/designService').designService.create({ sourcePath: path, title, sessionId }),
    remove: (_e, { id } = {}) => require('../services/designService').designService.remove(id),
    pickImage: async (event) => {
      if (windowManager.getWindowById(event.sender.id)?.windowType !== 'main') {
        throw new Error('images are opened from the main window');
      }
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'heic', 'gif', 'bmp', 'tiff'] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return require('../services/designService').designService.create({ sourcePath: result.filePaths[0] });
    },
    addMark: (_e, { id, ...mark } = {}) => require('../services/designService').designService.addMark(id, mark),
    addMarks: (_e, { id, marks } = {}) => require('../services/designService').designService.addMarks(id, marks ?? []),
    clearMarks: (_e, { id } = {}) => require('../services/designService').designService.clearMarks(id),
    extractText: (_e, { id } = {}) => require('../services/designService').designService.extractTextElements(id),
    applyOps: (_e, { id, ops, label, baseVersionId } = {}) =>
      require('../services/designService').designService.applyOps(id, ops ?? [], { label, baseVersionId }),
    addReference: (_e, { id, path } = {}) => require('../services/designService').designService.addReference(id, path),
    compare: (_e, { id, versionId } = {}) => require('../services/designService').designService.compare(id, versionId),
    operations: () => Object.entries(require('../services/designService').designService.OPERATIONS)
      .map(([id, spec]) => ({ id, label: spec.label, params: spec.params })),
  },
  events: [],
  schemas: {
    get: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^dsn_[A-Za-z0-9_-]{1,64}$/ }] },
    remove: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^dsn_[A-Za-z0-9_-]{1,64}$/ }] },
  },
});

/**
 * Multimedia — OCR, image analysis, video and speech.
 */
registerNamespace('multimedia', {
  handlers: {
    capabilities: () => {
      const { multimediaService } = require('../services/multimediaService');
      return {
        ocr: multimediaService.visionAvailable(),
        video: multimediaService.ffmpegAvailable(),
        tones: Object.entries(multimediaService.TONES).map(([id, t]) => ({ id, label: t.label })),
        paces: Object.entries(multimediaService.PACES).map(([id, p]) => ({ id, label: p.label })),
        styles: Object.entries(multimediaService.STYLES).map(([id, s]) => ({ id, label: s.label })),
      };
    },
    ocr: (_e, { path } = {}) => require('../services/multimediaService').multimediaService.ocrImage(path),
    ocrBatch: (_e, { paths } = {}) => require('../services/multimediaService').multimediaService.ocrBatch(paths ?? []),
    analyzeImage: (_e, { path } = {}) => require('../services/multimediaService').multimediaService.analyzeImage(path),
    compareImages: (_e, { a, b } = {}) => require('../services/multimediaService').multimediaService.compareImages(a, b),
    probeVideo: (_e, { path } = {}) => require('../services/multimediaService').multimediaService.probeVideo(path),
    extractFrames: (_e, { path, count } = {}) => require('../services/multimediaService').multimediaService.extractFrames(path, { count }),
    makeVideo: (_e, { paths, fps, format, output } = {}) =>
      require('../services/multimediaService').multimediaService.makeVideo(paths ?? [], { fps, format, output }),
    extractAudio: (_e, { path } = {}) => require('../services/multimediaService').multimediaService.extractAudio(path),
    speak: (_e, { text, tone, pace, style, voice } = {}) =>
      require('../services/multimediaService').multimediaService.speak(text, { tone, pace, style, voice }),
    listVoices: () => require('../services/multimediaService').multimediaService.listVoices(),
  },
  events: [],
});

/**
 * Website Builder — the local subset: scaffold, edit, preview, publish.
 */
registerNamespace('website', {
  handlers: {
    list: () => require('../services/websiteService').websiteService.list(),
    get: (_e, { id } = {}) => require('../services/websiteService').websiteService.get(id),
    create: (_e, spec = {}) => require('../services/websiteService').websiteService.create(spec),
    remove: (_e, { id } = {}) => require('../services/websiteService').websiteService.remove(id),
    files: (_e, { id } = {}) => require('../services/websiteService').websiteService.listFiles(id),
    readFile: (_e, { id, path } = {}) => require('../services/websiteService').websiteService.readFile(id, path),
    writeFile: (_e, { id, path, content } = {}) => require('../services/websiteService').websiteService.writeFile(id, path, content),
    deleteFile: (_e, { id, path } = {}) => require('../services/websiteService').websiteService.deleteFile(id, path),
    // Code control: every file plus a downloadable bundle.
    codeControl: (_e, { id } = {}) => require('../services/websiteService').websiteService.codeControl(id),
    makeCopy: (_e, { id, name } = {}) => require('../services/websiteService').websiteService.makeCopy(id, { name }),
    seoAudit: (_e, { id } = {}) => require('../services/websiteService').websiteService.seoAudit(id),
    applySeo: (_e, { id, ...patch } = {}) => require('../services/websiteService').websiteService.applySeo(id, patch),
    setAccess: (_e, { id, ...access } = {}) => require('../services/websiteService').websiteService.setAccess(id, access),
    recordView: (_e, { id, page } = {}) => require('../services/websiteService').websiteService.recordView(id, page),
    analytics: (_e, { id } = {}) => require('../services/websiteService').websiteService.analyticsSummary(id),
    addNotification: (_e, { id, ...rule } = {}) => require('../services/websiteService').websiteService.addNotification(id, rule),
    removeNotification: (_e, { id, notificationId } = {}) => require('../services/websiteService').websiteService.removeNotification(id, notificationId),
    addSchedule: (_e, { id, ...spec } = {}) => require('../services/websiteService').websiteService.addSchedule(id, spec),
    removeSchedule: (_e, { id, scheduleId } = {}) => require('../services/websiteService').websiteService.removeSchedule(id, scheduleId),
    publish: async (_e, { id, domain } = {}) => require('../services/websiteService').websiteService.publish(id, { domain }),
    previewUrl: async (_e, { id } = {}) => require('../services/websiteService').websiteService.previewUrl(id),
    stopPreview: (_e, { id } = {}) => require('../services/websiteService').websiteService.stopPreviewServer(id),
    dnsRecords: (_e, { domain } = {}) => require('../services/websiteService').websiteService.dnsRecords(domain),
  },
  events: [],
  schemas: {
    get: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^web_[A-Za-z0-9_-]{1,64}$/ }] },
    remove: { fields: [{ name: 'id', type: 'string', required: true, pattern: /^web_[A-Za-z0-9_-]{1,64}$/ }] },
  },
});

/**
 * Collaboration — a task others can join and prompt.
 */
registerNamespace('collab', {
  handlers: {
    get: (_e, { sessionId } = {}) => {
      const { collabService } = require('../services/collabService');
      const session = collabService._find(sessionId);
      return session ? collabService._reduced(session) : null;
    },
    enable: (_e, { sessionId } = {}) => require('../services/collabService').collabService.enable(sessionId),
    disable: (_e, { sessionId } = {}) => require('../services/collabService').collabService.disable(sessionId),
    invite: (_e, { sessionId, email } = {}) => require('../services/collabService').collabService.invite(sessionId, email),
    join: (_e, { token, identity } = {}) => require('../services/collabService').collabService.join(token, { identity }),
    members: (_e, { sessionId } = {}) => require('../services/collabService').collabService.members(sessionId),
    removeMember: (_e, { sessionId, email } = {}) => require('../services/collabService').collabService.removeMember(sessionId, email),
    prompt: (_e, { sessionId, identity, message } = {}) =>
      require('../services/collabService').collabService.prompt(sessionId, identity, message),
    queue: (_e, { sessionId } = {}) => require('../services/collabService').collabService.queue(sessionId),
    drain: async (_e, { sessionId } = {}) => require('../services/collabService').collabService.drain(sessionId),
    history: (_e, { sessionId } = {}) => require('../services/collabService').collabService.history(sessionId),
    exportTranscript: (_e, { sessionId } = {}) => require('../services/collabService').collabService.exportTranscript(sessionId),
  },
  events: [],
  schemas: {
    enable: { fields: [{ name: 'sessionId', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ }] },
    invite: { fields: [
      { name: 'sessionId', type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]{1,64}$/ },
      { name: 'email', type: 'string', required: true, max: 200 },
    ] },
  },
});

/**
 * Mail Manus — the local address that turns email into a task.
 */
registerNamespace('mailManus', {
  handlers: {
    state: () => require('../services/mailManusService').mailManusService.load(),
    configure: (_e, patch = {}) => require('../services/mailManusService').mailManusService.configure(patch),
    botAddress: () => require('../services/mailManusService').mailManusService.botAddress(),
    approveSender: (_e, { email } = {}) => require('../services/mailManusService').mailManusService.approveSender(email),
    removeSender: (_e, { email } = {}) => require('../services/mailManusService').mailManusService.removeSender(email),
    addWorkflow: (_e, spec = {}) => require('../services/mailManusService').mailManusService.addWorkflow(spec),
    removeWorkflow: (_e, { alias } = {}) => require('../services/mailManusService').mailManusService.removeWorkflow(alias),
    poll: async (_e, { limit, criteria } = {}) => require('../services/mailManusService').mailManusService.poll({ limit, criteria }),
    handleMessage: async (_e, { message } = {}) => require('../services/mailManusService').mailManusService.handleMessage(message),
    cancel: async (_e, { workflow, message } = {}) => require('../services/mailManusService').mailManusService.cancelTask(workflow, message),
    filterConfiguration: (_e, spec = {}) => require('../services/mailManusService').mailManusService.filterConfiguration(spec),
    calendarEvent: (_e, spec = {}) => require('../services/mailManusService').mailManusService.calendarEvent(spec),
    extractRecord: (_e, { message } = {}) => require('../services/mailManusService').mailManusService.extractRecord(message),
  },
  events: [],
});

module.exports = { setupAllNamespaces: () => {} };
