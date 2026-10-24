'use strict';
/**
 * Vault → browser login. Fills a login form from the encrypted local vault
 * without ever putting the password in the transcript or in agent-visible
 * tool output: the value is read in the main process and injected straight
 * into the page through the browser's JS evaluation.
 *
 * Selection: an explicit credential id, otherwise the vault credential whose
 * `sites` match the page origin.
 */
const { browserService } = require('./browserService');
const { secretsService } = require('./secretsService');

function originOf(url) {
  try { return new URL(String(url)).origin; } catch { return null; }
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

/** Build the in-page fill script (values embedded here, in the main process). */
function fillScript({ username, password, submit = false }) {
  return `(() => {
  const setValue = (el, value) => {
    if (!el) return false;
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc && desc.set ? desc.set.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  };
  const inputs = [...document.querySelectorAll('input')].filter((el) => el.type !== 'hidden' && !el.disabled && el.offsetParent !== null);
  const pw = document.querySelector('input[type="password"]') || inputs.find((el) => /pass/i.test(el.name + el.id + el.autocomplete));
  const user = inputs.find((el) => el !== pw && /user|email|login|account|phone/i.test(el.name + el.id + el.type + el.autocomplete)) || inputs.find((el) => el !== pw && (el.type === 'text' || el.type === 'email' || el.type === 'tel'));
  const filledUser = ${username ? 'setValue(user, ' + JSON.stringify(username) + ')' : 'false'};
  const filledPass = ${password ? 'setValue(pw, ' + JSON.stringify(password) + ')' : 'false'};
  let submitted = false;
  ${submit ? `
  const form = (pw && pw.form) || (user && user.form);
  const button = document.querySelector('button[type="submit"], input[type="submit"], form button');
  if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); submitted = true; }
  else if (button) { button.click(); submitted = true; }` : ''}
  return JSON.stringify({ filledUser, filledPass, submitted, host: location.hostname });
})()`;
}

/**
 * Fill credentials on the active tab of a browser session.
 * @returns {Promise<{filled:boolean, reason?:string, credential?:object, fields?:string[]}>}
 */
async function fillCredentials(sessionId, { credentialId, username, submit = false, url } = {}, driver = browserService) {
  if (!sessionId) throw new Error('sessionId is required');
  const { vaultService } = require('./vaultService');
  const pageUrl = url || await driver.act(sessionId, 'js', { code: 'location.href' });
  if (!pageUrl || typeof pageUrl !== 'string' || !originOf(pageUrl)) {
    return { filled: false, reason: 'no http(s) page is open in this browser session' };
  }
  const cred = credentialId ? vaultService.internalCredentialById(credentialId) : vaultService.credentialForOrigin(pageUrl);
  if (!cred) {
    return {
      filled: false,
      reason: `no vault credential matches ${hostOf(pageUrl)} — add one in Settings → Vault (or pass credentialId)`,
    };
  }
  const stored = secretsService.get(cred.secretName) || null;
  const password = stored?.fields?.password || '';
  const user = username || cred.username || stored?.fields?.username || '';
  if (!password && !user) return { filled: false, reason: `vault credential "${cred.title}" has no stored password`, credential: { id: cred.id, title: cred.title } };

  const raw = await driver.act(sessionId, 'js', { code: fillScript({ username: user, password, submit: submit === true }) });
  let parsed = null;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* page returned something odd */ }
  if (!parsed || (!parsed.filledUser && !parsed.filledPass)) {
    return { filled: false, reason: 'no login fields found on this page', credential: { id: cred.id, title: cred.title } };
  }
  const fields = [];
  if (parsed.filledUser) fields.push('username');
  if (parsed.filledPass) fields.push('password');
  try { require('./diagnosticsService').diagnosticsService.record('vault', { action: 'browser-fill', credentialId: cred.id, host: parsed.host }); } catch {}
  return { filled: true, credential: { id: cred.id, title: cred.title, username: user }, fields, submitted: parsed.submitted === true };
}

module.exports = { browserCredentialsService: { fillCredentials, fillScript, originOf } };
