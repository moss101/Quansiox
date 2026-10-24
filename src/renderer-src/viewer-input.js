'use strict';
/* Pure input helpers for the noVNC screen viewer (no DOM / no RFB import, so
 * they can be unit-tested with node). */

const SUPER_L = 0xffeb;
const KEYSYM = { Delete: 0xffff, Tab: 0xff09, Escape: 0xff1b, Return: 0xff0d };
const CHORD_KEYS = {
  ControlLeft: [0xffe3, 'ControlLeft'],
  AltLeft: [0xffe9, 'AltLeft'],
  ShiftLeft: [0xffe1, 'ShiftLeft'],
  SuperLeft: [SUPER_L, 'MetaLeft'],
  Delete: [KEYSYM.Delete, 'Delete'],
  Tab: [KEYSYM.Tab, 'Tab'],
  Escape: [KEYSYM.Escape, 'Escape'],
};

/** Send arbitrary text as key press/release pairs (IME mode, clipboard paste). */
function sendText(rfb, text) {
  if (!rfb || typeof rfb.sendKey !== 'function') return 0;
  let sent = 0;
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a || cp === 0x0d) {
      rfb.sendKey(KEYSYM.Return, 'Enter', true);
      rfb.sendKey(KEYSYM.Return, 'Enter', false);
      sent += 1;
      continue;
    }
    rfb.sendKey(cp, null, true);
    rfb.sendKey(cp, null, false);
    sent += 1;
  }
  return sent;
}

/** Press a chord: modifiers down in order, keys up in reverse. */
function sendChord(rfb, keys = []) {
  if (!rfb || typeof rfb.sendKey !== 'function') return false;
  const resolved = keys.map((k) => CHORD_KEYS[k]).filter(Boolean);
  for (const [sym, code] of resolved) rfb.sendKey(sym, code, true);
  for (const [sym, code] of resolved.slice().reverse()) rfb.sendKey(sym, code, false);
  return resolved.length > 0;
}

/** Translate a macOS Cmd+<key> press into Super+<key> for the Linux guest. */
function metaChord(rfb, key) {
  if (!rfb || typeof rfb.sendKey !== 'function' || !key) return false;
  rfb.sendKey(SUPER_L, 'MetaLeft', true);
  if (key.length === 1) {
    const cp = key.codePointAt(0);
    rfb.sendKey(cp, null, true);
    rfb.sendKey(cp, null, false);
  }
  rfb.sendKey(SUPER_L, 'MetaLeft', false);
  return true;
}

module.exports = { sendText, sendChord, metaChord, SUPER_L, KEYSYM, CHORD_KEYS };
