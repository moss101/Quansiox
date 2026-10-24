'use strict';
/**
 * Slack connector (real) — talks to the Slack Web API over HTTPS with a
 * user-supplied bot token stored in the encrypted secrets vault (never in
 * settings). Transport (fetch) + base URL are injectable, so it's testable
 * offline against a mock without faking responses in production.
 *
 * Real prerequisite (flagged, not faked): the user creates a Slack app, adds a
 * bot token, and stores it as a secret (e.g. secret name `slack.bot_token`,
 * scope '*').
 */
const DEFAULT_BASE = 'https://slack.com/api';

let baseUrl = DEFAULT_BASE;
let fetchImpl = (...a) => fetch(...a);
function setTransport({ baseUrl: b, fetch: f } = {}) { if (b) baseUrl = b; if (f) fetchImpl = f; }

const SECRET_NAME = 'slack_bot_token';

function resolveToken() {
  const { settingsService } = require('./settingsService');
  const { secretsService } = require('./secretsService');
  const name = settingsService.load().slackTokenSecret || SECRET_NAME;
  const rec = secretsService.get(name);
  const fields = rec?.fields || {};
  const token = fields.token || fields.value || Object.values(fields)[0];
  return token ? String(token) : null;
}

async function status() {
  const token = resolveToken();
  if (!token) return { configured: false, hint: `store your Slack bot token as a secret (secret ${SECRET_NAME})` };
  try {
    const r = await api('auth.test', {});
    return { configured: true, team: r.team, user: r.user, bot: r.bot_id };
  } catch (error) {
    return { configured: true, error: String(error?.message ?? error) };
  }
}

/** Call a Slack Web API method. Throws the real Slack error (no fake success). */
async function api(method, body = {}) {
  const token = resolveToken();
  if (!token) throw new Error('slack not configured — store the bot token as a secret');
  const res = await fetchImpl(`${baseUrl}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { throw new Error(`slack ${method}: non-JSON response (${res.status})`); }
  if (!json.ok) throw new Error(`slack ${method}: ${json.error || `HTTP ${res.status}`}`);
  return json;
}

function chatPostMessage({ channel, text, thread_ts } = {}) {
  if (!channel || !text) throw new Error('chatPostMessage needs channel + text');
  return api('chat.postMessage', { channel, text, ...(thread_ts ? { thread_ts } : {}) });
}
function conversationsList({ types = 'public_channel,private_channel', limit = 100 } = {}) {
  return api('conversations.list', { types, limit }).then((r) => (r.channels || []).map((c) => ({ id: c.id, name: c.name, is_member: c.is_member, num_members: c.num_members })));
}
function conversationsHistory({ channel, limit = 30 } = {}) {
  if (!channel) throw new Error('conversationsHistory needs a channel');
  return api('conversations.history', { channel, limit }).then((r) => (r.messages || []).map((m) => ({ ts: m.ts, user: m.user, text: m.text, thread_ts: m.thread_ts })));
}
function usersList() { return api('users.list', {}).then((r) => (r.members || []).map((u) => ({ id: u.id, name: u.name, real_name: u.real_name }))); }

module.exports = { slackService: { status, api, chatPostMessage, conversationsList, conversationsHistory, usersList, setTransport, SECRET_NAME } };
