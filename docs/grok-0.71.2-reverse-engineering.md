# Grok Bot 0.71.2 — reverse engineering & parity gap (Quansiox)

Source: `/Users/mohsin/manux/Grok Bot.app` (Electron, com.anysphere.sand, v0.71.2, built 2026-10-14).
Extracted via `asar extract .../app.asar /tmp/qx-grok/app`. Entry: `dist/electron-main/main.cjs` (loader) → `main-app.cjs` (2.6 MB) + `main-core.cjs`.

## Method surface diff (vs. 0.66.0 catalog in work/parity-2026-10-05/ipc-catalog.json)

- Old catalog: 280 desktop + 133 coordinator = 413 method names.
- New bundle (proto-style `name:I().args(...)` registrations): **394** method names.
- **115 new** method names not in the old catalog (renamed surface + new features).
- **122 old** method names absent from the new bundle (renamed/removed).

Full lists: `/tmp/qx-grok/methods_args.json`, `/tmp/qx-grok/removed.txt`.

### New method groups (local-relevant first)

| Group | New methods | Quansiox status |
|---|---|---|
| agent (26) | agentsCreate, agentsDeleteMany, duplicateAgent, openAgent, openAgentWindowed, getAgentThread, getAgentTodos, getAgentTranscript{,Page,Window}, getAgentNotificationAvatar, markAgentTaskDone, setAgentTaskPinned, getGrokBotAgentAccess/LinkAccess, updateGrokBotAgentAccess, getCloudAgentAppSecrets, setCloudAgentAppSecrets, tellCloudAgentAppSecretsSet, unpublishCloudAgentPublishApp, listGrokBotAgentFiles, uploadGrokBotAgentFile, deleteGrokBotAgentFile, listGrokBotAgentMeetings, performServerAgentAction, subagentsGet, getGrokBotAgentFiles | partial: sessions exist; transcript paging, agent files, access control need work |
| attachment (6) | readAttachmentChunk, readAttachmentImage, uploadAttachment, uploadAttachmentChunk, preuploadStagedAttachment, releaseStagedAttachmentPreupload | partial: staging exists; chunked upload/read-image new |
| conversation (3) | conversationOutlineGet (renamed), rollBackConversation, startFreshConversation | outline exists; rollback/fresh new |
| cookie (5) | injectChromeCookies (renamed), await/cancel/present/requestCookieOriginApproval | import exists; approval flow new |
| mcp (8) | listBoxMcpServers, refreshMcp, completeMcpOAuth, installMcpEntry, setMcpToolPermissions, uninstallMcpPlugin, updateMcpPluginInstall, callMcpAppTool | partial: stdio MCP exists; OAuth/refresh/permissions new |
| host/settings (1) | setHostSettings | settings exists |
| library (1) | listLibraryPages | exists (doc.pages) |
| vault (4) | create/put/delete/update GrokBotVault{Card,Credential} | secrets exists; vault cards (payment) new |
| daemon/exec (3) | mintLocalExecDaemonCredential, spawnLocalExecDaemon, sealLocalExecFile | new local daemon concept |
| process (3) | isProcessAlive, terminateProcess, reportProcessCrash | new |
| clipboard (1) | writeClipboard | new (electron clipboard) |
| window (1) | setWindowFocused | windowManager exists |
| computer use (1) | revokeComputerUseAllowedApp | permission mgmt new |
| other (4) | deepLinkEmit, devLogin, setUnreadFilterMenuChecked, revokeComputerUseAllowedApp | partial |
| secret (1) | storeSecret (renamed from submitSecret) | exists |

Cloud/backend/vendor groups (out of local-first scope, stay fail-closed stubs):
box(5), canvas(5), cursor(6), team(7), messages grants(3), auth/webauthn(4), gateway(3), market(1), report*(7), transcript report*(3), removeSandMachine(1), disconnectListenerPlatform(1), sharepoint(1), voice read(1), getSharepointSignIn.

## What changed architecturally in 0.71.2

- IPC method naming shifted from `getX`/`listX` style to `xGet`/`xList`/`xCreate` in several places (conversationOutlineGet, subagentsGet, injectChromeCookies, storeSecret, rollBackConversation...). Quansiox must accept both for backward compat.
- New local-exec daemon (`spawnLocalExecDaemon` + `mintLocalExecDaemonCredential`) — a separate daemon process for tool execution, beyond the existing sandbox host.
- Chunked attachment upload/download (preupload/uploadChunk/readChunk/readImage) — large file transfer.
- Cookie origin approval becomes an interactive request/approve flow (requestCookieOriginApproval → awaitCookieOriginApproval), not just a grant list.
- MCP gains OAuth completion, refresh, permission sets, plugin install/uninstall — beyond stdio spawn.
- Agent transcript is now paginated (getAgentTranscript / Page / Window) with parity reporting.

## Quansiox update plan

Phase 1 (this pass): catalog updated to 0.71.2 surface; renamed local methods aliased to existing handlers; trivial new local features implemented (clipboard, window focus, agent CRUD aliases, transcript alias, listLibraryPages, storeSecret alias, conversationOutlineGet, subagentsGet, injectChromeCookies, deepLinkEmit, setUnreadFilterMenuChecked, revokeComputerUseAllowedApp, rollBackConversation, startFreshConversation, getAgentNotificationAvatar, getAgentThread/Todos/Transcript*, markAgentTaskDone, setAgentTaskPinned, duplicateAgent, openAgent*, agentsCreate/DeleteMany, getGrokBotAgentFiles/upload/delete, setHostSettings, writeClipboard, setWindowFocused).

Phase 2: chunked attachments, cookie approval flow, MCP OAuth/refresh/permissions, local-exec daemon, transcript paging with real cursor.

Phase 3: cloud/backend groups remain fail-closed stubs (require Quansiox-owned backend) — out of local-first scope unless requested.

## Files touched

- docs/grok-0.71.2-reverse-engineering.md (this file)
- src/main/services/grokCompat/catalog.js (regenerated: old + 115 new entries)
- src/main/services/grokCompat/handlers.js (aliases + new trivial handlers)
- test/grok-compat.js (extend assertions for new aliases)
