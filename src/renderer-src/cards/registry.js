/**
 * The card registry.
 *
 * A card is a structured thing the agent says to the user: "may I run this?",
 * "here is a draft email", "this task changed", "your build finished". The
 * reference implementation has **48** of them — 30 send-message cards, 12
 * event cards and 6 other kinds — and each one is a small, typed surface
 * with its own payload shape.
 *
 * The registry is the single place that knows:
 *
 *   - which card types exist, and under which kind;
 *   - what each one's payload fields are;
 *   - how it is resolved (which channel answers it);
 *   - how it is rendered (card / outcome / silent).
 *
 * Adding a card type is then ONE registry entry plus ONE component — the
 * transcript renderer does not change.
 */

/** The card kinds. */
export const KIND = {
  SEND_MESSAGE: 'send-message',
  EVENT: 'event',
  MESSAGE: 'message',
  USER_ATTACHMENT: 'user-attachment',
  MCP_APP: 'mcp-app',
  NOTICE: 'notice',
  FEEDBACK: 'feedback',
  VOICE_CALL: 'voice-call',
};

/** How a card is resolved. */
export const RESOLUTION = {
  NONE: 'none',
  /** The user answers an approval prompt in the transcript. */
  CONFIRM: 'confirm',
  /** The user fills a form in the transcript. */
  FORM: 'form',
  /** The user answers a multiple-choice widget. */
  WIDGET: 'widget',
  /** The user edits a draft and sends it. */
  DRAFT: 'draft',
  /** The user provides a secret. */
  SECRET: 'secret',
};

/** How a card is drawn. */
export const RENDER = {
  CARD: 'card',
  OUTCOME: 'outcome',
  SILENT: 'silent',
};

/**
 * The 30 send-message card types.
 *
 * `fields` are the payload keys the card reads. `resolution` is how the
 * user answers it.
 */
