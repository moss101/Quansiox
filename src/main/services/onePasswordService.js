'use strict';
/**
 * 1Password integration — scoped, opt-in access to the user's 1Password CLI.
 *
 * Grok Bot ships a full 1Password service: a native `sand-op-launcher` that
 * verifies the CLI's code signature, confines it to the app sandbox, mints
 * short-lived service accounts, and hands the token to the backend.
 *
 * Quansiox keeps the same *shape* but stays entirely local:
 *
 *  - the `op` CLI is discovered and used in place (never re-implemented);
 *  - a service account can be minted for a chosen vault, with an expiry;
 *  - reading a secret requires an explicit user approval — a Touch ID /
 *    passcode prompt from the `QuansioxVaultApprover` helper;
 *  - nothing is uploaded anywhere; the secret is handed to the caller in
 *    the main process and never leaves it.
 *
 * The CLI runner and the approver are injectable, so the logic is
 * unit-tested without 1Password installed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

/** Candidate locations of the 1Password CLI, in preference order. */
const OP_CANDIDATES = [
  '/Applications/1Password.app/Contents/MacOS/op',
  '/Applications/1Password 7 - Password Manager.app/Contents/MacOS/op',
  '/Applications/1Password 8 - Password Manager.app/Contents/MacOS/op',
  '/opt/homebrew/bin/op',
  '/usr/local/bin/op',
];

/** The Touch ID approver binary, when it has been built. */
function approverPath() {
  const candidates = [
    process.env.QUANSIOX_VAULT_APPROVER,
    path.join(__dirname, '..', '..', '..', 'build', 'QuansioxVaultApprover'),
    path.join(__dirname, '..', '..', '..', 'native', 'QuansioxVaultApprover'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Find the `op` CLI. */
function findOp() {
  if (process.env.QUANSIOX_OP_BIN) return process.env.QUANSIOX_OP_BIN;
  for (const candidate of OP_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  try {
    const found = execFileSync('/usr/bin/which', ['op'], { encoding: 'utf8' }).trim();
    return found || null;
  } catch {
    return null;
  }
}

/** Run the CLI. Injected in tests. */
let runner = (bin, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(bin, args, { encoding: 'utf8', timeout: 30_000, ...opts }, (error, stdout, stderr) => {
    if (error) {
      const message = String(stderr || error.message).trim();
      reject(Object.assign(new Error(message || `op ${args[0]} failed`), { code: error.code }));
      return;
    }
    resolve(String(stdout ?? ''));
  });
});
let customRunner = false;

/** Ask the user to approve releasing a secret. Injected in tests. */
let approver = async (reason) => {
  const bin = approverPath();
  if (!bin) {
    // No approver built: the caller decides. We report "unavailable"
    // rather than pretending the user approved.
    return { approved: false, reason: 'no approver available' };
  }
  return new Promise((resolve) => {
    execFile(bin, [reason], { timeout: 120_000 }, (error, _stdout, stderr) => {
      if (!error) { resolve({ approved: true }); return; }
      const text = String(stderr || error.message || '').trim();
      resolve({ approved: false, reason: text });
    });
  });
};

/** The state of the 1Password integration. */
async function status() {
  const bin = findOp();
  if (!bin) {
    return { available: false, reason: 'the 1Password CLI (op) was not found', approver: Boolean(approverPath()) };
  }
  try {
    const out = await runner(bin, ['--version'], {});
    const version = out.trim().split('\n')[0] ?? '';
    const signedIn = await isSignedIn(bin);
    return {
      available: true,
      path: bin,
      version,
      signedIn,
      approver: Boolean(approverPath()),
    };
  } catch (error) {
    return { available: true, path: bin, version: null, signedIn: false, error: String(error.message ?? error) };
  }
}

async function isSignedIn(bin = findOp()) {
  if (!bin) return false;
  try {
    await runner(bin, ['account', 'list', '--format', 'json'], {});
    return true;
  } catch {
    return false;
  }
}

/** The signed-in accounts (ids and emails only). */
async function accounts() {
  const bin = findOp();
  if (!bin) throw new Error('the 1Password CLI (op) was not found');
  const out = await runner(bin, ['account', 'list', '--format', 'json'], {});
  let rows = [];
  try { rows = JSON.parse(out || '[]'); } catch { rows = []; }
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.id ?? null,
    email: row.email ?? null,
    name: row.name ?? null,
    url: row.url ?? null,
  }));
}

/** The vaults visible to the signed-in account. */
async function vaults() {
  const bin = findOp();
  if (!bin) throw new Error('the 1Password CLI (op) was not found');
  const out = await runner(bin, ['vault', 'list', '--format', 'json'], {});
  let rows = [];
  try { rows = JSON.parse(out || '[]'); } catch { rows = []; }
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.id ?? null,
    name: row.name ?? null,
    type: row.type ?? null,
  }));
}

