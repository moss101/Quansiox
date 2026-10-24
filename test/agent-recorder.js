'use strict';
/* Agent-workflow recording test — the local record→replay pipeline. Exercises
 * the recorder manager, the auto-note integration in executeTool (fake computer
 * host), the saved artifact, and replay re-driving it. Gated: nothing recorded
 * unless record_start. Electron-free (fake computer proxy). */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-rectest-'));
process.env.QUANSIOX_USER_DATA_DIR = profile;

const { agentRecorder } = require('../src/coordinator/agentRecorder');
const { readArtifact, replayArtifact } = require('../src/coordinator/skill-recording');
const coordinator = require('../src/coordinator/index');
// The permission model is always on (2026-10-20 repair pass): a turn has to
// name a mode, and "permissive" no longer means "allow everything". This
// test is about the recorder, not about permissions, so it asks for the mode
// it needs: computer mode, no per-tool allowlist.
const permissive = { permissive: false, permissionMode: 'computer' };
const cwd = profile;

// fake computer host (installed into the coordinator's IPC proxy)
let hostCalls = [];
coordinator.installIpcComputerProxy(async (method, args) => {
  hostCalls.push([method, args]);
  if (method === 'screenshot') return { id: 'shot-1', data: 'data:image/png;base64,AA', width: 100, height: 100, coordinateToken: 'ct', frameHash: 'hh', screenChanged: false };
  return { ok: true, method, args };
});

async function run() {
  // 1. gated OFF by default: a computer action records nothing
  const out0 = await coordinator.executeTool('computer_click', { x: 1, y: 2, coordinate_token: 'ct' }, cwd, 's-norec', permissive);
  assert.strictEqual(agentRecorder.isRecording('s-norec'), false);
  assert.ok(!out0.type || out0.type !== '__image'); assert.notStrictEqual(out0, undefined);

  // 2. record_start → capture computer actions → record_stop → artifact
  const started = await coordinator.executeTool('record_start', {}, cwd, 's-rec', permissive);
  assert.match(String(started), /recording started/);
  assert.strictEqual(agentRecorder.isRecording('s-rec'), true);
  await coordinator.executeTool('computer_open_app', { name: 'Notes' }, cwd, 's-rec', permissive);
  await coordinator.executeTool('computer_click', { x: 12, y: 34, coordinate_token: 'ct' }, cwd, 's-rec', permissive);
  await coordinator.executeTool('computer_type', { text: 'hello' }, cwd, 's-rec', permissive);
  await coordinator.executeTool('computer_key', { key: 'Enter' }, cwd, 's-rec', permissive);
  await coordinator.executeTool('computer_screenshot', {}, cwd, 's-rec', permissive); // not a replayable step
  assert.strictEqual(agentRecorder.status('s-rec').steps, 4, 'only replayable actions recorded (screenshot skipped)');
  const stopMsg = await coordinator.executeTool('record_stop', {}, cwd, 's-rec', permissive);
  const id = /skill (\S+)/.exec(String(stopMsg))?.[1];
  assert.ok(id, 'record_stop returns a skill id');
  assert.strictEqual(agentRecorder.isRecording('s-rec'), false);

  // 3. the artifact persisted and is readable
  const artifact = readArtifact(id);
  assert.strictEqual(artifact.state, 'completed');
  assert.strictEqual(artifact.steps.length, 4);
  assert.deepStrictEqual([artifact.steps[0].kind, artifact.steps[1].kind, artifact.steps[2].kind, artifact.steps[3].kind], ['open_app', 'click', 'type', 'key']);

  // 4. replay re-drives the artifact as computer actions
  const hostActions = [];
  const host = async (method, args) => { hostActions.push([method, args]); return { frameHash: 'live-hash', coordinateToken: 'live-ct', screenChanged: false }; };
  const gate = { issueCoordinate: () => ({ token: 'gc', screenChanged: false }), requireCoordinate: () => null, issueSnapshot: () => ({ token: 'gs' }), requireSnapshot: () => null };
  const replay = await replayArtifact(artifact, gate, host);
  assert.ok(!replay.error, 'artifact is replayable');
  assert.ok(replay.actions.some((a) => a.tool === 'computer_click' && a.x === 12 && a.y === 34), 'click replayed at the recorded coords');
  assert.ok(replay.actions.some((a) => a.tool === 'computer_type' && a.text === 'hello'), 'type replayed');
  assert.ok(replay.actions.some((a) => a.tool === 'computer_open_app' && a.name === 'Notes'), 'open_app replayed');

  // 5. cancel discards; double-start/stop guarded
  await coordinator.executeTool('record_start', {}, cwd, 's-cancel', permissive);
  await coordinator.executeTool('computer_click', { x: 0, y: 0 }, cwd, 's-cancel', permissive);
  const cancelMsg = await coordinator.executeTool('record_cancel', {}, cwd, 's-cancel', permissive);
  assert.match(String(cancelMsg), /cancelled/);
  assert.match(String(await coordinator.executeTool('record_stop', {}, cwd, 's-cancel', permissive)), /record error: this session is not recording/);
  assert.match(String(await coordinator.executeTool('record_start', {}, cwd, 's-rec2', permissive)), /recording started/);
  assert.match(String(await coordinator.executeTool('record_start', {}, cwd, 's-rec2', permissive)), /record error: already recording|already has a recording/);
  await coordinator.executeTool('record_cancel', {}, cwd, 's-rec2', permissive);

  fs.rmSync(profile, { recursive: true, force: true });
  console.log('agent-recorder test: ALL OK');
}

run().catch((e) => { console.error(e); process.exit(1); });
