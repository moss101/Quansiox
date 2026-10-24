'use strict';
/* Confirmation service test — interactive tool-approval: request→respond
 * resolves, deny resolves false, timeout fails closed, unknown → false, and the
 * gated set covers the risky tools. Node-only. */
const assert = require('node:assert/strict');
const { confirmationService } = require('../src/main/services/confirmationService');

const { request, respond, isGated, list } = confirmationService;

async function run() {
  // gated set
  for (const t of ['shell', 'write_file', 'submit_secret', 'computer_click', 'github_pr_create', 'slack_post_message', 'email_send']) {
    assert.strictEqual(isGated(t), true, `${t} is gated`);
  }
  for (const t of ['read_file', 'list_dir', 'recall', 'list_secrets', 'computer_screenshot']) {
    assert.strictEqual(isGated(t), false, `${t} is not gated`);
  }

  // request → approve
  const a = request('s1', 'write_file', { path: 'x.js', content: 'x' }, '/ws', 5000);
  assert.strictEqual(respond(a.id, true), true);
  assert.strictEqual(await a.promise, true, 'approve resolves true');

  // request → deny
  const d = request('s1', 'shell', { command: 'rm -rf x' }, '/ws', 5000);
  assert.strictEqual(respond(d.id, false), true);
  assert.strictEqual(await d.promise, false, 'deny resolves false');

  // respond to an unknown/stale id → false, no throw
  assert.strictEqual(respond('cfm_999', true), false);

  // timeout → fail closed (deny) + troubleshooting notice with request ID
  const t = request('s1', 'shell', { command: 'sleep 60' }, '/ws', 60);
  assert.strictEqual(await t.promise, false, 'timeout resolves false (fail closed)');
  assert.strictEqual(list().length, 0, 'no pending after timeout');
  const { noticeService } = require('../src/main/services/noticeService');
  const notice = noticeService.list().find((n) => /Approval timed out/.test(n.title));
  assert.ok(notice, 'timeout raises a notice');
  assert.match(notice.requestId, /^req_/, 'notice carries a request ID');
  noticeService.clear();

  console.log('confirmation test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
