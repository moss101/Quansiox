'use strict';
/* Settings / templates / theme bridge — vanilla JS dialogs shared with the
 * React app via window.quansioxUI. Keeps the rich settings surface without
 * porting every form to React yet. */
const { api, events } = window.quansiox;
const $ = (s) => document.querySelector(s);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- build dialog markup ----
const ICON = {
  provider: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.9 12.1 20 3m-4.2 0H20v4.2"/></svg>',
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 13.8 8l4.5 1.8-4.5 1.7L12 16l-1.8-4.5L5.7 9.8 10.2 8Z"/><path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8Z"/></svg>',
  desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 21h6m-3-4v4"/></svg>',
  integrations: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5m6-5v5"/><path d="M6 8h12v2.5a6 6 0 0 1-6 6 6 6 0 0 1-6-6Z"/><path d="M12 16.5V21"/></svg>',
  security: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 5.8v5.4c0 4.3 2.9 7.6 7 9.8 4.1-2.2 7-5.5 7-9.8V5.8Z"/><path d="m9.2 11.8 2 2 3.6-4"/></svg>',
  general: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  updates: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
};
const dialog = $('#settings-dialog');
dialog.innerHTML = `
  <form method="dialog" id="settings-form">
    <div class="settings-shell">
      <div class="settings-rail">
        <div class="rail-title"><span class="logo">Q</span> Settings</div>
        <button type="button" class="rail-tab active" data-pane="provider">${ICON.provider} Provider</button>
        <button type="button" class="rail-tab" data-pane="general">${ICON.general} General</button>
        <button type="button" class="rail-tab" data-pane="agent">${ICON.agent} Agent</button>
        <button type="button" class="rail-tab" data-pane="desktop">${ICON.desktop} Desktop</button>
        <button type="button" class="rail-tab" data-pane="integrations">${ICON.integrations} Integrations</button>
        <button type="button" class="rail-tab" data-pane="updates">${ICON.updates} Updates</button>
        <button type="button" class="rail-tab" data-pane="security">${ICON.security} Security</button>
        <button type="button" class="rail-tab" data-pane="permissions">${ICON.security} Permissions</button>
        <button type="button" class="rail-tab" data-pane="plugins">${ICON.integrations} Plugins &amp; MCP</button>
        <button type="button" class="rail-tab" data-pane="vault">${ICON.security} Vault</button>
        <button type="button" class="rail-tab" data-pane="usage">${ICON.updates} Usage &amp; cost</button>
        <button type="button" class="rail-tab" data-pane="meetings">${ICON.agent} Meetings &amp; calls</button>
        <button type="button" class="rail-tab" data-pane="canvas">${ICON.general} Canvas</button>
        <button type="button" class="rail-tab" data-pane="projects">${ICON.general} Projects</button>
        <button type="button" class="rail-tab" data-pane="slides">${ICON.general} Slides</button>
        <button type="button" class="rail-tab" data-pane="design">${ICON.general} Design</button>
        <button type="button" class="rail-tab" data-pane="websites">${ICON.general} Websites</button>
        <button type="button" class="rail-tab" data-pane="collab">${ICON.agent} Collaboration</button>
        <button type="button" class="rail-tab" data-pane="mail">${ICON.integrations} Mail</button>
      </div>
      <div class="settings-main">
        <div class="settings-body">
          <div class="settings-pane active" data-pane="provider">
            <div class="settings-section">
              <h4>Connection</h4>
              <label>Provider preset
                <select name="preset" id="set-preset">
                  <option value="">— custom —</option>
                  <option value="https://api.openai.com/v1">OpenAI</option>
                  <option value="https://api.x.ai/v1">xAI (Grok)</option>
                  <option value="https://openrouter.ai/api/v1">OpenRouter</option>
                  <option value="http://localhost:11434/v1">Ollama (local)</option>
                  <option value="http://localhost:1234/v1">LM Studio (local)</option>
                </select>
              </label>
              <label>Protocol
                <select name="provider" id="set-provider">
                  <option value="">Auto-detect from URL</option>
                  <option value="openai-chat">OpenAI chat completions</option>
                  <option value="openai-responses">OpenAI Responses API</option>
                  <option value="anthropic">Anthropic Messages</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="ollama">Ollama (local)</option>
                  <option value="lmstudio">LM Studio (local)</option>
                </select>
              </label>
              <label>Provider base URL
                <input name="baseUrl" id="set-baseUrl" class="mono" placeholder="https://api.openai.com/v1" required />
              </label>
              <label>API key <small>(stored locally, never leaves your machine except to the provider)</small>
                <input name="apiKey" id="set-apiKey" type="password" class="mono" placeholder="sk-…" />
              </label>
              <label>Model
                <input name="model" id="set-model" class="mono" list="model-list" placeholder="gpt-4o-mini" required />
                <datalist id="model-list"></datalist>
              </label>
              <label>Subagent model <small>(optional cheaper model for delegated tasks)</small>
                <input name="subagentModel" id="set-subagent-model" class="mono" list="model-list" placeholder="same as main model" />
              </label>
              <div class="test-row">
                <button type="button" id="btn-test-conn" class="btn btn-secondary btn-mini">Test connection</button>
                <span id="test-result" class="mono"></span>
              </div>
            </div>
          </div>
          <div class="settings-pane" data-pane="general">
            <div class="settings-section">
              <h4>Appearance</h4>
              <label>Theme
                <select name="theme" id="set-theme">
                  <option value="system">Match system</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label>Language <small>(applies to dates and numbers; the interface ships in English)</small>
                <select name="language" id="set-language">
                  <option value="en">English</option>
                  <option value="zh-CN">中文 (简体)</option>
                  <option value="ja">日本語</option>
                  <option value="es">Español</option>
                  <option value="fr">Français</option>
                  <option value="de">Deutsch</option>
                  <option value="ko">한국어</option>
                  <option value="pt-BR">Português (Brasil)</option>
                </select>
              </label>
              <label>Timezone
                <select name="timezone" id="set-timezone">
                  <option value="auto">Auto (system)</option>
                </select>
              </label>
            </div>
            <div class="settings-section">
              <div class="mcp-head"><span>Usage</span>
                <button type="button" id="btn-usage-refresh" class="btn btn-secondary btn-mini">Refresh</button></div>
              <div id="usage-summary" class="mono"></div>
            </div>
            <div class="settings-section">
              <h4>Feedback</h4>
              <p class="mini-copy">Saved to your local Quansiox data folder; never uploaded.</p>
              <label>What's working, or what's missing?
                <textarea id="feedback-text" rows="3" placeholder="Tell us what to improve…"></textarea>
              </label>
              <div class="test-row">
                <button type="button" id="btn-feedback-send" class="btn btn-secondary btn-mini">Save feedback</button>
                <span id="feedback-result" class="mono"></span>
              </div>
            </div>
          </div>
          <div class="settings-pane" data-pane="agent">
            <div class="settings-section">
              <h4>Behavior</h4>
              <label>Max agent steps
                <input name="maxSteps" id="set-maxSteps" type="number" min="1" max="100" />
              </label>
              <label>Custom instructions
                <textarea name="systemPromptExtra" id="set-sysprompt" rows="3" placeholder="Appended to the agent's system prompt"></textarea>
              </label>
              <label>Sandbox mode
                <select name="sandboxMode" id="set-sandboxmode">
                  <option value="sandboxed">Process + seatbelt (fast)</option>
                  <option value="vm">Linux VM — kernel isolation (slow boot)</option>
                  <option value="off">Off — raw host tools</option>
                </select>
              </label>
              <label>Automatic team planning
                <select name="autoTeam" id="set-autoteam">
                  <option value="regex">Heuristic — split obvious multi-part requests</option>
                  <option value="model">Model-directed — let the model decompose the task</option>
                  <option value="off">Off — one agent does everything</option>
                </select>
              </label>
              <label class="checkbox-row">
                <input type="checkbox" name="worktreeIsolation" id="set-worktree" />
                Give isolated subagents their own git worktree (host mode)
              </label>
              <label class="checkbox-row">
                <input type="checkbox" name="notifyOnDone" id="set-notify" /> Notify me when a task finishes
              </label>
              <label class="checkbox-row">
                <input type="checkbox" name="chromeCookieImport" id="set-chrome-cookies" />
                Allow importing cookies from Chrome/Edge/Brave (per-site grants; Keychain prompt)
              </label>
            </div>
            <div class="settings-section cu-section">
              <div class="mcp-head"><span>Computer use</span>
                <button type="button" id="btn-cu-perms" class="btn btn-secondary btn-mini">Check permissions</button></div>
              <label class="checkbox-row">
                <input type="checkbox" name="allowComputerUse" id="set-cu" />
                Allow the agent to control this Mac (screenshot, click, type) — requires Accessibility + Screen Recording
              </label>
              <label class="checkbox-row">
                <input type="checkbox" name="allowBrowser" id="set-browser" />
                Allow the agent to use the browser inside this session's computer
              </label>
              <div class="mono" id="cu-status"></div>
            </div>
          </div>
          <div class="settings-pane" data-pane="desktop">
            <div class="settings-section">
              <h4>Window</h4>
              <label>Global shortcut <small>(e.g. CommandOrControl+Shift+K)</small>
                <input name="globalShortcut" id="set-shortcut" class="mono" />
              </label>
            </div>
          </div>
          <div class="settings-pane" data-pane="integrations">
            <div class="settings-section">
              <div class="mcp-head"><span>Provider profiles</span>
                <button type="button" id="btn-profile-save" class="btn btn-secondary btn-mini">Save current</button></div>
              <div id="profile-list"></div>
            </div>
            <div class="settings-section">
              <div class="mcp-head"><span>MCP tool servers</span>
                <button type="button" id="btn-mcp-add" class="btn btn-secondary btn-mini">+ Add</button></div>
              <div id="mcp-list"></div>
              <div class="mono" id="mcp-status"></div>
            </div>
          </div>
          <div class="settings-pane" data-pane="permissions" data-react-pane="permissions"></div>
          <div class="settings-pane" data-pane="plugins" data-react-pane="plugins"></div>
          <div class="settings-pane" data-pane="vault" data-react-pane="vault"></div>
          <div class="settings-pane" data-pane="usage" data-react-pane="usage"></div>
          <div class="settings-pane" data-pane="meetings" data-react-pane="meetings"></div>
          <div class="settings-pane" data-pane="canvas" data-react-pane="canvas"></div>
          <div class="settings-pane" data-pane="projects" data-react-pane="projects"></div>
          <div class="settings-pane" data-pane="slides" data-react-pane="slides"></div>
          <div class="settings-pane" data-pane="design" data-react-pane="design"></div>
          <div class="settings-pane" data-pane="websites" data-react-pane="websites"></div>
          <div class="settings-pane" data-pane="collab" data-react-pane="collab"></div>
          <div class="settings-pane" data-pane="mail" data-react-pane="mail"></div>
          <div class="settings-pane" data-pane="updates">
            <div class="settings-section">
              <h4>Updates</h4>
              <label>Current version
                <output id="upd-version" class="mono">…</output>
              </label>
              <label>Update feed URL
                <input name="updateFeedUrl" id="set-feed" class="mono" placeholder="https://…/latest.json" />
              </label>
              <div class="test-row update-slot">
                <button type="button" id="btn-check-update" class="btn btn-secondary btn-mini">Check for updates</button>
                <button type="button" id="btn-install-update" class="btn btn-primary btn-mini" hidden>Download & restart</button>
                <span id="update-result" class="mono"></span>
              </div>
            </div>
            <div class="settings-section">
              <h4>Troubleshooting</h4>
              <p class="mini-copy">Create a local, redacted diagnostics zip (no transcripts, secrets, or cookies) and reveal it in Finder.</p>
              <div class="test-row">
                <button type="button" id="btn-support-bundle" class="btn btn-secondary btn-mini">Create support bundle</button>
                <span id="support-result" class="mono"></span>
              </div>
            </div>
            <div class="settings-section">
              <div class="mcp-head"><span>Diagnostics</span>
                <button type="button" id="btn-diag-refresh" class="btn btn-secondary btn-mini">Refresh</button></div>
              <div id="diag-summary" class="mono"></div>
              <div class="test-row">
                <button type="button" id="btn-diag-clear" class="btn btn-secondary btn-mini">Clear log</button>
                <span id="diag-result" class="mono"></span>
              </div>
            </div>
          </div>
          <div class="settings-pane" data-pane="security">
            <div class="settings-section">
              <h4>Approvals</h4>
              <label class="checkbox-row">
                <input type="checkbox" name="requireApproval" id="set-approval" />
                Ask before gated tools (shell, file writes, computer control, sending)
              </label>
            </div>
            <div class="settings-section">
              <h4>Auto-review rules</h4>
              <label class="checkbox-row">
                <input type="checkbox" id="set-ar-enabled" />
                Let rules auto-approve or block gated tool calls before prompting me
              </label>
              <label>Allow without asking <small>(one rule per line — plain text matches anywhere, /regex/ supported)</small>
                <textarea id="set-ar-allow" rows="3" placeholder="npm test&#10;/^git (status|log|diff)/"></textarea>
              </label>
              <label>Always block <small>(block wins over allow)</small>
                <textarea id="set-ar-block" rows="3" placeholder="rm -rf"></textarea>
              </label>
              <div class="mono" id="ar-status"></div>
            </div>
            <div class="settings-section">
              <div class="mcp-head"><span>Standing permissions</span>
                <button type="button" id="btn-perm-refresh" class="btn btn-secondary btn-mini">Refresh</button></div>
              <div id="perm-list"></div>
              <div class="mono" id="perm-status"></div>
            </div>
            <div class="settings-section">
              <div class="mcp-head"><span>Box secrets</span>
                <button type="button" id="btn-box-secrets-refresh" class="btn btn-secondary btn-mini">Refresh</button></div>
              <p class="mini-copy">Secrets provisioned to the agent's box, stored encrypted. Only names are shown.</p>
              <div id="box-secret-list"></div>
              <div class="test-row">
                <input id="box-secret-name" class="mono" placeholder="name" style="max-width:140px" />
                <input id="box-secret-value" class="mono" type="password" placeholder="value" style="max-width:180px" />
                <button type="button" id="btn-box-secret-add" class="btn btn-secondary btn-mini">Add</button>
                <span id="box-secret-result" class="mono"></span>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-foot">
          <button type="button" id="btn-settings-cancel" class="btn btn-secondary">Cancel</button>
          <button type="submit" value="save" class="btn btn-primary">Save</button>
        </div>
      </div>
    </div>
  </form>`;

