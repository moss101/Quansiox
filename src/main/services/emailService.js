'use strict';
/**
 * Email connector (real, no-dep) — minimal SMTP send + IMAP search/fetch over
 * node:tls, with an injectable duplex transport and a CRLF-line + {n} literal
 * aware reader (the correct framing for these protocols).
 *
 * Honest caveat: this is verified here against *simulated* protocol frames (an
 * injectable fake transport with scripted server responses), NOT a live mail
 * server. Verify against your real IMAP/SMTP before relying on it. Config/creds:
 * server settings live in settings (non-secret); the app-password lives in the
 * encrypted secrets vault.
 */
const DEFAULT_SMTP = { port: 465, secure: true };
const DEFAULT_IMAP = { port: 993, secure: true };

let smtpConnect = defaultConnect;
let imapConnect = defaultConnect;
function setTransport({ smtpConnect: s, imapConnect: i } = {}) { if (s) smtpConnect = s; if (i) imapConnect = i; }
function defaultConnect({ host, port, secure }) {
  const net = require('node:net');
  const tls = require('node:tls');
  return secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
}

/** Buffered reader: CRLF lines + octet-counted {n} literals. */
function reader(duplex) {
  let buf = Buffer.alloc(0);
  const lineQ = [];
  const litQ = [];
  duplex.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); pump(); });
  duplex.on('error', () => {});
  function pump() {
    while (litQ.length && buf.length >= litQ[0].n) { const w = litQ.shift(); const p = buf.subarray(0, w.n); buf = buf.subarray(w.n); w.resolve(p); }
    let idx;
    while (lineQ.length && (idx = buf.indexOf('\r\n')) !== -1) { const line = buf.subarray(0, idx).toString('utf8'); buf = buf.subarray(idx + 2); lineQ.shift().resolve(line); }
  }
  return {
    readLine() { return new Promise((resolve) => { lineQ.push({ resolve }); pump(); }); },
    readLiteral(n) { return new Promise((resolve) => { litQ.push({ n, resolve }); pump(); }); },
  };
}

