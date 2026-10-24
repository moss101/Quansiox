'use strict';
/**
 * Guest computer-use — routes `computer_*` actions into the Linux guest desktop
 * (xdotool + X) instead of this Mac's GUI, via the VM's `exec` op. The desktop
 * guest ships xdotool + ImageMagick + xwd (vm/desktop-build.json); a screencap is
 * emitted as **base64** so binary pixels survive the guest's text protocol.
 *
 * The VM client (exec) is injected → command mapping + the base64 screencap
 * round-trip are unit-tested offline. Actually driving a live guest X is
 * hardware-gated (VZ boot, prototyped on a capable Mac). frameHash is a byte
 * hash of the PNG (coarse screen-change detector).
 */
const { frameHashFromBytes } = require('../../coordinator/freshness');

const int = (n) => Math.max(0, Math.round(Number(n) || 0));
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Map a computer_* tool to a guest shell command (null if it needs no mapping). */
function mapCommand(tool, args) {
  switch (tool) {
    case 'computer_click': return `xdotool mousemove ${int(args.x)} ${int(args.y)} click 1`;
    case 'computer_right_click': return `xdotool mousemove ${int(args.x)} ${int(args.y)} click 3`;
    case 'computer_type': return `xdotool type --delay 12 -- ${shq(String(args.text ?? ''))}`;
    case 'computer_key': return `xdotool key ${shq([...(args.modifiers || []), args.key].filter(Boolean).join('+'))}`;
    case 'computer_scroll': { const btn = String(args.deltaY ?? 0).startsWith('-') ? 5 : 4; return `xdotool mousemove ${int(args.x)} ${int(args.y)} click ${btn}`; }
    case 'computer_move': return `xdotool mousemove ${int(args.x)} ${int(args.y)}`;
    default: return null;
  }
}

const SCREENSHOT_CMD = 'import -silent -window root png:- 2>/dev/null | base64 -w0; if [ ${PIPESTATUS[0]:-1} -ne 0 ]; then xwd -root -silent | convert xwd:- png:- | base64 -w0; fi';

/** Capture the guest framebuffer as base64 → decode to PNG + frameHash. */
async function screencap(guest, sessionId) {
  const r = await guest.exec(sessionId, SCREENSHOT_CMD);
  if (r.exitCode !== 0) return { ok: false, error: r.output || 'guest screencap failed' };
  const b64 = (r.output || '').trim();
  let png;
  try { png = Buffer.from(b64, 'base64'); } catch { return { ok: false, error: 'screencap decode failed' }; }
  if (!png.length || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    return { ok: false, error: 'guest screencap did not return a PNG' };
  }
  return { ok: true, png, dataUrl: `data:image/png;base64,${b64}`, bytes: png.length, frameHash: frameHashFromBytes(b64) || null };
}

async function act(sessionId, tool, args, guest) {
  if (tool === 'computer_screenshot') { const s = await screencap(guest, sessionId); return s.ok ? { ok: true, dataUrl: s.dataUrl, bytes: s.bytes, frameHash: s.frameHash, screenChanged: true } : s; }
  const cmd = mapCommand(tool, args);
  if (!cmd) return { ok: false, error: `guest computer does not support ${tool}` };
  const r = await guest.exec(sessionId, cmd);
  const shot = await screencap(guest, sessionId); // effect verification
  return { ok: r.exitCode === 0, exitCode: r.exitCode, output: (r.output || '').slice(0, 4000), frameHash: shot.ok ? shot.frameHash : null, dataUrl: shot.ok ? shot.dataUrl : undefined, screenChanged: shot.ok };
}

module.exports = { guestComputerService: { act, mapCommand, screencap } };
