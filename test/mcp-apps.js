'use strict';
/* MCP app surface — real stdio MCP server (fixture), catalog install/update/
 * uninstall, tool permissions enforcement, resources, staged docs, plugin
 * logos, OAuth code exchange, box listing, popularity from real usage.
 * (Grok 0.71: refreshMcp, getGrokBotAgentMcpServers, refreshMcpCatalog,
 * installMcpEntry, uninstallMcpPlugin, updateMcpPluginInstall,
 * setMcpToolPermissions, callMcpAppTool, readMcpAppResource,
 * stageMcpAppDocument, getMcpPluginLogo, completeMcpOAuth, listBoxMcpServers,
 * getMcpTeamPopularity). Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mcp-apps-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { settingsService } = require('../src/main/services/settingsService');
const { mcpService } = require('../src/main/services/mcpService');
const { marketplaceService } = require('../src/main/services/marketplaceService');
const { secretsService } = require('../src/main/services/secretsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

const MINI = path.join(__dirname, 'fixtures', 'mini-mcp-server.js');

(async () => {
  const keepalive = setInterval(() => {}, 1_000);

  // 0. configure the fixture as a real MCP server
  settingsService.save({ mcpServers: [{ name: 'mini', command: process.execPath, args: [MINI] }] });

  // 1. refreshMcp — ensureLoaded starts the server and lists tools
  const refreshed = await grokCompatService.dispatch('refreshMcp', {});
  const st = refreshed.servers.find((s) => s.name === 'mini');
  assert.strictEqual(st.status, 'ready', JSON.stringify(st));
  assert.deepStrictEqual(st.tools, ['echo']);
  assert.ok(st.pid > 0);

  // 2. getGrokBotAgentMcpServers — live wired to settings + status
  const agentServers = await grokCompatService.dispatch('getGrokBotAgentMcpServers', { agentId: 'sess-mcp' });
  assert.strictEqual(agentServers.servers.length, 1);
  assert.strictEqual(agentServers.servers[0].name, 'mini');
  assert.strictEqual(agentServers.servers[0].status, 'ready');
  assert.strictEqual(agentServers.servers[0].agentId, 'sess-mcp');

  // 3. callMcpAppTool — real tools/call on the fixture, JSON args parsing
  const call = await grokCompatService.dispatch('callMcpAppTool', { serverIdentifier: 'mini', toolName: 'echo', argumentsJson: JSON.stringify({ text: 'hi' }), userActivated: true });
  assert.strictEqual(call.status, 'ok');
  assert.strictEqual(call.result, 'echo:hi');
  const badJson = await grokCompatService.dispatch('callMcpAppTool', { serverIdentifier: 'mini', toolName: 'echo', argumentsJson: '{nope' });
  assert.strictEqual(badJson.status, 'error');
  assert.match(badJson.error, /not valid JSON/);
  const unknownTool = await grokCompatService.dispatch('callMcpAppTool', { serverIdentifier: 'mini', toolName: 'nope', argumentsJson: '{}' });
  assert.match(unknownTool.error, /unknown tool nope/);

  // 4. setMcpToolPermissions — blocks the tool from specs AND calls
  const perms = await grokCompatService.dispatch('setMcpToolPermissions', { serverId: 'mini', tools: { echo: 'blocked' } });
  assert.strictEqual(perms.permissions.tools.echo, 'blocked');
  assert.strictEqual(perms.toolSpecs, 0, 'blocked tool removed from specs');
  assert.ok(!mcpService.toolSpecs().some((t) => t.function.name === 'mcp__mini__echo'));
  const blocked = await grokCompatService.dispatch('callMcpAppTool', { serverIdentifier: 'mini', toolName: 'echo', argumentsJson: '{"text":"x"}' });
  assert.match(blocked.error, /blocked by permissions/);
  await grokCompatService.dispatch('setMcpToolPermissions', { serverId: 'mini', tools: { echo: 'allowed' } });
  assert.strictEqual(mcpService.toolSpecs().filter((t) => t.function.name === 'mcp__mini__echo').length, 1);

  // 5. readMcpAppResource — real resources/read
  const res = await grokCompatService.dispatch('readMcpAppResource', { serverIdentifier: 'mini', resourceUri: 'mem://greeting', documentSha256: 'abc' });
  assert.strictEqual(res.contents[0].text, 'hello resource');
  const resMissing = await grokCompatService.dispatch('readMcpAppResource', { serverIdentifier: 'mini', resourceUri: 'mem://nope' });
  assert.match(resMissing.error, /unknown resource/);

  // 6. installMcpEntry / updateMcpPluginInstall / uninstallMcpPlugin — real catalog install
  marketplaceService.CATALOG.push({ id: 'test-mcp', kind: 'mcp', name: 'Test MCP', description: 'fixture', category: 'mcp', author: 'test', version: '1.0.0', command: process.execPath, args: [MINI, '--label', '{{label}}'] });
  const installed = await grokCompatService.dispatch('installMcpEntry', { entryId: 'test-mcp', values: { label: 'alpha' } });
  assert.strictEqual(installed.installed, true);
  assert.deepStrictEqual(installed.server.args, [MINI, '--label', 'alpha']);
  const updated = await grokCompatService.dispatch('updateMcpPluginInstall', { pluginId: 'test-mcp', values: { label: 'beta' } });
  assert.deepStrictEqual(updated.server.args, [MINI, '--label', 'beta']);
  const removed = await grokCompatService.dispatch('uninstallMcpPlugin', { pluginId: 'test-mcp' });
  assert.strictEqual(removed.removed, true);
  assert.ok(!(settingsService.load().mcpServers ?? []).some((s) => s.name === 'test-mcp'));

  // 7. refreshMcpCatalog — marketplace view with installed flags
  await grokCompatService.dispatch('refreshMcpCatalog', {});
  const catalog = marketplaceService.list({ kind: 'mcp' });
  assert.ok(catalog.length >= 4);
  assert.ok(catalog.every((e) => typeof e.installed === 'boolean'));

  // 8. stageMcpAppDocument — real document persisted with sha256
  const html = '<html><body>mcp app</body></html>';
  const staged = await grokCompatService.dispatch('stageMcpAppDocument', { html, csp: { connectDomains: ['https://example.com'] } });
  assert.strictEqual(staged.sha256, crypto.createHash('sha256').update(html).digest('hex'));
  assert.ok(fs.existsSync(staged.path));
  assert.deepStrictEqual(staged.csp.connectDomains, ['https://example.com']);

  // 9. getMcpPluginLogo — real fetch + disk cache
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const logoServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); });
  await new Promise((r) => logoServer.listen(0, '127.0.0.1', r));
  const logoUrl = `http://127.0.0.1:${logoServer.address().port}/logo.png`;
  const logo = await grokCompatService.dispatch('getMcpPluginLogo', { url: logoUrl });
  assert.strictEqual(logo.mime, 'image/png');
  assert.strictEqual(logo.bytes, png.length);
  assert.strictEqual(logo.cached, false);
  const logo2 = await grokCompatService.dispatch('getMcpPluginLogo', { url: logoUrl });
  assert.strictEqual(logo2.cached, true);
  logoServer.close();
  const badProto = await grokCompatService.dispatch('getMcpPluginLogo', { url: 'file:///etc/passwd' });
  assert.strictEqual(badProto.status, 'error');

  // 10. completeMcpOAuth — real authorization_code exchange to a local endpoint
  const tokenServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('code') !== 'good-code' || params.get('code_verifier') !== 'verifier-1') { res.writeHead(400); res.end('{"error":"invalid_grant"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'at-123', refresh_token: 'rt-456', expires_in: 3600, token_type: 'Bearer' }));
    });
  });
  await new Promise((r) => tokenServer.listen(0, '127.0.0.1', r));
  const pendingFile = path.join(tmp, 'mcp-oauth-pending.json');
  fs.writeFileSync(pendingFile, JSON.stringify({
    'state-1': { server: 'remote-srv', tokenEndpoint: `http://127.0.0.1:${tokenServer.address().port}/token`, clientId: 'client-1', redirectUri: 'http://127.0.0.1/cb', codeVerifier: 'verifier-1', createdAtMs: Date.now() },
  }), { mode: 0o600 });
  const oauth = await grokCompatService.dispatch('completeMcpOAuth', { code: 'good-code', state: 'state-1' });
  assert.strictEqual(oauth.ok, true);
  assert.strictEqual(oauth.hasRefreshToken, true);
  const stored = secretsService.get(oauth.secretName);
  assert.ok(stored, 'tokens stored as an encrypted secret');
  assert.strictEqual(stored.fields.access_token, 'at-123');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(pendingFile, 'utf8')), {}, 'pending state consumed');
  const oauthUnknown = await grokCompatService.dispatch('completeMcpOAuth', { code: 'x', state: 'nope' });
  assert.strictEqual(oauthUnknown.ok, false);
  tokenServer.close();

  // 11. listBoxMcpServers — the local host is a first-class "box"
  const boxes = await grokCompatService.dispatch('listBoxMcpServers', { serverIdentifiers: ['mini'] });
  assert.strictEqual(boxes.boxes.length, 1);
  assert.strictEqual(boxes.boxes[0].id, 'local');
  assert.deepStrictEqual(boxes.boxes[0].servers.map((s) => s.name), ['mini']);
  assert.strictEqual(boxes.boxes[0].hostname, os.hostname());

  // 12. getMcpTeamPopularity — real usage counts from diagnostics
  const pop = await grokCompatService.dispatch('getMcpTeamPopularity', {});
  const miniPop = pop.popularity.find((p) => p.server === 'mini');
  assert.ok(miniPop.calls >= 1, 'tool calls recorded by diagnostics');
  assert.strictEqual(miniPop.installed, true);

  await mcpService.stopServer('mini');
  clearInterval(keepalive);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mcp-apps test: ALL OK (server/calls/permissions/resources/install/logo/oauth/box/popularity)');
})().catch(async (e) => { try { await mcpService.stopServer('mini'); } catch {} console.error(e); process.exit(1); });
