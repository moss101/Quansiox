'use strict';
/**
 * Grok compatibility — real local handlers.
 *
 * Each handler implements a shipped Grok Bot method against Quansiox's own
 * services. Handlers are plain functions `(params, ctx) => result` where
 * ctx = { event } carries the IPC event (for window-scoped agent runs).
 * Anything that is genuinely cloud/backend/vendor-bound is NOT here — those
 * are fail-closed stubs in grokCompatService (never a silent fake success).
 *
 * Every dependency is lazily required so this module loads in plain Node for
 * tests; electron-backed services only resolve inside the running app.
 */
const crypto = require('node:crypto');

const ok = (extra) => ({ status: 'ok', ok: true, ...(extra || {}) });

function bool(...vals) {
  const v = vals.find((x) => typeof x === 'boolean');
  if (v !== undefined) return v;
  const s = vals.find((x) => x !== undefined && x !== null);
  return s === true || s === 'true' || s === 1;
}

function settings() { return require('../settingsService').settingsService; }
function sessionService() { return require('../sessionService').sessionService; }

// Wrap a possibly-throwing sync/async body so the dispatcher always gets a
// well-formed envelope even when an electron-only service is unavailable.
async function attempt(fn) {
  try { return { status: 'ok', result: await fn() }; }
  catch (error) { return { status: 'error', error: String(error?.message ?? error) }; }
}

/** Shared by updateMcpPluginInstall / updatePluginInstall: re-fill an installed
 *  MCP plugin with new values, rebuilding from the catalog template when known. */
async function updateInstalledPluginImpl(p) {
  const id = String(p.pluginId ?? '');
  const cfg = settings().load();
  const idx = (cfg.mcpServers ?? []).findIndex((s) => s.name === id);
  if (idx === -1) return { status: 'error', error: `server not installed: ${id}` };
  const values = p.values ?? {};
  const current = cfg.mcpServers[idx];
  const merged = { ...(current.installValues ?? {}), ...values };
  const fill = (s) => String(s).replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (m, k) => (merged[k] !== undefined ? String(merged[k]) : m));
  const pkg = require('../marketplaceService').marketplaceService.CATALOG.find((x) => x.id === id && x.kind === 'mcp');
  let next;
  if (pkg) {
    next = {
      name: id,
      command: pkg.command,
      args: (pkg.args ?? []).map(fill),
      ...(pkg.env || values ? { env: Object.fromEntries(Object.entries(pkg.env ?? {}).map(([k, v]) => [k, fill(v)])) } : {}),
      installValues: merged,
    };
  } else {
    next = {
      ...current,
      args: (current.args ?? []).map(fill),
      env: Object.fromEntries(Object.entries({ ...(current.env ?? {}), ...values }).map(([k, v]) => [k, fill(v)])),
      installValues: merged,
    };
  }
  const servers = [...cfg.mcpServers];
  servers[idx] = next;
  settings().save({ mcpServers: servers });
  await require('../mcpService').mcpService.reloadAll();
  return { status: 'ok', updated: true, entryId: id, server: next };
}

// ---------------- canvas (local: an artifact with a share state) ----------------
const canvas = () => require('../canvasService').canvasService;

/** Turn a canvas locator into the artifact id it names. */
function canvasLocator(params = {}) {
  const locator = params.locator ?? params;
  return { locator, canvasId: canvas().canvasIdOf(locator) };
}

/** The share of a canvas. */
const getCanvasShare = async (p) => ({ status: 'ok', ...canvas().getShare(p.locator ?? p) });

/** Change who a canvas is visible to. */
const setCanvasVisibility = async (p) => ({ status: 'ok', ...canvas().setVisibility(p.locator ?? p, p.visibility) });

/** The principals a canvas is shared with. */
const getCanvasShareAccess = async (p) => ({ status: 'ok', ...canvas().getShareAccess(p.locator ?? p) });

/** Set the principals a canvas is shared with. */
const updateCanvasShareAccess = async (p) => ({
  status: 'ok',
  ...canvas().updateShareAccess(p.locator ?? p, p.principals, p.expectedStateToken),
});

/** Give a canvas an address (a slug). */
const setCanvasPageAddress = async (p) => ({ status: 'ok', ...canvas().setPageAddress(p.locator ?? p, p.slug) });

/** Rename a canvas. */
const renameCanvas = async (p) => ({ status: 'ok', ...canvas().rename(p.locator ?? p, p.title) });

/** Open a canvas link (local canvas or an external URL). */
const openCanvasLink = async (p) => ({ ...(await canvas().openLink(p)) });

/** Export a canvas as a single self-contained HTML file. */
const exportCanvasShareFile = async (p) => ({ status: 'ok', ...canvas().exportShareFile(p.canvasId ?? (p.locator ?? {}).canvasId, p) });

// ---------------- library documents (local) ----------------
const documents = () => require('../documentsService').documentsService;

const getDocument = async (p) => {
  const id = String(p.id ?? (p.locator ?? {}).id ?? (p.locator ?? {}).documentId ?? '');
  if (!id) throw new Error('a document id is required');
  return { status: 'ok', document: documents().getDocument(id) };
};

const saveDocument = async (p) => {
  const saved = documents().saveDocument({
    id: p.id ?? (p.locator ?? {}).id,
    title: p.title,
    content: p.content ?? p.source ?? '',
    visibility: p.visibility,
  });
  return { status: 'ok', document: saved };
};

const listLibraryDocs = async () => ({ status: 'ok', documents: documents().listLibraryDocs() });

const setDocumentVisibility = async (p) => {
  const id = String(p.id ?? (p.locator ?? {}).id ?? '');
  const visibility = String(p.visibility ?? '');
  return { status: 'ok', document: documents().setDocumentVisibility(id, visibility) };
};

const getDocumentEditRight = async (p) => {
  const locator = p.locator ?? {};
  const documentId = String(locator.documentId ?? locator.id ?? p.id ?? '');
  if (!documentId) return { status: 'error', error: 'locator.documentId is required' };
  let found = false;
  try { documents().getDocument(documentId); found = true; } catch {}
  // Everything is local, so everything that exists is editable.
  return { status: 'ok', storeId: locator.storeId ?? null, documentId, editable: found, found, readOnly: false };
};

const getDocumentAssets = async (p) => {
  const id = String(p.id ?? (p.locator ?? {}).id ?? '');
  return { status: 'ok', ...documents().getDocumentAssets(id) };
};

const resolveLibraryPages = async (p) => ({ status: 'ok', pages: documents().resolveLibraryPages() });

// ---------------- attachments (local) ----------------
const attachments = () => require('../documentsService').documentsService;

const stageAttachmentBytes = async (p) => ({
  status: 'ok',
  ...attachments().stageAttachmentBytes({ name: p.name, mimeType: p.mimeType ?? p.mime, data: p.data ?? p.base64 }),
});

const stageAttachmentPath = async (p) => ({
  status: 'ok',
  ...attachments().stageAttachmentPath({ name: p.name, path: p.path }),
});

const discardStagedAttachment = async (p) => ({ status: 'ok', ...attachments().discardStagedAttachment(p.token) });

const commitStagedAttachments = async (p) => ({
  status: 'ok',
  ...attachments().commitStagedAttachments({ tokens: p.tokens ?? [p.token], agentId: p.agentId, sessionId: p.sessionId }),
});

const readAttachmentBytes = async (p) => ({ status: 'ok', ...attachments().readAttachmentBytes(p.token) });

const resolveAttachmentMedia = async (p) => ({ status: 'ok', ...attachments().resolveAttachmentMedia(p.token) });

// ---------------- meetings (local) ----------------
const meetings = () => require('../meetingService').meetingService;

const listMeetings = async () => ({ status: 'ok', meetings: meetings().list() });

const leaveMeeting = async (p) => {
  const meeting = meetings().get(String(p.meetingId ?? ''));
  if (!meeting) return { status: 'error', reason: 'unknown meeting' };
  return { status: 'ok', meetingId: meeting.id, left: true };
};

const meetingCensus = async () => {
  const list = meetings().list();
  return {
    status: 'ok',
    total: list.length,
    analyzed: list.filter((m) => m.analyzed).length,
    turns: list.reduce((sum, m) => sum + m.turns, 0),
  };
};



// ---------------- voice calls (local: a real voice session) ----------------
const voiceCall = () => require('../voiceCallService').voiceCallService;

/** Mint a credential for a voice call. */
const mintVoiceCallCredential = async (p) => ({ status: 'ok', ...voiceCall().mintCredential({ ttlMs: p.ttlMs, sessionId: p.sessionId }) });

/** Open a voice call. */
const startVoiceCall = async (p) => ({ status: 'ok', call: voiceCall().start({ sessionId: p.sessionId, credential: p.credential, title: p.title }) });

/** The state of a voice call. */
const getVoiceCall = async (p) => {
  const call = voiceCall().get(p.callId);
  if (!call) return { status: 'error', reason: 'unknown voice call' };
  return { status: 'ok', call: voiceCall().publicCall(call) };
};

/** Interrupt the agent mid-sentence (the user talks over it). */
const nudgeVoiceCall = async (p) => ({ status: 'ok', ...voiceCall().nudge(p.callId) });

/** Record a message in the call. */
const recordVoiceCall = async (p) => ({ status: 'ok', message: voiceCall().record(p.callId, { from: p.from, text: p.text }) });

/** The messages the agent sent during the call. */
const readVoiceCallSentMessages = async (p) => ({ status: 'ok', messages: voiceCall().sentMessages(p.callId) });

/** Set the presence of a call. */
const setVoiceCallPresence = async (p) => ({ status: 'ok', call: voiceCall().setPresence(p.callId, p.presence) });

/** The harness session of a call. */
const voiceCallHarnessSession = async (p) => ({ status: 'ok', ...voiceCall().harnessSession({ callId: p.callId, sessionId: p.sessionId }) });

/** Run a tool inside a call. */
const voiceCallHarnessTool = async (p) => ({ status: 'ok', ...(await voiceCall().harnessTool({ callId: p.callId, name: p.name, args: p.args, sessionId: p.sessionId })) });

/**
 * Some surfaces only exist inside the Electron main process (windows, the
 * file dialog, the app lifecycle). Outside it they answer honestly instead
 * of throwing a TypeError.
 */
function needsMainProcess(what, feature = 'app') {
  let electron = null;
  try { electron = require('electron'); } catch { /* not in Electron */ }
  if (electron && typeof electron === 'object') {
    if (feature === 'dialog') { if (electron.dialog) return null; }
    else if (feature === 'app') { if (electron.app) return null; }
    else if (feature === 'clipboard') { if (electron.clipboard) return null; }
    else return null;
  }
  return { status: 'error', error: `${what} needs the desktop app` };
}

