'use strict';
/**
 * iMessage / SMS reader — reads macOS `chat.db` through the system sqlite3 CLI
 * in read-only mode (`-readonly`), so the app never opens the live database for
 * writing and never needs a native sqlite binding. Requires Full Disk Access;
 * without it every call reports `denied` honestly instead of failing vaguely.
 *
 * Apple stores dates as nanoseconds since 2001-01-01. Modern rows often leave
 * `text` NULL and put the body in the binary `attributedBody` (NSArchiver
 * `typedstream` or a binary plist) blob, so `decodeAttributedBody` recovers a
 * best-effort plain string and marks where the text came from.
 *
 * Electron-free; sqlite path / db path injectable for tests.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const APPLE_EPOCH_MS = 978_307_200_000; // 2001-01-01T00:00:00Z in unix ms
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 25;

/* Apple reaction types: 2000–2005 add a tapback, 3000–3005 removes it. */
const TAPBACK_ADD_MIN = 2000;
const TAPBACK_ADD_MAX = 2005;
const TAPBACK_REMOVE_MIN = 3000;
const TAPBACK_REMOVE_MAX = 3005;

function defaultDbPath() { return path.join(os.homedir(), 'Library', 'Messages', 'chat.db'); }
function defaultSqlite() { return '/usr/bin/sqlite3'; }

let opts = { dbPath: defaultDbPath, sqlitePath: defaultSqlite() };
function _configure(patch = {}) { opts = { ...opts, ...patch }; }
function _reset() { opts = { dbPath: defaultDbPath, sqlitePath: defaultSqlite() }; }
// Paths may be injected as strings (tests) or as lazy functions (production).
const resolveDb = () => (typeof opts.dbPath === 'function' ? opts.dbPath() : opts.dbPath);
const resolveSqlite = () => (typeof opts.sqlitePath === 'function' ? opts.sqlitePath() : opts.sqlitePath);

function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

/** Apple-ns → unix ms, tolerant of iOS/macOS unit variants. */
function appleToUnixMs(value) {
  const raw = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0));
  if (raw === 0n) return null;
  // Values below ~1e13 are seconds (or ms); above are nanoseconds.
  if (raw > 10n ** 15n) return APPLE_EPOCH_MS + Number(raw / 1_000_000n);
  if (raw > 10n ** 11n) return APPLE_EPOCH_MS + Number(raw);
  return APPLE_EPOCH_MS + Number(raw * 1000n);
}

