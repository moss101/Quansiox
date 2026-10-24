'use strict';
/** Shared browser tool protocol bits (host WebContentsView tabs + guest CDP). */

const KEYCODES = {
  enter: { code: 13, name: 'Enter' }, return: { code: 13, name: 'Enter' },
  tab: { code: 9, name: 'Tab' }, escape: { code: 27, name: 'Escape' },
  backspace: { code: 8, name: 'Backspace' }, delete: { code: 46, name: 'Delete' },
  space: { code: 32, name: ' ' }, arrowup: { code: 38, name: 'ArrowUp' },
  arrowdown: { code: 40, name: 'ArrowDown' }, arrowleft: { code: 37, name: 'ArrowLeft' },
  arrowright: { code: 39, name: 'ArrowRight' }, home: { code: 36, name: 'Home' },
  end: { code: 35, name: 'End' }, pageup: { code: 33, name: 'PageUp' },
  pagedown: { code: 34, name: 'PageDown' },
};
for (let i = 0; i < 26; i += 1) {
  const ch = String.fromCharCode(97 + i);
  KEYCODES[ch] = { code: 65 + i, name: ch.toUpperCase() };
}
for (let i = 0; i < 10; i += 1) KEYCODES[String(i)] = { code: 48 + i, name: String(i) };
const MODBITS = { alt: 1, ctrl: 2, control: 2, meta: 4, command: 4, cmd: 4, shift: 8 };

function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('url required');
  if (/^(https?|about:blank)/i.test(raw)) return raw;
  if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(raw)) return `https://${raw}`;
  throw new Error('only http(s) URLs are allowed in the agent browser');
}

module.exports = { KEYCODES, MODBITS, normalizeUrl };
