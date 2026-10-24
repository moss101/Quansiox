'use strict';
/* Mail Manus test — the local-first mail surface.
 *
 * Covers the documented behaviour:
 *   - the bot address and the workflow addresses (MAL-01/08);
 *   - the approved-sender allowlist (MAL-07);
 *   - a forwarded message triggers a task (MAL-02);
 *   - the prompt carries the body, the attachments and the fields that could
 *     be read straight out of the message (MAL-04/17);
 *   - the result goes back to the inbox (MAL-05);
 *   - "cancel" stops the task (MAL-15);
 *   - the client-side filter configuration (MAL-10/11);
 *   - a calendar event (MAL-19);
 *   - a message that is not addressed to a workflow is ignored.
 *
 * The SMTP/IMAP transport is injected, so the flow is tested without a mail
 * server.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mail-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const { mailManusService } = require('../src/main/services/mailManusService');

function message(overrides = {}) {
  return {
    uid: 1,
    subject: 'Invoice 42',
    from: 'Ada <ada@example.com>',
    fromAddress: 'ada@example.com',
    to: 'travel@example.com',
    toAddresses: ['travel@example.com'],
    cc: '',
    ccAddresses: [],
    body: 'Please pay invoice 42 for 99.50 EUR by 2026-02-01. Thanks!',
    snippet: 'Please pay invoice 42 …',
    attachments: [{ filename: 'invoice.pdf', mime: 'application/pdf', bytes: 9, content: 'SGVsbG8=', encoding: 'base64' }],
    messageId: '<abc@example.com>',
    ...overrides,
  };
}

async function run() {
  /* -- 1. the addresses (MAL-01/08) --------------------------------------- */
  mailManusService.configure({
    enabled: true,
    botAddress: 'quansiox@example.com',
    approvedSenders: [],
    settings: { defaultPrompt: 'Summarise what came in.', sendStatusUpdates: false },
  });
  assert.strictEqual(mailManusService.botAddress(), 'quansiox@example.com');
  const workflow = mailManusService.addWorkflow({
    alias: 'travel',
    prompt: 'Extract the trip details and file them.',
    sessionId: 'mail-session',
  });
  assert.strictEqual(workflow.alias, 'travel');
  assert.strictEqual(workflow.address, 'travel@example.com');
  assert.strictEqual(workflow.prompt, 'Extract the trip details and file them.');
  assert.throws(() => mailManusService.addWorkflow({ alias: '' }), /needs an alias/);

  // The message has to be addressed to one of our addresses.
  const matched = mailManusService.matchWorkflow(message());
  assert.ok(matched, 'the workflow address matched');
  assert.strictEqual(matched.alias, 'travel');
  assert.strictEqual(mailManusService.matchWorkflow(message({ toAddresses: ['someone@else.com'], ccAddresses: [] })), null);

  /* -- 2. the approved senders (MAL-07) ----------------------------------- */
  assert.strictEqual(mailManusService.isApproved(message()).allowed, true, 'with no allow list everyone is allowed');
  mailManusService.configure({ approvedSenders: ['ada@example.com'] });
  assert.strictEqual(mailManusService.isApproved(message()).allowed, true);
  const blocked = mailManusService.isApproved(message({ fromAddress: 'eve@example.com' }));
  assert.strictEqual(blocked.allowed, false);
  assert.match(blocked.reason, /not on the approved list/);
  mailManusService.approveSender('bob@example.com');
  assert.ok(mailManusService.load().approvedSenders.includes('bob@example.com'));
  assert.throws(() => mailManusService.approveSender('nope'), /not an email address/);
  mailManusService.removeSender('bob@example.com');
  assert.ok(!mailManusService.load().approvedSenders.includes('bob@example.com'));

  /* -- 3. a forwarded message triggers a task (MAL-02/04) ------------------ */
  const sent = [];
  mailManusService.setRunner(async (sessionId, prompt) => {
    sent.push({ sessionId, prompt });
    return 'The invoice is filed.';
  });
  // The reply goes through the injected transport.
  const replies = [];
  mailManusService.setSender(async (payload) => { replies.push(payload); return { ok: true, accepted: true }; });
  try {
    const result = await mailManusService.handleMessage(message());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'ran');
    assert.strictEqual(result.workflow, 'travel');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].sessionId, 'mail-session', 'the task runs on the workflow session');
    assert.match(sent[0].prompt, /Extract the trip details/);
    assert.match(sent[0].prompt, /Invoice 42/);
    assert.match(sent[0].prompt, /invoice\.pdf/, 'the attachments are named in the prompt');
    assert.match(sent[0].prompt, /99.5/, 'the fields read from the message are offered');
    assert.strictEqual(result.output, 'The invoice is filed.');
    // And the result goes back to the inbox.
    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].to, 'ada@example.com');
    assert.match(replies[0].text, /The invoice is filed/);
    assert.strictEqual(replies[0].inReplyTo, '<abc@example.com>', 'the reply is threaded');
  } finally {
    /* the transport stays injected for the rest of the test */
  }

  /* -- 4. a message that is not for us is ignored -------------------------- */
  const ignored = await mailManusService.handleMessage(
    message({ toAddresses: ['other@example.com'], ccAddresses: [] })
  );
  assert.strictEqual(ignored.skipped, true);

  /* -- 5. a rejected sender gets a reply but nothing runs ------------------ */
  const sentBefore = sent.length;
  const repliesBefore = replies.length;
  const rejected = await mailManusService.handleMessage(message({ fromAddress: 'eve@example.com' }));
  assert.strictEqual(rejected.rejected, true);
  assert.strictEqual(sent.length, sentBefore, 'nothing ran for a rejected sender');
  assert.strictEqual(replies.length, repliesBefore + 1, 'but the sender was told why');

  /* -- 6. "cancel" stops the task (MAL-15) -------------------------------- */
  const cancelled = await mailManusService.handleMessage(
    message({ subject: 'Cancel', body: 'cancel' })
  );
  assert.strictEqual(cancelled.action, 'cancel');
  assert.strictEqual(cancelled.cancelled, true);

  /* -- 7. the structured record (MAL-17) ----------------------------------- */
  const record = mailManusService.extractRecord(message());
  assert.strictEqual(record.amount, 99.5);
  assert.strictEqual(record.currency, 'EUR');
  assert.strictEqual(record.reference, '42');
  assert.strictEqual(record.sentiment, 'positive');
  assert.deepStrictEqual(record.attachments, ['invoice.pdf']);

  /* -- 8. the client-side filter (MAL-10/11) ------------------------------ */
  const gmail = mailManusService.filterConfiguration({ from: 'invoice@supplier.com', keyword: 'invoice', provider: 'gmail' });
  assert.strictEqual(gmail.provider, 'gmail');
  assert.match(gmail.searchQuery, /from:invoice@supplier\.com/);
  assert.match(gmail.searchQuery, /invoice/);
  assert.strictEqual(gmail.forwardTo, 'quansiox@example.com');
  assert.match(gmail.xml, /<feed/);
  assert.ok(gmail.instructions.length >= 2);
  const outlook = mailManusService.filterConfiguration({ subject: 'Receipt', provider: 'outlook' });
  assert.strictEqual(outlook.provider, 'outlook');
  assert.strictEqual(outlook.rule.action.type, 'forward');
  assert.ok(outlook.rule.conditions.length >= 1);

  /* -- 9. a calendar event (MAL-19) ---------------------------------------- */
  const ics = mailManusService.calendarEvent({
    title: 'Review trip',
    start: '2026-03-01T10:00:00Z',
    end: '2026-03-01T11:00:00Z',
    location: 'Room 2',
  });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /SUMMARY:Review trip/);
  assert.match(ics, /DTSTART:20260301T100000Z/);
  assert.match(ics, /END:VCALENDAR/);
  assert.throws(() => mailManusService.calendarEvent({ title: 'x', start: 'nonsense', end: 'nonsense' }));

  /* -- 10. the workflow list ------------------------------------------------ */
  assert.strictEqual(mailManusService.removeWorkflow('travel').removed, true);
  assert.strictEqual(mailManusService.load().workflows.length, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mail-manus test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
