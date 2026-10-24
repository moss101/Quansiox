import React, { useMemo, useState } from 'react';

/**
 * The diff view.
 *
 * The `edit_file` and `pi_edit` tools already return a real unified diff.
 * Until now the transcript showed it as a raw `<pre>`, which is not a diff
 * view — it is a text file that happens to contain a diff.
 *
 * This renders it properly: the hunks, the line numbers, the added and
 * removed lines coloured by role, and collapsible hunks so a big diff does
 * not bury the conversation.
 *
 * Pure presentational — no API calls, no state beyond the collapsed hunks.
 */

/**
 * Parse a unified diff into hunks.
 *
 * @param {string} diff
 * @returns {Array<{ header: string, lines: Array<{ kind: string, text: string, old: number|null, new: number|null }> }>}
 */
export function parseDiff(diff) {
  const text = String(diff ?? '');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const hunks = [];
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const header = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { header: line, section: header[3].trim(), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      // Text before the first hunk header (a file header, for instance).
      continue;
    }
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), old: null, new: newLine });
      newLine += 1;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'remove', text: line.slice(1), old: oldLine, new: null });
      oldLine += 1;
    } else if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', text: line.slice(1), old: null, new: null });
    } else {
      hunk.lines.push({ kind: 'context', text: line.slice(1), old: oldLine, new: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks.filter((h) => h.lines.length);
}

/** One hunk. */
function Hunk({ hunk, initiallyCollapsed }) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const added = hunk.lines.filter((l) => l.kind === 'add').length;
  const removed = hunk.lines.filter((l) => l.kind === 'remove').length;
  return (
    <div className="diff-hunk" data-surface="diff-hunk" data-added={added} data-removed={removed}>
      <button
        type="button"
        className="diff-hunk-header"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="diff-hunk-title">{hunk.header}</span>
        <span className="diff-hunk-counts">
          {added ? <span className="diff-count add">+{added}</span> : null}
          {removed ? <span className="diff-count remove">−{removed}</span> : null}
        </span>
      </button>
      {!collapsed ? (
        <div className="diff-lines">
          {hunk.lines.map((line, index) => (
            <div key={`${line.kind}-${index}`} className={`diff-line diff-${line.kind}`} data-kind={line.kind}>
              <span className="diff-gutter old">{line.old ?? ''}</span>
              <span className="diff-gutter new">{line.new ?? ''}</span>
              <span className="diff-marker">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The diff view.
 *
 * @param {object} props
 * @param {string} props.diff       a unified diff
 * @param {boolean} [props.collapsible]
 */
export function DiffView({ diff, collapsible = true }) {
  const hunks = useMemo(() => parseDiff(diff), [diff]);
  if (!hunks.length) {
    return (
      <div className="diff-view diff-empty" data-surface="diff-view">
        <span className="diff-empty-text">No changes</span>
      </div>
    );
  }
  return (
    <div className="diff-view" data-surface="diff-view">
      {hunks.map((hunk, index) => (
        <Hunk key={`${hunk.header}-${index}`} hunk={hunk} initiallyCollapsed={collapsible && hunks.length > 2 && index > 0} />
      ))}
    </div>
  );
}

export default DiffView;
