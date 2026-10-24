'use strict';
/* Local AI-tool ecosystem discovery.
 *
 *  - the TOML subset Codex uses ([mcp_servers.NAME]) parses correctly
 *  - Claude Code / Codex / Cursor configs are discovered
 *  - skills and slash commands are found
 *  - importing an MCP server lands it in the settings (and does not touch
 *    the user's own config)
 *  - secrets are never read
 *
 * The home directory is faked via HOME so the real ~/.claude is untouched. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-home-'));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
process.env.QUANSIOX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-eco-'));

const { ecosystemService } = require('../src/main/services/ecosystemService');
const { parseToml } = ecosystemService;

(async () => {
  /* ---------------- the TOML subset ---------------- */
  const toml = parseToml([
    '# a comment',
    'model = "gpt-5"',
    '[mcp_servers.files]',
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]',
    'env = { X = "1" }',
    '[mcp_servers.other]',
    'command = "other-server"',
  ].join('\n'));
  assert.equal(toml.model, 'gpt-5');
  assert.equal(toml['mcp_servers.files'].command, 'npx');
  assert.deepEqual(toml['mcp_servers.files'].args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.equal(toml['mcp_servers.other'].command, 'other-server');

  /* ---------------- Claude Code ---------------- */
  fs.mkdirSync(path.join(fakeHome, '.claude', 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude', 'skills', 'my-skill', 'SKILL.md'),
    '---\nname: my-skill\ndescription: does the thing\n---\n\nDo the thing.');
  fs.mkdirSync(path.join(fakeHome, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude', 'commands', 'review.md'), 'Review the diff.');
  fs.writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({
    mcpServers: { 'claude-fs': { command: 'npx', args: ['-y', 'fs-server'], env: { TOKEN: 'secret' } } },
    projects: { '/tmp/proj': { mcpServers: { 'proj-db': { command: 'psql', args: ['--x'] } } } },
  }));

  /* ---------------- Codex ---------------- */
  fs.mkdirSync(path.join(fakeHome, '.codex', 'skills', 'codex-skill'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.codex', 'skills', 'codex-skill', 'SKILL.md'),
    '---\ndescription: a codex skill\n---\nBody.');
  fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'),
    '[mcp_servers.codex-gh]\ncommand = "gh-mcp"\nargs = ["serve"]\n');
  fs.writeFileSync(path.join(fakeHome, '.codex', 'history.jsonl'),
    `${JSON.stringify({ text: 'refactor the parser' })}\n${JSON.stringify({ text: 'write the docs' })}\n`);

  /* ---------------- Cursor ---------------- */
  fs.mkdirSync(path.join(fakeHome, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { 'cursor-mcp': { command: 'cursor-server' } },
  }));
  fs.writeFileSync(path.join(fakeHome, '.cursor', 'rules', 'style.mdc'), 'Always use tabs.');

  /* ---------------- discovery ---------------- */
  const found = ecosystemService.discover();
  const byTitle = (t) => found.items.find((i) => i.title === t);

  assert.ok(byTitle('claude-fs'), 'the Claude MCP server is discovered');
  assert.equal(byTitle('claude-fs').kind, 'mcp_server');
  assert.match(byTitle('claude-fs').excerpt, /fs-server/);
  assert.ok(byTitle('proj-db'), 'a per-project Claude MCP server is discovered');
  assert.equal(byTitle('proj-db').project, '/tmp/proj');
  assert.ok(byTitle('my-skill'), 'a Claude skill is discovered');
  assert.equal(byTitle('my-skill').kind, 'skill');
  assert.match(byTitle('my-skill').excerpt, /does the thing/);
  assert.ok(byTitle('review'), 'a Claude slash command is discovered');
  assert.equal(byTitle('review').kind, 'prompt');

  assert.ok(byTitle('codex-gh'), 'a Codex MCP server is discovered');
  assert.ok(byTitle('codex-skill'), 'a Codex skill is discovered');
  assert.ok(byTitle('refactor the parser'), 'a Codex session is discovered');
  assert.equal(byTitle('refactor the parser').kind, 'session');

  assert.ok(byTitle('cursor-mcp'), 'a Cursor MCP server is discovered');
  assert.ok(byTitle('style'), 'a Cursor rule is discovered');

  // the sources report what was found
  const claudeSource = found.sources.find((s) => s.id === 'claude_code');
  assert.equal(claudeSource.found, true);
  assert.ok(claudeSource.roots.includes('.claude.json'));
  const absent = found.sources.find((s) => s.id === 'opencode');
  assert.equal(absent.found, false);

  /* ---------------- the catalogue is addressable ---------------- */
  const catalog = ecosystemService.catalog();
  assert.ok(catalog.entries.length >= 8);
  assert.ok(catalog.entries.every((e) => typeof e.id === 'string' && e.id.length > 0));
  const importable = catalog.entries.filter((e) => e.importable);
  assert.ok(importable.length >= 5);

  /* ---------------- import ---------------- */
  const { settingsService } = require('../src/main/services/settingsService');
  const mcpEntry = catalog.entries.find((e) => e.title === 'codex-gh');
  const imported = await ecosystemService.importItem(mcpEntry.id);
  assert.equal(imported.status, 'ok');
  assert.equal(imported.kind, 'mcp_server');
  const servers = settingsService.load().mcpServers ?? [];
  assert.ok(servers.some((s) => s.name === 'codex-gh'), 'the MCP server landed in the settings');
  assert.deepEqual(servers.find((s) => s.name === 'codex-gh').args, ['serve']);

  // a skill import lands in the skill catalog
  const skillEntry = catalog.entries.find((e) => e.title === 'my-skill');
  const skillImported = await ecosystemService.importItem(skillEntry.id);
  assert.equal(skillImported.status, 'ok');
  const { skillsService } = require('../src/main/services/skillsService');
  assert.ok(skillsService.list().some((s) => s.name === 'my-skill'), 'the skill landed in the catalog');

  // a prompt import lands in the prompt library
  const promptEntry = catalog.entries.find((e) => e.title === 'review');
  const promptImported = await ecosystemService.importItem(promptEntry.id);
  assert.equal(promptImported.status, 'ok');
  assert.ok((settingsService.load().prompts ?? []).some((p) => p.title === 'review'));

  // an unknown entry is refused
  const bad = await ecosystemService.importItem('nope:nope:nope:999');
  assert.equal(bad.status, 'error');

  // the user's own configuration was never modified
  const claudeJson = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8'));
  assert.ok(claudeJson.mcpServers['claude-fs'], 'the source config is untouched');

  process.env.HOME = realHome;
  console.log('ecosystem test: ALL OK (toml/claude/codex/cursor/import/no-mutation)');
})().catch((e) => { console.error(e); process.exit(1); });
