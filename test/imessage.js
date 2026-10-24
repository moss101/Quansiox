'use strict';
/* iMessage chat.db reader + Messages send: read-only sqlite path, attributedBody
 * decode, Apple-epoch conversion, FDA/missing codes, and the sendMessage
 * allowlist/length/escaping gates. Electron-free; builds a synthetic chat.db
 * with the real sqlite3 CLI. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-imessage-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const DB = path.join(tmp, 'chat.db');
const APPLE_MS = Date.UTC(2001, 0, 1); // 978307200000

function sql(statements) {
  execFileSync('/usr/bin/sqlite3', [DB], { input: statements });
}

(async () => {
  // --- synthetic chat.db (apple-epoch nanoseconds, attributedBody blob) ---
  sql(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, chat_identifier TEXT, service_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, uncanonicalized_id TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER, date INTEGER, date_read INTEGER, service TEXT, associated_message_type INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO chat VALUES (1,'iMessage;-;+15551234567','Test Chat','+15551234567','iMessage');
    INSERT INTO handle VALUES (1,'+15551234567','+15551234567');
    INSERT INTO handle VALUES (2,'agent@example.com','agent@example.com');
    INSERT INTO chat_handle_join VALUES (1,1);
    INSERT INTO message VALUES (1,'m1','hello there',NULL,1,0, 1000000000000000000, 0,'iMessage',0);
    INSERT INTO message VALUES (2,'m2',NULL,X'0000000030040201000000',1,1, 2000000000000000000, 0,'iMessage',0);
    INSERT INTO chat_message_join VALUES (1,1);
    INSERT INTO chat_message_join VALUES (1,2);
    INSERT INTO attachment VALUES (1,'~/Library/Messages/Attachments/x/photo.jpg','image/jpeg','photo.jpg');
    INSERT INTO message_attachment_join VALUES (1,1);
  `);

  const { imessageReader, _internal } = require('../src/main/services/imessageReader');

  // 0. date conversion (apple-ns → unix ms)
  assert.equal(_internal.appleToUnixMs(1_000_000_000_000_000_000), APPLE_MS + 1_000_000_000_000);
  assert.equal(_internal.appleToUnixMs(0), null);

  // 1. attributedBody decode (typedstream blob → first human-text run)
  const decoded = imessageReader.decodeAttributedBody(Buffer.concat([
    Buffer.from([0x04, 0x0b]), Buffer.from('streamtyped'), Buffer.from([0x00]), Buffer.from('decoded body text'),
  ]));
  assert.equal(decoded, 'decoded body text');
  assert.equal(imessageReader.decodeAttributedBody(null), null);

  // 1b. a REAL typedstream archive: every string is length-prefixed, so the
  // body must be read with its exact length. The old implementation split on
  // control bytes and left the length byte glued to the message.
  const typedstream = (strings) => {
    const parts = [Buffer.from([0x04, 0x0b]), Buffer.from('streamtyped'), Buffer.from([0x00])];
    for (const s of strings) {
      const body = Buffer.from(s, 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      parts.push(Buffer.from([0x81]), len, body);
    }
    return Buffer.concat(parts);
  };
  assert.equal(
    imessageReader.decodeAttributedBody(typedstream(['NSString', 'NSMutableString', 'the real body text'])),
    'the real body text',
    'the archive body is read with its exact length',
  );
  // a body whose length byte is a printable character must not leak into
  // the text (this is the classic "+hello" off-by-one)
  assert.equal(
    imessageReader.decodeAttributedBody(typedstream(['NSString', '+hello there'])),
    '+hello there',
    'the length prefix never leaks into the message',
  );
  // class names are never mistaken for the body
  assert.equal(
    imessageReader.decodeAttributedBody(typedstream(['NSString', 'NSMutableString'])),
    null,
    'an archive with no body decodes to null',
  );

  // 1c. reaction decoding (Apple stores 2000-2005 / 3000-3005)
  assert.deepEqual(imessageReader.decodeReaction(2000), { kind: 'add', reaction: 'love' });
  assert.deepEqual(imessageReader.decodeReaction(2002), { kind: 'add', reaction: 'dislike' });
  assert.deepEqual(imessageReader.decodeReaction(3001), { kind: 'remove', reaction: 'like' });
  assert.equal(imessageReader.decodeReaction(0), null);
  assert.equal(imessageReader.decodeReaction(1234), null);

  // 2. probe against the synthetic db
  imessageReader._configure({ dbPath: DB });
  const probe = await imessageReader.probe();
  assert.equal(probe.ok, true);
  assert.equal(probe.status, 'granted');
  assert.equal(probe.path, DB);

  // 3. listChats
  const chats = await imessageReader.listChats({ limit: 10 });
  assert.equal(chats.chats.length, 1);
  assert.equal(chats.chats[0].identifier, '+15551234567');
  assert.equal(chats.chats[0].title, 'Test Chat');
  assert.equal(chats.chats[0].service, 'iMessage');
  assert.ok(chats.chats[0].messageCount >= 2);
  assert.ok(chats.chats[0].lastMessageAt.startsWith('20'));

  // 4. readMessages: text + attributedBody fallback + attachment + fromMe + ISO date
  const msgs = await imessageReader.readMessages({ chatId: 1, limit: 10 });
  assert.equal(msgs.messages.length, 2);
  const byId = new Map(msgs.messages.map((m) => [m.id, m]));
  const m1 = byId.get(1);
  const m2 = byId.get(2);
  assert.equal(m1.text, 'hello there');
  assert.equal(m1.textSource, 'text');
  assert.equal(m1.fromMe, false);
  assert.equal(m1.service, 'iMessage');
  assert.equal(m1.sender, '+15551234567');
  assert.equal(m1.at, new Date(APPLE_MS + 1_000_000_000_000).toISOString());
  assert.equal(m1.attachments.length, 1);
  assert.equal(m1.attachments[0].name, 'photo.jpg');
  assert.equal(m1.attachments[0].mime, 'image/jpeg');
  assert.ok(m1.attachments[0].path.endsWith('photo.jpg'));
  assert.equal(m2.fromMe, true);
  assert.equal(m2.textSource, 'attributedBody');

  // 5. searchMessages matches body text
  const found = await imessageReader.searchMessages({ query: 'hello', limit: 10 });
  assert.equal(found.messages.length, 1);
  assert.equal(found.messages[0].text, 'hello there');
  assert.equal((await imessageReader.searchMessages({ query: 'zzz-nope' })).messages.length, 0);
  await assert.rejects(() => imessageReader.searchMessages({ query: '  ' }), /query is required/);

  // 6. limit clamping
  assert.ok((await imessageReader.listChats({ limit: 99999 })).chats.length <= 200);

  // 7. missing db → ENOENT_CHATDB
  imessageReader._configure({ dbPath: path.join(tmp, 'nope.db') });
  const missing = await imessageReader.probe();
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'ENOENT_CHATDB');
  await assert.rejects(() => imessageReader.listChats({}), /not found/);

  // 8. sqlite reports authorization denied → NEEDS_FDA
  const fakeSqlite = path.join(tmp, 'fake-sqlite3');
  fs.writeFileSync(fakeSqlite, '#!/bin/sh\necho "authorization denied" >&2\nexit 1\n', { mode: 0o755 });
  imessageReader._configure({ dbPath: DB, sqlitePath: fakeSqlite });
  const denied = await imessageReader.probe();
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'NEEDS_FDA');
  assert.match(denied.hint, /Full Disk Access/);
  await assert.rejects(() => imessageReader.listChats({}), (e) => e.code === 'NEEDS_FDA');

  // 9. reset back to a working reader
  imessageReader._configure({ dbPath: DB, sqlitePath: '/usr/bin/sqlite3' });
  assert.equal((await imessageReader.probe()).ok, true);

  // --- macMessagesService.sendMessage gates ---
  const { settingsService } = require('../src/main/services/settingsService');
  settingsService.save({ workspaceRoot: tmp });
  const { macMessagesService } = require('../src/main/services/macMessagesService');
  const sent = [];
  macMessagesService._setRunner((cmd, args) => { sent.push({ cmd, args }); return ''; });

  // disabled by default
  assert.throws(() => macMessagesService.sendMessage({ to: '+15551234567', text: 'hi' }), /disabled/i);

  settingsService.save({ messagesEnabled: true });
  // not allowlisted
  assert.throws(() => macMessagesService.sendMessage({ to: '+15551234567', text: 'hi' }), /allowed list/i);

  macMessagesService.allowRecipients(['+15551234567']);
  // empty / too long
  assert.throws(() => macMessagesService.sendMessage({ to: '+15551234567', text: '   ' }), /text is required/i);
  assert.throws(() => macMessagesService.sendMessage({ to: '+15551234567', text: 'x'.repeat(4001) }), /too long/i);

  // happy path + AppleScript escaping (quote/backslash) + no shell
  const res = macMessagesService.sendMessage({ to: '+15551234567', text: 'say "hi" \\ done' });
  assert.equal(res.sent, true);
  assert.equal(res.to, '+15551234567');
  assert.equal(res.chars, 15);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].cmd, 'osascript');
  assert.equal(sent[0].args[0], '-e');
  const script = sent[0].args[1];
  assert.ok(script.includes('tell application "Messages"'));
  assert.ok(script.includes('say \\"hi\\" \\\\ done'), 'quotes/backslashes escaped');
  assert.ok(!script.includes('say "hi"'));

  // reader delegation through the service facade
  const viaService = await macMessagesService.listChats({ limit: 5 });
  assert.equal(viaService.chats.length, 1);
  const status = await macMessagesService.readStatus();
  assert.equal(status.ok, true);
  assert.equal(status.status, 'granted');

  // Existing grokCompat surface still responds (new reader routes live in IPC).
  const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');
  const compatPerms = await grokCompatService.dispatch('checkMessagesPermissions', {});
  assert.equal(compatPerms.status, 'ok');
  assert.ok(['granted', 'denied', 'missing'].includes(compatPerms.fullDiskAccess));
  const compatAllow = await grokCompatService.dispatch('listMessagesAllowedRecipients', {});
  assert.equal(compatAllow.status, 'ok');
  assert.deepEqual(compatAllow.recipients, ['+15551234567']);

  console.log('imessage test: ALL OK (reader/chats/messages/search/attributedBody/dates/denied/sendMessage/compat)');
})().catch((e) => { console.error(e); process.exit(1); });
