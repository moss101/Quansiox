import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, events, toast, useAgentSession, useSessions, useSettings, useToasts, useSessionAvatars, useAttention, playVoiceMemo, stopVoiceMemo } from './lib.js';
import Composer from './Composer.jsx';
import Playback from './Playback.jsx';
import Palette from './Palette.jsx';
import { DetailsPane } from './DetailsPane.jsx';
import { FilesPanel, TerminalPanel, GitPanel, PromptLibrary, DownloadsPanel, LibraryPanel, ArtifactsPanel } from './Panels.jsx';
import { VoiceOverlay } from './VoiceOverlay.jsx';
import { UserMessage, AssistantMessage, ErrorMessage, StreamingMessage, ToolCard, PlanCard } from './Messages.jsx';
import { Icon } from './Icons.jsx';
import TaskDetail from './TaskDetail.jsx';
import ScreenViewer from './ScreenViewer.jsx';
import PermissionPanel from './PermissionPanel.jsx';
import TaskStatusStrip from './TaskStatus.jsx';
import { activeItem, countLabel, matchItems, stepIndex } from './findChatModel.js';
import ShortcutsDialog from './ShortcutsDialog.jsx';
import LibraryDialog from './LibraryDialog.jsx';
import { ACCENTS, BOT_COLORS, LANGUAGES, SHAPES, THEMES, botPatch, completionPatch, nextStep, prevStep, validate } from './onboardingModel.js';
import { Card } from './cards/Cards.jsx';
import { useSettingsContext } from './contexts/settingsContext.jsx';
import McpPanel from './surfaces/McpPanel.jsx';
import MeetingPanel from './surfaces/MeetingPanel.jsx';
import VaultPanel from './surfaces/VaultPanel.jsx';
import PluginsPanel from './surfaces/PluginsPanel.jsx';
import UsagePanel from './surfaces/UsagePanel.jsx';
import VoiceCallPanel from './surfaces/VoiceCallPanel.jsx';
import CanvasPanel from './surfaces/CanvasPanel.jsx';
import ProjectsPanel from './surfaces/ProjectsPanel.jsx';
import SlidesPanel from './surfaces/SlidesPanel.jsx';
import DesignPanel from './surfaces/DesignPanel.jsx';
import WebsitePanel from './surfaces/WebsitePanel.jsx';
import CollabPanel from './surfaces/CollabPanel.jsx';
import MailPanel from './surfaces/MailPanel.jsx';

function ConfirmOverlay({ confirm, sessionId, onAnswer }) {
  const totalSec = Math.max(1, Math.round((Number(confirm.timeoutMs) || 120_000) / 1000));
  const [left, setLeft] = useState(totalSec);
  useEffect(() => {
    setLeft(totalSec);
    const t = setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [confirm.id, totalSec]);
  const expired = left <= 0;
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');
  // The structured request (W1.8) carries the action, the target and a
  // redacted argument preview. Fall back to the legacy shape.
  const request = confirm.request ?? null;
  const args = request?.argsPreview ?? confirm.args ?? {};
  const tool = request?.tool ?? confirm.tool;
  const target = request?.target ?? '';
  const detail = target
    || (args.command ?? args.path ?? args.url ?? args.text ?? null);
  const preview = Object.entries(args || {})
    .filter(([key]) => key !== 'command' && key !== 'path' && key !== 'url' && key !== 'text')
    .slice(0, 6)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="Approval required">
      <div className="confirm-card" data-surface="confirm">
        <strong>Approve this action?</strong>
        <p className="confirm-tool" data-surface="confirm-tool">{tool}</p>
        {request?.description ? <p className="confirm-description">{String(request.description).slice(0, 300)}</p> : null}
        {detail ? <p className="confirm-detail" data-surface="confirm-target">{String(detail).slice(0, 300)}</p> : null}
        {preview.length ? (
          <pre className="confirm-preview" data-surface="confirm-preview">{preview.join('\n')}</pre>
        ) : null}
        <p className={`confirm-expiry${expired ? ' expired' : ''}`} data-surface="confirm-expiry" data-expired={expired ? '1' : '0'}>
          {expired ? 'Request expired — it was denied automatically. Choose Close.' : `Auto-denies in ${mm}:${ss}`}
        </p>
        <div className="row">
          <button className="btn btn-primary" disabled={expired} onClick={() => onAnswer(true, 'once')}>Allow once</button>
          <button className="btn btn-secondary" disabled={expired} title={`Stop asking for ${tool} in this session`}
            onClick={() => {
              api.consent.set({ scope: sessionId, subject: tool, mode: 'allow' })
                .then(() => toast(`always allowing ${tool} in this session`, 'ok'))
                .catch((err) => toast(err.message ?? String(err), 'err'));
              onAnswer(true, 'once');
            }}>Always allow</button>
          <button className="btn btn-secondary" disabled={expired} title="Allow this exact action from now on"
            onClick={() => {
              api.permissions.addGrant({
                scope: 'action',
                action: tool,
                target: String(target ?? ''),
                tool,
              })
                .then(() => toast(`always allowing "${String(target || tool).slice(0, 60)}"`, 'ok'))
                .catch((err) => toast(err.message ?? String(err), 'err'));
              onAnswer(true, 'always');
            }}>Always allow this action</button>
          <button className="btn btn-danger" onClick={() => onAnswer(false, 'once')}>{expired ? 'Close' : 'Deny'}</button>
        </div>
      </div>
    </div>
  );
}

function ComputerBrowser({ sessionId, state, viewportRef, onHide }) {
  const [draft, setDraft] = useState(state?.url || '');
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(state?.url || '');
  }, [state?.url]);
  const [cookieOpen, setCookieOpen] = useState(false);
  const [cookieGrants, setCookieGrants] = useState([]);
  const [cookieOrigin, setCookieOrigin] = useState('');
  const [cookieMsg, setCookieMsg] = useState('');
  const [cookieBusy, setCookieBusy] = useState(false);
  useEffect(() => {
    setCookieOpen(false);
    setCookieGrants([]);
    setCookieMsg('');
  }, [sessionId]);
  const refreshCookieGrants = () => api.browserCookies.grants({ sessionId })
    .then((grants) => setCookieGrants(Array.isArray(grants) ? grants : []))
    .catch((error) => setCookieMsg(`✗ ${error.message ?? error}`));
  const toggleCookies = () => {
    const next = !cookieOpen;
    setCookieOpen(next);
    if (next) { setCookieMsg(''); refreshCookieGrants(); }
  };
  const addCookieOrigin = async (event) => {
    event.preventDefault();
    const origin = cookieOrigin.trim();
    if (!origin) return;
    try {
      const grants = await api.browserCookies.putGrants({ sessionId, add: [origin] });
      setCookieGrants(Array.isArray(grants) ? grants : []);
      setCookieOrigin('');
      setCookieMsg('origin granted');
    } catch (error) { setCookieMsg(`✗ ${error.message ?? error}`); }
  };
  const revokeCookieOrigin = async (origin) => {
    try {
      const grants = await api.browserCookies.putGrants({ sessionId, remove: [origin] });
      setCookieGrants(Array.isArray(grants) ? grants : []);
    } catch (error) { setCookieMsg(`✗ ${error.message ?? error}`); }
  };
  const importChromeCookies = async () => {
    setCookieBusy(true);
    setCookieMsg('reading Chrome…');
    try {
      const r = await api.browserCookies.importChrome({ sessionId, browser: 'chrome' });
      const unmatched = Array.isArray(r.unmatchedOrigins) && r.unmatchedOrigins.length
        ? ` · not granted: ${r.unmatchedOrigins.slice(0, 4).join(', ')}`
        : '';
      setCookieMsg(`${r.set ?? 0} cookies set (${r.granted} granted of ${r.skipped + r.granted} parsed)${unmatched}`);
    } catch (error) { setCookieMsg(`✗ ${error.message ?? error}`); }
    setCookieBusy(false);
  };
  const tabs = state?.tabs?.length ? state.tabs : [];
  const go = (event) => {
    event.preventDefault();
    const url = draft.trim();
    if (!url) return;
    api.browser.navigate({ sessionId, url }).catch(() => {});
  };
  return (
    <div className="computer-browser" data-surface="computer-browser">
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab) => (
          <button
            key={tab.tabId}
            type="button"
            role="tab"
            aria-selected={tab.tabId === state?.activeTabId}
            className={`browser-tab${tab.tabId === state?.activeTabId ? ' active' : ''}`}
            title={tab.url || tab.title || 'New tab'}
            onClick={() => api.browser.tabs({ sessionId, action: 'activate', tabId: tab.tabId }).catch(() => {})}
          >
            <span>{tab.title || tab.url || 'New tab'}</span>
          </button>
        ))}
        <button type="button" className="browser-tab-add" aria-label="New tab"
          onClick={() => api.browser.tabs({ sessionId, action: 'new' }).catch(() => {})}>+</button>
        <button type="button" className="browser-cookies-btn" data-surface="cookie-grants-toggle"
          title="Cookie origins & Chrome cookie import" onClick={toggleCookies}>Cookies</button>
        <button type="button" className="browser-hide" aria-label="Hide browser" onClick={onHide}>Hide</button>
      </div>
      {cookieOpen && (
        <div className="browser-cookies-panel" data-surface="cookie-grants">
          <div className="bc-head">
            <span>Cookie origins</span>
            <button type="button" aria-label="Close" onClick={() => setCookieOpen(false)}>✕</button>
          </div>
          {cookieGrants.length
            ? cookieGrants.map((origin) => (
              <div className="bc-row" key={origin}>
                <span className="mono ellipsis">{origin}</span>
                <button type="button" onClick={() => revokeCookieOrigin(origin)}>Revoke</button>
              </div>
            ))
            : <div className="bc-empty">No origins granted. Cookies are imported only for origins you grant.</div>}
          <form className="bc-form" onSubmit={addCookieOrigin}>
            <input className="mono" placeholder="https://github.com" value={cookieOrigin}
              onChange={(event) => setCookieOrigin(event.target.value)} aria-label="Cookie origin" />
            <button type="submit">Grant</button>
          </form>
          <div className="bc-actions">
            <button type="button" disabled={cookieBusy || !cookieGrants.length} onClick={importChromeCookies}>
              {cookieBusy ? 'Importing…' : 'Import from Chrome'}
            </button>
          </div>
          {cookieMsg && <div className="bc-status mono">{cookieMsg}</div>}
        </div>
      )}
      <form className={`browser-omnibox${state?.loading ? ' loading' : ''}`} onSubmit={go}>
        <button type="button" aria-label="Back" disabled={!state?.canGoBack}
          onClick={() => api.browser.history({ sessionId, action: 'back' }).catch(() => {})}>‹</button>
        <button type="button" aria-label="Forward" disabled={!state?.canGoForward}
          onClick={() => api.browser.history({ sessionId, action: 'forward' }).catch(() => {})}>›</button>
        <button type="button" aria-label="Reload"
          onClick={() => api.browser.history({ sessionId, action: 'reload' }).catch(() => {})}>↻</button>
        <input
          aria-label="Address"
          value={draft}
          placeholder="https://"
          spellCheck={false}
          onFocus={() => { editing.current = true; }}
          onBlur={() => { editing.current = false; setDraft(state?.url || ''); }}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
      {state?.dialog && (
        <div className="browser-dialog" role="status">
          <span>{state.dialog.message}</span>
          <button type="button" onClick={() => api.browser.dialog({ sessionId, accept: true }).catch(() => {})}>OK</button>
          <button type="button" onClick={() => api.browser.dialog({ sessionId, accept: false }).catch(() => {})}>Dismiss</button>
        </div>
      )}
      <div className="browser-viewport" data-browser-viewport ref={viewportRef} aria-label="Agent browser">
        <span className="browser-viewport-note">The page this computer is browsing</span>
      </div>
    </div>
  );
}

const STARTERS = [
  { icon: Icon.Folder, title: 'Analyze this workspace', desc: 'Map the structure, dependencies, and what each module does.', prompt: 'Analyze this workspace: map the structure, key modules, dependencies, and summarize what this project does and its current state.' },
  { icon: Icon.Zap, title: 'Build a small tool', desc: 'Ask for a CLI script or utility and watch it get written and tested.', prompt: 'Build a small, useful command-line tool in this workspace. Write the code, test it, and report how to use it.' },
  { icon: Icon.Git, title: 'Review recent changes', desc: 'Summarize the git history and flag anything risky.', prompt: 'Review the recent git history and working tree in this workspace. Summarize what changed and flag anything risky.' },
  { icon: Icon.Sparkle, title: 'Fix and improve', desc: 'Find a rough edge, a bug, or a missing test and fix it.', prompt: 'Find one rough edge in this workspace — a bug, missing test, or unclear code — and fix it properly.' },
];

