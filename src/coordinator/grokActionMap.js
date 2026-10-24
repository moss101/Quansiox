'use strict';
/**
 * Grok Bot ActionName ↔ Quansiox tool translation layer (parity plan P3.4).
 *
 * Grok's agent tool contract is a 152+8-name PascalCase `ActionName` enum
 * (extracted list: `work/grok-re/case/grok-tools.txt`, 156 names, verified
 * against the 0.75.0 bundle). Quansiox's is a snake_case registry served by
 * the coordinator (`allTools()` — 146 tools). This module is the complete
 * contract surface between them:
 *
 *   kind 'local' — the action has a real local mechanism; `to` lists the
 *                  quansiox tool(s) that implement it (validated against the
 *                  live registry by test/parity-toolmap.js).
 *   kind 'stub'  — cloud-only or not-yet-built; the agent gets an honest
 *                  unsupported response naming the family (`reason`), per
 *                  the Phase-P3 preamble: contract surface + honest stub.
 *
 * Identifier facts (names) are copied from the extraction; behavior is all
 * quansiox's own (docs/asset-policy.md).
 *
 * Pure module — no Electron, no coordinator state. */
const { REASON, refusalText } = require('./denialMessages.js');

/* ---- 1:1 by name (Grok and Quansiox happen to agree, snake↔Pascal) ---- */
const NAME_EQUAL = {
  AwaitShell: 'await_shell', CheckSubagent: 'check_subagent', CreateAgent: 'create_agent',
  CreateTask: 'create_task', EditCanvas: 'edit_canvas', GetMcpServerStatus: 'get_mcp_server_status',
  InstallPlugin: 'install_plugin', ListCanvases: 'list_canvases', MessageSubagent: 'message_subagent',
  ProposeCarryOver: 'propose_carry_over', ReadTask: 'read_task', RestartMcpServers: 'restart_mcp_servers',
  SearchPlugins: 'search_plugins', SendToAgent: 'send_to_agent', SendToUser: 'send_to_user',
  SetMcpInstructions: 'set_mcp_instructions', Shell: 'shell', StopSubagent: 'stop_subagent',
  UninstallPlugin: 'uninstall_plugin', UpdateAgent: 'update_agent', UpdateState: 'update_state',
  UpdateTask: 'update_task', WakeParent: 'wake_parent', WebFetch: 'web_fetch',
};

/* ---- semantic mappings: a real quansiox tool implements the behavior ---- */
const SEMANTIC = {
  Read: { to: ['read_file'], note: 'base read; family also glob_files/read_image' },
  Screenshot: { to: ['computer_screenshot'] },
  Computer: { to: ['computer_click'], note: 'the computer-use family: ax_tree/click/find/key/scroll/set_value/type' },
  Skill: { to: ['use_skill'] },
  Vault: { to: ['list_secrets'], note: 'the secrets family: list/request/submit_secret' },
  BrowserSecureFill: { to: ['browser_fill_credentials'] },
  ChatItems: { to: ['messages_read'] },
  CheckIMessagePermissions: { to: ['messages_status'] },
  FindIMessageChats: { to: ['messages_chats'] },
  IMessageActivity: { to: ['messages_status'] },
  SearchIMessages: { to: ['messages_search'] },
  SendIMessage: { to: ['messages_send'] },
  FetchIMessageAttachment: { to: ['messages_read'], note: 'attachment payload support depends on the messages bridge' },
  CheckEmailInboxAvailability: { to: ['email_status'] },
  ListEmailInboxes: { to: ['email_status'], note: 'local single-inbox model (mail service)' },
  ReadEmailThread: { to: ['email_search'] },
  SearchEmailThreads: { to: ['email_search'] },
  SendEmail: { to: ['email_send'] },
  ClaimEmailInbox: { to: ['email_status'], note: 'claims the locally configured inbox; no cloud provisioning' },
  ConvertToTeam: { to: ['convert_agent_to_team'] },
  CreateChannel: { to: ['create_room'] },
  ListDocuments: { to: ['list_documents'] },
  ReadDocument: { to: ['read_document'] },
  WriteDocument: { to: ['save_document'] },
  WriteDocumentAsset: { to: ['save_document'] },
  WriteCanvasAsset: { to: ['edit_canvas'] },
  Visualize: { to: ['create_artifact'] },
  DownloadFile: { to: ['web_fetch'], note: 'fetch + write_file; no separate download rail' },
  WebSearch: { to: ['wide_research'], note: 'research pipeline; no dedicated search endpoint tool' },
  PlacesSearch: { to: ['web_fetch'], note: 'public web APIs through the existing fetch tool — no new egress' },
  ProductSearch: { to: ['web_fetch'], note: 'same mechanism as PlacesSearch' },
  WeatherForecast: { to: ['web_fetch'], note: 'same mechanism as PlacesSearch' },
  RecallMemory: { to: ['recall'] },
  UpdateMemory: { to: ['remember'] },
  FillCredential: { to: ['browser_fill_credentials'] },
  ListCredentials: { to: ['list_secrets'] },
  ListAvailableSecureValues: { to: ['list_secrets'] },
  GetCredentialProviderStatus: { to: ['onepassword_list'], note: 'provider presence = the vault lists' },
  RequestCookieOriginApproval: { to: ['browser_import_cookies'], note: 'runs the cookie-approval flow' },
  GetPlugin: { to: ['list_installed_plugins'] },
  SetPrimaryBot: { to: ['set_primary_agent'] },
  RequestUserForm: { to: ['request_user_input'] },
  OfferTeamAccess: { to: ['offer_agent_access'] },
  ProposeSkills: { to: ['propose_skill'] },
  SendMessage: { to: ['send_to_user'], note: 'generic send surfaces to the user; chat channels have dedicated tools' },
  SetStatus: { to: ['update_state'] },
  JoinMeeting: { to: ['meeting_copilot'], note: 'joins via the computer session — the consented local mechanism' },
};

