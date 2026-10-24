'use strict';
/* Email connector test — SMTP send + IMAP search/fetch over an injected fake
 * transport that emits realistic byte frames (CRLF lines + {n} octet literals)
 * per client write. Caveat: frames are simulated, not a live server. Node-only. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mail-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp; // for config()/secrets
const { EventEmitter } = require('node:events');
const { emailService } = require('../src/main/services/emailService');
setTimeout(() => { console.error('email test timed out (protocol client stalled)'); process.exit(1); }, 15_000).unref?.();

// A fake duplex: emits `greeting` on construction, then pops the next scripted
// response buffer for each client write (order matches the protocol exchange).
function fakeDuplex(greeting, script) {
  const buf = Buffer.alloc(0);
  const d = new EventEmitter();
  d.write = (s) => {
    setTimeout(() => { const next = script.shift(); if (next != null) setImmediate(() => d.emit('data', Buffer.isBuffer(next) ? next : Buffer.from(String(next)))); }, 0);
    return true;
  };
  d.end = () => {};
  setImmediate(() => d.emit('data', Buffer.from(greeting)));
  return d;
}

async function run() {
  // ---- SMTP send ----
  const sent = [];
  emailService.setTransport({
    smtpConnect: (opts) => {
      sent.push({ opts, name: 'smtp' });
      return fakeDuplex('220 mail.example.test ESMTP ready\r\n', [
        '250-mail.example.test\r\n250-AUTH LOGIN\r\n250 OK\r\n', // EHLO
        '334 VXNlcm5hbWU6\r\n',                                  // AUTH LOGIN
        '334 UGFzc3dvcmQ6\r\n',                                  // user
        '235 2.7.0 Accepted\r\n',                                // pass
        '250 2.1.0 Ok\r\n',                                      // MAIL FROM
        '250 2.1.5 Ok\r\n',                                      // RCPT TO
        '354 End data with <CR><LF>.<CR><LF>\r\n',               // DATA
        '250 2.0.0 Ok: queued as Q1\r\n',                        // message body
        '221 2.0.0 Bye\r\n',                                     // QUIT
      ]);
    },
  });
  const r = await emailService.smtpSend({ host: 'mail.example.test', user: 'agent@example.test', pass: 'pw', from: 'agent@example.test', to: 'bob@example.test', subject: 'Hello', text: 'line1\nline2' });
  assert.strictEqual(r.accepted, true);
  assert.strictEqual(r.subject, 'Hello');
  assert.strictEqual(sent[0].opts.host, 'mail.example.test');
  assert.strictEqual(sent[0].opts.port, 465); // default secure smtps

  // ---- IMAP search + fetch (with a {n} literal body); search returns uids 3,7 ----
  const body = 'From: alice@example.test\r\nSubject: Build passed\r\nDate: Tue, 01 Jul 2025 10:00:00 +0000\r\n\r\nCI is green. All tests pass.';
  const bodyBytes = Buffer.byteLength(body);
  const body2 = 'From: bob@example.test\r\nSubject: Ping\r\nDate: Mon, 30 Jun 2025 09:00:00 +0000\r\n\r\njust checking in';
  const body2Bytes = Buffer.byteLength(body2);
  const fetchFrame = (tag, uid, b, n) => Buffer.concat([Buffer.from(`* ${uid} FETCH (FLAGS (\\Seen) RFC822 {${n}}\r\n`), Buffer.from(b), Buffer.from(`)\r\n${tag} OK FETCH done\r\n`)]);
  emailService.setTransport({
    imapConnect: () => fakeDuplex('* OK IMAP4rev1 ready\r\n', [
      `* CAPABILITY IMAP4rev1\r\nt1 OK LOGIN completed\r\n`,
      `* 3 EXISTS\r\n* 0 RECENT\r\nt2 OK [READ-WRITE] SELECT done\r\n`,
      `* SEARCH 3 7\r\nt3 OK SEARCH done\r\n`,
      fetchFrame('t4', 7, body, bodyBytes),  // most-recent-first fetch
      fetchFrame('t5', 3, body2, body2Bytes),
    ]),
  });
  const msgs = await emailService.imapSearch({ host: 'imap.example.test', user: 'agent@example.test', pass: 'pw', criteria: 'ALL', limit: 5 });
  assert.strictEqual(msgs.length, 2, 'two fetched messages');
  assert.strictEqual(msgs[0].uid, 7, 'most recent first');
  assert.strictEqual(msgs[0].subject, 'Build passed');
  assert.strictEqual(msgs[0].from, 'alice@example.test');
  assert.match(msgs[0].snippet, /CI is green/, 'literal body decoded + snippet');
  assert.strictEqual(msgs[1].subject, 'Ping');

  // garbled/edge: empty search → no messages
  emailService.setTransport({ imapConnect: () => fakeDuplex('* OK ready\r\n', ['* CAPABILITY IMAP4rev1\r\nt1 OK LOGIN\r\n', '* 0 EXISTS\r\nt2 OK SELECT\r\n', '* SEARCH\r\nt3 OK SEARCH\r\n']) });
  assert.deepStrictEqual(await emailService.imapSearch({ host: 'h', user: 'u', pass: 'p' }), []);

  // config resolution: unconfigured by default; settings + secret → resolved pass
  const { settingsService } = require('../src/main/services/settingsService');
  const { secretsService } = require('../src/main/services/secretsService');
  assert.deepStrictEqual(emailService.config(), { smtp: null, imap: null }, 'unconfigured by default');
  settingsService.save({ emailSmtp: { host: 'smtp.x.test', port: 465, secure: true, user: 'a@x.test', passwordSecret: 'mail_pw' }, emailImap: { host: 'imap.x.test', port: 993, secure: true, user: 'a@x.test', passwordSecret: 'mail_pw' } });
  secretsService.set('mail_pw', { password: 'app-pw' });
  const cfg = emailService.config();
  assert.strictEqual(cfg.smtp.host, 'smtp.x.test');
  assert.strictEqual(cfg.smtp.pass, 'app-pw', 'password pulled from the encrypted vault');
  assert.strictEqual(cfg.imap.pass, 'app-pw');

  console.log('email test: ALL OK (SMTP send + IMAP search/fetch over simulated frames)');
}

run().catch((e) => { console.error(e); process.exit(1); });