const SEND_MESSAGE = {
  text: { title: 'Message', fields: ['content', 'images'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  attachment: { title: 'Attachment', fields: ['url', 'file_name', 'channel'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  widget: { title: 'Question', fields: ['widget'], resolution: RESOLUTION.WIDGET, render: RENDER.CARD },
  'cursor-agent': { title: 'Cloud agent', fields: ['bcId', 'title'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'secret-request': { title: 'Secret needed', fields: ['secretRequest'], resolution: RESOLUTION.SECRET, render: RENDER.CARD },
  'credential-request': { title: 'Credential needed', fields: ['credentialRequest'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'user-form': { title: 'Input requested', fields: ['formRequest'], resolution: RESOLUTION.FORM, render: RENDER.CARD },
  'email-draft': { title: 'Email draft', fields: ['draft'], resolution: RESOLUTION.DRAFT, render: RENDER.CARD },
  'slack-draft': { title: 'Slack draft', fields: ['draft'], resolution: RESOLUTION.DRAFT, render: RENDER.CARD },
  'meeting-chat-draft': { title: 'Meeting message draft', fields: ['draft'], resolution: RESOLUTION.DRAFT, render: RENDER.CARD },
  'calendar-event': { title: 'Calendar event', fields: ['event'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'permission-request': { title: 'Permission needed', fields: ['permission'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  connector: { title: 'Connect a service', fields: ['connector', 'variant'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  connectors: { title: 'Connect services', fields: ['connectors'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'listener-connect': { title: 'Connect a listener', fields: ['platform'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'scm-connect': { title: 'Connect a repository', fields: ['provider', 'intent', 'reason'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'onepassword-connect': { title: 'Connect 1Password', fields: [], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'team-access': { title: 'Share with the team', fields: ['reason'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'slack-connect': { title: 'Connect Slack', fields: ['reason'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'bot-template-share': { title: 'Publish this agent', fields: ['shareId', 'name', 'body'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'auto-review-approval': { title: 'Safety review', fields: ['approval'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'meeting-join-consent': { title: 'Join this meeting?', fields: ['approval'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'connector-grant': { title: 'Share data with a connector', fields: ['ask'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'local-tool-permission': { title: 'Run this on your computer', fields: ['ask'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'virtual-card-approval': { title: 'Approve this purchase', fields: ['approval'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'cookie-origin-approval': { title: 'Read cookies for this site', fields: ['approval'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'publish-approval': { title: 'Publish this app', fields: ['approval'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'app-secrets-request': { title: 'The app needs secrets', fields: ['request'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  'mobile-tool-permission': { title: 'Run this on a paired device', fields: ['permission'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
  // The local-first addition: the agent hands the conversation to another
  // agent. The reference implementation has no equivalent — its agents live
  // in a cloud and hand off through a backend.
  handoff: { title: 'Handing over', fields: ['handoff'], resolution: RESOLUTION.CONFIRM, render: RENDER.CARD },
};

/** The 12 event card types. */
const EVENT = {
  'name-changed': { title: 'Renamed', fields: ['name'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'channel-connected': { title: 'Channel connected', fields: ['channel'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'channel-disconnected': { title: 'Channel disconnected', fields: ['channel'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'automation-changed': { title: 'Automation changed', fields: ['automation'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'task-changed': { title: 'Task changed', fields: ['task'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'team-shared': { title: 'Shared with the team', fields: ['agent'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'team-bot-publish': { title: 'Published to the team', fields: ['agent'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'person-added': { title: 'Someone joined', fields: ['person'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'person-removed': { title: 'Someone left', fields: ['person'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'person-left': { title: 'Someone left', fields: ['person'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'bot-added': { title: 'Agent added', fields: ['bot'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'bot-removed': { title: 'Agent removed', fields: ['bot'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
};

/** The 6 other kinds. */
const OTHER = {
  message: { kind: KIND.MESSAGE, title: 'Message', fields: ['content', 'role', 'channel', 'fromAgent', 'toAgent', 'author', 'replyTo', 'branched', 'batchId', 'isStreaming'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'user-attachment': { kind: KIND.USER_ATTACHMENT, title: 'Your attachment', fields: ['file_path', 'replyTo'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'mcp-app': { kind: KIND.MCP_APP, title: 'App', fields: ['resourceUri'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  notice: { kind: KIND.NOTICE, title: 'Notice', fields: ['text'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  feedback: { kind: KIND.FEEDBACK, title: 'Feedback', fields: ['state', 'sentiment'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
  'voice-call': { kind: KIND.VOICE_CALL, title: 'Voice call', fields: ['call'], resolution: RESOLUTION.NONE, render: RENDER.CARD },
};

/** kind -> type -> descriptor */
export const REGISTRY = {
  [KIND.SEND_MESSAGE]: SEND_MESSAGE,
  [KIND.EVENT]: EVENT,
  [KIND.MESSAGE]: { message: OTHER.message },
  [KIND.USER_ATTACHMENT]: { 'user-attachment': OTHER['user-attachment'] },
  [KIND.MCP_APP]: { 'mcp-app': OTHER['mcp-app'] },
  [KIND.NOTICE]: { notice: OTHER.notice },
  [KIND.FEEDBACK]: { feedback: OTHER.feedback },
  [KIND.VOICE_CALL]: { 'voice-call': OTHER['voice-call'] },
};

/** The protocol key: `kind:type`. */
export function cardKey(kind, type) {
  return `${kind}:${type}`;
}

/** The descriptor for a card, or null when it is not a known card. */
export function describeCard(kind, type) {
  const group = REGISTRY[kind];
  const descriptor = group?.[type];
  if (!descriptor) return null;
  return { kind, type, ...descriptor };
}

/** Every card type, for the settings and the tests. */
export function allCards() {
  const out = [];
  for (const [kind, group] of Object.entries(REGISTRY)) {
    for (const type of Object.keys(group)) {
      out.push(describeCard(kind, type));
    }
  }
  return out;
}

/**
 * Is this card waiting for the user?
 *
 * A card that has been answered is drawn as an outcome row, not as a card
 * with buttons on it.
 */
export function isPending(card, resolutionState) {
  if (!card) return false;
  if (card.resolution === RESOLUTION.NONE) return false;
  if (!resolutionState) return true;
  return resolutionState.pending === true;
}