/* ---- honest stubs: no real local mechanism (yet); family reason recorded ----
 * Family reasons match the Phase-P3 scoping decisions in
 * docs/parity/parity-task-list.md. A stub NEVER fakes success. */
const STUBS = {
  // device fleet — Grok's cloud box + companion devices; quansiox has one machine + VM
  AndroidReadNotifications: 'device-fleet', DeviceGetLocation: 'device-fleet',
  IOSControlHome: 'device-fleet', IOSReadHome: 'device-fleet', IOSReadReminders: 'device-fleet',
  IOSWriteReminders: 'device-fleet', ListMachines: 'device-fleet', CopyFromBox: 'device-fleet',
  CopyToBox: 'device-fleet', MacDraftMail: 'device-fleet', MacReadMail: 'device-fleet',
  MacReadNotes: 'device-fleet', MacWriteNotes: 'device-fleet', MobileReadCalendar: 'device-fleet',
  MobileReadContacts: 'device-fleet', MobileSetAlarm: 'device-fleet', MobileWriteCalendar: 'device-fleet',
  FindContacts: 'device-fleet', StartExternalBrowser: 'device-fleet', StopExternalBrowser: 'device-fleet',
  // purchase rails — fail-closed by design (P3.8)
  RequestVirtualCard: 'purchase-rails', CheckSubscriptionUsage: 'purchase-rails',
  // meetings beyond join — transcript/response ops need meeting transcription
  FindMeeting: 'meeting-transcripts', GetMeetingSummary: 'meeting-transcripts',
  LeaveMeeting: 'meeting-transcripts', ReadMeetingLines: 'meeting-transcripts',
  ReadMeetingTranscript: 'meeting-transcripts', RespondInMeeting: 'meeting-transcripts',
  UpdateMeeting: 'meeting-transcripts', DraftCalendarInvite: 'calendar',
  // MCP store/auth surface (status/instructions are real above)
  AddMcpServer: 'mcp-store', AuthenticateMcpServer: 'mcp-store', InstallMcpServer: 'mcp-store',
  RemoveMcpAccount: 'mcp-store', RenameMcpAccount: 'mcp-store', SearchMcpServers: 'mcp-store',
  GetMcpTools: 'mcp-store', UninstallMcpServer: 'mcp-store', McpAuth: 'mcp-store',
  // team-server surface
  CloudAgent: 'team-server', CopyBotFile: 'team-server', PublishToTeam: 'team-server',
  CreateBotShareJson: 'team-server', SearchBotTemplates: 'team-server',
  // Slack/Teams write scope beyond message post (Slack post/history are real tools)
  DeleteOwnSlackMessage: 'slack-write-scope', ReactToSlackMessage: 'slack-write-scope',
  SetSlackStatus: 'slack-write-scope', SetUpSlack: 'slack-write-scope',
  DeleteOwnMicrosoftTeamsMessage: 'teams-integration', ReactToMicrosoftTeamsMessage: 'teams-integration',
  SetMicrosoftTeamsStatus: 'teams-integration', SetUpMicrosoftTeams: 'teams-integration',
  ReactToMessage: 'reactions', DraftExternalMessage: 'external-messaging',
  // transcripts of other agents' sessions
  ReadTranscript: 'transcript-tooling', ReadTranscriptFile: 'transcript-tooling',
  SearchTranscripts: 'transcript-tooling', SearchTranscriptFiles: 'transcript-tooling',
  // review surface (pr_review.read)
  ListReviewItems: 'review-surface', ResolveReviewItem: 'review-surface',
  // profile/account server
  UpdateAppHome: 'profile-server', UpdateAvatar: 'profile-server', UpdateProfile: 'profile-server',
  SetUserAttribute: 'profile-server', OfferAppearancePicker: 'profile-server',
  OfferEmailAddress: 'profile-server', OfferSlackConnect: 'profile-server',
  SendFeedback: 'profile-server', UpdateRoutine: 'automation-tooling',
  // library v2
  SaveToLibrary: 'library-v2', ListSections: 'library-v2', UploadFile: 'cloud-storage',
  // rules/governance proposals beyond carry-over
  ProposeRuleChange: 'rules-engine', SortMemories: 'memory-admin', UpdateSkill: 'skill-authoring',
  ReadAgentActivity: 'activity-feed', FetchConnectedActivity: 'activity-feed',
  RemapUserFormTargets: 'user-forms', DisconnectChannel: 'channel-admin',
  UpdateChannel: 'channel-admin', ReportSiteBlocked: 'site-reporting',
  RequestScmConnect: 'scm-connect', RequestOnePasswordConnect: 'onepassword-connect',
  SetOnePasswordPreference: 'onepassword-connect', ReadEmailAttachment: 'email-attachments',
};