// ---- SMTP send ----
async function readResponse(rd) {
  let last = '';
  for (;;) { const line = await rd.readLine(); last = line; if (/^\d{3}( |$)/.test(line)) break; }
  return { code: Number(last.slice(0, 3)), text: last };
}
async function smtpSend({ host, port = DEFAULT_SMTP.port, secure = DEFAULT_SMTP.secure, user, pass, from, to, subject, text, attachments = [], inReplyTo = null, references = null }) {
  if (!host || !user || !pass || !to) throw new Error('smtp needs host, user, pass, to');
  const dup = smtpConnect({ host, port, secure });
  const rd = reader(dup);
  const write = (s) => dup.write(s.endsWith('\r\n') ? s : `${s}\r\n`);
  const expect = async (code) => { const r = await readResponse(rd); if (r.code !== code) throw new Error(`smtp expected ${code}, got ${r.code} ${r.text}`); return r; };

  await expect(220);                                   // greeting
  write('EHLO quansiox'); await expect(250);          // capabilities (multi-line 250-)
  write('AUTH LOGIN'); await expect(334);
  write(Buffer.from(user).toString('base64')); await expect(334);
  write(Buffer.from(pass).toString('base64')); await expect(235);
  write(`MAIL FROM:<${from || user}>`); await expect(250);
  for (const rcpt of String(to).split(/[,;]\s*/).filter(Boolean)) { write(`RCPT TO:<${rcpt.trim()}>`); await expect(250); }
  write('DATA'); await expect(354);

  // A message with attachments is a multipart document; a plain one is not.
  const boundary = `qx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  const headers = [
    `From: ${from || user}`,
    `To: ${to}`,
    `Subject: ${String(subject ?? '')}`,
    'MIME-Version: 1.0',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  let payload;
  if (list.length) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      String(text ?? ''),
    ];
    for (const attachment of list) {
      const filename = String(attachment.filename ?? 'attachment.bin').replace(/["\r\n]/g, '');
      const mime = String(attachment.mime ?? 'application/octet-stream');
      const data = Buffer.isBuffer(attachment.content)
        ? attachment.content
        : Buffer.from(String(attachment.content ?? ''), attachment.encoding === 'base64' ? 'base64' : 'utf8');
      parts.push(
        `--${boundary}`,
        `Content-Type: ${mime}; name="${filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${filename}"`,
        '',
        data.toString('base64')
      );
    }
    parts.push(`--${boundary}--`);
    payload = parts.join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    payload = String(text ?? '');
  }
  write(`${headers.join('\r\n')}\r\n\r\n${payload.replace(/\r?\n/g, '\r\n')}\r\n.\r\n`);
  const queued = await expect(250);
  write('QUIT'); dup.end?.();
  return { accepted: queued.code === 250, to, subject: String(subject ?? ''), attachments: list.length };
}

// ---- IMAP search + fetch ----
async function imapSearch({ host, port = DEFAULT_IMAP.port, secure = DEFAULT_IMAP.secure, user, pass, mailbox = 'INBOX', criteria = 'ALL', limit = 10 }) {
  if (!host || !user || !pass) throw new Error('imap needs host, user, pass');
  const dup = imapConnect({ host, port, secure });
  const rd = reader(dup);
  let tagSeq = 0;
  const nextTag = () => `t${++tagSeq}`;
  const tagged = async (cmd) => {
    const tag = nextTag();
    dup.write(`${tag} ${cmd}\r\n`);
    const untagged = [];
    for (;;) {
      const line = await rd.readLine();
      if (line.startsWith(`${tag} `)) return { ok: line.slice(tag.length + 1).startsWith('OK'), lines: untagged, status: line };
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) { const data = await rd.readLiteral(Number(lit[1])); untagged.push(`${line}\r\n${data.toString('utf8')}`); }
      else untagged.push(line);
    }
  };
  await rd.readLine();                        // greeting "* OK ..."
  const login = await tagged(`LOGIN "${user}" "${String(pass).replace(/"/g, '\\"')}"`);
  if (!login.ok) throw new Error(`imap login failed: ${login.status.replace(/^t\d+ /, '')}`);
  const sel = await tagged(`SELECT "${mailbox}"`);
  if (!sel.ok) throw new Error(`imap select failed: ${sel.status.replace(/^t\d+ /, '')}`);
  const se = await tagged(`SEARCH ${criteria}`);
  if (!se.ok) throw new Error(`imap search failed: ${se.status.replace(/^t\d+ /, '')}`);
  const searchLine = se.lines.find((l) => /^\* SEARCH/i.test(l)) || '';
  const uids = searchLine.split(/\s+/).filter((x) => /^\d+$/.test(x)).slice(-limit).reverse();
  const out = [];
  for (const uid of uids) {
    const fe = await tagged(`FETCH ${uid} (FLAGS RFC822)`);
    if (!fe.ok) continue;
    const fetched = fe.lines.find((l) => /RFC822 \{/.test(l)) || fe.lines.join('\n');
    const raw = /RFC822 \{(\d+)\}\r?\n([\s\S]*)/.exec(fetched)?.[2] ?? '';
    out.push(parseMessage(uid, raw));
  }
  dup.end?.();
  return out;
}
/** Decode a MIME body according to its transfer encoding. */
function decodeBody(raw, encoding) {
  const text = String(raw ?? '');
  switch (String(encoding ?? '').toLowerCase().trim()) {
    case 'base64':
      try { return Buffer.from(text.replace(/\s+/g, ''), 'base64'); } catch { return Buffer.from(text, 'utf8'); }
    case 'quoted-printable':
      return Buffer.from(
        text.replace(/=\r?\n/g, '')
          .replace(/=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16))),
        'binary'
      );
    default:
      return Buffer.from(text, 'utf8');
  }
}

/** Split a MIME multipart body on its boundary. */
function splitMultipart(body, boundary) {
  const marker = `--${boundary}`;
  const chunks = String(body ?? '').split(new RegExp(`\\r?\\n?${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\r?\\n?`, 'i'));
  return chunks.filter((chunk) => chunk.trim().length);
}

