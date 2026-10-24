'use strict';
/* Webhook service test — POST|GET /hook/:id/:token triggers an automation;
 * timingSafe token verification (403 on bad token), 404 on unknown id, and the
 * injected runner is actually invoked. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-hook-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { automationService } = require('../src/main/services/automationService');
const { webhookService } = require('../src/main/services/webhookService');

(async () => {
  // fake runner records triggering
  const triggered = [];
  automationService.setRunner(async (sid, msg) => { triggered.push([sid, msg]); return 'ran'; });

  const port = await webhookService.ensureStarted();
  assert.ok(port > 0, 'loopback port assigned');

  const auto = automationService.create({ sessionId: 'hook-sess', prompt: 'nightly build' });
  const { url, id } = await webhookService.webhookUrl(auto.id);
  assert.ok(url.startsWith(`http://127.0.0.1:${port}/hook/${auto.id}/`), 'webhook url built');

  // 1. valid token triggers the automation (runner invoked)
  const ok = await fetch(url, { method: 'POST' });
  assert.strictEqual(ok.status, 202, 'valid webhook → 202 Accepted');
  assert.strictEqual((await ok.json()).status, 'accepted');
  await new Promise((r) => setTimeout(r, 80)); // fire-and-forget run completes
  assert.strictEqual(triggered.length, 1, 'automation ran once');
  assert.deepStrictEqual(triggered[0], ['hook-sess', 'nightly build']);
  assert.strictEqual(automationService.get(auto.id).runCount, 1, 'run recorded');

  // 2. wrong token → 403 (no run)
  const bad = await fetch(`http://127.0.0.1:${port}/hook/${auto.id}/${'a'.repeat(64)}`, { method: 'POST' });
  assert.strictEqual(bad.status, 403, 'bad token → 403');
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(triggered.length, 1, 'no run on bad token');

  // 3. unknown automation → 404
  const missing = await fetch(`http://127.0.0.1:${port}/hook/nope_123/${'b'.repeat(64)}`, { method: 'POST' });
  assert.strictEqual(missing.status, 404, 'unknown automation → 404');

  // 4. GET also works (webhook-friendly)
  const get = await fetch(url, { method: 'GET' });
  assert.ok([200, 202].includes(get.status), 'GET accepted');

  webhookService.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('webhook test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
