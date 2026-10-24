'use strict';
/* Webhook server test — loopback HTTP: valid token → 202 accepted, bad token →
 * 403, unknown → 404, wrong path → 404, GET works, wrong method → 405. Uses a
 * fake dispatch (the real automation run is covered by test/automation.js).
 * Node-only. */
const assert = require('node:assert/strict');
const { webhookServer } = require('../src/main/services/webhookServer');

const GOOD = 'a'.repeat(64);
const BAD = 'b'.repeat(64);

async function run() {
  webhookServer.start(async (id, token) => {
    if (id === 'missing') { const e = new Error('unknown automation'); e.status = 404; throw e; }
    if (token !== GOOD) { const e = new Error('invalid webhook token'); e.status = 403; throw e; }
    return { id, status: 'ok', summary: 'ran nightly build' };
  });
  const base = await webhookServer.ensureStarted();
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(base), 'loopback base url');

  // valid → 202 accepted
  let res = await fetch(`${base}/hook/auto1/${GOOD}`, { method: 'POST' });
  assert.strictEqual(res.status, 202);
  let body = await res.json();
  assert.strictEqual(body.status, 'accepted'); assert.strictEqual(body.id, 'auto1');
  assert.strictEqual(body.result.summary, 'ran nightly build');

  // GET also accepted
  res = await fetch(`${base}/hook/auto1/${GOOD}`);
  assert.strictEqual(res.status, 202, 'GET accepted');

  // bad token → 403
  res = await fetch(`${base}/hook/auto1/${BAD}`, { method: 'POST' });
  assert.strictEqual(res.status, 403); assert.strictEqual((await res.json()).status, 'rejected');

  // unknown automation → 404
  res = await fetch(`${base}/hook/missing/${GOOD}`, { method: 'POST' });
  assert.strictEqual(res.status, 404);

  // wrong path → 404
  res = await fetch(`${base}/nope`, { method: 'POST' });
  assert.strictEqual(res.status, 404);

  // wrong method → 405
  res = await fetch(`${base}/hook/auto1/${GOOD}`, { method: 'DELETE' });
  assert.strictEqual(res.status, 405);

  webhookServer.stop();
  console.log('webhook-server test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
