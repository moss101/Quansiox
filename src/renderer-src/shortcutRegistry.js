'use strict';
/**
 * The sand.* action registry (parity plan P1.7) — pure, electron-free.
 *
 * Grok Bot's shortcut surface is an action registry: named `sand.*` actions,
 * each bound to an accelerator. The identifiers and accelerators below are
 * facts taken verbatim from the 0.75.0 extraction (docs/parity/
 * parity-task-list.md P1.7); the IMPLEMENTATIONS are quansiox's own:
 *
 *   status 'wired'  — a quansiox handler exists on this accelerator
 *   status 'approx' — a nearest-local behavior exists; note names the gap
 *   status 'unmapped' — no local analog; reason names the missing surface
 *                     (honest stub, same policy as the tool-contract map)
 *
 * The shortcuts dialog renders the registry grouped exactly as Grok groups
 * it: Essentials / Chat / Navigation / Panels / Window.
 */

export const SHORTCUT_GROUPS = ['Essentials', 'Chat', 'Navigation', 'Panels', 'Window'];

/** Accelerator grammar: `mod+`, `alt+`, `shift+` modifiers + a key
 * (letter, digit, punctuation like `/`, `,`, `[`, or a named key:
 * `enter`, `ArrowUp`, `ArrowDown`, `plus`, `-`). */
/** Accelerator grammar: `mod+`, `alt+`, `shift+` (`ctrl+` allowed stacked
 * for native menu bindings) + a key: letter, digit, punctuation (`/`, `,`,
 * `.`, `[`, `]`, `-`), or named (`enter`, `tab`, `ArrowUp`, `ArrowDown`,
 * `plus`). Renderer events normalize to mod/alt/shift only (eventToAccel);
 * ctrl-stacked entries are native window bindings. */
const ACCEL_RE = /^(?:(mod|alt|shift|ctrl)\+)*(mod|alt|shift|ctrl|[a-z0-9]|enter|tab|ArrowUp|ArrowDown|plus|[/,.\[\]-])$/i;

function entry(id, accel, group, label, impl) {
  if (!ACCEL_RE.test(accel)) throw new Error(`bad accelerator for ${id}: ${accel}`);
  return { id, accel, group, label, ...impl };
}

/** The focusAgent1..9 family is generated, exactly as Grok's registry does. */
function agentSlots() {
  return Array.from({ length: 9 }, (_, i) => entry(
    `sand.focusAgent${i + 1}`, `mod+${i + 1}`, 'Navigation',
    `Go to ${i + 1 === 1 ? 'agent' : `agent ${i + 1}`}`,
    { status: 'wired', impl: `session slot ${i + 1} (sidebar order)` },
  ));
}

