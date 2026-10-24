'use strict';
/* Marketplace test — Quansiox-owned local catalog over skills + MCP servers.
 * Install/uninstall dispatch by kind; MCP install writes settings.mcpServers
 * (coordinator MCP-syncs before each run), skill install → skillsService.
 * Electron-free; no process spawns. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mkt-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const market = require('../src/main/services/marketplaceService').marketplaceService;
const { settingsService } = require('../src/main/services/settingsService');
settingsService.save({ mcpServers: [] });

async function run() {
  // 1. catalog lists curated packages, skills + mcp, all uninstalled initially
  const all = market.list();
  assert.ok(all.length >= 6, 'catalog has packages');
  assert.ok(all.some((p) => p.kind === 'skill') && all.some((p) => p.kind === 'mcp'));
  assert.ok(all.every((p) => p.installed === false), 'nothing installed yet');
  assert.ok(!('body' in all.find((p) => p.kind === 'skill')), 'list stays summary (no skill body)');
  assert.ok(all.filter((p) => p.kind === 'mcp').every((p) => !('command' in p)), 'list hides mcp command/env');

  // 2. filter by kind + query
  assert.ok(market.list({ kind: 'skill' }).every((p) => p.kind === 'skill'));
  assert.ok(market.list({ query: 'github' }).map((p) => p.id).includes('mcp-github'));
  assert.strictEqual(market.list({ query: 'zzzznomatch' }).length, 0);

  // 3. install a skill → lands in the skill catalog + installed flag flips
  market.install('code-review');
  assert.strictEqual(market.installed('code-review'), true);
  assert.strictEqual(market.list().find((p) => p.id === 'code-review').installed, true);
  const again = market.install('code-review');
  assert.strictEqual(again.already, true, 'idempotent install');
  assert.ok(require('../src/main/services/skillsService').skillsService.get('code-review'));

  // 4. install an MCP server → recorded in settings.mcpServers (env preserved)
  market.install('mcp-github');
  const servers = settingsService.load().mcpServers;
  const gh = servers.find((s) => s.name === 'mcp-github');
  assert.ok(gh, 'mcp server recorded');
  assert.strictEqual(gh.command, 'npx');
  assert.strictEqual(gh.env.GITHUB_TOKEN, '{{secret:github.token}}', 'env preserved (secret ref)');
  assert.strictEqual(servers.filter((s) => s.name === 'mcp-github').length, 1, 'no duplicate');

  // 5. uninstall both
  market.uninstall('code-review');
  assert.strictEqual(market.installed('code-review'), false);
  market.uninstall('mcp-github');
  assert.ok(!settingsService.load().mcpServers.some((s) => s.name === 'mcp-github'));

  // 6. unknown package + manifest import (skill + mcp)
  assert.throws(() => market.install('nope'), /not in catalog/);
  const mSkill = market.installFromManifest({ kind: 'skill', name: 'My Custom', description: 'd', body: 'do the thing' });
  assert.strictEqual(mSkill.id, 'my-custom');
  assert.ok(require('../src/main/services/skillsService').skillsService.get('my-custom'));
  const mMcp = market.installFromManifest({ kind: 'mcp', id: 'custom-mcp', command: 'node', args: ['server.js'], env: { A: '1' } });
  assert.strictEqual(mMcp.kind, 'mcp');
  assert.ok(settingsService.load().mcpServers.some((s) => s.name === 'custom-mcp'));
  assert.throws(() => market.installFromManifest({ kind: 'mcp', id: 'nocmd' }), /needs a command/);

  // 7. through the Grok compatibility surface (real, not stubbed)
  const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
  let env = await grokCompatService.dispatch('listPublicBotMarketplace', {});
  assert.strictEqual(env.status, 'ok'); assert.ok(Array.isArray(env.packages) && env.packages.length >= 6);
  env = await grokCompatService.dispatch('listPublicBotMarketplace', { kind: 'mcp', query: 'github' });
  assert.ok(env.packages.every((p) => p.kind === 'mcp') && env.packages.some((p) => p.id === 'mcp-github'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('marketplace test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
