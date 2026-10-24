'use strict';
/* MCP catalog + governance test — getMcpCatalog (real installable catalog),
 * toggleMcpToolDisabled now ENFORCED via the consent store (guardTool refuses a
 * disabled tool — no more dead mcpDisabledTools flag), and getEffectivePlugins.
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mcpg-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const { settingsService } = require('../src/main/services/settingsService');
const { consentService } = require('../src/main/services/consentService');
const { skillsService } = require('../src/main/services/skillsService');
const { marketplaceService } = require('../src/main/services/marketplaceService');
const { guardTool } = require('../src/coordinator/permissions');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

const permissive = { permissive: true };

(async () => {
  // 1. getMcpCatalog is a real, installable MCP-server catalog
  const cat = (await grokCompatService.dispatch('getMcpCatalog', {})).servers;
  assert.ok(Array.isArray(cat) && cat.length >= 4, 'catalog lists MCP servers');
  assert.ok(cat.every((s) => s.kind === 'mcp'));
  assert.ok(!cat.some((s) => 'command' in s), 'catalog hides install command/env');

  // 2. toggleMcpToolDisabled is ENFORCED (fixes the dead-flag fake)
  assert.strictEqual(guardTool('write_file', { path: 'x', content: 'y' }, permissive), null, 'allowed before disable');
  let env = await grokCompatService.dispatch('toggleMcpToolDisabled', { tool: 'write_file', disabled: true });
  assert.strictEqual(env.mode, 'deny', 'disable records a standing deny');
  assert.strictEqual(consentService.getGrant('*', 'write_file'), 'deny');
  const refusal = guardTool('write_file', { path: 'x', content: 'y' }, permissive);
  assert.match(refusal, /standing denial/, 'a disabled tool is actually refused');
  // re-enable
  env = await grokCompatService.dispatch('toggleMcpToolDisabled', { tool: 'write_file', disabled: false });
  assert.strictEqual(consentService.getGrant('*', 'write_file'), undefined, 're-enable revokes the deny');
  assert.strictEqual(guardTool('write_file', { path: 'x' }, permissive), null, 'allowed again after re-enable');

  // 3. getEffectivePlugins reflects enabled skills + configured MCP servers
  skillsService.install({ id: 'eff-skill', name: 'Eff', body: 'b', enabled: true });
  settingsService.save({ mcpServers: [{ name: 'eff-mcp', command: 'node', args: [] }] });
  env = await grokCompatService.dispatch('getEffectivePlugins', {});
  assert.ok(env.plugins.some((p) => p.id === 'eff-skill'), 'enabled skill listed');
  assert.ok(env.mcpServers.some((s) => s.id === 'eff-mcp'), 'configured MCP server listed');

  // 4. an installed MCP server from the marketplace appears in effective plugins
  marketplaceService.install('mcp-fetch');
  env = await grokCompatService.dispatch('getEffectivePlugins', {});
  assert.ok(env.mcpServers.some((s) => s.id === 'mcp-fetch'), 'marketplace-installed MCP server is effective');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mcp-governance test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
