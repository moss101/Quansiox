'use strict';
/**
 * Tray service — menu-bar icon (Manus desktopTray pattern): quick access to
 * new sessions, showing the main window, and quit. Degrades gracefully when
 * the tray is unavailable.
 */
const { Tray, Menu, nativeImage } = require('electron');
const TRAY_ICON_DATA_URL = require('../assets/trayIcon.js');

let tray = null;

function start({ onNewSession, onShowMain, onQuit }) {
  if (tray) return tray;
  try {
    const image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    image.setTemplateImage(true); // adapts to light/dark menu bars
    tray = new Tray(image);
    tray.setToolTip('Quansiox');
    const rebuild = () => {
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'New session', click: () => onNewSession?.() },
          { label: 'Show Quansiox', click: () => onShowMain?.() },
          { type: 'separator' },
          { label: 'Quit Quansiox', click: () => onQuit?.() },
        ])
      );
    };
    rebuild();
    tray.on('click', () => onShowMain?.());
    return tray;
  } catch (error) {
    console.error('[tray] unavailable:', error.message);
    tray = null;
    return null;
  }
}

function stop() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { trayService: { start, stop } };
