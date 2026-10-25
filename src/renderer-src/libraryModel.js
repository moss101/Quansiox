'use strict';
/**
 * Library v2 view model (parity plan P2.5) — pure.
 * One collection, Grok's kind taxonomy: saved messages (P2.4 store) plus
 * content pins (media/page/document/sheet/deck). Grouped by kind with
 * stable ordering and hover-card payloads. Node-testable. */

export const KIND_ORDER = ['message', 'media', 'page', 'document', 'sheet', 'deck'];

export const KIND_LABELS = {
  message: 'Saved messages',
  media: 'Media',
  page: 'Pages',
  document: 'Documents',
  sheet: 'Sheets',
  deck: 'Decks',
};

/** Normalize a saved-message row into the library shape. */
export function messageEntry(row) {
  return {
    kind: 'message',
    authorKind: row?.kind ?? 'user',
    refId: row?.messageId ?? null,
    sessionId: row?.sessionId ?? null,
    title: null, // messages show their snippet, not a title
    note: '',
    text: row?.text ?? '',
    savedAt: row?.savedAt ?? 0,
    bumpedAt: row?.bumpedAt ?? 0,
    origin: 'transcript',
  };
}

/** Group entries by kind, in KIND_ORDER; unknown kinds sort last by name. */
export function groupByKind(entries) {
  const list = [...(Array.isArray(entries) ? entries : [])]
    .sort((a, b) => (b.bumpedAt ?? 0) - (a.bumpedAt ?? 0));
  const groups = new Map();
  const unknownKinds = [...new Set(list.map((e) => e.kind))].filter((k) => !KIND_ORDER.includes(k)).sort();
  for (const kind of [...KIND_ORDER, ...unknownKinds]) {
    groups.set(kind, []);
  }
  for (const entry of list) {
    if (!groups.has(entry.kind)) groups.set(entry.kind, []);
    groups.get(entry.kind).push(entry);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([kind, items]) => ({ kind, label: KIND_LABELS[kind] ?? kind, items }));
}

/** The hover-card payload for a pin: what it is, where it came from, when. */
export function hoverCard(entry, opts = {}) {
  const label = KIND_LABELS[entry?.kind] ?? String(entry?.kind ?? '');
  const from = entry?.sessionId
    ? (opts.titles?.[String(entry.sessionId)] ? `from ${opts.titles[String(entry.sessionId)]}` : `from session ${String(entry.sessionId).slice(0, 12)}`)
    : 'from this library';
  return {
    headline: entry?.title ?? String(entry?.text ?? '').slice(0, 60) ?? '',
    kindLabel: label,
    origin: entry?.origin ? `${from} · ${entry.origin}` : from,
    hasNote: Boolean(entry?.note),
  };
}

/** Artifact kind → library kind (facts both sides: artifactService KINDS,
 * Grok's library taxonomy). Chart-like artifacts pin as sheets; the rest of
 * the interactive html family pins as pages. */
export function libraryKindForArtifact(artifactKind) {
  if (artifactKind === 'chart') return 'sheet';
  return 'page';
}
