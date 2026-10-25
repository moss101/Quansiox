'use strict';
/**
 * Onboarding model (parity plan P2.2) — pure, electron-free.
 *
 * Grok's onboarding narrative: Get started → workspace/import → appearance
 * (theme, accent, bot color, character shapes) → language + model → first
 * bot. Quansiox's wizard already covered Welcome/Workspace/First-bot; this
 * model defines the full step machine plus the appearance vocabulary.
 *
 * Facts (extraction): the character-shape list (blob/egg/star/pumpkin) and
 * the appearance pane's structure are Grok's; the rendering is ours.
 */

export const STEPS = [
  { id: 'welcome', title: 'Welcome to Quansiox' },
  { id: 'workspace', title: 'Choose a workspace' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'language-model', title: 'Language & model' },
  { id: 'first-bot', title: 'Create your first bot' },
];

/** Grok's character shapes (extraction fact). CSS-drawn in the wizard. */
export const SHAPES = ['blob', 'egg', 'star', 'pumpkin'];

/** Accent palettes mapped onto Grok's role tokens (facts → our vocabulary). */
export const ACCENTS = [
  { id: 'blue', label: 'Blue', token: 'accent' },
  { id: 'green', label: 'Green', token: 'success' },
  { id: 'orange', label: 'Orange', token: 'warn' },
];

/** Bot body colors — same role palette, distinct from the UI accent. */
export const BOT_COLORS = ACCENTS;

export const THEMES = ['system', 'light', 'dark'];

/** The language step today: follow-system + English. The full catalog
 * (36 endonyms) is P2.1; the wizard reads this list, so it grows there. */
export const LANGUAGES = [
  { id: 'system', label: 'Follow System' },
  { id: 'en', label: 'English' },
];

/**
 * @param {object} draft the wizard state
 * @returns {{canFinish: boolean, firstInvalid: string|null}} the final step
 * accepts an empty bot profile (it is optional), so the only invalid state
 * is an unknown vocabulary value — silently-coerced settings are worse than
 * a blocked Finish.
 */
export function validate(draft = {}) {
  const shape = draft.botShape ?? 'blob';
  const accent = draft.accent ?? 'blue';
  const botColor = draft.botColor ?? 'blue';
  const theme = draft.theme ?? 'system';
  if (!SHAPES.includes(shape)) return { canFinish: false, firstInvalid: 'botShape' };
  if (!ACCENTS.some((a) => a.id === accent)) return { canFinish: false, firstInvalid: 'accent' };
  if (!BOT_COLORS.some((c) => c.id === botColor)) return { canFinish: false, firstInvalid: 'botColor' };
  if (!THEMES.includes(theme)) return { canFinish: false, firstInvalid: 'theme' };
  if (draft.language != null && !LANGUAGES.some((l) => l.id === draft.language)) {
    return { canFinish: false, firstInvalid: 'language' };
  }
  return { canFinish: true, firstInvalid: null };
}

/** The settings patch a finished wizard persists (facts only, no secrets). */
export function completionPatch(draft = {}) {
  const patch = { onboardingSeen: true };
  if (draft.accent) patch.accent = draft.accent;
  if (draft.botColor) patch.botColor = draft.botColor;
  if (draft.botShape) patch.botShape = draft.botShape;
  if (draft.language) patch.language = draft.language;
  if (draft.model) patch.model = String(draft.model).slice(0, 120);
  return patch;
}

/** The session-profile patch (first bot identity). */
export function botPatch(draft = {}) {
  const patch = {};
  if (String(draft.name ?? '').trim()) patch.title = String(draft.name).trim().slice(0, 80);
  if (String(draft.label ?? '').trim()) patch.label = String(draft.label).trim().slice(0, 60);
  if (String(draft.description ?? '').trim()) patch.description = String(draft.description).trim().slice(0, 400);
  return patch;
}

/** Step navigation with bounds. */
export function nextStep(step) { return Math.min(STEPS.length - 1, Math.max(0, step) + 1); }
export function prevStep(step) { return Math.max(0, step - 1); }
