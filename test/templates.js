'use strict';
/* Local bot templates (share/export analog) + compat mappings. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-templates-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { sessionService } = require('../src/main/services/sessionService');
const { templateService } = require('../src/main/services/templateService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  sessionService.ensure('sess-tpl');
  sessionService.update('sess-tpl', { title: 'Release manager', label: 'CI/CD', description: 'Owns deploys.' });
  assert.deepEqual(templateService.list(), []);

  let t = templateService.publishFromSession({ sessionId: 'sess-tpl', prompt: 'Draft the release notes' });
  assert.match(t.id, /^tpl_/);
  assert.equal(t.profile.title, 'Release manager');
  assert.equal(t.profile.label, 'CI/CD');
  assert.equal(t.visibility, 'private');
  assert.equal(t.version, 1);
  assert.equal(templateService.list().length, 1);
  assert.equal(templateService.getForSourceAgent('sess-tpl').id, t.id);
  assert.throws(() => templateService.getPublic(t.id), /private/);
  t = templateService.setVisibility(t.id, 'shared');
  assert.equal(templateService.getPublic(t.id).id, t.id, 'shared templates are readable');
  // republish same source + name bumps the version in place
  t = templateService.publishFromSession({ sessionId: 'sess-tpl', name: t.name });
  assert.equal(t.version, 2);
  assert.equal(templateService.list().length, 1);

  // export/import round-trip (share is a local JSON handoff)
  const doc = templateService.exportDocument(t.id);
  assert.equal(doc.format, 'quansiox.bot-template');
  const imported = templateService.importDocument(doc);
  assert.notEqual(imported.id, t.id, 'import gets a fresh id');
  assert.equal(imported.profile.title, 'Release manager');
  assert.equal(templateService.list().length, 2);
  assert.throws(() => templateService.importDocument({ name: '' }), /no name/);
  const policy = templateService.exportPolicy();
  assert.equal(policy.exportable, true);
  assert.deepEqual(policy.formats, ['json']);

  // create a live session from a template
  const created = templateService.createFromTemplate({ templateId: t.id });
  assert.notEqual(created.session.id, 'sess-tpl');
  assert.equal(created.session.title, 'Release manager');
  assert.equal(created.session.label, 'CI/CD');
  assert.equal(created.prompt, 'Draft the release notes');
  assert.equal(sessionService.get(created.session.id).description, 'Owns deploys.');

  // compat surface
  let env = await grokCompatService.dispatch('listBotTemplates', {});
  assert.equal(env.status, 'ok');
  assert.equal(env.templates.length, 2);
  env = await grokCompatService.dispatch('publishBotTemplate', { sessionId: 'sess-tpl', name: 'Support bot', visibility: 'private' });
  assert.equal(env.status, 'ok'); assert.ok(env.templateId);
  const tplId = env.templateId;
  env = await grokCompatService.dispatch('getBotTemplateVersion', { templateId: tplId });
  assert.equal(env.status, 'ok'); assert.equal(env.version, 1);
  env = await grokCompatService.dispatch('setBotTemplateVisibility', { templateId: tplId, visibility: 'shared' });
  assert.equal(env.status, 'ok'); assert.equal(env.template.visibility, 'shared');
  env = await grokCompatService.dispatch('getPublicBotTemplate', { templateId: tplId });
  assert.equal(env.status, 'ok');
  env = await grokCompatService.dispatch('getBotTemplateForSourceAgent', { sessionId: 'sess-tpl' });
  assert.equal(env.status, 'ok'); assert.equal(env.template.id, tplId);
  env = await grokCompatService.dispatch('getBotTemplateExportPolicy', {});
  assert.equal(env.status, 'ok'); assert.equal(env.exportable, true);
  env = await grokCompatService.dispatch('createAgentFromTemplate', { templateId: tplId, name: 'Support bot 2' });
  assert.equal(env.status, 'ok'); assert.equal(env.session.title, 'Support bot 2');
  env = await grokCompatService.dispatch('updateGrokBotAgent', { agentId: 'sess-tpl', name: 'Release captain', label: 'Release' });
  assert.equal(env.status, 'ok'); assert.equal(env.agent.title, 'Release captain');
  assert.equal(sessionService.get('sess-tpl').label, 'Release');
  env = await grokCompatService.dispatch('deleteBotTemplate', { templateId: tplId });
  assert.equal(env.status, 'ok'); assert.equal(templateService.get(tplId), null);

  assert.equal(fs.statSync(path.join(tmp, 'bot-templates.json')).mode & 0o777, 0o600);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('templates test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
