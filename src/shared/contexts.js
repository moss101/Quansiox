'use strict';
/**
 * The bounded-context map.
 *
 * The reference implementation's renderer is organised as 19 bounded
 * contexts — a slice of state, the interfaces it needs, and what it
 * publishes. This module is the map of them, and it is shared: the renderer
 * uses it to organise itself, the main process reports it over IPC, and the
 * tests assert it.
 *
 * The definitions live here rather than in the renderer because the main
 * process has to be able to read them too.
 */

const CONTEXTS = [
  {
    id: 'transcript',
    label: 'Transcript',
    members: ['transcript', 'transcriptLoadingIndicator', 'staleTranscriptNotice', 'conversationOutline', 'trays'],
    ports: ['sessions', 'transcriptCursor'],
    events: ['transcript:entry', 'transcript:outline', 'transcript:tray'],
    lifecycle: { start: 'restore the last page', stop: 'release the scroll anchor' },
  },
  {
    id: 'send',
    label: 'Send pipeline',
    members: ['drafts', 'sendJournal', 'sendAck', 'turnOutcome', 'renderStream', 'attachmentUploads'],
    ports: ['agent', 'attachments', 'permissions'],
    events: ['agent:delta', 'agent:tool', 'agent:plan', 'agent:error'],
    lifecycle: { start: 'open the send journal', stop: 'flush the journal' },
  },
  {
    id: 'roster',
    label: 'Agent roster',
    members: ['roster', 'unreadDivider', 'agentLoad', 'selection'],
    ports: ['agents', 'sessions'],
    events: ['agent:state'],
    lifecycle: { start: 'load the roster', stop: 'unsubscribe' },
  },
  {
    id: 'agentIdentity',
    label: 'Agent identity',
    members: ['agentIdentity', 'primaryAgent', 'pinnedAgents', 'sidebarSections'],
    ports: ['agents', 'hostPrefs'],
    events: ['agent:state'],
    lifecycle: { start: 'load the identity of the selected agent', stop: 'clear it' },
  },
  {
    id: 'approvals',
    label: 'Approvals',
    members: ['confirm', 'interactionCards', 'consent', 'autoReview'],
    ports: ['confirmations', 'interactions', 'permissions'],
    events: ['agent:confirm', 'agent:governance'],
    lifecycle: { start: 'arm the prompt', stop: 'deny anything still pending' },
  },
  {
    id: 'permissions',
    label: 'Permissions',
    members: ['permissionMode', 'toolMatrix', 'standingGrants', 'governanceLog', 'autoReviewRules'],
    ports: ['permissions', 'consent'],
    events: ['agent:governance'],
    lifecycle: { start: 'load the permission state', stop: 'unsubscribe' },
  },
  {
    id: 'tasks',
    label: 'Tasks',
    members: ['agentTasks', 'taskState', 'asyncTasks', 'plan'],
    ports: ['tasks', 'taskState', 'asyncTasks'],
    events: ['task:changed', 'async-task:changed'],
    lifecycle: { start: 'load the checklists', stop: 'unsubscribe' },
  },
  {
    id: 'subagents',
    label: 'Subagents',
    members: ['subagents', 'childTranscripts', 'steering'],
    ports: ['agent', 'taskState'],
    events: ['subagent:changed'],
    lifecycle: { start: 'subscribe to child progress', stop: 'unsubscribe' },
  },
  {
    id: 'automations',
    label: 'Automations',
    members: ['automations', 'autoHistory', 'routines'],
    ports: ['automations', 'webhooks'],
    events: ['automation:changed'],
    lifecycle: { start: 'load the automations', stop: 'unsubscribe' },
  },
  {
    id: 'computer',
    label: 'Computer',
    members: ['computerState', 'takeover', 'trustOverlay', 'recordedRuns'],
    ports: ['computer', 'computerUse', 'sandbox', 'humanCapture'],
    events: ['computer:state', 'computer:action'],
    lifecycle: { start: 'watch the desktop', stop: 'release the desktop' },
  },
  {
    id: 'browser',
    label: 'Browser',
    members: ['browserState', 'cookieGrants', 'tabs'],
    ports: ['browser', 'browserCookies'],
    events: ['browser:state'],
    lifecycle: { start: 'open the session browser', stop: 'close it' },
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    members: ['artifacts', 'canvas'],
    ports: ['artifacts'],
    events: ['artifact:changed'],
    lifecycle: { start: 'load the artifacts', stop: 'release the frames' },
  },
  {
    id: 'library',
    label: 'Library',
    members: ['documents', 'pages', 'assets'],
    ports: ['library'],
    events: [],
    lifecycle: { start: 'load the library', stop: '—' },
  },
  {
    id: 'vault',
    label: 'Vault',
    members: ['secrets', 'vaultCards', 'credentialRequests', 'onePassword'],
    ports: ['secrets', 'onePassword', 'interactions'],
    events: [],
    lifecycle: { start: 'load the metadata', stop: '—' },
  },
  {
    id: 'mcp',
    label: 'MCP',
    members: ['mcpServers', 'mcpTools', 'mcpApps'],
    ports: ['mcp', 'marketplace'],
    events: ['mcp:state'],
    lifecycle: { start: 'load the servers', stop: 'unsubscribe' },
  },
  {
    id: 'skills',
    label: 'Skills',
    members: ['skills', 'addons', 'templates', 'marketplace'],
    ports: ['skills', 'addons', 'templates', 'marketplace'],
    events: [],
    lifecycle: { start: 'load the catalogue', stop: '—' },
  },
  {
    id: 'voice',
    label: 'Voice',
    members: ['voiceSettings', 'voiceCall', 'dictationTake', 'voiceMemos'],
    ports: ['voice', 'voiceSession', 'voiceCall'],
    events: [],
    lifecycle: { start: 'arm the microphone', stop: 'release it' },
  },
  {
    id: 'usage',
    label: 'Usage & billing',
    members: ['usageSummary', 'costByModel', 'weeklyUsage'],
    ports: ['settings', 'sessions', 'updater'],
    events: [],
    lifecycle: { start: 'load the summary', stop: '—' },
  },
  {
    id: 'connection',
    label: 'Connection',
    members: ['connection', 'updateStatus', 'installId', 'flags'],
    ports: ['settings', 'updater', 'flags'],
    events: ['connection:state', 'update:state'],
    lifecycle: { start: 'read the capability snapshot', stop: 'unsubscribe' },
  },
];

/** The context with a given id. */
function contextById(id) {
  return CONTEXTS.find((c) => c.id === id) ?? null;
}

/**
 * The contexts that depend on a given namespace.
 * Used to answer "what breaks if the `vault` namespace goes away?".
 */
function contextsUsing(port) {
  return CONTEXTS.filter((c) => c.ports.includes(port)).map((c) => c.id);
}

/** A summary of the architecture, for the app and the tests. */
function describe() {
  return {
    count: CONTEXTS.length,
    contexts: CONTEXTS.map((c) => ({
      id: c.id,
      label: c.label,
      members: c.members,
      ports: c.ports,
      events: c.events,
    })),
    ports: [...new Set(CONTEXTS.flatMap((c) => c.ports))].sort(),
    events: [...new Set(CONTEXTS.flatMap((c) => c.events))].sort(),
  };
}

module.exports = { CONTEXTS, contextById, contextsUsing, describe };
