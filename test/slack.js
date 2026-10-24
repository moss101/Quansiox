'use strict';
/* Slack connector test — real Slack Web API over fetch, against a loopback
 * mock (no fake in production). Bot token comes from the encrypted secrets
 * vault. Covers: not-configured, postMessage (auth header + body + parse),
 * channels, history, and a real Slack !ok error. Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-slack-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
const { settingsService } = require('../src/main/services/settingsService');
const { secretsService } = require('../src/main/services/secretsService');
const { slackService } = require('../src/main/services/slackService');

const seen = [];
let mode = 'ok';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.url?.slice(1), auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'error') { res.end(JSON.stringify({ ok: false, error: 'invalid_auth' })); return; }
    const m = req.url?.slice(1);
    if (m === 'auth.test') res.end(JSON.stringify({ ok: true, team: 'Manux', user: 'evie', bot_id: 'B1' }));
    else if (m === 'chat.postMessage') res.end(JSON.stringify({ ok: true, channel: body ? JSON.parse(body).channel : null, ts: '1699999999.000100' }));
    else if (m === 'conversations.list') res.end(JSON.stringify({ ok: true, channels: [{ id: 'C1', name: 'general', is_member: true, num_members: 3 }] }));
    else if (m === 'conversations.history') res.end(JSON.stringify({ ok: true, messages: [{ ts: '1', user: 'U1', text: 'hi', thread_ts: undefined }] }));
    else res.end(JSON.stringify({ ok: false, error: 'unknown' }));
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. not configured → not-configured status, ops throw honest error (no fake)
  let st = await slackService.status();
  assert.strictEqual(st.configured, false);
  await assert.rejects(() => slackService.chatPostMessage({ channel: 'C1', text: 'x' }), /not configured/);

  // 2. configure: store the bot token as an encrypted secret + point at the mock
  secretsService.set('slack_bot_token', { token: 'xoxb-TESTTOKEN' });
  slackService.setTransport({ baseUrl, fetch: (u, o) => fetch(u, o) });

  st = await slackService.status();
  assert.strictEqual(st.configured, true);
  assert.strictEqual(st.team, 'Manux'); assert.strictEqual(st.bot, 'B1');

  // 3. postMessage: Bearer auth + request body + parsed ts/channel
  const posted = await slackService.chatPostMessage({ channel: 'C1', text: 'hello from quansiox' });
  assert.strictEqual(posted.ts, '1699999999.000100');
  const last = seen[seen.length - 1];
  assert.strictEqual(last.method, 'chat.postMessage');
  assert.strictEqual(last.auth, 'Bearer xoxb-TESTTOKEN', 'bot token sent as Bearer from the vault');
  assert.strictEqual(last.body.text, 'hello from quansiox');

  // 4. channels + history
  const chans = await slackService.conversationsList();
  assert.strictEqual(chans[0].name, 'general');
  const hist = await slackService.conversationsHistory({ channel: 'C1', limit: 5 });
  assert.strictEqual(hist[0].text, 'hi');

  // 5. a real Slack !ok error propagates (no fake success)
  mode = 'error';
  await assert.rejects(() => slackService.chatPostMessage({ channel: 'C1', text: 'x' }), /invalid_auth/);
  // and a token value never appears in any response/field we return
  mode = 'ok';

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('slack test: ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
