'use strict';
/* Control handoff test — Take over / I'm done: the flag flips, every agent
 * computer action is refused with USER_TAKEOVER while active, and handing back
 * re-enables the gate. Node-only (electron-free paths). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-handoff-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { controlHandoff } = require('../src/main/services/controlHandoff');
const { computerUseService } = require('../src/main/services/computerUseService');
const { settingsService } = require('../src/main/services/settingsService');

async function run() {
  // Off by default.
  assert.strictEqual(controlHandoff.isActive(), false, 'handoff starts inactive');
  assert.strictEqual(computerUseService.isTakenOver(), false, 'service reflects the flag');

  // Opt in to computer use so the only gate under test is the handoff.
  settingsService.save({ allowComputerUse: true });

  // Take over → agent actions refuse with the taxonomy token.
  const set = controlHandoff.setActive(true);
  assert.deepStrictEqual(set, { active: true });
  assert.strictEqual(controlHandoff.isActive(), true);
  await assert.rejects(() => computerUseService.screenshot(), /USER_TAKEOVER/, 'screenshot refused during take-over');
  await assert.rejects(() => computerUseService.listApps(), /USER_TAKEOVER/, 'host ops refused during take-over');

  // I'm done → the flag clears (no helper is spawned in this node-only test;
  // refusal-clearing is exercised through the flag the gate reads).
  controlHandoff.setActive(false);
  assert.strictEqual(controlHandoff.isActive(), false);
  assert.strictEqual(computerUseService.isTakenOver(), false, 'service reflects hand-back');

  // Disabled gate still wins when computer use is off.
  settingsService.save({ allowComputerUse: false });
  await assert.rejects(() => computerUseService.screenshot(), /disabled/, 'opt-in gate still enforced');

  // Recover: restart() re-arms supervision without spawning anything.
  const { computerHostService } = require('../src/main/services/computerHostService');
  assert.strictEqual(computerHostService.restart(), true, 'restart() returns true');
  assert.strictEqual(computerHostService.status().running, false, 'no helper spawned by restart');

  console.log('control handoff test: ALL OK');
}
run().catch((error) => { console.error(error); process.exit(1); });