const promptsDialog = document.createElement('dialog');
promptsDialog.id = 'prompts-dialog';
promptsDialog.innerHTML = `
  <h2>Prompt library</h2>
  <div id="prompt-list"></div>
  <div class="dialog-actions">
    <button value="close" class="btn btn-secondary" id="btn-prompts-close">Close</button>
  </div>`;
document.body.appendChild(promptsDialog);

// settings rail tabs
/**
 * Show one pane.
 *
 * The pane is reflected in the URL hash (`#settings/permissions`), so a
 * settings page can be linked to, bookmarked and survive a reload — the
 * routed-settings requirement.
 */
function showSettingsPane(name) {
  const wanted = String(name ?? '');
  const tab = document.querySelector(`.rail-tab[data-pane="${wanted}"]`);
  const panes = document.querySelectorAll('.settings-pane');
  let found = false;
  document.querySelectorAll('.rail-tab').forEach((t) => {
    const active = t === tab;
    t.classList.toggle('active', active);
    if (active) found = true;
  });
  panes.forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === wanted));
  // The rail scrolls on short windows; keep the selected page visible.
  if (tab) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return found;
}

for (const tab of document.querySelectorAll('.rail-tab')) {
  tab.addEventListener('click', () => {
    showSettingsPane(tab.dataset.pane);
    try {
      history.replaceState(null, '', `#settings/${tab.dataset.pane}`);
    } catch { /* the hash is a convenience, not a requirement */ }
  });
}

