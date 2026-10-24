'use strict';
/**
 * Keep-awake service — Manus Studio's keepAwake pattern
 * (dist/keepAwake/keepAwakeService.js): a powerSaveBlocker that prevents
 * app suspension while the agent is working, held only on AC power (the
 * Manus 'prevent-app-suspension' AC-only gate), with persisted state.
 */
let blockerId = null;

function isOnAcPower() {
  // Heuristic without a native dependency: macOS reports AC via pmset.
  try {
    const { execFileSync } = require('node:child_process');
    if (process.platform === 'darwin') {
      const out = execFileSync('pmset', ['-g', 'ps'], { timeout: 2000, encoding: 'utf8' });
      return !/discharging/i.test(out);
    }
  } catch { /* fall through — assume AC */ }
  return true;
}

function ensureAwake(reason = 'agent run') {
  const { powerSaveBlocker } = require('electron');
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return blockerId;
  if (!isOnAcPower()) return null; // never drain the battery on this
  blockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (blockerId !== null) {
    try { console.log(`[keepAwake] started (${blockerId}) — ${reason}`); } catch {}
  }
  return blockerId;
}

function release() {
  if (blockerId === null) return;
  const { powerSaveBlocker } = require('electron');
  try { if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId); } catch {}
  blockerId = null;
}

function state() {
  const { powerSaveBlocker } = require('electron');
  return { active: blockerId !== null && powerSaveBlocker.isStarted(blockerId), id: blockerId };
}

module.exports = { keepAwakeService: { ensureAwake, release, state } };
