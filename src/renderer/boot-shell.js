'use strict';
/* Grok-parity pre-boot splash (P1.5): visible from first paint until the
 * renderer mounts, so there is never a white flash before the theme
 * applies. Pure DOM — this runs before any module and before the
 * stylesheet is guaranteed, so inline geometry only; the colors resolve
 * from the token cascade once styles.css lands. main.jsx removes the
 * node on mount. */
(function () {
  if (document.getElementById('qx-boot-shell')) return;
  var shell = document.createElement('div');
  shell.id = 'qx-boot-shell';
  shell.setAttribute('aria-hidden', 'true');
  var mark = document.createElement('div');
  mark.className = 'qx-boot-mark';
  mark.textContent = 'Q';
  var bar = document.createElement('div');
  bar.className = 'qx-boot-bar';
  bar.appendChild(document.createElement('span'));
  shell.appendChild(mark);
  shell.appendChild(bar);
  document.body.appendChild(shell);
})();
