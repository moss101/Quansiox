'use strict';
/**
 * Memory service — local long-term memory (the local-first analog of Grok's
 * "bot memories"): a persistent facts store the agent can write (`remember`)
 * and read (`recall`), with relevant facts auto-injected into the system prompt.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR); mtime-cached like settings so
 * the forked coordinator observes main-process writes. 0600 at rest.
 *
 * Beyond Grok's flat fact list this store understands *supersession*: a new
 * fact about the same subject replaces the old one instead of piling up
 * contradictory rows. Recall also scores phrases, not just single tokens, so
 * "the api key lives in the vault" matches a query about the api key.
 */
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_FACTS = 500;
const MAX_TEXT = 2000;
const INJECT_LIMIT = 12; // facts surfaced into the system prompt

function userDataDir() {
  return require('./userData').userDataDir();
}

function file() { return path.join(userDataDir(), 'memory.json'); }

let cached = null;
let cachedMtimeMs = -1;
function readAll() {
  try {
    const mtimeMs = fs.statSync(file()).mtimeMs;
    if (cached && mtimeMs === cachedMtimeMs) return cached;
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cached = Array.isArray(parsed) ? parsed : [];
  } catch {
    cached = cached ?? [];
  }
  return cached;
}
function writeAll(facts) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(facts, null, 2), { mode: 0o600 });
  cached = facts;
  cachedMtimeMs = fs.statSync(file()).mtimeMs;
}

function newId() { return 'mem_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
const tokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9_+-]+/g) || [];

/** Word bigrams — phrase matching makes recall much sharper. */
function bigrams(list) {
  const out = [];
  for (let i = 0; i + 1 < list.length; i += 1) out.push(`${list[i]} ${list[i + 1]}`);
  return out;
}

/**
 * Guess the subject of a fact, so "the api key lives in the vault" and
 * "the api key is in 1password" supersede each other.
 *
 * Patterns handled: "my X is Y", "the X is Y", "X lives in Y",
 * "X is stored in Y". Returns a normalised subject or null.
 */
function guessSubject(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  let m = /^(?:my|the|our)\s+([a-z0-9 _-]{2,40}?)\s+(?:is|are|lives in|is stored in|is in)\b/.exec(s);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  m = /^([a-z0-9 _-]{2,40}?)\s+(?:lives in|is stored in)\b/.exec(s);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  return null;
}

function list({ scope } = {}) {
  return readAll()
    .filter((f) => f.superseded !== true)
    .filter((f) => !scope || (f.scope || 'global') === scope || (f.scope || 'global') === 'global')
    .map(({ id, text, tags, scope: factScope, subject, createdAt, updatedAt, uses }) => ({
      id, text, tags: tags || [], scope: factScope || 'global', subject: subject ?? null,
      createdAt, updatedAt, uses: uses || 0,
    }));
}

/**
 * Store a fact; if an equivalent text exists, refresh it (bump uses/tags).
 *
 * When a subject is given (or inferred) and an active fact already covers
 * that subject, the old fact is marked superseded instead of contradicting
 * the new one.
 */
