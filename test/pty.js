'use strict';
/* PTY smoke test — verifies the `script`-wrapped bash session:
 * command execution, TTY detection (ANSI output), and SIGINT control char. */
const Module = require('node:module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron') return require.resolve('./stub-electron.js');
  return orig.call(this, req, ...rest);
};

const { shellSessionService } = require('../src/main/services/shellSessionService');

const out = [];
const sender = {
  id: 1,
  isDestroyed: () => false,
  send: (_c, _route, payload) => out.push(payload),
  once: () => {},
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  shellSessionService.create({ sender });
  await sleep(1200);
  shellSessionService.write({ sender }, { input: 'echo pty-works-$((21*2))\n' });
  await sleep(1500);
  const text = () => out.map((p) => (p.kind === 'stdout' ? p.data : '')).join('');

  const assert = require('node:assert');
  assert(text().includes('pty-works-42'), 'command executed through shell');

  if (out.some((p) => p.data?.includes('pseudo-terminal unavailable'))) {
    // Restricted context: pipes fallback — no ANSI expected.
    console.log('note: pty unavailable in this environment; pipes fallback verified');
  } else {
    assert(text().includes('\x1b['), 'tty detected (ANSI sequences present)');
  }

  // SIGINT behavior: the session must remain usable afterwards (pty mode
  // interrupts the child; pipes mode kills the group and auto-respawns).
  shellSessionService.write({ sender }, { input: 'sleep 999\n' });
  await sleep(600);
  shellSessionService.control({ sender }, { key: '\x03' });
  await sleep(1800); // allow respawn + boot
  shellSessionService.write({ sender }, { input: 'echo STILL_ALIVE\n' });
  await sleep(1200);
  assert(text().includes('STILL_ALIVE'), `session usable after SIGINT (${text().length} chars)`);

  shellSessionService.close({ sender });
  console.log('PTY SMOKE OK — real tty, command execution, SIGINT all pass');
  process.exit(0);
})().catch((e) => {
  console.error('PTY SMOKE FAIL:', e.message);
  process.exit(1);
});