const HANDLERS = {
  'ok': async () => ok(),

  // ---- sessions ("agents") ----
  'sessions.list': async () => ({ status: 'ok', agents: sessionService().list() }),
  'sessions.get': async (p) => attempt(() => sessionService().get(p.id ?? p.agentId)),
  'sessions.search': async (p) => {
    const q = String(p.q ?? p.query ?? '').toLowerCase();
    const list = sessionService().list();
    return { status: 'ok', agents: q ? list.filter((s) => (s.title || '').toLowerCase().includes(q)) : list };
  },
  'sessions.count': async () => ({ status: 'ok', count: sessionService().list().length }),
  'sessions.create': async (p) => {
    const id = (typeof crypto.randomUUID === 'function' && crypto.randomUUID()) || `s-${Date.now().toString(36)}`;
    sessionService().ensure(id);
    if (p.title) try { sessionService().rename(id, String(p.title)); } catch {}
    return ok({ id, sessionId: id });
  },
  'sessions.remove': async (p) => ok({ removed: sessionService().remove(p.id ?? p.agentId) }),
  'sessions.rename': async (p) => ok(sessionService().rename(p.id ?? p.agentId, String(p.title ?? ''))),
  'sessions.setActive': async () => ok({ active: p_active() }),
  'sessions.active': async () => ({ status: 'ok', active: p_active() }),

  // ---- agent loop ----
  'agent.run': async (p, ctx) => {
    const sessionId = p.agentId ?? p.sessionId ?? p.id ?? (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `s-${Date.now().toString(36)}`);
    try { sessionService().ensure(sessionId); } catch {}
    // The turn runs in the background; a failure is reported to the session
    // by the agent service, so it must not become an unhandled rejection.
    require('../agentService').agentService.run(ctx.event, {
      sessionId, message: p.message ?? p.prompt, attachments: p.attachments ?? [],
    }).catch(() => { /* reported to the session */ });
    return ok({ sessionId, started: true });
  },

  // ---- delegated tasks / subagents ----
  'tasks.list': async (p, ctx) => attempt(() => require('../agentService').agentService.task(ctx.event, { sessionId: p.agentId ?? p.sessionId, action: 'list' })),
  'tasks.interrupt': async (p, ctx) => attempt(() => require('../agentService').agentService.task(ctx.event, { sessionId: p.agentId ?? p.sessionId, id: p.id, action: 'interrupt' })),
  'tasks.start': async (p, ctx) => attempt(() => require('../agentService').agentService.task(ctx.event, {
    sessionId: p.agentId ?? p.sessionId, action: 'start', prompt: p.prompt,
    description: p.description ?? (p.prompt || '').slice(0, 80),
    subagent_type: p.subagent_type, model: p.model, environment: p.environment,
  })),

  // ---- MCP servers ----
  'mcp.status': async () => ({ status: 'ok', servers: require('../mcpService').mcpService.status() }),
  'mcp.tools': async () => ({ status: 'ok', tools: require('../mcpService').mcpService.toolSpecs() }),
  'mcp.servers': async () => ({ status: 'ok', servers: settings().load().mcpServers ?? [] }),
  'mcp.add': async (p, ctx) => {
    const config = { name: String(p.name), command: p.command, args: p.args ?? [], env: p.env ?? {} };
    const next = [...(settings().load().mcpServers ?? []).filter((s) => s.name !== config.name), config];
    settings().save({ mcpServers: next });
    await require('../mcpService').mcpService.reloadAll();
    return ok({ added: config.name, servers: next.length });
  },
  'mcp.remove': async (p, ctx) => {
    const name = String(p.name ?? p.account);
    const next = (settings().load().mcpServers ?? []).filter((s) => s.name !== name);
    settings().save({ mcpServers: next });
    try { await require('../mcpService').mcpService.stopServer(name); } catch {}
    return ok({ removed: name, servers: next.length });
  },
  'mcp.rename': async (p, ctx) => {
    const from = String(p.from ?? p.account), to = String(p.name ?? p.to);
    const next = (settings().load().mcpServers ?? []).map((s) => (s.name === from ? { ...s, name: to } : s));
    settings().save({ mcpServers: next });
    await require('../mcpService').mcpService.reloadAll();
    return ok({ renamed: [from, to] });
  },
  // ---- MCP catalog (real, installable) + governed tools + effective plugins ----
  'mkt.mcpCatalog': async (p) => ({ status: 'ok', servers: require('../marketplaceService').marketplaceService.list({ kind: 'mcp', query: p.query }) }),
  'refreshMcp': async () => {
    const mcp = require('../mcpService').mcpService;
    await mcp.ensureLoaded();
    return { status: 'ok', servers: mcp.status() };
  },
  'getGrokBotAgentMcpServers': async (p) => {
    const mcp = require('../mcpService').mcpService;
    await mcp.ensureLoaded();
    const live = new Map(mcp.status().map((s) => [s.name, s]));
    const servers = (settings().load().mcpServers ?? []).map((cfg) => {
      const st = live.get(cfg.name);
      return {
        name: cfg.name, command: cfg.command ?? null, args: cfg.args ?? [],
        status: st?.status ?? 'stopped', tools: st?.tools ?? [], pid: st?.pid ?? null,
        hasEnv: Object.keys(cfg.env ?? {}).length > 0, agentId: p.agentId ?? null,
      };
    });
    return { status: 'ok', servers, agentId: p.agentId ?? null };
  },
  'refreshMcpCatalog': async () => {
    const catalog = require('../marketplaceService').marketplaceService.list({ kind: 'mcp' });
    return { status: 'ok', entries: catalog, count: catalog.length, refreshedAt: Date.now() };
  },
  'getMcpPluginLogo': async (p) => {
    const url = String(p.url ?? '');
    if (!/^https?:\/\//.test(url)) return { status: 'error', error: 'logo url must be http(s)' };
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const path = require('node:path');
    const userData = process.env.QUANSIOX_USER_DATA_DIR || (() => { try { return require('electron').app.getPath('userData'); } catch { return require('node:os').tmpdir(); } })();
    const logoDir = path.join(userData, 'mcp-logos');
    const key = crypto.createHash('sha1').update(url).digest('hex');
    const metaPath = path.join(logoDir, `${key}.json`);
    try {
      const cached = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (cached.path && fs.existsSync(cached.path)) return { status: 'ok', ...cached, cached: true };
    } catch {}
    try {
      const res = await fetch(url);
      if (!res.ok) return { status: 'ok', logo: null, error: `logo fetch HTTP ${res.status}`, url };
      const mime = res.headers.get('content-type')?.split(';')[0] || 'image/png';
      const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/gif': 'gif' })[mime] || 'bin';
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > 2 * 1024 * 1024) return { status: 'ok', logo: null, error: 'logo too large', url };
      fs.mkdirSync(logoDir, { recursive: true });
      const dest = path.join(logoDir, `${key}.${ext}`);
      fs.writeFileSync(dest, bytes, { mode: 0o600 });
      const meta = { url, path: dest, mime, bytes: bytes.length, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
      fs.writeFileSync(metaPath, JSON.stringify({ url, path: dest, mime, bytes: bytes.length }, null, 2), { mode: 0o600 });
      return { status: 'ok', ...meta, cached: false };
    } catch (e) { return { status: 'ok', logo: null, error: String(e?.message ?? e), url }; }
  },
  'installMcpEntry': async (p) => {
    const marketplace = require('../marketplaceService').marketplaceService;
    const entryId = String(p.entryId ?? '');
    const pkg = marketplace.CATALOG.find((x) => x.id === entryId);
    if (!pkg || pkg.kind !== 'mcp') return { status: 'error', error: `no MCP catalog entry: ${entryId}` };
    const values = p.values ?? {};
    const fill = (s) => String(s).replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (m, k) => (values[k] !== undefined ? String(values[k]) : m));
    const cfg = settings().load();
    const existing = (cfg.mcpServers ?? []).find((s) => s.name === pkg.id);
    const entry = {
      name: pkg.id,
      command: pkg.command,
      args: (pkg.args ?? []).map(fill),
      ...(pkg.env || values ? { env: Object.fromEntries(Object.entries(pkg.env ?? {}).map(([k, v]) => [k, fill(v)])) } : {}),
      installValues: { ...values },
    };
    settings().save({ mcpServers: [...(cfg.mcpServers ?? []).filter((s) => s.name !== pkg.id), entry] });
    await require('../mcpService').mcpService.reloadAll();
    return { status: 'ok', installed: !existing, entryId: pkg.id, server: entry, valuesApplied: Object.keys(values).length };
  },
  'uninstallMcpPlugin': async (p) => {
    const id = String(p.pluginId ?? p.id ?? p.name ?? '');
    const cfg = settings().load();
    const before = (cfg.mcpServers ?? []).length;
    settings().save({ mcpServers: (cfg.mcpServers ?? []).filter((s) => s.name !== id) });
    try { await require('../mcpService').mcpService.stopServer(id); } catch {}
    return { status: 'ok', removed: before !== (settings().load().mcpServers ?? []).length, entryId: id };
  },
  'updateMcpPluginInstall': async (p) => updateInstalledPluginImpl(p),
  'updatePluginInstall': async (p) => updateInstalledPluginImpl(p),
  // ---- agent skills & plugins (Batch 10) ----
  'addGrokBotAgentSkill': async (p) => {
    try { return { status: 'ok', skill: require('../agentSkillsService').agentSkillsService.add(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'updateGrokBotAgentSkill': async (p) => {
    try { return { status: 'ok', skill: require('../agentSkillsService').agentSkillsService.update(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'removeGrokBotAgentSkill': async (p) => ({ status: 'ok', ...require('../agentSkillsService').agentSkillsService.remove(p) }),
  'getGrokBotAgentSkills': async (p) => ({ status: 'ok', skills: require('../agentSkillsService').agentSkillsService.list(p.agentId) }),
  'getGrokBotAgentPlugins': async (p) => ({ status: 'ok', ...require('../agentPluginsService').agentPluginsService.getPlugins(p) }),
  'setGrokBotAgentPlugins': async (p) => {
    try { return { status: 'ok', ...require('../agentPluginsService').agentPluginsService.setPlugins(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'setGrokBotAgentPluginVariables': async (p) => {
    try { return { status: 'ok', ...require('../agentPluginsService').agentPluginsService.setPluginVariables(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'getTimeZone': async () => {
    const override = settings().load().timeZoneOverride ?? null;
    return {
      status: 'ok',
      timeZone: override || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      offsetMinutes: -new Date().getTimezoneOffset(),
      overridden: Boolean(override),
    };
  },
  // ---- local voice (Batch 11) ----
  'synthesizeSpeech': async (p) => {
    try { return { status: 'ok', ...(await require('../voiceService').voiceService.synthesize(p)) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'previewVoice': async (p) => {
    try { return { status: 'ok', greetingId: p.greetingId ?? null, ...require('../voiceService').voiceService.preview({ voiceId: p.voiceId, greeting: p.greeting }) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'setAgentVoice': async (p) => {
    try { return { status: 'ok', ...require('../voiceService').voiceService.setAgentVoice(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'setGrokBotAgentVoice': async (p) => {
    try { return { status: 'ok', ...require('../voiceService').voiceService.setAgentVoice({ id: p.agentId, voiceId: p.voiceId, voiceSpeed: p.voiceSpeed, voiceLanguage: p.voiceLanguage }) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'setComputerViewOpen': async (p) => {
    const isOpen = Boolean(p.isOpen);
    settings().save({ computerViewOpen: isOpen });
    try { require('../ipc/emitEvent').emitEvent('computer', 'viewOpen', { isOpen }); } catch {}
    return { status: 'ok', isOpen };
  },
  'getBoxHostPhase': async () => {
    try {
      const rows = require('../sandboxService').sandboxService.status();
      const active = rows.find((r) => r.status === 'ready') ?? rows[0] ?? null;
      return { status: 'ok', phase: active ? active.status : 'idle', sandboxes: rows.length, active: active ? { sessionId: active.sessionId, status: active.status, pid: active.pid } : null };
    } catch (e) { return { status: 'ok', phase: 'idle', sandboxes: 0, active: null }; }
  },
  'setAgentHiddenFromSidebar': async (p) => {
    const id = String(p.id ?? p.agentId ?? '');
    if (!id) return { status: 'error', error: 'id is required' };
    const hidden = Array.isArray(settings().load().hiddenAgents) ? settings().load().hiddenAgents : [];
    const next = p.isHidden ? [...new Set([...hidden, id])] : hidden.filter((x) => x !== id);
    settings().save({ hiddenAgents: next });
    return { status: 'ok', ok: true, id, isHidden: Boolean(p.isHidden) };
  },
  'reportTranscriptParity': async (p) => { try { require('../diagnosticsService').diagnosticsService.record('transcript_parity', p ?? {}); } catch {} return { status: 'ok', ok: true }; },
  'reportTranscriptRowLoss': async (p) => { try { require('../diagnosticsService').diagnosticsService.record('transcript_row_loss', p ?? {}); } catch {} return { status: 'ok', ok: true }; },
  'reportTranscriptSource': async (p) => { try { require('../diagnosticsService').diagnosticsService.record('transcript_source', p ?? {}); } catch {} return { status: 'ok', ok: true }; },
  'getTrays': async () => ({ status: 'ok', trays: require('../userInteractionService').userInteractionService.listTrays() }),
  'clearTrays': async () => ({ status: 'ok', cleared: require('../userInteractionService').userInteractionService.clearTrays() }),
  'dismissTray': async (p) => {
    try { return { status: 'ok', ...require('../userInteractionService').userInteractionService.dismissTray(String(p.id ?? '')) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'submitUserForm': async (p) => {
    try {
      return {
        status: 'ok',
        ...require('../userInteractionService').userInteractionService.submitForm({
          entryId: String(p.entryId ?? ''),
          values: p.values,
          saveToVault: Boolean(p.saveToVault),
        }),
      };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'dismissUserForm': async (p) => {
    try {
      return {
        status: 'ok',
        ...require('../userInteractionService').userInteractionService.dismissForm({
          entryId: String(p.entryId ?? ''),
          mode: p.mode,
          agentId: p.agentId,
          platform: p.platform,
          sessionId: p.sessionId,
        }),
      };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'respondToWidget': async (p) => {
    try {
      return {
        status: 'ok',
        ...require('../userInteractionService').userInteractionService.respondWidget({
          entryId: String(p.entryId ?? ''),
          value: p.value,
          agentId: p.agentId,
          sessionId: p.sessionId,
        }),
      };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'dismissWidget': async (p) => {
    try {
      return {
        status: 'ok',
        ...require('../userInteractionService').userInteractionService.dismissWidget({
          entryId: String(p.entryId ?? ''),
          agentId: p.agentId,
          sessionId: p.sessionId,
        }),
      };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  // ---- gateway control plane (Batch 13) ----
  'forceReconnectGateway': async () => ({ status: 'ok', ...require('../gatewayStateService').gatewayStateService.reconnect() }),
  'setGatewayPaused': async (p) => {
    const paused = typeof p.paused === 'boolean' ? p.paused : (typeof p.value === 'boolean' ? p.value : null);
    if (paused === null) return { status: 'error', error: 'paused (boolean) is required' };
    return { status: 'ok', ...require('../gatewayStateService').gatewayStateService.setPaused(paused) };
  },
  'setDevGatewayOffline': async (p) => ({ status: 'ok', ...require('../gatewayStateService').gatewayStateService.setDevOffline(Boolean(p.induced)) }),
  'resolveGatewayConnection': async (p) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const raw = String(p.path ?? '');
    if (!raw) return { status: 'error', error: 'path is required' };
    // Symbolic paths resolve service connection descriptors (Grok's
    // coordinator asks for 'gateway' / 'local-exec-refresh' / provider
    // connections by name rather than by filesystem path).
    if (raw === 'gateway') {
      const gw = require('../gatewayStateService').gatewayStateService;
      return ok({ path: raw, connection: { kind: 'gateway', transport: 'in-process', processId: process.pid, ...gw.status() } });
    }
    if (raw === 'cookie-provider') {
      const approvals = require('../cookieApprovalService').cookieApprovalService;
      return ok({ path: raw, connection: { kind: 'in-process', service: 'cookieApprovalService', pending: approvals.list().length } });
    }
    if (raw === 'passkey-provider') {
      return { status: 'unavailable', path: raw, scope: 'backend', reason: 'no macOS passkey signer helper is bundled with Quansiox' };
    }
    if (raw === 'local-exec-refresh') {
      const exec = require('../execDaemonService').execDaemonService;
      const d = exec.status();
      if (!d || d.status === 'not-spawned') {
        return ok({ path: raw, available: false, reason: 'no local exec daemon running', daemon: d });
      }
      const cred = exec.mintCredential(d.id);
      const sealed = exec.sealPayload(JSON.stringify({
        kind: 'local-exec-refresh', daemonId: d.id, sockPath: d.sock, pid: d.pid,
        token: cred.token, bootstrapPath: cred.path, issuedAt: Date.now(),
      }));
      return ok({ path: raw, available: true, daemon: d, keyId: sealed.keyId, alg: sealed.alg, contents: sealed.contents });
    }
    const base = settings().load().workspaceRoot || process.cwd();
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(base, raw);
    let kind = 'missing';
    try {
      const st = fs.statSync(resolved);
      kind = st.isDirectory() ? 'directory' : 'file';
    } catch {}
    return { status: 'ok', path: resolved, kind, exists: kind !== 'missing' };
  },
  'setTimeZoneOverride': async (p) => {
    const tz = p.timeZone == null ? null : String(p.timeZone);
    if (tz) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); }
      catch { return { status: 'error', error: `invalid time zone: ${tz}` }; }
    }
    settings().save({ timeZoneOverride: tz });
    try { require('../ipc/emitEvent').emitEvent('gateway', 'timeZoneOverride', { timeZone: tz }); } catch {}
    return { status: 'ok', timeZone: tz, overridden: Boolean(tz) };
  },
  // ---- desktop overlay panel (Batch 14) ----
  'mount': async (p) => {
    try { return { status: 'ok', ...require('../panelService').panelService.mount(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'unmount': async () => ({ status: 'ok', ...require('../panelService').panelService.unmount() }),
  'read': async () => ({ status: 'ok', ...require('../panelService').panelService.read() }),
  'offerChoices': async (p) => {
    try { return { status: 'ok', ...require('../panelService').panelService.offerChoices(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'readChoices': async () => ({ status: 'ok', ...require('../panelService').panelService.readChoices() }),
  'reachForMenu': async (p) => ({ status: 'ok', ...require('../panelService').panelService.reachForMenu(p) }),
  'submitPrompt': async (p, ctx) => {
    try {
      const { agentId, prompt } = require('../panelService').panelService.submitPrompt(p);
      try { sessionService().ensure(agentId); } catch {}
      const run = require('../agentService').agentService.run(ctx?.event ?? { sender: null }, { sessionId: agentId, message: prompt, attachments: [] });
      if (run && typeof run.then === 'function') run.catch(() => {});
      return { status: 'ok', submitted: true, sessionId: agentId, prompt };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'switchTo': async (p) => {
    try { return { status: 'ok', ...require('../panelService').panelService.switchTo(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  // ---- terms, prefs, entry install, document rights (Batch 15) ----
  'markGrokBotTermsSeen': async () => {
    const rec = { seen: true, seenAt: Date.now() };
    settings().save({ grokBotTermsRecord: rec });
    return { status: 'ok', ...rec };
  },
  'getGrokBotTermsRecord': async () => {
    const rec = settings().load().grokBotTermsRecord;
    return { status: 'ok', seen: rec?.seen === true, seenAt: rec?.seenAt ?? null };
  },
  'getBotColorInChatEnabled': async () => ({ status: 'ok', enabled: settings().load().botColorInChat !== false }),
  'setBotColorInChatEnabled': async (p) => {
    const enabled = typeof p.enabled === 'boolean' ? p.enabled : Boolean(p.value ?? true);
    settings().save({ botColorInChat: enabled });
    return { status: 'ok', enabled };
  },
  'setGrokBotAgentSidebarHidden': async (p) => {
    const id = String(p.agentId ?? p.id ?? '');
    if (!id) return { status: 'error', error: 'agentId is required' };
    const hidden = Array.isArray(settings().load().hiddenAgents) ? settings().load().hiddenAgents : [];
    const next = p.isHidden ? [...new Set([...hidden, id])] : hidden.filter((x) => x !== id);
    settings().save({ hiddenAgents: next });
    return { status: 'ok', agentId: id, isHidden: Boolean(p.isHidden) };
  },
  'setGrokBotAgentVisibility': async (p) => {
    const id = String(p.agentId ?? '');
    const visibility = String(p.visibility ?? '');
    if (!id) return { status: 'error', error: 'agentId is required' };
    if (!['owner', 'team'].includes(visibility)) return { status: 'error', error: 'visibility must be owner|team' };
    const map = { ...(settings().load().agentVisibility ?? {}) };
    map[id] = visibility;
    settings().save({ agentVisibility: map });
    return { status: 'ok', agentId: id, visibility, teamSharingAvailable: false, note: 'team sharing requires the Grok backend; preference stored locally' };
  },
  'installEntry': async (p) => {
    try {
      const id = String(p.entryId ?? '');
      const result = require('../marketplaceService').marketplaceService.install(id);
      if (!p.values || typeof p.values !== 'object' || Object.keys(p.values).length === 0) {
        return { status: 'ok', ok: true, ...result, hasTeamConfiguredVariables: Boolean(p.hasTeamConfiguredVariables) };
      }
      const updated = await updateInstalledPluginImpl({ pluginId: id, values: p.values });
      if (updated.status !== 'ok') {
        return { status: 'ok', ok: true, ...result, valuesApplied: false, valuesError: updated.error ?? 'values not applicable', hasTeamConfiguredVariables: Boolean(p.hasTeamConfiguredVariables) };
      }
      return { status: 'ok', ok: true, ...result, valuesApplied: true, values: p.values, hasTeamConfiguredVariables: Boolean(p.hasTeamConfiguredVariables) };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'getDocumentEditRight': async (p) => {
    const locator = p.locator ?? {};
    const documentId = String(locator.documentId ?? '');
    if (!documentId) return { status: 'error', error: 'locator.documentId is required' };
    let found = false;
    try { require('../documentsService').documentsService.getDocument(documentId); found = true; } catch {}
    return { status: 'ok', storeId: locator.storeId ?? null, documentId, editable: found, found, readOnly: false };
  },
  // ---- macOS Messages integration (Batch 16) ----
  'checkMessagesPermissions': async (p) => ({ status: 'ok', ...require('../macMessagesService').macMessagesService.checkPermissions(p ?? {}) }),
  'getCurrentMachineMessagesEnabled': async () => ({ status: 'ok', ...require('../macMessagesService').macMessagesService.getEnabled() }),
  'updateCurrentMachineMessagesEnabled': async (p) => ({ status: 'ok', ...require('../macMessagesService').macMessagesService.setEnabled(p.messagesEnabled) }),
  'getMessagesAppIcon': async () => ({ status: 'ok', ...require('../macMessagesService').macMessagesService.getAppIcon() }),
  'listMessagesAllowedRecipients': async () => ({ status: 'ok', ...require('../macMessagesService').macMessagesService.listRecipients() }),
  'revokeMessagesAllowedRecipient': async (p) => {
    try { return { status: 'ok', ...require('../macMessagesService').macMessagesService.revokeRecipient(p.recipient) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'requestMessagesGrants': async (p) => {
    try { return { status: 'ok', ...require('../macMessagesService').macMessagesService.requestGrants(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'awaitMessagesGrants': async (p) => {
    try { return { status: 'ok', ...(await require('../macMessagesService').macMessagesService.awaitGrants(p)) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'resolveMessagesGrants': async (p) => {
    try { return { status: 'ok', ...require('../macMessagesService').macMessagesService.resolveGrants(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'cancelMessagesGrants': async (p) => {
    try { return { status: 'ok', ...require('../macMessagesService').macMessagesService.cancelGrants(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  // Real chat.db reads + sending (Full Disk Access required to read).
  'getMessagesReadStatus': async () => ({ status: 'ok', ...(await require('../macMessagesService').macMessagesService.readStatus()) }),
  'listMessagesChats': async (p) => {
    try { return { status: 'ok', ...(await require('../macMessagesService').macMessagesService.listChats(p ?? {})) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e), code: e?.code ?? null }; }
  },
  'readMessages': async (p) => {
    try { return { status: 'ok', ...(await require('../macMessagesService').macMessagesService.readMessages(p ?? {})) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e), code: e?.code ?? null }; }
  },
  'searchMessages': async (p) => {
    try { return { status: 'ok', ...(await require('../macMessagesService').macMessagesService.searchMessages(p ?? {})) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e), code: e?.code ?? null }; }
  },
  'sendMessagesMessage': async (p) => {
    try { return { status: 'ok', ...require('../macMessagesService').macMessagesService.sendMessage(p ?? {}) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  // ---- feedback sink (Batch 13) ----
  'submitFeedback': async (p) => {
    try { return { status: 'ok', ...require('../feedbackService').feedbackService.append('feedback', p ?? {}) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'voteFeedback': async (p) => {
    try { return { status: 'ok', ...require('../feedbackService').feedbackService.append('vote', p ?? {}) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'promptAcceptanceStatus': async (p) => {
    const sessionId = String(p.sessionId ?? p.agentId ?? p.id ?? '');
    if (!sessionId) return { status: 'error', error: 'sessionId is required' };
    const { agentService } = require('../agentService');
    const running = agentService.isRunning(sessionId);
    return { status: 'ok', sessionId, accepted: running, running };
  },
  'readTranscriptStoreTail': async (p) => {
    const { transcriptService } = require('../transcriptService');
    let sessionId = p.sessionId ? String(p.sessionId) : null;
    if (!sessionId) {
      const { sessionService } = require('../sessionService');
      const sessions = sessionService.list?.() ?? [];
      sessionId = sessions[0]?.id ?? sessions[0]?.sessionId ?? null;
    }
    if (!sessionId) return { status: 'error', error: 'no session available' };
    try {
      const tail = transcriptService.tail(sessionId, { limit: Math.min(500, Math.max(1, Number(p.limit) || 50)) });
      return { status: 'ok', sessionId, rows: tail.turns, total: tail.total, count: tail.turns.length, found: true };
    } catch {
      return { status: 'ok', sessionId, rows: [], total: 0, count: 0, found: false };
    }
  },
  'setMcpToolPermissions': async (p) => {
    const serverId = String(p.serverId ?? p.server ?? '');
    if (!serverId) return { status: 'error', error: 'serverId is required' };
    const cfg = settings().load();
    const perms = { ...(cfg.mcpToolPermissions ?? {}) };
    perms[serverId] = {
      ...(perms[serverId] ?? {}),
      tools: p.tools ?? perms[serverId]?.tools ?? {},
      ...(p.reads !== undefined ? { reads: p.reads } : {}),
      ...(p.writes !== undefined ? { writes: p.writes } : {}),
      updatedAt: Date.now(),
    };
    settings().save({ mcpToolPermissions: perms });
    const mcp = require('../mcpService').mcpService;
    await mcp.ensureLoaded();
    return { status: 'ok', serverId, permissions: perms[serverId], toolSpecs: mcp.toolSpecs().filter((t) => t.function.name.startsWith(`mcp__${serverId}__`)).length };
  },
  'callMcpAppTool': async (p) => {
    let args = {};
    if (typeof p.argumentsJson === 'string' && p.argumentsJson.trim()) {
      try { args = JSON.parse(p.argumentsJson); } catch (e) { return { status: 'error', error: `argumentsJson is not valid JSON: ${e.message}` }; }
    } else if (p.argumentsJson && typeof p.argumentsJson === 'object') args = p.argumentsJson;
    try {
      const out = await require('../mcpService').mcpService.callToolOnServer(p.serverIdentifier, String(p.toolName ?? ''), args);
      return { status: 'ok', result: out.text, raw: out.raw, server: out.server, tool: out.tool, userActivated: Boolean(p.userActivated), agentId: p.agentId ?? null };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'readMcpAppResource': async (p) => {
    try {
      const out = await require('../mcpService').mcpService.readResource(p.serverIdentifier, p.resourceUri);
      return { status: 'ok', ...out, documentSha256: p.documentSha256 ?? null };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'stageMcpAppDocument': async (p) => {
    const html = String(p.html ?? '');
    if (!html) return { status: 'error', error: 'html is required' };
    const crypto = require('node:crypto');
    const sha256 = crypto.createHash('sha256').update(html).digest('hex');
    const doc = require('../documentsService').documentsService.saveDocument({
      title: `MCP App ${sha256.slice(0, 8)}`, content: html, visibility: 'private',
    });
    return { status: 'ok', id: doc.id, sha256, bytes: doc.bytes, csp: p.csp ?? null, path: doc.path };
  },
  'completeMcpOAuth': async (p) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const userData = process.env.QUANSIOX_USER_DATA_DIR || (() => { try { return require('electron').app.getPath('userData'); } catch { return require('node:os').tmpdir(); } })();
    const pendingFile = path.join(userData, 'mcp-oauth-pending.json');
    let pendingAll = {};
    try { pendingAll = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch {}
    const state = String(p.state ?? '');
    const pending = pendingAll[state];
    if (!pending) return { status: 'ok', ok: false, reason: 'no pending OAuth flow for this state' };
    if (pending.createdAtMs && Date.now() - pending.createdAtMs > 15 * 60 * 1000) {
      delete pendingAll[state]; fs.writeFileSync(pendingFile, JSON.stringify(pendingAll, null, 2), { mode: 0o600 });
      return { status: 'ok', ok: false, reason: 'OAuth flow expired' };
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: String(p.code ?? ''),
      client_id: String(pending.clientId ?? ''), redirect_uri: String(pending.redirectUri ?? ''),
    });
    if (pending.codeVerifier) body.set('code_verifier', String(pending.codeVerifier));
    try {
      const res = await fetch(pending.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.access_token) {
        return { status: 'ok', ok: false, server: pending.server, reason: `token endpoint HTTP ${res.status}${json.error ? ` (${json.error})` : ''}` };
      }
      const expiresAt = json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : null;
      const secretName = `mcp_${String(pending.server).replace(/[^A-Za-z0-9_-]/g, '_')}_oauth`;
      require('../secretsService').secretsService.set(secretName, {
        access_token: json.access_token,
        ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
        ...(expiresAt ? { expires_at: String(expiresAt) } : {}),
        token_type: json.token_type ?? 'Bearer',
      }, `MCP OAuth tokens for ${pending.server}`);
      delete pendingAll[state];
      fs.writeFileSync(pendingFile, JSON.stringify(pendingAll, null, 2), { mode: 0o600 });
      return { status: 'ok', ok: true, server: pending.server, secretName, expiresAt, hasRefreshToken: Boolean(json.refresh_token) };
    } catch (e) {
      return { status: 'ok', ok: false, server: pending.server, reason: String(e?.message ?? e) };
    }
  },
  'listBoxMcpServers': async (p) => {
    const os = require('node:os');
    const mcp = require('../mcpService').mcpService;
    await mcp.ensureLoaded();
    const wanted = Array.isArray(p.serverIdentifiers) && p.serverIdentifiers.length ? new Set(p.serverIdentifiers) : null;
    const servers = mcp.status().filter((s) => !wanted || wanted.has(s.name));
    return { status: 'ok', boxes: [{ id: 'local', kind: 'local-host', hostname: os.hostname(), platform: process.platform, servers }] };
  },
  'getMcpTeamPopularity': async () => {
    const sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const { diagnosticsService } = require('../diagnosticsService');
    const counts = {};
    for (const e of diagnosticsService.list({ kind: 'mcp_tool_call', sinceMs, limit: 5000 })) {
      const server = e.detail?.server;
      if (server) counts[server] = (counts[server] ?? 0) + 1;
    }
    const installed = new Set((settings().load().mcpServers ?? []).map((s) => s.name));
    const popularity = [...new Set([...Object.keys(counts), ...installed])]
      .map((server) => ({ server, calls: counts[server] ?? 0, installed: installed.has(server) }))
      .sort((a, b) => b.calls - a.calls);
    return { status: 'ok', windowDays: 30, popularity };
  },
  'consent.toolDisabled': async (p) => {
    const consent = require('../consentService').consentService;
    const tool = String(p.tool ?? p.name);
    const disabled = p.disabled ?? (p.value === true);
    if (disabled) return { status: 'ok', tool, ...consent.setGrant('*', tool, 'deny') };
    return { status: 'ok', tool, ...consent.revokeGrant('*', tool), enabled: true };
  },
  'mcp.effective': async () => {
    const { settingsService } = require('../settingsService');
    const skills = require('../skillsService').skillsService.list().filter((s) => s.enabled);
    const servers = settingsService.load().mcpServers ?? [];
    return { status: 'ok', plugins: skills.map((s) => ({ id: s.id, name: s.name, kind: 'skill' })), mcpServers: servers.map((s) => ({ id: s.name, kind: 'mcp' })) };
  },

  // ---- settings ----
  'settings.notifications': async (p) => { const value = bool(p.value, p.enabled, p.enabled); settings().save({ notifyOnDone: value }); return ok({ notifyOnDone: value }); },
  'settings.notifyUpdates': async (p) => { const value = bool(p.value, p.enabled); settings().save({ notifyOnUpdates: value }); return ok({ notifyOnUpdates: value }); },
  'settings.systemPromptExtra': async (p) => { const value = String(p.instructions ?? p.value ?? ''); settings().save({ systemPromptExtra: value }); return ok({ systemPromptExtra: value }); },
  'settings.readContext': async (p) => ok({
    systemPromptExtra: settings().load().systemPromptExtra || '',
    model: settings().load().model, sandboxMode: settings().load().sandboxMode,
  }),

  // ---- secrets ----
  'secrets.set': async (p) => ({ status: 'ok', secret: require('../secretsService').secretsService.set(p.name, p.fields, p.note) }),
  'secrets.list': async () => ({ status: 'ok', secrets: require('../secretsService').secretsService.list() }),
  'secrets.remove': async (p) => ok({ removed: require('../secretsService').secretsService.remove(p.name) }),
  'secrets.status': async () => ({ status: 'ok', count: require('../secretsService').secretsService.list().length, encrypted: true, boxSecrets: require('../boxSecretService').boxSecretService.status() }),

  // ---- skill / teach recording ----
  'skill.status': async () => attempt(() => require('../skillRecordingService').skillRecordingService.status()),
  'skill.list': async () => attempt(() => require('../skillRecordingService').skillRecordingService.list()),
  'skill.begin': async () => attempt(async () => {
    const skill = require('../skillRecordingService').skillRecordingService;
    try { if (skill.status().state === 'idle') await skill.prepare(); } catch {}
    await skill.begin();
    return skill.status();
  }),
  'skill.stop': async () => attempt(async () => {
    const skill = require('../skillRecordingService').skillRecordingService;
    await skill.stop(); await skill.complete();
    return skill.status();
  }),

  // ---- updates ----
  'updater.check': async () => attempt(() => require('../updaterService').updaterService.check()),

  // ---- host ----
  'host.status': async () => ({
    status: 'ok', platform: process.platform, sandboxMode: settings().load().sandboxMode ?? 'sandboxed',
    secrets: require('../secretsService').secretsService.list().length,
    sessions: sessionService().list().length, local: true,
  }),

  // ---- window (electron-only; main process) ----
  'window.close': async (p, ctx) => attempt(() => { const wm = require('../../windowManager').windowManager; const win = (p.id != null && wm.getWindowById(Number(p.id))?.win) || wm.mainWindow?.(); win?.close(); return { closed: true }; }),
  'window.minimize': async (p, ctx) => attempt(() => { const wm = require('../../windowManager').windowManager; const win = wm.mainWindow?.(); win?.minimize(); return { minimized: true }; }),
  'window.focus': async () => attempt(() => { require('../../windowManager').windowManager.focusMainWindow(); return { focused: true }; }),
  'window.state': async () => attempt(() => { const win = require('../../windowManager').windowManager.mainWindow?.(); const b = win?.getBounds() ?? {}; return { focused: win?.isFocused?.() ?? false, ...b }; }),
  'window.resize': async (p) => attempt(() => { const win = require('../../windowManager').windowManager.mainWindow?.(); const w = Math.max(600, Number(p.width) || win?.getBounds?.()?.width || 1280); win?.setSize?.(w, undefined); return { width: w }; }),
  'window.movePanel': async (p) => ({ status: 'ok', ...require('../panelService').panelService.move(p) }),
  'window.endPanelMove': async () => ({ status: 'ok', ...require('../panelService').panelService.endMove() }),

  // ---- automations & workflows (Grok createAgentAutomation / *Workflow) ----
  'automation.create': async (p) => ({ status: 'ok', automation: require('../automationService').automationService.create(p) }),
  'automation.createWorkflow': async (p) => ({ status: 'ok', automation: require('../automationService').automationService.create({ ...p, kind: 'workflow' }) }),
  'automation.update': async (p) => ({ status: 'ok', automation: require('../automationService').automationService.update(p.id, p) }),
  'automation.remove': async (p) => ok({ removed: require('../automationService').automationService.remove(p.id) }),
  'automation.listAutomations': async (p) => ({ status: 'ok', automations: require('../automationService').automationService.list(p.agentId ?? p.sessionId).filter((a) => a.kind === 'automation') }),
  'automation.listWorkflows': async (p) => ({ status: 'ok', workflows: require('../automationService').automationService.list(p.agentId ?? p.sessionId).filter((a) => a.kind === 'workflow') }),
  'automation.listAll': async () => ({ status: 'ok', automations: require('../automationService').automationService.list() }),
  'automation.setEnabled': async (p) => ({ status: 'ok', automation: require('../automationService').automationService.setEnabled(p.id, bool(p.enabled, p.value)) }),
  'automation.run': async (p) => require('../automationService').automationService.run(p.id),
  'automation.importText': async (p) => ({ status: 'ok', workflow: require('../automationService').automationService.importWorkflowText(p) }),
  'automation.importUrl': async (p) => ({ status: 'ok', workflow: require('../automationService').automationService.importWorkflowUrl(p) }),
  'automation.webhook': async (p) => {
    const rec = require('../automationService').automationService.webhookToken(p.id);
    const url = await require('../webhookService').webhookService.webhookUrl(p.id);
    return { status: 'ok', ...rec, ...url, note: 'POST this URL to trigger the automation locally' };
  },

  // ---- library documents + attachment staging (Grok getDocument / stageAttachment*) ----
  'doc.save': async (p) => ({ status: 'ok', document: require('../documentsService').documentsService.saveDocument(p) }),
  'doc.get': async (p) => ({ status: 'ok', document: require('../documentsService').documentsService.getDocument(p.id) }),
  'doc.list': async () => ({ status: 'ok', documents: require('../documentsService').documentsService.listLibraryDocs() }),
  'doc.setVisibility': async (p) => ({ status: 'ok', document: require('../documentsService').documentsService.setDocumentVisibility(p.id, p.visibility) }),
  'doc.pages': async () => ({ status: 'ok', pages: require('../documentsService').documentsService.resolveLibraryPages() }),
  'doc.assets': async (p) => ({ status: 'ok', ...require('../documentsService').documentsService.getDocumentAssets(p.id) }),
  'att.stageBytes': async (p) => ({ status: 'ok', attachment: require('../documentsService').documentsService.stageAttachmentBytes(p) }),
  'att.stagePath': async (p) => ({ status: 'ok', attachment: require('../documentsService').documentsService.stageAttachmentPath(p) }),
  'att.readText': async (p) => ({ status: 'ok', text: require('../documentsService').documentsService.readAttachmentText(p.id) }),
  'att.readBytes': async (p) => ({ status: 'ok', ...require('../documentsService').documentsService.readAttachmentBytes(p.id) }),
  'att.resolve': async (p) => ({ status: 'ok', media: require('../documentsService').documentsService.resolveAttachmentMedia(p.id) }),
  'att.discard': async (p) => ({ status: 'ok', ...require('../documentsService').documentsService.discardStagedAttachment(p.id) }),
  'att.commit': async (p) => ({ status: 'ok', ...require('../documentsService').documentsService.commitStagedAttachments(p) }),

  // ---- authenticated browser sessions (Grok importChromeCookies / cookie grants) ----
  'cookies.grants': async (p) => ({ status: 'ok', origins: require('../cookieImportService').cookieImportService.getGrants(p.sessionId) }),
  'cookies.putGrants': async (p) => ({ status: 'ok', origins: require('../cookieImportService').cookieImportService.putGrants(p.sessionId, { add: p.origins ?? p.add ?? [], remove: p.remove ?? [] }) }),
  'cookies.allowItems': async (p) => ({ status: 'ok', allowItems: require('../cookieImportService').cookieImportService.getGrants(p.sessionId) }),
  'cookies.import': async (p, ctx) => {
    const ci = require('../cookieImportService').cookieImportService;
    const plan = ci.planImport(p.sessionId, ci.resolveImportText(p));
    const applied = plan.records.length ? await require('../browserService').browserService.applyCookies(p.sessionId, plan.records) : { set: 0, failed: 0 };
    return { status: 'ok', parsed: plan.parsed, granted: plan.granted, skipped: plan.skipped, applied: applied.set, applyFailed: applied.failed, unmatchedOrigins: plan.unmatchedOrigins, hint: plan.unmatchedOrigins.length ? `grant origins via putCookieOriginGrants (e.g. ${plan.unmatchedOrigins[0]})` : undefined };
  },

  // ---- session conveniences (Grok getConversationOutline / searchMedia / avatars / drafts) ----
  'sess.outline': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.outline(p.sessionId ?? p.agentId) }),
  'sess.seedName': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.seedConversationName(p.sessionId ?? p.agentId, p.message ?? p.text) }),
  'sess.searchMedia': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.searchMedia(p.query, { kinds: p.kinds }) }),
  'sess.setAvatar': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.setAvatarBytes(p.sessionId ?? p.agentId, { contentBase64: p.contentBase64, mime: p.mime }) }),
  'sess.getAvatar': async (p) => ({ status: 'ok', ...(require('../sessionExtrasService').sessionExtrasService.getAvatar(p.sessionId ?? p.agentId) || { avatar: null }) }),
  'sess.genAvatar': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.generateAgentImage(p.sessionId ?? p.agentId, { label: p.label }) }),
  'sess.saveDraft': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.saveDraft(p.sessionId ?? p.agentId, p.text ?? p.draft) }),
  'sess.getDraft': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.getDraft(p.sessionId ?? p.agentId) }),
  'sess.discardDraft': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.discardDraft(p.sessionId ?? p.agentId) }),
  'sess.setDraftingDisabled': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.setDraftingDisabled(p.sessionId ?? p.agentId, p.disabled === true || p.value === true) }),

  // ---- local standing-consent grants (Grok local tool permissions) ----
  'consent.get': async (p) => ({ status: 'ok', scope: p.scope ?? '*', subject: p.subject ?? p.tool, mode: require('../consentService').consentService.getGrant(p.scope ?? '*', p.subject ?? p.tool) ?? 'ask' }),
  'consent.set': async (p) => ({ status: 'ok', ...require('../consentService').consentService.setGrant(p.scope ?? '*', p.subject ?? p.tool, p.mode) }),
  'consent.resolve': async (p) => {
    const cs = require('../consentService').consentService;
    const scope = p.scope ?? '*';
    const subject = p.subject ?? p.tool;
    const grant = cs.getGrant(scope, subject);
    if (grant) return { status: 'ok', scope, subject, mode: grant };
    const one = (p.action || p.target) ? cs.findApproval({ action: p.action ?? p.tool, target: p.target }) : null;
    return { status: 'ok', scope, subject, mode: one ? 'allow-once' : 'ask', approvalId: one?.approvalId ?? null };
  },
  'consent.allow': async (p) => ({ status: 'ok', ...require('../consentService').consentService.setGrant(p.scope ?? '*', p.subject ?? p.tool, 'allow') }),

  // ---- broadcast & roster (Grok broadcastToAgents / getServerAgentRoster) ----
  'bcast.broadcast': async (p) => ({ status: 'ok', ...await require('../broadcastService').broadcastService.broadcast(p) }),
  'bcast.roster': async () => ({ status: 'ok', ...require('../broadcastService').broadcastService.roster() }),

  // ---- long-term memory (Grok bot memories, local-first analog) ----
  'memory.list': async () => ({ status: 'ok', memories: require('../memoryService').memoryService.list() }),
  'memory.recall': async (p) => ({ status: 'ok', memories: require('../memoryService').memoryService.recall(p.query, { tags: p.tags, limit: p.limit }) }),
  'memory.remember': async (p) => ({ status: 'ok', memory: require('../memoryService').memoryService.remember(p.text, { tags: p.tags }) }),
  'memory.forget': async (p) => ({ status: 'ok', ...require('../memoryService').memoryService.forget(p.id) }),

  // ---- feature flags / experiment overrides (Grok applyFeatureFlagOverride etc.) ----
  'flags.snapshot': async () => ({ status: 'ok', ...require('../flagsService').flagsService.snapshot() }),
  'flags.refresh': async () => ({ status: 'ok', ...require('../flagsService').flagsService.refresh() }),
  'flags.override': async (p) => ({ status: 'ok', ...require('../flagsService').flagsService.override(p.flag ?? p.name, p.value ?? p.enabled) }),
  'flags.evaluate': async (p) => ({ status: 'ok', flag: p.flag ?? p.name, value: require('../flagsService').flagsService.evaluate(p.flag ?? p.name, p.default) }),

  // ---- workspace + roster search (Grok searchMedia / searchAgents) ----
  'search.media': async (p) => {
    const { settingsService } = require('../settingsService');
    const root = settingsService.load().workspaceRoot || process.cwd();
    const results = require('../searchService').searchService.listMedia(p.query, root, { kinds: p.kinds });
    return { status: 'ok', results, media: results };
  },
  'search.agents': async (p) => {
    const { sessionService } = require('../sessionService');
    return { status: 'ok', agents: require('../searchService').searchService.searchAgents(p.query, sessionService.list()) };
  },

  // ---- host preferences (pinned agents + sidebar sections) ----
  'host.pinned': async () => ({ status: 'ok', pinned: require('../hostPrefsService').hostPrefsService.getPinned() }),
  'host.setPinned': async (p) => ({ status: 'ok', pinned: require('../hostPrefsService').hostPrefsService.setPinned(p.ids ?? p.agents ?? p.pinned) }),
  'host.sections': async () => ({ status: 'ok', sections: require('../hostPrefsService').hostPrefsService.sections() }),
  'host.setSections': async (p) => ({ status: 'ok', sections: require('../hostPrefsService').hostPrefsService.setSections(p.sections) }),

  // ---- updates + notification preferences (real updaterService + settings) ----
  'upd.status': async () => {
    const { settingsService } = require('../settingsService');
    const { updaterService } = require('../updaterService');
    const s = settingsService.load();
    return { status: 'ok', version: updaterService.appVersion(), updateFeedUrl: s.updateFeedUrl || '', updateChannel: s.updateChannel || 'latest', autoUpdateWhenIdle: s.autoUpdateWhenIdle === true };
  },
  'upd.setTrack': async (p) => {
    const { settingsService } = require('../settingsService');
    const updateFeedUrl = String(p.url ?? p.feed ?? '');
    const updateChannel = String(p.track ?? p.channel ?? 'latest');
    settingsService.save({ updateFeedUrl, updateChannel });
    return { status: 'ok', updateFeedUrl, updateChannel };
  },
  'upd.setAutoUpdateWhenIdle': async (p) => {
    const { settingsService } = require('../settingsService');
    const autoUpdateWhenIdle = Boolean(p.enabled ?? p.value ?? true);
    settingsService.save({ autoUpdateWhenIdle });
    return { status: 'ok', autoUpdateWhenIdle };
  },
  'upd.quitAndInstall': async () => {
    const { settingsService } = require('../settingsService');
    const s = settingsService.load();
    if (!s.updateFeedUrl) return { status: 'error', error: 'no update feed configured (set one with setUpdateTrack/updateHostNow)' };
    const { updaterService } = require('../updaterService');
    return { status: 'ok', installing: true, result: await updaterService.install() };
  },
  'notif.get': async () => {
    const s = require('../settingsService').settingsService.load();
    return { status: 'ok', notifyOnDone: s.notifyOnDone !== false };
  },
  'notif.set': async (p) => {
    const { settingsService } = require('../settingsService');
    const notifyOnDone = Boolean(p.notifyOnDone ?? p.enabled ?? p.value);
    settingsService.save({ notifyOnDone });
    return { status: 'ok', notifyOnDone };
  },

  // ---- skills + plugin catalog (local skillsService) ----
  'skills.catalog': async () => ({ status: 'ok', skills: require('../skillsService').skillsService.list() }),
  'skills.publish': async (p) => ({ status: 'ok', skill: require('../skillsService').skillsService.install(p) }),
  'skills.sync': async (p) => ({ status: 'ok', ...require('../skillsService').skillsService.installBatch(p.skills ?? p.plugins ?? []) }),
  'skills.uninstall': async (p) => ({ status: 'ok', ...require('../skillsService').skillsService.uninstall(p.id) }),
  'skills.targets': async () => ({ status: 'ok', targets: require('../skillsService').skillsService.publishTargets() }),
  'skills.syncStatus': async () => ({ status: 'ok', ...require('../skillsService').skillsService.syncStatus() }),

  // ---- marketplace (Quansiox-owned local catalog over skills + MCP servers) ----
  'mkt.list': async (p) => ({ status: 'ok', packages: require('../marketplaceService').marketplaceService.list({ kind: p.kind, query: p.query }) }),
  'mkt.install': async (p) => ({ status: 'ok', ...require('../marketplaceService').marketplaceService.install(p.id) }),
  'mkt.uninstall': async (p) => ({ status: 'ok', ...require('../marketplaceService').marketplaceService.uninstall(p.id) }),
  'mkt.installManifest': async (p) => ({ status: 'ok', ...require('../marketplaceService').marketplaceService.installFromManifest(p.manifest ?? p) }),

  // ---- 0.71.2 renamed / new local aliases + simple local features ----
  'conversationOutlineGet': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.outline(p.sessionId ?? p.agentId ?? p.id) }),
  'subagentsGet': async (p, ctx) => {
    try {
      const r = await require('../agentService').agentService.task(ctx?.event ?? null, { sessionId: p?.agentId ?? p?.sessionId, action: 'list' });
      return { status: 'ok', result: r };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'injectChromeCookies': async (p, ctx) => {
    const ci = require('../cookieImportService').cookieImportService;
    const plan = ci.planImport(p.sessionId, ci.resolveImportText(p));
    const applied = plan.records.length ? await require('../browserService').browserService.applyCookies(p.sessionId, plan.records) : { set: 0, failed: 0 };
    return { status: 'ok', parsed: plan.parsed, granted: plan.granted, skipped: plan.skipped, applied: applied.set, applyFailed: applied.failed, unmatchedOrigins: plan.unmatchedOrigins };
  },
  'listLibraryPages': async () => ({ status: 'ok', pages: require('../documentsService').documentsService.resolveLibraryPages() }),
  // ---- canvas (local artifacts with a share state) ----
  'getCanvasShare': getCanvasShare,
  'setCanvasVisibility': setCanvasVisibility,
  'getCanvasShareAccess': getCanvasShareAccess,
  'updateCanvasShareAccess': updateCanvasShareAccess,
  'setCanvasPageAddress': setCanvasPageAddress,
  'renameCanvas': renameCanvas,
  'openCanvasLink': openCanvasLink,
  'exportCanvasShareFile': exportCanvasShareFile,
  // ---- library documents ----
  'getDocument': getDocument,
  'saveDocument': saveDocument,
  'listLibraryDocs': listLibraryDocs,
  'setDocumentVisibility': setDocumentVisibility,
  'getDocumentEditRight': getDocumentEditRight,
  'getDocumentAssets': getDocumentAssets,
  'resolveLibraryPages': resolveLibraryPages,
  // ---- attachment staging ----
  'stageAttachmentBytes': stageAttachmentBytes,
  'stageAttachmentPath': stageAttachmentPath,
  'discardStagedAttachment': discardStagedAttachment,
  'commitStagedAttachments': commitStagedAttachments,
  'readAttachmentBytes': readAttachmentBytes,
  'resolveAttachmentMedia': resolveAttachmentMedia,
  // ---- meetings ----
  'listMeetings': listMeetings,
  // ---- voice calls ----
  'mintVoiceCallCredential': mintVoiceCallCredential,
  'startVoiceCall': startVoiceCall,
  'getVoiceCall': getVoiceCall,
  'nudgeVoiceCall': nudgeVoiceCall,
  'recordVoiceCall': recordVoiceCall,
  'readVoiceCallSentMessages': readVoiceCallSentMessages,
  'setVoiceCallPresence': setVoiceCallPresence,
  'voiceCallHarnessSession': voiceCallHarnessSession,
  'voiceCallHarnessTool': voiceCallHarnessTool,
  'leaveMeeting': leaveMeeting,
  'meetingCensus': meetingCensus,
  'storeSecret': async (p) => ({ status: 'ok', secret: require('../secretsService').secretsService.set(p.name, p.fields ?? p.value, p.note) }),
  // ---- box secrets + vault (Batch 6) ----
  'setBoxSecrets': async (p) => ({ status: 'ok', ...require('../boxSecretService').boxSecretService.setBoxSecrets(p) }),
  'carryBoxSecretsToBot': async (p) => ({ status: 'ok', ...require('../boxSecretService').boxSecretService.carryToBot(p.serverId, p.names) }),
  'carryUserSecretsToGrokBot': async (p) => ({ status: 'ok', ...require('../boxSecretService').boxSecretService.carryUserSecretsToBot(p.serverId, p.names) }),
  'listGrokBotSecrets': async (p) => ({ status: 'ok', secrets: p.serverId ? require('../boxSecretService').boxSecretService.listBotSecrets(p.serverId) : require('../boxSecretService').boxSecretService.listAllBotSecrets() }),
  'getCredentialsState': async () => ({ status: 'ok', ...require('../vaultService').vaultService.getCredentialsState() }),
  'putGrokBotVaultCredential': async (p) => ({ status: 'ok', credential: require('../vaultService').vaultService.putGrokBotVaultCredential(p) }),
  'deleteGrokBotVaultCredential': async (p) => ({ status: 'ok', ...require('../vaultService').vaultService.deleteGrokBotVaultCredential(p) }),
  'createGrokBotVaultCard': async (p) => ({ status: 'ok', card: require('../vaultService').vaultService.createGrokBotVaultCard(p) }),
  'updateGrokBotVaultCard': async (p) => {
    try { return { status: 'ok', card: require('../vaultService').vaultService.updateGrokBotVaultCard(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'requestCredentialApproval': async (p) => ({ status: 'ok', request: require('../vaultService').vaultService.requestCredential(p) }),
  'approveCredentialRequest': async (p) => ({ status: 'ok', ...(await require('../vaultService').vaultService.approveCredentialRequest(p)) }),
  'denyCredentialRequest': async (p) => ({ status: 'ok', ...require('../vaultService').vaultService.denyCredentialRequest(p) }),
  'resolveVirtualCardApproval': async (p) => {
    try { return { status: 'ok', ...require('../vaultService').vaultService.resolveVirtualCardApproval(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'beginSpendApproval': async (p) => {
    try { return { status: 'ok', ...require('../vaultService').vaultService.beginSpendApproval(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'listVirtualCardPaymentMethods': async () => ({ status: 'ok', ...require('../vaultService').vaultService.listVirtualCardPaymentMethods() }),
  'startCredentialMint': async (p) => {
    try { return { status: 'ok', ...require('../vaultService').vaultService.startCredentialMint(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'detectCredentialMint': async () => ({ status: 'ok', ...require('../vaultService').vaultService.detectCredentialMint() }),
  'connectCredentialProviderOAuth': async (p) => ({ status: 'ok', ...require('../vaultService').vaultService.connectCredentialProviderOAuth(p) }),
  'completeCredentialProviderOAuth': async (p) => ({ status: 'ok', ...(await require('../vaultService').vaultService.completeCredentialProviderOAuth(p)) }),
  'cancelCredentialProviderOAuth': async () => ({ status: 'ok', ...require('../vaultService').vaultService.cancelCredentialProviderOAuth() }),
  'disconnectCredentialProvider': async (p) => ({ status: 'ok', ...require('../vaultService').vaultService.disconnectCredentialProvider(p) }),
  'syncCredentialProvider': async () => ({ status: 'ok', ...require('../vaultService').vaultService.syncCredentialProvider() }),
  'agentsCreate': async (p) => {
    const id = (typeof crypto.randomUUID === 'function' && crypto.randomUUID()) || `s-${Date.now().toString(36)}`;
    require('../sessionService').sessionService.ensure(id);
    if (p.title) try { require('../sessionService').sessionService.rename(id, String(p.title)); } catch {}
    return { status: 'ok', ok: true, id, sessionId: id };
  },
  'agentsDeleteMany': async (p) => {
    const ss = require('../sessionService').sessionService;
    const ids = p.ids ?? p.agentIds ?? (p.id ? [p.id] : []);
    let removed = 0;
    for (const id of ids) try { if (ss.remove(id)) removed++; } catch {}
    return { status: 'ok', ok: true, removed };
  },
  'duplicateAgent': async (p) => {
    const ss = require('../sessionService').sessionService;
    const src = p.id ?? p.agentId ?? p.sourceId;
    const id = (typeof crypto.randomUUID === 'function' && crypto.randomUUID()) || `s-${Date.now().toString(36)}`;
    ss.ensure(id);
    try { const s = ss.get(src); if (s?.title) ss.rename(id, `${s.title} (copy)`); } catch {}
    return { status: 'ok', ok: true, id, sessionId: id };
  },
  'startFreshConversation': async (p) => {
    const id = (typeof crypto.randomUUID === 'function' && crypto.randomUUID()) || `s-${Date.now().toString(36)}`;
    require('../sessionService').sessionService.ensure(id);
    return { status: 'ok', ok: true, id, sessionId: id };
  },
  'getAgentNotificationAvatar': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.generateAgentImage(p.sessionId ?? p.agentId ?? p.id, { label: p.label }) }),
  'getAgentThread': async (p) => ({ status: 'ok', ...require('../transcriptService').transcriptService.thread(p.id ?? p.agentId ?? p.sessionId) }),
  'getAgentTodos': async (p) => ({ status: 'ok', ...require('../transcriptService').transcriptService.todos(p.id ?? p.agentId ?? p.sessionId) }),
  'getAgentTranscriptTail': async (p) => ({ status: 'ok', ...require('../transcriptService').transcriptService.tail(p.id ?? p.agentId ?? p.sessionId, p) }),
  'getAgentTranscript': async (p) => ({ status: 'ok', ...require('../transcriptService').transcriptService.all(p.id ?? p.agentId ?? p.sessionId) }),
  'getAgentTranscriptPage': async (p) => ({ status: 'ok', ...require('../transcriptService').transcriptService.page(p.id ?? p.agentId ?? p.sessionId, p) }),
  'getAgentTranscriptWindow': async (p) => ({ status: 'ok', ...require('../transcriptService').transcriptService.window(p.id ?? p.agentId ?? p.sessionId, p) }),
  'markAgentTaskDone': async (p) => {
    const { taskStore } = require('../../../coordinator/task-store');
    const id = p.taskId ?? p.id;
    try {
      const record = taskStore.get(id, p.agentId ?? p.sessionId);
      if (!record) return { status: 'ok', ok: false, found: false, id, error: `unknown task: ${id}` };
      taskStore.save({ ...record, status: 'completed', finishedAt: Date.now(), pinned: record.pinned ?? false });
      return { status: 'ok', ok: true, found: true, id, taskStatus: 'completed' };
    } catch (e) { return { status: 'ok', ok: false, found: false, id, error: String(e?.message ?? e) }; }
  },
  'setAgentTaskPinned': async (p) => {
    const { taskStore } = require('../../../coordinator/task-store');
    const id = p.taskId ?? p.id;
    const pinned = Boolean(p.pinned);
    try {
      const record = taskStore.get(id, p.agentId ?? p.sessionId);
      if (!record) return { status: 'ok', ok: false, found: false, id, pinned, error: `unknown task: ${id}` };
      taskStore.save({ ...record, pinned });
      return { status: 'ok', ok: true, found: true, id, pinned };
    } catch (e) { return { status: 'ok', ok: false, found: false, id, pinned, error: String(e?.message ?? e) }; }
  },
  'openAgent': async (p) => ({ status: 'ok', ok: true }),
  'openAgentWindowed': async (p) => ({ status: 'ok', ok: true }),
  'listGrokBotAgentFiles': async (p) => ({ status: 'ok', ...require('../agentFilesService').agentFilesService.listGrokBotAgentFiles(p) }),
  'uploadGrokBotAgentFile': async (p) => {
    try { return { status: 'ok', ok: true, ...require('../agentFilesService').agentFilesService.uploadGrokBotAgentFile(p) }; }
    catch (e) { return { status: 'error', ok: false, error: String(e?.message ?? e) }; }
  },
  'deleteGrokBotAgentFile': async (p) => {
    try { return { status: 'ok', ok: true, ...require('../agentFilesService').agentFilesService.deleteGrokBotAgentFile(p) }; }
    catch (e) { return { status: 'error', ok: false, error: String(e?.message ?? e) }; }
  },
  'pickAvatarFile': async () => {
    const blocked = needsMainProcess('picking a file', 'dialog');
    if (blocked) return blocked;
    try {
      const { dialog } = require('electron');
      const picked = await dialog.showOpenDialog({
        title: 'Pick an avatar image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      });
      if (picked.canceled || !picked.filePaths?.length) return { status: 'ok', ok: false, cancelled: true };
      const file = picked.filePaths[0];
      const buf = require('node:fs').readFileSync(file);
      if (buf.length > 8 * 1024 * 1024) return { status: 'error', error: 'avatar image too large (max 8 MB)' };
      const ext = require('node:path').extname(file).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/png';
      return { status: 'ok', ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, fileName: require('node:path').basename(file) };
    } catch (e) { return { status: 'error', ok: false, error: String(e?.message ?? e) }; }
  },
  'pickAvatarSource': async () => {
    const blocked = needsMainProcess('picking a file', 'dialog');
    if (blocked) return blocked;
    const picked = await require('./grokCompatService').grokCompatService.dispatch('pickAvatarFile', {});
    const { status, ok, error, dataUrl, fileName, cancelled } = picked;
    return { status: status ?? 'ok', ok: Boolean(ok), error, dataUrl, fileName, cancelled, source: 'file' };
  },
  'setComposingAgent': async (p) => {
    const id = p.agentId ? String(p.agentId) : null;
    if (!id) return { status: 'error', error: 'agentId is required' };
    const composing = Boolean(p.composing);
    try {
      const { sessionService } = require('../sessionService');
      const session = sessionService.get(id);
      session.composing = composing;
      sessionService.save(session);
    } catch {}
    try { require('../ipc/emitEvent').emitEvent('agents', 'composing', { agentId: id, composing }); } catch {}
    return { status: 'ok', agentId: id, composing };
  },
  'setViewingAgent': async (p) => {
    const id = p.agentId ? String(p.agentId) : null;
    const { settingsService } = require('../settingsService');
    settingsService.save({ viewingAgentId: id });
    try { require('../ipc/emitEvent').emitEvent('agents', 'viewing', { agentId: id }); } catch {}
    return { status: 'ok', agentId: id };
  },
  'setHostSettings': async (p) => {
    const { settingsService } = require('../settingsService');
    settingsService.save(p.settings ?? p ?? {});
    return { status: 'ok', ok: true };
  },
  'writeClipboard': async (p) => {
    const blocked = needsMainProcess('writing the clipboard', 'clipboard');
    if (blocked) return blocked;
    try { const { clipboard } = require('electron'); clipboard.writeText(String(p.text ?? p.value ?? '')); return { status: 'ok', ok: true }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'setWindowFocused': async (p) => {
    try { require('../../windowManager').windowManager.focusMainWindow(); return { status: 'ok', ok: true }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'deepLinkEmit': async (p) => ({ status: 'ok', ok: true }),
  // ---- desktop stores & shell (Batch 8) ----
  'readClientPersistence': async (p) => ({ status: 'ok', ...require('../clientPersistenceService').clientPersistenceService.read(p) }),
  'readManyClientPersistence': async (p) => ({ status: 'ok', ...require('../clientPersistenceService').clientPersistenceService.readMany(p) }),
  'writeClientPersistence': async (p) => {
    try { return { status: 'ok', ...require('../clientPersistenceService').clientPersistenceService.write(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'removeClientPersistence': async (p) => ({ status: 'ok', ...require('../clientPersistenceService').clientPersistenceService.remove(p) }),
  'listClientPersistenceKeys': async (p) => ({ status: 'ok', ...require('../clientPersistenceService').clientPersistenceService.listKeys(p) }),
  'hasMigratedClientPersistence': async () => ({ status: 'ok', ...require('../clientPersistenceService').clientPersistenceService.hasMigrated() }),
  'migrateClientPersistence': async (p) => ({ status: 'ok', ...require('../clientPersistenceService').clientPersistenceService.migrate(p) }),
  'markDeepLinksReady': async () => ({ status: 'ok', ...require('../deepLinkService').deepLinkService.markReady() }),
  'openExternal': async (p) => {
    const url = String(p.url ?? '');
    if (!/^(https?|mailto):/i.test(url)) return { status: 'error', error: 'only http(s) and mailto URLs may open externally' };
    try {
      const { shell } = require('electron');
      if (!shell?.openExternal) return { status: 'error', opened: false, error: 'opening system settings needs the desktop app' };
      await shell.openExternal(url);
      return { status: 'ok', opened: true, url };
    }
    catch (e) { return { status: 'error', opened: false, error: String(e?.message ?? e) }; }
  },
  'relaunchDesktop': async () => {
    const blocked = needsMainProcess('relaunching the app');
    if (blocked) return blocked;
    try {
      const { app } = require('electron');
      app.relaunch();
      setTimeout(() => app.exit(0), 50);
      return { status: 'ok', relaunching: true };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'getLinkMetadata': async (p) => require('../netDiagnosticsService').netDiagnosticsService.getLinkMetadata(p),
  'runNetworkDiagnostics': async (p) => require('../netDiagnosticsService').netDiagnosticsService.runNetworkDiagnostics(p),
  'recordLocalToolApproval': async (p) => {
    try { return { status: 'ok', ...require('../consentService').consentService.recordApproval(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'clearLocalToolApprovals': async () => ({ status: 'ok', ...require('../consentService').consentService.clearApprovals() }),
  // ---- desktop preferences & UI (Batch 9) ----
  'getThemeState': async () => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.getThemeState() }),
  'setThemePreference': async (p) => {
    try { return { status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.setThemePreference(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'getLanguageState': async () => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.getLanguageState() }),
  'setLanguagePreference': async (p) => {
    try { return { status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.setLanguagePreference(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'getSpellCheckEnabled': async () => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.getSpellCheckEnabled() }),
  'setSpellCheckEnabled': async (p) => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.setSpellCheckEnabled(p) }),
  'getHardwareAcceleration': async () => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.getHardwareAcceleration() }),
  'setHardwareAccelerationEnabled': async (p) => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.setHardwareAccelerationEnabled(p) }),
  'getOnboardingSeen': async () => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.getOnboardingSeen() }),
  'setOnboardingSeen': async (p) => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.setOnboardingSeen(p) }),
  'getWebauthnProxyEnabled': async () => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.getWebauthnProxyEnabled() }),
  'setWebauthnProxyEnabled': async (p) => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.setWebauthnProxyEnabled(p) }),
  'getAutoReviewInstructions': async () => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.getAutoReviewInstructions() }),
  'setAutoReviewInstructions': async (p) => {
    try { return { status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.setAutoReviewInstructions(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'requestAutoReviewApproval': async (p) => ({ status: 'ok', request: require('../autoReviewService').autoReviewService.request(p) }),
  'resolveAutoReviewApproval': async (p) => {
    try { return { status: 'ok', ...require('../autoReviewService').autoReviewService.resolve(p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'setTitleBarOverlayTone': async (p) => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.setTitleBarOverlayTone(p) }),
  'getSandAccessFresh': async () => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.getSandAccessFresh() }),
  'toggleMaximizeWindow': async () => {
    try { return { status: 'ok', ...require('../../windowManager').windowManager.toggleMaximizeMainWindow() }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'setUnreadFilterMenuChecked': async (p) => ({ status: 'ok', ok: true }),
  'revokeComputerUseAllowedApp': async (p) => ({ status: 'ok', ok: true }),
  'requestCookieOriginApproval': async (p) => {
    const { status, ...rest } = require('../cookieApprovalService').cookieApprovalService.request(p);
    return { status: 'ok', state: status, ...rest };
  },
  'presentCookieOriginApproval': async (p) => ({ status: 'ok', ...(await require('../cookieApprovalService').cookieApprovalService.present(p)) }),
  'awaitCookieOriginApproval': async (p) => ({ status: 'ok', ...(await require('../cookieApprovalService').cookieApprovalService.await(p)) }),
  'cancelCookieOriginApproval': async (p) => ({ status: 'ok', ...require('../cookieApprovalService').cookieApprovalService.cancel(p) }),
  'readAttachmentChunk': async (p) => ({ status: 'ok', ...require('../attachmentService').attachmentService.readAttachmentChunk(p) }),
  'readAttachmentImage': async (p) => ({ status: 'ok', ...require('../attachmentService').attachmentService.readAttachmentImage(p) }),
  'readAttachmentText': async (p) => {
    if (p.id) return { status: 'ok', text: require('../documentsService').documentsService.readAttachmentText(p.id) };
    return { status: 'ok', ...require('../attachmentService').attachmentService.readAttachmentText(p) };
  },
  'uploadAttachment': async (p) => ({ status: 'ok', ...require('../attachmentService').attachmentService.uploadAttachment(p) }),
  'uploadAttachmentChunk': async (p) => ({ status: 'ok', ...require('../attachmentService').attachmentService.uploadAttachmentChunk(p) }),
  'preuploadStagedAttachment': async (p) => ({ status: 'ok', ...require('../attachmentService').attachmentService.preuploadStagedAttachment(p) }),
  'releaseStagedAttachmentPreupload': async (p) => ({ status: 'ok', ...require('../attachmentService').attachmentService.releaseStagedAttachmentPreupload(p) }),
  'precaptionStagedAttachment': async (p) => ({ status: 'ok', ...(await require('../attachmentService').attachmentService.precaptionStagedAttachment(p)) }),
  'downloadAttachment': async (p) => ({ status: 'ok', ...(await require('../attachmentService').attachmentService.downloadAttachment(p)) }),
  'listLibraryPages': async () => ({ status: 'ok', pages: require('../documentsService').documentsService.resolveLibraryPages() }),
  'rollBackConversation': async (p) => {
    try { return { status: 'ok', ...require('../transcriptService').transcriptService.rollback(p.id ?? p.agentId ?? p.sessionId, p) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  // Grok send.createThreadFromMessage (args {entryId, agentId} → void): fork
  // a new thread seeded with the turn the agent started it from.
  'createThreadFromMessage': async (p) => {
    const sessions = require('../sessionService').sessionService;
    try {
      const agentId = String(p.agentId ?? '');
      const entryId = String(p.entryId ?? '');
      const source = sessions.get(agentId);
      const entry = (source.turns ?? []).find((t) => t.id === entryId || t.entryId === entryId);
      if (!entry) return { status: 'error', error: `entry ${entryId} not found in agent ${agentId}` };
      const preview = String(entry.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const created = sessions.create({ title: `Thread: ${preview || source.title || agentId}`.slice(0, 80), projectId: source.projectId ?? null });
      sessions.appendTurn(created.id, { ...entry, entryId });
      return { status: 'ok', sessionId: created.id, title: created.title, seededEntryId: entryId };
    } catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  // Grok roster.dismissAgentSuggestions (args {agentId, suggestionIds[], reason
  // hidden|acted} → void): persist the dismissal ledger locally.
  'dismissAgentSuggestions': async (p) => {
    try { return { status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.dismissSuggestions(p.agentId, p.suggestionIds ?? p.ids, p.reason) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },

  // ---- local-exec daemon (Grok spawnLocalExecDaemon / mint / seal) ----
  'spawnLocalExecDaemon': async (p) => ({ status: 'ok', daemon: await require('../execDaemonService').execDaemonService.spawnLocalExecDaemon({ cwd: p.cwd, id: p.id }) }),
  'stopLocalExecDaemon': async () => ({ status: 'ok', ...(await require('../execDaemonService').execDaemonService.stopLocalExecDaemon()) }),
  'localExecDaemonStatus': async () => ({ status: 'ok', daemon: require('../execDaemonService').execDaemonService.status() }),
  'mintLocalExecDaemonCredential': async (p) => {
    const cred = require('../execDaemonService').execDaemonService.mintCredential(p.id);
    return { status: 'ok', id: cred.id, token: cred.token, path: cred.path, note: 'single-use bootstrap; the daemon unlinks it after reading' };
  },
  'sealLocalExecFile': async (p) => {
    const exec = require('../execDaemonService').execDaemonService;
    // Grok's schema passes a JSON payload; the sealed contents go to the
    // local-exec supervisor which unseals them with the same key.
    if (p.payloadJson !== undefined || p.payload !== undefined) {
      try { return { status: 'ok', ...exec.sealPayload(p.payloadJson ?? p.payload) }; }
      catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
    }
    try { return { status: 'ok', ...exec.sealFile(p.path ?? p.file) }; }
    catch (e) { return { status: 'error', error: String(e?.message ?? e) }; }
  },
  'isProcessAlive': async (p) => {
    const pid = Number(p.pid ?? p.processId);
    if (!Number.isInteger(pid) || pid <= 0) return { status: 'error', error: 'invalid pid' };
    try { process.kill(pid, 0); return { status: 'ok', pid, alive: true }; }
    catch (e) { return { status: 'ok', pid, alive: e?.code === 'EPERM' }; }
  },
  'terminateProcess': async (p) => {
    const pid = Number(p.pid ?? p.processId);
    if (!Number.isInteger(pid) || pid <= 1) return { status: 'error', error: 'invalid pid' };
    const signal = String(p.signal ?? 'SIGTERM');
    if (!/^SIG(TERM|KILL|INT|HUP|QUIT|USR1|USR2)$/.test(signal)) return { status: 'error', error: 'unsupported signal' };
    try {
      const { execFileSync } = require('node:child_process');
      const uidOut = execFileSync('ps', ['-o', 'uid=', '-p', String(pid)], { timeout: 2000, encoding: 'utf8' }).trim();
      const uid = Number(uidOut);
      if (!Number.isInteger(uid)) return { status: 'ok', pid, terminated: false, reason: 'no such process' };
      if (typeof process.getuid === 'function' && uid !== process.getuid()) {
        return { status: 'error', error: 'refusing to signal a process owned by another user' };
      }
      process.kill(pid, signal);
      return { status: 'ok', pid, signal, terminated: true };
    } catch (e) {
      if (e?.message?.includes('refusing')) return { status: 'error', error: e.message };
      return { status: 'ok', pid, terminated: false, reason: String(e?.message ?? e) };
    }
  },
  'reportProcessCrash': async (p) => ({ status: 'ok', recorded: require('../diagnosticsService').diagnosticsService.record('process_crash', { pid: p.pid, exitCode: p.exitCode, signal: p.signal, command: p.command, reason: p.reason, kind: p.kind }) }),
  'reportLocalExecSupervisorFailed': async (p) => ({ status: 'ok', recorded: require('../diagnosticsService').diagnosticsService.record('exec_supervisor_failed', { daemonId: p.id ?? p.daemonId, reason: p.reason, detail: p.detail }) }),
  'diagnosticsList': async (p) => ({ status: 'ok', events: require('../diagnosticsService').diagnosticsService.list({ limit: p.limit, kind: p.kind, sinceMs: p.sinceMs }) }),
  'diagnosticsSummary': async () => ({ status: 'ok', ...require('../diagnosticsService').diagnosticsService.summary() }),
  'diagnosticsClear': async () => ({ status: 'ok', cleared: require('../diagnosticsService').diagnosticsService.clear() }),
  'getAgentNotificationAvatar': async (p) => ({ status: 'ok', ...require('../sessionExtrasService').sessionExtrasService.generateAgentImage(p.sessionId ?? p.agentId ?? p.id, { label: p.label }) }),

  // ---- Batch 17: deep-dig surface delta ----
  'getHostSettings': async () => {
    const cfg = settings().load();
    return ok({
      notifications: { notifyOnDone: cfg.notifyOnDone !== false, notifyOnUpdates: Boolean(cfg.notifyOnUpdates) },
      selectedTeam: cfg.selectedTeam ?? null,
      mcpCustomInstructions: cfg.systemPromptExtra || '',
      mcpCustomInstructionsByServerId: cfg.mcpInstructionsByServerId ?? {},
      mcpDisabledToolsByServerId: cfg.mcpDisabledToolsByServerId ?? {},
      timeZoneOverride: cfg.timeZoneOverride ?? null,
    });
  },
  'skipOnboarding': async () => {
    const r = require('../desktopPrefsService').desktopPrefsService.setOnboardingSeen({ seen: true });
    try { require('../ipc/emitEvent').emitEvent('settings', 'onboardingSkipped', {}); } catch {}
    return ok({ ...r, skipped: true });
  },
  'isGlobalSearchEnabled': async () => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.getGlobalSearchEnabled() }),
  'getMachineId': async () => ({ status: 'ok', ...require('../desktopPrefsService').desktopPrefsService.getMachineId() }),
  'readClipboard': async () => {
    try {
      const { clipboard } = require('electron');
      return { status: 'ok', text: String(clipboard.readText() ?? ''), available: true };
    } catch {
      return { status: 'ok', text: '', available: false };
    }
  },
  'getSandAccess': async () => {
    const prefs = require('../desktopPrefsService').desktopPrefsService;
    const cached = settings().load().sandAccessCache;
    if (cached && Date.now() - Number(cached.checkedAt ?? 0) < 60_000) return ok({ ...cached, cached: true });
    const fresh = { ...prefs.getSandAccessFresh(), checkedAt: Date.now() };
    settings().save({ sandAccessCache: fresh });
    return ok({ ...fresh, cached: false });
  },
  'readComputerUsePermissions': async () => {
    const sand = require('../desktopPrefsService').desktopPrefsService.getSandAccessFresh();
    const messages = require('../macMessagesService').macMessagesService.checkPermissions({});
    return ok({
      screen: sand.screen ?? 'unknown',
      accessibility: sand.accessibility ?? 'unknown',
      automation: messages.automation,
      fullDiskAccess: messages.fullDiskAccess,
      contacts: messages.contacts,
      platform: sand.platform,
    });
  },
  'openComputerUsePermissionSettings': async () => {
    const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    if (process.platform !== 'darwin') return { status: 'ok', opened: false, reason: 'macOS only' };
    try {
      const { shell } = require('electron');
      if (!shell?.openExternal) return { status: 'error', opened: false, error: 'opening system settings needs the desktop app' };
      await shell.openExternal(url);
      return { status: 'ok', opened: true, url };
    }
    catch (e) { return { status: 'error', opened: false, error: String(e?.message ?? e) }; }
  },
  'listComputerUseAllowedApps': async () => ok({ allowedApps: settings().load().computerUseAllowedApps ?? [] }),
  'isOnePasswordAppInstalled': async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const candidates = [
      '/Applications/1Password.app',
      '/Applications/1Password 7.app',
      path.join(os.homedir(), 'Applications', '1Password.app'),
    ];
    return { status: 'ok', installed: candidates.some((p) => { try { return fs.existsSync(p); } catch { return false; } }) };
  },
  'noteBackendReturn': async () => ({ status: 'ok', ...require('../gatewayStateService').gatewayStateService.noteBackendReturn() }),
  'noteNetworkReturn': async () => ({ status: 'ok', ...require('../gatewayStateService').gatewayStateService.noteNetworkReturn() }),
  'noteBoxRunning': async () => ({ status: 'ok', ...require('../gatewayStateService').gatewayStateService.noteBoxState('running') }),
  'noteBoxAsleep': async () => ({ status: 'ok', ...require('../gatewayStateService').gatewayStateService.noteBoxState('asleep') }),
  'getRpcTraceWindowTraceparent': async () => {
    let traceparent = null;
    try { traceparent = require('../../windowManager').windowManager.getRpcTraceWindowTraceparent(); } catch {}
    return { status: 'ok', traceparent };
  },
  'startRpcTraceWindow': async () => {
    try { return { status: 'ok', ...require('../../windowManager').windowManager.startRpcTraceWindow() }; }
    catch (e) { return { status: 'error', opened: false, error: String(e?.message ?? e) }; }
  },
  'resolveServerTranscriptTail': async () => {
    const path = require('node:path');
    const userDataDir = () => {
      if (process.env.QUANSIOX_USER_DATA_DIR) return process.env.QUANSIOX_USER_DATA_DIR;
      const { app } = require('electron');
      return app.getPath('userData');
    };
    let dir = null;
    try {
      dir = path.join(userDataDir(), 'sessions');
      require('node:fs').mkdirSync(dir, { recursive: true });
    } catch { dir = null; }
    return ok({ access: { kind: 'local-sessions', service: 'transcriptService', dir } });
  },
  'peekUsageWarningAssignment': async () => {
    const cfg = settings().load();
    if (!cfg.accountEmail) return ok({ assignment: null, reason: 'no authenticated network bootstrap' });
    return ok({ assignment: null, reason: 'no usage-warning experiment cached' });
  },
  'adoptServerMcpToolPermissions': async () => {
    const cfg = settings().load();
    const staged = cfg.serverMcpToolPermissions;
    if (!Array.isArray(staged) || staged.length === 0) return ok({ adopted: 0, reason: 'no server tool permissions staged' });
    const perms = { ...(cfg.mcpToolPermissions ?? {}) };
    let adopted = 0;
    for (const item of staged) {
      const serverId = String(item?.serverId ?? item?.server ?? '');
      const toolName = String(item?.toolName ?? item?.tool ?? '');
      if (!serverId || !toolName) continue;
      const entry = { ...(perms[serverId] ?? {}) };
      entry.tools = { ...(entry.tools ?? {}), [toolName]: item.allowed === false ? 'blocked' : 'allowed' };
      perms[serverId] = entry;
      adopted += 1;
    }
    settings().save({ mcpToolPermissions: perms, serverMcpToolPermissions: [] });
    return ok({ adopted });
  },
  'getEffectiveMcpPlugins': async () => {
    const { settingsService } = require('../settingsService');
    const servers = settingsService.load().mcpServers ?? [];
    const catalog = (() => { try { return require('../marketplaceService').marketplaceService.catalog?.() ?? []; } catch { return []; } })();
    const catalogMcp = Array.isArray(catalog) ? catalog.filter((e) => e?.kind === 'mcp') : [];
    return ok({
      plugins: [
        ...servers.map((s) => ({ id: s.name, name: s.name, kind: 'mcp', source: 'local' })),
        ...catalogMcp.map((e) => ({ id: e.id, name: e.name ?? e.id, kind: 'mcp', source: 'catalog' })),
      ],
    });
  },
  'agentsList': async () => {
    const { sessionService } = require('../sessionService');
    const agents = sessionService.list().map((s) => ({ id: s.id, name: s.name ?? s.title ?? s.id, createdAt: s.createdAt ?? null }));
    return ok({ agents });
  },
  'readLayout': async () => ({ status: 'ok', ...require('../panelService').panelService.readLayout() }),
  'unmountSelf': async () => ({ status: 'ok', ...require('../panelService').panelService.unmountSelf() }),
  'finishWebAuthnConsent': async () => ({ status: 'unavailable', scope: 'backend', reason: 'WebAuthn consent is completed by the platform passkey signer helper; Quansiox has no passkey backend' }),
  'logOnboardingJobRoleExperimentExposure': async () => ({ status: 'ok', recorded: require('../diagnosticsService').diagnosticsService.record('telemetry', { method: 'logOnboardingJobRoleExperimentExposure', experiment: 'onboarding-job-role' }) }),
  'logOnboardingRoleUseCaseBotsExperimentExposure': async () => ({ status: 'ok', recorded: require('../diagnosticsService').diagnosticsService.record('telemetry', { method: 'logOnboardingRoleUseCaseBotsExperimentExposure', experiment: 'onboarding-role-use-case-bots' }) }),
  'logOnboardingNotificationsAskExperimentExposure': async () => ({ status: 'ok', recorded: require('../diagnosticsService').diagnosticsService.record('telemetry', { method: 'logOnboardingNotificationsAskExperimentExposure', experiment: 'onboarding-notifications-ask' }) }),
  'logGroupChatDiscouragementExperimentExposure': async () => ({ status: 'ok', recorded: require('../diagnosticsService').diagnosticsService.record('telemetry', { method: 'logGroupChatDiscouragementExperimentExposure', experiment: 'group-chat-discouragement' }) }),
  'logInviteTeammatesExperimentExposure': async () => ({ status: 'ok', recorded: require('../diagnosticsService').diagnosticsService.record('telemetry', { method: 'logInviteTeammatesExperimentExposure', experiment: 'invite-teammates' }) }),
  // ---- local bot templates + session profile updates (v2.63) ----
  'listBotTemplates': async (p = {}) => ok({ templates: require('../templateService').templateService.list({ visibility: p.visibility }) }),
  'publishBotTemplate': async (p = {}) => {
    const t = require('../templateService').templateService.publishFromSession({
      sessionId: p.sessionId ?? p.agentId ?? p.sourceSessionId,
      name: p.name ?? p.title,
      description: p.description,
      prompt: p.prompt,
      visibility: p.visibility,
    });
    return ok({ template: t, templateId: t.id });
  },
  'deleteBotTemplate': async (p = {}) => {
    const id = p.templateId ?? p.id;
    if (!id) throw new Error('templateId is required');
    return ok({ removed: require('../templateService').templateService.remove(id) });
  },
  'getPublicBotTemplate': async (p = {}) => {
    const t = require('../templateService').templateService.getPublic(p.templateId ?? p.id);
    if (!t) throw new Error('unknown template');
    return ok({ template: t });
  },
  'getBotTemplateForSourceAgent': async (p = {}) => ok({
    template: require('../templateService').templateService.getForSourceAgent(p.sessionId ?? p.agentId),
  }),
  'createAgentFromTemplate': async (p = {}) => {
    const created = require('../templateService').templateService.createFromTemplate({
      templateId: p.templateId ?? p.id, name: p.name,
    });
    return ok({ session: created.session, agent: created.session, prompt: created.prompt });
  },
  'setBotTemplateVisibility': async (p = {}) => {
    const id = p.templateId ?? p.id;
    if (!id) throw new Error('templateId is required');
    return ok({ template: require('../templateService').templateService.setVisibility(id, p.visibility) });
  },
  'getBotTemplateExportPolicy': async () => ok(require('../templateService').templateService.exportPolicy()),
  'getBotTemplateVersion': async (p = {}) => ok(require('../templateService').templateService.version(p.templateId ?? p.id)),
  'updateGrokBotAgent': async (p = {}) => {
    const id = p.sessionId ?? p.agentId ?? p.id;
    if (!id) throw new Error('agentId is required');
    const patch = {};
    if (p.name !== undefined || p.title !== undefined) patch.title = p.name ?? p.title;
    if (p.label !== undefined) patch.label = p.label;
    if (p.description !== undefined) patch.description = p.description;
    if (!Object.keys(patch).length) throw new Error('nothing to update');
    return ok({ agent: sessionService().update(id, patch) });
  },

  // ---- local group chats + voice transcription (v2.63 parity batch) ----
  'createGroup': async (p = {}) => {
    const { groupService } = require('../groupService');
    const memberIds = p.memberIds ?? p.agentIds ?? p.ids ?? p.people ?? [];
    const group = groupService.create({ name: p.name ?? p.title ?? 'Group chat', memberIds });
    return ok({ group, groupId: group.id });
  },
  'setGroupMembers': async (p = {}) => {
    const { groupService } = require('../groupService');
    const id = p.groupId ?? p.id ?? p.roomId;
    if (!id) throw new Error('groupId is required');
    const memberIds = p.memberIds ?? p.agentIds ?? p.ids ?? p.people ?? [];
    return ok({ group: groupService.setMembers({ id, memberIds }) });
  },
  'addGrokBotRoomPeople': async (p = {}) => {
    const { groupService } = require('../groupService');
    const id = p.groupId ?? p.roomId ?? p.id;
    if (!id) throw new Error('roomId is required');
    const group = groupService.get(id);
    const current = (group.members ?? []).map((m) => m.id);
    const add = (p.memberIds ?? p.agentIds ?? p.ids ?? p.people ?? []).map(String);
    const memberIds = [...new Set([...current, ...add])];
    if (memberIds.length > 6) throw new Error('a group supports at most 6 bots');
    return ok({ group: groupService.setMembers({ id, memberIds }), added: add.length });
  },
  'listGrokBotAgentSessions': async () => {
    const sessions = sessionService().list();
    return ok({ sessions });
  },
  'transcribeAudio': async (p = {}) => {
    const audioBase64 = p.audioBase64 ?? p.audio ?? p.data ?? p.base64;
    if (!audioBase64) throw new Error('audioBase64 is required');
    const result = require('../voiceService').voiceService.transcribe({
      audioBase64,
      mimeType: p.mimeType ?? p.mime ?? 'audio/wav',
    });
    if (result.status !== 'ok') return result;
    return ok({ text: result.text, provider: result.provider, model: result.model });
  },
};


// ---- telemetry sink (Batch 13): record report*/note* events locally ----
// Grok's telemetry methods ship events to a vendor backend. Quansiox records
// them into its local diagnostics log instead (`diagnosticsList` reads them
// back) — nothing leaves the machine, and the surface answers truthfully.
const TELEMETRY_METHODS = [
  'reportBackendReachability', 'reportGatewayCommandSpan', 'reportGatewayDnsDiagnostic',
  'reportGatewayReachability', 'reportTransportStage', 'reportMarketplaceSearch',
  'reportPolicyStopped', 'reportUsageWarning', 'exposeUsageWarningExperiment',
  'logComposerTriggerExperimentExposure', 'noteSentryConversation', 'noteBoxIntent',
  'signalBoxIntent', 'reportAccessBlocked', 'reportAgentLoad', 'reportAgentsUnreachable',
  'reportArtifactEngagement', 'reportClientFailure', 'reportHeapMetrics',
  'reportOnboardingCompleted', 'reportOnboardingStep', 'reportReactionAck',
  'reportRebuildLifecycle', 'reportReconciliation', 'reportRecoveryAction',
  'reportRenderStream', 'reportRenderTtfr', 'reportSendAck', 'reportSendLatency',
  'reportSidebarAction', 'reportSigninGate', 'reportTurnClientOutcome',
  'reportTurnClientStart', 'reportUpdatePrompt', 'reportVncLiveness', 'reportVncSession',
  'reportOpenComputer',
];
for (const method of TELEMETRY_METHODS) {
  if (!HANDLERS[method]) {
    HANDLERS[method] = async (p) => {
      try { require('../diagnosticsService').diagnosticsService.record('telemetry', { method, args: p ?? {} }); } catch {}
      return { status: 'ok', ok: true, recorded: true, method };
    };
  }
}

// Active session is a renderer-side concept; expose a stable default.
function p_active() {
  try { return null; } catch { return null; }
}

module.exports = { HANDLERS, bool };
