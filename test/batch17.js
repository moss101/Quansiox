'use strict';
/* Batch 17 — deep-dig surface delta: host settings, machine id, global
 * search, onboarding skip, clipboard, computer-use permissions + settings
 * pane, sand access cache, gateway notes (backend/network/box), RPC trace
 * window + traceparent, server transcript tail access, MCP plugin adoption,
 * agentsList, panel readLayout/unmountSelf, experiment exposure logs, and
 * honest envelopes for cursor/cloud/backend stubs. Electron is stubbed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-batch17-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const opened = [];
class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts;
    this.id = FakeBrowserWindow.nextId++;
    this.destroyed = false;
    this.listeners = new Map();
    this.webContents = { executeJavaScript: async () => {} };
  }
  on(event, cb) { this.listeners.set(event, cb); return this; }
  emit(event, ...args) { const cb = this.listeners.get(event); if (cb) cb(...args); }
  focus() { this.focused = true; }
  loadURL(url) { this.url = url; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
}
FakeBrowserWindow.nextId = 1;

const fakeElectron = {
  app: { getLocale: () => 'en-US', getPath: () => tmp },
  clipboard: { readText: () => 'hello-clipboard' },
  shell: { openExternal: async (url) => { opened.push(url); } },
  systemPreferences: {
    getMediaAccessStatus: (kind) => (kind === 'screen' ? 'granted' : kind === 'microphone' ? 'denied' : 'not-determined'),
    isTrustedAccessibilityClient: () => true,
  },
  BrowserWindow: FakeBrowserWindow,
  nativeTheme: { shouldUseDarkColors: true, themeSource: 'system' },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, parent, isMain);
};

const { settingsService } = require('../src/main/services/settingsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { gatewayStateService } = require('../src/main/services/gatewayStateService');
const { sessionService } = require('../src/main/services/sessionService');
const { desktopPrefsService } = require('../src/main/services/desktopPrefsService');
const { diagnosticsService } = require('../src/main/services/diagnosticsService');

(async () => {
  settingsService.save({ workspaceRoot: tmp });

  // 1. host settings round-trip
  settingsService.save({ notifyOnDone: true, notifyOnUpdates: true, systemPromptExtra: 'Be concise.', mcpDisabledToolsByServerId: { fs: { write: true } } });
  const host = await grokCompatService.dispatch('getHostSettings', {});
  assert.strictEqual(host.status, 'ok');
  assert.strictEqual(host.notifications.notifyOnDone, true);
  assert.strictEqual(host.mcpCustomInstructions, 'Be concise.');
  assert.deepStrictEqual(host.mcpDisabledToolsByServerId, { fs: { write: true } });

  // 2. onboarding skip
  assert.strictEqual((await grokCompatService.dispatch('getOnboardingSeen', {})).seen, false);
  const skip = await grokCompatService.dispatch('skipOnboarding', {});
  assert.strictEqual(skip.skipped, true);
  assert.strictEqual((await grokCompatService.dispatch('getOnboardingSeen', {})).seen, true);

  // 3. global search pref (default on)
  assert.strictEqual((await grokCompatService.dispatch('isGlobalSearchEnabled', {})).enabled, true);
  desktopPrefsService.setGlobalSearchEnabled({ enabled: false });
  assert.strictEqual((await grokCompatService.dispatch('isGlobalSearchEnabled', {})).enabled, false);

  // 4. machine id — stable, persisted
  const m1 = await grokCompatService.dispatch('getMachineId', {});
  const m2 = await grokCompatService.dispatch('getMachineId', {});
  assert.match(m1.machineId, /^[0-9a-f-]{36}$/);
  assert.strictEqual(m1.machineId, m2.machineId);
  assert.strictEqual(settingsService.load().machineId, m1.machineId, 'persisted in settings');

  // 5. clipboard (stubbed electron)
  const clip = await grokCompatService.dispatch('readClipboard', {});
  assert.strictEqual(clip.text, 'hello-clipboard');
  assert.strictEqual(clip.available, true);

  // 6. computer-use permissions — screen/accessibility from Electron, macOS probes real
  const perms = await grokCompatService.dispatch('readComputerUsePermissions', {});
  assert.strictEqual(perms.screen, 'granted');
  assert.strictEqual(perms.accessibility, 'granted');
  assert.ok(['granted', 'denied', 'unknown'].includes(perms.automation));
  assert.ok(['granted', 'denied', 'unknown'].includes(perms.fullDiskAccess));
  assert.strictEqual(perms.platform, process.platform);

  // 7. permission settings pane
  const pane = await grokCompatService.dispatch('openComputerUsePermissionSettings', {});
  assert.strictEqual(pane.opened, true);
  assert.match(opened.at(-1), /^x-apple\.systempreferences:/);

  // 8. computer-use allowlist + 1Password probe
  const allow0 = await grokCompatService.dispatch('listComputerUseAllowedApps', {});
  assert.deepStrictEqual(allow0.allowedApps, []);
  settingsService.save({ computerUseAllowedApps: [{ bundleId: 'com.apple.Safari', name: 'Safari' }] });
  assert.strictEqual((await grokCompatService.dispatch('listComputerUseAllowedApps', {})).allowedApps.length, 1);
  assert.strictEqual(typeof (await grokCompatService.dispatch('isOnePasswordAppInstalled', {})).installed, 'boolean');

  // 9. sand access — fresh probe cached on second call
  const sand1 = await grokCompatService.dispatch('getSandAccess', {});
  assert.strictEqual(sand1.cached, false);
  assert.strictEqual(sand1.screen, 'granted');
  assert.strictEqual(sand1.microphone, 'denied');
  const sand2 = await grokCompatService.dispatch('getSandAccess', {});
  assert.strictEqual(sand2.cached, true);

  // 10. gateway notes
  await grokCompatService.dispatch('noteBackendReturn', {});
  await grokCompatService.dispatch('noteBackendReturn', {});
  await grokCompatService.dispatch('noteNetworkReturn', {});
  await grokCompatService.dispatch('noteBoxRunning', {});
  await grokCompatService.dispatch('noteBoxAsleep', {});
  const gw = gatewayStateService.status();
  assert.strictEqual(gw.backendReturns, 2);
  assert.strictEqual(gw.networkReturns, 1);
  assert.strictEqual(gw.boxState, 'asleep');
  assert.ok(gw.boxStateAt > 0);

  // 11. RPC trace window — traceparent lifecycle
  assert.strictEqual((await grokCompatService.dispatch('getRpcTraceWindowTraceparent', {})).traceparent, null);
  const started = await grokCompatService.dispatch('startRpcTraceWindow', {});
  assert.strictEqual(started.opened, true);
  assert.match(started.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  const live = await grokCompatService.dispatch('getRpcTraceWindowTraceparent', {});
  assert.strictEqual(live.traceparent, started.traceparent);
  gatewayStateService.noteTrace('listAgents', 'ok');
  assert.strictEqual(gatewayStateService.traceEntries().length, 1);
  const reuse = await grokCompatService.dispatch('startRpcTraceWindow', {});
  assert.strictEqual(reuse.reused, true);
  const fakeWin = [...require('../src/main/windowManager').windowManager.windows.values()].find((w) => w.windowType === 'rpc-trace').win;
  fakeWin.destroyed = true;
  fakeWin.emit('closed');
  assert.strictEqual((await grokCompatService.dispatch('getRpcTraceWindowTraceparent', {})).traceparent, null, 'closed window clears traceparent');

  // 12. server transcript tail access
  const tail = await grokCompatService.dispatch('resolveServerTranscriptTail', {});
  assert.strictEqual(tail.access.kind, 'local-sessions');
  assert.ok(fs.existsSync(tail.access.dir));

  // 13. MCP: effective plugins + adopting staged server permissions
  settingsService.save({ mcpServers: [{ name: 'fs', command: 'npx' }] });
  const eff = await grokCompatService.dispatch('getEffectiveMcpPlugins', {});
  assert.ok(eff.plugins.some((p) => p.id === 'fs' && p.kind === 'mcp'));
  const adopt0 = await grokCompatService.dispatch('adoptServerMcpToolPermissions', {});
  assert.strictEqual(adopt0.adopted, 0);
  settingsService.save({ serverMcpToolPermissions: [{ serverId: 'fs', toolName: 'read', allowed: true }, { serverId: 'fs', toolName: 'write', allowed: false }] });
  const adopt1 = await grokCompatService.dispatch('adoptServerMcpToolPermissions', {});
  assert.strictEqual(adopt1.adopted, 2);
  assert.strictEqual(settingsService.load().mcpToolPermissions.fs.tools.read, 'allowed');
  assert.strictEqual(settingsService.load().mcpToolPermissions.fs.tools.write, 'blocked');
  assert.deepStrictEqual(settingsService.load().serverMcpToolPermissions, [], 'staging cleared');

  // 14. agentsList
  sessionService.ensure('agent-17');
  const agents = await grokCompatService.dispatch('agentsList', {});
  assert.ok(agents.agents.some((a) => a.id === 'agent-17'));

  // 15. panel readLayout + unmountSelf
  await grokCompatService.dispatch('mount', { agentId: 'agent-17', name: 'Pet' });
  await grokCompatService.dispatch('movePanel', { dx: 40, dy: 600 });
  const layout = await grokCompatService.dispatch('readLayout', {});
  assert.strictEqual(layout.layout.width, 380);
  assert.strictEqual(layout.layout.mounted, true);
  assert.strictEqual(layout.layout.x, 40);
  await grokCompatService.dispatch('switchTo', { agentId: 'agent-17' });
  const self = await grokCompatService.dispatch('unmountSelf', {});
  assert.strictEqual(self.selfUnmounted, true);
  assert.strictEqual(settingsService.load().viewingAgentId, null, 'view cleared');
  assert.strictEqual(settingsService.load().desktopPanel.mounted, true, 'panel itself stays mounted');

  // 16. usage-warning assignment — honest without an account
  const peek = await grokCompatService.dispatch('peekUsageWarningAssignment', {});
  assert.strictEqual(peek.assignment, null);
  assert.match(peek.reason, /authenticated/);

  // 17. experiment exposure logs land in diagnostics
  const before = diagnosticsService.list({ kind: 'telemetry' }).length;
  await grokCompatService.dispatch('logOnboardingJobRoleExperimentExposure', {});
  await grokCompatService.dispatch('logGroupChatDiscouragementExperimentExposure', {});
  await grokCompatService.dispatch('logInviteTeammatesExperimentExposure', {});
  await grokCompatService.dispatch('logOnboardingNotificationsAskExperimentExposure', {});
  await grokCompatService.dispatch('logOnboardingRoleUseCaseBotsExperimentExposure', {});
  const after = diagnosticsService.list({ kind: 'telemetry' });
  assert.strictEqual(after.length, before + 5);
  assert.ok(after.some((e) => e.detail?.experiment === 'group-chat-discouragement'));

  // 18. honest stubs
  const wa = await grokCompatService.dispatch('finishWebAuthnConsent', {});
  assert.strictEqual(wa.status, 'unavailable');
  assert.strictEqual(wa.scope, 'backend');
  const cur = await grokCompatService.dispatch('getCursorWeeklyUsage', {});
  assert.strictEqual(cur.status, 'unavailable');
  assert.strictEqual(cur.scope, 'cursor/account');
  const bots = await grokCompatService.dispatch('listBotTemplates', {});
  assert.strictEqual(bots.status, 'ok'); assert.ok(Array.isArray(bots.templates), 'templates are a real local catalog now');
  const machines = await grokCompatService.dispatch('getSandMachines', {});
  assert.strictEqual(machines.scope, 'cloud');

  console.log('batch17 test: ALL OK (host settings/machine id/trace window/MCP adoption/panel layout/notes/stubs)');
})().catch((e) => { console.error(e); process.exit(1); });
