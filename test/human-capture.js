'use strict';
/* Human demonstration capture (GPA G3): native helper NDJSON → SkillRecorder
 * artifact. Uses a fake Node helper over a real Unix socket (the native tap
 * itself is permission/hardware-gated). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-human-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const helper = path.join(tmp, 'fake-helper.js');
fs.writeFileSync(helper, `#!/usr/bin/env node
const net = require('node:net');
const socket = process.argv[2];
const client = net.createConnection(socket, () => {
  client.write(JSON.stringify({ type: 'ready' }) + '\\n');
  setTimeout(() => {
    client.write(JSON.stringify({ type: 'click', x: 120, y: 240, button: 0, clickCount: 1 }) + '\\n');
    client.write(JSON.stringify({ type: 'key', keyCode: 4, text: 'h', modifiers: [] }) + '\\n');
    client.write(JSON.stringify({ type: 'key', keyCode: 5, text: 'i', modifiers: [] }) + '\\n');
    client.write(JSON.stringify({ type: 'key', keyCode: 36, text: '\\r', modifiers: [] }) + '\\n');
    client.write(JSON.stringify({ type: 'scroll', x: 300, y: 320, deltaY: -3 }) + '\\n');
  }, 60);
});
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
process.env.QUANSIOX_CAPTURE_HELPER = helper;

const { humanCaptureService } = require('../src/main/services/humanCaptureService');
const { readArtifact } = require('../src/coordinator/skill-recording');

(async () => {
  // helper discovery + status
  assert.equal(humanCaptureService.helperPath(), helper);
  assert.deepEqual(humanCaptureService.status(), { recording: false, steps: 0 });

  await humanCaptureService.start({ sessionId: 'sess-demo' });
  assert.equal(humanCaptureService.status().recording, true);
  await new Promise((r) => setTimeout(r, 250));
  const result = humanCaptureService.stop();
  assert.equal(result.state, 'completed');
  assert.equal(result.steps, 4, 'click + typed run + Return + scroll');
  const artifact = readArtifact(result.id);
  assert.deepEqual(artifact.steps.map((s) => s.kind), ['click', 'type', 'key', 'scroll']);
  assert.equal(artifact.steps[0].x, 120);
  assert.equal(artifact.steps[0].y, 240);
  assert.equal(artifact.steps[1].text, 'hi', 'printable keys coalesce into one type step');
  assert.equal(artifact.steps[2].key, 'Return');
  assert.equal(artifact.steps[3].deltaY, -3);

  // cancel leaves no artifact and stops the helper
  await humanCaptureService.start({ sessionId: 'sess-demo-2' });
  assert.deepEqual(humanCaptureService.cancel(), { cancelled: true });
  assert.equal(humanCaptureService.status().recording, false);
  assert.throws(() => humanCaptureService.stop(), /no demonstration/);
  await assert.rejects(() => humanCaptureService.start({}), /session is required/);

  // a helper that cannot get permission reports honestly and start fails
  const failing = path.join(tmp, 'failing-helper.js');
  fs.writeFileSync(failing, `#!/usr/bin/env node
process.stderr.write('Accessibility permission is required');
process.exit(73);
`);
  process.env.QUANSIOX_CAPTURE_HELPER = failing;
  await assert.rejects(() => humanCaptureService.start({ sessionId: 'sess-fail' }), /exited before ready|Accessibility/);
  assert.equal(humanCaptureService.status().recording, false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('human-capture test: ALL OK');
})().catch((error) => { console.error(error); process.exit(1); });
