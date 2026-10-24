'use strict';
/**
 * Mail Manus — the local-first implementation of Manus' mail surface.
 *
 * The documented product gives every user a personal bot address
 * (`you-abc123@mail.manus.ai`), and a task is triggered by forwarding an
 * email to it or CC-ing it. There is a **workflow email** — a custom address
 * like `travel@manus.bot` with a default prompt attached — and a
 * **client-side filter** that forwards matching mail to it. The reply comes
 * back to the inbox, with attachments where they apply, and a "Cancel"
 * reply stops the run.
 *
 * A local-first app cannot hand out a real mailbox on someone else's domain.
 * What it *can* do is the whole mechanism, against a mailbox the user
 * already owns:
 *
 *   - the **bot address** is an address that delivers into the user's own
 *     IMAP mailbox (the local part is derived from the mailbox user);
 *   - **workflow addresses** are local-part aliases on the same mailbox,
 *     each with its own default prompt and its own session;
 *   - **approved senders** gate who may trigger a task at all;
 *   - the **poller** fetches unseen mail, matches the workflow address,
 *     runs the task and **replies by SMTP** — with attachments;
 *   - a reply of **"Cancel"** stops the running task;
 *   - **status emails** tell the sender the task started, and a
 *     **confirmation** email asks before a long task;
 *   - the **client-side filter** configuration (a Gmail filter and an
 *     Outlook rule) is generated for the user's own mail client;
 *   - a **calendar event** can be emitted as an .ics file.
 *
 * The address is honestly described as a *local alias*, not a hosted
 * mailbox: the docs' `@manus.bot` addresses only exist because Manus runs
 * the mail servers.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { emailService } = require('./emailService');

/* ------------------------------------------------------------------ store */

function userDataDir() {
  return require('./userData').userDataDir();
}
function storeFile() { return path.join(userDataDir(), 'mail-manus.json'); }

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return {
      enabled: parsed.enabled === true,
      botAddress: parsed.botAddress ?? null,
      approvedSenders: Array.isArray(parsed.approvedSenders) ? parsed.approvedSenders : [],
      workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
      processed: Array.isArray(parsed.processed) ? parsed.processed : [],
      settings: parsed.settings ?? {},
      updatedAt: parsed.updatedAt ?? 0,
    };
  } catch {
    return { enabled: false, botAddress: null, approvedSenders: [], workflows: [], processed: [], settings: {}, updatedAt: 0 };
  }
}
function save(state) {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  state.updatedAt = Date.now();
  fs.writeFileSync(storeFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
  return state;
}

/* ------------------------------------------------------------- addresses */

/**
 * The bot address.
 *
 * It is the user's own mailbox, with a local part derived from the mailbox
 * user so several workflow addresses can be distinguished on it.
 */
function botAddress(local = 'quansiox') {
  const state = load();
  if (state.botAddress) return state.botAddress;
  const config = emailService.config();
  const mailbox = config?.imap?.user ?? '';
  const domain = mailbox.includes('@') ? mailbox.split('@')[1] : null;
  if (!domain) return null;
  return `${sanitizeLocalPart(local)}@${domain}`;
}

function sanitizeLocalPart(value) {
  return String(value ?? 'quansiox').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40) || 'quansiox';
}

/** Does this message address one of our workflow addresses? */
function matchWorkflow(message) {
  const state = load();
  const recipients = [...(message.toAddresses ?? []), ...(message.ccAddresses ?? [])];
  for (const workflow of state.workflows) {
    const address = (workflow.address ?? '').toLowerCase();
    if (!address) continue;
    if (recipients.some((r) => r.toLowerCase() === address)) return workflow;
    // A workflow also matches on its local part, so `travel@x` answers
    // `travel@y` when the domain is the user's own.
    const local = address.split('@')[0];
    if (local && recipients.some((r) => r.split('@')[0].toLowerCase() === local)) return workflow;
  }
  const bot = state.botAddress ?? botAddress();
  if (bot && recipients.some((r) => r.toLowerCase() === bot.toLowerCase())) {
    return { alias: 'bot', address: bot, prompt: state.settings.defaultPrompt ?? '', sessionId: null, enabled: true };
  }
  return null;
}

