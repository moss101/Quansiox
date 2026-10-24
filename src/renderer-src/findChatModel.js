'use strict';
/**
 * Find-in-chat model (parity plan P2.4 remainder) — pure, electron-free.
 *
 * The find bar's logic, extracted so it is testable without a renderer:
 *
 *   matchItems  — which transcript items match the query, in transcript
 *                 order (user/assistant text, case-insensitive).
 *   stepIndex   — next/prev navigation with wraparound in BOTH directions,
 *                 clamped against an empty or shrunken match list (the
 *                 transcript can compact mid-search; the index must never
 *                 claim "5/2").
 *   activeItem  — the match a given index denotes, after clamping.
 */

/** @param {Array<{kind?: string, text?: string}>} items transcript items */
export function matchItems(items, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  return (Array.isArray(items) ? items : [])
    .filter((it) => (it?.kind === 'user' || it?.kind === 'assistant')
      && typeof it.text === 'string'
      && it.text.toLowerCase().includes(q));
}

/**
 * @param {number|null} idx current index (null = none yet)
 * @param {number} len match count
 * @param {1|-1} dir
 * @returns {number} the next index — wraps in both directions; 0 when the
 *   list is empty; clamped when the list shrank under the current index.
 */
export function stepIndex(idx, len, dir = 1) {
  if (!len || len < 1) return 0;
  // No selection yet: forward starts at the first match, backward at the
  // last — never skip match 0 on the first Enter.
  if (!Number.isFinite(idx)) return dir === 1 ? 0 : len - 1;
  const clamped = Math.max(0, Math.min(len - 1, idx));
  return (clamped + dir + len) % len;
}

/** Clamp a stored index against the current match count. */
export function clampIndex(idx, len) {
  if (!len || len < 1) return 0;
  return Math.max(0, Math.min(len - 1, Number.isFinite(idx) ? idx : 0));
}

/** The match an index denotes (clamped); null when there are no matches. */
export function activeItem(matches, idx) {
  if (!Array.isArray(matches) || !matches.length) return null;
  return matches[clampIndex(idx, matches.length)] ?? null;
}

/** The count label: "n/m", "0/0" for a query with no hits. */
export function countLabel(matchesLen, idx) {
  const total = Array.isArray(matchesLen) ? matchesLen.length : Math.max(0, matchesLen | 0);
  if (!total) return '0/0';
  return `${clampIndex(idx, total) + 1}/${total}`;
}