const GROK_ACTIONS = {};
for (const [action, tool] of Object.entries(NAME_EQUAL)) GROK_ACTIONS[action] = { kind: 'local', to: [tool], nameEqual: true };
for (const [action, spec] of Object.entries(SEMANTIC)) GROK_ACTIONS[action] = { kind: 'local', to: spec.to, note: spec.note };
for (const [action, reason] of Object.entries(STUBS)) GROK_ACTIONS[action] = { kind: 'stub', reason };

/** Translate a Grok ActionName to the local plan.
 * @returns {{kind:'local', to:string[], note?:string}|{kind:'stub', reason:string, message:string}|null} */
function translate(action) {
  const entry = GROK_ACTIONS[String(action ?? '').trim()];
  if (!entry) return null;
  if (entry.kind === 'local') return entry;
  return {
    kind: 'stub',
    reason: entry.reason,
    message: refusalText(REASON.TOOL_BLOCKED, {
      tool: `Grok action ${action}`,
      detail: `needs the ${entry.reason} surface, which is not available locally`,
    }),
  };
}

/** Coverage manifest for audits (docs + tests print this). */
function manifest() {
  const local = Object.entries(GROK_ACTIONS).filter(([, e]) => e.kind === 'local');
  const stubs = Object.entries(GROK_ACTIONS).filter(([, e]) => e.kind === 'stub');
  const byReason = {};
  for (const [, e] of stubs) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  return {
    total: Object.keys(GROK_ACTIONS).length,
    local: local.length,
    nameEqual: local.filter(([, e]) => e.nameEqual).length,
    semantic: local.filter(([, e]) => !e.nameEqual).length,
    stub: stubs.length,
    stubsByReason: Object.fromEntries(Object.entries(byReason).sort(([, a], [, b]) => b - a)),
  };
}

module.exports = { GROK_ACTIONS, translate, manifest };
