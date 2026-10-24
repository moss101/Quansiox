'use strict';
/**
 * Capabilities — what this install can actually do.
 *
 * The renderer used to discover a missing capability by clicking a button
 * and reading an error. The reference implementation instead exposes a
 * `capabilities` surface the UI adapts to.
 *
 * This service answers that question honestly, from the *live* state of the
 * machine rather than from a static list:
 *
 *   - is the guest desktop available? (a VZ-capable host, the images present)
 *   - is the native computer helper built and executable?
 *   - is the vault approver built (so the Touch ID gate exists)?
 *   - which providers are configured?
 *   - which MCP servers are registered?
 *   - what is the permission mode?
 *
 * The answer is a snapshot the renderer can cache, with a `reason` on every
 * unavailable capability so the UI can *explain* rather than apologise.
 *
 * Electron-free (honours QUANSIOX_USER_DATA_DIR).
 */
const fs = require('node:fs');
const path = require('node:path');

function root() {
  return path.join(__dirname, '..', '..', '..');
}

function nativeHelper(name) {
  for (const dir of [path.join(root(), 'build'), path.join(root(), 'native')]) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

function vmAssets() {
  const vm = path.join(root(), 'vm');
  const present = {
    kernel: fs.existsSync(path.join(vm, 'bzImage')) || fs.existsSync(path.join(vm, 'Image')),
    initramfs: fs.existsSync(path.join(vm, 'initramfs.cpio.gz')),
    desktopKernel: fs.existsSync(path.join(vm, 'desktop-Image')),
    desktopInitramfs: fs.existsSync(path.join(vm, 'desktop-initramfs.cpio.gz')),
    host: fs.existsSync(path.join(vm, 'qx-vm')) || fs.existsSync(path.join(vm, 'qx-vm.next')),
  };
  return present;
}

/**
 * The full capability snapshot.
 * @returns {object}
 */
function snapshot() {
  const settings = require('./settingsService').settingsService.load();
  const helpers = vmAssets();
  const computerHelper = nativeHelper('QuansioxComputerHelper');
  const captureHelper = nativeHelper('QuansioxCapture');
  const vaultApprover = nativeHelper('QuansioxVaultApprover');

  let mcpServers = [];
  try {
    mcpServers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
  } catch { /* settings unavailable */ }

  const capabilities = {
    guestDesktop: {
      available: Boolean(helpers.host && helpers.desktopKernel && helpers.desktopInitramfs),
      reason: helpers.host && helpers.desktopKernel && helpers.desktopInitramfs
        ? null
        : 'the guest desktop images are not present in this build',
    },
    headlessSandbox: {
      available: Boolean(helpers.host && helpers.kernel && helpers.initramfs),
      reason: helpers.host && helpers.kernel && helpers.initramfs
        ? null
        : 'the sandbox images are not present in this build',
    },
    computerUse: {
      available: Boolean(computerHelper) && settings.allowComputerUse === true,
      reason: !computerHelper
        ? 'the native computer helper is not built (run "npm run native")'
        : settings.allowComputerUse !== true
          ? 'computer use is switched off in Settings → Permissions'
          : null,
    },
    humanCapture: {
      available: Boolean(captureHelper),
      reason: captureHelper ? null : 'the native capture helper is not built (run "npm run native")',
    },
    vaultApprover: {
      available: Boolean(vaultApprover),
      reason: vaultApprover ? null : 'the vault approver is not built, so secrets release without a Touch ID check',
    },
    providers: {
      available: Boolean(settings.baseUrl && settings.apiKey),
      reason: settings.apiKey ? null : 'no provider API key is configured',
      models: settings.model ? [settings.model] : [],
    },
    mcp: {
      available: mcpServers.length > 0,
      reason: mcpServers.length ? null : 'no MCP servers are configured',
      servers: mcpServers.map((s) => s?.name).filter(Boolean),
    },
    voice: {
      available: true,
      reason: null,
      transport: 'local',
    },
    screenSharing: {
      available: Boolean(helpers.desktopKernel),
      reason: helpers.desktopKernel ? null : 'no guest desktop to share',
    },
    browser: {
      available: true,
      reason: null,
    },
  };

  return {
    version: 1,
    at: Date.now(),
    capabilities,
    permissionMode: settings.permissionMode,
    sandboxMode: settings.sandboxMode,
    /** A flat list of what is NOT available, for a one-line summary. */
    unavailable: Object.entries(capabilities)
      .filter(([, c]) => c.available === false)
      .map(([name, c]) => ({ name, reason: c.reason })),
  };
}

/** Just the names of the available capabilities. */
function available() {
  const snap = snapshot();
  return Object.entries(snap.capabilities)
    .filter(([, c]) => c.available)
    .map(([name]) => name);
}

module.exports = { capabilitiesService: { snapshot, available } };
