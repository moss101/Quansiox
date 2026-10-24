'use strict';
/* Projects test — the local-first implementation of Manus' "Projects".
 *
 * Covers the whole documented behaviour that matters:
 *   - CRUD, pin, drag-and-drop ordering (PRJ-01/02/07/08);
 *   - master instruction (PRJ-03) and knowledge base (PRJ-04);
 *   - config inheritance into a new task (PRJ-05/06);
 *   - the propagation asymmetry: the instruction is LIVE (PRJ-18) while the
 *     file set is FROZEN at task creation (PRJ-19);
 *   - moving an existing task into a project (PRJ-20);
 *   - the sidebar task filters (PRJ-09..12);
 *   - the collaborator roster and the default-deny privacy (PRJ-13..17);
 *   - the project_knowledge agent tool;
 *   - unlimited projects (PRJ-21) and blob garbage collection.
 * Electron-free: the real service and the real coordinator run here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-projects-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const { projectService } = require('../src/main/services/projectService');
const { sessionService } = require('../src/main/services/sessionService');
const coordinator = require('../src/coordinator/index');
const permissive = { permissive: true };
const cwd = tmp;

async function run() {
  /* -- 1. CRUD ---------------------------------------------------------- */
  assert.deepStrictEqual(projectService.list(), []);
  // A task that belongs to no project at all.
  sessionService.ensure('proj-task-3');
  const project = projectService.create({ name: 'Weekly Reports', masterInstruction: 'Always end with a bullet summary.' });
  assert.ok(project.id.startsWith('prj_'));
  assert.strictEqual(project.name, 'Weekly Reports');
  assert.strictEqual(project.pinned, false);
  assert.strictEqual(project.private, true, 'projects are private by default (PRJ-14)');
  assert.strictEqual(project.files.length, 0);
  assert.strictEqual(projectService.get(project.id).name, 'Weekly Reports');
  assert.strictEqual(projectService.get('nope'), null);
  assert.throws(() => projectService.create({ name: '   ' }), /name required/);

  /* -- 2. unlimited projects (PRJ-21) ----------------------------------- */
  for (let i = 0; i < 25; i += 1) projectService.create({ name: `Project ${i}` });
  assert.strictEqual(projectService.list().length, 26, 'no hard quota on project count');

  /* -- 3. pin + drag-and-drop ordering (PRJ-07/08) ---------------------- */
  const list = projectService.list();
  const ids = list.map((p) => p.id);
  projectService.setPinned(project.id, true);
  assert.strictEqual(projectService.list()[0].id, project.id, 'pinned projects stay on top');
  // Drag-and-drop: move the last project to the front of the manual order.
  const tail = projectService.list().filter((p) => !p.pinned).map((p) => p.id);
  const moved = [tail[tail.length - 1], ...tail.slice(0, -1)];
  projectService.reorder(moved);
  const after = projectService.list().filter((p) => !p.pinned).map((p) => p.id);
  assert.deepStrictEqual(after, moved, 'manual order is persisted exactly');

  /* -- 4. knowledge base (PRJ-04) --------------------------------------- */
  const added = projectService.addFiles(project.id, [
    { name: 'notes.md', content: '# Q1 notes\nRevenue is up.' },
    { name: 'data.csv', content: 'a,b\n1,2' },
  ]);
  assert.strictEqual(added.added.length, 2);
  assert.strictEqual(added.project.files.length, 2);
  const mdId = added.added.find((f) => f.name === 'notes.md').id;
  const read = projectService.readFile(project.id, mdId);
  assert.match(read.text, /Revenue is up/);
  assert.strictEqual(read.binary, false);
  // A binary file is refused as text rather than mangled.
  projectService.addFiles(project.id, [{ name: 'logo.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }]);
  const png = projectService.readFile(project.id, projectService.get(project.id).files.find((f) => f.name === 'logo.png').id);
  assert.strictEqual(png.binary, true);
  assert.strictEqual(png.text, null);

  /* -- 5. the propagation asymmetry (PRJ-18 / PRJ-19) ------------------- */
  const taskId = 'proj-task-1';
  sessionService.ensure(taskId);
  sessionService.assignProject(taskId, project.id);
  const config = projectService.taskConfig(sessionService.get(taskId));
  assert.strictEqual(config.projectId, project.id);
  assert.strictEqual(config.files.length, 3, 'the task froze the file set at join time');
  assert.match(config.instruction, /bullet summary/);

  // (a) An INSTRUCTION edit is live: the current task sees it immediately.
  projectService.update(project.id, { masterInstruction: 'Now answer in French.' });
  const liveConfig = projectService.taskConfig(sessionService.get(taskId));
  assert.match(liveConfig.instruction, /French/, 'instruction updates apply to the current task (PRJ-18)');
  assert.strictEqual(liveConfig.files.length, 3);

  // (b) A FILE upload does NOT reach the current task (PRJ-19).
  projectService.addFiles(project.id, [{ name: 'later.md', content: 'added after the task started' }]);
  const afterFile = projectService.taskConfig(sessionService.get(taskId));
  assert.strictEqual(afterFile.files.length, 3, 'file updates do not reach existing tasks (PRJ-19)');
  assert.ok(!afterFile.files.some((f) => f.name === 'later.md'));
  assert.strictEqual(projectService.get(project.id).files.length, 4, 'but the project itself has it');

  // (c) A NEW task in the project does see the new file.
  const task2 = 'proj-task-2';
  sessionService.ensure(task2);
  sessionService.assignProject(task2, project.id);
  const newConfig = projectService.taskConfig(sessionService.get(task2));
  assert.strictEqual(newConfig.files.length, 4, 'new tasks follow the new configuration');
  assert.ok(newConfig.files.some((f) => f.name === 'later.md'));

  // (d) The frozen blob still has its old bytes for the old task.
  const oldRead = projectService.readFile(project.id, mdId);
  assert.match(oldRead.text, /Revenue is up/);

  /* -- 6. the prompt block (PRJ-05) ------------------------------------- */
  const block = projectService.promptBlock(sessionService.get(taskId));
  assert.match(block, /Weekly Reports/);
  // The instruction in the block is the LIVE one (it was edited in step 5a).
  assert.match(block, /French/);
  assert.match(block, /notes\.md/);
  assert.doesNotMatch(block, /later\.md/, 'the prompt lists the frozen file set only');
  // A task outside any project gets nothing.
  assert.strictEqual(projectService.promptBlock(sessionService.get('proj-task-3')), '');

  /* -- 7. the project_knowledge agent tool ------------------------------ */
  const listed = String(await coordinator.executeTool('project_knowledge', {}, cwd, taskId, permissive));
  assert.match(listed, /notes\.md/);
  assert.doesNotMatch(listed, /later\.md/, 'the tool sees the frozen file set too');
  const body = String(await coordinator.executeTool('project_knowledge', { file_id: mdId }, cwd, taskId, permissive));
  assert.match(body, /Revenue is up/);
  const none = String(await coordinator.executeTool('project_knowledge', {}, cwd, 'proj-task-3', permissive));
  assert.match(none, /does not belong to a project/);

  /* -- 8. moving an existing task into a project (PRJ-20) ---------------- */
  const moving = 'proj-task-move';
  sessionService.ensure(moving);
  assert.strictEqual(projectService.taskConfig(sessionService.get(moving)), null);
  sessionService.assignProject(moving, project.id);
  assert.strictEqual(sessionService.get(moving).projectId, project.id);
  assert.ok(sessionService.list().some((s) => s.id === moving && s.projectId === project.id));
  // And back out again.
  sessionService.assignProject(moving, null);
  assert.strictEqual(sessionService.get(moving).projectId, undefined);
  assert.throws(() => sessionService.assignProject(moving, 'no-such-project'), /project not found/);

  /* -- 9. the sidebar task filters (PRJ-09..12) ------------------------- */
  const tasks = sessionService.list();
  const standalone = projectService.filterTasks(tasks, 'standalone');
  assert.ok(standalone.every((t) => !t.projectId));
  assert.ok(standalone.length < tasks.length);
  assert.strictEqual(projectService.filterTasks(tasks, 'all').length, tasks.length);
  sessionService.update(task2, { favorite: true });
  const favorites = projectService.filterTasks(sessionService.list(), 'favorites');
  assert.deepStrictEqual(favorites.map((t) => t.id), [task2]);
  const scheduled = projectService.filterTasks(sessionService.list(), 'scheduled', { scheduledSessionIds: [taskId] });
  assert.deepStrictEqual(scheduled.map((t) => t.id), [taskId]);

  /* -- 10. collaborators (PRJ-13..17) ----------------------------------- */
  const withCollab = projectService.addCollaborator(project.id, { name: 'ada' });
  assert.strictEqual(withCollab.collaborators.length, 1);
  assert.strictEqual(withCollab.collaborators[0].id, 'ada');
  assert.throws(() => projectService.addCollaborator(project.id, { name: '' }), /collaborator name required/);
  const removed = projectService.removeCollaborator(project.id, 'ada');
  assert.strictEqual(removed.collaborators.length, 0);

  /* -- 11. removing a project ------------------------------------------- */
  const doomed = projectService.create({ name: 'Doomed' });
  projectService.addFiles(doomed.id, [{ name: 'x.txt', content: 'x' }]);
  assert.strictEqual(projectService.remove(doomed.id).removed, true);
  assert.strictEqual(projectService.get(doomed.id), null);
  assert.strictEqual(projectService.remove(doomed.id).removed, false);

  /* -- 12. blob garbage collection -------------------------------------- */
  const gcProject = projectService.create({ name: 'GC' });
  projectService.addFiles(gcProject.id, [{ name: 'keep.txt', content: 'keep' }]);
  const keepId = projectService.get(gcProject.id).files[0].id;
  const gcSession = 'gc-task';
  sessionService.ensure(gcSession);
  sessionService.assignProject(gcSession, gcProject.id);
  // Replace the file: the old blob is no longer in the project's current set.
  projectService.addFiles(gcProject.id, [{ name: 'keep.txt', content: 'replaced' }]);
  const snapshot = sessionService.get(gcSession).projectConfigSnapshot;
  assert.strictEqual(snapshot.files[0].id, keepId, 'the snapshot still points at the old blob');
  const newId = projectService.get(gcProject.id).files[0].id;
  assert.notStrictEqual(newId, keepId, 'the replacement is a new immutable blob');

  // A blob a task snapshot still references is NOT garbage.
  const kept = projectService.gc([snapshot]);
  assert.strictEqual(kept.removed, 0, 'a snapshotted blob is kept alive');
  assert.ok(fs.existsSync(projectService._blobPath(gcProject.id, keepId)));
  assert.strictEqual(projectService.readFile(gcProject.id, keepId).text, 'keep', 'and it still reads with its old bytes');

  // Once no snapshot references it, the old blob is reclaimable.
  sessionService.assignProject(gcSession, null);
  const collected = projectService.gc([]);
  assert.ok(collected.removed >= 1, 'the orphaned blob is reclaimed');
  assert.ok(!fs.existsSync(projectService._blobPath(gcProject.id, keepId)), 'the old blob is gone');
  assert.ok(fs.existsSync(projectService._blobPath(gcProject.id, newId)), 'the current blob is kept');

  /* -- 13. store hygiene ------------------------------------------------ */
  const storePath = path.join(tmp, 'projects.json');
  assert.strictEqual(fs.statSync(storePath).mode & 0o777, 0o600, 'the project store is 0600');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('projects test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
