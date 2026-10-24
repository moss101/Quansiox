'use strict';
/**
 * Saved-messages view model (parity plan P2.4 remainder) — pure.
 * The Library groups saved messages by session (Grok's library groups by
 * conversation) with newest-saved first inside each group; snippets are
 * single-line previews. Node-testable without the renderer. */

/** @param {Array<{sessionId?: string|null, bumpedAt?: number}>} saved */
export function groupBySession(saved) {
  const list = [...(Array.isArray(saved) ? saved : [])]
    .sort((a, b) => (b.bumpedAt ?? 0) - (a.bumpedAt ?? 0));
  const groups = new Map();
  for (const entry of list) {
    const key = entry.sessionId ?? 'unsaved-session';
    if (!groups.has(key)) groups.set(key, { sessionId: entry.sessionId, items: [] });
    groups.get(key).items.push(entry);
  }
  return [...groups.values()];
}

/** One-line preview: collapse whitespace, clamp to `max` chars with an
 * ellipsis that never eats a word fragment silently. */
export function snippet(text, max = 140) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Display label for a group: the session id, prettified. */
export function groupLabel(sessionId, titles = {}) {
  if (!sessionId) return 'Unknown session';
  const title = titles[String(sessionId)];
  if (title && String(title).trim()) return String(title);
  return String(sessionId);
}