// A deep link opens the dialog on the named pane.
function paneFromHash() {
  const match = String(location.hash || '').match(/^#settings\/([a-z-]+)/);
  return match?.[1] ?? null;
}

// ---- theme ----
function resolvedTheme(theme) {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme) {
  const mode = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
  const resolved = resolvedTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document.body.dataset.theme = resolved;
  const btn = $('#btn-theme');
  if (btn) btn.textContent = resolved === 'light' ? '☀' : '☾';
  localStorage.setItem('quansiox-theme', mode);
}
// Grok parity: follow the system appearance on first run; the toggle persists.
applyTheme(localStorage.getItem('quansiox-theme') ?? 'system');
// Live-follow the system appearance while "Match system" is selected.
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (localStorage.getItem('quansiox-theme') === 'system') applyTheme('system');
});
$('#btn-theme').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
$('#btn-settings').addEventListener('click', () => window.quansioxUI.openSettings());

// ---- privacy mode (P4.4) ----
// Local enforcement, enforced at the coordinator run gate: while on, no
// provider run leaves the machine (local Ollama/LM Studio keep working).
// The button is the always-visible indicator — shield + active state.
const btnPrivacy = $('#btn-privacy');
function paintPrivacy(enabled) {
  btnPrivacy?.classList.toggle('active', enabled === true);
  btnPrivacy?.setAttribute('aria-pressed', enabled === true ? 'true' : 'false');
}
api.privacy?.get?.().then((r) => paintPrivacy(r?.enabled === true)).catch(() => {});
btnPrivacy?.addEventListener('click', async () => {
  try {
    const current = await api.privacy.get();
    const next = await api.privacy.set({ enabled: !(current?.enabled === true) });
    paintPrivacy(next?.enabled === true);
  } catch { /* namespace not ready */ }
});

