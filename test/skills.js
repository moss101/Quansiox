'use strict';
/* Skills + plugin catalog test — real local skills system. Covers service CRUD,
 * catalog block (present/empty), the use_skill/list_skills agent tools via
 * executeTool, enable-gating, compat routing. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-skills-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const skills = require('../src/main/services/skillsService').skillsService;
const coordinator = require('../src/coordinator/index');
const permissive = { permissive: true };
const cwd = tmp;

async function run() {
  // 1. empty catalog: list + block + use_skill
  assert.deepStrictEqual(skills.list(), []);
  assert.strictEqual(skills.catalogBlock(), '', 'empty catalog → no system-prompt block');
  assert.match(String(await coordinator.executeTool('list_skills', {}, cwd, 'sk', permissive)), /no skills installed/);
  assert.match(String(await coordinator.executeTool('use_skill', { id: 'nope' }, cwd, 'sk', permissive)), /skill not found/);

  // 2. publish (install) a skill
  const s = skills.install({ id: 'code-review', name: 'Code Review', description: 'Review diffs for bugs', version: '1.0.0', body: 'You are reviewing a diff. List bugs, then fixes.', tools: ['shell'] });
  assert.strictEqual(s.id, 'code-review');
  assert.strictEqual(s.enabled, true);
  assert.deepStrictEqual(skills.list().map((x) => x.id), ['code-review']);
  assert.strictEqual(skills.get('code-review').body, 'You are reviewing a diff. List bugs, then fixes.');
  // derived id from a name if no id given
  const s2 = skills.install({ name: 'Write Docs', body: 'docs body' });
  assert.strictEqual(s2.id, 'write-docs');
  // 0600 at rest
  assert.strictEqual(fs.statSync(path.join(tmp, 'skills', 'code-review.json')).mode & 0o777, 0o600, 'skill file 0600');

  // 3. catalog block lists enabled skills; disabling hides it
  const block = skills.catalogBlock();
  assert.match(block, /Code Review/);
  assert.match(block, /\(id: code-review\)/);
  assert.match(block, /Write Docs/, 'installed+enabled skills appear');
  skills.setEnabled('code-review', false);
  assert.doesNotMatch(skills.catalogBlock(), /code-review/, 'disabled skill excluded from prompt');
  assert.match(skills.catalogBlock(), /Write Docs/, 'other enabled skill still present');

  // 4. use_skill returns the skill body + input; disabled refused; list_skills reflects state
  skills.setEnabled('code-review', true);
  const used = String(await coordinator.executeTool('use_skill', { id: 'code-review', input: 'review HEAD~1' }, cwd, 'sk', permissive));
  assert.match(used, /You are reviewing a diff/);
  assert.match(used, /review HEAD~1/);
  skills.setEnabled('code-review', false);
  assert.match(String(await coordinator.executeTool('use_skill', { id: 'code-review' }, cwd, 'sk', permissive)), /skill is disabled/);
  const listed = String(await coordinator.executeTool('list_skills', {}, cwd, 'sk', permissive));
  assert.match(listed, /code-review.*disabled/s);

  // 5. uninstall + validation + batch sync + publish targets/sync status
  skills.setEnabled('code-review', true);
  assert.deepStrictEqual(skills.uninstall('write-docs').removed, 'write-docs');
  assert.throws(() => skills.install({ id: '!!!', body: 'x' }), /valid id/);
  assert.throws(() => skills.install({ id: 'nobody', body: '   ' }), /needs a body/);
  const batch = skills.installBatch([{ id: 'a', body: 'A' }, { id: 'b', body: 'B' }, { id: '@@', body: 'x' }]);
  assert.strictEqual(batch.installed, 2); assert.strictEqual(batch.failed, 1);
  assert.ok(skills.syncStatus().total >= 2);

  // 6. through the Grok compatibility surface (real, not stubbed)
  const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
  let env = await grokCompatService.dispatch('publishSkill', { id: 'compat-skill', name: 'Compat', description: 'd', body: 'body' });
  assert.strictEqual(env.status, 'ok'); assert.strictEqual(env.skill.id, 'compat-skill');
  env = await grokCompatService.dispatch('skillsCatalog', {});
  assert.ok(env.skills.some((x) => x.id === 'compat-skill'));
  env = await grokCompatService.dispatch('getPluginSyncStatus', {});
  assert.ok(env.total >= 1);
  env = await grokCompatService.dispatch('getSkillPublishTargets', {});
  assert.strictEqual(env.targets[0].target, 'local');
  env = await grokCompatService.dispatch('unpublishSkill', { id: 'compat-skill' });
  assert.ok(!skills.list().some((x) => x.id === 'compat-skill'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('skills test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
