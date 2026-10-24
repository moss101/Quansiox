'use strict';
/**
 * Webhook service — loopback webhook receiver for automations. Wraps the generic
 * `webhookServer` and wires it to `automationService.runByWebhook` (token-verified
 * local run), and injects the URL builder so `automationService.webhookToken(id)`
 * and this service's `webhookUrl(id)` return a real, callable URL. Main-only.
 *
 * API (kept compatible with the original automation-webhook surface):
 *   ensureStarted() -> port, webhookUrl(id) -> { url, id }, stop().
 */
const { webhookServer } = require('./webhookServer');

let wired = false;
function dispatch(id, token) {
  const { automationService } = require('./automationService');
  return automationService.runByWebhook(id, token)
    .then((r) => ({ id, status: r.status, summary: r.summary ?? '' }))
    .catch((error) => {
      const e = new Error(String(error?.message ?? error));
      if (/unknown automation/.test(e.message)) e.status = 404;
      else if (/invalid webhook token|no webhook/.test(e.message)) e.status = 403;
      throw e;
    });
}
function wire() {
  if (wired) return;
  wired = true;
  webhookServer.start(dispatch);
  const { automationService } = require('./automationService');
  automationService.setUrlBuilder((id, token) => webhookServer.urlFor(id, token));
}
async function ensureStarted() {
  wire();
  const base = await webhookServer.ensureStarted();
  return Number(base.split(':').pop());
}
async function webhookUrl(id) {
  wire();
  await webhookServer.ensureStarted();
  const { automationService } = require('./automationService');
  const cred = automationService.webhookToken(id);
  return { url: cred.url, id };
}
function base() { return webhookServer.baseUrl(); }
function stop() { const { automationService } = require('./automationService'); automationService.setUrlBuilder(null); webhookServer.stop(); wired = false; }

module.exports = { webhookService: { ensureStarted, webhookUrl, base, stop, baseUrl: () => webhookServer.baseUrl(), start: ensureStarted } };
