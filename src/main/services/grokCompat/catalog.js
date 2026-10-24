// Quansiox compatibility surface. Derived from the Grok Bot IPC catalog
// (0.71.2 extraction + the four 0.75.0 additions).
// impl:'local' = real local behavior (./handlers.js); impl:'stub' = fail-closed.

'use strict';
const REGISTRY = [
  {
    "method": "addGrokBotAgentManager",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "add Grok Bot Agent Manager"
  },
  {
    "method": "addGrokBotAgentSkill",
    "side": "desktop",
    "group": "skill",
    "impl": "local",
    "summary": "add Grok Bot Agent Skill",
    "handler": "addGrokBotAgentSkill"
  },
  {
    "method": "addGrokBotRoomPeople",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "handler": "addGrokBotRoomPeople",
    "summary": "add Grok Bot Room People"
  },
  {
    "method": "applyExperimentOverride",
    "side": "desktop",
    "group": "flags",
    "impl": "local",
    "summary": "Apply a flag/experiment override",
    "handler": "flags.override"
  },
  {
    "method": "applyFeatureFlagOverride",
    "side": "desktop",
    "group": "flags",
    "impl": "local",
    "summary": "Apply a feature-flag override",
    "handler": "flags.override"
  },
  {
    "method": "approveCredentialRequest",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "approve Credential Request",
    "handler": "approveCredentialRequest"
  },
  {
    "method": "attachProdBoxStatus",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "attach Prod Box Status"
  },
  {
    "method": "beginPasskeyRegistration",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "scope": "backend",
    "summary": "begin Passkey Registration"
  },
  {
    "method": "beginSpendApproval",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "Open a virtual-card spend approval (approvals domain, 0.75.0)",
    "handler": "beginSpendApproval"
  },
  {
    "method": "cancelComputerUpgrade",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "cancel Computer Upgrade"
  },
  {
    "method": "cancelCredentialProviderOAuth",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "cancel Credential Provider OAuth",
    "handler": "cancelCredentialProviderOAuth"
  },
  {
    "method": "cancelPasskeyCeremony",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "scope": "backend",
    "summary": "cancel Passkey Ceremony"
  },
  {
    "method": "carryUserSecretsToGrokBot",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "summary": "carry User Secrets To Grok Bot",
    "handler": "carryUserSecretsToGrokBot"
  },
  {
    "method": "checkForUpdates",
    "side": "desktop",
    "group": "shell",
    "impl": "local",
    "handler": "updater.check",
    "summary": "Check for updates"
  },
  {
    "method": "checkMessagesPermissions",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "check Messages Permissions",
    "handler": "checkMessagesPermissions"
  },
  {
    "method": "claimEgressTunnel",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "claim Egress Tunnel"
  },
  {
    "method": "clearGrokBotConnectorPreferences",
    "side": "desktop",
    "group": "integration",
    "impl": "stub",
    "scope": "backend",
    "summary": "clear Grok Bot Connector Preferences"
  },
  {
    "method": "clearLocalToolApprovals",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "clear Local Tool Approvals",
    "handler": "clearLocalToolApprovals"
  },
  {
    "method": "cloneGrokBotAgentToTeam",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "clone Grok Bot Agent To Team"
  },
  {
    "method": "closeWindow",
    "side": "desktop",
    "group": "window",
    "impl": "local",
    "handler": "window.close",
    "summary": "Close a window"
  },
  {
    "method": "commitStagedAttachments",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "Commit staged attachments into the library",
    "handler": "att.commit"
  },
  {
    "method": "connectCredentialProviderOAuth",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "connect Credential Provider OAuth",
    "handler": "connectCredentialProviderOAuth"
  },
  {
    "method": "createGrokBotEmailInbox",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "create Grok Bot Email Inbox"
  },
  {
    "method": "deleteGrokBotSecret",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "handler": "secrets.remove",
    "summary": "Remove a secret"
  },
  {
    "method": "denyCredentialRequest",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "deny Credential Request",
    "handler": "denyCredentialRequest"
  },
  {
    "method": "detectCredentialMint",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "detect Credential Mint",
    "handler": "detectCredentialMint"
  },
  {
    "method": "discardStagedAttachment",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "Discard a staged attachment",
    "handler": "att.discard"
  },
  {
    "method": "disconnectCredentialProvider",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "disconnect Credential Provider",
    "handler": "disconnectCredentialProvider"
  },
  {
    "method": "downloadAttachment",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "download Attachment",
    "handler": "downloadAttachment"
  },
  {
    "method": "endPanelMove",
    "side": "desktop",
    "group": "window",
    "impl": "local",
    "handler": "window.endPanelMove",
    "summary": "End panel move (local)"
  },
  {
    "method": "exposeFeatureGate",
    "side": "desktop",
    "group": "flags",
    "impl": "local",
    "summary": "Evaluate a feature gate",
    "handler": "flags.evaluate"
  },
  {
    "method": "focusWindow",
    "side": "desktop",
    "group": "window",
    "impl": "local",
    "handler": "window.focus",
    "summary": "Focus main window"
  },
  {
    "method": "forceReconnectGateway",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "force Reconnect Gateway",
    "handler": "forceReconnectGateway"
  },
  {
    "method": "forceRecreateComputer",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "force Recreate Computer"
  },
  {
    "method": "getAutoReviewInstructions",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "get Auto Review Instructions",
    "handler": "getAutoReviewInstructions"
  },
  {
    "method": "getBotColorInChatEnabled",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "summary": "get Bot Color In Chat Enabled",
    "handler": "getBotColorInChatEnabled"
  },
  {
    "method": "getBoxHostPhase",
    "side": "desktop",
    "group": "computer",
    "impl": "local",
    "summary": "get Box Host Phase",
    "handler": "getBoxHostPhase"
  },
  {
    "method": "getBoxMigrationStatus",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "get Box Migration Status"
  },
  {
    "method": "getCanvasShare",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "getCanvasShare",
    "handler": "getCanvasShare"
  },
  {
    "method": "getComputerUpgradeSchedule",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "get Computer Upgrade Schedule"
  },
  {
    "method": "getCredentialsState",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "get Credentials State",
    "handler": "getCredentialsState"
  },
  {
    "method": "getCurrentMachineMessagesEnabled",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "get Current Machine Messages Enabled",
    "handler": "getCurrentMachineMessagesEnabled"
  },
  {
    "method": "getDesktopNotificationPreferences",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "Get notification preferences",
    "handler": "notif.get"
  },
  {
    "method": "getDocument",
    "side": "desktop",
    "group": "document",
    "impl": "local",
    "summary": "Read a library document",
    "handler": "doc.get"
  },
  {
    "method": "getDocumentAssets",
    "side": "desktop",
    "group": "document",
    "impl": "local",
    "summary": "Document assets (reserved)",
    "handler": "doc.assets"
  },
  {
    "method": "getDocumentEditRight",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "get Document Edit Right",
    "handler": "getDocumentEditRight"
  },
  {
    "method": "getEffectivePlugins",
    "side": "desktop",
    "group": "skill",
    "impl": "local",
    "summary": "Effective enabled plugins/skills + MCP servers",
    "handler": "mcp.effective"
  },
  {
    "method": "getEgressTunnelEnabled",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "get Egress Tunnel Enabled"
  },
  {
    "method": "getEgressTunnelStatus",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "get Egress Tunnel Status"
  },
  {
    "method": "getExperimentsSnapshot",
    "side": "desktop",
    "group": "flags",
    "impl": "local",
    "summary": "Snapshot all flags + effective values",
    "handler": "flags.snapshot"
  },
  {
    "method": "getFinanceOverview",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Finance Overview"
  },
  {
    "method": "getGrokBotAgentMcpServers",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "get Grok Bot Agent Mcp Servers",
    "handler": "getGrokBotAgentMcpServers"
  },
  {
    "method": "getGrokBotAgentPlugins",
    "side": "desktop",
    "group": "skill",
    "impl": "local",
    "summary": "get Grok Bot Agent Plugins",
    "handler": "getGrokBotAgentPlugins"
  },
  {
    "method": "getGrokBotSlackInstallState",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Grok Bot Slack Install State"
  },
  {
    "method": "getGrokBotTermsRecord",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "summary": "get Grok Bot Terms Record",
    "handler": "getGrokBotTermsRecord"
  },
  {
    "method": "getHardwareAcceleration",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "get Hardware Acceleration",
    "handler": "getHardwareAcceleration"
  },
  {
    "method": "getHostPinnedAgents",
    "side": "desktop",
    "group": "host",
    "impl": "local",
    "summary": "Get pinned session ids",
    "handler": "host.pinned"
  },
  {
    "method": "getHostSidebarSections",
    "side": "desktop",
    "group": "host",
    "impl": "local",
    "summary": "Get sidebar section visibility",
    "handler": "host.sections"
  },
  {
    "method": "getLanguageState",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "get Language State",
    "handler": "getLanguageState"
  },
  {
    "method": "getLinkMetadata",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "get Link Metadata",
    "handler": "getLinkMetadata"
  },
  {
    "method": "getLocalToolActionGrant",
    "side": "desktop",
    "group": "consent",
    "impl": "local",
    "summary": "Get a local tool action grant",
    "handler": "consent.get"
  },
  {
    "method": "getLocalToolPermission",
    "side": "desktop",
    "group": "consent",
    "impl": "local",
    "summary": "Get a tool permission decision",
    "handler": "consent.get"
  },
  {
    "method": "getMcpTeamPopularity",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "get Mcp Team Popularity",
    "handler": "getMcpTeamPopularity"
  },
  {
    "method": "getMessagesAppIcon",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "get Messages App Icon",
    "handler": "getMessagesAppIcon"
  },
  {
    "method": "getOnboardingSeen",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "get Onboarding Seen",
    "handler": "getOnboardingSeen"
  },
  {
    "method": "getPublicBotTemplate",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "handler": "getPublicBotTemplate",
    "summary": "get Public Bot Template"
  },
  {
    "method": "getSandAccessFresh",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "get Sand Access Fresh",
    "handler": "getSandAccessFresh"
  },
  {
    "method": "getSlackLinkUrl",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Slack Link Url"
  },
  {
    "method": "getSpellCheckEnabled",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "get Spell Check Enabled",
    "handler": "getSpellCheckEnabled"
  },
  {
    "method": "getTeamMemberPolicy",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Team Member Policy"
  },
  {
    "method": "getThemeState",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "get Theme State",
    "handler": "getThemeState"
  },
  {
    "method": "getTimeZone",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "get Time Zone",
    "handler": "getTimeZone"
  },
  {
    "method": "getUpdateStatus",
    "side": "desktop",
    "group": "shell",
    "impl": "local",
    "summary": "App version + update feed status",
    "handler": "upd.status"
  },
  {
    "method": "getWebauthnProxyEnabled",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "get Webauthn Proxy Enabled",
    "handler": "getWebauthnProxyEnabled"
  },
  {
    "method": "getWindowState",
    "side": "desktop",
    "group": "window",
    "impl": "local",
    "handler": "window.state",
    "summary": "Window bounds/state"
  },
  {
    "method": "hasMigratedClientPersistence",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "has Migrated Client Persistence",
    "handler": "hasMigratedClientPersistence"
  },
  {
    "method": "importChromeCookies",
    "side": "desktop",
    "group": "cookies",
    "impl": "local",
    "summary": "Import a user-supplied cookies.txt (origin-granted) into the browser partition",
    "handler": "cookies.import"
  },
  {
    "method": "installEntry",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "install Entry",
    "handler": "installEntry"
  },
  {
    "method": "installGrokBotSlackApp",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "install Grok Bot Slack App"
  },
  {
    "method": "isSlackLinked",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "is Slack Linked"
  },
  {
    "method": "leaveMeeting",
    "side": "desktop",
    "group": "voice",
    "impl": "local",
    "summary": "leaveMeeting",
    "handler": "leaveMeeting"
  },
  {
    "method": "listChromeCookieAllowItems",
    "side": "desktop",
    "group": "cookies",
    "impl": "local",
    "summary": "List the cookie origin allow-items",
    "handler": "cookies.allowItems"
  },
  {
    "method": "listClientPersistenceKeys",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "list Client Persistence Keys",
    "handler": "listClientPersistenceKeys"
  },
  {
    "method": "listCookieOriginGrants",
    "side": "desktop",
    "group": "cookies",
    "impl": "local",
    "summary": "List granted cookie origins for a session",
    "handler": "cookies.grants"
  },
  {
    "method": "listGrokBotAgentManagers",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "list Grok Bot Agent Managers"
  },
  {
    "method": "listGrokBotAgentSessions",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "handler": "listGrokBotAgentSessions",
    "summary": "list Grok Bot Agent Sessions"
  },
  {
    "method": "listGrokBotEmailInboxes",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "list Grok Bot Email Inboxes"
  },
  {
    "method": "listGrokBotSecrets",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "handler": "listGrokBotSecrets",
    "summary": "List secret names+fields"
  },
  {
    "method": "listGrokBotTeamAgents",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "list Grok Bot Team Agents"
  },
  {
    "method": "listGrokBotUserBotMemories",
    "side": "desktop",
    "group": "memory",
    "impl": "local",
    "summary": "List local long-term memories",
    "handler": "memory.list"
  },
  {
    "method": "listLibraryDocs",
    "side": "desktop",
    "group": "document",
    "impl": "local",
    "summary": "List library documents",
    "handler": "doc.list"
  },
  {
    "method": "listVirtualCardPaymentMethods",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "List linked virtual-card payment methods (approvals domain, 0.75.0)",
    "handler": "listVirtualCardPaymentMethods"
  },
  {
    "method": "listMeetings",
    "side": "desktop",
    "group": "voice",
    "impl": "local",
    "summary": "listMeetings",
    "handler": "listMeetings"
  },
  {
    "method": "listMessagesAllowedRecipients",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "list Messages Allowed Recipients",
    "handler": "listMessagesAllowedRecipients"
  },
  {
    "method": "listPasskeys",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "scope": "backend",
    "summary": "list Passkeys"
  },
  {
    "method": "listPublicBotMarketplace",
    "side": "desktop",
    "group": "market",
    "impl": "local",
    "summary": "List the local marketplace catalog",
    "handler": "mkt.list"
  },
  {
    "method": "listSecrets",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "handler": "secrets.list",
    "summary": "List secret names+fields"
  },
  {
    "method": "markDeepLinksReady",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "mark Deep Links Ready",
    "handler": "markDeepLinksReady"
  },
  {
    "method": "markGrokBotTermsSeen",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "summary": "mark Grok Bot Terms Seen",
    "handler": "markGrokBotTermsSeen"
  },
  {
    "method": "meetingCensus",
    "side": "desktop",
    "group": "voice",
    "impl": "local",
    "summary": "meetingCensus",
    "handler": "meetingCensus"
  },
  {
    "method": "migrateClientPersistence",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "migrate Client Persistence",
    "handler": "migrateClientPersistence"
  },
  {
    "method": "minimizeWindow",
    "side": "desktop",
    "group": "window",
    "impl": "local",
    "handler": "window.minimize",
    "summary": "Minimize"
  },
  {
    "method": "mintVoiceCallCredential",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    
    "summary": "mintVoiceCallCredential",
    "handler": "mintVoiceCallCredential"
  },
  {
    "method": "mintXaiCommerceBearer",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "scope": "backend",
    "summary": "mint Xai Commerce Bearer"
  },
  {
    "method": "mount",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "mount",
    "handler": "mount"
  },
  {
    "method": "movePanel",
    "side": "desktop",
    "group": "window",
    "impl": "local",
    "handler": "window.movePanel",
    "summary": "Move a panel (local)"
  },
  {
    "method": "noteSentryConversation",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "note Sentry Conversation",
    "handler": "noteSentryConversation"
  },
  {
    "method": "offerChoices",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "offer Choices",
    "handler": "offerChoices"
  },
  {
    "method": "openCloudAgent",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "open Cloud Agent"
  },
  {
    "method": "openExternal",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "open External",
    "handler": "openExternal"
  },
  {
    "method": "pickAvatarFile",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "pick Avatar File",
    "handler": "pickAvatarFile"
  },
  {
    "method": "pickAvatarSource",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "pick Avatar Source",
    "handler": "pickAvatarSource"
  },
  {
    "method": "precaptionStagedAttachment",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "precaption Staged Attachment",
    "handler": "precaptionStagedAttachment"
  },
  {
    "method": "promoteGrokBotMemoriesToTeam",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "promote Grok Bot Memories To Team"
  },
  {
    "method": "publishGrokBotAgent",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "publish Grok Bot Agent"
  },
  {
    "method": "putCookieOriginGrants",
    "side": "desktop",
    "group": "cookies",
    "impl": "local",
    "summary": "Grant/revoke cookie origins for a session",
    "handler": "cookies.putGrants"
  },
  {
    "method": "putGrokBotSecret",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "handler": "secrets.set",
    "summary": "Store a secret field"
  },
  {
    "method": "quitAndInstallUpdate",
    "side": "desktop",
    "group": "shell",
    "impl": "local",
    "summary": "Staged install + relaunch",
    "handler": "upd.quitAndInstall"
  },
  {
    "method": "reachForMenu",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "reach For Menu",
    "handler": "reachForMenu"
  },
  {
    "method": "read",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "read",
    "handler": "read"
  },
  {
    "method": "readAttachmentBytes",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "Read a staged attachment as base64",
    "handler": "att.readBytes"
  },
  {
    "method": "readAttachmentText",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "Read a staged attachment as text",
    "handler": "readAttachmentText"
  },
  {
    "method": "readChoices",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "read Choices",
    "handler": "readChoices"
  },
  {
    "method": "readClientPersistence",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "read Client Persistence",
    "handler": "readClientPersistence"
  },
  {
    "method": "readManyClientPersistence",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "read Many Client Persistence",
    "handler": "readManyClientPersistence"
  },
  {
    "method": "readTranscriptStoreTail",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "read Transcript Store Tail",
    "handler": "readTranscriptStoreTail"
  },
  {
    "method": "reconcileUnpublishedPlugin",
    "side": "desktop",
    "group": "skill",
    "impl": "stub",
    "scope": "backend",
    "summary": "reconcile Unpublished Plugin"
  },
  {
    "method": "recordLocalToolApproval",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "record Local Tool Approval",
    "handler": "recordLocalToolApproval"
  },
  {
    "method": "recordLocalToolStandingGrant",
    "side": "desktop",
    "group": "consent",
    "impl": "local",
    "summary": "Record a standing allow grant",
    "handler": "consent.allow"
  },
  {
    "method": "refreshFeatureFlags",
    "side": "desktop",
    "group": "flags",
    "impl": "local",
    "summary": "Re-read + snapshot flags",
    "handler": "flags.refresh"
  },
  {
    "method": "refreshMcpCatalog",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "refresh Mcp Catalog",
    "handler": "refreshMcpCatalog"
  },
  {
    "method": "reinstallGrokBotSlackApp",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "reinstall Grok Bot Slack App"
  },
  {
    "method": "relaunchDesktop",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "relaunch Desktop",
    "handler": "relaunchDesktop"
  },
  {
    "method": "removeClientPersistence",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "remove Client Persistence",
    "handler": "removeClientPersistence"
  },
  {
    "method": "removeGrokBotAgentManager",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "remove Grok Bot Agent Manager"
  },
  {
    "method": "removeGrokBotAgentSkill",
    "side": "desktop",
    "group": "skill",
    "impl": "local",
    "summary": "remove Grok Bot Agent Skill",
    "handler": "removeGrokBotAgentSkill"
  },
  {
    "method": "removeGrokBotRoomPeople",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "remove Grok Bot Room People"
  },
  {
    "method": "reportAccessBlocked",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Access Blocked",
    "handler": "reportAccessBlocked"
  },
  {
    "method": "reportAgentLoad",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Agent Load",
    "handler": "reportAgentLoad"
  },
  {
    "method": "reportAgentsUnreachable",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Agents Unreachable",
    "handler": "reportAgentsUnreachable"
  },
  {
    "method": "reportArtifactEngagement",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Artifact Engagement",
    "handler": "reportArtifactEngagement"
  },
  {
    "method": "reportBoxVisibility",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "report Box Visibility"
  },
  {
    "method": "reportClientFailure",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Client Failure",
    "handler": "reportClientFailure"
  },
  {
    "method": "reportCloudAgentArtifact",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "report Cloud Agent Artifact"
  },
  {
    "method": "reportHeapMetrics",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Heap Metrics",
    "handler": "reportHeapMetrics"
  },
  {
    "method": "reportOnboardingCompleted",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Onboarding Completed",
    "handler": "reportOnboardingCompleted"
  },
  {
    "method": "reportOnboardingStep",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Onboarding Step",
    "handler": "reportOnboardingStep"
  },
  {
    "method": "reportOpenComputer",
    "side": "desktop",
    "group": "computer",
    "impl": "local",
    "summary": "report Open Computer",
    "handler": "reportOpenComputer"
  },
  {
    "method": "reportReactionAck",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Reaction Ack",
    "handler": "reportReactionAck"
  },
  {
    "method": "reportRebuildLifecycle",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Rebuild Lifecycle",
    "handler": "reportRebuildLifecycle"
  },
  {
    "method": "reportReconciliation",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Reconciliation",
    "handler": "reportReconciliation"
  },
  {
    "method": "reportRecoveryAction",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Recovery Action",
    "handler": "reportRecoveryAction"
  },
  {
    "method": "reportRenderStream",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Render Stream",
    "handler": "reportRenderStream"
  },
  {
    "method": "reportRenderTtfr",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Render Ttfr",
    "handler": "reportRenderTtfr"
  },
  {
    "method": "reportSendAck",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Send Ack",
    "handler": "reportSendAck"
  },
  {
    "method": "reportSendLatency",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Send Latency",
    "handler": "reportSendLatency"
  },
  {
    "method": "reportSidebarAction",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Sidebar Action",
    "handler": "reportSidebarAction"
  },
  {
    "method": "reportSigninGate",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Signin Gate",
    "handler": "reportSigninGate"
  },
  {
    "method": "reportTurnClientOutcome",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Turn Client Outcome",
    "handler": "reportTurnClientOutcome"
  },
  {
    "method": "reportTurnClientStart",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Turn Client Start",
    "handler": "reportTurnClientStart"
  },
  {
    "method": "reportUpdatePrompt",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Update Prompt",
    "handler": "reportUpdatePrompt"
  },
  {
    "method": "reportVncLiveness",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Vnc Liveness",
    "handler": "reportVncLiveness"
  },
  {
    "method": "reportVncSession",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "report Vnc Session",
    "handler": "reportVncSession"
  },
  {
    "method": "rescheduleComputerUpgrade",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "reschedule Computer Upgrade"
  },
  {
    "method": "resizeWindowWidth",
    "side": "desktop",
    "group": "window",
    "impl": "local",
    "handler": "window.resize",
    "summary": "Resize (width)"
  },
  {
    "method": "resolveAttachmentMedia",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "Resolve a staged attachment (mime/size)",
    "handler": "att.resolve"
  },
  {
    "method": "resolveLibraryPages",
    "side": "desktop",
    "group": "document",
    "impl": "local",
    "summary": "List shared library pages",
    "handler": "doc.pages"
  },
  {
    "method": "revokeMessagesAllowedRecipient",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "revoke Messages Allowed Recipient",
    "handler": "revokeMessagesAllowedRecipient"
  },
  {
    "method": "revokePasskey",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "scope": "backend",
    "summary": "revoke Passkey"
  },
  {
    "method": "runNetworkDiagnostics",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "run Network Diagnostics",
    "handler": "runNetworkDiagnostics"
  },
  {
    "method": "runPasskeyCeremony",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "scope": "backend",
    "summary": "run Passkey Ceremony"
  },
  {
    "method": "saveDocument",
    "side": "desktop",
    "group": "document",
    "impl": "local",
    "summary": "Save/create a library document",
    "handler": "doc.save"
  },
  {
    "method": "scheduleComputerUpgrade",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "schedule Computer Upgrade"
  },
  {
    "method": "setAttachProdBoxEnabled",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "set Attach Prod Box Enabled"
  },
  {
    "method": "setAutoReviewInstructions",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "set Auto Review Instructions",
    "handler": "setAutoReviewInstructions"
  },
  {
    "method": "setAutoUpdateWhenIdle",
    "side": "desktop",
    "group": "shell",
    "impl": "local",
    "summary": "Toggle auto-update when idle",
    "handler": "upd.setAutoUpdateWhenIdle"
  },
  {
    "method": "setBotColorInChatEnabled",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "summary": "set Bot Color In Chat Enabled",
    "handler": "setBotColorInChatEnabled"
  },
  {
    "method": "setCanvasVisibility",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "setCanvasVisibility",
    "handler": "setCanvasVisibility"
  },
  {
    "method": "setComposingAgent",
    "side": "desktop",
    "group": "agent",
    "impl": "local",
    "summary": "set Composing Agent",
    "handler": "setComposingAgent"
  },
  {
    "method": "setComputerViewOpen",
    "side": "desktop",
    "group": "computer",
    "impl": "local",
    "summary": "set Computer View Open",
    "handler": "setComputerViewOpen"
  },
  {
    "method": "setDesktopNotificationPreferences",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "Set notification preferences",
    "handler": "notif.set"
  },
  {
    "method": "setDocumentVisibility",
    "side": "desktop",
    "group": "document",
    "impl": "local",
    "summary": "Set private|shared visibility",
    "handler": "doc.setVisibility"
  },
  {
    "method": "setEgressTunnelEnabled",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "set Egress Tunnel Enabled"
  },
  {
    "method": "setGrokBotAgentPlugins",
    "side": "desktop",
    "group": "skill",
    "impl": "local",
    "summary": "set Grok Bot Agent Plugins",
    "handler": "setGrokBotAgentPlugins"
  },
  {
    "method": "setGrokBotAgentPluginVariables",
    "side": "desktop",
    "group": "skill",
    "impl": "local",
    "summary": "set Grok Bot Agent Plugin Variables",
    "handler": "setGrokBotAgentPluginVariables"
  },
  {
    "method": "setGrokBotAgentSidebarHidden",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "summary": "set Grok Bot Agent Sidebar Hidden",
    "handler": "setGrokBotAgentSidebarHidden"
  },
  {
    "method": "setGrokBotAgentVisibility",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "summary": "set Grok Bot Agent Visibility",
    "handler": "setGrokBotAgentVisibility"
  },
  {
    "method": "setGrokBotAgentVoice",
    "side": "desktop",
    "group": "voice",
    "impl": "local",
    "summary": "set Grok Bot Agent Voice",
    "handler": "setGrokBotAgentVoice"
  },
  {
    "method": "setHardwareAccelerationEnabled",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "set Hardware Acceleration Enabled",
    "handler": "setHardwareAccelerationEnabled"
  },
  {
    "method": "setHostPinnedAgents",
    "side": "desktop",
    "group": "host",
    "impl": "local",
    "summary": "Set pinned session ids",
    "handler": "host.setPinned"
  },
  {
    "method": "setHostSidebarSections",
    "side": "desktop",
    "group": "host",
    "impl": "local",
    "summary": "Set sidebar section visibility",
    "handler": "host.setSections"
  },
  {
    "method": "setLanguagePreference",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "set Language Preference",
    "handler": "setLanguagePreference"
  },
  {
    "method": "setLocalToolActionGrant",
    "side": "desktop",
    "group": "consent",
    "impl": "local",
    "summary": "Set a local tool action grant",
    "handler": "consent.set"
  },
  {
    "method": "setLocalToolPermission",
    "side": "desktop",
    "group": "consent",
    "impl": "local",
    "summary": "Set a tool decision (allow/deny)",
    "handler": "consent.set"
  },
  {
    "method": "setOnboardingSeen",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "set Onboarding Seen",
    "handler": "setOnboardingSeen"
  },
  {
    "method": "setSpellCheckEnabled",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "set Spell Check Enabled",
    "handler": "setSpellCheckEnabled"
  },
  {
    "method": "setThemePreference",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "set Theme Preference",
    "handler": "setThemePreference"
  },
  {
    "method": "setTitleBarOverlayTone",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "set Title Bar Overlay Tone",
    "handler": "setTitleBarOverlayTone"
  },
  {
    "method": "setUpdateTrack",
    "side": "desktop",
    "group": "shell",
    "impl": "local",
    "summary": "Set the update track / feed",
    "handler": "upd.setTrack"
  },
  {
    "method": "setViewingAgent",
    "side": "desktop",
    "group": "agent",
    "impl": "local",
    "summary": "set Viewing Agent",
    "handler": "setViewingAgent"
  },
  {
    "method": "setWebauthnProxyEnabled",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "set Webauthn Proxy Enabled",
    "handler": "setWebauthnProxyEnabled"
  },
  {
    "method": "stageAttachmentBytes",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "Stage attachment bytes",
    "handler": "att.stageBytes"
  },
  {
    "method": "stageAttachmentPath",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "Stage a confined local file",
    "handler": "att.stagePath"
  },
  {
    "method": "stageMcpAppDocument",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "stage Mcp App Document",
    "handler": "stageMcpAppDocument"
  },
  {
    "method": "startCredentialMint",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "start Credential Mint",
    "handler": "startCredentialMint"
  },
  {
    "method": "startFinanceLink",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "start Finance Link"
  },
  {
    "method": "startGrokBotSlackConnect",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "start Grok Bot Slack Connect"
  },
  {
    "method": "startPasskeyEnrollment",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "scope": "backend",
    "summary": "start Passkey Enrollment"
  },
  {
    "method": "startRpcTraceWindow",
    "side": "desktop",
    "group": "window",
    "impl": "local",
    "summary": "start Rpc Trace Window",
    "handler": "startRpcTraceWindow"
  },
  {
    "method": "submitFeedback",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "submit Feedback",
    "handler": "submitFeedback"
  },
  {
    "method": "submitPrompt",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "submit Prompt",
    "handler": "submitPrompt"
  },
  {
    "method": "switchTo",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "switch To",
    "handler": "switchTo"
  },
  {
    "method": "syncCredentialProvider",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "sync Credential Provider",
    "handler": "syncCredentialProvider"
  },
  {
    "method": "synthesizeSpeech",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "synthesize Speech",
    "handler": "synthesizeSpeech"
  },
  {
    "method": "toggleMaximizeWindow",
    "side": "desktop",
    "group": "window",
    "impl": "local",
    "summary": "toggle Maximize Window",
    "handler": "toggleMaximizeWindow"
  },
  {
    "method": "uninstallGrokBotSlackApp",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "uninstall Grok Bot Slack App"
  },
  {
    "method": "uninstallPlugin",
    "side": "desktop",
    "group": "skills",
    "impl": "local",
    "summary": "Uninstall a plugin/skill",
    "handler": "skills.uninstall"
  },
  {
    "method": "unmount",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "unmount",
    "handler": "unmount"
  },
  {
    "method": "unpublishGrokBotAgent",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "unpublish Grok Bot Agent"
  },
  {
    "method": "updateComputer",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "update Computer"
  },
  {
    "method": "updateCurrentMachineMessagesEnabled",
    "side": "desktop",
    "group": "integration",
    "impl": "local",
    "summary": "update Current Machine Messages Enabled",
    "handler": "updateCurrentMachineMessagesEnabled"
  },
  {
    "method": "updateGrokBotAgent",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "handler": "updateGrokBotAgent",
    "summary": "update Grok Bot Agent"
  },
  {
    "method": "updateGrokBotAgentSkill",
    "side": "desktop",
    "group": "skill",
    "impl": "local",
    "summary": "update Grok Bot Agent Skill",
    "handler": "updateGrokBotAgentSkill"
  },
  {
    "method": "updatePluginInstall",
    "side": "desktop",
    "group": "skill",
    "impl": "local",
    "summary": "update Plugin Install",
    "handler": "updatePluginInstall"
  },
  {
    "method": "verifyPasskeyEnrollmentCode",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "scope": "backend",
    "summary": "verify Passkey Enrollment Code"
  },
  {
    "method": "voiceCallHarnessSession",
    "side": "desktop",
    "group": "voice",
    "impl": "local",
    
    "summary": "voiceCallHarnessSession",
    "handler": "voiceCallHarnessSession"
  },
  {
    "method": "voiceCallHarnessTool",
    "side": "desktop",
    "group": "voice",
    "impl": "local",
    
    "summary": "voiceCallHarnessTool",
    "handler": "voiceCallHarnessTool"
  },
  {
    "method": "writeClientPersistence",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "write Client Persistence",
    "handler": "writeClientPersistence"
  },
  {
    "method": "authenticateMcpServer",
    "side": "both",
    "group": "mcp",
    "impl": "local",
    "handler": "mcp.add",
    "summary": "Add/authenticate a stdio MCP server"
  },
  {
    "method": "generateAgentAvatarImage",
    "side": "both",
    "group": "session",
    "impl": "local",
    "summary": "Generate a deterministic initials avatar",
    "handler": "sess.genAvatar"
  },
  {
    "method": "getMcpCatalog",
    "side": "both",
    "group": "mcp",
    "impl": "local",
    "handler": "mkt.mcpCatalog",
    "summary": "Browse the local MCP server catalog"
  },
  {
    "method": "getMcpPluginLogo",
    "side": "both",
    "group": "mcp",
    "impl": "local",
    "summary": "get Mcp Plugin Logo",
    "handler": "getMcpPluginLogo"
  },
  {
    "method": "getMcpState",
    "side": "both",
    "group": "mcp",
    "impl": "local",
    "handler": "mcp.status",
    "summary": "MCP runtime status"
  },
  {
    "method": "listMcpServerTools",
    "side": "both",
    "group": "mcp",
    "impl": "local",
    "handler": "mcp.tools",
    "summary": "List tools across MCP servers"
  },
  {
    "method": "removeMcpAccount",
    "side": "both",
    "group": "mcp",
    "impl": "local",
    "handler": "mcp.remove",
    "summary": "Remove an MCP account/server"
  },
  {
    "method": "removeMcpServer",
    "side": "both",
    "group": "mcp",
    "impl": "local",
    "handler": "mcp.remove",
    "summary": "Remove an MCP server"
  },
  {
    "method": "renameMcpAccount",
    "side": "both",
    "group": "mcp",
    "impl": "local",
    "handler": "mcp.rename",
    "summary": "Rename an MCP account/server"
  },
  {
    "method": "setMcpCustomInstructions",
    "side": "both",
    "group": "mcp",
    "impl": "local",
    "handler": "settings.systemPromptExtra",
    "summary": "Custom instructions"
  },
  {
    "method": "toggleMcpToolDisabled",
    "side": "both",
    "group": "mcp",
    "impl": "local",
    "handler": "consent.toolDisabled",
    "summary": "Enable/disable a tool (enforced standing-consent)"
  },
  {
    "method": "transcribeAudio",
    "side": "both",
    "group": "voice",
    "impl": "local",
    "handler": "transcribeAudio",
    "summary": "transcribe Audio"
  },
  {
    "method": "broadcastToAgents",
    "side": "coordinator",
    "group": "broadcast",
    "impl": "local",
    "summary": "Fan a message to many agent sessions concurrently",
    "handler": "bcast.broadcast"
  },
  {
    "method": "clearGeneratedRoomNameStamps",
    "side": "coordinator",
    "group": "misc",
    "impl": "stub",
    "scope": "backend",
    "summary": "clear Generated Room Name Stamps"
  },
  {
    "method": "clearTrays",
    "side": "coordinator",
    "group": "shell",
    "impl": "local",
    "summary": "clear Trays",
    "handler": "clearTrays"
  },
  {
    "method": "completeGithubConnect",
    "side": "coordinator",
    "group": "integration",
    "impl": "stub",
    "scope": "backend",
    "summary": "complete Github Connect"
  },
  {
    "method": "confirmCloudAgentPublishProposal",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "confirm Cloud Agent Publish Proposal"
  },
  {
    "method": "connectChannel",
    "side": "coordinator",
    "group": "integration",
    "impl": "stub",
    "scope": "backend",
    "summary": "connect Channel"
  },
  {
    "method": "countAgents",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "sessions.count",
    "summary": "Count sessions"
  },
  {
    "method": "createAgent",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "sessions.create",
    "summary": "Create a new session"
  },
  {
    "method": "createAgentAutomation",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Create a scheduled automation",
    "handler": "automation.create"
  },
  {
    "method": "createAgentFromTemplate",
    "side": "coordinator",
    "group": "account",
    "impl": "local",
    "handler": "createAgentFromTemplate",
    "summary": "create Agent From Template"
  },
  {
    "method": "createAgentWorkflow",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Create a step workflow",
    "handler": "automation.createWorkflow"
  },
  {
    "method": "createThreadFromMessage",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "Fork a thread seeded from an agent message (send domain, 0.75.0)",
    "handler": "createThreadFromMessage"
  },
  {
    "method": "createGroup",
    "side": "coordinator",
    "group": "account",
    "impl": "local",
    "handler": "createGroup",
    "summary": "create Group"
  },
  {
    "method": "deleteAgentAutomation",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Delete an automation",
    "handler": "automation.remove"
  },
  {
    "method": "deleteAgents",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "sessions.remove",
    "summary": "Delete a session"
  },
  {
    "method": "deleteAgentWorkflow",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Delete a workflow",
    "handler": "automation.remove"
  },
  {
    "method": "deleteBotTemplate",
    "side": "coordinator",
    "group": "account",
    "impl": "local",
    "handler": "deleteBotTemplate",
    "summary": "delete Bot Template"
  },
  {
    "method": "discardDraft",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "Discard a composer draft",
    "handler": "sess.discardDraft"
  },
  {
    "method": "disconnectChannel",
    "side": "coordinator",
    "group": "integration",
    "impl": "stub",
    "scope": "backend",
    "summary": "disconnect Channel"
  },
  {
    "method": "dismissCloudAgentPublishProposal",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "dismiss Cloud Agent Publish Proposal"
  },
  {
    "method": "dismissAgentSuggestions",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "Record agent-suggestion dismissals per agent (roster domain, 0.75.0)",
    "handler": "dismissAgentSuggestions"
  },
  {
    "method": "dismissTray",
    "side": "coordinator",
    "group": "shell",
    "impl": "local",
    "summary": "dismiss Tray",
    "handler": "dismissTray"
  },
  {
    "method": "dismissUserForm",
    "side": "coordinator",
    "group": "shell",
    "impl": "local",
    "summary": "dismiss User Form",
    "handler": "dismissUserForm"
  },
  {
    "method": "dismissWidget",
    "side": "coordinator",
    "group": "shell",
    "impl": "local",
    "summary": "dismiss Widget",
    "handler": "dismissWidget"
  },
  {
    "method": "ensureCloudAgentArtifacts",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "ensure Cloud Agent Artifacts"
  },
  {
    "method": "ensureDefaultMainAgent",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "ok",
    "summary": "Ensure a main session exists (no-op)"
  },
  {
    "method": "ensureForeverBox",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "ensure Forever Box"
  },
  {
    "method": "getAgentAutomations",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "List automations for an agent",
    "handler": "automation.listAutomations"
  },
  {
    "method": "getAgentAvatar",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "Get a session avatar",
    "handler": "sess.getAvatar"
  },
  {
    "method": "getAgentChannels",
    "side": "coordinator",
    "group": "integration",
    "impl": "stub",
    "scope": "backend",
    "summary": "get Agent Channels"
  },
  {
    "method": "getAgentTasks",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "tasks.list",
    "summary": "List tasks for a session"
  },
  {
    "method": "getAgentTranscriptTail",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "getAgentTranscriptTail",
    "summary": "Read a session transcript tail"
  },
  {
    "method": "getAgentWorkflows",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "List workflows for an agent",
    "handler": "automation.listWorkflows"
  },
  {
    "method": "getAsyncTasks",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "tasks.list",
    "summary": "List background/async child tasks"
  },
  {
    "method": "getAutomationWebhookCredential",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Get/create a local webhook token",
    "handler": "automation.webhook"
  },
  {
    "method": "getBotTemplateExportPolicy",
    "side": "coordinator",
    "group": "account",
    "impl": "local",
    "handler": "getBotTemplateExportPolicy",
    "summary": "get Bot Template Export Policy"
  },
  {
    "method": "getBotTemplateForSourceAgent",
    "side": "coordinator",
    "group": "account",
    "impl": "local",
    "handler": "getBotTemplateForSourceAgent",
    "summary": "get Bot Template For Source Agent"
  },
  {
    "method": "getBotTemplateVersion",
    "side": "coordinator",
    "group": "account",
    "impl": "local",
    "handler": "getBotTemplateVersion",
    "summary": "get Bot Template Version"
  },
  {
    "method": "getBoxSecretsStatus",
    "side": "coordinator",
    "group": "secret",
    "impl": "local",
    "handler": "secrets.status",
    "summary": "Secrets count/status"
  },
  {
    "method": "getCloudAgentConversation",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "get Cloud Agent Conversation"
  },
  {
    "method": "getCloudAgentInfo",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "get Cloud Agent Info"
  },
  {
    "method": "getCloudAgentPublishProposals",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "get Cloud Agent Publish Proposals"
  },
  {
    "method": "getConversationOutline",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "Outline a session transcript",
    "handler": "sess.outline"
  },
  {
    "method": "getForeverBoxStatus",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "get Forever Box Status"
  },
  {
    "method": "getHostStatus",
    "side": "coordinator",
    "group": "computer",
    "impl": "local",
    "handler": "host.status",
    "summary": "Describe local host/sandbox"
  },
  {
    "method": "getListenerConnectUrl",
    "side": "coordinator",
    "group": "integration",
    "impl": "stub",
    "scope": "backend",
    "summary": "get Listener Connect Url"
  },
  {
    "method": "getListenerIntegrations",
    "side": "coordinator",
    "group": "integration",
    "impl": "stub",
    "scope": "backend",
    "summary": "get Listener Integrations"
  },
  {
    "method": "getMainAgent",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "sessions.active",
    "summary": "Active session id"
  },
  {
    "method": "getPluginSyncStatus",
    "side": "coordinator",
    "group": "skills",
    "impl": "local",
    "summary": "Skill/plugin sync status",
    "handler": "skills.syncStatus"
  },
  {
    "method": "getServerAgentRoster",
    "side": "coordinator",
    "group": "broadcast",
    "impl": "local",
    "summary": "Snapshot roster of agent sessions",
    "handler": "bcast.roster"
  },
  {
    "method": "getSkillPublishTargets",
    "side": "coordinator",
    "group": "skills",
    "impl": "local",
    "summary": "Skill publish targets (local catalog)",
    "handler": "skills.targets"
  },
  {
    "method": "getSubagents",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "tasks.list",
    "summary": "List child tasks"
  },
  {
    "method": "getTeachRecordingStatus",
    "side": "coordinator",
    "group": "skill",
    "impl": "local",
    "handler": "skill.status",
    "summary": "Recording status"
  },
  {
    "method": "getTrays",
    "side": "coordinator",
    "group": "shell",
    "impl": "local",
    "summary": "get Trays",
    "handler": "getTrays"
  },
  {
    "method": "getVoiceCall",
    "side": "coordinator",
    "group": "voice",
    "impl": "local",
    
    "summary": "getVoiceCall",
    "handler": "getVoiceCall"
  },
  {
    "method": "handBackForeverBox",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "hand Back Forever Box"
  },
  {
    "method": "hasRestorablePluginListingCopy",
    "side": "coordinator",
    "group": "skill",
    "impl": "stub",
    "scope": "backend",
    "summary": "has Restorable Plugin Listing Copy"
  },
  {
    "method": "importAgentWorkflowText",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Import a workflow from text",
    "handler": "automation.importText"
  },
  {
    "method": "importAgentWorkflowUrl",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Import a workflow from a local source",
    "handler": "automation.importUrl"
  },
  {
    "method": "interruptAgentRun",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "tasks.interrupt",
    "summary": "Interrupt a child/run"
  },
  {
    "method": "isEgressTunnelAvailable",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "is Egress Tunnel Available"
  },
  {
    "method": "kickstartAgent",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "tasks.start",
    "summary": "Start a child task"
  },
  {
    "method": "listAgents",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "sessions.list",
    "summary": "List sessions (Grok \"agents\")"
  },
  {
    "method": "listAllAutomations",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "List all automations",
    "handler": "automation.listAll"
  },
  {
    "method": "markAgentTaskRead",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "ok",
    "summary": "Mark task read (local)"
  },
  {
    "method": "noteMountedAgent",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "ok",
    "summary": "Note mounted session (local)"
  },
  {
    "method": "nudgeVoiceCall",
    "side": "coordinator",
    "group": "voice",
    "impl": "local",
    
    "summary": "nudgeVoiceCall",
    "handler": "nudgeVoiceCall"
  },
  {
    "method": "openAgentTail",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "sessions.get",
    "summary": "Open/last turn of a session transcript"
  },
  {
    "method": "previewVoice",
    "side": "coordinator",
    "group": "voice",
    "impl": "local",
    "summary": "preview Voice",
    "handler": "previewVoice"
  },
  {
    "method": "promptAcceptanceStatus",
    "side": "coordinator",
    "group": "misc",
    "impl": "local",
    "summary": "prompt Acceptance Status",
    "handler": "promptAcceptanceStatus"
  },
  {
    "method": "publishBotTemplate",
    "side": "coordinator",
    "group": "account",
    "impl": "local",
    "handler": "publishBotTemplate",
    "summary": "publish Bot Template"
  },
  {
    "method": "publishSkill",
    "side": "coordinator",
    "group": "skills",
    "impl": "local",
    "summary": "Install/publish a skill into the local catalog",
    "handler": "skills.publish"
  },
  {
    "method": "reactToMessage",
    "side": "coordinator",
    "group": "misc",
    "impl": "local",
    "handler": "ok",
    "summary": "React to a message (local, no-op)"
  },
  {
    "method": "readMainAgentContext",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "Read main-agent context/config",
    "handler": "settings.readContext"
  },
  {
    "method": "readMcpAppResource",
    "side": "coordinator",
    "group": "mcp",
    "impl": "local",
    "summary": "read Mcp App Resource",
    "handler": "readMcpAppResource"
  },
  {
    "method": "recordVoiceCall",
    "side": "coordinator",
    "group": "voice",
    "impl": "local",
    
    "summary": "recordVoiceCall",
    "handler": "recordVoiceCall"
  },
  {
    "method": "refreshChannel",
    "side": "coordinator",
    "group": "integration",
    "impl": "stub",
    "scope": "backend",
    "summary": "refresh Channel"
  },
  {
    "method": "requestDiskSaverAudit",
    "side": "coordinator",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "request Disk Saver Audit"
  },
  {
    "method": "resolveAgentCreation",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "scope": "backend",
    "summary": "resolve Agent Creation"
  },
  {
    "method": "resolveAutoReviewApproval",
    "side": "coordinator",
    "group": "misc",
    "impl": "local",
    "summary": "resolve Auto Review Approval",
    "handler": "resolveAutoReviewApproval"
  },
  {
    "method": "resolveConnectorGrant",
    "side": "coordinator",
    "group": "integration",
    "impl": "stub",
    "scope": "backend",
    "summary": "resolve Connector Grant"
  },
  {
    "method": "resolveLocalToolPermission",
    "side": "coordinator",
    "group": "consent",
    "impl": "local",
    "summary": "Resolve a tool decision (allow/ask/deny)",
    "handler": "consent.resolve"
  },
  {
    "method": "resolveMessagesGrants",
    "side": "coordinator",
    "group": "integration",
    "impl": "local",
    "summary": "resolve Messages Grants",
    "handler": "resolveMessagesGrants"
  },
  {
    "method": "respondToWidget",
    "side": "coordinator",
    "group": "shell",
    "impl": "local",
    "summary": "respond To Widget",
    "handler": "respondToWidget"
  },
  {
    "method": "restoreTemporalAgentRouting",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "scope": "backend",
    "summary": "restore Temporal Agent Routing"
  },
  {
    "method": "resyncPublishedSkill",
    "side": "coordinator",
    "group": "skill",
    "impl": "stub",
    "scope": "backend",
    "summary": "resync Published Skill"
  },
  {
    "method": "runAgentAutomationNow",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Run an automation now",
    "handler": "automation.run"
  },
  {
    "method": "runAgentWorkflowNow",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Run a workflow now",
    "handler": "automation.run"
  },
  {
    "method": "searchAgents",
    "side": "coordinator",
    "group": "search",
    "impl": "local",
    "handler": "search.agents",
    "summary": "Search sessions by title/id"
  },
  {
    "method": "searchMedia",
    "side": "coordinator",
    "group": "search",
    "impl": "local",
    "summary": "Search workspace media files",
    "handler": "search.media"
  },
  {
    "method": "seedConversationName",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "Name a session from its first message",
    "handler": "sess.seedName"
  },
  {
    "method": "sendDraft",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "Persist a composer draft",
    "handler": "sess.saveDraft"
  },
  {
    "method": "sendPrompt",
    "side": "coordinator",
    "group": "misc",
    "impl": "local",
    "handler": "agent.run",
    "summary": "Send a prompt (runs the agent loop)"
  },
  {
    "method": "setAgentAutomationEnabled",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Enable/disable an automation",
    "handler": "automation.setEnabled"
  },
  {
    "method": "setAgentAvatarBytes",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "Set a session avatar from bytes",
    "handler": "sess.setAvatar"
  },
  {
    "method": "setAgentDraftingDisabled",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "Disable/enable draft persistence",
    "handler": "sess.setDraftingDisabled"
  },
  {
    "method": "setAgentHiddenFromSidebar",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "set Agent Hidden From Sidebar",
    "handler": "setAgentHiddenFromSidebar"
  },
  {
    "method": "setAgentNotificationsEnabled",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "settings.notifications",
    "summary": "Toggle finish notifications"
  },
  {
    "method": "setAgentNotifyOnUpdates",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "settings.notifyUpdates",
    "summary": "Notify-on-updates toggle"
  },
  {
    "method": "setAgentUnread",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "ok",
    "summary": "Mark session unread (local)"
  },
  {
    "method": "setAgentVoice",
    "side": "coordinator",
    "group": "voice",
    "impl": "local",
    "summary": "Set per-agent voice",
    "handler": "setAgentVoice"
  },
  {
    "method": "setBotTemplateVisibility",
    "side": "coordinator",
    "group": "account",
    "impl": "local",
    "handler": "setBotTemplateVisibility",
    "summary": "set Bot Template Visibility"
  },
  {
    "method": "setGroupMembers",
    "side": "coordinator",
    "group": "account",
    "impl": "local",
    "handler": "setGroupMembers",
    "summary": "set Group Members"
  },
  {
    "method": "setMainAgent",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "sessions.setActive",
    "summary": "Set the active session"
  },
  {
    "method": "setVoiceCallPresence",
    "side": "coordinator",
    "group": "voice",
    "impl": "local",
    
    "summary": "setVoiceCallPresence",
    "handler": "setVoiceCallPresence"
  },
  {
    "method": "skillsCatalog",
    "side": "coordinator",
    "group": "skills",
    "impl": "local",
    "handler": "skills.catalog",
    "summary": "List installed skills in the local catalog"
  },
  {
    "method": "startTeachRecording",
    "side": "coordinator",
    "group": "skill",
    "impl": "local",
    "handler": "skill.begin",
    "summary": "Begin teaching recording"
  },
  {
    "method": "stopCloudAgent",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "stop Cloud Agent"
  },
  {
    "method": "stopTeachRecording",
    "side": "coordinator",
    "group": "skill",
    "impl": "local",
    "handler": "skill.stop",
    "summary": "Stop/complete recording"
  },
  {
    "method": "submitSecret",
    "side": "coordinator",
    "group": "secret",
    "impl": "local",
    "handler": "secrets.set",
    "summary": "Store a secret field"
  },
  {
    "method": "submitUserForm",
    "side": "coordinator",
    "group": "shell",
    "impl": "local",
    "summary": "submit User Form",
    "handler": "submitUserForm"
  },
  {
    "method": "syncPluginSkills",
    "side": "coordinator",
    "group": "skills",
    "impl": "local",
    "summary": "Install a batch of skills/plugins",
    "handler": "skills.sync"
  },
  {
    "method": "unpublishPluginListing",
    "side": "coordinator",
    "group": "skill",
    "impl": "stub",
    "scope": "backend",
    "summary": "unpublish Plugin Listing"
  },
  {
    "method": "unpublishSkill",
    "side": "coordinator",
    "group": "skills",
    "impl": "local",
    "summary": "Remove a published skill",
    "handler": "skills.uninstall"
  },
  {
    "method": "updateAgent",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "handler": "sessions.rename",
    "summary": "Rename a session"
  },
  {
    "method": "updateAgentAutomation",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Update an automation",
    "handler": "automation.update"
  },
  {
    "method": "updateAgentWorkflow",
    "side": "coordinator",
    "group": "automation",
    "impl": "local",
    "summary": "Update a workflow",
    "handler": "automation.update"
  },
  {
    "method": "updateCloudAgentPublishApp",
    "side": "coordinator",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "update Cloud Agent Publish App"
  },
  {
    "method": "updateHostNow",
    "side": "coordinator",
    "group": "computer",
    "impl": "local",
    "handler": "updater.check",
    "summary": "Check for updates"
  },
  {
    "method": "voteFeedback",
    "side": "coordinator",
    "group": "misc",
    "impl": "local",
    "summary": "vote Feedback",
    "handler": "voteFeedback"
  },
  {
    "method": "ackCursorTeamFallback",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "ackCursorTeamFallback",
    "scope": "cursor/account"
  },
  {
    "method": "addGrokBotTeamsAppToTeam",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "addGrokBotTeamsAppToTeam",
    "scope": "backend"
  },
  {
    "method": "agentsCreate",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "agentsCreate",
    "handler": "agentsCreate"
  },
  {
    "method": "agentsDeleteMany",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "agentsDeleteMany",
    "handler": "agentsDeleteMany"
  },
  {
    "method": "awaitCookieOriginApproval",
    "side": "desktop",
    "group": "cookies",
    "impl": "local",
    "summary": "awaitCookieOriginApproval",
    "handler": "awaitCookieOriginApproval"
  },
  {
    "method": "awaitMessagesGrants",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "awaitMessagesGrants",
    "handler": "awaitMessagesGrants"
  },
  {
    "method": "callMcpAppTool",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "callMcpAppTool",
    "handler": "callMcpAppTool"
  },
  {
    "method": "cancelCookieOriginApproval",
    "side": "desktop",
    "group": "cookies",
    "impl": "local",
    "summary": "cancelCookieOriginApproval",
    "handler": "cancelCookieOriginApproval"
  },
  {
    "method": "cancelMessagesGrants",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "cancelMessagesGrants",
    "handler": "cancelMessagesGrants"
  },
  {
    "method": "carryBoxSecretsToBot",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "summary": "carryBoxSecretsToBot",
    "handler": "carryBoxSecretsToBot"
  },
  {
    "method": "completeCursorScmConnect",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "completeCursorScmConnect",
    "scope": "cursor/account"
  },
  {
    "method": "completeMcpOAuth",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "completeMcpOAuth",
    "handler": "completeMcpOAuth"
  },
  {
    "method": "conversationOutlineGet",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "conversationOutlineGet",
    "handler": "conversationOutlineGet"
  },
  {
    "method": "createGrokBotVaultCard",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "summary": "createGrokBotVaultCard",
    "handler": "createGrokBotVaultCard"
  },
  {
    "method": "deepLinkEmit",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "deepLinkEmit",
    "handler": "deepLinkEmit"
  },
  {
    "method": "deleteFinanceConnection",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "deleteFinanceConnection",
    "scope": "backend"
  },
  {
    "method": "deleteGrokBotAgentFile",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "deleteGrokBotAgentFile",
    "handler": "deleteGrokBotAgentFile"
  },
  {
    "method": "deleteGrokBotVaultCredential",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "summary": "deleteGrokBotVaultCredential",
    "handler": "deleteGrokBotVaultCredential"
  },
  {
    "method": "devLogin",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "devLogin",
    "scope": "backend"
  },
  {
    "method": "disconnectListenerPlatform",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "disconnectListenerPlatform",
    "scope": "backend"
  },
  {
    "method": "disconnectScmConnection",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "disconnectScmConnection",
    "scope": "backend"
  },
  {
    "method": "duplicateAgent",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "duplicateAgent",
    "handler": "duplicateAgent"
  },
  {
    "method": "exposeUsageWarningExperiment",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "exposeUsageWarningExperiment",
    "handler": "exposeUsageWarningExperiment"
  },
  {
    "method": "getAgentNotificationAvatar",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "getAgentNotificationAvatar",
    "handler": "getAgentNotificationAvatar"
  },
  {
    "method": "getAgentThread",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "getAgentThread",
    "handler": "getAgentThread"
  },
  {
    "method": "getAgentTodos",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "getAgentTodos",
    "handler": "getAgentTodos"
  },
  {
    "method": "getAgentTranscript",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "getAgentTranscript",
    "handler": "getAgentTranscript"
  },
  {
    "method": "getAgentTranscriptPage",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "getAgentTranscriptPage",
    "handler": "getAgentTranscriptPage"
  },
  {
    "method": "getAgentTranscriptWindow",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "getAgentTranscriptWindow",
    "handler": "getAgentTranscriptWindow"
  },
  { "method": "getCanvasShareAccess",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "getCanvasShareAccess",
    "handler": "getCanvasShareAccess"
    
  },
  {
    "method": "getCloudAgentAppSecrets",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "summary": "getCloudAgentAppSecrets",
    "scope": "backend"
  },
  {
    "method": "getCursorEnterpriseUsage",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "getCursorEnterpriseUsage",
    "scope": "cursor/account"
  },
  {
    "method": "getCursorGithubRepoAccess",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "getCursorGithubRepoAccess",
    "scope": "cursor/account"
  },
  {
    "method": "getCursorOriginPrStatus",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "getCursorOriginPrStatus",
    "scope": "cursor/account"
  },
  {
    "method": "getCursorPrepaidSettings",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "getCursorPrepaidSettings",
    "scope": "cursor/account"
  },
  {
    "method": "getCursorTeamInviteLink",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "getCursorTeamInviteLink",
    "scope": "cursor/account"
  },
  {
    "method": "getCursorUsageBreakdown",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "getCursorUsageBreakdown",
    "scope": "cursor/account"
  },
  {
    "method": "getGrokBotAgentAccess",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "summary": "getGrokBotAgentAccess",
    "scope": "backend"
  },
  {
    "method": "getGrokBotAgentLinkAccess",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "summary": "getGrokBotAgentLinkAccess",
    "scope": "backend"
  },
  {
    "method": "getGrokBotTeamsInstallState",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "getGrokBotTeamsInstallState",
    "scope": "backend"
  },
  {
    "method": "getSharepointSignIn",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "getSharepointSignIn",
    "scope": "backend"
  },
  {
    "method": "injectChromeCookies",
    "side": "desktop",
    "group": "cookies",
    "impl": "local",
    "summary": "injectChromeCookies",
    "handler": "injectChromeCookies"
  },
  {
    "method": "installGrokBotTeamsApp",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "installGrokBotTeamsApp",
    "scope": "backend"
  },
  {
    "method": "installMcpEntry",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "installMcpEntry",
    "handler": "installMcpEntry"
  },
  {
    "method": "invokeCursorDashboardAction",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "invokeCursorDashboardAction",
    "scope": "cursor/account"
  },
  {
    "method": "isProcessAlive",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "isProcessAlive",
    "handler": "isProcessAlive"
  },
  {
    "method": "listBoxMcpServers",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "listBoxMcpServers",
    "handler": "listBoxMcpServers"
  },
  {
    "method": "listCursorTeamGroups",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "listCursorTeamGroups",
    "scope": "cursor/account"
  },
  {
    "method": "listCursorTeamMembers",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "listCursorTeamMembers",
    "scope": "cursor/account"
  },
  {
    "method": "listGrokBotAgentFiles",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "listGrokBotAgentFiles",
    "handler": "listGrokBotAgentFiles"
  },
  {
    "method": "listGrokBotAgentMeetings",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "summary": "listGrokBotAgentMeetings",
    "scope": "backend"
  },
  {
    "method": "listGrokBotTeamsJoinedTeams",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "listGrokBotTeamsJoinedTeams",
    "scope": "backend"
  },
  {
    "method": "listLibraryPages",
    "side": "desktop",
    "group": "document",
    "impl": "local",
    "summary": "listLibraryPages",
    "handler": "listLibraryPages"
  },
  {
    "method": "logComposerTriggerExperimentExposure",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "logComposerTriggerExperimentExposure",
    "handler": "logComposerTriggerExperimentExposure"
  },
  {
    "method": "markAgentTaskDone",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "markAgentTaskDone",
    "handler": "markAgentTaskDone"
  },
  {
    "method": "mintLocalExecDaemonCredential",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "mintLocalExecDaemonCredential",
    "handler": "mintLocalExecDaemonCredential"
  },
  {
    "method": "noteBoxIntent",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "noteBoxIntent",
    "handler": "noteBoxIntent"
  },
  {
    "method": "openAgent",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "openAgent",
    "handler": "openAgent"
  },
  {
    "method": "openAgentWindowed",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "openAgentWindowed",
    "handler": "openAgentWindowed"
  },
  { "method": "openCanvasLink",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "openCanvasLink",
    "handler": "openCanvasLink"
    
  },
  {
    "method": "performServerAgentAction",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "summary": "performServerAgentAction",
    "scope": "backend"
  },
  {
    "method": "prepareCursorScmConnect",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "prepareCursorScmConnect",
    "scope": "cursor/account"
  },
  {
    "method": "presentCookieOriginApproval",
    "side": "desktop",
    "group": "cookies",
    "impl": "local",
    "summary": "presentCookieOriginApproval",
    "handler": "presentCookieOriginApproval"
  },
  {
    "method": "preuploadStagedAttachment",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "preuploadStagedAttachment",
    "handler": "preuploadStagedAttachment"
  },
  {
    "method": "putGrokBotVaultCredential",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "summary": "putGrokBotVaultCredential",
    "handler": "putGrokBotVaultCredential"
  },
  {
    "method": "readAttachmentChunk",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "readAttachmentChunk",
    "handler": "readAttachmentChunk"
  },
  {
    "method": "readAttachmentImage",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "readAttachmentImage",
    "handler": "readAttachmentImage"
  },
  {
    "method": "readVoiceCallSentMessages",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "readVoiceCallSentMessages",
    "handler": "readVoiceCallSentMessages"
    
  },
  {
    "method": "refreshMcp",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "refreshMcp",
    "handler": "refreshMcp"
  },
  {
    "method": "reinstallGrokBotTeamsApp",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "reinstallGrokBotTeamsApp",
    "scope": "backend"
  },
  {
    "method": "releaseStagedAttachmentPreupload",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "releaseStagedAttachmentPreupload",
    "handler": "releaseStagedAttachmentPreupload"
  },
  {
    "method": "removeCursorAccount",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "removeCursorAccount",
    "scope": "cursor/account"
  },
  {
    "method": "removeSandMachine",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "removeSandMachine",
    "scope": "cursor/account"
  },
  { "method": "renameCanvas",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "renameCanvas",
    "handler": "renameCanvas"
    
  },
  {
    "method": "reportBackendReachability",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "reportBackendReachability",
    "handler": "reportBackendReachability"
  },
  {
    "method": "reportGatewayCommandSpan",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "reportGatewayCommandSpan",
    "handler": "reportGatewayCommandSpan"
  },
  {
    "method": "reportGatewayDnsDiagnostic",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "reportGatewayDnsDiagnostic",
    "handler": "reportGatewayDnsDiagnostic"
  },
  {
    "method": "reportGatewayReachability",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "reportGatewayReachability",
    "handler": "reportGatewayReachability"
  },
  {
    "method": "reportLocalExecSupervisorFailed",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "reportLocalExecSupervisorFailed",
    "handler": "reportLocalExecSupervisorFailed"
  },
  {
    "method": "reportMarketplaceSearch",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "reportMarketplaceSearch",
    "handler": "reportMarketplaceSearch"
  },
  {
    "method": "reportPolicyStopped",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "reportPolicyStopped",
    "handler": "reportPolicyStopped"
  },
  {
    "method": "reportProcessCrash",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "reportProcessCrash",
    "handler": "reportProcessCrash"
  },
  {
    "method": "reportTranscriptParity",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "reportTranscriptParity",
    "handler": "reportTranscriptParity"
  },
  {
    "method": "reportTranscriptRowLoss",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "reportTranscriptRowLoss",
    "handler": "reportTranscriptRowLoss"
  },
  {
    "method": "reportTranscriptSource",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "reportTranscriptSource",
    "handler": "reportTranscriptSource"
  },
  {
    "method": "reportTransportStage",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "reportTransportStage",
    "handler": "reportTransportStage"
  },
  {
    "method": "reportUsageWarning",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "reportUsageWarning",
    "handler": "reportUsageWarning"
  },
  {
    "method": "requestCookieOriginApproval",
    "side": "desktop",
    "group": "cookies",
    "impl": "local",
    "summary": "requestCookieOriginApproval",
    "handler": "requestCookieOriginApproval"
  },
  {
    "method": "requestMessagesGrants",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "requestMessagesGrants",
    "handler": "requestMessagesGrants"
  },
  {
    "method": "requestWebAuthnCeremony",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "requestWebAuthnCeremony",
    "scope": "backend"
  },
  {
    "method": "requestWebAuthnConsent",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "requestWebAuthnConsent",
    "scope": "backend"
  },
  {
    "method": "requestWebAuthnPin",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "requestWebAuthnPin",
    "scope": "backend"
  },
  {
    "method": "resolveGatewayConnection",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "resolveGatewayConnection",
    "handler": "resolveGatewayConnection"
  },
  {
    "method": "resolveVirtualCardApproval",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "resolveVirtualCardApproval",
    "handler": "resolveVirtualCardApproval"
  },
  {
    "method": "revokeComputerUseAllowedApp",
    "side": "desktop",
    "group": "computer",
    "impl": "local",
    "summary": "revokeComputerUseAllowedApp",
    "handler": "revokeComputerUseAllowedApp"
  },
  {
    "method": "rollBackConversation",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "rollBackConversation",
    "handler": "rollBackConversation"
  },
  {
    "method": "sealLocalExecFile",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "sealLocalExecFile",
    "handler": "sealLocalExecFile"
  },
  {
    "method": "sendCursorTeamInvites",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "sendCursorTeamInvites",
    "scope": "cursor/account"
  },
  {
    "method": "setAgentTaskPinned",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "setAgentTaskPinned",
    "handler": "setAgentTaskPinned"
  },
  {
    "method": "setBoxSecrets",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "summary": "setBoxSecrets",
    "handler": "setBoxSecrets"
  },
  { "method": "setCanvasPageAddress",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "setCanvasPageAddress",
    "handler": "setCanvasPageAddress"
    
  },
  {
    "method": "setCloudAgentAppSecrets",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "summary": "setCloudAgentAppSecrets",
    "scope": "backend"
  },
  {
    "method": "setCursorPrepaidAutoTopUp",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "setCursorPrepaidAutoTopUp",
    "scope": "cursor/account"
  },
  {
    "method": "setCursorPrepaidHardLimit",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "setCursorPrepaidHardLimit",
    "scope": "cursor/account"
  },
  {
    "method": "setDevGatewayOffline",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "setDevGatewayOffline",
    "handler": "setDevGatewayOffline"
  },
  {
    "method": "setGatewayPaused",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "setGatewayPaused",
    "handler": "setGatewayPaused"
  },
  {
    "method": "setHostSettings",
    "side": "desktop",
    "group": "host",
    "impl": "local",
    "summary": "setHostSettings",
    "handler": "setHostSettings"
  },
  {
    "method": "setMcpToolPermissions",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "setMcpToolPermissions",
    "handler": "setMcpToolPermissions"
  },
  {
    "method": "setTimeZoneOverride",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "setTimeZoneOverride",
    "handler": "setTimeZoneOverride"
  },
  {
    "method": "setUnreadFilterMenuChecked",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "setUnreadFilterMenuChecked",
    "handler": "setUnreadFilterMenuChecked"
  },
  {
    "method": "setWindowFocused",
    "side": "desktop",
    "group": "window",
    "impl": "local",
    "summary": "setWindowFocused",
    "handler": "setWindowFocused"
  },
  {
    "method": "signalBoxIntent",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "signalBoxIntent",
    "handler": "signalBoxIntent"
  },
  {
    "method": "spawnLocalExecDaemon",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "spawnLocalExecDaemon",
    "handler": "spawnLocalExecDaemon"
  },
  {
    "method": "startFreshConversation",
    "side": "coordinator",
    "group": "session",
    "impl": "local",
    "summary": "startFreshConversation",
    "handler": "startFreshConversation"
  },
  {
    "method": "startGrokBotTeamsConnect",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "startGrokBotTeamsConnect",
    "scope": "backend"
  },
  {
    "method": "storeSecret",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "summary": "storeSecret",
    "handler": "storeSecret"
  },
  {
    "method": "subagentsGet",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "subagentsGet",
    "handler": "subagentsGet"
  },
  {
    "method": "switchCursorAccount",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "switchCursorAccount",
    "scope": "cursor/account"
  },
  {
    "method": "tellCloudAgentAppSecretsSet",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "summary": "tellCloudAgentAppSecretsSet",
    "scope": "backend"
  },
  {
    "method": "terminateProcess",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "terminateProcess",
    "handler": "terminateProcess"
  },
  {
    "method": "uninstallGrokBotTeamsApp",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "uninstallGrokBotTeamsApp",
    "scope": "backend"
  },
  {
    "method": "uninstallMcpPlugin",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "uninstallMcpPlugin",
    "handler": "uninstallMcpPlugin"
  },
  {
    "method": "unpublishCloudAgentPublishApp",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "summary": "unpublishCloudAgentPublishApp",
    "scope": "backend"
  },
  { "method": "updateCanvasShareAccess",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "updateCanvasShareAccess",
    "handler": "updateCanvasShareAccess"
    
  },
  {
    "method": "updateCursorAccountName",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "updateCursorAccountName",
    "scope": "cursor/account"
  },
  {
    "method": "updateCursorProfilePhoto",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "updateCursorProfilePhoto",
    "scope": "cursor/account"
  },
  {
    "method": "updateForeverBox",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "updateForeverBox",
    "scope": "backend"
  },
  {
    "method": "updateGrokBotAgentAccess",
    "side": "coordinator",
    "group": "agent",
    "impl": "stub",
    "summary": "updateGrokBotAgentAccess",
    "scope": "backend"
  },
  {
    "method": "updateGrokBotVaultCard",
    "side": "desktop",
    "group": "secret",
    "impl": "local",
    "summary": "updateGrokBotVaultCard",
    "handler": "updateGrokBotVaultCard"
  },
  {
    "method": "updateMcpPluginInstall",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "updateMcpPluginInstall",
    "handler": "updateMcpPluginInstall"
  },
  {
    "method": "updateSandMachineLabel",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "updateSandMachineLabel",
    "scope": "cursor/account"
  },
  {
    "method": "updateWebAuthnConsent",
    "side": "desktop",
    "group": "misc",
    "impl": "stub",
    "summary": "updateWebAuthnConsent",
    "scope": "backend"
  },
  {
    "method": "uploadAttachment",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "uploadAttachment",
    "handler": "uploadAttachment"
  },
  {
    "method": "uploadAttachmentChunk",
    "side": "desktop",
    "group": "attachment",
    "impl": "local",
    "summary": "uploadAttachmentChunk",
    "handler": "uploadAttachmentChunk"
  },
  {
    "method": "uploadGrokBotAgentFile",
    "side": "coordinator",
    "group": "agent",
    "impl": "local",
    "summary": "uploadGrokBotAgentFile",
    "handler": "uploadGrokBotAgentFile"
  },
  {
    "method": "writeClipboard",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "writeClipboard",
    "handler": "writeClipboard"
  },
  {
    "method": "stopLocalExecDaemon",
    "side": "desktop",
    "group": "exec",
    "impl": "local",
    "summary": "stopLocalExecDaemon",
    "handler": "stopLocalExecDaemon"
  },
  {
    "method": "localExecDaemonStatus",
    "side": "desktop",
    "group": "exec",
    "impl": "local",
    "summary": "localExecDaemonStatus",
    "handler": "localExecDaemonStatus"
  },
  {
    "method": "diagnosticsList",
    "side": "desktop",
    "group": "diagnostics",
    "impl": "local",
    "summary": "diagnosticsList",
    "handler": "diagnosticsList"
  },
  {
    "method": "diagnosticsSummary",
    "side": "desktop",
    "group": "diagnostics",
    "impl": "local",
    "summary": "diagnosticsSummary",
    "handler": "diagnosticsSummary"
  },
  {
    "method": "diagnosticsClear",
    "side": "desktop",
    "group": "diagnostics",
    "impl": "local",
    "summary": "diagnosticsClear",
    "handler": "diagnosticsClear"
  },
  {
    "method": "requestCredentialApproval",
    "side": "desktop",
    "group": "vault",
    "impl": "local",
    "summary": "requestCredentialApproval",
    "handler": "requestCredentialApproval"
  },
  {
    "method": "completeCredentialProviderOAuth",
    "side": "desktop",
    "group": "vault",
    "impl": "local",
    "summary": "completeCredentialProviderOAuth",
    "handler": "completeCredentialProviderOAuth"
  },
  {
    "method": "requestAutoReviewApproval",
    "side": "desktop",
    "group": "desktop",
    "impl": "local",
    "summary": "requestAutoReviewApproval",
    "handler": "requestAutoReviewApproval"
  },
  {
    "method": "getGrokBotAgentSkills",
    "side": "desktop",
    "group": "agent",
    "impl": "local",
    "summary": "getGrokBotAgentSkills",
    "handler": "getGrokBotAgentSkills"
  },
  {
    "method": "adoptServerMcpToolPermissions",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "adopt Server Mcp Tool Permissions",
    "handler": "adoptServerMcpToolPermissions"
  },
  {
    "method": "agentsList",
    "side": "desktop",
    "group": "agent",
    "impl": "local",
    "summary": "agents List",
    "handler": "agentsList"
  },
  {
    "method": "getEffectiveMcpPlugins",
    "side": "desktop",
    "group": "mcp",
    "impl": "local",
    "summary": "get Effective Mcp Plugins",
    "handler": "getEffectiveMcpPlugins"
  },
  {
    "method": "getHostSettings",
    "side": "desktop",
    "group": "host",
    "impl": "local",
    "summary": "get Host Settings",
    "handler": "getHostSettings"
  },
  {
    "method": "getMachineId",
    "side": "desktop",
    "group": "desktop",
    "impl": "local",
    "summary": "get Machine Id",
    "handler": "getMachineId"
  },
  {
    "method": "getRpcTraceWindowTraceparent",
    "side": "desktop",
    "group": "diagnostics",
    "impl": "local",
    "summary": "get Rpc Trace Window Traceparent",
    "handler": "getRpcTraceWindowTraceparent"
  },
  {
    "method": "getSandAccess",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "get Sand Access",
    "handler": "getSandAccess"
  },
  {
    "method": "isGlobalSearchEnabled",
    "side": "desktop",
    "group": "desktop",
    "impl": "local",
    "summary": "is Global Search Enabled",
    "handler": "isGlobalSearchEnabled"
  },
  {
    "method": "isOnePasswordAppInstalled",
    "side": "desktop",
    "group": "desktop",
    "impl": "local",
    "summary": "is One Password App Installed",
    "handler": "isOnePasswordAppInstalled"
  },
  {
    "method": "listComputerUseAllowedApps",
    "side": "desktop",
    "group": "computer",
    "impl": "local",
    "summary": "list Computer Use Allowed Apps",
    "handler": "listComputerUseAllowedApps"
  },
  {
    "method": "logGroupChatDiscouragementExperimentExposure",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "log Group Chat Discouragement Experiment Exposure",
    "handler": "logGroupChatDiscouragementExperimentExposure"
  },
  {
    "method": "logInviteTeammatesExperimentExposure",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "log Invite Teammates Experiment Exposure",
    "handler": "logInviteTeammatesExperimentExposure"
  },
  {
    "method": "logOnboardingJobRoleExperimentExposure",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "log Onboarding Job Role Experiment Exposure",
    "handler": "logOnboardingJobRoleExperimentExposure"
  },
  {
    "method": "logOnboardingNotificationsAskExperimentExposure",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "log Onboarding Notifications Ask Experiment Exposure",
    "handler": "logOnboardingNotificationsAskExperimentExposure"
  },
  {
    "method": "logOnboardingRoleUseCaseBotsExperimentExposure",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "log Onboarding Role Use Case Bots Experiment Exposure",
    "handler": "logOnboardingRoleUseCaseBotsExperimentExposure"
  },
  {
    "method": "noteBackendReturn",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "note Backend Return",
    "handler": "noteBackendReturn"
  },
  {
    "method": "noteBoxAsleep",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "note Box Asleep",
    "handler": "noteBoxAsleep"
  },
  {
    "method": "noteBoxRunning",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "note Box Running",
    "handler": "noteBoxRunning"
  },
  {
    "method": "noteNetworkReturn",
    "side": "desktop",
    "group": "telemetry",
    "impl": "local",
    "summary": "note Network Return",
    "handler": "noteNetworkReturn"
  },
  {
    "method": "openComputerUsePermissionSettings",
    "side": "desktop",
    "group": "computer",
    "impl": "local",
    "summary": "open Computer Use Permission Settings",
    "handler": "openComputerUsePermissionSettings"
  },
  {
    "method": "peekUsageWarningAssignment",
    "side": "desktop",
    "group": "flags",
    "impl": "local",
    "summary": "peek Usage Warning Assignment",
    "handler": "peekUsageWarningAssignment"
  },
  {
    "method": "readClipboard",
    "side": "desktop",
    "group": "shell",
    "impl": "local",
    "summary": "read Clipboard",
    "handler": "readClipboard"
  },
  {
    "method": "readComputerUsePermissions",
    "side": "desktop",
    "group": "computer",
    "impl": "local",
    "summary": "read Computer Use Permissions",
    "handler": "readComputerUsePermissions"
  },
  {
    "method": "readLayout",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "read Layout",
    "handler": "readLayout"
  },
  {
    "method": "resolveServerTranscriptTail",
    "side": "desktop",
    "group": "session",
    "impl": "local",
    "summary": "resolve Server Transcript Tail",
    "handler": "resolveServerTranscriptTail"
  },
  {
    "method": "skipOnboarding",
    "side": "desktop",
    "group": "desktop",
    "impl": "local",
    "summary": "skip Onboarding",
    "handler": "skipOnboarding"
  },
  {
    "method": "unmountSelf",
    "side": "desktop",
    "group": "misc",
    "impl": "local",
    "summary": "unmount Self",
    "handler": "unmountSelf"
  },
  {
    "method": "addCursorAccount",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "add Cursor Account"
  },
  {
    "method": "cancelCursorLoginFlight",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "cancel Cursor Login Flight"
  },
  {
    "method": "cancelCursorSandTrial",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "cancel Cursor Sand Trial"
  },
  {
    "method": "finishWebAuthnConsent",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "backend",
    "summary": "finish Web Authn Consent"
  },
  {
    "method": "getCursorAuthStatus",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Cursor Auth Status"
  },
  {
    "method": "getCursorAvatar",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Cursor Avatar"
  },
  {
    "method": "getCursorLoginFlight",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Cursor Login Flight"
  },
  {
    "method": "getCursorPrReviewPreferences",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Cursor Pr Review Preferences"
  },
  {
    "method": "getCursorPrivacyModeEnabled",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Cursor Privacy Mode Enabled"
  },
  {
    "method": "getCursorSelectedTeam",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Cursor Selected Team"
  },
  {
    "method": "getCursorTeamInviteEligibility",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Cursor Team Invite Eligibility"
  },
  {
    "method": "getCursorUnifyCta",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Cursor Unify Cta"
  },
  {
    "method": "getCursorUsageSummary",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Cursor Usage Summary"
  },
  {
    "method": "getCursorWeeklyUsage",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "get Cursor Weekly Usage"
  },
  {
    "method": "getSandMachines",
    "side": "desktop",
    "group": "computer",
    "impl": "stub",
    "scope": "cloud",
    "summary": "get Sand Machines"
  },
  {
    "method": "getServerPinnedAgents",
    "side": "desktop",
    "group": "host",
    "impl": "stub",
    "scope": "cloud",
    "summary": "get Server Pinned Agents"
  },
  {
    "method": "listBotTemplates",
    "side": "desktop",
    "group": "account",
    "impl": "local",
    "handler": "listBotTemplates",
    "summary": "list Bot Templates"
  },
  {
    "method": "listCloudAgentPublishedApps",
    "side": "desktop",
    "group": "agent",
    "impl": "stub",
    "scope": "cloud",
    "summary": "list Cloud Agent Published Apps"
  },
  {
    "method": "listCursorAccounts",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "list Cursor Accounts"
  },
  {
    "method": "listCursorTeamMemberships",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "list Cursor Team Memberships"
  },
  {
    "method": "listGrokBotVaultCredentials",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "list Grok Bot Vault Credentials"
  },
  {
    "method": "loginCursor",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "login Cursor"
  },
  {
    "method": "logoutCursor",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "logout Cursor"
  },
  {
    "method": "setCursorSpendLimit",
    "side": "desktop",
    "group": "account",
    "impl": "stub",
    "scope": "cursor/account",
    "summary": "set Cursor Spend Limit"
  }
];

module.exports = { REGISTRY };