function isoFromApple(value) {
  const ms = appleToUnixMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

/* ---------------- attributedBody decoding ---------------- */

/**
 * Class names that appear in an NSAttributedString archive and must never be
 * mistaken for the message body.
 */
const ARCHIVE_CLASS_NAMES = new Set([
  'NSString', 'NSMutableString', 'NSDictionary', 'NSMutableDictionary',
  'NSArray', 'NSMutableArray', 'NSAttributedString', 'NSMutableAttributedString',
  'NSDocumentAttributes', 'NSMutableData', 'NSData', 'NSNumber', 'NSNull',
  'NSUUID', 'NSURL', 'NSCharacterSet', 'NSMutableIndexSet', 'NSIndexSet',
]);

/** True when a decoded chunk looks like human text rather than a class name. */
function looksLikeText(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (ARCHIVE_CLASS_NAMES.has(value)) return false;
  if (/^(NS|IM|MS|__kIM|DDScanner|typedstream|streamtyped)/.test(value)) return false;
  // must contain at least one printable, non-control character
  return /[\p{L}\p{N}\p{P}\p{S} ]/u.test(value);
}

/**
 * Tokenize a NeXTSTEP `typedstream` archive and collect its embedded
 * length-prefixed strings.
 *
 * The format (version 1) is a flat stream of typed objects. Strings are
 * introduced by a type byte (0x81 immutable, 0x84/0x85 mutable) followed by
 * a 4-byte big-endian length and then exactly that many bytes. Apple also
 * uses a compact length encoding for short strings, so both are handled.
 */
function scanTypedstreamStrings(buf) {
  const out = [];
  const len = buf.length;
  for (let i = 0; i < len - 4; i += 1) {
    const marker = buf[i];
    if (marker !== 0x81 && marker !== 0x84 && marker !== 0x85) continue;
    const size = buf.readUInt32BE(i + 1);
    // A plausible string length: non-zero, in range, and not absurd.
    if (size === 0 || size > len - i - 5) continue;
    const slice = buf.subarray(i + 5, i + 5 + size);
    let text;
    try { text = slice.toString('utf8'); } catch { continue; }
    // Reject slices that contain NUL-heavy binary (not a real string).
    if (text.includes('\u0000')) continue;
    out.push({ text, offset: i });
    i += 4 + size; // skip the payload
  }
  return out;
}

/**
 * Decode a binary property list and collect its string values.
 * Only the subset Apple uses for `attributedBody` is handled: ASCII/UTF-16
 * strings inside the object table.
 */
function scanBplistStrings(buf) {
  const out = [];
  if (buf.length < 40) return out;
  // Trailer: 32 bytes; first 8 hold the offsets of offset-table, object-table,
  // top-object, offset-table-size and object-ref-size.
  const trailer = buf.subarray(buf.length - 32);
  const offsetTableOffset = Number(trailer.readBigUInt64BE(0));
  const objectTableOffset = Number(trailer.readBigUInt64BE(8));
  const objectCount = Number(trailer.readBigUInt64BE(16));
  const topObject = Number(trailer.readBigUInt64BE(24));
  if (!Number.isFinite(offsetTableOffset) || !Number.isFinite(objectTableOffset)) return out;
  if (objectCount === 0 || objectCount > 100_000) return out;
  // Walk the offset table to find object boundaries.
  const offsets = [];
  for (let i = 0; i < objectCount; i += 1) {
    const at = offsetTableOffset + i * 8;
    if (at + 8 > buf.length) break;
    offsets.push(Number(buf.readBigUInt64BE(at)));
  }
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : objectTableOffset;
    if (start < 0 || end > buf.length || end <= start) continue;
    const obj = buf.subarray(start, end);
    const marker = obj[0];
    if (marker !== 0x55 && marker !== 0x5a) continue; // ASCII / UTF-16 string
    let text;
    if (marker === 0x55) {
      text = obj.subarray(1).toString('utf8');
    } else {
      // UTF-16BE
      const body = obj.subarray(1);
      text = swapUtf16(body).toString('utf16le');
    }
    if (text) out.push({ text, offset: start });
  }
  void topObject;
  return out;
}

/** Swap byte order of a UTF-16 buffer (big-endian → little-endian). */
function swapUtf16(buf) {
  const copy = Buffer.from(buf);
  if (copy.length % 2 !== 0) return copy;
  for (let i = 0; i < copy.length; i += 2) {
    const t = copy[i];
    copy[i] = copy[i + 1];
    copy[i + 1] = t;
  }
  return copy;
}

/**
 * Recover text from an attributedBody blob (best effort).
 *
 * Handles the two real shapes:
 *  - a binary plist (`bplist00…`)
 *  - a NeXTSTEP `typedstream` archive (`04 0b "streamtyped" …`)
 *
 * Both carry the message body as a length-prefixed string, so the length
 * prefix is consumed exactly — the previous implementation split the blob on
 * control bytes and left the length byte glued to the front of the message.
 */
function decodeAttributedBody(buffer) {
  if (!buffer) return null;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'latin1');
  if (!buf.length) return null;

  // 1) binary plist
  if (buf.length > 8 && buf.subarray(0, 8).toString('latin1') === 'bplist00') {
    const candidates = scanBplistStrings(buf).filter((c) => looksLikeText(c.text));
    if (candidates.length) return trimBody(candidates[candidates.length - 1].text);
  }

  // 2) typedstream archive
  if (buf.length > 14 && buf.subarray(2, 13).toString('latin1') === 'streamtyped') {
    const candidates = scanTypedstreamStrings(buf).filter((c) => looksLikeText(c.text));
    if (candidates.length) return trimBody(pickBody(candidates));
  }

  // 3) legacy fallback: split on control bytes after the 'NSString' marker.
  //    Binary bytes that are not valid UTF-8 decode to U+FFFD, and the
  //    length prefix of the next string would be glued to the run — both are
  //    stripped here, and a run that is only an archive class name is
  //    rejected (an archive with no body must decode to null, not to
  //    "NSMutableString").
  const text = buf.toString('utf8');
  const marker = text.lastIndexOf('NSString');
  const tail = marker === -1 ? text : text.slice(marker + 'NSString'.length);
  const runs = tail
    .split(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]+/)
    .map(sanitizeRun)
    .filter(Boolean);
  const candidate = runs.find((run) => looksLikeText(run));
  if (!candidate) return null;
  return trimBody(candidate);
}