// ---- language ----
function applyLanguage(lang) {
  // i18n (P2.1): system preference resolves through Grok's language-family
  // mapping (yue→zh-TW, iw→he, …); RTL locales set the document direction.
  // The resolver rides the preload bridge (classic scripts cannot require).
  const i18n = window.quansiox?.i18n;
  if (!i18n) { document.documentElement.lang = String(lang || 'en'); return; }
  const wanted = lang === 'system' || !lang
    ? i18n.resolvePreference(navigator.languages ?? [navigator.language])
    : (i18n.isLocale(lang) ? lang : i18n.resolvePreference([lang]));
  document.documentElement.lang = wanted;
  document.documentElement.dir = i18n.directionOf(wanted);
}
api.settings.get().then((s) => applyLanguage(s.language)).catch(() => {});

// ---- settings open/save ----
function renderMcpRow(server = { name: '', command: '' }) {
  const row = document.createElement('div');
  row.className = 'mcp-row';
  row.innerHTML = `
    <input class="mcp-name mono" placeholder="name" value="${escapeHtml(server.name ?? '')}" />
    <input class="mcp-command mono" placeholder="command" value="${escapeHtml(server.command ?? '')}" />
    <button type="button" class="mcp-remove">✕</button>`;
  row.querySelector('.mcp-remove').addEventListener('click', () => row.remove());
  return row;
}