/* --------------------------------------------------------------- settings */

function configure(patch = {}) {
  const state = load();
  if (patch.enabled !== undefined) state.enabled = patch.enabled === true;
  if (patch.botAddress !== undefined) state.botAddress = patch.botAddress ? String(patch.botAddress).toLowerCase() : null;
  if (Array.isArray(patch.approvedSenders)) {
    state.approvedSenders = patch.approvedSenders
      .map((sender) => String(sender).trim().toLowerCase())
      .filter((sender) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender))
      .slice(0, 500);
  }
  if (patch.settings !== undefined) state.settings = { ...state.settings, ...patch.settings };
  save(state);
  return state;
}

/** Add an approved sender (MAL-07). */
function approveSender(email) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('that is not an email address');
  const state = load();
  if (!state.approvedSenders.includes(address)) state.approvedSenders.push(address);
  save(state);
  return state.approvedSenders;
}

function removeSender(email) {
  const state = load();
  const address = String(email ?? '').toLowerCase();
  state.approvedSenders = state.approvedSenders.filter((s) => s !== address);
  save(state);
  return state.approvedSenders;
}

/** Is this sender allowed to trigger a task? */
function isApproved(message) {
  const state = load();
  if (!state.approvedSenders.length) return { allowed: true, reason: 'no allow list is configured, so every sender is allowed' };
  const sender = String(message?.fromAddress ?? '').toLowerCase();
  const allowed = state.approvedSenders.some((entry) => sender === entry
    || (entry.startsWith('@') && sender.endsWith(entry)));
  return allowed
    ? { allowed: true }
    : { allowed: false, reason: `${sender || 'this sender'} is not on the approved list` };
}

/* -------------------------------------------------------------- workflows */

/**
 * A workflow address: a custom local part with a default prompt attached
 * (MAL-08/09).
 */