/** Parse one MIME part into a body or an attachment. */
function parsePart(raw) {
  const separator = /\r?\n\r?\n/.exec(raw);
  // Without a separator the part has no headers of its own — everything is
  // the content.
  const headerText = separator ? raw.slice(0, separator.index) : '';
  const content = separator ? raw.slice(separator.index + separator[0].length) : raw;
  const headers = {};
  for (const line of headerText.split(/\r?\n/)) {
    const match = /^([A-Za-z-]+):\s?(.*)$/.exec(line);
    if (match) headers[match[1].toLowerCase()] = match[2].trim();
    else if (headers['content-type'] && /^\s/.test(line)) {
      headers['content-type'] += ` ${line.trim()}`;
    }
  }
  const contentType = headers['content-type'] ?? 'text/plain';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const filename = /filename="?([^";]+)"?/i.exec(contentType)?.[1] ?? null;
  const disposition = headers['content-disposition'] ?? '';
  const attachmentName = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? filename;
  const decoded = decodeBody(content, headers['content-transfer-encoding']);
  const isAttachment = Boolean(attachmentName) || (!mime.startsWith('text/') && mime !== 'multipart/alternative');
  if (isAttachment) {
    return {
      kind: 'attachment',
      filename: attachmentName ?? 'attachment.bin',
      mime,
      bytes: decoded.length,
      content: decoded.toString('base64'),
      encoding: 'base64',
    };
  }
  return {
    kind: mime === 'text/html' ? 'html' : 'text',
    mime,
    text: decoded.toString('utf8'),
  };
}

/**
 * Parse a raw RFC822 message.
 *
 * The subject, the body and the attachments all matter for the mail-driven
 * task flow, so this returns all three — including the addresses the
 * message was sent to, which is how a workflow address is recognised.
 */
function parseMessage(uid, raw) {
  const separator = /\r?\n\r?\n/.exec(raw);
  const headerText = separator ? raw.slice(0, separator.index) : '';
  const body = separator ? raw.slice(separator.index + separator[0].length) : '';
  const headers = {};
  // Unfold the headers: a continuation line starts with whitespace.
  for (const line of headerText.split(/\r?\n/)) {
    const match = /^([A-Za-z-]+):\s?(.*)$/.exec(line);
    if (match) headers[match[1].toLowerCase()] = match[2].trim();
    else if (Object.keys(headers).length && /^[ \t]/.test(line)) {
      const last = Object.keys(headers).at(-1);
      headers[last] = `${headers[last]} ${line.trim()}`;
    }
  }
  const val = (name) => headers[name] ?? '';
  const contentType = val('content-type') || 'text/plain';
  const mime = contentType.split(';')[0].trim().toLowerCase();

  const parts = [];
  if (mime.startsWith('multipart/')) {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
    if (boundary) {
      for (const chunk of splitMultipart(body, boundary)) parts.push(parsePart(chunk));
    }
  } else {
    parts.push(parsePart(body));
  }

  const textPart = parts.find((p) => p.kind === 'text');
  const htmlPart = parts.find((p) => p.kind === 'html');
  const attachments = parts.filter((p) => p.kind === 'attachment');

  const addressList = (value) => String(value ?? '')
    .split(',')
    .map((entry) => {
      const match = /"?([^"<]*?)"?\s*<?([^\s<>]+@[^\s<>]+)>?/.exec(entry.trim());
      return match ? { name: (match[1] || '').trim(), email: match[2].trim().toLowerCase() } : null;
    })
    .filter(Boolean);

  return {
    uid: Number(uid),
    subject: val('subject'),
    from: val('from'),
    fromAddress: addressList(val('from'))[0]?.email ?? '',
    to: val('to'),
    toAddresses: addressList(val('to')).map((a) => a.email),
    cc: val('cc'),
    ccAddresses: addressList(val('cc')).map((a) => a.email),
    date: val('date'),
    messageId: val('message-id'),
    inReplyTo: val('in-reply-to'),
    body: textPart?.text ?? '',
    html: htmlPart?.text ?? null,
    snippet: (textPart?.text ?? body).replace(/\s+/g, ' ').trim().slice(0, 200),
    attachments: attachments.map((a) => ({
      filename: a.filename, mime: a.mime, bytes: a.bytes, content: a.content, encoding: a.encoding,
    })),
  };
}

/** Resolve configured SMTP/IMAP from settings + the encrypted secrets vault. */
function secretValue(name) { try { const rec = require('./secretsService').secretsService.get(name); const f = rec?.fields || {}; return String(f.password || f.value || Object.values(f)[0] || '') || null; } catch { return null; } }
function config() {
  const s = require('./settingsService').settingsService.load();
  const build = (c) => (c ? { ...c, pass: secretValue(c.passwordSecret) } : null);
  return { smtp: build(s.emailSmtp), imap: build(s.emailImap) };
}

module.exports = { emailService: { smtpSend, imapSearch, setTransport, config, parseMessage, DEFAULT_SMTP, DEFAULT_IMAP } };