export const SAND_ACTIONS = [
  // ---- Essentials ----
  entry('sand.commandPalette', 'mod+k', 'Essentials', 'Command palette', { status: 'wired', impl: 'palette' }),
  entry('sand.openSettings', 'mod+,', 'Essentials', 'Settings', { status: 'wired', impl: 'settings dialog' }),
  entry('sand.keyboardShortcuts', 'mod+/', 'Essentials', 'Keyboard shortcuts', { status: 'wired', impl: 'shortcuts dialog (⌘⇧/ too)' }),
  entry('sand.keyboardShortcuts.alt', 'mod+shift+/', 'Essentials', 'Keyboard shortcuts (alternate)', { status: 'wired', impl: 'same dialog', aliasOf: 'sand.keyboardShortcuts' }),
  entry('sand.findInChat', 'mod+f', 'Essentials', 'Find in chat', { status: 'wired', impl: 'find bar (P2.4)' }),
  entry('sand.focusSearch', 'mod+shift+f', 'Essentials', 'Search conversations', { status: 'wired', impl: 'palette sessions mode' }),

  // ---- Chat ----
  entry('sand.newAgent', 'mod+n', 'Chat', 'New chat', { status: 'wired', impl: 'new session' }),
  entry('sand.newGroupChat', 'mod+shift+n', 'Chat', 'New group chat', { status: 'unmapped', reason: 'group-chat-composer', impl: 'groups exist (rooms) but no quick-create surface yet' }),
  entry('sand.send', 'mod+enter', 'Chat', 'Send message', { status: 'wired', impl: 'composer submit' }),
  entry('sand.dictate', 'mod+d', 'Chat', 'Dictate', { status: 'wired', impl: 'local dictation loop', fixed: true }),
  entry('sand.addSelectionToPrompt', 'mod+l', 'Chat', 'Add selection to prompt', { status: 'approx', note: 'nearest local behavior focuses the composer; selection-capture is not implemented', impl: 'focus composer' }),
  entry('sand.focusInput', 'mod+i', 'Chat', 'Focus message input', { status: 'wired', impl: 'focus composer' }),

  // ---- Navigation ----
  entry('sand.previousAgent', 'alt+ArrowUp', 'Navigation', 'Previous chat', { status: 'wired', impl: 'session stepping' }),
  entry('sand.nextAgent', 'alt+ArrowDown', 'Navigation', 'Next chat', { status: 'wired', impl: 'session stepping' }),
  entry('sand.cycleAgent', 'mod+Tab', 'Navigation', 'Cycle chats', { status: 'wired', impl: 'session cycling', fixed: true, note: 'Grok fixed binding: ctrl+tab' }),
  entry('sand.navigateBack', 'mod+[', 'Navigation', 'Back in history', { status: 'wired', impl: 'visit history' }),
  entry('sand.navigateForward', 'mod+]', 'Navigation', 'Forward in history', { status: 'wired', impl: 'visit history' }),
  ...agentSlots(),

  // ---- Panels ----
  entry('sand.toggleSidebar', 'mod+b', 'Panels', 'Toggle sidebar', { status: 'wired', impl: 'rail toggle' }),
  entry('sand.togglePanels', 'mod+.', 'Panels', 'Toggle panels', { status: 'wired', impl: 'dock panels', grokName: 'n/a (quansiox panel dock)' }),
  entry('sand.openTools', 'mod+shift+m', 'Panels', 'Tools & connectors', { status: 'wired', impl: 'settings → integrations' }),
  entry('sand.openSkills', 'mod+shift+w', 'Panels', 'Skills', { status: 'approx', note: 'opens integrations; a dedicated skills surface is pending', impl: 'settings → integrations' }),
  entry('sand.toggleAgentSettings', 'mod+shift+,', 'Panels', 'Agent settings', { status: 'approx', note: 'opens the details pane (per-agent settings surface pending)', impl: 'details pane' }),
  entry('sand.toggleDetails', 'mod+alt+b', 'Panels', 'Toggle details', { status: 'wired', impl: 'details pane', grokName: 'n/a (quansiox details)' }),

  // ---- Window (native Electron behaviors) ----
  entry('sand.zoom', 'mod+plus', 'Window', 'Zoom in', { status: 'wired', impl: 'native window zoom', fixed: true }),
  entry('sand.zoomOut', 'mod+-', 'Window', 'Zoom out', { status: 'wired', impl: 'native window zoom', fixed: true }),
  entry('sand.resetZoom', 'mod+0', 'Window', 'Actual size', { status: 'wired', impl: 'native window zoom', fixed: true }),
  entry('sand.fullscreen', 'mod+ctrl+f', 'Window', 'Toggle fullscreen', { status: 'wired', impl: 'native fullscreen', fixed: true }),
];

/** Normalize a KeyboardEvent to the registry's accelerator grammar. */
export function eventToAccel(ev) {
  const parts = [];
  if (ev.metaKey || ev.ctrlKey) parts.push('mod');
  if (ev.altKey) parts.push('alt');
  if (ev.shiftKey) parts.push('shift');
  let key = String(ev.key ?? '');
  if (key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'Shift') return null;
  if (key.length === 1) key = key.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

/** First registry entry whose accelerator matches, or null. */
export function matchAction(accel) {
  if (!accel) return null;
  return SAND_ACTIONS.find((a) => a.accel === accel) ?? null;
}

/** 'mod+shift+/' → '⌘⇧/' (macOS glyph display for the dialog). */
export function accelToGlyph(accel) {
  return String(accel ?? '')
    .replace('mod+', '⌘')
    .replace('alt+', '⌥')
    .replace('shift+', '⇧')
    .replace('ArrowUp', '↑')
    .replace('ArrowDown', '↓')
    .replace('plus', '+')
    .replace('enter', '↵');
}

/** The dialog model: every action grouped, in Grok's group order. */
export function groupedForDialog() {
  return SHORTCUT_GROUPS.map((group) => ({
    group,
    items: SAND_ACTIONS.filter((a) => a.group === group),
  })).filter((g) => g.items.length > 0);
}

/** Coverage summary for tests and the parity ledger. */
export function manifest() {
  const by = (s) => SAND_ACTIONS.filter((a) => a.status === s).length;
  return {
    total: SAND_ACTIONS.length,
    wired: by('wired'),
    approx: by('approx'),
    unmapped: by('unmapped'),
    unmappedReasons: SAND_ACTIONS.filter((a) => a.status === 'unmapped').map((a) => `${a.id}: ${a.reason}`),
  };
}
