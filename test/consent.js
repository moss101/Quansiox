'use strict';
/* Consent test — local standing tool-permission grants (Grok local tool
 * permissions): store CRUD + the backward-compatible guardTool integration
 * (deny hard-blocks even permissive; allow overrides gates; no grant → unchanged)
 * + Grok compat routing. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-consent-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const consent = require('../src/main/services/consentService').consentService;
const { guardTool } = require('../src/coordinator/permissions');

// ---- store ----
assert.strictEqual(consent.getGrant('*', 'shell'), undefined, 'no grant by default');
assert.deepStrictEqual(consent.listGrants(), []);
consent.setGrant('*', 'write_file', 'deny');
assert.strictEqual(consent.getGrant('*', 'write_file'), 'deny');
consent.setGrant('s1', 'browser_open', 'allow');
assert.strictEqual(consent.getGrant('s1', 'browser_open'), 'allow');
assert.strictEqual(consent.getGrant('*', 'browser_open'), undefined, 'grants are scope-local');
assert.strictEqual(consent.listGrants().length, 2);
// wildcard subject under a scope
consent.setGrant('s1', '*', 'allow');
assert.strictEqual(consent.getGrant('s1', 'computer_click'), 'allow', 'wildcard subject grant falls through');
assert.throws(() => consent.setGrant('*', 'shell', 'maybe'), /allow' or 'deny/);
assert.throws(() => consent.setGrant('bad scope!', 'shell', 'allow'), /invalid scope/);
// 0600 at rest
assert.strictEqual(fs.statSync(path.join(tmp, 'consent.json')).mode & 0o777, 0o600, 'consent file is 0600');

// clear the global write_file deny from the store section so the guard checks
// below start from a clean (no-grant) baseline
consent.revokeGrant('*', 'write_file');

const PERMISSIVE = { permissive: true };
const READ_ONLY = { permissive: false, permissionMode: 'read-only', enableFileMutation: false, allowlist: ['read_file', 'list_dir', 'shell', 'write_file'] };
const WORKSPACE = { permissive: false, permissionMode: 'workspace', enableFileMutation: true, allowlist: ['read_file', 'shell'] };

// ---- backward compatibility: no grant → identical behavior ----
assert.strictEqual(guardTool('shell', { command: 'echo hi' }, PERMISSIVE), null, 'permissive allows shell (no consent)');
assert.ok(/read-only subagent cannot write/.test(guardTool('write_file', { path: 'x', content: 'y' }, READ_ONLY) || ''), 'read-only refusal intact');
assert.ok(/not in this subagent's tool allowlist/.test(guardTool('write_file', { path: 'x' }, WORKSPACE) || ''), 'allowlist refusal intact');

// ---- a global 'write_file' deny overrides everything, incl permissive ----
consent.setGrant('*', 'write_file', 'deny');
assert.ok(/standing denial/.test(guardTool('write_file', { path: 'x', content: 'y' }, PERMISSIVE) || ''), 'deny overrides a permissive turn');
assert.ok(/standing denial/.test(guardTool('write_file', { path: 'x' }, WORKSPACE) || ''), 'deny overrides a workspace turn');
// a different tool is unaffected by the write_file denial
assert.strictEqual(guardTool('shell', { command: 'echo hi' }, PERMISSIVE), null, 'other tools unaffected by a tool-scoped deny');

// ---- revoke deny, then grant allow: allows lifts the gate ----
consent.revokeGrant('*', 'write_file');
assert.ok(/read-only subagent cannot write/.test(guardTool('write_file', { path: 'x', content: 'y' }, READ_ONLY) || ''), 'revoked → refusal returns');
consent.setGrant('*', 'write_file', 'allow');
assert.strictEqual(guardTool('write_file', { path: 'x', content: 'y' }, READ_ONLY), null, 'allow overrides read-only');
assert.strictEqual(guardTool('write_file', { path: 'x', content: 'y' }, WORKSPACE), null, 'allow overrides allowlist');

// ---- Grok compat surface ----
(async () => {
  const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
  let env = await grokCompatService.dispatch('setLocalToolPermission', { scope: '*', subject: 'computer_click', mode: 'deny' });
  assert.strictEqual(env.status, 'ok'); assert.strictEqual(env.mode, 'deny');
  env = await grokCompatService.dispatch('getLocalToolPermission', { subject: 'computer_click' });
  assert.strictEqual(env.mode, 'deny');
  env = await grokCompatService.dispatch('resolveLocalToolPermission', { subject: 'computer_click' });
  assert.strictEqual(env.mode, 'deny');
  env = await grokCompatService.dispatch('recordLocalToolStandingGrant', { subject: 'computer_click' });
  assert.strictEqual(env.mode, 'allow');
  assert.strictEqual(consent.getGrant('*', 'computer_click'), 'allow', 'standing grant recorded as allow');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('consent test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