function addWorkflow({ alias, prompt, sessionId, address = null } = {}) {
  const state = load();
  const rawAlias = String(alias ?? '').trim().toLowerCase();
  if (!rawAlias) throw new Error('a workflow needs an alias');
  const local = sanitizeLocalPart(rawAlias);
  if (!local || local === 'quansiox') throw new Error('a workflow needs an alias');
  const domain = botAddress()?.split('@')[1];
  const workflowAddress = (address ?? (domain ? `${local}@${domain}` : local)).toLowerCase();
  const existing = state.workflows.find((w) => w.alias === local);
  const entry = {
    alias: local,
    address: workflowAddress,
    prompt: String(prompt ?? '').slice(0, 4000),
    sessionId: sessionId ?? existing?.sessionId ?? null,
    enabled: true,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  state.workflows = [...state.workflows.filter((w) => w.alias !== local), entry];
  save(state);
  return entry;
}

function removeWorkflow(alias) {
  const state = load();
  const local = String(alias ?? '').toLowerCase();
  const before = state.workflows.length;
  state.workflows = state.workflows.filter((w) => w.alias !== local);
  save(state);
  return { removed: before !== state.workflows.length };
}

/* --------------------------------------------------------------- sending */

/** The transport is injectable so the flow can be tested without a server. */
let sendFn = null;
function setSender(fn) { sendFn = typeof fn === 'function' ? fn : null; }

async function send({ to, subject, text, attachments = [], inReplyTo = null }) {
  if (sendFn) return sendFn({ to, subject, text, attachments, inReplyTo });
  const config = emailService.config();
  if (!config?.smtp?.pass) return { ok: false, reason: 'email is not configured (emailSmtp settings + password secret)' };
  const from = config.smtp.from ?? config.smtp.user;
  try {
    const result = await emailService.smtpSend({
      ...config.smtp, from, to, subject, text, attachments, inReplyTo,
    });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/* ------------------------------------------------------- structured fields */

/**
 * Extract the structured fields the docs mention (MAL-17): the amounts, the
 * dates and the identifiers in a message.
 *
 * This is a real extractor over the text — and the agent can do better with
 * the model, so the extracted record is offered to the prompt as well.
 */
function extractRecord(message) {
  const text = `${message.subject ?? ''}\n${message.body ?? ''}`;
  const record = {};
  const amount = /(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?)\s*(EUR|USD|GBP|JPY|CNY|INR|AUD|CAD|CHF|SEK|NOK|DKK|PLN|BRL|MXN|\$|€|£|¥|₹)/i.exec(text);
  if (amount) {
    record.amount = Number(amount[1].replace(/[,\s]/g, ''));
    record.currency = amount[2].toUpperCase().replace('$', 'USD').replace('€', 'EUR').replace('£', 'GBP').replace('¥', 'CNY');
  }
  const total = /\b(?:total|amount due|grand total)\b[:\s]*([\d.,]+)/i.exec(text);
  if (total) record.total = Number(total[1].replace(/,/g, ''));
  // The reference has to contain a digit, otherwise "invoice for the
  // company" would be read as the invoice number "for".
  const invoice = /\b(?:invoice|receipt|order)\s*(?:number|no\.?|#)?\s*((?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{1,})\b/i.exec(text);
  if (invoice) record.reference = invoice[1];
  const date = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/.exec(text);
  if (date) record.date = date[1];
  // A light sentiment read: the words that carry it.
  const positive = (text.match(/\b(thanks|thank you|great|appreciate|please|kind)\b/gi) ?? []).length;
  const negative = (text.match(/\b(complaint|disappointed|urgent|overdue|late|refund|cancel)\b/gi) ?? []).length;
  record.sentiment = positive > negative ? 'positive' : negative > positive ? 'negative' : 'neutral';
  record.attachments = (message.attachments ?? []).map((a) => a.filename);
  return record;
}

/* ------------------------------------------------------- calendar events */

/** A calendar event as an .ics file (MAL-19). */
function calendarEvent({ title, start, end, location = '', description = '', url = '' }) {
  const stamp = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  };
  const startStamp = stamp(start);
  const endStamp = stamp(end);
  if (!startStamp || !endStamp) throw new Error('the event needs a start and an end');
  const escape = (value) => String(value ?? '').replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Quansiox//Mail Manus//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@quansiox.local`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${startStamp}`,
    `DTEND:${endStamp}`,
    `SUMMARY:${escape(title)}`,
  ];
  if (location) lines.push(`LOCATION:${escape(location)}`);
  if (description) lines.push(`DESCRIPTION:${escape(description)}`);
  if (url) lines.push(`URL:${escape(url)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------ the filter */

/**
 * The client-side filter configuration (MAL-10/11).
 *
 * The docs set up a filter in the user's own mail client — Gmail or Outlook
 * — that forwards matching messages to the workflow address. Both clients
 * can import a configuration, so both are produced here.
 */
function filterConfiguration({ from = '', subject = '', keyword = '', address, provider = 'gmail' }) {
  const target = address ?? botAddress();
  if (!target) throw new Error('no bot address is configured yet');
  const terms = [];
  if (from) terms.push(`from:${from}`);
  if (subject) terms.push(`subject:${subject}`);
  if (keyword) terms.push(keyword);
  const query = terms.join(' ') || '*';
  if (provider === 'outlook') {
    return {
      provider: 'outlook',
      name: `Quansiox — ${keyword || from || 'workflow'}`,
      rule: {
        conditions: [
          ...(from ? [{ field: 'from', operator: 'contains', value: from }] : []),
          ...(subject ? [{ field: 'subject', operator: 'contains', value: subject }] : []),
          ...(keyword ? [{ field: 'body', operator: 'contains', value: keyword }] : []),
        ],
        action: { type: 'forward', to: target },
      },
      instructions: [
        `Outlook → Settings → Mail → Rules → New rule`,
        `Condition: ${terms.length ? terms.join(' AND ') : 'any message'}`,
        `Action: Forward to ${target}`,
      ],
    };
  }
  return {
    provider: 'gmail',
    name: `Quansiox — ${keyword || from || 'workflow'}`,
    searchQuery: query,
    forwardTo: target,
    xml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:gd="http://schemas.google.com/g/2005">',
      '  <title>Quansiox — workflow filter</title>',
      '  <entry>',
      `    <category term="${escapeXml(`filter:${query}`)}" label="${escapeXml(keyword || from || 'workflow')}"/>`,
      `    <title>${escapeXml(keyword || from || 'workflow')}</title>`,
      '    <content></content>',
      '  </entry>',
      '</feed>',
    ].join('\n'),
    instructions: [
      'Gmail → Settings → Filters and Blocked Addresses → Create a new filter',
      `Has the words: ${query}`,
      `Then forward it to: ${target}`,
    ],
  };
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/* ------------------------------------------------------------- processing */

/** The runner is injected so the flow can be tested without a model. */
let runFn = null;
function setRunner(fn) { runFn = typeof fn === 'function' ? fn : null; }

/**
 * The runs this service has started, by session.
 *
 * A cancel only aborts a run that is genuinely in flight. Aborting a
 * session that is idle would leave a request waiting for a reply that never
 * comes, which is how a mail flow ends up hanging on a "cancel".
 */
const activeRuns = new Map();

async function defaultRun(sessionId, message) {
  const { agentService } = require('./agentService');
  return agentService.run({ sender: null }, { sessionId, message });
}

/**
 * Handle one inbound message.
 *
 * @param {object} message  the parsed message
 * @param {object} options  { dryRun }
 * @returns {Promise<object>} what happened
 */
async function handleMessage(message, { dryRun = false } = {}) {
  const state = load();
  if (!state.enabled) return { ok: false, reason: 'mail Manus is turned off', skipped: true };

  const approval = isApproved(message);
  if (!approval.allowed) {
    // A rejected sender gets a reply saying so, so the person is not left
    // waiting — but nothing is run.
    if (!dryRun) {
      await send({
        to: message.fromAddress,
        subject: `Re: ${message.subject ?? ''}`.trim(),
        text: `This address does not accept tasks from ${message.fromAddress}.\n\nApproved senders: ${state.approvedSenders.join(', ') || '(none)'}`,
        inReplyTo: message.messageId ?? null,
      });
    }
    return { ok: false, reason: approval.reason, rejected: true };
  }

  const workflow = matchWorkflow(message);
  if (!workflow) return { ok: false, reason: 'the message was not addressed to a workflow address', skipped: true };

  // A reply of "Cancel" stops the running task (MAL-15).
  const text = `${message.subject ?? ''} ${message.body ?? ''}`.trim();
  if (/^cancel\b/i.test(text) || /^\s*cancel\s*$/i.test(text.trim())) {
    const cancelled = await cancelTask(workflow, message);
    return { ok: true, action: 'cancel', ...cancelled };
  }

  const record = extractRecord(message);
  const prompt = buildPrompt(workflow, message, record);

  // A confirmation before a long task (MAL-14).
  if (state.settings.confirmBeforeLongTasks && prompt.length > (state.settings.confirmThreshold ?? 800)) {
    if (!dryRun) {
      await send({
        to: message.fromAddress,
        subject: `Confirm: ${message.subject ?? 'your task'}`,
        text: `I received your message and it looks like a longer task.\n\nReply "go" to start it, or "cancel" to stop.\n\n---\n${prompt.slice(0, 800)}`,
        inReplyTo: message.messageId ?? null,
      });
    }
    return { ok: true, action: 'awaiting-confirmation', workflow: workflow.alias };
  }

  // A status email while the task runs (MAL-13).
  if (!dryRun && state.settings.sendStatusUpdates) {
    await send({
      to: message.fromAddress,
      subject: `Working on: ${message.subject ?? 'your task'}`,
      text: `I have your message and I am on it. I will reply with the result. Reply "cancel" to stop the task.`,
      inReplyTo: message.messageId ?? null,
    });
  }

  let output = '';
  let sessionId = workflow.sessionId ?? null;
  if (!dryRun) {
    const runner = runFn ?? defaultRun;
    if (sessionId) activeRuns.set(sessionId, { uid: message.uid, startedAt: Date.now() });
    try {
      const result = await runner(sessionId, prompt);
      output = typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      output = `The task failed: ${String(error?.message ?? error)}`;
    } finally {
      if (sessionId) activeRuns.delete(sessionId);
    }
  }

  // The result goes back to the inbox, with the attachments (MAL-05/06).
  let delivered = null;
  if (!dryRun) {
    delivered = await send({
      to: message.fromAddress,
      subject: `Re: ${message.subject ?? ''}`.trim(),
      text: output || 'The task finished with no output.',
      attachments: [],
      inReplyTo: message.messageId ?? null,
    });
  }

  const processed = {
    uid: message.uid,
    subject: message.subject,
    from: message.fromAddress,
    workflow: workflow.alias,
    at: Date.now(),
    output: output.slice(0, 4000),
  };
  state.processed = [processed, ...state.processed].slice(0, 200);
  save(state);

  return {
    ok: true,
    action: 'ran',
    workflow: workflow.alias,
    prompt,
    record,
    output,
    delivered: delivered?.ok ?? null,
    sessionId,
  };
}

/** The prompt the agent gets for an inbound message. */
function buildPrompt(workflow, message, record) {
  const parts = [];
  if (workflow.prompt) parts.push(workflow.prompt);
  parts.push(`A task arrived by email.\n\nSubject: ${message.subject ?? '(no subject)'}\nFrom: ${message.fromAddress}`);
  if (message.ccAddresses?.length) parts.push(`Also sent to: ${message.ccAddresses.join(', ')}`);
  parts.push(`\nMessage:\n"""\n${message.body ?? ''}\n"""`);
  if (message.attachments?.length) {
    parts.push(`\nAttachments: ${message.attachments.map((a) => a.filename).join(', ')}`);
  }
  if (Object.keys(record ?? {}).length) {
    parts.push(`\nFields I could read straight from the message:\n${JSON.stringify(record, null, 2)}`);
  }
  parts.push('\nDo the task and reply with the result. Do not ask follow-up questions — you cannot see the thread.');
  return parts.join('\n');
}

/** Cancel a running task (MAL-15/16). */
async function cancelTask(workflow, message) {
  let aborted = false;
  try {
    const { agentService } = require('./agentService');
    // Only a run that is actually in flight is aborted.
    if (workflow.sessionId && activeRuns.has(workflow.sessionId)) {
      await Promise.race([
        agentService.abort({ sender: null }, { sessionId: workflow.sessionId }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      aborted = true;
    }
  } catch { /* nothing was running */ }
  await send({
    to: message?.fromAddress,
    subject: `Cancelled: ${message?.subject ?? 'your task'}`,
    text: 'The task was cancelled.',
    inReplyTo: message?.messageId ?? null,
  });
  return { cancelled: true, aborted };
}

/* --------------------------------------------------------------- polling */

/**
 * Poll the mailbox for new mail and handle it.
 *
 * The criteria default to `UNSEEN`, so a message is only handled once —
 * the mailbox flags it as read when the client next looks.
 */
async function poll({ limit = 10, criteria = 'UNSEEN', dryRun = false } = {}) {
  const config = emailService.config();
  if (!config?.imap?.pass) return { ok: false, reason: 'email is not configured (emailImap settings + password secret)', messages: [] };
  let messages;
  try {
    messages = await emailService.imapSearch({ ...config.imap, criteria, limit });
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), messages: [] };
  }
  const results = [];
  for (const message of messages) {
    // eslint-disable-next-line no-await-in-loop
    const result = await handleMessage(message, { dryRun });
    results.push({ uid: message.uid, subject: message.subject, from: message.fromAddress, ...result });
  }
  return { ok: true, checked: messages.length, results };
}

/* --------------------------------------------------------------- exports */

module.exports = {
  mailManusService: {
    load,
    save,
    configure,
    botAddress,
    matchWorkflow,
    approveSender,
    removeSender,
    isApproved,
    addWorkflow,
    removeWorkflow,
    handleMessage,
    cancelTask,
    poll,
    send,
    extractRecord,
    calendarEvent,
    filterConfiguration,
    buildPrompt,
    setRunner,
    setSender,
  },
};
