'use strict';
/* Bot profile metadata (docs: edit profile) — name, label, description. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-profile-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { sessionService } = require('../src/main/services/sessionService');

const id = 'sess_profile_1';
sessionService.ensure(id);
let updated = sessionService.update(id, {
  title: 'Release manager',
  label: 'CI/CD',
  description: 'Owns release notes and deploys for project atlas.',
});
assert.equal(updated.title, 'Release manager');
assert.equal(updated.label, 'CI/CD');
assert.equal(updated.description, 'Owns release notes and deploys for project atlas.');

const loaded = sessionService.get(id);
assert.equal(loaded.label, 'CI/CD', 'profile persists on the session');
assert.equal(loaded.description, 'Owns release notes and deploys for project atlas.');

const listed = sessionService.list().find((s) => s.id === id);
assert.equal(listed.label, 'CI/CD', 'sidebar metadata carries the label');
assert.equal(listed.description.startsWith('Owns release'), true);

// bounds: label 60, description 400
sessionService.update(id, { label: 'x'.repeat(80), description: 'y'.repeat(450) });
const capped = sessionService.get(id);
assert.equal(capped.label.length, 60, 'label capped');
assert.equal(capped.description.length, 400, 'description capped');

// partial updates leave other fields alone
sessionService.update(id, { muted: true });
const afterMute = sessionService.get(id);
assert.equal(afterMute.label.length, 60, 'label preserved');
assert.equal(afterMute.description.length, 400, 'description preserved');
assert.equal(afterMute.muted, true);

// duplicate copies the profile and resets sidebar flags
const copy = sessionService.duplicate(id);
assert.match(copy.title, /\(copy\)$/);
assert.equal(sessionService.get(copy.id).label.length, 60, 'duplicate keeps the label');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('session-profile test: ALL OK');
