'use strict';
/* Headless robustness.
 *
 * Quansiox runs in a lot of places that are not the Electron window: the
 * coordinator, the exec daemon, the CLI helpers and the tests. A service
 * that asks Electron for the user data directory crashes there, and one
 * broken service takes down everything that imports it.
 *
 * This test proves:
 *  - the user data directory has one answer everywhere (override → Electron
 *    → the conventional per-user directory);
 *  - every service that keeps state works without Electron;
 *  - the whole Grok-compatible local surface answers outside Electron —
 *    no "Cannot read properties of undefined (reading 'getPath')".
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-headless-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { userDataDir, userDataPath, electronApp } = require('../src/main/services/userData');

// 1. the override wins
assert.equal(userDataDir(), tmp);
assert.equal(userDataPath('a', 'b'), path.join(tmp, 'a', 'b'));

// 2. without an override and without Electron, the conventional directory
//    is used (never a crash)
const savedOverride = process.env.QUANSIOX_USER_DATA_DIR;
delete process.env.QUANSIOX_USER_DATA_DIR;
assert.equal(electronApp(), null, 'this process is not Electron');
const fallback = userDataDir();
assert.ok(path.isAbsolute(fallback));
assert.ok(fallback.endsWith('Quansiox'), fallback);
process.env.QUANSIOX_USER_DATA_DIR = savedOverride;

// 3. the services that keep state all work
const services = [
  'settingsService', 'sessionService', 'memoryService', 'consentService',
  'documentsService', 'secretsService', 'flagsService', 'hostPrefsService',
  'agentSkillsService', 'agentPluginsService', 'skillsService', 'addonService',
  'automationService', 'templateService', 'installIdService', 'diagnosticsService',
  'cookieImportService', 'attachmentService', 'sessionExtrasService', 'vaultService',
  'boxSecretService', 'agentFilesService', 'restoreService', 'supportBundleService',
  'userInteractionService', 'meetingService', 'artifactService', 'canvasService',
  'vmSnapshotService', 'voiceCallService', 'voiceSessionService', 'ecosystemService',
];
for (const name of services) {
  const module = require(`../src/main/services/${name}.js`);
  const service = module[name];
  assert.ok(service, `${name} exports its service`);
  assert.equal(typeof service, 'object', `${name} is an object`);
}

// 4. the whole Grok-compatible local surface answers outside Electron
(async () => {
  const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
  const catalog = grokCompatService.catalog();
  // A few methods start real work (an agent turn, a task); they are
  // covered by their own tests and would keep this one alive.
  const sideEffects = new Set([
    'agent.run', 'tasks.start', 'tasks.interrupt', 'kickstartAgent',
    'sendPrompt', 'interruptAgentRun', 'retry', 'startTeachRecording',
    'runAgentAutomationNow', 'runAgentWorkflowNow', 'relaunchDesktop',
  ]);
  const environmentErrors = [];
  for (const method of catalog.methods.filter((m) => m.impl === 'local' && !sideEffects.has(m.handler))) {
    let result = null;
    try {
      result = await grokCompatService.dispatch(method.method, {});
    } catch (error) {
      environmentErrors.push(`${method.method} :: THREW ${String(error?.message ?? error)}`);
      continue;
    }
    if (result?.status !== 'error') continue;
    const message = String(result.error ?? result.reason ?? '');
    // A missing parameter is a legitimate error; a missing Electron is not.
    // An honest "this needs the desktop app" is a fine answer; a crash is
    // not.
    if (/getPath|BrowserWindow is not|showOpenDialog|Cannot read properties of undefined/.test(message)) {
      environmentErrors.push(`${method.method} :: ${message}`);
    }
  }
  if (environmentErrors.length) console.log('ENV ERRORS:', environmentErrors.join('\n'));
  assert.deepEqual(environmentErrors, [], 'no method depends on the Electron main process');

  // The sweep started a local exec daemon and a sandbox — stop them, so the
  // test does not leave processes behind.
  try { require('../src/main/services/execDaemonService').execDaemonService.stopLocalExecDaemon(); } catch {}
  try { require('../src/main/services/sandboxService').sandboxService.stop?.('*'); } catch {}

  console.log(`headless test: ALL OK (user data path/services/no-Electron surface of ${catalog.local} local methods)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