/** Strip binary noise (replacement chars, control bytes) from a candidate run. */
function sanitizeRun(run) {
  return String(run ?? '')
    .replace(/[\uFFFD\u0000-\u001F\u007F-\u009F]+/g, '')
    .trim();
}

/**
 * Pick the body among the archive's strings.
 *
 * The archive holds class names, format hints and the actual body. The body
 * is the longest human-looking string, and it is never a class name.
 */
function pickBody(candidates) {
  const scored = candidates
    .map((c) => ({ text: c.text, score: c.text.length }))
    .sort((a, b) => b.score - a.score);
  return scored[0].text;
}

function trimBody(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
}

/** Escape a value for direct embedding in a SQL literal (single quotes). */
function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Run SQL through the sqlite3 CLI, read-only, JSON output.
 * @returns {Promise<{denied:boolean, rows:Array}>}
 */
function runSql(sql, { dbPath = resolveDb(), sqlitePath = resolveSqlite(), timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(dbPath)) {
      reject(Object.assign(new Error(`chat.db not found at ${dbPath}`), { code: 'ENOENT_CHATDB' }));
      return;
    }
    const child = execFile(sqlitePath, ['-readonly', '-json', dbPath], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || '');
        if (/authorization denied|unable to open database|Operation not permitted/i.test(message)) {
          reject(Object.assign(new Error('Full Disk Access is required to read Messages (System Settings → Privacy & Security → Full Disk Access)'), { code: 'NEEDS_FDA' }));
          return;
        }
        reject(new Error(message.trim() || `sqlite3 exited ${error.code}`));
        return;
      }
      const text = String(stdout ?? '').trim();
      if (!text) { resolve([]); return; }
      try {
        const parsed = JSON.parse(text);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (parseError) {
        reject(new Error(`could not parse sqlite3 output: ${parseError.message}`));
      }
    });
    // SQL goes in over stdin so quoting never touches a shell.
    child.stdin?.end(`${sql}\n`);
  });
}

const CHAT_SELECT = `
select c.ROWID as id,
       c.guid as guid,
       c.chat_identifier as identifier,
       coalesce(nullif(c.display_name, ''), c.chat_identifier) as title,
       c.service_name as service,
       (select max(m.date) from message m join chat_message_join j on j.message_id = m.ROWID where j.chat_id = c.ROWID) as last_date,
       (select count(*) from chat_message_join j where j.chat_id = c.ROWID) as message_count
from chat c`;

/** List conversations, newest first. */
async function listChats({ limit = 30, dbPath } = {}) {
  const rows = await runSql(`${CHAT_SELECT}\norder by (last_date is null), last_date desc limit ${clampLimit(limit)}`, { dbPath });
  return {
    chats: rows.map((row) => ({
      id: Number(row.id),
      guid: row.guid,
      identifier: row.identifier,
      title: row.title,
      service: row.service,
      messageCount: Number(row.message_count ?? 0),
      lastMessageAt: isoFromApple(row.last_date),
    })),
  };
}

function attachQuery(messageIds) {
  if (!messageIds.length) return null;
  return `select maj.message_id as message_id, a.filename as filename, a.mime_type as mime, a.transfer_name as name
from message_attachment_join maj join attachment a on a.ROWID = maj.attachment_id
where maj.message_id in (${messageIds.join(',')})`;
}

/**
 * Shape one message row.
 *
 * Beyond the body text this now surfaces the metadata Grok Bot's
 * `messages-worker.cjs` also reads: the reaction applied to *this* message
 * (a tapback on someone else's bubble), whether the message is itself a
 * tapback, its thread root, and edit/retract timestamps.
 */
