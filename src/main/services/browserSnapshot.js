'use strict';
/**
 * Join a CDP DOMSnapshot.captureSnapshot result with an Accessibility tree
 * into the agent-facing ref map. Used by both the host WebContentsView browser
 * and the per-bot Linux guest browser (CDP over vsock), so refs/staleness mean
 * the same thing regardless of where the page runs.
 */
const NODE_BUDGET = 2000;
const TEXT_CAP = 100_000;
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'searchbox',
  'slider', 'switch', 'spinbutton', 'listbox', 'gridcell', 'treeitem',
]);
const INTERESTING_EXTRA = new Set(['heading', 'statictext', 'image', 'dialog', 'alert', 'progressbar']);

function buildBrowserSnapshot({
  dom, ax, documentRevision = 0, mutationGeneration = 0, snapshotId,
  nodeBudget = NODE_BUDGET, textCap = TEXT_CAP,
}) {
  const doc = dom?.documents?.[0];
  const boxes = new Map();
  if (doc && Array.isArray(doc.nodes?.backendNodeId) && doc.layout?.nodeIndex) {
    const { nodes, layout } = doc;
    for (let li = 0; li < layout.nodeIndex.length; li += 1) {
      const backend = nodes.backendNodeId[layout.nodeIndex[li]];
      const bounds = layout.bounds?.[li];
      if (!backend || !Array.isArray(bounds) || bounds.length < 4) continue;
      const [x, y, width, height] = bounds;
      if (width > 0 && height > 0) {
        boxes.set(backend, {
          x: x - (doc.scrollOffsetX || 0),
          y: y - (doc.scrollOffsetY || 0),
          width,
          height,
        });
      }
    }
  }
  const byNodeId = new Map((ax?.nodes ?? []).map((n) => [n.nodeId, n]));
  const refs = new Map();
  const lines = [];
  let refCounter = 0;
  const nameOf = (n) => {
    const v = n.name?.value ?? n.name ?? '';
    return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  };
  const walk = (node, depth) => {
    if (lines.length > nodeBudget || depth > 24) return;
    const role = String(node.role?.value ?? node.role ?? 'generic').toLowerCase();
    const name = nameOf(node);
    const value = typeof node.value?.value === 'string' ? node.value.value : '';
    const backend = node.backendDOMNodeId;
    const interesting = name || value || INTERACTIVE.has(role) || INTERESTING_EXTRA.has(role);
    if (interesting) {
      refCounter += 1;
      const ref = `e${refCounter}`;
      const box = boxes.get(backend);
      if (box) refs.set(ref, { backend, role, name, box, nodeId: node.nodeId });
      let line = `${'  '.repeat(depth)}- ${role}`;
      if (name) line += ` "${name.slice(0, 200)}"`;
      if (value) line += ` = "${value.slice(0, 120)}"`;
      if (!box) line += ' [no-rect]';
      lines.push(`${line} [ref=${ref}]`);
    }
    for (const childId of node.childIds ?? []) {
      const child = byNodeId.get(childId);
      if (child) walk(child, interesting ? depth + 1 : depth);
    }
  };
  const roots = (ax?.nodes ?? []).filter(
    (n) => !byNodeId.has(n.parentId ?? -1) || n.parentId === null || n.parentId === undefined);
  for (const root of roots) walk(root, 0);
  const header =
    `snapshot_id=${snapshotId} documentRevision=${documentRevision} ` +
    `mutationGeneration=${mutationGeneration} ` +
    `(pass snapshot_id to actions; it goes stale after navigation or DOM changes — then re-run browser_snapshot)`;
  const text = `${header}\n${lines.join('\n')}`.slice(0, textCap);
  return { snapshotId, documentRevision, mutationGeneration, text, refCount: refs.size, refs };
}

module.exports = { buildBrowserSnapshot, NODE_BUDGET, TEXT_CAP };
