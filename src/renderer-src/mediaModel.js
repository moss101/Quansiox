'use strict';
/**
 * Media model (parity plan P2.6) — pure.
 * Grok's sand-media filmstrip: the media of a conversation in one strip,
 * clickable into a fullscreen viewer. Quansiox's media = transcript images
 * (agent screenshots + user-attached images surfaced as data URLs).
 */

/** Collect the media items of a transcript, in transcript order.
 * @param {Array<{kind?: string, image?: string, images?: string[], at?: number, name?: string}>} items
 * @returns {Array<{id: string, src: string, at: number, from: 'screenshot'|'attachment'}>} */
export function collectMedia(items) {
  const out = [];
  let n = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.kind === 'tool' && typeof item.image === 'string' && item.image) {
      out.push({ id: `m${n++}`, src: item.image, at: item.at ?? 0, from: 'screenshot' });
    }
    for (const src of Array.isArray(item?.images) ? item.images : []) {
      if (typeof src === 'string' && src) {
        out.push({ id: `m${n++}`, src, at: item.at ?? 0, from: 'attachment' });
      }
    }
  }
  return out;
}

/** Lightbox navigation with wraparound (same policy as find-in-chat). */
export function stepIndex(idx, len, dir = 1) {
  if (!len || len < 1) return 0;
  const clamped = Math.max(0, Math.min(len - 1, Number.isFinite(idx) ? idx : 0));
  return (clamped + dir + len) % len;
}

/** The strip's caption: count + origin of the current item. */
export function stripLabel(media, idx) {
  const total = Array.isArray(media) ? media.length : 0;
  if (!total) return '';
  const current = media[Math.max(0, Math.min(total - 1, idx ?? 0))];
  const origin = current?.from === 'screenshot' ? 'screenshot' : 'attached image';
  return `${(idx ?? 0) + 1} of ${total} · ${origin}`;
}