async function renderProfiles() {
  const list = $('#profile-list');
  if (!list) return;
  list.innerHTML = '';
  let profiles = [];
  try { profiles = await api.profiles.list(); } catch { return; }
  if (!profiles.length) {
    list.innerHTML = '<div class="git-empty">no profiles — “Save current”</div>';
    return;
  }
  for (const p of profiles) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    row.innerHTML = `<span class="ellipsis">${escapeHtml(p.name)} <small class="mono">${escapeHtml(p.model)}</small>${p.active ? ' <b>●</b>' : ''}</span>
      <span><button data-act="a">Use</button><button data-act="d">✕</button></span>`;
    row.addEventListener('click', async (e) => {
      const act = e.target.dataset?.act;
      if (act === 'a') { await api.profiles.activate({ id: p.id }); openSettings(); }
      if (act === 'd') { await api.profiles.remove({ id: p.id }); renderProfiles(); }
    });
    list.appendChild(row);
  }
}

async function renderPermissions() {
  const list = $('#perm-list');
  if (!list) return;
  list.innerHTML = '';
  let grants = [];
  try { grants = await api.consent.list({}); } catch { return; }
  if (!grants.length) {
    list.innerHTML = '<div class="git-empty">no standing permissions — “Always allow” in an approval prompt creates one</div>';
    return;
  }
  for (const g of grants) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    row.innerHTML = `<span class="ellipsis mono">${escapeHtml(g.subject)} <small>${g.mode === 'deny' ? '· blocked' : '· allowed'} · ${g.scope === '*' ? 'all sessions' : escapeHtml(g.scope)}</small></span>
      <span><button data-act="r" title="Revoke">✕</button></span>`;
    row.addEventListener('click', async (e) => {
      if (e.target.dataset?.act !== 'r') return;
      try {
        await api.consent.revoke({ scope: g.scope, subject: g.subject });
        $('#perm-status').textContent = `revoked ${g.subject}`;
        renderPermissions();
      } catch (error) {
        $('#perm-status').textContent = `✗ ${error.message || error}`;
      }
    });
    list.appendChild(row);
  }
}

async function renderDiagnostics() {
  const el = $('#diag-summary');
  if (!el) return;
  el.textContent = 'loading…';
  try {
    const [summary, events] = await Promise.all([
      api.diagnostics.summary(),
      api.diagnostics.list({ limit: 5 }),
    ]);
    const kinds = Object.entries(summary.byKind ?? {})
      .map(([k, n]) => `${k}:${n}`).join(' · ');
    el.textContent = `${summary.total ?? events.length} events${kinds ? ` (${kinds})` : ''}`;
    if (events.length) {
      const last = events[0];
      el.textContent += ` · last: ${last.kind} @ ${new Date(last.ms).toLocaleTimeString()}`;
    }
  } catch (error) {
    el.textContent = `✗ ${error.message || error}`;
  }
}

async function renderBoxSecrets() {
  const list = $('#box-secret-list');
  if (!list) return;
  list.innerHTML = '';
  let status = { names: [] };
  try { status = await api.boxSecrets.status(); } catch { return; }
  if (!status.names?.length) {
    list.innerHTML = '<div class="git-empty">no box secrets configured</div>';
    return;
  }
  for (const name of status.names) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    row.innerHTML = `<span class="ellipsis mono">${escapeHtml(name)}</span>
      <span><button data-act="r" title="Remove">✕</button></span>`;
    row.addEventListener('click', async (e) => {
      if (e.target.dataset?.act !== 'r') return;
      try {
        await api.boxSecrets.remove({ name });
        $('#box-secret-result').textContent = `removed ${name}`;
        renderBoxSecrets();
      } catch (error) {
        $('#box-secret-result').textContent = `✗ ${error.message || error}`;
      }
    });
    list.appendChild(row);
  }
}

// ---- General pane: timezone list, usage summary, auto-review rules ----
function populateTimezones() {
  const sel = $('#set-timezone');
  if (!sel || sel.options.length > 1) return;
  try {
    for (const tz of Intl.supportedValuesOf('timeZone')) {
      const opt = document.createElement('option');
      opt.value = tz;
      opt.textContent = tz;
      sel.appendChild(opt);
    }
  } catch { /* older engines: keep Auto only */ }
}