function remember(text, { tags, id, scope, subject } = {}) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('memory needs text');
  if (body.length > MAX_TEXT) throw new Error(`memory too long (>${MAX_TEXT})`);
  const facts = readAll();
  const now = Date.now();
  const norm = body.toLowerCase();
  const scoped = scope ? String(scope).slice(0, 64) : 'global';
  const factSubject = subject ? String(subject).slice(0, 120).toLowerCase() : guessSubject(body);

  const existing = facts.find((f) => f.text.toLowerCase() === norm && (f.scope || 'global') === scoped)
    || (id && ID_RE.test(id) ? facts.find((f) => f.id === id) : null);
  if (existing) {
    existing.text = body;
    existing.updatedAt = now;
    existing.uses = (existing.uses || 0) + 1;
    if (factSubject) existing.subject = factSubject;
    if (Array.isArray(tags)) existing.tags = [...new Set([...(existing.tags || []), ...tags.map(String)])];
    writeAll(facts);
    return reduced(existing);
  }

  // Supersede an older fact about the same subject.
  if (factSubject) {
    for (const f of facts) {
      if (f.superseded === true) continue;
      if ((f.scope || 'global') !== scoped) continue;
      if (f.subject === factSubject) {
        f.superseded = true;
        f.supersededAt = now;
      }
    }
  }

  if (facts.filter((f) => f.superseded !== true).length >= MAX_FACTS) {
    throw new Error('memory is full (max 500 facts)');
  }
  const fact = {
    id: (id && ID_RE.test(id) && !facts.some((f) => f.id === id)) ? id : newId(),
    text: body, tags: (Array.isArray(tags) ? tags.map(String) : []).slice(0, 8), scope: scoped,
    subject: factSubject,
    createdAt: now, updatedAt: now, uses: 1,
  };
  facts.push(fact);
  writeAll(facts);
  return reduced(fact);
}

function forget(id) {
  const facts = readAll().filter((f) => f.id !== String(id || ''));
  const removed = facts.length !== readAll().length;
  writeAll(facts);
  return { removed };
}

/**
 * Keyword + phrase scored recall: tag matches, shared tokens, shared
 * bigrams, then recency as a tie-break. Superseded facts are excluded.
 */
function recall(query, { limit = 8, tags, scope } = {}) {
  const q = tokens(query);
  const qBigrams = new Set(bigrams(q));
  const wantTags = tags ? new Set((Array.isArray(tags) ? tags : [tags]).map(String)) : null;
  const scoped = scope ? String(scope).slice(0, 64) : null;
  const scored = readAll()
    .filter((f) => f.superseded !== true)
    .filter((f) => !scoped || (f.scope || 'global') === scoped || (f.scope || 'global') === 'global')
    .map((f) => {
      const factTokens = new Set(tokens(f.text));
      const factBigrams = new Set(bigrams(tokens(f.text)));
      const hits = q.reduce((n, t) => n + (factTokens.has(t) ? 1 : 0), 0);
      const phraseHits = [...qBigrams].reduce((n, b) => n + (factBigrams.has(b) ? 1 : 0), 0);
      const tagHits = (f.tags || []).filter((t) => wantTags?.has(t)).length;
      const qTagHits = (f.tags || []).filter((t) => q.includes(t)).length;
      const subjectHit = f.subject && q.some((t) => f.subject.includes(t)) ? 2 : 0;
      const match = hits * 2 + phraseHits * 4 + tagHits * 3 + qTagHits * 3 + subjectHit;
      return { fact: f, match };
    })
    .filter((x) => x.match > 0); // only genuine matches (uses is a tie-break, not a match)
  scored.sort((a, b) => b.match - a.match || (b.fact.uses || 0) - (a.fact.uses || 0) || (b.fact.updatedAt || 0) - (a.fact.updatedAt || 0));
  return scored.slice(0, Math.max(1, Number(limit) || 8)).map((x) => reduced(x.fact));
}

/** Recent facts for prompt injection (recency + uses), capped. */
function relevant({ limit = INJECT_LIMIT, scope } = {}) {
  const scoped = scope ? String(scope).slice(0, 64) : null;
  return readAll()
    .filter((f) => f.superseded !== true)
    .filter((f) => !scoped || (f.scope || 'global') === scoped || (f.scope || 'global') === 'global')
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, Math.max(1, Number(limit) || INJECT_LIMIT))
    .map(reduced);
}

const reduced = (f) => ({
  id: f.id, text: f.text, tags: f.tags || [], scope: f.scope || 'global',
  subject: f.subject ?? null, createdAt: f.createdAt, updatedAt: f.updatedAt,
});

module.exports = { memoryService: { list, remember, recall, forget, relevant, guessSubject } };