function shapeMessage(row, attachments = []) {
  const fromBody = row.text == null ? decodeAttributedBody(row.attributed_body) : null;
  const text = row.text != null ? String(row.text) : (fromBody ?? '');
  const reaction = decodeReaction(row.associated_message_type);
  return {
    id: Number(row.id),
    guid: row.guid,
    at: isoFromApple(row.date),
    fromMe: Number(row.is_from_me) === 1,
    sender: row.handle || null,
    service: row.service,
    text,
    textSource: row.text != null ? 'text' : (fromBody != null ? 'attributedBody' : 'none'),
    // a tapback ON this message (the reaction row points at it)
    reactions: reaction ? [reaction] : [],
    // a tapback BY this message (it reacts to another message)
    isReaction: reaction !== null,
    reactsToGuid: row.associated_message_guid || null,
    threadRootGuid: row.thread_originator_guid || null,
    editedAt: isoFromApple(row.date_edited),
    retractedAt: isoFromApple(row.date_retracted),
    attachments: attachments.map((a) => ({
      name: a.name || (a.filename ? path.basename(String(a.filename)) : null),
      mime: a.mime || null,
      path: a.filename ? String(a.filename).replace(/^~/, os.homedir()) : null,
    })),
  };
}

/**
 * Columns we read from `message`, with a fallback for schemas that lack
 * them. The macOS `chat.db` schema has changed across releases (and some
 * rows come from a slightly different build), so we probe once and select
 * only what actually exists.
 */
const MESSAGE_COLUMNS = {
  associated_message_type: 'm.associated_message_type',
  associated_message_guid: 'm.associated_message_guid',
  thread_originator_guid: 'm.thread_originator_guid',
  date_edited: 'm.date_edited',
  date_retracted: 'm.date_retracted',
};

/** dbPath -> Set of available column names (probed lazily, cached). */
const schemaCache = new Map();

/**
 * Probe which message columns exist. Returns the set of available keys.
 * Never throws: an unreadable schema yields the minimal set.
 */
async function messageSchema(dbPath) {
  const key = dbPath || 'default';
  if (schemaCache.has(key)) return schemaCache.get(key);
  const available = new Set(['id', 'guid', 'date', 'is_from_me', 'service', 'text', 'attributed_body', 'handle']);
  try {
    const rows = await runSql('pragma table_info(message);', { dbPath });
    for (const row of rows) {
      const name = String(row?.name ?? '');
      if (name === 'associated_message_type') available.add('associated_message_type');
      if (name === 'associated_message_guid') available.add('associated_message_guid');
      if (name === 'thread_originator_guid') available.add('thread_originator_guid');
      if (name === 'date_edited') available.add('date_edited');
      if (name === 'date_retracted') available.add('date_retracted');
    }
  } catch { /* minimal schema */ }
  schemaCache.set(key, available);
  return available;
}

/** Forget the cached schema (used when the database path changes). */
function resetSchemaCache() { schemaCache.clear(); }

/**
 * Build the message SELECT for the columns this database actually has.
 * @param {Set<string>} available
 */
function buildMessageSelect(available) {
  const parts = [
    'm.ROWID as id',
    'm.guid as guid',
    'm.date as date',
    'm.is_from_me as is_from_me',
    'm.service as service',
    'm.text as text',
    'm.attributedBody as attributed_body',
  ];
  for (const [key, column] of Object.entries(MESSAGE_COLUMNS)) {
    if (available.has(key)) parts.push(column + ' as ' + key);
  }
  parts.push('h.uncanonicalized_id as handle');
  return `select ${parts.join(', ')}
from message m
left join handle h on h.ROWID = m.handle_id`;
}

/**
 * Decode the reaction type Apple stores in `associated_message_type`.
 *  2000-2005 -> a tapback was added (2000 = love, 2001 = like, 2002 = dislike,
 *               2003 = laugh, 2004 = emphasize, 2005 = question)
 *  3000-3005 -> the matching tapback was removed
 * @returns {{ kind: 'add'|'remove', reaction: string }|null}
 */
