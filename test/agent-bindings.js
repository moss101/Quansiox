'use strict';
/* Agent skills & plugins — per-agent skill attachments (real skills-catalog
 * install + files into the agent file store), plugin bindings (plugin /
 * config-update / inline), per-agent variable overrides, shared plugin
 * install-value updates, timezone + transcript telemetry reports. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-agent-bind-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { settingsService } = require('../src/main/services/settingsService');
const { skillsService } = require('../src/main/services/skillsService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  // 1. agent skills — install into the catalog, bind, files land in agent files
  const add = await grokCompatService.dispatch('addGrokBotAgentSkill', {
    agentId: 'a1', name: 'web research', description: 'how to browse',
    content: 'Step 1: search\nStep 2: cite',
    files: [{ path: 'guide.md', content: '# Guide' }],
  });
  assert.strictEqual(add.status, 'ok');
  assert.strictEqual(add.skill.skillId, 'web-research');
  assert.deepStrictEqual(add.skill.files, ['guide.md']);
  assert.strictEqual(skillsService.get('web-research').body.includes('Step 1'), true);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'agent-files', 'a1', fs.readdirSync(path.join(tmp, 'agent-files', 'a1')).find((f) => f.endsWith('-guide.md'))), 'utf8'), '# Guide');
  assert.strictEqual(fs.statSync(path.join(tmp, 'agent-skills.json')).mode & 0o777, 0o600);

  const list = await grokCompatService.dispatch('getGrokBotAgentSkills', { agentId: 'a1' });
  assert.strictEqual(list.skills.length, 1);
  assert.strictEqual(list.skills[0].inCatalog, true);

  // second agent binding the same skill keeps the catalog entry on remove
  await grokCompatService.dispatch('addGrokBotAgentSkill', { agentId: 'a2', name: 'web research', content: 'Step 1: search' });
  assert.strictEqual((await grokCompatService.dispatch('addGrokBotAgentSkill', { agentId: 'a2', name: 'other', content: 'x' })).skill.skillId, 'other');
  const removedScalar = await grokCompatService.dispatch('removeGrokBotAgentSkill', { agentId: 'a2', name: 'other' });
  assert.strictEqual(removedScalar.catalogRemoved, true);
  assert.strictEqual(skillsService.get('other'), null);

  // update by name
  const upd = await grokCompatService.dispatch('updateGrokBotAgentSkill', { agentId: 'a1', name: 'web research', content: 'Step 1: search harder' });
  assert.strictEqual(upd.skill.skillId, 'web-research');
  assert.ok(skillsService.get('web-research').body.includes('harder'));
  const updMissing = await grokCompatService.dispatch('updateGrokBotAgentSkill', { agentId: 'a1', name: 'nope', content: 'x' });
  assert.strictEqual(updMissing.status, 'error');
  const rm = await grokCompatService.dispatch('removeGrokBotAgentSkill', { agentId: 'a1', name: 'web research' });
  assert.strictEqual(rm.removed, true);
  assert.strictEqual(rm.catalogRemoved, false, 'a2 still binds it');
  assert.strictEqual(skillsService.get('web-research') !== null, true);

  // 2. agent plugins — bind installed/catalog plugin, per-agent variables, remove
  assert.strictEqual((await grokCompatService.dispatch('setGrokBotAgentPlugins', { agentId: 'a1', plugins: [{ kind: 'plugin', pluginId: 'no-such' }] })).status, 'error');
  const bound = await grokCompatService.dispatch('setGrokBotAgentPlugins', { agentId: 'a1', plugins: [
    { kind: 'plugin', pluginId: 'mcp-filesystem' },
    { kind: 'inline', name: 'scratch', displayName: 'Scratch', description: 'inline server', mcpConfigJson: JSON.stringify({ command: 'node', args: ['x.js'] }) },
  ] });
  assert.strictEqual(bound.plugins.length, 2);
  assert.strictEqual(bound.plugins[0].installed, false, 'not installed yet is honest');
  assert.strictEqual(bound.plugins[1].displayName, 'Scratch');

  // config-update requires valid JSON
  const badJson = await grokCompatService.dispatch('setGrokBotAgentPlugins', { agentId: 'a1', plugins: [
    { kind: 'config-update', pluginId: 'mcp-filesystem', mcpConfigJson: '{oops' },
  ] });
  assert.strictEqual(badJson.status, 'error');

  const vars = await grokCompatService.dispatch('setGrokBotAgentPluginVariables', { agentId: 'a1', pluginId: 'mcp-filesystem', variables: { TOKEN: 't1', n: 2 } });
  assert.strictEqual(vars.plugin.variables.TOKEN, 't1');
  const vars2 = await grokCompatService.dispatch('setGrokBotAgentPluginVariables', { agentId: 'a1', pluginId: 'mcp-filesystem', variables: { EXTRA: true }, mergeWithStored: true });
  assert.strictEqual(vars2.plugin.variables.TOKEN, 't1', 'merge keeps stored');
  assert.strictEqual(vars2.plugin.variables.EXTRA, true);
  const varsReset = await grokCompatService.dispatch('setGrokBotAgentPluginVariables', { agentId: 'a1', pluginId: 'mcp-filesystem', variables: { TOKEN: 't2' } });
  assert.strictEqual(varsReset.plugin.variables.EXTRA, undefined, 'no merge replaces');
  const varsBad = await grokCompatService.dispatch('setGrokBotAgentPluginVariables', { agentId: 'a1', pluginId: 'ghost', variables: { a: 'b' } });
  assert.strictEqual(varsBad.status, 'error');

  // 3. updatePluginInstall shares the MCP install-values flow
  // (reloadAll is stubbed so no real MCP child process is spawned in the test)
  const { mcpService } = require('../src/main/services/mcpService');
  const realReload = mcpService.reloadAll;
  mcpService.reloadAll = async () => ({ reloaded: 0 });
  try {
    settingsService.save({ mcpServers: [{ name: 'temp-plugin', command: 'node', args: ['{{script}}'], env: {}, installValues: { script: 'a.js' } }] });
    const upEnv = await grokCompatService.dispatch('updatePluginInstall', { pluginId: 'temp-plugin', values: { script: 'b.js' } });
    assert.strictEqual(upEnv.updated, true);
    const server = settingsService.load().mcpServers.find((s) => s.name === 'temp-plugin');
    assert.deepStrictEqual(server.args, ['b.js']);
    assert.strictEqual(server.installValues.script, 'b.js');
    assert.strictEqual((await grokCompatService.dispatch('updatePluginInstall', { pluginId: 'ghost', values: {} })).status, 'error');
  } finally { mcpService.reloadAll = realReload; }

  // 4. timezone + transcript telemetry
  const tz = await grokCompatService.dispatch('getTimeZone', {});
  assert.strictEqual(typeof tz.timeZone, 'string');
  assert.ok(Number.isFinite(tz.offsetMinutes));
  for (const method of ['reportTranscriptParity', 'reportTranscriptRowLoss', 'reportTranscriptSource']) {
    const env = await grokCompatService.dispatch(method, { rows: 3 });
    assert.strictEqual(env.status, 'ok');
  }
  const log = fs.readFileSync(path.join(tmp, 'diagnostics', 'events.jsonl'), 'utf8');
  assert.ok(log.includes('transcript_parity') && log.includes('transcript_source'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('agent-bindings test: ALL OK (skills/plugins/variables/install-values/timezone/telemetry)');
})().catch((e) => { console.error(e); process.exit(1); });