async function renderUsage() {
  const el = $('#usage-summary');
  if (!el) return;
  el.textContent = 'loading…';
  try {
    const u = await api.settings.usageSummary();
    const fmt = (n) => Number(n ?? 0).toLocaleString();
    const cost = u.costUsd == null
      ? 'unknown (no rates for the model)'
      : `$${u.costUsd > 0 && u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}`;
    el.textContent = `${u.sessions} conversations · ${fmt(u.turns)} messages · `
      + `${fmt(u.promptTokens)} prompt + ${fmt(u.completionTokens)} completion tokens · `
      + `${fmt(u.requests)} requests · est. ${cost}`;
  } catch (error) {
    el.textContent = `✗ ${error.message || error}`;
  }
}

async function loadAutoReview() {
  try {
    const r = await api.settings.autoReviewGet();
    const ins = r.instructions ?? {};
    $('#set-ar-enabled').checked = ins.isEnabled === true;
    $('#set-ar-allow').value = (ins.allowInstructions ?? []).join('\n');
    $('#set-ar-block').value = (ins.blockInstructions ?? []).join('\n');
  } catch { /* leave empty */ }
}

async function saveAutoReview() {
  const clean = (v) => String(v ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  await api.settings.autoReviewSet({
    instructions: {
      isEnabled: $('#set-ar-enabled').checked,
      allowInstructions: clean($('#set-ar-allow').value),
      blockInstructions: clean($('#set-ar-block').value),
    },
  });
}

async function openSettings(pane) {
  const s = await api.settings.get();
  $('#set-baseUrl').value = s.baseUrl;
  $('#set-model').value = s.model;
  const providerValue = s.provider || (s.apiStyle === 'responses' ? 'openai-responses' : '');
  if ([...$('#set-provider').options].some((o) => o.value === providerValue)) $('#set-provider').value = providerValue;
  $('#set-subagent-model').value = s.subagentModel || '';
  $('#set-maxSteps').value = s.maxSteps;
  $('#set-apiKey').value = '';
  $('#set-apiKey').placeholder = s.apiKey || 'sk-…';
  $('#set-preset').value = [...$('#set-preset').options].some((o) => o.value === s.baseUrl) ? s.baseUrl : '';
  $('#set-sysprompt').value = s.systemPromptExtra ?? '';
  $('#set-notify').checked = s.notifyOnDone !== false;
  $('#set-cu').checked = s.allowComputerUse === true;
  $('#set-browser').checked = s.allowBrowser !== false;
  $('#set-sandboxmode').value = ['sandboxed','vm','off'].includes(s.sandboxMode) ? s.sandboxMode : 'sandboxed';
  $('#set-autoteam').value = ['off','regex','model'].includes(s.autoTeam) ? s.autoTeam : 'regex';
  $('#set-worktree').checked = s.worktreeIsolation === true;
  $('#set-chrome-cookies').checked = s.chromeCookieImport === true;
  $('#cu-status').textContent = '';
  $('#set-shortcut').value = s.globalShortcut ?? '';
  $('#set-feed').value = s.updateFeedUrl ?? '';
  const mcpList = $('#mcp-list');
  mcpList.innerHTML = '';
  for (const server of s.mcpServers ?? []) mcpList.appendChild(renderMcpRow(server));
  $('#set-approval').checked = s.requireApproval === true;
  const storedTheme = localStorage.getItem('quansiox-theme');
  $('#set-theme').value = ['light', 'dark', 'system'].includes(storedTheme) ? storedTheme : 'system';
  $('#set-language').value = ['en', 'zh-CN', 'ja', 'es', 'fr', 'de', 'ko', 'pt-BR'].includes(s.language) ? s.language : 'en';
  populateTimezones();
  const tzKnown = s.timezone === 'auto' || [...$('#set-timezone').options].some((o) => o.value === s.timezone);
  $('#set-timezone').value = tzKnown ? (s.timezone ?? 'auto') : 'auto';
  renderUsage();
  $('#ar-status').textContent = '';
  loadAutoReview();
  api.updater.appVersion?.().then((v) => { $('#upd-version').textContent = String(v ?? '—'); })
    .catch(() => { $('#upd-version').textContent = '—'; });
  $('#perm-status').textContent = '';
  renderPermissions();
  $('#diag-result').textContent = '';
  renderDiagnostics();
  $('#box-secret-result').textContent = '';
  $('#box-secret-name').value = '';
  $('#box-secret-value').value = '';
  renderBoxSecrets();
  $('#feedback-result').textContent = '';
  $('#test-result').textContent = '';
  $('#update-result').textContent = '';
  renderProfiles();
  dialog.showModal();
  // Deep-link a pane: an explicit argument wins, otherwise the URL hash.
  const target = (typeof pane === 'string' && pane) || paneFromHash();
  if (target) {
    document.querySelector(`.rail-tab[data-pane="${target}"]`)?.click();
  }
}

function providerPartial(fd) {
  const provider = String(fd.get('provider') ?? '');
  const partial = {
    baseUrl: String(fd.get('baseUrl') ?? '').trim(),
    model: String(fd.get('model') ?? '').trim(),
    provider: provider === 'openai-responses' ? 'openai-responses' : provider,
    apiStyle: provider === 'openai-responses' ? 'responses' : 'chat',
    subagentModel: String(fd.get('subagentModel') ?? '').trim(),
    maxSteps: Number(fd.get('maxSteps')) || 24,
    systemPromptExtra: $('#set-sysprompt').value.trim(),
    notifyOnDone: $('#set-notify').checked,
    allowComputerUse: $('#set-cu').checked,
    allowBrowser: $('#set-browser').checked,
    sandboxMode: $('#set-sandboxmode').value,
    autoTeam: $('#set-autoteam').value,
    worktreeIsolation: $('#set-worktree').checked,
    chromeCookieImport: $('#set-chrome-cookies').checked,
    requireApproval: $('#set-approval').checked,
    language: $('#set-language').value,
    timezone: $('#set-timezone').value,
    globalShortcut: $('#set-shortcut').value.trim(),
    updateFeedUrl: $('#set-feed').value.trim(),
    mcpServers: [...document.querySelectorAll('#mcp-list .mcp-row')].map((row) => ({
      name: row.querySelector('.mcp-name').value.trim().replace(/[^a-zA-Z0-9_-]/g, ''),
      command: row.querySelector('.mcp-command').value.trim(),
      args: [],
    })).filter((x) => x.name && x.command),
  };
  const key = String(fd.get('apiKey') ?? '').trim();
  if (key && !key.includes('…')) partial.apiKey = key;
  return partial;
}

function notifySettingsSaved() {
  window.dispatchEvent(new CustomEvent('quansiox-settings'));
}

$('#btn-settings-cancel').addEventListener('click', () => dialog.close('cancel'));

// Save on the Save button and on Enter. Cancel is not a submit button, so
// Enter in the API key or model field no longer discards the form.
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const partial = providerPartial(new FormData($('#settings-form')));
  if (!partial.baseUrl || !partial.model) {
    $('#test-result').textContent = 'Provider URL and model are required';
    document.querySelector('.rail-tab[data-pane="provider"]')?.click();
    return;
  }
  try {
    applyTheme($('#set-theme').value);
    applyLanguage(partial.language);
    await api.settings.save(partial);
    try {
      await saveAutoReview();
      $('#ar-status').textContent = 'auto-review rules saved';
    } catch (error) {
      $('#ar-status').textContent = `✗ ${error.message || error}`;
      document.querySelector('.rail-tab[data-pane="security"]')?.click();
      return;
    }
    notifySettingsSaved();
    dialog.close('save');
  } catch (error) {
    $('#test-result').textContent = `✗ ${error.message || error}`;
    document.querySelector('.rail-tab[data-pane="provider"]')?.click();
  }
});
$('#set-preset').addEventListener('change', (e) => {
  if (e.target.value) $('#set-baseUrl').value = e.target.value;
});
$('#btn-mcp-add').addEventListener('click', () => $('#mcp-list').appendChild(renderMcpRow()));
$('#btn-perm-refresh').addEventListener('click', () => { renderPermissions(); });
$('#btn-usage-refresh').addEventListener('click', () => { renderUsage(); });
$('#btn-diag-refresh').addEventListener('click', () => { renderDiagnostics(); });
$('#btn-diag-clear').addEventListener('click', async () => {
  const el = $('#diag-result');
  try {
    await api.diagnostics.clear();
    el.textContent = 'cleared';
    renderDiagnostics();
  } catch (error) {
    el.textContent = `✗ ${error.message || error}`;
  }
});
$('#btn-box-secrets-refresh').addEventListener('click', () => { renderBoxSecrets(); });
$('#btn-box-secret-add').addEventListener('click', async () => {
  const el = $('#box-secret-result');
  const name = $('#box-secret-name').value.trim();
  const value = $('#box-secret-value').value;
  if (!name || !value) { el.textContent = 'name and value are required'; return; }
  try {
    await api.boxSecrets.set({ secrets: { [name]: value } });
    el.textContent = `saved ${name}`;
    $('#box-secret-name').value = '';
    $('#box-secret-value').value = '';
    renderBoxSecrets();
  } catch (error) {
    el.textContent = `✗ ${error.message || error}`;
  }
});
$('#btn-feedback-send').addEventListener('click', async () => {
  const el = $('#feedback-result');
  const message = $('#feedback-text').value.trim();
  if (!message) { el.textContent = 'write something first'; return; }
  try {
    const entry = await api.feedback.send({ message });
    $('#feedback-text').value = '';
    el.textContent = `saved (${entry.id.slice(0, 10)}…)`;
  } catch (error) {
    el.textContent = `✗ ${error.message || error}`;
  }
});
$('#btn-profile-save').addEventListener('click', async () => {
  const fd = new FormData($('#settings-form'));
  const partial = { baseUrl: String(fd.get('baseUrl') ?? '').trim(), model: String(fd.get('model') ?? '').trim() };
  const key = String(fd.get('apiKey') ?? '').trim();
  if (key && !key.includes('…')) partial.apiKey = key;
  await api.settings.save(partial);
  await api.profiles.saveCurrent({});
  notifySettingsSaved();
  renderProfiles();
});
$('#btn-test-conn').addEventListener('click', async () => {
  const el = $('#test-result');
  el.textContent = 'testing…';
  try {
    const key = $('#set-apiKey').value.trim();
    const result = await api.settings.test({ baseUrl: $('#set-baseUrl').value.trim(), apiKey: key && !key.includes('…') ? key : undefined, useSaved: !key || key.includes('…') });
    el.textContent = result.ok ? `✓ ${result.count} models` : `✗ ${result.error}`;
    if (result.ok) {
      const dl = $('#model-list');
      dl.innerHTML = '';
      for (const id of result.models.slice(0, 200)) {
        const o = document.createElement('option');
        o.value = id;
        dl.appendChild(o);
      }
    }
  } catch (e) { el.textContent = `✗ ${e.message}`; }
});
$('#btn-check-update').addEventListener('click', async () => {
  const el = $('#update-result');
  el.textContent = 'checking…';
  try {
    await api.settings.save({ updateFeedUrl: $('#set-feed').value.trim() });
    const r = await api.updater.check();
    el.textContent = !r.enabled ? 'checks disabled' : r.updateAvailable ? `update: ${r.current} → ${r.latest}` : `up to date (${r.current})`;
    $('#btn-install-update').hidden = !r.updateAvailable;
  } catch (e) { el.textContent = `✗ ${e.message}`; }
});

