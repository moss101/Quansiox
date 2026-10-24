'use strict';
/* Provider engine — protocol detection, request shaping (Anthropic system
 * split + prompt caching, Gemini, Responses) and event parsing, plus a live
 * Anthropic-SSE round-trip through the coordinator. Electron-free. */
const Module = require('node:module');
const http = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-providers-'));
process.env.QUANSIOX_USER_DATA_DIR = testRoot;
process.env.QUANSIOX_TEST_USERDATA = testRoot;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return require.resolve('./stub-electron.js');
  return origResolve.call(this, request, ...rest);
};

const p = require('../src/coordinator/providers');

// --- 1. detection -----------------------------------------------------------
assert.equal(p.detectProvider('https://api.openai.com/v1', 'gpt-4o').id, 'openai-chat');
assert.equal(p.detectProvider('https://api.anthropic.com/v1', 'claude-3-5-sonnet').id, 'anthropic');
assert.equal(p.detectProvider('https://generativelanguage.googleapis.com/v1beta', 'gemini-1.5-pro').id, 'gemini');
assert.equal(p.detectProvider('http://127.0.0.1:11434', 'llama3').id, 'ollama');
assert.equal(p.detectProvider('http://localhost:1234', 'qwen').id, 'lmstudio');
assert.equal(p.detectProvider('https://api.openai.com/v1', 'gpt-5', { apiStyle: 'responses' }).id, 'openai-responses');
assert.equal(p.detectProvider('http://127.0.0.1:9', 'x', { provider: 'anthropic' }).id, 'anthropic', 'explicit provider wins');
assert.equal(p.detectProvider(null, 'm').id, 'openai-chat', 'defaults to OpenAI chat');
assert.equal(p.detectProvider('http://127.0.0.1:11434', 'x').baseUrl, 'http://127.0.0.1:11434/v1', 'ollama gets /v1');

// --- 2. Anthropic request: system split + prompt caching + tools ------------
const anth = p.detectProvider('https://api.anthropic.com/v1', 'claude-x');
const areq = p.buildRequest(anth, {
  model: 'claude-x',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'shell', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'ok' },
  ],
  tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }],
  max_tokens: 128,
}, { apiKey: 'k-anthropic' });
assert.equal(areq.url, 'https://api.anthropic.com/v1/messages');
assert.equal(areq.headers['x-api-key'], 'k-anthropic');
assert.equal(areq.headers.authorization, undefined, 'anthropic uses x-api-key, not bearer');
assert.equal(areq.payload.system[0].cache_control.type, 'ephemeral', 'system prompt cached');
assert.equal(areq.payload.messages.length, 3, 'system message removed from messages');
assert.equal(areq.payload.messages[1].content[0].type, 'tool_use', 'assistant tool_calls → tool_use block');
assert.equal(areq.payload.messages[2].content[0].type, 'tool_result', 'tool role → tool_result block');
assert.equal(areq.payload.tools[0].input_schema.type, 'object', 'tools converted to input_schema');
assert.equal(areq.payload.max_tokens, 128);

// --- 3. Gemini + Responses request shapes ----------------------------------
const gem = p.detectProvider('https://generativelanguage.googleapis.com/v1beta', 'gemini-1.5-pro');
const greq = p.buildRequest(gem, { model: 'gemini-1.5-pro', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] }, { apiKey: 'g' });
assert.match(greq.url, /models\/gemini-1\.5-pro:streamGenerateContent\?alt=sse$/);
assert.equal(greq.headers['x-goog-api-key'], 'g');
assert.equal(greq.payload.tools[0].functionDeclarations[0].name, 'f');
assert.equal(greq.payload.contents[0].role, 'user');

const resp = p.detectProvider('https://api.openai.com/v1', 'gpt-5', { apiStyle: 'responses' });
const rreq = p.buildRequest(resp, { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] }, { apiKey: 'sk' });
assert.equal(rreq.url, 'https://api.openai.com/v1/responses');
assert.equal(rreq.payload.tools[0].type, 'function');
assert.equal(rreq.payload.input[0].content, 'hi');

// --- 4. event parsing per family -------------------------------------------
assert.deepEqual(p.parseEvent(anth, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }).deltaText, 'hi');
assert.equal(p.parseEvent(anth, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } }).reasoning, 'hmm');
assert.equal(p.parseEvent(anth, { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }).toolCalls[0].args, '{"a":1}');
assert.equal(p.parseEvent(anth, { type: 'message_delta', usage: { input_tokens: 3, output_tokens: 4 } }).usage.total_tokens, 7);
assert.equal(p.parseEvent(gem, { candidates: [{ content: { parts: [{ text: 'yo' }] } }] }).deltaText, 'yo');
assert.equal(p.parseEvent(gem, { candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { x: 1 } } }] } }] }).toolCalls[0].name, 'f');
assert.equal(p.parseEvent(p.detectProvider('https://api.openai.com/v1', 'g'), { choices: [{ delta: { reasoning_content: 'r' } }] }).reasoning, 'r');
assert.equal(p.parseEvent(p.detectProvider('https://api.openai.com/v1', 'g'), { choices: [{ delta: { content: 'c' } }] }).deltaText, 'c');
assert.equal(p.parseFull(anth, { content: [{ type: 'text', text: 'full' }], usage: { input_tokens: 1, output_tokens: 2 } }).message.content, 'full');

// --- 5. live round-trip: Anthropic SSE through the coordinator -------------
const { settingsService } = require('../src/main/services/settingsService');
const seen = { headers: null, payload: null };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.headers = req.headers;
    seen.payload = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (obj) => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    for (const piece of ['Hel', 'lo ', 'Anthropic']) send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
    send({ type: 'message_delta', usage: { output_tokens: 7 } });
    send({ type: 'message_stop' });
    res.end();
  });
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  settingsService.save({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'k-anthropic',
    provider: 'anthropic',
    model: 'claude-test',
    workspaceRoot: testRoot,
    maxSteps: 3,
    mcpServers: [],
    allowComputerUse: false,
    notifyOnDone: false,
  });

  const { agentService } = require('../src/main/services/agentService');
  const events = [];
  const sender = { id: 1, isDestroyed: () => false, send: (channel, route, ...args) => events.push([route, ...args]) };
  process.env.QUANSIOX_TEST_USERDATA = testRoot;
  const result = await agentService.run({ sender }, { sessionId: 'prov-anthropic', message: 'say hi' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(seen.headers['x-api-key'], 'k-anthropic');
  assert.equal(seen.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.payload.stream, true);
  assert.ok(Array.isArray(seen.payload.system) && seen.payload.system[0].cache_control, 'cached system prompt sent');
  const deltas = events.filter(([route]) => route === 'agent:onDelta').map(([, , text]) => text).join('');
  assert.equal(deltas, 'Hello Anthropic', `streamed deltas: ${JSON.stringify(deltas)}`);
  const { sessionService } = require('../src/main/services/sessionService');
  const turns = sessionService.get('prov-anthropic').turns ?? [];
  assert.ok(turns.some((t) => t.role === 'assistant' && /Hello Anthropic/.test(String(t.content))), 'assistant turn persisted');

  // unknown/reasoning events must not break the loop
  assert.equal(result.ok, true);
  server.close();
  console.log('providers test: ALL OK (detection + request shaping + parse + Anthropic SSE round-trip)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
