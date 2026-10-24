'use strict';
/**
 * Composer model (parity plan P2.3) — pure, electron-free.
 *
 * The pieces of Grok's composer that are logic, not UI:
 *
 *   voiceMemoReducer — the voice-memo state machine (idle → recording ⇄
 *     paused → stopped), with guards so stray events can't corrupt a take.
 *   downsample       — peak history → fixed-width waveform bars.
 *   wordDiff         — the draft-revision highlighter: word-level diff
 *     (LCS) between the text being revised and the current draft.
 *   memoClock        — elapsed recording time as m:ss.
 */

export const MEMO_STATES = ['idle', 'recording', 'paused', 'stopped', 'error'];

/** @returns {typeof MEMO_STATES[number]} next state, or the same state when the event is illegal there. */
export function voiceMemoReducer(state, event) {
  switch (state) {
    case 'idle':
      if (event === 'start') return 'recording';
      return state;
    case 'recording':
      if (event === 'pause') return 'paused';
      if (event === 'stop') return 'stopped';
      if (event === 'cancel') return 'idle';
      if (event === 'error') return 'error';
      return state;
    case 'paused':
      if (event === 'resume') return 'recording';
      if (event === 'stop') return 'stopped';
      if (event === 'cancel') return 'idle';
      if (event === 'error') return 'error';
      return state;
    case 'stopped':
      if (event === 'reset') return 'idle';
      return state;
    case 'error':
      if (event === 'reset') return 'idle';
      return state;
    default:
      return 'idle';
  }
}

/** Whether the MediaRecorder is actually capturing in this state. */
export function isCapturing(state) {
  return state === 'recording';
}

/**
 * Peak history (0..1, sampled while recording) → `buckets` display bars.
 * Uniform bucket mean keeps the shape stable as history grows.
 */
export function downsample(peaks, buckets = 48) {
  const src = (Array.isArray(peaks) ? peaks : []).filter((v) => Number.isFinite(v));
  if (!src.length) return new Array(buckets).fill(0);
  if (src.length <= buckets) {
    const out = src.slice();
    while (out.length < buckets) out.push(0);
    return out;
  }
  const out = [];
  for (let i = 0; i < buckets; i += 1) {
    const from = Math.floor((i * src.length) / buckets);
    const to = Math.max(from + 1, Math.floor(((i + 1) * src.length) / buckets));
    let sum = 0;
    for (let j = from; j < to && j < src.length; j += 1) sum += src[j];
    out.push(sum / (to - from));
  }
  return out;
}

/** @returns {string} "0:07" style clock. */
export function memoClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const WORD_SPLIT = /\s+/;

/**
 * Word-level diff via longest-common-subsequence, for the draft-revision
 * highlighter. Words are the unit (Grok highlights changed words, not
 * characters). Whitespace-normalized; order preserved.
 * @returns {Array<{type: 'same'|'ins'|'del', text: string}>} runs, coalesced.
 */
export function wordDiff(before, after) {
  const a = String(before ?? '').split(WORD_SPLIT).filter(Boolean);
  const b = String(after ?? '').split(WORD_SPLIT).filter(Boolean);
  // LCS table (texts are drafts — small).
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const runs = [];
  const push = (type, text) => {
    const last = runs[runs.length - 1];
    if (last && last.type === type) last.text += ` ${text}`;
    else runs.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push('same', a[i]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { push('del', a[i]); i += 1; }
    else { push('ins', b[j]); j += 1; }
  }
  while (i < a.length) { push('del', a[i]); i += 1; }
  while (j < b.length) { push('ins', b[j]); j += 1; }
  return runs;
}

/** The highlight is meaningful only when there is a revision base and it differs. */
export function hasRevision(base, draft) {
  const b = String(base ?? '').trim();
  const d = String(draft ?? '').trim();
  return b !== '' && d !== '' && b !== d;
}