// Staged install: download -> prepare-restart handshake -> relaunch (Cue pattern).
$('#btn-install-update').addEventListener('click', async () => {
  const el = $('#update-result');
  const btn = $('#btn-install-update');
  btn.disabled = true;
  el.textContent = 'downloading…';
  try {
    const r = await api.updater.install({});
    if (r.ok && r.applied) el.textContent = `update ${r.version} staged — restarting…`;
    else el.textContent = r.ok ? `downloaded (${Math.round(r.bytes / 1e6)} MB) — ${r.note ?? 'manual install'}` : `✗ ${r.error}`;
  } catch (e) { el.textContent = `✗ ${e.message}`; }
  btn.disabled = false;
});

$('#btn-cu-perms').addEventListener('click', async () => {
  const el = $('#cu-status');
  el.textContent = 'checking…';
  try {
    const p = await api.computerUse.checkPermissions();
    el.textContent = `${p.accessibility ? '✓' : '✗'} Accessibility · ${p.screenRecording ? '✓' : '✗'} Screen Recording`;
  } catch (e) { el.textContent = `error: ${e.message}`; }
});

// ---- prompt templates ----
let promptPick = null; // callback when a template is picked
async function openPrompts(onPick) {
  promptPick = onPick ?? null;
  const list = promptsDialog.querySelector('#prompt-list');
  list.innerHTML = '';
  let prompts = [];
  try { prompts = await api.prompts.list(); } catch {}
  if (!prompts.length) {
    list.innerHTML = '<div class="git-empty">no templates saved yet</div>';
  }
  for (const p of prompts) {
    const row = document.createElement('div');
    row.className = 'prompt-row';
    row.innerHTML = `<div class="prompt-info"><div class="prompt-title">${escapeHtml(p.title)}</div>
      <div class="prompt-body ellipsis">${escapeHtml(p.body.slice(0, 90))}</div></div>`;
    row.addEventListener('click', () => {
      promptPick?.(p.body);
      promptsDialog.close();
    });
    list.appendChild(row);
  }
  promptsDialog.showModal();
}
promptsDialog.querySelector('#btn-prompts-close').addEventListener('click', () => promptsDialog.close());

// expose to React
window.quansioxUI = { openSettings, openPrompts, applyTheme };
