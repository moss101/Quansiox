'use strict';
/* Stubbed electron exposing Tray/Menu/nativeImage/globalShortcut fakes. */
const state = {
  tray: null,
  registered: new Map(), // accelerator -> callback
  menuTemplates: [],
  builtMenus: [],
};
class FakeTray {
  constructor(image) {
    this.image = image;
    this.tooltip = null;
    this.contextMenu = null;
    this.handlers = {};
    state.tray = this;
  }
  setToolTip(t) { this.tooltip = t; }
  setContextMenu(m) { this.contextMenu = m; }
  on(evt, fn) { this.handlers[evt] = fn; }
  destroy() { state.tray = null; }
}
const FakeMenu = {
  buildFromTemplate(template) {
    state.menuTemplates.push(template);
    const menu = { items: template, popup: () => {} };
    state.builtMenus.push(menu);
    return menu;
  },
};
const FakeNativeImage = {
  createFromDataURL: (url) => ({ url, setTemplateImage: () => {} }),
};
const FakeGlobalShortcut = {
  register(accelerator, cb) {
    if (state.registered.has(accelerator)) return false; // already taken
    state.registered.set(accelerator, cb);
    return true;
  },
  unregister(accelerator) {
    state.registered.delete(accelerator);
  },
  unregisterAll() {
    state.registered.clear();
  },
};
module.exports = {
  __state: state,
  app: { getPath: () => '/tmp' },
  Tray: FakeTray,
  Menu: FakeMenu,
  nativeImage: FakeNativeImage,
  globalShortcut: FakeGlobalShortcut,
  BrowserWindow: class {},
  ipcMain: { on: () => {}, handle: () => {} },
};
