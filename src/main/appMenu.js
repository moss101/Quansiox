'use strict';
/**
 * Application menu with Grok-parity accelerators. Commands that map onto
 * existing renderer routes are delivered as real events, nothing is faked:
 *   - New Session  -> navigation:navigate {type:'new'}  (compiled renderer opens a session)
 *   - everything else -> ui:command {command}           (renderer/commands-bridge.js acts)
 * Standard items use native Electron roles.
 */

const COMMANDS = {
  openSettings: 'sand.openSettings',
  toggleSidebar: 'sand.toggleSidebar',
  togglePanels: 'sand.togglePanels',
  findInChat: 'sand.findInChat',
  focusInput: 'sand.focusInput',
};

function buildTemplate({ platform = process.platform, emit } = {}) {
  const isMac = platform === 'darwin';
  const command = (name) => () => emit('ui', 'command', { command: name });
  const newSession = () => emit('navigation', 'navigate', { type: 'new' });

  const template = [];

  if (isMac) {
    template.push({
      label: 'Quansiox',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: command(COMMANDS.openSettings) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: newSession },
      { label: 'Close Window', accelerator: 'CmdOrCtrl+W', role: 'close' },
      ...(isMac
        ? []
        : [
            { type: 'separator' },
            { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: command(COMMANDS.openSettings) },
            { type: 'separator' },
            { role: 'quit' },
          ]),
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: command(COMMANDS.toggleSidebar) },
      { label: 'Toggle Panels', accelerator: 'CmdOrCtrl+.', click: command(COMMANDS.togglePanels) },
      { type: 'separator' },
      { label: 'Find in Session', accelerator: 'CmdOrCtrl+F', click: command(COMMANDS.findInChat) },
      { label: 'Focus Composer', accelerator: 'CmdOrCtrl+I', click: command(COMMANDS.focusInput) },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen', accelerator: isMac ? 'Ctrl+Command+F' : 'F11' },
    ],
  });

  if (isMac) {
    template.push({
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    });
  }

  return template;
}

function installAppMenu({ Menu, emit, platform } = {}) {
  const menu = Menu ?? require('electron').Menu;
  const sender = emit ?? require('./ipc/emitEvent').emitEvent;
  const template = buildTemplate({ platform: platform ?? process.platform, emit: sender });
  menu.setApplicationMenu(menu.buildFromTemplate(template));
  return template;
}

module.exports = { buildTemplate, installAppMenu, COMMANDS };
