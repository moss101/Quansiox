'use strict';
/* Desktop overlay panel — mount/unmount/read state machine, quick choices,
 * real prompt submission through agentService.run (stubbed), geometry via
 * movePanel/endPanelMove, drop-up menu anchor via reachForMenu, switchTo
 * focus. Electron-free (settings-backed, run patched in memory). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-desktop-panel-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { settingsService } = require('../src/main/services/settingsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { agentService } = require('../src/main/services/agentService');
const { sessionService } = require('../src/main/services/sessionService');

(async () => {
  settingsService.save({ workspaceRoot: tmp });

  // patch agent run (no daemon in test); captures the real invocation
  const runs = [];
  agentService.run = async (event, opts) => { runs.push({ event, opts }); return { ok: true }; };

  // 1. read before mount → not mounted
  const pre = await grokCompatService.dispatch('read', {});
  assert.strictEqual(pre.status, 'ok');
  assert.strictEqual(pre.mounted, false);
  assert.strictEqual(pre.agent, null);

  // 2. mount validates and records the agent + mark
  const noAgent = await grokCompatService.dispatch('mount', { name: 'Pet' });
  assert.strictEqual(noAgent.status, 'error');
  const mark = 'data:image/svg+xml;base64,PHN2Zy8+';
  const mounted = await grokCompatService.dispatch('mount', { agentId: 'agent-panel', name: 'Pet', markSvgDataUrl: mark });
  assert.strictEqual(mounted.status, 'ok');
  assert.strictEqual(mounted.mounted, true);
  assert.strictEqual(mounted.agent.id, 'agent-panel');
  assert.strictEqual(mounted.agent.name, 'Pet');
  assert.strictEqual(mounted.agent.markSvgDataUrl, mark);
  const badMark = await grokCompatService.dispatch('mount', { agentId: 'agent-panel', markSvgDataUrl: 'javascript:alert(1)' });
  assert.strictEqual(badMark.agent.markSvgDataUrl, null, 'only data: URLs accepted');

  // 3. read reports layout + persisted geometry
  const read1 = await grokCompatService.dispatch('read', {});
  assert.strictEqual(read1.mounted, true);
  assert.strictEqual(read1.layout.width, 380);
  assert.deepStrictEqual(read1.geometry, { x: null, y: null });
  assert.strictEqual(settingsService.load().desktopPanel.mounted, true, 'panel state persisted in settings');

  // 4. choices: normalize + replace + gate while unmounted later
  const offered = await grokCompatService.dispatch('offerChoices', { choices: ['Summarize the diff', { label: 'Run tests', value: 'npm test', id: 'run-tests' }] });
  assert.strictEqual(offered.status, 'ok');
  assert.strictEqual(offered.count, 2);
  assert.deepStrictEqual(offered.choices.map((c) => c.label), ['Summarize the diff', 'Run tests']);
  assert.strictEqual(offered.choices[1].value, 'npm test');
  assert.strictEqual(offered.choices[1].id, 'run-tests');
  const readChoices = await grokCompatService.dispatch('readChoices', {});
  assert.strictEqual(readChoices.pending, true);
  assert.strictEqual(readChoices.agentId, 'agent-panel');

  // 5. geometry: movePanel nudge → endPanelMove commit → reachForMenu anchor
  const moved = await grokCompatService.dispatch('movePanel', { dx: 120, dy: 640 });
  assert.strictEqual(moved.moved, true);
  assert.deepStrictEqual(moved.geometry, { x: 120, y: 640 });
  const moved2 = await grokCompatService.dispatch('movePanel', { dx: -20, dy: -40 });
  assert.deepStrictEqual(moved2.geometry, { x: 100, y: 600 });
  const ended = await grokCompatService.dispatch('endPanelMove', {});
  assert.strictEqual(ended.ended, true);
  assert.deepStrictEqual(ended.geometry, { x: 100, y: 600 });
  const menu = await grokCompatService.dispatch('reachForMenu', { heightPx: 200 });
  assert.strictEqual(menu.status, 'ok');
  assert.deepStrictEqual(menu.anchor, { x: 100, y: 400, width: 380, height: 200, dropUp: true });
  assert.strictEqual(settingsService.load().desktopPanel.heightPx, 200);

  // 6. submitPrompt starts a real run on the mounted agent's session
  const submitted = await grokCompatService.dispatch('submitPrompt', { prompt: '  fix the failing test  ' });
  assert.strictEqual(submitted.status, 'ok');
  assert.strictEqual(submitted.sessionId, 'agent-panel');
  assert.strictEqual(submitted.prompt, 'fix the failing test');
  assert.strictEqual(runs.length, 1);
  assert.deepStrictEqual(runs[0].opts, { sessionId: 'agent-panel', message: 'fix the failing test', attachments: [] });
  assert.ok(sessionService.get('agent-panel'), 'session ensured for the run');
  const emptyPrompt = await grokCompatService.dispatch('submitPrompt', { prompt: '   ' });
  assert.strictEqual(emptyPrompt.status, 'error');

  // 7. switchTo focuses an agent
  const switched = await grokCompatService.dispatch('switchTo', { agentId: 'agent-other' });
  assert.strictEqual(switched.status, 'ok');
  assert.strictEqual(settingsService.load().viewingAgentId, 'agent-other');
  const badSwitch = await grokCompatService.dispatch('switchTo', {});
  assert.strictEqual(badSwitch.status, 'error');

  // 8. unmount clears choices and blocks prompt/choices/move
  const unmounted = await grokCompatService.dispatch('unmount', {});
  assert.strictEqual(unmounted.mounted, false);
  assert.strictEqual(unmounted.alreadyUnmounted, false);
  assert.strictEqual((await grokCompatService.dispatch('unmount', {})).alreadyUnmounted, true);
  assert.strictEqual((await grokCompatService.dispatch('submitPrompt', { prompt: 'hi' })).status, 'error');
  assert.strictEqual((await grokCompatService.dispatch('offerChoices', { choices: ['x'] })).status, 'error');
  assert.strictEqual((await grokCompatService.dispatch('movePanel', { dx: 1, dy: 1 })).moved, false);
  const readAfter = await grokCompatService.dispatch('read', {});
  assert.strictEqual(readAfter.mounted, false);
  assert.deepStrictEqual(readAfter.geometry, { x: 100, y: 600 }, 'geometry remembered for remount');

  // 9. remount same agent restores geometry
  await grokCompatService.dispatch('mount', { agentId: 'agent-panel', name: 'Pet' });
  const read2 = await grokCompatService.dispatch('read', {});
  assert.deepStrictEqual(read2.geometry, { x: 100, y: 600 });
  await grokCompatService.dispatch('mount', { agentId: 'agent-other', name: 'Other' });
  assert.deepStrictEqual((await grokCompatService.dispatch('read', {})).geometry, { x: null, y: null }, 'different agent starts fresh');

  // 10. status line (working / idle) is part of the panel state
  const { panelService } = require('../src/main/services/panelService');
  const working = panelService.setStatus({ status: 'working', message: 'running the tests' });
  assert.strictEqual(working.agentStatus, 'working');
  assert.strictEqual(working.lastMessage, 'running the tests');
  const readStatus = await grokCompatService.dispatch('read', {});
  assert.strictEqual(readStatus.agentStatus, 'working');
  assert.strictEqual(readStatus.lastMessage, 'running the tests');
  panelService.setStatus({ status: 'idle' });
  assert.strictEqual((await grokCompatService.dispatch('read', {})).agentStatus, 'idle');

  // 11. the panel IPC namespace can submit a prompt (it starts a real run)
  const { registerNamespace, setupIpc, allHandlers } = require('../src/main/ipc/registry');
  require('../src/main/ipc/namespaces');
  assert.ok(allHandlers.panel, 'the panel namespace is registered');
  assert.ok(typeof allHandlers.panel.submit === 'function');
  assert.ok(typeof allHandlers.panel.state === 'function');
  const panelSubmitted = await allHandlers.panel.submit({}, { prompt: 'do the thing' });
  assert.strictEqual(panelSubmitted.submitted, true);
  assert.strictEqual(panelSubmitted.agentId, 'agent-other');
  assert.strictEqual(runs.length, 2, 'the panel prompt started a real agent run');
  assert.deepStrictEqual(runs[1].opts, { sessionId: 'agent-other', message: 'do the thing', attachments: [] });
  // a panel prompt with no text is refused
  await assert.rejects(() => allHandlers.panel.submit({}, { prompt: '   ' }), /non-empty string/);
  void registerNamespace; void setupIpc;

  console.log('desktop-panel test: ALL OK (mount/read/choices/geometry/submitPrompt/switchTo/status/panel-namespace)');
})().catch((e) => { console.error(e); process.exit(1); });
