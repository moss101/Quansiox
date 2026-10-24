'use strict';
/* Support bundle — local, redacted diagnostics zip (docs troubleshooting). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-support-test-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const { settingsService } = require('../src/main/services/settingsService');
settingsService.save({ apiKey: 'sk-live-SECRET-abcdef', model: 'test-model', workspaceRoot: tmp, mcpServers: [{ name: 'x', command: 'node', env: { API_TOKEN: 'tok-123' } }] });
require('../src/main/services/diagnosticsService').diagnosticsService.record('test', { authorization: 'Bearer abc', note: 'plain', nested: { password: 'p' } });
require('../src/main/services/noticeService').noticeService.raise({ title: 'Test notice', body: 'boom', kind: 'error' });
const { sessionService } = require('../src/main/services/sessionService');
sessionService.ensure('sess-support');
sessionService.appendTurn('sess-support', { role: 'user', content: 'private transcript text' });

const { supportBundleService } = require('../src/main/services/supportBundleService');
const bundle = supportBundleService.create({ outDir: path.join(tmp, 'out') });
assert.ok(fs.existsSync(bundle.path));
assert.ok(bundle.bytes > 0);
// The bundle carries the reliability log (W7.7) alongside the diagnostics.
assert.deepEqual(bundle.files.sort(), ['README.txt', 'diagnostics.json', 'flags.json', 'manifest.json', 'notices.json', 'reliability.json', 'sessions.json', 'settings.json']);

const unzipped = path.join(tmp, 'unzipped');
fs.mkdirSync(unzipped);
const res = spawnSync('/usr/bin/ditto', ['-x', '-k', bundle.path, unzipped]);
assert.equal(res.status, 0);
const settings = JSON.parse(fs.readFileSync(path.join(unzipped, 'settings.json'), 'utf8'));
assert.notEqual(settings.apiKey, 'sk-live-SECRET-abcdef', 'api key scrubbed');
assert.equal(settings.apiKey.includes('SECRET'), false);
assert.equal(settings.mcpServers[0].env.API_TOKEN, '…', 'credential key scrubbed');
assert.equal(settings.model, 'test-model', 'non-secret settings preserved');
const diag = JSON.parse(fs.readFileSync(path.join(unzipped, 'diagnostics.json'), 'utf8'));
assert.equal(diag[0].detail.authorization, '…');
assert.equal(diag[0].detail.note, 'plain');
assert.equal(diag[0].detail.nested.password, '…');
const sessions = JSON.parse(fs.readFileSync(path.join(unzipped, 'sessions.json'), 'utf8'));
assert.equal(sessions[0].title, 'private transcript text');
assert.equal(JSON.stringify(sessions).includes('private transcript text'), true, 'title is included');
const raw = fs.readFileSync(path.join(unzipped, 'sessions.json'), 'utf8');
assert.equal(raw.includes('turns'), true);
assert.equal(raw.includes('"content"'), false, 'transcript bodies excluded');
const all = bundle.files.map((f) => fs.readFileSync(path.join(unzipped, f), 'utf8')).join('\n');
assert.equal(all.includes('sk-live-SECRET-abcdef'), false, 'secret never appears in the archive');
assert.equal(all.includes('tok-123'), false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('support-bundle test: ALL OK');