function decodeReaction(type) {
  const n = Number(type ?? 0);
  const names = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'];
  if (n >= TAPBACK_ADD_MIN && n <= TAPBACK_ADD_MAX) {
    return { kind: 'add', reaction: names[n - TAPBACK_ADD_MIN] ?? 'unknown' };
  }
  if (n >= TAPBACK_REMOVE_MIN && n <= TAPBACK_REMOVE_MAX) {
    return { kind: 'remove', reaction: names[n - TAPBACK_REMOVE_MIN] ?? 'unknown' };
  }
  return null;
}

/**
 * Read messages in a conversation (by numeric chat id or by handle/identifier).
 */
async function readMessages({ chatId, identifier, limit = DEFAULT_LIMIT, since, dbPath } = {}) {
  const cap = clampLimit(limit);
  let where;
  if (chatId != null && chatId !== '') {
    const id = Number(chatId);
    if (!Number.isFinite(id)) throw new Error('chatId must be numeric');
    where = `where m.ROWID in (select message_id from chat_message_join where chat_id = ${Math.trunc(id)})`;
  } else if (identifier) {
    where = `where m.ROWID in (select message_id from chat_message_join where chat_id in (select ROWID from chat where chat_identifier = ${sqlLiteral(identifier)}))`;
  } else {
    where = '';
  }
  if (since) {
    const ms = Date.parse(since);
    if (Number.isFinite(ms)) {
      const appleNs = BigInt(Math.trunc(ms - APPLE_EPOCH_MS)) * 1_000_000n;
      where += `${where ? ' and' : 'where'} m.date >= ${appleNs}`;
    }
  }
  const schema = await messageSchema(dbPath);
  const rows = await runSql(`${buildMessageSelect(schema)}
${where}
order by m.date desc limit ${cap}`, { dbPath });
  const ids = rows.map((r) => Number(r.id)).filter(Number.isFinite);
  let attachments = [];
  const attSql = attachQuery(ids);
  if (attSql) attachments = await runSql(attSql, { dbPath }).catch(() => []);
  const byMessage = new Map();
  for (const a of attachments) {
    const key = Number(a.message_id);
    if (!byMessage.has(key)) byMessage.set(key, []);
    byMessage.get(key).push(a);
  }
  return { messages: rows.map((row) => shapeMessage(row, byMessage.get(Number(row.id)) ?? [])) };
}

/** Full-text search across message bodies (substring match). */
async function searchMessages({ query, limit = DEFAULT_LIMIT, dbPath } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query is required');
  const cap = clampLimit(limit);
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const schema = await messageSchema(dbPath);
  const select = buildMessageSelect(schema);
  const rows = await runSql(
    `${select}
where m.text like ${sqlLiteral(like)} escape '\\'
order by m.date desc limit ${cap}`,
    { dbPath },
  ).catch(async (error) => {
    // Some libraries store no `text`; fall back to a scan of attributedBody.
    if (error.code === 'NEEDS_FDA' || error.code === 'ENOENT_CHATDB') throw error;
    const fallback = await runSql(`${select}
order by m.date desc limit ${cap * 4}`, { dbPath });
    const needle = q.toLowerCase();
    return fallback.filter((row) => decodeAttributedBody(row.attributed_body)?.toLowerCase().includes(needle)).slice(0, cap);
  });
  return { query: q, messages: rows.map((row) => shapeMessage(row)) };
}

/** Permission/health probe: does the DB exist and can we actually query it? */
async function probe({ dbPath } = {}) {
  const target = dbPath || resolveDb();
  if (!fs.existsSync(target)) return { status: 'missing', ok: false, code: 'ENOENT_CHATDB', path: target };
  try {
    await runSql('select 1 as ok', { dbPath: target });
    return { status: 'granted', ok: true, readable: true, path: target };
  } catch (error) {
    if (error.code === 'NEEDS_FDA') {
      return { status: 'denied', ok: false, code: 'NEEDS_FDA', path: target, hint: error.message };
    }
    return { status: 'error', ok: false, code: 'READ_FAILED', path: target, error: error.message };
  }
}

module.exports = {
  imessageReader: {
    listChats, readMessages, searchMessages, probe,
    decodeAttributedBody, decodeReaction, appleToUnixMs, isoFromApple,
    _configure, _reset, defaultDbPath,
  },
  _internal: { runSql, clampLimit, sqlLiteral, APPLE_EPOCH_MS, decodeAttributedBody, appleToUnixMs },
};
