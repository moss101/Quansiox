'use strict';
/* Terms record, bot color pref, sidebar hidden (shared store), agent
 * visibility, marketplace installEntry (with values), document edit rights.
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-terms-prefs-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { settingsService } = require('../src/main/services/settingsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
const { documentsService } = require('../src/main/services/documentsService');
const { marketplaceService } = require('../src/main/services/marketplaceService');
const { mcpService } = require('../src/main/services/mcpService');

(async () => {
  settingsService.save({ workspaceRoot: tmp });
  let mcpReloads = 0;
  mcpService.reloadAll = async () => { mcpReloads += 1; };

  // 1. terms record: unseen → seen (persisted)
  const unseen = await grokCompatService.dispatch('getGrokBotTermsRecord', {});
  assert.strictEqual(unseen.seen, false);
  assert.strictEqual(unseen.seenAt, null);
  const marked = await grokCompatService.dispatch('markGrokBotTermsSeen', {});
  assert.strictEqual(marked.seen, true);
  assert.ok(marked.seenAt > 0);
  const seen = await grokCompatService.dispatch('getGrokBotTermsRecord', {});
  assert.strictEqual(seen.seen, true);
  assert.strictEqual(seen.seenAt, marked.seenAt);

  // 2. bot color in chat: default on, toggles
  assert.strictEqual((await grokCompatService.dispatch('getBotColorInChatEnabled', {})).enabled, true);
  const off = await grokCompatService.dispatch('setBotColorInChatEnabled', { enabled: false });
  assert.strictEqual(off.enabled, false);
  assert.strictEqual((await grokCompatService.dispatch('getBotColorInChatEnabled', {})).enabled, false);
  await grokCompatService.dispatch('setBotColorInChatEnabled', { enabled: true });

  // 3. sidebar hidden shares the real hiddenAgents store with setAgentHiddenFromSidebar
  const hide = await grokCompatService.dispatch('setGrokBotAgentSidebarHidden', { agentId: 'a1', isHidden: true });
  assert.strictEqual(hide.isHidden, true);
  assert.ok(settingsService.load().hiddenAgents.includes('a1'));
  const unhideViaOld = await grokCompatService.dispatch('setAgentHiddenFromSidebar', { id: 'a1', isHidden: false });
  assert.strictEqual(unhideViaOld.ok, true);
  assert.ok(!settingsService.load().hiddenAgents.includes('a1'), 'shared store');
  const missingId = await grokCompatService.dispatch('setGrokBotAgentSidebarHidden', { isHidden: true });
  assert.strictEqual(missingId.status, 'error');

  // 4. agent visibility: validated + persisted
  const vis = await grokCompatService.dispatch('setGrokBotAgentVisibility', { agentId: 'a1', visibility: 'team' });
  assert.strictEqual(vis.visibility, 'team');
  assert.strictEqual(vis.teamSharingAvailable, false);
  assert.strictEqual(settingsService.load().agentVisibility.a1, 'team');
  const badVis = await grokCompatService.dispatch('setGrokBotAgentVisibility', { agentId: 'a1', visibility: 'public' });
  assert.strictEqual(badVis.status, 'error');

  // 5. installEntry: real marketplace install (skill), idempotent
  const install = await grokCompatService.dispatch('installEntry', { entryId: 'code-review' });
  assert.strictEqual(install.status, 'ok');
  assert.strictEqual(install.kind, 'skill');
  assert.strictEqual(install.installed, true);
  assert.ok(marketplaceService.installed('code-review'));
  const again = await grokCompatService.dispatch('installEntry', { entryId: 'code-review' });
  assert.strictEqual(again.already, true);
  const unknown = await grokCompatService.dispatch('installEntry', { entryId: 'nope' });
  assert.strictEqual(unknown.status, 'error');

  // 6. installEntry with values materializes install values on the MCP entry
  const mcpInstall = await grokCompatService.dispatch('installEntry', { entryId: 'mcp-filesystem' });
  assert.strictEqual(mcpInstall.installed, true);
  const withValues = await grokCompatService.dispatch('installEntry', { entryId: 'mcp-filesystem', values: { workspace: tmp }, hasTeamConfiguredVariables: true });
  assert.strictEqual(withValues.valuesApplied, true);
  const server = settingsService.load().mcpServers.find((s) => s.name === 'mcp-filesystem');
  assert.deepStrictEqual(server.installValues, { workspace: tmp });
  assert.strictEqual(withValues.hasTeamConfiguredVariables, true);
  assert.strictEqual(mcpReloads, 1, 'install values reload MCP once (stubbed)');

  // 7. document edit right answers from the real doc store
  const doc = documentsService.saveDocument({ title: 'Editable', content: 'hello' });
  const right = await grokCompatService.dispatch('getDocumentEditRight', { locator: { storeId: 'local', documentId: doc.id } });
  assert.strictEqual(right.editable, true);
  assert.strictEqual(right.found, true);
  const missingDoc = await grokCompatService.dispatch('getDocumentEditRight', { locator: { storeId: 'local', documentId: 'doc_missing' } });
  assert.strictEqual(missingDoc.editable, false);
  assert.strictEqual(missingDoc.found, false);
  const noLocator = await grokCompatService.dispatch('getDocumentEditRight', {});
  assert.strictEqual(noLocator.status, 'error');

  console.log('terms-prefs test: ALL OK (terms/color/sidebar/visibility/installEntry/editRight)');
})().catch((e) => { console.error(e); process.exit(1); });
