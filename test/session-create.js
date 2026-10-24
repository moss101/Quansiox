'use strict';
/* Create New Bot — a named session is created up front (Grok's Create New Bot
 * dialog), not on the first message. Covers defaults, profile fields, list
 * visibility, and id validation. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-create-user-'));
process.env.QUANSIOX_USER_DATA_DIR = userData;
const { sessionService } = require('../src/main/services/sessionService');

const created = sessionService.create({ title: 'jack', label: 'inbox', description: 'keeps my inbox under control' });
assert.ok(created.id, 'create returns an id');
assert.strictEqual(created.title, 'jack');
assert.strictEqual(created.label, 'inbox');
assert.strictEqual(created.description, 'keeps my inbox under control');

const loaded = sessionService.get(created.id);
assert.strictEqual(loaded.title, 'jack');
assert.deepStrictEqual(loaded.turns, [], 'a new bot starts empty');

const listed = sessionService.list().find((row) => row.id === created.id);
assert.ok(listed, 'new bot appears in the sidebar list');
assert.strictEqual(listed.title, 'jack');

const plain = sessionService.create({});
assert.strictEqual(plain.title, 'New Bot', 'untitled creation defaults to New Bot');
assert.notStrictEqual(plain.id, created.id, 'each bot gets its own id');

assert.throws(() => sessionService.create({ id: '../escape' }), /invalid session id/);

fs.rmSync(userData, { recursive: true, force: true });
console.log('session-create test: ALL OK');