/**
 * The items of a vault — titles and metadata only, never the secrets.
 */
async function items({ vault } = {}) {
  const bin = findOp();
  if (!bin) throw new Error('the 1Password CLI (op) was not found');
  const args = ['item', 'list', '--format', 'json'];
  if (vault) args.push('--vault', String(vault));
  const out = await runner(bin, args, {});
  let rows = [];
  try { rows = JSON.parse(out || '[]'); } catch { rows = []; }
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.id ?? null,
    title: row.title ?? null,
    vault: row.vault?.name ?? row.vault ?? null,
    category: row.category ?? null,
    updatedAt: row.updatedAt ?? null,
  }));
}

/**
 * Mint a service account for a vault, with an expiry.
 *
 * The token is returned to the caller once and never stored: the user can
 * put it in the local vault if they want it there.
 */
async function mintServiceAccount({ vault, name, expiresIn = '30d' } = {}) {
  const bin = findOp();
  if (!bin) throw new Error('the 1Password CLI (op) was not found');
  if (!vault) throw new Error('vault is required');
  const args = ['service-account', 'create', String(name || 'Quansiox'), '--vault', String(vault), '--format', 'json'];
  if (expiresIn) args.push('--expires-in', String(expiresIn));
  const out = await runner(bin, args, {});
  let parsed = null;
  try { parsed = JSON.parse(out || 'null'); } catch { parsed = null; }
  return parsed ?? { raw: out.trim() };
}

/**
 * Read a secret — only after the user approved it.
 *
 * The approval is a Touch ID / passcode prompt (the `QuansioxVaultApprover`
 * helper). The secret is returned to the caller in the main process and is
 * never written to a transcript.
 */
async function readSecret({ item, field, vault, reason } = {}) {
  if (!item) throw new Error('item is required');
  const bin = findOp();
  if (!bin) throw new Error('the 1Password CLI (op) was not found');

  const why = reason || `release the ${field || 'secret'} of "${item}" to the agent`;
  const approval = await approver(why);
  if (!approval.approved) {
    return { approved: false, reason: approval.reason || 'the user declined' };
  }

  const args = ['item', 'get', String(item), '--format', 'json'];
  if (vault) args.push('--vault', String(vault));
  if (field) args.push('--fields', String(field));
  const out = await runner(bin, args, {});
  let parsed = null;
  try { parsed = JSON.parse(out || 'null'); } catch { parsed = null; }
  // The caller decides which field to keep; we return the whole record and
  // let the vault service extract what it needs in the main process.
  return { approved: true, record: parsed ?? { raw: out.trim() } };
}

/**
 * Import an item's login into the local vault.
 *
 * The 1Password secret is read (with approval) and stored in Quansiox's own
 * AES-GCM vault; the 1Password account is never referenced again.
 */
async function importIntoVault({ item, vault, credentialId } = {}) {
  const { vaultService } = require('./vaultService');
  const read = await readSecret({
    item,
    vault,
    reason: `import "${item}" into the Quansiox vault`,
  });
  if (!read.approved) return { status: 'denied', reason: read.reason };
  const record = read.record ?? {};
  const fields = record.fields ?? {};
  const username = fields.username?.value ?? fields.username ?? null;
  const password = fields.password?.value ?? fields.password ?? null;
  if (!password) return { status: 'error', error: 'that item has no password field' };
  const url = fields.url?.value ?? fields.url ?? null;
  const sites = url ? [String(url)] : [];
  const stored = vaultService.putGrokBotVaultCredential({
    id: credentialId,
    title: record.title ?? String(item),
    username: username ?? '',
    password: String(password),
    sites,
    notes: `imported from 1Password item ${item}`,
  });
  return { status: 'ok', id: stored.id, title: stored.title };
}

module.exports = {
  onePasswordService: {
    status, accounts, vaults, items, mintServiceAccount, readSecret, importIntoVault,
    findOp, approverPath,
    _setRunner: (fn) => { runner = fn; customRunner = true; },
    _setApprover: (fn) => { approver = fn; },
    _reset: () => {
      runner = (bin, args, opts = {}) => new Promise((resolve, reject) => {
        execFile(bin, args, { encoding: 'utf8', timeout: 30_000, ...opts }, (error, stdout, stderr) => {
          if (error) { reject(Object.assign(new Error(String(stderr || error.message).trim()), { code: error.code })); return; }
          resolve(String(stdout ?? ''));
        });
      });
      approver = async (reason) => {
        const bin = approverPath();
        if (!bin) return { approved: false, reason: 'no approver available' };
        return new Promise((resolve) => {
          execFile(bin, [reason], { timeout: 120_000 }, (error, _stdout, stderr) => {
            if (!error) { resolve({ approved: true }); return; }
            resolve({ approved: false, reason: String(stderr || error.message || '').trim() });
          });
        });
      };
      customRunner = false;
    },
  },
};