function App() {
  const bootHash = /^session=([a-zA-Z0-9_-]+)$/.exec(decodeURIComponent(location.hash.slice(1)));
  const initial = bootHash
    ? bootHash[1]
    : (crypto.randomUUID?.() ?? `s-${Date.now()}`);

  const agent = useAgentSession(initial);
  const { sessions, refresh } = useSessions();
  const [activeSession, setActiveSession] = useState(null);
  useEffect(() => {
    let alive = true;
    api.sessions.get({ id: agent.sessionId })
      .then((session) => { if (alive) setActiveSession(session); })
      .catch(() => { if (alive) setActiveSession(null); });
    return () => { alive = false; };
  }, [agent.sessionId, sessions]);
  const attention = useAttention(agent.sessionId);
  const threadCounts = useMemo(() => {
    const counts = {};
    for (const item of agent.items) {
      const parent = item.replyTo?.messageId;
      if (parent) counts[parent] = (counts[parent] || 0) + 1;
    }
    return counts;
  }, [agent.items]);
  const settings = useSettings();
  const avatars = useSessionAvatars(sessions);

  // First-run flow (docs get-started): welcome → workspace → appearance →
  // language & model → first bot profile (P2.2).
  useEffect(() => {
    if (settings && settings.onboardingSeen !== true) {
      setOnboarding((prev) => prev ?? {
        step: 0, name: '', label: '', description: '',
        theme: 'system', accent: 'blue', botColor: 'blue', botShape: 'blob',
        language: 'system', model: settings.model ?? '',
      });
    }
  }, [settings]);

  // Per-conversation notification mutes feed the attention hook.
  useEffect(() => {
    attention.setMuted(sessions.filter((s) => s.muted).map((s) => s.id));
  }, [sessions, attention.setMuted]);

  // Grok "sand" shell geometry: a collapsible nav rail and a resizable, persisted
  // sidepane (stage-column). Both survive reloads via the settings store.
  const RAIL_W = 280; const RAIL_COLLAPSED_W = 88;
  // The stage can be WIDER than it used to be: the surfaces that live here
  // (the guest desktop, the browser, the task detail) need room, and 560px
  // made them unusable.
  const STAGE_MIN = 260; const STAGE_MAX = 760; const STAGE_DEFAULT = 320;
  const STAGE_COLLAPSED_W = 44;
  const clampStage = (n) => Math.round(Math.min(STAGE_MAX, Math.max(STAGE_MIN, Number(n) || STAGE_DEFAULT)));
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [stageWidth, setStageWidth] = useState(STAGE_DEFAULT);
  const [stageCollapsed, setStageCollapsed] = useState(false);
  const geomSeeded = useRef(false);
  useEffect(() => {
    if (!settings || geomSeeded.current) return;
    geomSeeded.current = true;
    setRailCollapsed(settings.railCollapsed === true);
    setStageWidth(clampStage(settings.stageWidth));
    setStageCollapsed(settings.stageCollapsed === true);
  }, [settings]);
  // Collapsing the stage is a persisted choice, like the rail.
  const toggleStage = useCallback(() => {
    setStageCollapsed((prev) => {
      const next = !prev;
      api.settings.save({ stageCollapsed: next }).catch(() => {});
      return next;
    });
  }, []);
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      api.settings.save({ railCollapsed: next }).catch(() => {});
      return next;
    });
  }, []);
  const stageResize = useRef(null);
  const onStageResizeStart = useCallback((event) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    const rect = event.currentTarget.parentElement.getBoundingClientRect();
    stageResize.current = { startX: event.clientX, startWidth: rect.width };
    const move = (e) => {
      const drag = stageResize.current;
      if (!drag) return;
      // Pane is on the right: dragging the left edge leftward widens it.
      setStageWidth(clampStage(drag.startWidth + (drag.startX - e.clientX)));
    };
    const up = () => {
      stageResize.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setStageWidth((w) => { api.settings.save({ stageWidth: w }).catch(() => {}); return w; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);
  const [selectedTask, setSelectedTask] = useState(null);
  const [taskDraft, setTaskDraft] = useState({ prompt: '', type: 'general', model: '', environment: 'shared' });
  const [startingTask, setStartingTask] = useState(false);
  const { toasts, dismiss } = useToasts();
  const [attachments, setAttachments] = useState([]);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [palette, setPalette] = useState(null); // null | { mode: 'all' | 'sessions' }
  const [sessionMenu, setSessionMenu] = useState(null); // { id, x, y }
  const [showHidden, setShowHidden] = useState(false);
  const [rename, setRename] = useState(null); // { id, value } — rename dialog
  const [profile, setProfile] = useState(null); // { id, title, label, description } — edit profile
  const [newBot, setNewBot] = useState(null); // { name, busy, error } — Create New Bot dialog
  const [computerOpen, setComputerOpen] = useState(false); // full-size bot computer viewer
  const [groupDraft, setGroupDraft] = useState(null); // { name, selected: [] } — new group chat
  const [groupBusy, setGroupBusy] = useState(false);
  const [details, setDetails] = useState(false); // conversation details drawer (⌘⇧I)
  const [takeover, setTakeover] = useState(false); // user has control of this Mac (Take over / I'm done)
  const [resetConfirm, setResetConfirm] = useState(false); // Reset computer confirmation
  const [dictating, setDictating] = useState(false); // ⌘D dictation recording in progress
  const [replyTo, setReplyTo] = useState(null); // { messageId, preview, author } — docs reply-to-message
  const [voiceMode, setVoiceMode] = useState(() => { try { return localStorage.getItem('quansiox-voice-mode') === '1'; } catch { return false; } });
  const [liveVoice, setLiveVoice] = useState(false);
  const [sidebar, setSidebar] = useState({ workspace: '', model: '' });
  const [dock, setDock] = useState({ open: false, tab: 'files' });
  const [find, setFind] = useState(null); // { q, idx }
  const [outline, setOutline] = useState(null); // null = closed; { title, items } when open
  const [promptLib, setPromptLib] = useState(false);
  const fileInput = useRef(null);
  const messagesEnd = useRef(null);
  const composerText = useRef('');
  const [fileEntries, setFileEntries] = useState([]);
  const [recordings, setRecordings] = useState([]);
  const [humanCapture, setHumanCapture] = useState({ recording: false, steps: 0 });
  const refreshHumanCapture = useCallback(() => api.humanCapture.status().then(setHumanCapture).catch(() => setHumanCapture({ recording: false, steps: 0 })), []);
  // The settings area is its own bounded context: it owns the state of
  // everything you configure, so the app shell stays about the conversation.
  const {
    secrets, secretDraft, setSecretDraft, refreshSecrets,
    automations, autoDraft, setAutoDraft, editAuto, setEditAuto, autoHistory, refreshAutomations, toggleAutoHistory,
    market, marketKind, setMarketKind, refreshMarket,
    skills, skillDraft, setSkillDraft, refreshSkills,
    addons, trustDraft, setTrustDraft, refreshAddons,
    templates, templateDraft, setTemplateDraft, refreshTemplates,
    integ, checkIntegration,
    memories, memQuery, setMemQuery, memDraft, setMemDraft, memScope, setMemScope, refreshMemories,
  } = useSettingsContext({ sessionId: agent.sessionId });
  const [threadOpen, setThreadOpen] = useState(null); // messageId | null
  const [onboarding, setOnboarding] = useState(null); // wizard draft (onboardingModel.js)
  // "More sections" group auto-opens on tall viewports; the user can toggle, and
  // a resize back to tall re-opens (never force-closes). Closed ≈ 0 height.
  const [sectionsOpen, setSectionsOpen] = useState(() => typeof window !== 'undefined' && window.innerHeight >= 720);
  useEffect(() => {
    const onResize = () => { if (window.innerHeight >= 720) setSectionsOpen(true); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [customDraft, setCustomDraft] = useState({ name: '', description: '', prompt: '', tools: 'read_file,list_dir', permissionMode: 'read-only' });
  const [agentComputer, setAgentComputer] = useState({
    sessionId: initial,
    identity: `computer:${initial}`,
    status: 'idle',
    root: '',
  });
  const [browserState, setBrowserState] = useState(null);
  const [watchBrowser, setWatchBrowser] = useState(false);
  // Per-bot computer: one live Linux desktop per session (Grok-style "box").
  // phase: off | starting | ready | error. The server publishes onState too.
  const [botComputer, setBotComputer] = useState({ sessionId: initial, phase: 'off', url: null, input: false, error: null });
  const browserHold = useRef(false);
  const pendingBrowser = useRef(null);
  const viewportRef = useRef(null);

  // Workspace file list for @mentions in the composer.
  useEffect(() => {
    api.file.tree().then((r) => setFileEntries(r.entries ?? [])).catch(() => {});
    const off = events.on('file', 'onChange', () => api.file.tree().then((r) => setFileEntries(r.entries ?? [])).catch(() => {}));
    return off;
  }, []);

  const refreshRecordings = useCallback(() => {
    api.skill?.list?.().then((rows) => setRecordings(Array.isArray(rows) ? rows : [])).catch(() => {});
    refreshHumanCapture();
  }, []);
  useEffect(() => { refreshRecordings(); }, [refreshRecordings]);
  useEffect(() => { refreshSecrets(); }, [refreshSecrets]);
  useEffect(() => { refreshAutomations(); }, [refreshAutomations]);
  useEffect(() => { refreshMarket(); }, [refreshMarket]);
  useEffect(() => { refreshSkills(); }, [refreshSkills]);
  useEffect(() => { refreshMemories(); }, [refreshMemories]);
  useEffect(() => { refreshAddons(); }, [refreshAddons]);
  useEffect(() => { refreshTemplates(); }, [refreshTemplates]);

  const sessionSeen = useRef(agent.sessionId);
  sessionSeen.current = agent.sessionId;

  const pullComputer = useCallback((sid) => {
    const describe = api.sandbox?.describe;
    if (!describe) return undefined;
    return describe({ sessionId: sid }).then((info) => {
      if (!info || info.sessionId !== sid || sessionSeen.current !== sid) return;
      setAgentComputer({
        sessionId: info.sessionId,
        identity: info.identity || `computer:${sid}`,
        status: info.status || 'idle',
        root: info.root || '',
        runtimeKind: info.runtimeKind,
        desktopDisplay: info.desktopDisplay === true,
        browserRuntime: info.browserRuntime,
      });
    }).catch(() => {});
  }, []);

  // Identity follows the active session. Status is refreshed when that
  // session's computer is ensured or the run ends (sandbox onStatus).
  useEffect(() => {
    const sid = agent.sessionId;
    setAgentComputer({
      sessionId: sid,
      identity: `computer:${sid}`,
      status: 'idle',
      root: '',
    });
    pullComputer(sid);
    const off = events.on('sandbox', 'onStatus', (id) => {
      if (id === sid) pullComputer(sid);
    });
    return () => { off?.(); };
  }, [agent.sessionId, pullComputer]);

  // A run starts and ends without changing the session id. Ask again so the
  // stage does not stay idle after the session computer is ensured.
  useEffect(() => {
    pullComputer(agent.sessionId);
  }, [agent.running, agent.sessionId, pullComputer]);

  // Per-bot computer state: follows the active session and live onState events.
  const pullBotComputer = useCallback((sid) => {
    if (!api.computer?.status) return undefined;
    return api.computer.status({ sessionId: sid }).then((state) => {
      if (state && state.sessionId === sid && sessionSeen.current === sid) setBotComputer(state);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const sid = agent.sessionId;
    setBotComputer({ sessionId: sid, phase: 'off', url: null, input: false, error: null });
    pullBotComputer(sid);
    const off = events.on('computer', 'onState', (state) => {
      if (state?.sessionId === sid) setBotComputer(state);
    });
    return () => { off?.(); };
  }, [agent.sessionId, pullBotComputer]);
  const startBotComputer = useCallback(async () => {
    // "Computer" means the VM, even if the in-app browser was presented. Hold
    // the browser reveal, undock its view, and switch the panel to the guest.
    browserHold.current = true;
    setWatchBrowser(false);
    api.browser.undock({ sessionId: agent.sessionId }).catch(() => {});
    setBotComputer((prev) => ({ ...prev, phase: prev.phase === 'ready' ? 'ready' : 'starting', error: null }));
    try {
      const state = await api.computer.ensure({ sessionId: agent.sessionId, reason: 'ui' });
      setBotComputer(state);
    } catch (error) {
      setBotComputer((prev) => ({ ...prev, phase: 'error', error: String(error?.message ?? error) }));
      toast(`Computer unavailable: ${error?.message ?? error}`, 'err');
    }
  }, [agent.sessionId, toast]);
  const stopBotComputer = useCallback(async () => {
    setComputerOpen(false);
    try {
      const state = await api.computer.stop({ sessionId: agent.sessionId });
      setBotComputer(state);
    } catch (error) { toast(error?.message ?? String(error), 'err'); }
  }, [agent.sessionId, toast]);
  // The badge shows the desktop phase when one exists, otherwise the sandbox
  // status (shell/files) so the panel is never blank while a run is active.
  const computerPhaseLabel = watchBrowser
    ? 'in-app'
    : (botComputer.phase !== 'off' ? botComputer.phase : (agentComputer.status || 'idle'));
  // Computer-use children act on the bot's computer (their computerCall keeps
  // the parent session id), so show how many are on this screen right now.
  const liveComputerChildren = (agent.subagents || [])
    .filter((row) => row.status === 'running' && row.type === 'computer-use').length;

  // The session browser lives in this computer. Presenting it, or the agent
  // opening a page, swaps the screen for the live page.
  useEffect(() => {
    const sid = agent.sessionId;
    let dead = false;
    const reveal = pendingBrowser.current === sid;
    if (reveal) pendingBrowser.current = null;
    browserHold.current = false;
    setWatchBrowser(reveal);
    api.browser.focusSession?.({ sessionId: sid }).catch(() => {});
    api.browser.state({ sessionId: sid }).then((info) => {
      if (dead || sessionSeen.current !== sid) return;
      setBrowserState(info || { sessionId: sid, active: false, presented: false });
      if (info?.presented && !browserHold.current) setWatchBrowser(true);
    }).catch(() => {});
    if (reveal) api.browser.show({ sessionId: sid }).catch(() => {});
    const off = events.on('browser', 'onState', (info) => {
      if (!info || info.sessionId !== sid || sessionSeen.current !== sid) return;
      setBrowserState(info);
      if (!info.presented) browserHold.current = false;
      else if (!browserHold.current) setWatchBrowser(true);
    });
    return () => {
      dead = true;
      off?.();
      api.browser.undock({ sessionId: sid }).catch(() => {});
    };
  }, [agent.sessionId]);

  useEffect(() => {
    if (!watchBrowser || selectedTask) return undefined;
    const sid = agent.sessionId;
    const el = viewportRef.current;
    if (!el) return undefined;
    let frame = 0;
    const publish = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (sessionSeen.current !== sid || !viewportRef.current) return;
        const node = viewportRef.current;
        const covered = Boolean(document.querySelector('dialog[open]'));
        const rect = node.getBoundingClientRect();
        if (covered || rect.width < 8 || rect.height < 8) {
          api.browser.undock({ sessionId: sid }).catch(() => {});
          return;
        }
        api.browser.dock({
          sessionId: sid,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        }).catch(() => {});
      });
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    window.addEventListener('resize', publish);
    const dialogs = [...document.querySelectorAll('dialog')];
    const dialogObserver = new MutationObserver(publish);
    dialogs.forEach((dialog) => dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] }));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      dialogObserver.disconnect();
      window.removeEventListener('resize', publish);
      api.browser.undock({ sessionId: sid }).catch(() => {});
    };
  }, [watchBrowser, selectedTask, agent.sessionId, browserState?.activeTabId]);

  const showBrowser = (sessionId) => {
    browserHold.current = false;
    if (sessionId !== agent.sessionId) {
      pendingBrowser.current = sessionId;
      agent.load(sessionId);
      return;
    }
    setWatchBrowser(true);
    api.browser.show({ sessionId }).catch(() => {
      if (sessionSeen.current === sessionId) setWatchBrowser(false);
    });
  };
  const hideBrowser = () => {
    browserHold.current = true;
    setWatchBrowser(false);
    api.browser.close({ sessionId: agent.sessionId }).catch(() => {});
  };

  useEffect(() => {
    if (bootHash) agent.load(bootHash[1]);
    else refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [agent.items, agent.liveText]);

  const refreshSidebar = useCallback(async () => {
    try {
      const [root, s] = await Promise.all([api.workspace.effectiveRoot(), api.settings.get()]);
      setSidebar({
        workspace: root.replace(/^\/Users\/[^/]+/, '~'),
        model: `${s.model}`,
      });
    } catch {}
  }, []);
  useEffect(() => { refreshSidebar(); }, [refreshSidebar, settings]);

  useEffect(() => {
    const off = events.on('navigation', 'navigate', ({ type, id }) => {
      if (type === 'new') newSession();
      if (type === 'session' && id) switchRef.current(id);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Delegated artifact chips — open the artifact in its sandboxed window.
  useEffect(() => {
    const onClick = async (ev) => {
      const chip = ev.target.closest?.('.artifact-chip');
      if (!chip) return;
      const id = chip.dataset.artifactId;
      if (!id) return;
      try { await api.artifacts.open({ id }); }
      catch (failure) { toast(failure.message, 'err'); }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Delegated copy buttons on rendered code blocks.
  useEffect(() => {
    const onClick = async (ev) => {
      const btn = ev.target.closest?.('.code-copy');
      if (!btn) return;
      try { await navigator.clipboard.writeText(decodeURIComponent(btn.dataset.code ?? '')); } catch {}
      btn.classList.add('copied');
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⧉ Copy'; }, 1400);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Close the session context menu on any outside click.
  useEffect(() => {
    if (!sessionMenu) return undefined;
    const close = () => setSessionMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close); };
  }, [sessionMenu]);

  // Grace close (Cue close-requested pattern).
  const [closeRequest, setCloseRequest] = useState(null);
  useEffect(() => {
    const off = events.on('window', 'onCloseRequested', (info) => {
      setCloseRequest({ ...info, seconds: Math.round((info.graceMs ?? 5000) / 1000) });
    });
    return off;
  }, []);
  useEffect(() => {
    if (!closeRequest || closeRequest.seconds <= 0) return;
    const t = setTimeout(() => setCloseRequest((c) => (c ? { ...c, seconds: c.seconds - 1 } : null)), 1000);
    return () => clearTimeout(t);
  }, [closeRequest]);

  // Update prepare-restart handshake ack.
  useEffect(() => {
    const off = events.on('updater', 'onPrepareRestart', ({ id }) => {
      api.updater.prepared({ id, result: 'ok' }).catch(() => {});
    });
    return off;
  }, []);

  // Take over / I'm done: keep the handoff flag in sync across windows/restarts.
  useEffect(() => {
    api.computerUse.takeover().then((r) => setTakeover(Boolean(r?.active))).catch(() => {});
    const off = events.on('computerUse', 'onTakeover', ({ active }) => setTakeover(Boolean(active)));
    return off;
  }, []);
  const handoff = useCallback((next) => {
    api.computerUse.setTakeover({ active: next }).then((r) => setTakeover(Boolean(r?.active))).catch(() => {});
  }, []);
  const recoverComputer = useCallback(async () => {
    try {
      const report = await api.desktop.recover({ sessionId: agent.sessionId });
      const parts = [];
      if (report?.helper === 'restarted') parts.push('Mac helper restarted');
      if (report?.desktopStopped) parts.push('guest desktop stopped');
      if (report?.sandboxStopped) parts.push('sandbox stopped');
      toast(parts.length ? `Computer recovered — ${parts.join(', ')}` : 'Computer recovered — nothing was live', 'ok');
    } catch (error) {
      toast(error?.message ?? String(error), 'err');
    }
  }, [agent.sessionId]);

  // Draft persistence (v2.13): autosave the composer per session and restore it
  // on session switch/reload. sessionExtras.* bridges to sessionExtrasService.
  const composerEditor = useRef(null);
  const composerSuppress = useRef(false);
  const draftTimer = useRef(null);
  // Composer parity (P2.3): voice-memo bar, markdown preview, and the
  // revision base for the draft-revision highlighter (set by Edit on a sent
  // user message; cleared on send, discard, or closing the revision chip).
  const [memoOpen, setMemoOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [revisingOf, setRevisingOf] = useState(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // P1.5: remove the pre-boot splash once the app has mounted (it has
  // already faded out via CSS; this releases the node).
  useEffect(() => { document.getElementById('qx-boot-shell')?.remove(); }, []);
  // Saved-messages library (P2.4): which transcript rows are saved. The
  // authoritative list is the store; this Set is its renderer mirror.
  const [savedIds, setSavedIds] = useState(() => new Set());
  useEffect(() => {
    api.savedMessages.list()
      .then((rows) => setSavedIds(new Set((Array.isArray(rows) ? rows : []).map((r) => r.messageId))))
      .catch(() => {});
  }, []);
  const toggleSaveMessage = useCallback((item) => {
    if (!item?.id || typeof item.text !== 'string') return;
    const has = savedIds.has(item.id);
    (has
      ? api.savedMessages.remove({ messageId: item.id })
      : api.savedMessages.save({ sessionId: agent.sessionId, messageId: item.id, text: item.text, kind: item.kind, author: item.author })
    )
      .then(() => {
        setSavedIds((prev) => {
          const next = new Set(prev);
          if (has) next.delete(item.id); else next.add(item.id);
          return next;
        });
        toast(has ? 'removed from saved' : 'saved to library', 'ok');
      })
      .catch((e) => toast(e?.message ?? String(e), 'err'));
  }, [savedIds, agent.sessionId]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const clearRevision = useCallback(() => setRevisingOf(null), []);
  const discardDraft = useCallback(() => {
    api.sessionExtras.discardDraft({ sessionId: agent.sessionId }).catch(() => {});
    setRevisingOf(null);
    toast('draft discarded', 'ok');
  }, [agent.sessionId]);
  const insertTranscript = useCallback((text) => {
    const ed = composerEditor.current;
    if (!ed) return;
    composerSuppress.current = true;
    ed.chain().focus().insertContentAt(ed.state.selection.to, `\n${text} `).run();
  }, []);
  const startEdit = useCallback((item) => {
    const ed = composerEditor.current;
    if (!ed || typeof item?.text !== 'string' || !item.text.trim()) return;
    composerSuppress.current = true;
    setRevisingOf(item.text);
    ed.chain().focus().clearContent().insertContent(item.text).run();
  }, []);
  const saveActiveDraft = useCallback(() => {
    const text = composerEditor.current?.getText?.() ?? '';
    api.sessionExtras.saveDraft({ sessionId: agent.sessionId, text }).catch(() => {});
  }, [agent.sessionId]);
  const onDraftChange = useCallback((text) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      api.sessionExtras.saveDraft({ sessionId: agent.sessionId, text }).catch(() => {});
    }, 600);
  }, [agent.sessionId]);
  useEffect(() => {
    let alive = true;
    api.sessionExtras.getDraft({ sessionId: agent.sessionId })
      .then((r) => {
        if (!alive || !r?.text || !composerEditor.current) return;
        composerSuppress.current = true;
        composerEditor.current.commands.setContent(r.text);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [agent.sessionId]);
  // Visit history for ⌘[ / ⌘] (docs: "Back / forward in visit history").
  const backStack = useRef([]);
  const forwardStack = useRef([]);
  const switchSession = useCallback((id, { viaHistory = false } = {}) => {
    if (!id || id === agent.sessionId) return;
    if (!viaHistory) {
      backStack.current.push(agent.sessionId);
      forwardStack.current = [];
    }
    saveActiveDraft();
    setReplyTo(null);
    api.restore.checkpoint({ type: 'session', id }).catch(() => {});
    agent.load(id);
  }, [agent, agent.sessionId, saveActiveDraft]);
  const goBack = useCallback(() => {
    const prev = backStack.current.pop();
    if (!prev) return;
    forwardStack.current.push(agent.sessionId);
    switchSession(prev, { viaHistory: true });
  }, [agent.sessionId, switchSession]);
  const goForward = useCallback(() => {
    const next = forwardStack.current.pop();
    if (!next) return;
    backStack.current.push(agent.sessionId);
    switchSession(next, { viaHistory: true });
  }, [agent.sessionId, switchSession]);
  const switchRef = useRef(switchSession);
  switchRef.current = switchSession;

  // Group chat replies arrive over groups:onReply; reload the transcript so
  // each bot's answer appears as it lands.
  useEffect(() => {
    const reload = ({ groupId } = {}) => {
      if (groupId === agent.sessionId) agent.load(agent.sessionId);
    };
    const offs = [events.on('groups', 'onReply', reload), events.on('groups', 'onDone', reload)];
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.sessionId]);

  // Post-restart continuity (GPA G15): reopen the last route and surface the
  // update-applied notice once per boot. Runs after switchRef is assigned.
  const restoreDone = useRef(false);
  useEffect(() => {
    if (restoreDone.current) return;
    restoreDone.current = true;
    api.restore.consume().then((state) => {
      if (state?.pendingUpdate) {
        const from = state.pendingUpdate.from ? ` from ${state.pendingUpdate.from}` : '';
        toast(`Updated to ${state.pendingUpdate.to}${from}`, 'ok');
      }
      if (state?.route?.type === 'session' && state.route.id && state.route.id !== agent.sessionId) {
        switchRef.current(state.route.id);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grok parity: + / ⌘N / "new" opens the Create New Bot dialog, then creates
  // a named session (the bot) up front instead of an untitled blank chat.
  const newSession = useCallback(() => {
    saveActiveDraft();
    setNewBot({ name: '', busy: false, error: null });
  }, [saveActiveDraft]);

  const createNewBot = useCallback(async () => {
    const name = String(newBot?.name || '').trim();
    if (!name || newBot?.busy) return;
    setNewBot((state) => ({ ...state, busy: true, error: null }));
    try {
      const created = await api.sessions.create({ title: name });
      setNewBot(null);
      api.restore.checkpoint({ type: 'session', id: created.id }).catch(() => {});
      agent.setSessionId(created.id);
      agent.load(created.id);
      refresh();
      toast(`Created ${created.title}`, 'ok');
    } catch (error) {
      setNewBot((state) => ({ ...state, busy: false, error: String(error?.message ?? error) }));
    }
  }, [newBot, agent, refresh, toast]);

  // Keep the restore route in sync with the active session (covers the first
  // boot, where no explicit switch happened).
  useEffect(() => {
    if (agent.sessionId) api.restore.checkpoint({ type: 'session', id: agent.sessionId }).catch(() => {});
  }, [agent.sessionId]);

  const onSend = useCallback((text, atts) => {
    if (activeSession?.kind === 'group') {
      if (Array.isArray(atts) && atts.length) { toast('Attachments are not supported in group chats yet', 'warn'); return; }
      if (groupBusy) { toast('This group is still answering', 'warn'); return; }
      setGroupBusy(true);
      api.groups.send({ id: agent.sessionId, message: text })
        .catch((error) => toast(error.message ?? String(error), 'err'))
        .finally(() => { setGroupBusy(false); agent.load(agent.sessionId); });
      setTimeout(() => agent.load(agent.sessionId), 300); // show the user turn now
      return;
    }
    agent.send(text, atts, replyTo);
    setReplyTo(null);
    setAttachments([]);
    // The composer is cleared on send, so the draft is consumed.
    api.sessionExtras.discardDraft({ sessionId: agent.sessionId }).catch(() => {});
  }, [agent, agent.sessionId, replyTo, activeSession, groupBusy]);

  // Reply-to-message (docs): quote chip in the composer + persisted parent.
  const startReply = useCallback((item) => {
    if (!item?.id) return;
    setReplyTo({
      messageId: item.id,
      preview: String(item.text ?? '').replace(/\s+/g, ' ').slice(0, 120),
      author: item.kind === 'user' ? 'You' : 'Quansiox',
    });
    composerEditor.current?.commands?.focus?.('end');
  }, []);
  const jumpToMessage = useCallback((messageId) => {
    if (!messageId) { toast('Original message is not linked', 'warn'); return; }
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!el) { toast('Original message is not in this transcript anymore', 'warn'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);
  }, []);

  // Find prior work (docs): palette searches messages + links across
  // conversations and jumps to the matching place once the transcript loads.
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteMessages, setPaletteMessages] = useState([]);
  const [paletteLinks, setPaletteLinks] = useState([]);
  const [paletteSearching, setPaletteSearching] = useState(false);
  useEffect(() => {
    if (!palette || paletteQuery.trim().length < 2) {
      setPaletteMessages([]);
      setPaletteLinks([]);
      setPaletteSearching(false);
      return undefined;
    }
    setPaletteSearching(true);
    const q = paletteQuery.trim();
    const timer = setTimeout(() => {
      Promise.all([
        api.sessions.searchMessages({ query: q, limit: 24 }).catch(() => []),
        api.sessions.searchLinks({ query: q, limit: 12 }).catch(() => []),
      ]).then(([messages, links]) => {
        setPaletteMessages(Array.isArray(messages) ? messages : []);
        setPaletteLinks(Array.isArray(links) ? links : []);
      }).finally(() => setPaletteSearching(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [palette, paletteQuery]);
  const pendingJumpRef = useRef(null);
  const pendingJumpTimerRef = useRef(null);
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending) return;
    if (!agent.items.some((it) => it.id === pending)) return;
    pendingJumpRef.current = null;
    clearTimeout(pendingJumpTimerRef.current);
    // Let the transcript paint once so scroll/flash land on the node.
    pendingJumpTimerRef.current = setTimeout(() => jumpToMessage(pending), 60);
  }, [agent.items, agent.sessionId, jumpToMessage]);
  const openMessageHit = useCallback((hit) => {
    if (!hit) return;
    if (hit.sessionId === agent.sessionId) {
      jumpToMessage(hit.messageId);
      return;
    }
    pendingJumpRef.current = hit.messageId ?? null;
    if (pendingJumpRef.current) {
      clearTimeout(pendingJumpTimerRef.current);
      pendingJumpTimerRef.current = setTimeout(() => {
        if (pendingJumpRef.current) {
          toast('Could not find that message in the transcript', 'warn');
          pendingJumpRef.current = null;
        }
      }, 4000);
    }
    switchSession(hit.sessionId);
  }, [agent.sessionId, jumpToMessage, switchSession]);
  // Saved-messages library jump (P2.4): same session → flash jump; another
  // session → switch first, the pending-jump effect lands the scroll.
  const jumpToSaved = useCallback((entry) => {
    if (!entry?.messageId) return;
    if (entry.sessionId && entry.sessionId !== agent.sessionId) {
      pendingJumpRef.current = entry.messageId;
      switchSession(entry.sessionId);
      return;
    }
    jumpToMessage(entry.messageId);
  }, [agent.sessionId, jumpToMessage, switchSession]);
  const mentionFile = useCallback((path) => {
    const ed = composerEditor.current;
    if (!ed) return;
    const current = ed.getText().trim();
    ed.commands.setContent(current ? `${current} @${path}` : `@${path}`);
    try { ed.commands.focus('end'); } catch { /* editor gone */ }
    // Explicit text node: a trailing space in setContent is collapsed by the
    // HTML parser, which would leave the @-suggestion popup open at doc end.
    ed.commands.insertContent({ type: 'text', text: ' ' });
    toast(`Mentioned ${path}`, 'ok', 1500);
  }, []);
  // Prior links open through the same policy as in-chat links: http(s) goes
  // to the session's in-app browser (window-open handler), never to Safari.
  const openPaletteLink = useCallback((url) => {
    if (!/^https?:\/\//i.test(String(url ?? ''))) { toast('Unsupported link', 'warn'); return; }
    try { window.open(url, '_blank', 'noopener'); } catch { toast('Could not open link', 'warn'); return; }
    toast('Opened link', 'ok', 1500);
  }, []);
  // Routines live in the sidebar's more-sections group; reveal + flash the row.
  const revealRoutine = useCallback((routine) => {
    if (!routine?.id) return;
    setSectionsOpen(true);
    setTimeout(() => {
      const row = document.querySelector(`[data-automation="${routine.id}"]`);
      if (!row) { toast('Automation not found', 'warn'); return; }
      let node = row.closest('details');
      while (node) { node.open = true; node = node.parentElement ? node.parentElement.closest('details') : null; }
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1600);
    }, 120);
  }, []);

  /* slash commands (restored) */
  const runCommand = useCallback(async (raw) => {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(' ');
    try {
      switch (cmd) {
        case '/new': newSession(); break;
        case '/clear': agent.load(agent.sessionId); toast('view reloaded', 'ok'); break;
        case '/export': {
          const p = await api.sessions.export({ id: agent.sessionId });
          toast(p ? `exported → ${p}` : 'export canceled', p ? 'ok' : 'warn'); break;
        }
        case '/model': {
          if (!arg) { toast(`current model: ${sidebar.model || 'unknown'}`); break; }
          await api.settings.save({ model: arg });
          refreshSidebar();
          toast(`model → ${arg}`, 'ok'); break;
        }
        case '/attach': {
          if (!arg) { toast('usage: /attach <workspace-relative path>', 'warn'); break; }
          const r = await api.file.read({ path: arg });
          setAttachments((prev) => [...prev, { name: arg.split('/').pop(), mimeType: 'text/plain', text: r.content ?? String(r) }]);
          toast(`attached ${arg}`, 'ok'); break;
        }
        case '/cost': {
          const c = await api.sessions.cost({ id: agent.sessionId });
          toast(c ? `≈ $${c.cost?.toFixed?.(4) ?? c.cost} (${c.model})` : 'no cost data yet'); break;
        }
        case '/stats': {
          const s = await api.sessions.stats({ id: agent.sessionId });
          toast(`${s.turns} turns · ${s.toolCalls} tool calls · ↑${s.usage.promptTokens} ↓${s.usage.completionTokens} tokens${s.estimatedCost != null ? ` · ≈$${s.estimatedCost}` : ''}`); break;
        }
        case '/provider': {
          const list = await api.profiles.list();
          if (!arg) { toast(list.length ? `profiles: ${list.map((p) => p.name).join(', ')}` : 'no profiles saved (Settings → profiles)'); break; }
          const hit = list.find((p) => p.name.toLowerCase().includes(arg.toLowerCase()));
          if (!hit) { toast(`no profile matching “${arg}”`, 'err'); break; }
          await api.profiles.activate({ id: hit.id });
          refreshSidebar();
          toast(`provider → ${hit.name}`, 'ok'); break;
        }
        case '/help':
          toast('/new /clear /export /model <name> /attach <path> /cost /stats /provider [name]', 'info', 6000); break;
        default: toast(`unknown command ${cmd} — try /help`, 'warn');
      }
    } catch (err) { toast(err.message ?? String(err), 'err'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, newSession, refreshSidebar, sidebar.model]);

  const addFiles = useCallback(async (files) => {
    const next = [];
    for (const file of files.slice(0, 8)) {
      if (file.size > 25 * 1024 * 1024) { toast(`${file.name} is too large (max 25 MB)`, 'err'); continue; }
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const dataBase64 = dataUrl.split(',')[1] || '';
      let stored = null;
      try {
        stored = await api.attachments.upload({ name: file.name, mimeType: file.type || undefined, dataBase64 });
      } catch (error) { toast(`attach ${file.name}: ${error.message ?? error}`, 'err'); continue; }
      const chip = {
        name: file.name,
        mimeType: stored.mimeType || file.type || 'application/octet-stream',
        attachmentId: stored.sha256,
        path: stored.path,
        size: stored.size,
        mediaKind: stored.mediaKind,
      };
      // Images keep their inline bytes so the provider sees them immediately.
      if (/^image\//.test(chip.mimeType)) chip.data = dataBase64;
      else if (chip.size <= 200 * 1024) chip.text = await file.text();
      next.push(chip);
    }
    setAttachments((prev) => [...prev, ...next]);
  }, []);

  const snap = useCallback(async () => {
    try {
      const shot = await api.capture.screen();
      setAttachments((prev) => [...prev, { name: shot.name, mimeType: shot.mimeType, data: shot.data }]);
      toast('screenshot attached', 'ok');
    } catch {}
  }, []);

  // Find-in-session matches (P2.4): ordered by the model, navigated with
  // wraparound in both directions; the active match is a specific message
  // that gets a distinct highlight plus the scroll/flash treatment.
  const findMatches = useMemo(() => matchItems(agent.items, find?.q ?? ''), [agent.items, find?.q]);
  const findActive = find ? activeItem(findMatches, find.idx) : null;
  const goToFindMatch = useCallback((idx) => {
    setFind((f) => ({ ...(f ?? { q: '', idx: 0 }), idx }));
    const hit = activeItem(findMatches, idx);
    if (hit?.id) jumpToMessage(hit.id);
  }, [findMatches, jumpToMessage]);
  const cycleFind = (dir = 1) => {
    if (!findMatches.length) return;
    goToFindMatch(stepIndex(find?.idx ?? 0, findMatches.length, dir));
  };

  const activeTitle = sessions.find((s) => s.id === agent.sessionId)?.title ?? 'New session';
  // Sidebar order: pinned first, then by recency. Hidden sessions live in
  // their own collapsed section and stay out of palette/shortcut slots.
  const orderedSessions = [...sessions].sort((a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const matchesSearch = (s) => !search.trim()
    || `${s.title} ${s.id}`.toLowerCase().includes(search.toLowerCase());
  const visibleSessions = orderedSessions.filter((s) => !s.hidden).filter(matchesSearch);
  const hiddenSessions = orderedSessions.filter((s) => s.hidden).filter(matchesSearch);

  // Move to the previous/next session in sidebar order (Alt+↑/↓, Ctrl+Tab).
  const stepSession = useCallback((delta) => {
    if (visibleSessions.length < 2) return;
    const i = visibleSessions.findIndex((s) => s.id === agent.sessionId);
    const next = visibleSessions[(i + delta + visibleSessions.length) % visibleSessions.length];
    if (next) switchSession(next.id);
  }, [visibleSessions, agent.sessionId, switchSession]);

  const runPaletteAction = useCallback((id, extra) => {
    switch (id) {
      case 'new-session': newSession(); break;
      case 'settings': window.quansioxUI?.openSettings?.(); break;
      case 'connect-apps': window.quansioxUI?.openSettings?.('integrations'); break;
      case 'toggle-theme': document.getElementById('btn-theme')?.click(); break;
      case 'toggle-sidebar': toggleRail(); break;
      case 'toggle-panels': setDock((d) => ({ ...d, open: !d.open })); break;
      case 'focus-composer': composerEditor.current?.commands?.focus?.(); break;
      case 'find-now': setFind({ q: extra?.q ?? '', idx: 0 }); break;
      case 'find': setFind((f) => (f ?? { q: '', idx: 0 })); break;
      case 'shortcuts': setShortcutsOpen(true); break;
      case 'library': setLibraryOpen(true); break;
      case 'export': api.sessions.export({ id: agent.sessionId })
        .then((p) => toast(p ? `exported → ${p}` : 'export canceled', p ? 'ok' : 'warn'))
        .catch((err) => toast(err.message ?? String(err), 'err'));
        break;
      case 'mark-read-all': attention.markAllRead(); break;
      case 'details': setDetails((v) => !v); break;
      default: toast(`unknown action ${id}`, 'warn');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newSession, toggleRail, agent.sessionId, attention.markAllRead]);

  const paletteActions = useMemo(() => [
    { id: 'new-session', title: 'New Bot', hint: '⌘N' },
    { id: 'settings', title: 'Open settings', hint: '⌘,' },
    { id: 'shortcuts', title: 'Keyboard shortcuts', hint: '⌘/' },
    { id: 'library', title: 'Saved messages (Library)' },
    { id: 'connect-apps', title: 'Connect apps (Integrations)', hint: '⌘⇧M' },
    { id: 'toggle-theme', title: 'Toggle light / dark theme' },
    { id: 'toggle-sidebar', title: 'Toggle sidebar', hint: '⌘B' },
    { id: 'toggle-panels', title: 'Toggle panels', hint: '⌘.' },
    { id: 'focus-composer', title: 'Focus composer', hint: '⌘I' },
    { id: 'find', title: 'Find in this session', hint: '⌘F' },
    { id: 'details', title: 'Conversation details', hint: '⌘⇧I' },
    { id: 'export', title: 'Export conversation' },
    { id: 'mark-read-all', title: 'Mark all sessions read' },
  ], []);

  // Dictation (docs ⌘D): record with MediaRecorder → local whisper transcribe
  // (honest-unavailable without a provider) → insert into the composer.
  const recorderRef = useRef(null);
  const dictationBusyRef = useRef(false);
  const insertDictation = useCallback((text) => {
    const ed = composerEditor.current;
    if (!ed) return;
    const current = ed.getText().trim();
    ed.commands.setContent(current ? `${current} ${text}` : text);
    try { ed.commands.focus('end'); } catch { /* editor gone */ }
    toast('Dictation inserted', 'ok', 1500);
  }, []);
  const finishDictation = useCallback(async (chunks, mimeType) => {
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    if (blob.size < 1500) { toast('Nothing was recorded', 'err'); return; }
    if (blob.size > 20 * 1024 * 1024) { toast('Recording too large for local transcription', 'err'); return; }
    try {
      toast('Transcribing locally…', 'info', 1500);
      const buf = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const result = await api.voice.transcribe({ audioBase64: btoa(binary), mimeType: blob.type });
      if (result?.status === 'unavailable') { toast(result.reason, 'err'); return; }
      const text = String(result?.text ?? '').trim();
      if (!text) { toast('Nothing was recognized — try again', 'err'); return; }
      insertDictation(text);
    } catch (error) {
      toast(error?.message ?? String(error), 'err');
    }
  }, [insertDictation]);
  const toggleDictation = useCallback(async () => {
    const active = recorderRef.current;
    if (active) {
      if (active.timer) clearTimeout(active.timer);
      recorderRef.current = null;
      setDictating(false);
      try {
        if (active.rec.state !== 'inactive') active.rec.stop();
        else active.stream.getTracks().forEach((t) => t.stop());
      } catch { try { active.stream.getTracks().forEach((t) => t.stop()); } catch { /* gone */ } }
      return;
    }
    if (dictationBusyRef.current) return;
    dictationBusyRef.current = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) { toast('Microphone capture is unavailable in this build', 'err'); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
        .find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } });
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      const session = { rec, stream, timer: null };
      rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      rec.onstop = () => {
        try { stream.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
        if (recorderRef.current === session) { recorderRef.current = null; setDictating(false); }
        if (session.timer) clearTimeout(session.timer);
        finishDictation(chunks, rec.mimeType);
      };
      session.timer = setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch { /* gone */ } }, 90_000);
      recorderRef.current = session;
      rec.start();
      setDictating(true);
    } catch (error) {
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      toast(denied
        ? 'Microphone access denied — enable it in System Settings → Privacy & Security → Microphone'
        : `Microphone unavailable: ${error?.message ?? error}`, 'err');
    } finally {
      dictationBusyRef.current = false;
    }
  }, [finishDictation]);

  // Voice chat: when a run finishes and voice mode is on, read the reply aloud.
  const toggleVoiceMode = useCallback(() => {
    setVoiceMode((v) => {
      const next = !v;
      try { localStorage.setItem('quansiox-voice-mode', next ? '1' : '0'); } catch { /* private mode */ }
      if (!next) stopVoiceMemo();
      return next;
    });
  }, []);
  const voiceArmedRef = useRef(false);
  useEffect(() => {
    if (!voiceMode) { voiceArmedRef.current = false; return; }
    if (agent.running) { voiceArmedRef.current = true; return; }
    if (!voiceArmedRef.current) return;
    voiceArmedRef.current = false;
    const last = [...agent.items].reverse().find((it) => it.kind === 'assistant' && it.text);
    if (last) {
      playVoiceMemo({ key: 'voice-chat', text: last.text, sessionId: agent.sessionId, onError: () => {} });
      // The live voice loop speaks it sentence by sentence instead.
      window.dispatchEvent(new CustomEvent('quansiox:voice-reply', { detail: { text: last.text } }));
    }
  }, [voiceMode, agent.running, agent.items, agent.sessionId]);

  // Global shortcuts: ⌘K palette, ⌘⇧F session search, ⌘1–9 session slots,
  // Alt+↑/↓ + Ctrl+Tab cycling, ⌘[ / ⌘] history, plus the anchor set.
  useEffect(() => {
    const onKey = (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      const key = ev.key;
      if (mod && !ev.altKey && !ev.shiftKey && (key === 'k' || key === 'K')) {
        ev.preventDefault();
        setPalette((p) => (p ? null : { mode: 'all' }));
        return;
      }
      if (mod && ev.shiftKey && (key === 'F' || key === 'f')) {
        ev.preventDefault();
        setPalette({ mode: 'sessions' });
        return;
      }
      if (mod && ev.shiftKey && (key === 'I' || key === 'i')) {
        ev.preventDefault();
        setDetails((v) => !v);
        return;
      }
      // Docs: Connect apps — opens the Integrations (connectors) surface.
      if (mod && ev.shiftKey && (key === 'M' || key === 'm' || key === 'W' || key === 'w')) {
        ev.preventDefault();
        window.quansioxUI?.openSettings?.('integrations');
        return;
      }
      if (mod && ev.altKey && !ev.shiftKey && (key === 'b' || key === 'B')) {
        ev.preventDefault();
        setDetails((v) => !v);
        return;
      }
      if (mod && ev.shiftKey && key === ',') {
        ev.preventDefault();
        setDetails(true);
        return;
      }
      if (mod && key === '.') { ev.preventDefault(); setDock((d) => ({ ...d, open: !d.open })); return; }
      // sand.* registry additions (P1.7): the Grok-parity bindings that
      // were missing. Identifiers/accelerators per shortcutRegistry.js.
      if (mod && !ev.altKey && !ev.shiftKey && (key === 'n' || key === 'N')) { ev.preventDefault(); newSession(); return; }
      if (mod && ev.shiftKey && (key === 'N' || key === 'n')) { ev.preventDefault(); toast('group chats: create a room from a chat’s ⋯ menu (quick-create pending)', 'warn'); return; }
      if (mod && !ev.altKey && !ev.shiftKey && (key === 'b' || key === 'B')) { ev.preventDefault(); toggleRail(); return; }
      if (mod && !ev.altKey && !ev.shiftKey && key === ',') { ev.preventDefault(); window.quansioxUI?.openSettings?.(); return; }
      if (mod && !ev.altKey && !ev.shiftKey && (key === 'i' || key === 'I')) { ev.preventDefault(); composerEditor.current?.commands?.focus?.(); return; }
      if (mod && !ev.altKey && (key === '/' || key === '?')) { ev.preventDefault(); setShortcutsOpen((v) => !v); return; }
      if (mod && !ev.shiftKey && key === 'f') { ev.preventDefault(); setFind((f) => (f ?? { q: '', idx: 0 })); return; }
      if (mod && !ev.shiftKey && !ev.altKey && (key === 'd' || key === 'D')) { ev.preventDefault(); toggleDictation(); return; }
      if (mod && !ev.shiftKey && !ev.altKey && (key === 'l' || key === 'L')) {
        ev.preventDefault();
        document.querySelector('.composer.editor .ProseMirror')?.focus();
        return;
      }
      if (mod && key === '[') { ev.preventDefault(); goBack(); return; }
      if (mod && key === ']') { ev.preventDefault(); goForward(); return; }
      if (mod && !ev.shiftKey && !ev.altKey && /^[1-9]$/.test(key)) {
        const target = visibleSessions[Number(key) - 1];
        if (target) { ev.preventDefault(); switchSession(target.id); }
        return;
      }
      if (ev.altKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) {
        ev.preventDefault();
        stepSession(key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (ev.ctrlKey && key === 'Tab') {
        ev.preventDefault();
        stepSession(ev.shiftKey ? -1 : 1);
        return;
      }
      if (key === 'Escape') { setFind(null); setPalette(null); setSessionMenu(null); setRename(null); setProfile(null); setTemplateDraft(null); setThreadOpen(null); setEditAuto(null); setDetails(false); setResetConfirm(false); setReplyTo(null); setShortcutsOpen(false); setLibraryOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleSessions, switchSession, stepSession, goBack, goForward, toggleDictation]);

  const renderSessionCard = (s, isHidden = false) => (
    <div key={s.id}
      data-session={s.id}
      className={`session-card${s.id === agent.sessionId ? ' active' : ''}${attention.unread.has(s.id) ? ' unread' : ''}${isHidden ? ' hidden-item' : ''}`}
      onClick={() => switchSession(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setSessionMenu({ id: s.id, x: e.clientX, y: Math.min(e.clientY, window.innerHeight - 300) });
      }}>
      {avatars[s.id]
        ? <img className="session-avatar" alt="" src={avatars[s.id]} width="22" height="22" />
        : <span className="session-avatar" aria-hidden="true" />}
      <div className="session-title">
        {s.pinned && <span className="pin-glyph" title="Pinned" aria-label="Pinned"><Icon.Pin /></span>}
        {s.title || 'New session'}
      </div>
      <div className="session-meta">
        <Icon.Clock /> {relTimeUpdated(s.updatedAt)}
        {s.kind === 'group' ? <span className="session-group-badge">{s.memberCount || 0} bots</span> : null}
      </div>
      <div className="session-actions">
        <button className="ibtn" title="Watch the run (playback)"
          onClick={(e) => { e.stopPropagation(); api.playback.open({ sessionId: s.id }).catch(() => {}); }}><Icon.Play /></button>
        <button className="ibtn" title="Show this session's browser"
          onClick={(e) => { e.stopPropagation(); showBrowser(s.id); }}><Icon.Globe /></button>
        <button className="ibtn" title="Open in new window"
          onClick={(e) => { e.stopPropagation(); api.window.openSession({ sessionId: s.id }).catch(() => {}); }}><Icon.Popout /></button>
        <button className="ibtn danger" title="Delete session"
          onClick={(e) => { e.stopPropagation(); api.sessions.remove({ id: s.id }).then(refresh).catch(() => {}); }}><Icon.Trash /></button>
      </div>
      {attention.unread.has(s.id) && <span className="session-unread-dot" title="Unread activity" aria-label="Unread activity" />}
      {attention.working.has(s.id) && s.id !== agent.sessionId && <span className="session-working" title="Working" aria-label="Working" />}
    </div>
  );

  const renderHiddenSection = hiddenSessions.length > 0 && (
    <>
      <button type="button" className="hidden-toggle" data-surface="hidden-toggle"
        aria-expanded={showHidden}
        onClick={() => setShowHidden((v) => !v)}>
        <Icon.EyeOff /> <span>Hidden ({hiddenSessions.length})</span>
        {showHidden ? <Icon.ChevronDown /> : <Icon.ChevronRight />}
      </button>
      {showHidden && hiddenSessions.map((s) => renderSessionCard(s, true))}
    </>
  );

  return (
    <div className="layout agent-workspace" data-rail-collapsed={railCollapsed ? '' : undefined}>
      <aside className="sidebar" data-surface="session-rail">
        <div className="sidebar-head">
          <div className="brand"><span className="logo">Q</span><span className="brand-text">Quansiox</span></div>
          <div className="sidebar-actions">
            <button className="circle-btn" type="button"
              title="Search sessions" aria-label="Search sessions" aria-expanded={searchOpen}
              onClick={() => setSearchOpen((v) => !v)}><Icon.Search /></button>
            <button className="circle-btn btn-new" type="button"
              title="New Bot" aria-label="New Bot" onClick={newSession}><Icon.Plus /></button>
            <button className="circle-btn" type="button" data-surface="new-group"
              title="New group chat" aria-label="New group chat"
              onClick={() => setGroupDraft({ name: '', selected: [] })}><Icon.Sparkle /></button>
            <button className="circle-btn rail-toggle" type="button"
              title={railCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!railCollapsed} aria-label="Toggle sidebar"
              onClick={toggleRail}><Icon.Sidebar /></button>
          </div>
        </div>
        {searchOpen && (
          <div className="search-wrap">
            <Icon.Search />
            <input className="session-search" autoFocus placeholder="Search sessions…"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        )}
        <div className="session-list">
          {visibleSessions.map((s) => renderSessionCard(s))}
          {renderHiddenSection}
        </div>
        <div className="sidebar-footer">
          <button className="ws-chip" title="Choose workspace…" onClick={async () => {
            if (await api.workspace.pickRoot()) refreshSidebar();
          }}>
            <Icon.Folder /> <span className="ellipsis">{sidebar.workspace || 'choose workspace…'}</span>
          </button>
          <div className="model-chip"><span className="dot" /> {sidebar.model || 'no model'}</div>
        </div>
      </aside>

      <main className="chat workspace">
        {agent.computerActive && (
          <div className={`cu-banner${takeover ? ' taken-over' : ''}`} data-surface="cu-banner">
            <span className="live-dot" />
            {takeover
              ? 'You have control — the agent is paused'
              : 'The agent is controlling this Mac — take over or click Stop to interrupt'}
            <button type="button" className="cu-banner-action" data-surface="cu-takeover" onClick={() => handoff(!takeover)}>
              {takeover ? "I'm done — hand control back" : 'Take over'}
            </button>
          </div>
        )}
        <div className="workspace-body">
        <section className="transcript" data-surface="transcript" aria-label="Transcript">
        <div className="chat-topbar">
          <div className="chat-pill">
            {avatars[agent.sessionId]
              ? <img className="pill-avatar" alt="" src={avatars[agent.sessionId]} width="28" height="28" />
              : <span className="pill-avatar pill-avatar-fallback" aria-hidden="true">Q</span>}
            <span className="title">{activeTitle}</span>
            {sidebar.model && <span className="badge">{sidebar.model}</span>}
          </div>
          <div className="topbar-actions">
            <button className={`ibtn${libraryOpen ? ' active' : ''}`} data-surface="library-open" title="Saved messages (Library)"
              onClick={() => setLibraryOpen(true)}><Icon.Star /></button>
            <button className={`ibtn${dock.open ? ' active' : ''}`} title="Toggle panels (⌘.)"
              onClick={() => setDock((d) => ({ ...d, open: !d.open }))}><Icon.Folder /></button>
            <button className="ibtn" title="Find in session (⌘F)"
              onClick={() => setFind((f) => (f ? null : { q: '', idx: 0 }))}><Icon.Search /></button>
            <button className={`ibtn${details ? ' active' : ''}`} title="Conversation details (⌘⇧I)"
              onClick={() => setDetails((v) => !v)}><Icon.Info /></button>
            <button className={`ibtn${outline ? ' active' : ''}`} title="Conversation outline"
              onClick={() => {
                if (outline) { setOutline(null); return; }
                api.sessionExtras.outline({ sessionId: agent.sessionId })
                  .then((o) => setOutline({ title: o.title || 'Outline', items: o.outline || [] }))
                  .catch(() => {});
              }}><Icon.ListChecks /></button>
          </div>
        </div>
        {outline && (
          <div className="outline-pop" role="dialog" aria-label="Conversation outline">
            <div className="outline-head">
              <span className="outline-title">{outline.title}</span>
              <button className="ibtn" title="Close" onClick={() => setOutline(null)}><Icon.X /></button>
            </div>
            <div className="outline-list">
              {outline.items.length ? outline.items.map((item, i) => (
                <button type="button" key={`${item.kind}-${i}`} className={`outline-item outline-${item.kind}`}
                  onClick={() => { if (item.text) setFind({ q: item.text.slice(0, 40), idx: 0 }); setOutline(null); }}>
                  <span className="outline-kind">{item.kind === 'result' ? '↳' : item.kind === 'tool' ? '⚙' : item.kind === 'step' ? (item.status === 'done' ? '●' : item.status === 'in_progress' ? '◐' : '○') : item.kind === 'user' ? '›' : '•'}</span>
                  <span className="outline-text">{item.name ? `${item.name}${item.text ? ' — ' + item.text : ''}` : item.text}</span>
                </button>
              )) : <span className="outline-empty">No turns yet.</span>}
            </div>
          </div>
        )}
        {find && (
          <div className="find-bar" data-surface="find-bar" role="search" aria-label="Find in session">
            <Icon.Search />
            <input autoFocus value={find.q} data-surface="find-input"
              onChange={(e) => { setFind({ q: e.target.value, idx: 0 }); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); cycleFind(e.shiftKey ? -1 : 1); }
                if (e.key === 'Escape') { e.preventDefault(); setFind(null); }
              }}
              placeholder="find in session…" aria-label="Find in session" />
            <span className="find-count" data-surface="find-count">{find.q ? countLabel(findMatches, find.idx) : ''}</span>
            <button className="ibtn" data-surface="find-prev" title="Previous match (⇧↵)" aria-label="Previous match"
              onClick={() => cycleFind(-1)}><Icon.ChevronLeft /></button>
            <button className="ibtn" data-surface="find-next" title="Next match (↵)" aria-label="Next match"
              onClick={() => cycleFind(1)}><Icon.ChevronRight /></button>
            <button className="ibtn" title="Close (Esc)" aria-label="Close find" onClick={() => setFind(null)}><Icon.X /></button>
          </div>
        )}
        <div className="messages">
          <div className="messages-inner">
            {agent.hasMoreEarlier && (
              <div className="load-earlier-wrap">
                <button type="button" className="load-earlier" data-surface="load-earlier"
                  onClick={() => agent.loadEarlier()}>
                  Load earlier messages
                </button>
              </div>
            )}
            {agent.items.length === 0 && !agent.liveText && (
              <div className="empty-state">
                <div className="empty-logo">Q</div>
                <h2>Welcome to Quansiox</h2>
                <p>A local-first agent that plans, runs commands, edits files, and reports back — on your machine.</p>
                <div className="starter-grid">
                  {STARTERS.map((s, i) => (
                    <div key={i} className="starter-card" onClick={() => onSend(s.prompt, [])}>
                      <span className="st-title"><s.icon /> {s.title}</span>
                      <span className="st-desc">{s.desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {activeSession?.kind === 'group' && (
              <div className="group-banner" data-surface="group-banner">
                <Icon.Sparkle />
                <strong>{activeSession.title}</strong>
                <span>{(activeSession.members || []).map((m) => m.title).join(' · ')}</span>
                {groupBusy && <span className="group-busy">answering…</span>}
              </div>
            )}
            {agent.items.map((item) => {
              switch (item.kind) {
                case 'user': return (
                  <UserMessage key={item.key} text={item.text} at={item.at} search={find?.q} activeMatch={findActive?.id ?? null}
                    saved={savedIds.has(item.id)} onToggleSave={() => toggleSaveMessage(item)}
                    queued={item.queued === true} id={item.id} replyTo={item.replyTo} reactions={item.reactions}
                    onReply={() => startReply(item)} onReact={(emoji) => agent.react(item.id, emoji)}
                    onEdit={() => startEdit(item)}
                    onJumpTo={jumpToMessage}
                    threadCount={threadCounts[item.id] || 0} onOpenThread={() => setThreadOpen(item.id)}
                    onSteer={item.queued ? () => agent.steer(item.messageId) : undefined}
                    onRollback={() => {
                      if (!window.confirm('Roll back to this message? This removes it and everything after it from the conversation.')) return;
                      agent.rollback(item.id).then((r) => {
                        if (r?.error) toast(r.error, 'err');
                        else toast(`Rolled back ${r?.removed ?? 0} messages`, 'ok');
                      });
                    }} />
                );
                case 'assistant': return (
                  <AssistantMessage key={item.key} text={item.text} at={item.at} search={find?.q} activeMatch={findActive?.id ?? null}
                    saved={savedIds.has(item.id)} onToggleSave={() => toggleSaveMessage(item)}
                    author={item.author} sessionId={agent.sessionId} memoKey={item.key}
                    id={item.id} reactions={item.reactions}
                    onReply={() => startReply(item)} onReact={(emoji) => agent.react(item.id, emoji)}
                    onJumpTo={jumpToMessage}
                    threadCount={threadCounts[item.id] || 0} onOpenThread={() => setThreadOpen(item.id)} />
                );
                case 'error': return <ErrorMessage key={item.key} text={item.text} />;
                case 'tool': return <ToolCard key={item.key} name={item.name} args={item.args} output={item.output} image={item.image} />;
                case 'plan': return <PlanCard key={item.key} steps={item.steps} />;
                case 'card': return (
                  <Card
                    key={item.key}
                    kind={item.cardKind}
                    type={item.cardType}
                    payload={item.payload}
                    resolutionId={item.resolutionId}
                    interactionId={item.interactionId}
                    resolution={item.resolution}
                  />
                );
                default: return null;
              }
            })}
            {agent.liveText !== null && <StreamingMessage text={agent.liveText} />}
            <div ref={messagesEnd} />
          </div>
        </div>
        <div className={`status-row${agent.running ? ' running' : ''}`}>
          <span className="status-dot" />
          <span>{agent.status}</span>
          {agent.usage && <span className="usage">
            ↑{agent.usage.promptTokens ?? 0} ↓{agent.usage.completionTokens ?? 0} tok · {agent.usage.requests ?? 0} req
          </span>}
        </div>
        <NoticeStack />
        <InteractionCards />
        <TaskStatusStrip sessionId={agent.sessionId} />
        <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <LibraryDialog open={libraryOpen} onClose={() => setLibraryOpen(false)}
          activeSessionId={agent.sessionId} onJump={jumpToSaved} />
        <Composer
          onSend={onSend}
          running={agent.running || groupBusy}
          onStop={agent.stop}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          attachments={attachments}
          onRemoveAttachment={(i) => setAttachments((p) => p.filter((_, j) => j !== i))}
          onAttach={() => fileInput.current?.click()}
          onSnap={snap}
          onCommand={runCommand}
          fileEntries={fileEntries}
          onOpenPrompts={() => setPromptLib(true)}
          onDropFiles={addFiles}
          onMemo={addFiles}
          onTranscript={insertTranscript}
          onDiscard={discardDraft}
          memoOpen={memoOpen}
          onToggleMemo={() => setMemoOpen((v) => !v)}
          previewOpen={previewOpen}
          onTogglePreview={() => setPreviewOpen((v) => !v)}
          revisingOf={revisingOf}
          onClearRevision={clearRevision}
          editorRef={composerEditor}
          suppressSaveRef={composerSuppress}
          onDraftChange={onDraftChange}
          dictating={dictating}
          onToggleDictation={toggleDictation}
          voiceMode={voiceMode}
          onToggleVoiceMode={toggleVoiceMode}
          liveVoice={liveVoice}
          onToggleLiveVoice={() => setLiveVoice((v) => !v)}
        />
        <input ref={fileInput} type="file" multiple hidden
          onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
        </section>
        {agent.running && (
          <button type="button" className="run-stop-pill" data-action="stop-run"
            onClick={agent.stop} title="Stop the run">
            <Icon.Stop /> <span>Stop</span>
          </button>
        )}
        {agent.confirm && (
          <ConfirmOverlay confirm={agent.confirm} sessionId={agent.sessionId} onAnswer={agent.answerConfirm} />
        )}
        <aside
          className={`stage-column${watchBrowser ? ' has-browser' : ''}${stageCollapsed ? ' is-collapsed' : ''}`}
          aria-label="Agent workspace"
          style={{ width: stageCollapsed ? STAGE_COLLAPSED_W : stageWidth }}
        >
          <div className="stage-resizer" role="separator" aria-orientation="vertical" aria-label="Resize side pane"
            title="Drag to resize" onPointerDown={onStageResizeStart} />
          <button
            type="button"
            className="stage-collapse"
            data-surface="stage-collapse"
            aria-expanded={!stageCollapsed}
            title={stageCollapsed ? 'Show the side pane' : 'Hide the side pane'}
            onClick={toggleStage}
          >
            {stageCollapsed ? <Icon.ChevronLeft /> : <Icon.ChevronRight />}
          </button>
          {stageCollapsed ? null : (<>
          <section className="agent-computer" data-surface="agent-computer" aria-label="Bot computer">
            <header className="agent-computer-head">
              <span className="surface-label">{watchBrowser ? 'Session browser' : 'Bot computer'}</span>
              <span className={`computer-phase ${watchBrowser ? 'browser' : botComputer.phase}`}
                data-surface="agent-computer-status"
                title={botComputer.phase === 'off' ? `sandbox: ${agentComputer.status || 'idle'}` : `computer: ${botComputer.phase}`}>
                {computerPhaseLabel}
              </span>
            </header>
            <div className={`computer-screen${watchBrowser ? ' is-browser' : ''}`}>
              {watchBrowser ? (
                <>
                  <div className="environment-kind">Chromium · in this app</div>
                  <ComputerBrowser
                    sessionId={agent.sessionId}
                    state={browserState}
                    viewportRef={viewportRef}
                    onHide={hideBrowser}
                  />
                </>
              ) : botComputer.phase === 'ready' && botComputer.url ? (
                <>
                  <div className="computer-live-bar">
                    <span className="environment-kind">
                      Linux VM · live desktop{botComputer.input ? '' : ' · screen only'}
                      {liveComputerChildren > 0 ? ` · ${liveComputerChildren} subagent${liveComputerChildren === 1 ? '' : 's'} on this screen` : ''}
                    </span>
                    <button type="button" className="btn btn-mini btn-secondary" data-action="stop-computer" onClick={stopBotComputer}>Stop</button>
                  </div>
                  <div className="computer-preview">
                    <ScreenViewer url={botComputer.url} viewOnly onDisconnect={() => {}} />
                    <button type="button" className="computer-open" data-action="open-computer" onClick={() => setComputerOpen(true)}>
                      <Icon.Expand /> <span>Open</span>
                    </button>
                  </div>
                </>
              ) : (
                <div className="computer-empty" data-surface="computer-idle">
                  <div className="environment-kind">
                    {botComputer.phase === 'starting' ? 'Linux VM · booting…'
                      : botComputer.phase === 'error' ? 'Linux VM · unavailable'
                        : 'Linux VM · off'}
                  </div>
                  <p className="agent-computer-note">
                    {botComputer.phase === 'error'
                      ? botComputer.error || 'The guest did not start.'
                      : 'This bot has its own Linux computer. Start it to watch and control the same desktop its computer-use subagents drive.'}
                  </p>
                  <div className="computer-actions">
                    <button type="button" className="btn btn-primary" data-action="start-computer"
                      disabled={botComputer.phase === 'starting'} onClick={startBotComputer}>
                      {botComputer.phase === 'starting' ? 'Starting…' : botComputer.phase === 'error' ? 'Retry computer' : 'Start computer'}
                    </button>
                    {botComputer.phase === 'ready' && (
                      <button type="button" className="btn btn-secondary" onClick={stopBotComputer}>Stop</button>
                    )}
                  </div>
                  <div className="agent-computer-identity" data-surface="agent-computer-identity">{agentComputer.identity}</div>
                  <code className="agent-computer-root" data-surface="agent-computer-root">
                    {agentComputer.root ? agentComputer.root.replace(/^\/Users\/[^/]+/, '~') : 'Idle until this session runs'}
                  </code>
                </div>
              )}
            </div>
          </section>
          <div className="stage-scroll">
          <section className="computer-desk" data-surface="agent-computer-desk" aria-label="Session computer">
            <header className="surface-label">Workspace</header>
            <ul>
              <li>Files</li>
              <li>Shell</li>
              <li>Terminal</li>
            </ul>
          </section>
          <section className="subagent-roster" data-surface="subagent-rows" aria-label="Subagents">
            <header className="surface-label">Subagents</header>
            <details className="task-start" data-surface="delegate-task">
              <summary>Delegate task</summary>
              <form onSubmit={async (event) => {
                event.preventDefault();
                if (!taskDraft.prompt.trim() || startingTask) return;
                setStartingTask(true);
                try {
                  await api.tasks.start({ sessionId: agent.sessionId, prompt: taskDraft.prompt, description: taskDraft.prompt.slice(0, 80), subagent_type: taskDraft.type, model: taskDraft.model.trim() || undefined, environment: taskDraft.environment });
                  setTaskDraft((draft) => ({ ...draft, prompt: '' }));
                } catch (failure) { toast(failure.message, 'err'); }
                finally { setStartingTask(false); }
              }}>
                <textarea aria-label="Delegated task instructions" placeholder="What should this child do?" value={taskDraft.prompt} onChange={(event) => setTaskDraft((draft) => ({ ...draft, prompt: event.target.value }))} required />
                <select aria-label="Delegated task role" value={taskDraft.type} onChange={(event) => setTaskDraft((draft) => ({ ...draft, type: event.target.value }))}>{['general', 'explore', 'shell', 'browser', 'computer-use'].map((type) => <option key={type}>{type}</option>)}</select>
                <input aria-label="Delegated task model" placeholder={settings?.model || 'Default model'} value={taskDraft.model} onChange={(event) => setTaskDraft((draft) => ({ ...draft, model: event.target.value }))} />
                <select aria-label="Delegated task workspace" value={taskDraft.environment} onChange={(event) => setTaskDraft((draft) => ({ ...draft, environment: event.target.value }))}><option value="shared">Parent workspace</option><option value="isolated">Separate workspace</option></select>
                <button className="btn btn-primary" disabled={startingTask}>{startingTask ? 'Starting…' : 'Start child'}</button>
              </form>
            </details>
            {(() => {
              const rows = agent.subagents?.length ? agent.subagents : [{
                id: 'idle', title: 'No subagents yet', type: '—', status: 'idle', summary: 'Waiting for a child run',
              }];
              const groups = [];
              const seen = new Map();
              for (const row of rows) {
                const key = row.team || '';
                if (!seen.has(key)) {
                  seen.set(key, groups.length);
                  groups.push({ key, brief: row.team || '', rows: [] });
                }
                groups[seen.get(key)].rows.push(row);
              }
              return groups.map((group) => (
                <div key={group.key || 'solo'} className="subagent-team" data-subagent-team={group.brief || undefined}>
                  {group.brief ? <div className="subagent-team-name">{group.brief}</div> : null}
                  {group.rows.map((row) => (
                    <article key={row.id} className="subagent-row" data-subagent-row data-status={row.status}>
                      <span className="subagent-title">{row.title || row.name || 'Subagent'}</span>
                      <span className="subagent-type">{row.type || 'general'}</span>
                      <span className="subagent-status">{row.status || 'idle'}</span>
                      <span className="subagent-summary">{row.summary || ''}</span>
                      {row.id !== 'idle' && <div className="subagent-actions">
                        {row.model && <span className="task-model">{row.model}</span>}
                        <button className="btn btn-mini btn-secondary" onClick={() => setSelectedTask(row.id)}>Inspect</button>
                        {['queued', 'running'].includes(row.status) && <button className="btn btn-mini btn-danger" onClick={() => api.tasks.interrupt({ sessionId: agent.sessionId, id: row.id }).catch((failure) => toast(failure.message, 'err'))}>Stop</button>}
                      </div>}
                    </article>
                  ))}
                </div>
              ));
            })()}
            <details className="subagent-add">
            <summary>New subagent</summary>
            <form className="custom-subagent-form" data-surface="custom-subagents" onSubmit={async (event) => {
              event.preventDefault();
              const name = customDraft.name.trim();
              if (!name) return;
              const current = await api.settings.get();
              const tools = customDraft.tools.split(',').map((item) => item.trim()).filter(Boolean);
              const next = [...(current.customSubagents || []).filter((item) => item.name !== name), {
                name, description: customDraft.description, prompt: customDraft.prompt, tools, permissionMode: customDraft.permissionMode,
              }];
              await api.settings.save({ customSubagents: next });
              setCustomDraft({ name: '', description: '', prompt: '', tools: 'read_file,list_dir', permissionMode: 'read-only' });
            }}>
              <input aria-label="Custom subagent name" placeholder="Custom subagent name" value={customDraft.name} onChange={(e) => setCustomDraft((d) => ({ ...d, name: e.target.value }))} />
              <input aria-label="Custom subagent description" placeholder="Description" value={customDraft.description} onChange={(e) => setCustomDraft((d) => ({ ...d, description: e.target.value }))} />
              <input aria-label="Custom subagent prompt" placeholder="Role prompt" value={customDraft.prompt} onChange={(e) => setCustomDraft((d) => ({ ...d, prompt: e.target.value }))} />
              <input aria-label="Custom subagent tools" placeholder="tool,allowlist" value={customDraft.tools} onChange={(e) => setCustomDraft((d) => ({ ...d, tools: e.target.value }))} />
              <select aria-label="Permission mode" value={customDraft.permissionMode} onChange={(e) => setCustomDraft((d) => ({ ...d, permissionMode: e.target.value }))}>
                <option value="read-only">read-only</option>
                <option value="workspace">workspace</option>
                <option value="computer">computer</option>
              </select>
              <button type="submit" className="btn btn-secondary">Save subagent</button>
            </form>
            </details>
          </section>
          <section className="computer-browser-host" data-surface="computer-browser-host" aria-label="Browser and playback">
            <button type="button" className="btn btn-secondary" data-action="show-browser" onClick={() => showBrowser(agent.sessionId)}>Browser</button>
            <button type="button" className="btn btn-secondary" onClick={() => api.playback.open({ sessionId: agent.sessionId }).catch(() => {})}>Playback</button>
            <button type="button" className="btn btn-secondary" data-action="start-desktop" disabled={botComputer.phase === 'starting'}
              title="Start this bot's Linux computer and watch/control it"
              onClick={startBotComputer}>
              {botComputer.phase === 'starting' ? 'Starting…' : botComputer.phase === 'ready' ? 'Computer live' : 'Computer'}
            </button>
          </section>
          <section className="skill-playback" data-surface="recorded-playback" aria-label="Recorded run playback">
            <header className="surface-label">Recorded runs</header>
            <div className="skill-playback-row">
              <button type="button" className="btn btn-secondary" onClick={async () => {
                try {
                  await api.skill.prepare();
                  await api.skill.begin();
                  refreshRecordings();
                } catch { /* recorder reports through status */ }
              }}>Record</button>
              <button type="button" className="btn btn-secondary" onClick={async () => {
                try {
                  await api.skill.stop();
                  await api.skill.complete();
                  refreshRecordings();
                } catch { /* incomplete recording */ }
              }}>Finish</button>
              <button type="button" className="btn btn-secondary" onClick={async () => {
                try { await api.skill.cancel(); refreshRecordings(); } catch { /* already idle */ }
              }}>Cancel</button>
              <button type="button" className="btn btn-secondary" data-surface="teach-demo"
                title="Record a human demonstration with the native capture helper (needs Accessibility permission)"
                onClick={async () => {
                  try {
                    if (humanCapture.recording) {
                      const done = await api.humanCapture.stop();
                      toast(`Demonstration saved: ${done.steps} steps`, 'ok');
                      refreshRecordings();
                    } else {
                      await api.humanCapture.start({ sessionId: agent.sessionId });
                      toast('Recording your demonstration — click Finish demo when done', 'ok');
                    }
                    refreshHumanCapture();
                  } catch (error) { toast(error.message ?? String(error), 'err'); refreshHumanCapture(); }
                }}>{humanCapture.recording ? `Finish demo (${humanCapture.steps})` : 'Teach by demonstration'}</button>
              {humanCapture.recording && (
                <button type="button" className="btn btn-secondary" onClick={async () => {
                  try { await api.humanCapture.cancel(); refreshHumanCapture(); } catch { /* already stopped */ }
                }}>Cancel demo</button>
              )}
              {(recordings.length ? recordings : [{ id: 'none', state: 'idle', steps: 0 }]).map((rec) => (
                <button key={rec.id} type="button" className="skill-play" data-recording={rec.id} disabled={rec.id === 'none'}
                  onClick={() => api.skill.replay({ id: rec.id }).catch(() => {})}>
                  Play {rec.id === 'none' ? 'recording' : rec.id}
                </button>
              ))}
            </div>
          </section>
          <details className="permissions-manager" data-surface="permissions-manager" open>
            <summary className="surface-label">Permissions</summary>
            <PermissionPanel onToast={toast} compact />
          </details>
          <details className="settings-hint" data-surface="settings-hint">
            <summary className="surface-label">More settings</summary>
            <p className="permission-hint">
              The permission matrix, the vault, the plugin catalogue, usage and the
              meetings live in Settings — open it from the title bar.
            </p>
          </details>
          <details className="secrets-manager" data-surface="secrets">
            <summary className="surface-label">Secrets vault</summary>
            <div className="secret-list">
              {secrets.length ? secrets.map((s) => (
                <div key={s.name} className="secret-row" data-secret={s.name}>
                  <span className="secret-name">{s.name}</span>
                  <span className="secret-fields">{s.fields.join(', ') || '—'}</span>
                  <button className="ibtn danger" title="Delete secret" onClick={async () => { await api.secrets.remove({ name: s.name }).catch(() => {}); refreshSecrets(); }}><Icon.Trash /></button>
                </div>
              )) : <span className="secret-empty">No secrets. Reference one in a tool as {'{{secret:NAME.FIELD}}'}.</span>}
            </div>
            <form className="secret-form" onSubmit={async (event) => {
              event.preventDefault();
              const name = secretDraft.name.trim();
              if (!name || !secretDraft.value) return;
              try {
                await api.secrets.set({ name, fields: { [secretDraft.field.trim() || 'value']: secretDraft.value }, note: secretDraft.note });
                setSecretDraft((d) => ({ ...d, name: '', value: '', note: '' }));
                refreshSecrets();
              } catch (failure) { toast(failure.message, 'err'); }
            }}>
              <input aria-label="Secret name" placeholder="name (e.g. github_token)" value={secretDraft.name} onChange={(e) => setSecretDraft((d) => ({ ...d, name: e.target.value }))} />
              <input aria-label="Field name" placeholder="field" value={secretDraft.field} onChange={(e) => setSecretDraft((d) => ({ ...d, field: e.target.value }))} />
              <input aria-label="Secret value" type="password" placeholder="value (encrypted at rest)" value={secretDraft.value} onChange={(e) => setSecretDraft((d) => ({ ...d, value: e.target.value }))} />
              <button className="btn btn-secondary" type="submit">Store</button>
             </form>
           </details>
           <details className="sections-group" data-surface="sections" open={sectionsOpen} onToggle={(e) => setSectionsOpen(e.currentTarget.open)}>
          <summary className="surface-label">Skills · Addons · Integrations · Memory · Marketplace</summary>
          <details className="skills-manager" data-surface="skills">
             <summary className="surface-label">Skills</summary>
             <div className="skill-manager-list">
               {(skills.length ? skills : [{ id: 'none', name: 'No skills installed', enabled: false, description: 'install from Marketplace' }]).map((s) => (
                 <div key={s.id} className="skill-manager-row" data-skill={s.id} data-enabled={s.enabled ? '1' : '0'}>
                   <span className="skill-manager-name">{s.name}{s.enabled ? '' : ' <em>(off)</em>'}</span>
                   <span className="skill-manager-desc">{s.description}</span>
                   {s.id !== 'none' && (
                     <div className="skill-manager-actions">
                       <button className="ibtn" title={s.enabled ? 'Disable' : 'Enable'} onClick={async () => { await api.skills.setEnabled({ id: s.id, enabled: !s.enabled }).catch(() => {}); refreshSkills(); }}>{s.enabled ? <Icon.Pause /> : <Icon.Play />}</button>
                       <button className="ibtn danger" title="Uninstall" onClick={async () => { await api.skills.uninstall({ id: s.id }).catch(() => {}); refreshSkills(); }}><Icon.Trash /></button>
                     </div>
                   )}
                 </div>
               ))}
             </div>
             <form className="skill-manager-form" onSubmit={async (event) => {
               event.preventDefault();
               const name = skillDraft.name.trim(); const body = skillDraft.body.trim();
               if (!name || !body) return;
               try { await api.skills.publish({ name, body }); setSkillDraft({ name: '', body: '' }); refreshSkills(); }
               catch (failure) { toast(failure.message, 'err'); }
             }}>
               <input aria-label="Skill name" placeholder="skill name" value={skillDraft.name} onChange={(e) => setSkillDraft((d) => ({ ...d, name: e.target.value }))} />
               <textarea aria-label="Skill instructions" placeholder="SKILL.md instructions the agent should follow" value={skillDraft.body} onChange={(e) => setSkillDraft((d) => ({ ...d, body: e.target.value }))} />
               <button className="btn btn-secondary" type="submit">Add skill</button>
             </form>
           </details>
           <details className="addons-manager" data-surface="addons">
             <summary className="surface-label">Addons</summary>
             <div className="addon-list">
               {(addons.length ? addons : [{ id: 'none', name: 'No addons installed', trust: '—', permissions: [] }]).map((a) => (
                 <div key={a.id} className="addon-row" data-addon={a.id} data-enabled={a.enabled ? '1' : '0'} data-trust={a.trust}>
                   <span className="addon-name">{a.name} <span className="addon-version">v{a.version}</span></span>
                   <span className={`addon-trust ${a.trust}`}>{a.trust}</span>
                   <span className="addon-desc">{a.description || `${a.skills || 0} skills · ${a.mcpServers || 0} MCP`}</span>
                   {a.id !== 'none' && (
                     <div className="addon-actions">
                       <button className="ibtn" title={a.enabled ? 'Disable' : 'Enable'} onClick={async () => {
                         try { await api.addons[a.enabled ? 'disable' : 'enable']({ id: a.id }); } catch (failure) { toast(failure.message, 'err'); }
                         refreshAddons();
                       }}>{a.enabled ? <Icon.Pause /> : <Icon.Play />}</button>
                       <button className="ibtn danger" title="Uninstall" onClick={async () => {
                         try { await api.addons.uninstall({ id: a.id }); } catch (failure) { toast(failure.message, 'err'); }
                         refreshAddons();
                       }}><Icon.Trash /></button>
                     </div>
                   )}
                 </div>
               ))}
             </div>
             <button className="btn btn-secondary" type="button" onClick={async () => {
               try {
                 const installed = await api.addons.install();
                 if (installed) { toast(`Installed ${installed.name}`, 'ok'); refreshAddons(); }
               } catch (failure) { toast(failure.message, 'err'); }
             }}>Install addon folder…</button>
             <form className="addon-trust-form" onSubmit={async (event) => {
               event.preventDefault();
               try {
                 await api.addons.trust({ publisher: trustDraft.publisher.trim(), publicKeyPem: trustDraft.key });
                 toast('Publisher key trusted', 'ok');
                 setTrustDraft({ publisher: '', key: '' });
               } catch (failure) { toast(failure.message, 'err'); }
             }}>
               <input aria-label="Publisher" placeholder="publisher" value={trustDraft.publisher} onChange={(e) => setTrustDraft((d) => ({ ...d, publisher: e.target.value }))} />
               <textarea aria-label="Publisher public key" placeholder="Ed25519 public key (PEM)" value={trustDraft.key} onChange={(e) => setTrustDraft((d) => ({ ...d, key: e.target.value }))} />
               <button className="btn btn-secondary" type="submit">Trust key</button>
             </form>
           </details>
           <details className="templates-manager" data-surface="templates">
             <summary className="surface-label">Bot templates</summary>
             <p className="mini-copy">Snapshot this bot's profile (or import a shared JSON template). Sharing is a local file handoff.</p>
             <div className="template-list">
               {(templates.length ? templates : [{ id: 'none', name: 'No templates yet', visibility: '—', version: 0, profile: {} }]).map((t) => (
                 <div key={t.id} className="template-row" data-template={t.id} data-visibility={t.visibility}>
                   <span className="template-name">{t.name}</span>
                   <span className="template-visibility">{t.visibility} · v{t.version}</span>
                   <span className="template-desc">{t.profile?.title || t.description || ''}</span>
                   {t.id !== 'none' && (
                     <div className="template-actions">
                       <button className="ibtn" title="Create a bot from this template" onClick={async () => {
                         try {
                           const result = await api.templates.create({ templateId: t.id });
                           refresh();
                           switchRef.current(result.session.id);
                           toast(`Created ${result.session.title}`, 'ok');
                         } catch (error) { toast(error.message, 'err'); }
                       }}><Icon.Plus /></button>
                       <button className="ibtn" title={t.visibility === 'shared' ? 'Make private' : 'Share (mark shared)'} onClick={async () => {
                         try { await api.templates.setVisibility({ id: t.id, visibility: t.visibility === 'shared' ? 'private' : 'shared' }); }
                         catch (error) { toast(error.message, 'err'); }
                         refreshTemplates();
                       }}>{t.visibility === 'shared' ? <Icon.Eye /> : <Icon.EyeOff />}</button>
                       <button className="ibtn" title="Export template JSON" onClick={async () => {
                         try {
                           const file = await api.templates.export({ id: t.id });
                           if (file) toast(`Exported → ${file}`, 'ok');
                         } catch (error) { toast(error.message, 'err'); }
                       }}><Icon.Popout /></button>
                       <button className="ibtn danger" title="Delete template" onClick={async () => {
                         try { await api.templates.remove({ id: t.id }); } catch (error) { toast(error.message, 'err'); }
                         refreshTemplates();
                       }}><Icon.Trash /></button>
                     </div>
                   )}
                 </div>
               ))}
             </div>
             <div className="template-foot">
               <button className="btn btn-secondary" type="button" onClick={() => {
                 if (activeSession?.kind === 'group') { toast('Groups cannot be saved as bot templates', 'warn'); return; }
                 setTemplateDraft({
                   name: activeSession?.title || '',
                   description: activeSession?.description || '',
                   prompt: '',
                   visibility: 'private',
                 });
               }}>Save current bot as template</button>
               <button className="btn btn-secondary" type="button" onClick={async () => {
                 try {
                   const imported = await api.templates.import();
                   if (imported) { toast(`Imported ${imported.name}`, 'ok'); refreshTemplates(); }
                 } catch (error) { toast(error.message, 'err'); }
               }}>Import template…</button>
             </div>
           </details>
           <details className="integrations-manager" data-surface="integrations">
             <summary className="surface-label">Integrations</summary>
             <p className="integrations-note">Connect your accounts. Status is checked on demand.</p>
             {[
               { kind: 'github', label: 'GitHub', hint: 'install gh + gh auth login' },
               { kind: 'slack', label: 'Slack', hint: 'create an app; store the bot token as secret slack_bot_token' },
               { kind: 'email', label: 'Email', hint: 'configure SMTP/IMAP in Settings + a password secret' },
             ].map((it) => {
               const st = integ[it.kind];
                const state = !st ? 'unknown' : st.error ? 'error' : (st.configured || (it.kind === 'github' && st.authed) || (it.kind === 'email' && (st.smtp || st.imap))) ? 'ok' : 'off';
                return (
                 <div key={it.kind} className="integration-row" data-integration={it.kind} data-state={state}>
                   <span className="integration-label">{it.label}</span>
                   <span className="integration-state">{state === 'ok' ? 'connected' : state === 'off' ? 'not connected' : state === 'error' ? st.error : 'not checked'}</span>
                   <button className="ibtn" title="Check status" onClick={() => checkIntegration(it.kind)}><Icon.Refresh /></button>
                   {state === 'off' && <span className="integration-hint">{st?.hint || it.hint}</span>}
                 </div>
               );
              })}
            </details>
            <details className="memory-manager" data-surface="memory">
              <summary className="surface-label">Memory</summary>
              <div className="memory-scope" data-scope={memScope}>
                <button type="button" className={`chip${memScope === 'session' ? ' active' : ''}`} onClick={() => setMemScope('session')}>This bot</button>
                <button type="button" className={`chip${memScope === 'all' ? ' active' : ''}`} onClick={() => setMemScope('all')}>All</button>
              </div>
              <div className="memory-recall">
                <input aria-label="Recall query" placeholder="recall…" value={memQuery} onChange={(e) => setMemQuery(e.target.value)} />
                <button className="ibtn" title="Recall" onClick={async () => {
                  if (!memQuery.trim()) { refreshMemories(); return; }
                  api.memory.recall({ query: memQuery, ...memScopeArg }).then((r) => setMemories(Array.isArray(r) ? r : (r.memories || []))).catch(() => {});
                }}><Icon.Search /></button>
              </div>
              <div className="memory-list">
                {(memories.length ? memories : [{ id: 'none', text: 'No memories yet' }]).map((m) => (
                  <div key={m.id} className="memory-row" data-memory={m.id}>
                    <span className="memory-text">{m.text}</span>
                    {m.scope && m.scope !== 'global' ? <span className="memory-scope-tag">{m.scope === agent.sessionId ? 'this bot' : m.scope}</span> : null}
                    {m.tags?.length ? <span className="memory-tags">{m.tags.join(', ')}</span> : null}
                    {m.id !== 'none' && (
                      <button className="ibtn danger" title="Forget" onClick={async () => { await api.memory.forget({ id: m.id }).catch(() => {}); refreshMemories(); }}><Icon.Trash /></button>
                    )}
                  </div>
                ))}
              </div>
              <form className="memory-form" onSubmit={async (event) => {
                event.preventDefault();
                const text = memDraft.text.trim(); if (!text) return;
                const tags = memDraft.tags.split(',').map((t) => t.trim()).filter(Boolean);
                try { await api.memory.remember({ text, tags, ...(memScope === 'session' ? { scope: agent.sessionId } : {}) }); setMemDraft({ text: '', tags: '' }); refreshMemories(); }
                catch (failure) { toast(failure.message, 'err'); }
              }}>
                <textarea aria-label="Memory text" placeholder="a fact to remember…" value={memDraft.text} onChange={(e) => setMemDraft((d) => ({ ...d, text: e.target.value }))} />
                <input aria-label="Memory tags" placeholder="tags (comma-sep)" value={memDraft.tags} onChange={(e) => setMemDraft((d) => ({ ...d, tags: e.target.value }))} />
                <button className="btn btn-secondary" type="submit">Remember</button>
              </form>
            </details>
            <details className="marketplace-manager" data-surface="marketplace">
             <summary className="surface-label">Marketplace</summary>
             <div className="marketplace-filter">
               {['', 'skill', 'mcp'].map((k) => (
                 <button key={k || 'all'} type="button"
                   className={`chip${marketKind === k ? ' active' : ''}`}
                   onClick={() => setMarketKind(k)}>{k || 'all'}</button>
               ))}
             </div>
             <div className="marketplace-list">
               {(market.length ? market : [{ id: 'none', name: 'No packages', kind: '—', description: 'browse the catalog', installed: false }]).map((p) => (
                 <div key={p.id} className="marketplace-row" data-package={p.id} data-kind={p.kind} data-installed={p.installed ? '1' : '0'}>
                   <span className="marketplace-name">{p.name}{p.installed ? <span className="marketplace-installed"> ✓</span> : ''}</span>
                   <span className="marketplace-desc">{p.description}</span>
                   {p.id !== 'none' && (
                     <div className="marketplace-actions">
                       <button className="ibtn" title={p.installed ? 'Uninstall' : 'Install'} disabled={p.installed}
                         onClick={async () => { await api.marketplace.install({ id: p.id }).catch(() => {}); refreshMarket(); }}>
                         {p.installed ? <Icon.Check /> : <Icon.Plus />}
                       </button>
                       <button className="ibtn danger" title="Remove" disabled={!p.installed}
                         onClick={async () => { await api.marketplace.uninstall({ id: p.id }).catch(() => {}); refreshMarket(); }}><Icon.Trash /></button>
                     </div>
                   )}
                 </div>
               ))}
              </div>
            </details>
            </details>
            <details className="automations-manager" data-surface="automations">
            <summary className="surface-label">Automations</summary>
            <div className="automation-list">
              {(automations.length ? automations : [{ id: 'none', name: 'No automations yet', kind: '—', enabled: false, lastStatus: 'idle' }]).map((a) => (
                <div key={a.id} className="automation-item">
                  <div className="automation-row" data-automation={a.id} data-kind={a.kind}>
                    <span className="automation-name">{a.name}</span>
                    <span className="automation-meta">{a.kind}{a.kind === 'automation' ? ` · ${Math.round((a.intervalMs || 60000) / 60000)}m` : (a.steps?.length ? ` · ${a.steps.length} steps` : '')}</span>
                    <span className="automation-status" data-status={a.lastStatus}>{a.enabled ? a.lastStatus : 'off'}</span>
                    {a.id !== 'none' && (
                      <div className="automation-actions">
                        <button className="ibtn" title="Run now" onClick={async () => { await api.automations.run({ id: a.id }).catch(() => {}); refreshAutomations(); }}><Icon.Play /></button>
                        <button className="ibtn" title="Test run (does not affect the schedule)" onClick={async () => {
                          try {
                            const result = await api.automations.test({ id: a.id });
                            if (result?.status === 'error') toast(result.error, 'err');
                            else toast('Test run finished', 'ok');
                          } catch (failure) { toast(failure.message, 'err'); }
                          refreshAutomations();
                          if (autoHistory[a.id]) api.automations.history({ id: a.id, limit: 10 }).then((runs) => setAutoHistory((prev) => ({ ...prev, [a.id]: runs }))).catch(() => {});
                        }}><Icon.Zap /></button>
                        <button className="ibtn" title="Run history" data-action="history" onClick={() => toggleAutoHistory(a.id)}><Icon.Clock /></button>
                        <button className="ibtn" title="Edit routine" data-action="edit" onClick={() => setEditAuto({
                          id: a.id, name: a.name, kind: a.kind, prompt: a.prompt || '',
                          stepsText: (a.steps || []).join('\n'),
                          intervalMin: String(Math.round((a.intervalMs || 60000) / 60000)),
                          cron: a.cron || '',
                        })}><Icon.Edit /></button>
                        <button className="ibtn" title={a.enabled ? 'Disable' : 'Enable'} onClick={async () => { await api.automations.setEnabled({ id: a.id, enabled: !a.enabled }).catch(() => {}); refreshAutomations(); }}>{a.enabled ? <Icon.Pause /> : <Icon.Play />}</button>
                        <button className="ibtn danger" title="Delete" onClick={async () => { await api.automations.remove({ id: a.id }).catch(() => {}); refreshAutomations(); }}><Icon.Trash /></button>
                      </div>
                    )}
                  </div>
                  {autoHistory[a.id] && (
                    <div className="automation-history" data-automation-history={a.id}>
                      {autoHistory[a.id].length === 0 && <span className="automation-run-empty">No runs yet</span>}
                      {autoHistory[a.id].map((run, index) => (
                        <div className="automation-run" key={`${run.at}-${index}`} data-status={run.status}>
                          <span className={`automation-run-dot ${run.status}`} />
                          <span className="automation-run-trigger">{run.trigger}</span>
                          <span className="automation-run-time">{new Date(run.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                          <span className="automation-run-summary">{run.status === 'error' ? run.error : run.summary || '—'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <form className="automation-form" onSubmit={async (event) => {
              event.preventDefault();
              const name = autoDraft.name.trim() || 'Automation';
              const prompt = autoDraft.prompt.trim();
              if (!prompt) return;
              const intervalMs = Math.max(60_000, (Number(autoDraft.intervalMin) || 15) * 60_000);
              const cron = autoDraft.cron.trim();
              try {
                await api.automations.create(cron ? { name, prompt, cron, sessionId: 'automations' } : { name, prompt, intervalMs, sessionId: 'automations' });
                setAutoDraft((d) => ({ ...d, name: '', prompt: '' }));
                refreshAutomations();
              } catch (failure) { toast(failure.message, 'err'); }
            }}>
              <input aria-label="Automation name" placeholder="name" value={autoDraft.name} onChange={(e) => setAutoDraft((d) => ({ ...d, name: e.target.value }))} />
              <input aria-label="Interval minutes" type="number" min="1" placeholder="minutes" value={autoDraft.intervalMin} onChange={(e) => setAutoDraft((d) => ({ ...d, intervalMin: e.target.value }))} />
              <input aria-label="Cron schedule (optional)" placeholder="cron e.g. 0 9 * * * (overrides minutes)" value={autoDraft.cron} onChange={(e) => setAutoDraft((d) => ({ ...d, cron: e.target.value }))} />
              <input aria-label="Automation prompt" placeholder="agent prompt to run on a schedule" value={autoDraft.prompt} onChange={(e) => setAutoDraft((d) => ({ ...d, prompt: e.target.value }))} />
              <button className="btn btn-secondary" type="submit">Add</button>
            </form>
          </details>
          <div className={`computer-trust host-mac${agent.computerActive ? ' active' : ''}${takeover ? ' taken-over' : ''}`} data-surface="computer-trust">
            <span className="surface-label">This Mac</span>
            <span className="computer-trust-state">{takeover ? 'You have control (agent paused)' : agent.computerActive ? 'Controlling this Mac' : 'Not controlling this Mac'}</span>
            <button type="button" className="computer-stop" data-surface="computer-stop" onClick={agent.stop}>Stop</button>
            {agent.computerActive || takeover ? (
              <button type="button" className="computer-takeover" data-surface="cu-takeover-panel" onClick={() => handoff(!takeover)}>
                {takeover ? "I'm done" : 'Take over'}
              </button>
            ) : null}
            <div className="computer-recovery">
              <button type="button" data-surface="computer-recover" title="Restart the helper, guest desktop, and sandbox for this session" onClick={recoverComputer}>Recover</button>
              <button type="button" data-surface="computer-reset" title="Remove this session's sandbox computer; the next run boots fresh" onClick={() => setResetConfirm(true)}>Reset…</button>
            </div>
          </div>
          </div>
          </>)}
        </aside>
        </div>
        {closeRequest && closeRequest.seconds > 0 && (
          <div className="grace-close-overlay">
            <div className="grace-close-card">
              <strong>This session is still running</strong>
              <p>Closing the window anyway in {closeRequest.seconds}s. Cancel to keep watching the run.</p>
              <div className="row">
                <button className="btn btn-primary" onClick={() => {
                  api.window.cancelClose({}).catch(() => {});
                  setCloseRequest(null);
                }}>Keep window</button>
                <button className="btn btn-secondary" onClick={() => setCloseRequest(null)}>Close anyway</button>
              </div>
            </div>
          </div>
        )}
        {selectedTask && <TaskDetail key={selectedTask} sessionId={agent.sessionId} taskId={selectedTask} onClose={() => setSelectedTask(null)} />}
        {promptLib && (
          <PromptLibrary
            composerText={composerText.current}
            onInsert={(body) => onSend(body, [])}
            onClose={() => setPromptLib(false)} />
        )}
      </main>

      {dock.open && (
        <aside className="dock">
          <div className="dock-tabs">
            <button className={`dock-tab${dock.tab === 'files' ? ' active' : ''}`} onClick={() => setDock({ open: true, tab: 'files' })}><Icon.Folder /> Files</button>
            <button className={`dock-tab${dock.tab === 'git' ? ' active' : ''}`} onClick={() => setDock({ open: true, tab: 'git' })}><Icon.Git /> Git</button>
            <button className={`dock-tab${dock.tab === 'terminal' ? ' active' : ''}`} onClick={() => setDock({ open: true, tab: 'terminal' })}><Icon.Terminal /> Terminal</button>
            <button className={`dock-tab${dock.tab === 'downloads' ? ' active' : ''}`} onClick={() => setDock({ open: true, tab: 'downloads' })}><Icon.File /> Downloads</button>
            <button className={`dock-tab${dock.tab === 'library' ? ' active' : ''}`} onClick={() => setDock({ open: true, tab: 'library' })}><Icon.Brain /> Library</button>
            <button className={`dock-tab${dock.tab === 'artifacts' ? ' active' : ''}`} onClick={() => setDock({ open: true, tab: 'artifacts' })}><Icon.Sparkle /> Artifacts</button>
            <span style={{ flex: 1 }} />
            <button className="ibtn" title="Close panels (⌘.)" onClick={() => setDock((d) => ({ ...d, open: false }))}><Icon.X /></button>
          </div>
          <div className="dock-body">
            {dock.tab === 'files' && <FilesPanel active={dock.open} />}
            {dock.tab === 'git' && <GitPanel active={dock.open} />}
            {dock.tab === 'terminal' && <TerminalPanel active={dock.open} />}
            {dock.tab === 'downloads' && <DownloadsPanel sessionId={agent.sessionId} active={dock.open} />}
            {dock.tab === 'library' && <LibraryPanel sessionId={agent.sessionId} active={dock.open} />}
            {dock.tab === 'artifacts' && <ArtifactsPanel sessionId={agent.sessionId} active={dock.open} />}
          </div>
        </aside>
      )}

      {liveVoice && (
        <VoiceOverlay
          sessionId={agent.sessionId}
          onSend={(text) => onSend(text, [])}
          onClose={() => setLiveVoice(false)}
        />
      )}

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="t-icon">{t.kind === 'ok' ? <Icon.Check /> : t.kind === 'err' ? <Icon.X /> : t.kind === 'warn' ? <Icon.Info /> : <Icon.Info />}</span>
            <span className="t-msg">{t.message}</span>
            <button className="t-close" onClick={() => dismiss(t.id)}>✕</button>
          </div>
        ))}
      </div>

      {details && (
        <DetailsPane
          sessionId={agent.sessionId}
          muted={sessions.find((s) => s.id === agent.sessionId)?.muted === true}
          language={settings?.language}
          timezone={settings?.timezone}
          onToggleMuted={(id, muted) => { api.sessions.update({ id, muted }).then(refresh).catch(() => {}); }}
          onClose={() => setDetails(false)}
          onChanged={() => { refresh(); toast('done', 'ok'); }}
        />
      )}

      {palette && (
        <Palette          mode={palette.mode}
          sessions={visibleSessions}
          activeSessionId={agent.sessionId}
          avatars={avatars}
          actions={paletteActions}
          messageResults={paletteMessages}
          fileResults={fileEntries.filter((en) => !en.dir).map((en) => en.path)}
          linkResults={paletteLinks}
          routineResults={automations}
          searching={paletteSearching}
          onQueryChange={setPaletteQuery}
          onClose={() => { setPalette(null); setPaletteQuery(''); }}
          onSelectSession={(id) => switchSession(id)}
          onSelectMessage={openMessageHit}
          onSelectFile={mentionFile}
          onSelectLink={openPaletteLink}
          onSelectRoutine={revealRoutine}
          onAction={runPaletteAction}
        />
      )}

      {sessionMenu && (() => {
        const menuSession = sessions.find((s) => s.id === sessionMenu.id) ?? {};
        const patch = (fields) => {
          api.sessions.update({ id: sessionMenu.id, ...fields }).then(refresh).catch(() => {});
          setSessionMenu(null);
        };
        return (
        <div className="session-menu" style={{ left: sessionMenu.x, top: sessionMenu.y }} role="menu">
          <button type="button" role="menuitem" onClick={() => patch({ pinned: !menuSession.pinned })}>
            <Icon.Pin /> {menuSession.pinned ? 'Unpin session' : 'Pin session'}
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setRename({ id: sessionMenu.id, value: menuSession.title ?? '' });
            setSessionMenu(null);
          }}>
            <Icon.Edit /> Rename…
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setProfile({
              id: sessionMenu.id,
              title: menuSession.title ?? '',
              label: menuSession.label ?? '',
              description: menuSession.description ?? '',
            });
            setSessionMenu(null);
          }}>
            <Icon.Info /> Edit profile…
          </button>
          <button type="button" role="menuitem" onClick={() => {
            api.sessions.duplicate({ id: sessionMenu.id })
              .then((res) => { refresh(); toast(`duplicated → ${res.title}`, 'ok'); })
              .catch((err) => toast(err.message ?? String(err), 'err'));
            setSessionMenu(null);
          }}>
            <Icon.Copy /> Duplicate
          </button>
          <button type="button" role="menuitem" onClick={() => patch({ hidden: !menuSession.hidden })}>
            {menuSession.hidden ? <Icon.Eye /> : <Icon.EyeOff />} {menuSession.hidden ? 'Unhide session' : 'Hide session'}
          </button>
          <div className="menu-sep" role="separator" />
          {attention.unread.has(sessionMenu.id) ? (
            <button type="button" role="menuitem" onClick={() => { attention.markRead(sessionMenu.id); setSessionMenu(null); }}>
              <Icon.Check /> Mark as read
            </button>
          ) : (
            <button type="button" role="menuitem" onClick={() => { attention.markUnread(sessionMenu.id); setSessionMenu(null); }}>
              <Icon.Info /> Mark as unread
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => {
            api.sessions.export({ id: sessionMenu.id })
              .then((p) => toast(p ? `exported → ${p}` : 'export canceled', p ? 'ok' : 'warn'))
              .catch((err) => toast(err.message ?? String(err), 'err'));
            setSessionMenu(null);
          }}>Export conversation</button>
          <button type="button" role="menuitem" onClick={() => {
            api.playback.open({ sessionId: sessionMenu.id }).catch(() => {});
            setSessionMenu(null);
          }}>Watch the run</button>
          <button type="button" role="menuitem" className="danger" onClick={() => {
            api.sessions.remove({ id: sessionMenu.id }).then(refresh).catch(() => {});
            setSessionMenu(null);
          }}>Delete session</button>
        </div>
        );
      })()}

      {rename && (
        <div className="mini-overlay" onClick={() => setRename(null)}>
          <form className="mini-dialog" data-surface="rename-dialog" onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const value = rename.value.trim();
              if (value) api.sessions.update({ id: rename.id, title: value }).then(refresh).catch(() => {});
              setRename(null);
            }}>
            <div className="mini-title">Rename session</div>
            <input className="mini-input" autoFocus value={rename.value} maxLength={80}
              onChange={(e) => setRename((r) => ({ ...r, value: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRename(null); } }} />
            <div className="mini-actions">
              <button type="button" className="mini-btn" onClick={() => setRename(null)}>Cancel</button>
              <button type="submit" className="mini-btn primary">Save</button>
            </div>
          </form>
        </div>
      )}

      {profile && (
        <div className="mini-overlay" onClick={() => setProfile(null)}>
          <form className="mini-dialog" data-surface="profile-dialog" onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              api.sessions.update({
                id: profile.id,
                title: profile.title.trim() || 'Untitled',
                label: profile.label.trim(),
                description: profile.description.trim(),
              }).then(() => { refresh(); toast('Profile saved', 'ok'); }).catch((error) => toast(error.message, 'err'));
              setProfile(null);
            }}>
            <div className="mini-title">Edit bot profile</div>
            <input className="mini-input" autoFocus aria-label="Bot name" placeholder="Name" value={profile.title} maxLength={80}
              onChange={(e) => setProfile((p) => ({ ...p, title: e.target.value }))} />
            <input className="mini-input" aria-label="Bot label" placeholder="Label (e.g. release manager)" value={profile.label} maxLength={60}
              onChange={(e) => setProfile((p) => ({ ...p, label: e.target.value }))} />
            <textarea className="mini-input" aria-label="Bot description" placeholder="Description" rows={3} value={profile.description} maxLength={400}
              onChange={(e) => setProfile((p) => ({ ...p, description: e.target.value }))} />
            <div className="mini-actions">
              <button type="button" className="mini-btn" onClick={() => setProfile(null)}>Cancel</button>
              <button type="submit" className="mini-btn primary">Save</button>
            </div>
          </form>
        </div>
      )}

      {newBot && (
        <div className="mini-overlay" onClick={() => { if (!newBot.busy) setNewBot(null); }}>
          <form className="mini-dialog" data-surface="new-bot-dialog" onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); createNewBot(); }}>
            <div className="mini-title">Create New Bot</div>
            <input className="mini-input" autoFocus aria-label="Bot name" placeholder="Name your Bot"
              value={newBot.name} maxLength={80} disabled={newBot.busy}
              onChange={(e) => setNewBot((state) => ({ ...state, name: e.target.value }))} />
            <p className="mini-copy">Give it a name. You can add a label and description later in Edit profile.</p>
            {newBot.error ? <p className="mini-copy" role="alert" style={{ color: 'var(--danger)' }}>{newBot.error}</p> : null}
            <div className="mini-actions">
              <button type="button" className="mini-btn" disabled={newBot.busy} onClick={() => setNewBot(null)}>Cancel</button>
              <button type="submit" className="mini-btn primary" disabled={!newBot.name.trim() || newBot.busy}>
                {newBot.busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      {computerOpen && botComputer.phase === 'ready' && botComputer.url && (
        <div className="computer-modal-overlay" onClick={() => setComputerOpen(false)}>
          <div className="computer-modal" data-surface="computer-modal" onClick={(e) => e.stopPropagation()}>
            <header className="computer-modal-head">
              <span className="surface-label">Bot computer</span>
              <span className="computer-modal-meta">
                Linux VM · 1280×800{liveComputerChildren > 0 ? ` · ${liveComputerChildren} subagent${liveComputerChildren === 1 ? '' : 's'} on this screen` : ''}
              </span>
              <button type="button" className="mini-btn" data-action="close-computer" onClick={() => setComputerOpen(false)}>Close</button>
            </header>
            <ScreenViewer url={botComputer.url} onDisconnect={() => setComputerOpen(false)} />
          </div>
        </div>
      )}

      {editAuto && (
        <div className="mini-overlay" onClick={() => setEditAuto(null)}>
          <form className="mini-dialog" data-surface="routine-edit-dialog" onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              const patch = {
                name: editAuto.name.trim() || 'Routine',
                prompt: editAuto.prompt.trim(),
                cron: editAuto.cron.trim() || null,
                intervalMs: Math.max(60_000, (Number(editAuto.intervalMin) || 15) * 60_000),
              };
              if (editAuto.kind === 'workflow') patch.steps = editAuto.stepsText.split('\n').map((x) => x.trim()).filter(Boolean);
              try {
                await api.automations.update({ id: editAuto.id, ...patch });
                setEditAuto(null);
                refreshAutomations();
                toast('Routine updated', 'ok');
              } catch (error) { toast(error.message, 'err'); }
            }}>
            <div className="mini-title">Edit routine</div>
            <input className="mini-input" aria-label="Routine name" placeholder="Name" value={editAuto.name} maxLength={120}
              onChange={(e) => setEditAuto((a) => ({ ...a, name: e.target.value }))} />
            {editAuto.kind === 'workflow' ? (
              <textarea className="mini-input" aria-label="Workflow steps" rows={5} placeholder="One prompt per line"
                value={editAuto.stepsText}
                onChange={(e) => setEditAuto((a) => ({ ...a, stepsText: e.target.value }))} />
            ) : (
              <textarea className="mini-input" aria-label="Automation prompt" rows={3} placeholder="Agent prompt"
                value={editAuto.prompt}
                onChange={(e) => setEditAuto((a) => ({ ...a, prompt: e.target.value }))} />
            )}
            <div className="routine-edit-row">
              <label>Every (minutes)
                <input className="mini-input" type="number" min="1" value={editAuto.intervalMin}
                  onChange={(e) => setEditAuto((a) => ({ ...a, intervalMin: e.target.value }))} />
              </label>
              <label>Cron (optional)
                <input className="mini-input" placeholder="0 9 * * *" value={editAuto.cron}
                  onChange={(e) => setEditAuto((a) => ({ ...a, cron: e.target.value }))} />
              </label>
            </div>
            <div className="mini-actions">
              <button type="button" className="mini-btn" onClick={() => setEditAuto(null)}>Cancel</button>
              <button type="submit" className="mini-btn primary">Save routine</button>
            </div>
          </form>
        </div>
      )}

      {onboarding && (
        <div className="mini-overlay onboarding-overlay" data-surface="onboarding">
          <div className="mini-dialog onboarding-dialog" role="dialog" aria-modal="true" aria-label="Welcome to Quansiox">
            <div className="onboarding-step" data-surface="onboarding-step">Step {onboarding.step + 1} of 5</div>
            {onboarding.step === 0 && (
              <>
                <div className="mini-title">Welcome to Quansiox</div>
                <p className="mini-copy">A local-first agent that plans, runs tools, drives a browser, and reports back — all on this Mac. Let's set up your first bot.</p>
                <ul className="onboarding-list">
                  <li>Bots are local sessions with their own memory and profile.</li>
                  <li>Nothing is sent anywhere except the provider you configure.</li>
                  <li>You can change everything later in Settings.</li>
                </ul>
              </>
            )}
            {onboarding.step === 1 && (
              <>
                <div className="mini-title">Choose a workspace</div>
                <p className="mini-copy">The folder the agent may read and edit. You can change it later.</p>
                <p className="onboarding-path mono">{sidebar.workspace || 'current folder'}</p>
                <button type="button" className="btn btn-secondary" onClick={async () => {
                  try { const root = await api.workspace.pickRoot(); if (root) { toast('Workspace set', 'ok'); refreshSidebar(); } }
                  catch (error) { toast(error.message, 'err'); }
                }}>Choose folder…</button>
              </>
            )}
            {onboarding.step === 2 && (
              <>
                <div className="mini-title">Appearance</div>
                <p className="mini-copy">Theme, accent, and your bot's look. Everything is changeable later in Settings.</p>
                <div className="onboarding-field" data-surface="onboarding-theme">
                  <span className="onboarding-field-label">Theme</span>
                  <div className="chip-row" role="radiogroup" aria-label="Theme">
                    {THEMES.map((t) => (
                      <button type="button" key={t} role="radio" aria-checked={onboarding.theme === t}
                        className={`chip${onboarding.theme === t ? ' on' : ''}`}
                        onClick={() => { setOnboarding((o) => ({ ...o, theme: t })); window.quansioxUI?.applyTheme?.(t); }}>
                        {t === 'system' ? 'Match System' : t === 'light' ? 'Light' : 'Dark'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="onboarding-field" data-surface="onboarding-accent">
                  <span className="onboarding-field-label">Accent</span>
                  <div className="chip-row" role="radiogroup" aria-label="Accent">
                    {ACCENTS.map((a) => (
                      <button type="button" key={a.id} role="radio" aria-checked={onboarding.accent === a.id}
                        className={`chip accent-chip${onboarding.accent === a.id ? ' on' : ''}`} data-accent-choice={a.id}
                        onClick={() => {
                          setOnboarding((o) => ({ ...o, accent: a.id }));
                          document.documentElement.dataset.accent = a.id;
                        }}>
                        <span className="accent-dot" /> {a.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="onboarding-field" data-surface="onboarding-bot">
                  <span className="onboarding-field-label">Your bot</span>
                  <div className="chip-row" role="radiogroup" aria-label="Bot color">
                    {BOT_COLORS.map((c) => (
                      <button type="button" key={c.id} role="radio" aria-checked={onboarding.botColor === c.id}
                        className={`chip${onboarding.botColor === c.id ? ' on' : ''}`} data-surface="onboarding-bot-color"
                        onClick={() => setOnboarding((o) => ({ ...o, botColor: c.id }))}>{c.label}</button>
                    ))}
                  </div>
                  <div className="chip-row" role="radiogroup" aria-label="Character shape" data-surface="onboarding-shapes">
                    {SHAPES.map((s) => (
                      <button type="button" key={s} role="radio" aria-checked={onboarding.botShape === s}
                        className={`chip shape-chip${onboarding.botShape === s ? ' on' : ''}`} data-shape={s}
                        onClick={() => setOnboarding((o) => ({ ...o, botShape: s }))}>
                        <span className={`bot-shape s-${s}`} aria-hidden="true" /> {s}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            {onboarding.step === 3 && (
              <>
                <div className="mini-title">Language & model</div>
                <p className="mini-copy">The interface language and the model your bot talks to.</p>
                <div className="onboarding-field" data-surface="onboarding-language">
                  <span className="onboarding-field-label">Language</span>
                  <div className="chip-row" role="radiogroup" aria-label="Language">
                    {LANGUAGES.map((l) => (
                      <button type="button" key={l.id} role="radio" aria-checked={onboarding.language === l.id}
                        className={`chip${onboarding.language === l.id ? ' on' : ''}`}
                        onClick={() => setOnboarding((o) => ({ ...o, language: l.id }))}>{l.label}</button>
                    ))}
                  </div>
                </div>
                <div className="onboarding-field">
                  <span className="onboarding-field-label">Model</span>
                  <input className="mini-input" aria-label="Model" placeholder={settings?.model || 'e.g. gpt-4o-mini'}
                    value={onboarding.model} maxLength={120}
                    onChange={(e) => setOnboarding((o) => ({ ...o, model: e.target.value }))} />
                </div>
                <p className="onboarding-next">Later: import passwords/CSV in Settings → Integrations, and give your bot memory in Settings → Memory.</p>
              </>
            )}
            {onboarding.step === 4 && (
              <>
                <div className="mini-title">Create your first bot</div>
                <p className="mini-copy">Give it a name and an optional role. This becomes the conversation profile.</p>
                <input className="mini-input" autoFocus aria-label="Bot name" placeholder="e.g. Release manager"
                  value={onboarding.name} maxLength={80}
                  onChange={(e) => setOnboarding((o) => ({ ...o, name: e.target.value }))} />
                <input className="mini-input" aria-label="Bot label" placeholder="Label (optional, e.g. CI/CD)"
                  value={onboarding.label} maxLength={60}
                  onChange={(e) => setOnboarding((o) => ({ ...o, label: e.target.value }))} />
                <textarea className="mini-input" aria-label="Bot description" rows={2} placeholder="What should this bot do? (optional)"
                  value={onboarding.description} maxLength={400}
                  onChange={(e) => setOnboarding((o) => ({ ...o, description: e.target.value }))} />
              </>
            )}
            <div className="mini-actions onboarding-actions">
              <button type="button" className="mini-btn" onClick={async () => {
                await api.settings.save({ onboardingSeen: true }).catch(() => {});
                setOnboarding(null);
              }}>Skip</button>
              {onboarding.step > 0 && (
                <button type="button" className="mini-btn" onClick={() => setOnboarding((o) => ({ ...o, step: prevStep(o.step) }))}>Back</button>
              )}
              {onboarding.step < 4 ? (
                <button type="button" className="mini-btn primary" onClick={() => setOnboarding((o) => ({ ...o, step: nextStep(o.step) }))}>Continue</button>
              ) : (
                <button type="button" className="mini-btn primary" disabled={!validate(onboarding).canFinish} onClick={async () => {
                  try {
                    window.quansioxUI?.applyTheme?.(onboarding.theme);
                    document.documentElement.dataset.accent = onboarding.accent;
                    await api.settings.save(completionPatch(onboarding));
                    const bot = botPatch(onboarding);
                    if (Object.keys(bot).length) await api.sessions.update({ id: agent.sessionId, ...bot });
                    setOnboarding(null);
                    refresh();
                    refreshSidebar();
                    toast('You are ready — send your first task below', 'ok');
                  } catch (error) { toast(error.message, 'err'); }
                }}>Create bot</button>
              )}
            </div>
          </div>
        </div>
      )}

      {threadOpen && (
        <ThreadPane sessionId={agent.sessionId} messageId={threadOpen} onClose={() => setThreadOpen(null)} />
      )}

      {templateDraft && (
        <div className="mini-overlay" onClick={() => setTemplateDraft(null)}>
          <form className="mini-dialog" data-surface="template-dialog" onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const t = await api.templates.publish({
                  sessionId: agent.sessionId,
                  name: templateDraft.name.trim() || activeSession?.title || 'Bot template',
                  description: templateDraft.description.trim(),
                  prompt: templateDraft.prompt.trim(),
                  visibility: templateDraft.visibility,
                });
                setTemplateDraft(null);
                refreshTemplates();
                toast(`Saved template ${t.name}`, 'ok');
              } catch (error) { toast(error.message, 'err'); }
            }}>
            <div className="mini-title">Save bot as template</div>
            <input className="mini-input" autoFocus aria-label="Template name" placeholder="Template name"
              value={templateDraft.name} maxLength={120}
              onChange={(e) => setTemplateDraft((d) => ({ ...d, name: e.target.value }))} />
            <textarea className="mini-input" aria-label="Template description" placeholder="Description" rows={2}
              value={templateDraft.description} maxLength={600}
              onChange={(e) => setTemplateDraft((d) => ({ ...d, description: e.target.value }))} />
            <textarea className="mini-input" aria-label="Starter prompt" placeholder="Starter prompt (optional)" rows={3}
              value={templateDraft.prompt} maxLength={4000}
              onChange={(e) => setTemplateDraft((d) => ({ ...d, prompt: e.target.value }))} />
            <label className="template-visibility-field">Visibility
              <select value={templateDraft.visibility} onChange={(e) => setTemplateDraft((d) => ({ ...d, visibility: e.target.value }))}>
                <option value="private">Private (local only)</option>
                <option value="shared">Shared (exportable)</option>
              </select>
            </label>
            <div className="mini-actions">
              <button type="button" className="mini-btn" onClick={() => setTemplateDraft(null)}>Cancel</button>
              <button type="submit" className="mini-btn primary">Save template</button>
            </div>
          </form>
        </div>
      )}

      {groupDraft && (
        <div className="mini-overlay" onClick={() => setGroupDraft(null)}>
          <form className="mini-dialog group-dialog" data-surface="group-dialog" onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              const selected = groupDraft.selected.filter(Boolean);
              if (selected.length < 2) { toast('Pick at least two bots', 'err'); return; }
              try {
                const group = await api.groups.create({ name: groupDraft.name.trim() || 'Group chat', memberIds: selected });
                setGroupDraft(null);
                refresh();
                switchRef.current(group.id);
                toast('Group chat created', 'ok');
              } catch (error) { toast(error.message ?? String(error), 'err'); }
            }}>
            <div className="mini-title">New group chat</div>
            <input className="mini-input" autoFocus aria-label="Group name" placeholder="Group name"
              value={groupDraft.name} maxLength={80}
              onChange={(e) => setGroupDraft((g) => ({ ...g, name: e.target.value }))} />
            <div className="group-members">
              {sessions.filter((session) => session.kind !== 'group').map((session) => {
                const checked = groupDraft.selected.includes(session.id);
                return (
                  <label key={session.id} className="group-member">
                    <input type="checkbox" checked={checked} onChange={() => setGroupDraft((g) => ({
                      ...g,
                      selected: checked ? g.selected.filter((id) => id !== session.id)
                        : (g.selected.length >= 6 ? g.selected : [...g.selected, session.id]),
                    }))} />
                    <span className="ellipsis">{session.title || session.id}</span>
                  </label>
                );
              })}
              {!sessions.filter((session) => session.kind !== 'group').length && <span className="group-empty">Create a few sessions first.</span>}
            </div>
            <div className="mini-actions">
              <button type="button" className="mini-btn" onClick={() => setGroupDraft(null)}>Cancel</button>
              <button type="submit" className="mini-btn primary">Create group</button>
            </div>
          </form>
        </div>
      )}

      {resetConfirm && (
        <div className="mini-overlay" onClick={() => setResetConfirm(false)}>
          <form className="mini-dialog" data-surface="computer-reset-confirm" onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              setResetConfirm(false);
              try {
                const report = await api.desktop.reset({ sessionId: agent.sessionId });
                toast(report?.removed?.length ? 'Computer reset — sandbox files removed' : 'Computer reset — nothing was live', 'ok');
              } catch (error) {
                toast(error?.message ?? String(error), 'err');
              }
            }}>
            <div className="mini-title">Reset this session&apos;s computer?</div>
            <p className="mini-copy">
              The sandbox filesystem for this session is removed and any live guest desktop or sandbox stops.
              The next run boots a fresh computer. Files outside <code>.quansiox/sandboxes</code> are untouched.
            </p>
            <div className="mini-actions">
              <button type="button" className="mini-btn" onClick={() => setResetConfirm(false)}>Cancel</button>
              <button type="submit" className="mini-btn primary">Reset computer</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function NoticeStack() {
  // Troubleshooting notices with copyable request IDs (docs: "request-ID
  // surface for errors"). Fed by system:onNotice broadcasts + initial fetch.
  const [notices, setNotices] = useState([]);
  useEffect(() => {
    let alive = true;
    api.system.notices().then((list) => { if (alive) setNotices(Array.isArray(list) ? list.slice(-6) : []); }).catch(() => {});
    const off = events.on('system', 'onNotice', (entry) => {
      if (!entry?.id) return;
      setNotices((prev) => [...prev.filter((n) => n.id !== entry.id), entry].slice(-6));
    });
    return () => { alive = false; off(); };
  }, []);
  if (!notices.length) return null;
  const dismiss = (id) => {
    api.system.dismissNotice({ id }).catch(() => {});
    setNotices((prev) => prev.filter((n) => n.id !== id));
  };
  const copyId = (id) => {
    navigator.clipboard?.writeText(id).then(() => toast('request ID copied', 'ok')).catch(() => {});
  };
  return (
    <div className="notice-stack" data-surface="notice-stack">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice-${n.kind ?? 'error'}`}>
          <div className="notice-body">
            <strong>{n.title}</strong>
            {n.body ? <span className="notice-text">{n.body}</span> : null}
            <button type="button" className="notice-id" title="Copy request ID for support"
              onClick={() => copyId(n.requestId)}>{n.requestId}</button>
          </div>
          <div className="notice-actions">
            <button type="button" className="notice-btn" title="Copy request ID" onClick={() => copyId(n.requestId)}>Copy ID</button>
            <button type="button" className="notice-btn" title="Dismiss" onClick={() => dismiss(n.id)}><Icon.X /></button>
          </div>
        </div>
      ))}
      <button type="button" className="notice-clear"
        onClick={() => { api.system.clearNotices().catch(() => {}); setNotices([]); }}>Clear all</button>
    </div>
  );
}

function ThreadPane({ sessionId, messageId, onClose }) {
  const [thread, setThread] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api.sessions.thread({ id: sessionId, messageId })
      .then((data) => { if (alive) setThread(data); })
      .catch((failure) => { if (alive) setError(failure.message); });
    return () => { alive = false; };
  }, [sessionId, messageId]);
  return (
    <div className="thread-backdrop" onClick={onClose}>
      <section className="thread-pane" role="dialog" aria-modal="true" aria-label="Thread" onClick={(event) => event.stopPropagation()}>
        <header>
          <strong>Thread {thread ? `· ${thread.count} ${thread.count === 1 ? 'reply' : 'replies'}` : ''}</strong>
          <button className="ibtn" aria-label="Close thread" onClick={onClose}><Icon.X /></button>
        </header>
        {error && <p role="alert" className="task-error">{error}</p>}
        {!thread && !error && <p className="thread-empty">Loading thread…</p>}
        {thread?.turns?.map((turn, index) => (
          <article key={turn.id || index} className={`thread-turn ${turn.role}${turn.threadRoot ? ' root' : ''}`}>
            <div className="thread-turn-head">
              <span>{turn.role === 'user' ? 'You' : (turn.author || 'Quansiox')}</span>
              {turn.threadRoot && <span className="thread-root-tag">root</span>}
            </div>
            <div className="thread-turn-text">{Array.isArray(turn.content) ? turn.content.map((p) => p.text ?? '').join('\n') : String(turn.content ?? '')}</div>
          </article>
        ))}
        {thread && !thread.turns.length && <p className="thread-empty">No replies yet.</p>}
      </section>
    </div>
  );
}

function InteractionCards() {
  // Agent→user request cards (docs: form cards + secret-request cards). The
  // agent fork queues a persisted form; we poll the pending surface and render
  // one card above the composer. Values are sent once and never echoed.
  const [cards, setCards] = useState([]);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const card = cards[cards.length - 1] ?? null;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const pending = await api.interactions.pending();
        if (alive) setCards(Array.isArray(pending?.forms) ? pending.forms : []);
      } catch { /* main not ready yet — next poll */ }
    };
    load();
    const timer = setInterval(load, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!card) return;
    setValues(Object.fromEntries((card.fields || []).map((f) => [f.name, ''])));
    setError('');
  }, [card?.id]);

  if (!card) return null;
  const secret = (card.fields || []).some((f) => f.type === 'password');
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const missing = (card.fields || []).filter((f) => f.required && !String(values[f.name] ?? '').trim());
      if (missing.length) throw new Error(`Required: ${missing.map((f) => f.label || f.name).join(', ')}`);
      await api.interactions.submitForm({ entryId: card.id, values });
      setCards((prev) => prev.filter((c) => c.id !== card.id));
      toast(secret ? 'Secret saved' : 'Answer submitted', 'ok');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const dismiss = async () => {
    setBusy(true);
    try { await api.interactions.dismissForm({ entryId: card.id, mode: 'dismissed' }); }
    catch { /* already resolved */ }
    setCards((prev) => prev.filter((c) => c.id !== card.id));
    setBusy(false);
  };
  return (
    <form className={`interaction-card${secret ? ' secret' : ''}`} data-surface="interaction-card"
      onSubmit={submit} aria-label={card.title}>
      <header>
        <strong>{card.title || 'Input requested'}</strong>
        <span className="interaction-kind">{secret ? 'secret request' : 'input requested'}</span>
        <button type="button" className="ibtn" aria-label="Dismiss" onClick={dismiss} disabled={busy}><Icon.X /></button>
      </header>
      {error && <p role="alert" className="task-error">{error}</p>}
      {(card.fields || []).map((field) => (
        <label key={field.name} className="interaction-field">
          <span>{field.label || field.name}{field.required ? ' *' : ''}</span>
          {Array.isArray(field.options) && field.options.length ? (
            <select value={values[field.name] ?? ''} disabled={busy}
              onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))}>
              <option value="">Choose…</option>
              {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : (
            <input type={field.type === 'password' ? 'password' : (field.type || 'text')}
              value={values[field.name] ?? ''} placeholder={field.placeholder || ''} disabled={busy}
              autoComplete={field.type === 'password' ? 'off' : 'on'}
              onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))} />
          )}
        </label>
      ))}
      <footer>
        <button type="button" className="btn btn-secondary" onClick={dismiss} disabled={busy}>Dismiss</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : (secret ? 'Save secret' : 'Submit')}</button>
      </footer>
    </form>
  );
}

function relTimeUpdated(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(Number(ts)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

createRoot(document.getElementById('root')).render(
  /^playback=([a-zA-Z0-9_-]+)$/.test(decodeURIComponent(location.hash.slice(1)))
    ? <Playback sessionId={/^playback=([a-zA-Z0-9_-]+)$/.exec(decodeURIComponent(location.hash.slice(1)))[1]} />
    : <App />
);

/**
 * Mount the new surfaces into the settings dialog.
 *
 * The settings dialog is the one place in the app with room for a page, and
 * it already has a rail and a pane per section. The new surfaces (the
 * permission matrix, the vault, the plugin catalogue, the usage table, the
 * meetings and the canvas) are PAGE-shaped — in the 320px stage column they
 * were unreadable — so they belong here, beside the sections that were
 * always here.
 */
const SETTINGS_PANES = {
  permissions: () => <PermissionPanel onToast={toast} />,
  plugins: () => <PluginsPanel onToast={toast} />,
  vault: () => <VaultPanel onToast={toast} />,
  usage: () => <UsagePanel onToast={toast} />,
  meetings: () => (
    <div className="settings-surfaces">
      <MeetingPanel onToast={toast} />
      <VoiceCallPanel onToast={toast} />
    </div>
  ),
  canvas: () => <CanvasPanel onToast={toast} />,
  projects: () => <ProjectsPanel onToast={toast} />,
  slides: () => <SlidesPanel onToast={toast} />,
  design: () => <DesignPanel onToast={toast} />,
  websites: () => <WebsitePanel onToast={toast} />,
  collab: () => <CollabPanel onToast={toast} />,
  mail: () => <MailPanel onToast={toast} />,
};

for (const [name, render] of Object.entries(SETTINGS_PANES)) {
  const pane = document.querySelector(`[data-react-pane="${name}"]`);
  if (!pane) continue;
  try {
    createRoot(pane).render(render());
  } catch (error) {
    // A surface that fails to mount must not take the settings dialog with it.
    pane.textContent = `This section failed to load: ${String(error?.message ?? error).slice(0, 200)}`;
  }
}
