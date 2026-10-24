'use strict';
/* Quansiox service smoke test — stubs electron, runs a mock SSE provider,
 * and exercises agentService.run end-to-end (tool call -> tool result -> final). */
const Module = require('node:module');
const http = require('node:http');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- stub electron (fresh temp userData per run) ----
const sent = [];
const fakeSender = { id: 1, isDestroyed: () => false, send: (ch, route, ...a) => sent.push([route, ...a]) };
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quansiox-smoke-'));
process.env.QUANSIOX_TEST_USERDATA = testRoot;
// The forked coordinator process resolves services through this env var.
process.env.QUANSIOX_USER_DATA_DIR = testRoot;
// This suite is the no-Jev path. A key in the parent environment must not
// reroute tools away from the assertions below.
delete process.env.TYPESAFE_API_KEY;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return require.resolve('./stub-electron.js');
  return origResolve.call(this, request, ...rest);
};

// mock provider: turn 1 = shell tool call, turn 2 = final; turns 3/4 = MCP round
let turn = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/latest.json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: feedVersion, url: 'https://example.com/dl', notes: 'big release' }));
    return;
  }
  if (req.method === 'GET' && req.url.endsWith('/latest-bad.json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: '1.0.0' })); // missing url
    return;
  }
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    assert(req.headers.authorization === 'Bearer test-key', 'models auth header');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-1' }, { id: 'mock-2' }] }));
    return;
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    assert(req.headers.authorization === 'Bearer test-key', 'auth header');
    const payload = JSON.parse(body);
    // Compaction summarize call: non-stream, marker prompt -> JSON summary.
    if (payload.max_tokens === 1000 && String(payload.messages?.[0]?.content ?? '').startsWith('Summarize this conversation')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'COMPACT-SUMMARY: user built a thing; a.txt created.' } }] }));
      return;
    }
    assert(payload.stream === true, 'streaming requested');
    if (expect429Once) {
      expect429Once = false; // fail the first attempt only
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    lastPromptMessages = payload.messages;
    payloadToolsCache.push((payload.tools ?? []).map((t) => t.function.name));
    if (expectAttachmentTurn) {
      const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user');
      assert(Array.isArray(lastUser.content), 'multimodal content array');
      assert(lastUser.content[0].type === 'text' && lastUser.content[0].text === 'read this file');
      assert(lastUser.content.some((p) => p.type === 'text' && p.text.includes('hello from file')), 'attachment text inlined');
      assert(lastUser.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')), 'image attachment inlined');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'got it' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    turn += 1;
    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (expectSandboxTurn) {
      expectSandboxTurn = false;
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sb', function: { name: sandboxTool, arguments: JSON.stringify(sandboxArgs) } }] } }] });
    } else if (expectComputerTurn) {
      expectComputerTurn = false;
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: computerCallId, function: { name: computerTool, arguments: JSON.stringify(computerArgs) } }] } }] });
    } else if (turn === 1) {
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"comm' } }] } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"echo hello-quansiox"}' } }] } }] });
    } else if (turn === 2) {
      // verify the tool result made it into history
      const toolMsg = payload.messages.find((m) => m.role === 'tool');
      assert(toolMsg && toolMsg.content.includes('hello-quansiox'), 'tool result in history');
      sse({ choices: [{ delta: { content: 'All ' } }] });
      sse({ choices: [{ delta: { content: 'done.' } }] });
    } else if (turn === 3) {
      // MCP tool must be offered to the model
      const names = (payload.tools ?? []).map((t) => t.function.name);
      assert(names.includes('mcp__adder__add'), `mcp tool offered: ${names.join(',')}`);
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'mcp__adder__add', arguments: '{"a":2,"b":3}' } }] } }] });
    } else if (turn === 4) {
      const toolMsg = payload.messages.find((m) => m.role === 'tool');
      assert(toolMsg && toolMsg.content === '5', `mcp result in history: ${toolMsg?.content}`);
      sse({ choices: [{ delta: { content: '2 + 3 = 5' } }] });
    } else if (turn === 5) {
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_3', function: { name: 'update_plan', arguments: '{"steps":[{"title":"Do it","status":"in_progress"},{"title":"Verify","status":"pending"}]}' } }] } }] });
    } else if (turn === 6) {
      const planMsg = payload.messages.filter((m) => m.role === 'tool').at(-1);
      assert(planMsg && planMsg.content === 'plan updated and shown to the user', `plan ack in history: ${planMsg?.content}`);
      sse({ choices: [{ delta: { content: 'planned' } }] });
    } else {
      // generic later turns (checkpoint phase): plain final answer
      sse({ choices: [{ delta: { content: 'ok' } }] });
    }
    const finish = () => {
      res.write('data: [DONE]\n\n');
      // usage chunk (arrives with empty choices, like real providers)
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 7 } })}\n\n`);
      res.end();
    };
    if (holdStreamMs > 0) {
      const held = holdStreamMs;
      holdStreamMs = 0;
      setTimeout(finish, held);
      return;
    }
    finish();
  });
});

// mock for attachment turn: last user message must be multimodal content
let expectAttachmentTurn = false;
let lastPromptMessages = null;
let expect429Once = false;
let expectComputerTurn = false;
let expectSandboxTurn = false;
let computerTool = 'computer_list_apps';
let computerCallId = 'call_cu';
let computerArgs = {};
let sandboxTool = 'shell';
let sandboxArgs = {};
const payloadToolsCache = [];
let feedVersion = '0.0.0';
let holdStreamMs = 0; // when >0, delay the stream end to hold runs open

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const root = path.join(os.tmpdir(), 'quansiox-test-ws');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const { settingsService } = require('../src/main/services/settingsService');
  settingsService.save({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'mock-1', workspaceRoot: root, maxSteps: 5 });

  const { agentService } = require('../src/main/services/agentService');
  const { sessionService } = require('../src/main/services/sessionService');
  const { fileService } = require('../src/main/services/fileService');

  const fakeEvent = { sender: fakeSender };
  const sessionId = 'test-session-1';
  const result = await agentService.run(fakeEvent, { sessionId, message: 'echo test' });
  assert.deepStrictEqual(result, { ok: true, steps: 2 }, 'run result');
  const doneEvent = sent.find(([r]) => r === 'agent:onDone');
  assert.match(String(doneEvent?.[2]?.assistantId ?? ''), /^msg_/, 'onDone carries the final assistant turn id (reply/reaction targeting)');

  const deltas = sent.filter(([r]) => r === 'agent:onDelta').map(([, , d]) => d).join('');
  assert(deltas === 'All done.', `streamed deltas: ${JSON.stringify(deltas)}`);
  const toolCall = sent.find(([r]) => r === 'agent:onToolCall');
  assert(toolCall[2].name === 'shell' && toolCall[2].args.command === 'echo hello-quansiox');
  const toolResult = sent.find(([r]) => r === 'agent:onToolResult');
  assert(toolResult[2].output.includes('hello-quansiox'), 'shell tool executed');

  const session = sessionService.get(sessionId);
  assert(session.turns.length === 4, `turns: ${session.turns.length}`); // user, assistant(tool_calls), tool, assistant(final)
  assert(session.turns[0].role === 'user');
  assert(sessionService.list().length === 1);

  const tree = fileService.tree();
  assert(tree.root === root && Array.isArray(tree.entries));
  fs.writeFileSync(path.join(root, 'probe.txt'), 'x');
  assert(fileService.tree().entries.some((e) => e.path === 'probe.txt'));
  assert(fileService.read('probe.txt') === 'x');

  // ---- phase 2: MCP tool server ----
  const { mcpService } = require('../src/main/services/mcpService');
  settingsService.save({
    mcpServers: [{ name: 'adder', command: process.execPath, args: [path.join(__dirname, 'mcp-add-server.js')] }],
  });
  const statuses = await mcpService.reloadAll();
  assert(statuses[0].status === 'ready', `mcp status: ${statuses[0].status}`);
  assert.deepStrictEqual(statuses[0].tools, ['add']);
  const specs = mcpService.toolSpecs();
  assert(specs.length === 1 && specs[0].function.name === 'mcp__adder__add');
  assert(specs[0].function.parameters.properties.a.type === 'number', 'schema converted');
  assert.strictEqual(await mcpService.callTool('mcp__adder__add', { a: 2, b: 3 }), '5');

  // Agent round-trip through the MCP tool.
  const result2 = await agentService.run(fakeEvent, { sessionId: 'test-session-2', message: 'add 2 and 3' });
  assert.deepStrictEqual(result2, { ok: true, steps: 2 });
  const mcpCall = sent.filter(([r]) => r === 'agent:onToolCall').find(([, , c]) => c.name === 'mcp__adder__add');
  assert(mcpCall, 'mcp tool call event emitted');
  const mcpResult = sent.filter(([r]) => r === 'agent:onToolResult').find(([, , r2]) => r2.name === 'mcp__adder__add');
  assert(mcpResult[2].output === '5', `mcp tool result: ${mcpResult[2].output}`);
  await mcpService.stopServer('adder');

  // ---- phase 2b: update_plan tool -> live checklist events ----
  const planRun = await agentService.run(fakeEvent, { sessionId: 'test-session-plan', message: 'plan something' });
  assert.deepStrictEqual(planRun, { ok: true, steps: 2 }, 'plan run steps');
  const planEvents = sent.filter(([r]) => r === 'agent:onPlan');
  assert(planEvents.length === 1, 'onPlan emitted once');
  assert.deepStrictEqual(planEvents[0][2], [
    { title: 'Do it', status: 'in_progress' },
    { title: 'Verify', status: 'pending' },
  ], 'plan steps normalized');
  const planSession = sessionService.get('test-session-plan');
  const planTurn = planSession.turns.find((t) => t.name === 'update_plan');
  assert(planTurn && JSON.parse(planTurn.content).length === 2, 'plan persisted in transcript');

  // ---- phase 3: settings.test + attachments ----
  const { allHandlers } = require('../src/main/ipc/registry');
  require('../src/main/ipc/namespaces');
  const testResult = await allHandlers.settings.test(
    { sender: fakeSender },
    { baseUrl: `http://127.0.0.1:${port}/v1`, useSaved: true }
  );
  assert(testResult.ok && testResult.count === 2, `settings.test: ${JSON.stringify(testResult)}`);
  assert.deepStrictEqual(testResult.models, ['mock-1', 'mock-2']);

  expectAttachmentTurn = true;
  const result3 = await agentService.run(fakeEvent, {
    sessionId: 'test-session-3',
    message: 'read this file',
    attachments: [
      { name: 'notes.txt', mimeType: 'text/plain', text: 'hello from file' },
      { name: 'pic.png', mimeType: 'image/png', data: Buffer.from('fakepng').toString('base64') },
    ],
  });
  assert.deepStrictEqual(result3, { ok: true, steps: 1 });
  const stored = sessionService.get('test-session-3').turns[0].content;
  assert(Array.isArray(stored) && stored.length === 3, 'attachment turn persisted as parts');

  // ---- phase 4: rename + retry (multimodal content preserved) ----
  sessionService.rename('test-session-3', 'Renamed');
  assert.strictEqual(sessionService.get('test-session-3').title, 'Renamed');
  assert(sessionService.list().some((s) => s.title === 'Renamed'), 'rename visible in list');

  // sidebar management: update flags + duplicate
  const flags = sessionService.update('test-session-3', { pinned: true, muted: true });
  assert.deepStrictEqual(
    { pinned: flags.pinned, hidden: flags.hidden, muted: flags.muted },
    { pinned: true, hidden: false, muted: true },
    'update sets flags'
  );
  const listed3 = sessionService.list().find((s) => s.id === 'test-session-3');
  assert(listed3.pinned === true && listed3.muted === true, 'flags visible in list');
  sessionService.update('test-session-3', { hidden: true });
  assert(sessionService.list().find((s) => s.id === 'test-session-3').hidden === true, 'hide flags in list');
  sessionService.update('test-session-3', { hidden: false, pinned: false, muted: false });
  const dup = sessionService.duplicate('test-session-3');
  assert.strictEqual(dup.title, 'Renamed (copy)', 'duplicate titles with (copy)');
  assert(dup.id !== 'test-session-3', 'duplicate gets a new id');
  const dupSession = sessionService.get(dup.id);
  assert.strictEqual(dupSession.turns.length, 2, 'duplicate copies the transcript');
  assert(dupSession.pinned !== true && dupSession.hidden !== true && dupSession.muted !== true, 'duplicate clears flags');
  assert.strictEqual(sessionService.get('test-session-3').title, 'Renamed', 'source unchanged by duplicate');
  sessionService.remove(dup.id);

  expectAttachmentTurn = true; // retry sends the same multimodal content
  const retryResult = await agentService.retry(fakeEvent, { sessionId: 'test-session-3' });
  assert.deepStrictEqual(retryResult, { ok: true, steps: 1 }, 'retry run');
  const retried = sessionService.get('test-session-3').turns;
  assert(retried.length === 2, `retry truncated + re-ran: ${retried.length} turns`);
  assert(Array.isArray(retried[0].content), 'retry preserved multimodal user turn');
  assert.strictEqual(retried[1].content, 'got it');
  // retrying a session with no user turn must throw cleanly
  sessionService.ensure('empty-session-x');
  await assert.rejects(() => agentService.retry(fakeEvent, { sessionId: 'empty-session-x' }), /nothing to retry/);

  // ---- phase 5: git service + agent checkpoints ----
  const { gitService } = require('../src/main/services/gitService');
  const { execFileSync } = require('node:child_process');
  const gitCfg = (args) => execFileSync('git', args, { cwd: root });
  gitCfg(['init', '--quiet']);
  gitCfg(['config', 'user.email', 'test@quansiox']);
  gitCfg(['config', 'user.name', 'Quansiox Test']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'v1\n');
  gitCfg(['add', '-A']);
  gitCfg(['commit', '-m', 'init', '--quiet']);

  // dirty the tree -> checkpoint must commit it before the agent runs
  fs.writeFileSync(path.join(root, 'base.txt'), 'v2\n');
  fs.writeFileSync(path.join(root, 'scratch.txt'), 'new\n');
  expectAttachmentTurn = false; // turn counter: mock answers '2 + 3 = 5' generically; fine
  const cpEvent = { sender: fakeSender };
  await agentService.run(cpEvent, { sessionId: 'test-session-4', message: 'modify things' });
  const cpEvents = sent.filter(([r]) => r === 'agent:onCheckpoint');
  assert(cpEvents.length === 1 && cpEvents[0][2].hash, 'checkpoint event emitted');

  const st1 = await gitService.status();
  assert(st1.repo && st1.entries.length === 0, `tree clean after checkpoint: ${st1.entries.length}`);
  const logNow = await gitService.log(5);
  assert(logNow.some((c) => c.subject.includes('quansiox checkpoint')), `checkpoint in log: ${logNow[0].subject}`);

  // status/diff/stage/discard round-trip
  fs.writeFileSync(path.join(root, 'base.txt'), 'v3\n');
  const st2 = await gitService.status();
  assert(st2.entries.some((e) => e.path === 'base.txt' && (e.worktree === 'M' || e.index === 'M')), 'dirty file detected');
  const d = await gitService.diff({ pathspec: 'base.txt' });
  assert(d.includes('-v2') && d.includes('+v3'), 'diff content');
  await gitService.discard(['base.txt']);
  assert((await gitService.status()).entries.length === 0, 'discard restored file');
  fs.writeFileSync(path.join(root, 'stage-me.txt'), 's\n');
  await gitService.stage(['stage-me.txt']);
  const stStaged = await gitService.status();
  assert(stStaged.entries[0].index === 'A', 'staged as A');
  const hash = await gitService.commit('manual commit');
  assert(/^[0-9a-f]{7,}$/.test(hash), `commit hash ${hash}`);
  assert((await gitService.status()).entries.length === 0, 'clean after commit');

  // checkpoint with clean tree -> skipped
  await agentService.run(cpEvent, { sessionId: 'test-session-4', message: 'clean run' });
  const cp2 = sent.filter(([r]) => r === 'agent:onCheckpoint');
  assert(cp2.length === 1, 'no duplicate checkpoint on clean tree');

  // ---- phase 6: markdown export ----
  const md = sessionService.toMarkdown('test-session-3');
  assert(md.includes('# Renamed'), 'markdown title');
  assert(md.includes('## 🧑 You') && md.includes('read this file'), 'user turn');
  assert(md.includes('## 🤖 Quansiox') && md.includes('got it'), 'assistant turn');
  const mdTools = sessionService.toMarkdown('test-session-1');
  assert(mdTools.includes('🔧') && mdTools.includes('hello-quansiox'), 'tool calls in markdown');

  // ---- phase 7: usage accounting + history window ----
  const s1 = sessionService.get('test-session-1');
  assert.deepStrictEqual(
    { p: s1.usage.promptTokens, c: s1.usage.completionTokens, r: s1.usage.requests },
    { p: 200, c: 14, r: 2 },
    `usage accumulated: ${JSON.stringify(s1.usage)}`
  );

  // Build a long transcript, cap the window, verify provider payload shape.
  sessionService.ensure('test-session-long');
  for (let i = 0; i < 15; i += 1) {
    sessionService.appendTurn('test-session-long', { role: 'user', content: `q${i}` });
    sessionService.appendTurn('test-session-long', { role: 'assistant', content: `a${i}` });
  }
  settingsService.save({ historyWindowTurns: 8 });
  await agentService.run(fakeEvent, { sessionId: 'test-session-long', message: 'final q' });
  const msgs = lastPromptMessages;
  assert(msgs.length <= 9, `history capped: ${msgs.length} messages`);
  assert(msgs[0].role === 'system', 'system prompt kept');
  assert(msgs[1].role === 'user', `window starts at user turn, got ${msgs[1].role}: ${msgs[1].content?.slice(0, 20)}`);

  // ---- phase 8: custom system prompt injected ----
  settingsService.save({ systemPromptExtra: 'Always answer in Turkish.' });
  await agentService.run(fakeEvent, { sessionId: 'test-session-sys', message: 'hi' });
  assert(
    lastPromptMessages[0].content.includes('Always answer in Turkish.'),
    'systemPromptExtra appended to system prompt'
  );
  settingsService.save({ systemPromptExtra: '' });
  await agentService.run(fakeEvent, { sessionId: 'test-session-sys', message: 'hi again' });
  assert(
    !lastPromptMessages[0].content.includes('Turkish'),
    'system prompt extra cleared'
  );

  // ---- phase 9: provider retry (429 + Retry-After) + concurrency guard ----
  expect429Once = true;
  const retryRun = await agentService.run(fakeEvent, { sessionId: 'test-session-retry', message: 'retry me' });
  assert.deepStrictEqual(retryRun, { ok: true, steps: 1 }, 'run survives 429');
  const retryEvents = sent.filter(([r]) => r === 'agent:onRetry');
  assert(retryEvents.length === 1 && retryEvents[0][2].status === 429, 'onRetry event emitted');

  // Two messages on one busy session: the second queues behind the first and
  // runs after it settles (docs: a message sent while the bot is working is
  // answered after the current turn) — with onQueued/onRunStart bookkeeping.
  holdStreamMs = 600; // hold run #1 open deterministically
  const first = agentService.run(fakeEvent, { sessionId: 'test-session-lock', message: 'first', messageId: 'lock-1' });
  await new Promise((r) => setTimeout(r, 150)); // let the run register
  assert(agentService.isRunning('test-session-lock'), 'session busy while first runs');
  const second = agentService.run(fakeEvent, { sessionId: 'test-session-lock', message: 'second', messageId: 'lock-2' });
  const queuedEvents = sent.filter(([r]) => r === 'agent:onQueued');
  assert.strictEqual(queuedEvents.length, 1, 'onQueued emitted for the queued message');
  assert.strictEqual(queuedEvents[0][1], 'test-session-lock', 'onQueued carries the session id');
  assert.deepStrictEqual(queuedEvents[0][2], { messageId: 'lock-2', position: 1 }, 'onQueued carries messageId + position');
  assert.deepStrictEqual(await first, { ok: true, steps: 1 }, 'first run completes');
  assert.deepStrictEqual(await second, { ok: true, steps: 1 }, 'queued run runs after the first');
  const dequeued = sent.find(([r, , info]) => r === 'agent:onRunStart' && info?.messageId === 'lock-2');
  assert.ok(dequeued, 'onRunStart emitted for the dequeued message');
  assert.strictEqual(dequeued[2].dequeued, true, 'onRunStart marks the dequeue');
  assert.strictEqual(agentService.isRunning('test-session-lock'), false, 'queue drained');

  // ---- phase 10: prompt library ----
  const saved = await allHandlers.prompts.save(fakeEvent, { body: 'Refactor the auth module and add tests', title: 'Refactor' });
  assert(saved.id && saved.title === 'Refactor', 'prompt saved');
  await allHandlers.prompts.save(fakeEvent, { body: 'second template' }); // auto-title from body
  let list = await allHandlers.prompts.list(fakeEvent);
  assert(list.length === 2 && list[0].title === 'second template'.slice(0, 40), 'auto-title, newest first');
  const updated = await allHandlers.prompts.save(fakeEvent, { id: saved.id, title: 'Refactor v2', body: 'Refactor harder' });
  list = await allHandlers.prompts.list(fakeEvent);
  assert(list.length === 2 && list.some((p) => p.title === 'Refactor v2'), 'update in place');
  await assert.rejects(() => allHandlers.prompts.save(fakeEvent, { body: '   ' }), /empty prompt body/);
  await allHandlers.prompts.remove(fakeEvent, { id: updated.id });
  assert((await allHandlers.prompts.list(fakeEvent)).length === 1, 'remove works');

  // ---- phase 11: cost estimation ----
  const { pricingService } = require('../src/main/services/pricingService.js');
  // gpt-4o-mini prefix matching: 1M prompt + 0.5M completion tokens
  let est = pricingService.estimate('gpt-4o-mini-2024-07-18', { promptTokens: 1_000_000, completionTokens: 500_000 });
  assert(Math.abs(est.cost - (1 * 0.15 + 0.5 * 0.6)) < 1e-9, `builtin rates: ${est.cost}`);
  assert(est.rates.matched === 'gpt-4o-mini', 'longest-prefix match');
  // vendor path prefix stripped
  est = pricingService.estimate('openrouter/openai/gpt-4o', { promptTokens: 1_000_000, completionTokens: 0 });
  assert(Math.abs(est.cost - 2.5) < 1e-9, 'vendor prefix stripped');
  // custom override wins over builtin
  settingsService.save({ customPricing: { 'gpt-4o': { input: 1, output: 2 } } });
  est = pricingService.estimate('gpt-4o', { promptTokens: 2_000_000, completionTokens: 1_000_000 });
  assert(Math.abs(est.cost - 4) < 1e-9 && est.rates.custom, `custom rates: ${JSON.stringify(est)}`);
  // unknown model -> null
  assert.strictEqual(pricingService.estimate('mystery-model-x', { promptTokens: 100 }), null);
  // session cost handler (uses lastModel recorded by addUsage)
  sessionService.addUsage('test-session-1', { prompt_tokens: 1_000_000, completion_tokens: 0 }, 'gpt-4o');
  const sessionCost = await allHandlers.sessions.cost(fakeEvent, { id: 'test-session-1' });
  assert(
    sessionCost && Math.abs(sessionCost.cost - sessionCost.cost) === 0 && sessionCost.cost > 0.999 && sessionCost.cost < 1.01,
    `session cost ~1: ${JSON.stringify(sessionCost)}`
  );
  settingsService.save({ customPricing: {} });

  // ---- phase 12: context compaction ----
  sessionService.ensure('test-session-compact');
  const filler = 'x'.repeat(4000); // ~1k tokens per turn
  for (let i = 0; i < 14; i += 1) {
    sessionService.appendTurn('test-session-compact', { role: 'user', content: `q${i} ${filler}` });
    sessionService.appendTurn('test-session-compact', { role: 'assistant', content: `a${i} ${filler}` });
  }
  settingsService.save({ compactThresholdTokens: 5000 });
  await agentService.run(fakeEvent, { sessionId: 'test-session-compact', message: 'continue' });
  const compacted = sessionService.get('test-session-compact');
  assert(compacted.compaction, 'compaction stored');
  assert(compacted.compaction.summary.includes('COMPACT-SUMMARY'), 'summary from provider');
  assert(compacted.compaction.cutoff > 0 && compacted.compaction.cutoff < 28, `cutoff on boundary: ${compacted.compaction.cutoff}`);
  // provider payload: system + summary + kept slice (much smaller than full)
  const msgs2 = lastPromptMessages;
  assert(msgs2[1].role === 'user' && msgs2[1].content.includes('COMPACT-SUMMARY'), 'summary injected after system');
  assert(!msgs2.some((m) => typeof m.content === 'string' && m.content.includes('q0 ')), 'old turns excluded');
  assert(msgs2.some((m) => typeof m.content === 'string' && m.content === 'continue'), 'new turn kept');
  // transcript preserved on disk for export
  assert(compacted.turns.length === 30, `full transcript kept: ${compacted.turns.length}`);
  settingsService.save({ compactThresholdTokens: 60_000 });

  // ---- phase 13: update checker ----
  const { updaterService } = require('../src/main/services/updaterService.js');
  assert.strictEqual(updaterService.compareSemver('0.1.0', '0.2.0'), -1);
  assert.strictEqual(updaterService.compareSemver('1.2.3', '1.2.3'), 0);
  assert.strictEqual(updaterService.compareSemver('2.0.0', '1.99.99'), 1);
  assert.strictEqual(updaterService.compareSemver('1.0.0-rc.1', '1.0.0'), 0, 'prerelease ignored');
  // disabled feed
  const disabled = await updaterService.check();
  assert(disabled.enabled === false && /^\d+\.\d+\.\d+$/.test(disabled.current), 'disabled without feed');
  // live feed: newer version available
  settingsService.save({ updateFeedUrl: `http://127.0.0.1:${port}/latest.json` });
  feedVersion = '99.0.0';
  let upd = await updaterService.check();
  assert(upd.enabled && upd.updateAvailable && upd.latest === '99.0.0', `update detected: ${JSON.stringify(upd)}`);
  assert(upd.url === 'https://example.com/dl' && upd.notes === 'big release');
  // same version -> up to date
  feedVersion = upd.current;
  upd = await updaterService.check();
  assert(upd.enabled && !upd.updateAvailable, 'up to date');
  // malformed feed -> clean error
  settingsService.save({ updateFeedUrl: `http://127.0.0.1:${port}/latest-bad.json` });
  await assert.rejects(() => updaterService.check(), /malformed|update feed/);
  settingsService.save({ updateFeedUrl: '' });

  // ---- phase 14: file editing ----
  const w = fileService.write('edited/hello.txt', 'line one\nline two');
  assert(w.bytes > 0, 'write reports bytes');
  assert(fileService.read('edited/hello.txt') === 'line one\nline two', 'write/read round-trip');
  fileService.write('edited/hello.txt', 'overwritten');
  assert(fileService.read('edited/hello.txt') === 'overwritten', 'overwrite works');
  assert(fileService.tree().entries.some((e) => e.path === 'edited/hello.txt'), 'new file in tree');
  assert.throws(() => fileService.write('../escape.txt', 'nope'), /escapes workspace/);
  assert.throws(() => fileService.write('big.txt', 'x'.repeat(2_000_001)), /too large/);
  const wr = await allHandlers.file.write(fakeEvent, { path: 'edited/via-ipc.txt', content: 'ipc' });
  assert(wr.bytes === 3 && (await allHandlers.file.read(fakeEvent, { path: 'edited/via-ipc.txt' })) === 'ipc', 'ipc write/read');

  // ---- phase 15: provider profiles ----
  const prof = await allHandlers.profiles.saveCurrent(fakeEvent, { name: 'Mock Local' });
  assert(prof.id && prof.name === 'Mock Local', 'profile saved from current');
  let plist = await allHandlers.profiles.list(fakeEvent);
  assert(plist.length === 1 && plist[0].hasKey === true, 'key presence flagged, key never listed');
  assert(!JSON.stringify(plist).includes('test-key'), 'api key redacted from list');
  const prof2 = await allHandlers.profiles.save(fakeEvent, { name: 'Backup', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'bk-key', model: 'other-1' });
  plist = await allHandlers.profiles.list(fakeEvent);
  assert(plist.length === 2, 'two profiles');
  // activate switches live settings
  const act = await allHandlers.profiles.activate(fakeEvent, { id: prof2.id });
  assert(act.model === 'other-1', 'activate returns target');
  assert(settingsService.load().model === 'other-1' && settingsService.load().apiKey === 'bk-key', 'live settings switched');
  // list marks the active profile
  plist = await allHandlers.profiles.list(fakeEvent);
  assert(plist.find((p) => p.id === prof2.id).active === true, 'active flag');
  // update with redacted placeholder keeps the stored key
  await allHandlers.profiles.save(fakeEvent, { id: prof2.id, name: 'Backup2', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'bk…key1', model: 'other-2' });
  assert(settingsService.load().profiles.find((p) => p.id === prof2.id).apiKey === 'bk-key', 'redacted placeholder preserves key');
  // restore mock settings for cleanliness
  await allHandlers.profiles.activate(fakeEvent, { id: prof.id });
  await allHandlers.profiles.remove(fakeEvent, { id: prof2.id });
  assert((await allHandlers.profiles.list(fakeEvent)).length === 1, 'remove profile');
  await assert.rejects(() => allHandlers.profiles.activate(fakeEvent, { id: 'nope' }), /profile not found/);

  // ---- phase 16: session stats ----
  const stats = await allHandlers.sessions.stats(fakeEvent, { id: 'test-session-1' });
  assert(stats.turns > 0 && stats.userMessages >= 1, 'turn counts');
  assert(stats.toolCalls >= 1 && stats.toolCounts.shell >= 1, 'tool counts aggregated');
  assert(stats.usage.requests > 0, 'usage present');
  assert(typeof stats.estimatedCost === 'number', 'cost estimated');
  assert(typeof stats.createdAt === 'number' && typeof stats.updatedAt === 'number', 'timestamps');
  // files written via write_file are surfaced
  fs.writeFileSync(path.join(root, 'wtest.txt'), 'x');
  sessionService.ensure('test-session-stats');
  sessionService.appendTurn('test-session-stats', { role: 'user', content: 'go' });
  sessionService.appendTurn('test-session-stats', { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out/a.txt', content: 'hi' }) } }] });
  sessionService.appendTurn('test-session-stats', { role: 'tool', tool_call_id: 'c9', name: 'write_file', content: 'wrote 2 bytes' });
  const stats2 = await allHandlers.sessions.stats(fakeEvent, { id: 'test-session-stats' });
  assert.deepStrictEqual(stats2.filesTouched, ['out/a.txt'], 'files written surfaced');

  // ---- phase 17: computer use ----
  const cuToolResult = (id) => sent.filter(([r]) => r === 'agent:onToolResult').find(([, , x]) => x.id === id);

  // disabled by default -> clean refusal
  expectComputerTurn = true; computerTool = 'computer_list_apps'; computerCallId = 'call_cu1';
  await agentService.run(fakeEvent, { sessionId: 'test-session-cu', message: 'list apps' });
  let cuRes = cuToolResult('call_cu1');
  assert(cuRes && /disabled/.test(cuRes[2].output), `disabled guard: ${cuRes?.[2]?.output}`);

  // enabled -> tools offered to the model, call executes (may hit permission errors here)
  settingsService.save({ allowComputerUse: true });
  expectComputerTurn = true; computerTool = 'computer_list_apps'; computerCallId = 'call_cu2';
  await agentService.run(fakeEvent, { sessionId: 'test-session-cu', message: 'list apps again' });
  const names = lastPromptMessages && (payloadToolsCache.at(-1) || []);
  cuRes = cuToolResult('call_cu2');
  assert(cuRes, 'enabled computer call produced a tool result');
  assert(/Quansiox|\[|"|error|ACCESSIBILITY|not allowed/i.test(cuRes[2].output), `result text: ${String(cuRes[2].output).slice(0, 80)}`);

  // screenshot flow: image attached as follow-up user turn
  expectComputerTurn = true; computerTool = 'computer_screenshot'; computerCallId = 'call_cu3';
  await agentService.run(fakeEvent, { sessionId: 'test-session-cu', message: 'screenshot' });
  const cuSession = sessionService.get('test-session-cu');
  const shotTurn = cuSession.turns.find((t) => t.kind === 'screenshot');
  assert(shotTurn && Array.isArray(shotTurn.content), 'screenshot turn persisted as multimodal');
  assert(shotTurn.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png')), 'image data url present');
  const shotEvents = sent.filter(([r]) => r === 'agent:onScreenshot');
  assert(shotEvents.length === 1 && shotEvents[0][2].dataUrl.startsWith('data:image/png'), 'onScreenshot event');
  settingsService.save({ allowComputerUse: false });

  // ---- phase 18: sandbox computer ----
  const sbToolResult = () => sent.filter(([r]) => r === 'agent:onToolResult').filter(([, , x]) => x.id === 'call_sb').at(-1);

  // shell runs INSIDE the session sandbox (pwd proves it)
  expectSandboxTurn = true; sandboxTool = 'shell'; sandboxArgs = { command: 'pwd && echo SANDBOX-OK' };
  await agentService.run(fakeEvent, { sessionId: 'test-session-sb', message: 'run in sandbox' });
  let sb = sbToolResult();
  assert(sb && sb[2].output.includes('SANDBOX-OK'), 'sandbox shell executed');
  assert(sb[2].output.includes(`.quansiox/sandboxes/test-session-sb`), `pwd is sandbox root: ${sb[2].output.slice(0, 120)}`);
  assert(sb[2].output.includes('(sandbox:'), 'sandbox note attached');
  const computerNotes = sent.filter(([route, id]) => route === 'sandbox:onStatus' && id === 'test-session-sb');
  assert(computerNotes.length >= 2, `computer status published when the run starts and ends: ${computerNotes.length}`);

  // files written land inside the sandbox; escape is rejected
  expectSandboxTurn = true; sandboxTool = 'write_file'; sandboxArgs = { path: 'notes/in-sandbox.txt', content: 'hello sandbox' };
  await agentService.run(fakeEvent, { sessionId: 'test-session-sb', message: 'write file' });
  sb = sbToolResult();
  assert(/wrote 13 bytes .*\(in sandbox\)/.test(sb[2].output), `sandbox write: ${sb[2].output}`);
  assert(fs.existsSync(path.join(root, '.quiox-sandbox-check')) === false, 'host untouched');
  assert(fs.existsSync(path.join(root, '.quansiox/sandboxes/test-session-sb/notes/in-sandbox.txt')), 'file in sandbox root');

  const { sandboxService } = require('../src/main/services/sandboxService.js');
  const sbStatus = sandboxService.status();
  assert(sbStatus.some((x) => x.sessionId === 'test-session-sb' && x.status === 'ready'), `supervisor tracks sandbox: ${JSON.stringify(sbStatus)}`);

   // host fallback when sandboxMode=off
   settingsService.save({ sandboxMode: 'off' });
   expectSandboxTurn = true; sandboxTool = 'shell'; sandboxArgs = { command: 'pwd' };
   await agentService.run(fakeEvent, { sessionId: 'test-session-sb', message: 'run on host' });
   sb = sbToolResult();
   assert(!sb[2].output.includes('(sandbox:'), 'host mode has no sandbox note');

   // ---- auto-review rules settle the approval gate without a prompt ----
   // (no IPC in tests, so an interactive prompt would refuse — the allow rule
   // must carry the call, the block rule must refuse it up front.)
   settingsService.save({
     requireApproval: true,
     autoReviewInstructions: { isEnabled: true, allowInstructions: ['echo hello-quansiox'], blockInstructions: [] },
   });
   expectSandboxTurn = true; sandboxTool = 'shell'; sandboxArgs = { command: 'echo hello-quansiox' };
   await agentService.run(fakeEvent, { sessionId: 'test-session-sb', message: 'auto-review allow' });
   sb = sbToolResult();
   assert(sb[2].output.includes('hello-quansiox'), `auto-review allow skips the prompt: ${sb[2].output}`);

   settingsService.save({
     autoReviewInstructions: { isEnabled: true, allowInstructions: [], blockInstructions: ['echo'] },
   });
   expectSandboxTurn = true; sandboxTool = 'shell'; sandboxArgs = { command: 'echo hello-quansiox' };
   await agentService.run(fakeEvent, { sessionId: 'test-session-sb', message: 'auto-review block' });
   sb = sbToolResult();
   assert(/blocked by an auto-review rule/.test(sb[2].output), `auto-review block refuses: ${sb[2].output}`);

   settingsService.save({
     requireApproval: false,
     autoReviewInstructions: { isEnabled: false, allowInstructions: [], blockInstructions: [] },
   });
   settingsService.save({ sandboxMode: 'sandboxed' });
  await sandboxService.stop('test-session-sb');

  // ---- phase 19: freshness tokens on computer actions ----
  settingsService.save({ allowComputerUse: true });
  const cuResultAt = (id) => sent.filter(([r]) => r === 'agent:onToolResult').filter(([, , x]) => x.id === id).at(-1);

  // 1. click before any screenshot -> SCREENSHOT_REQUIRED
  expectComputerTurn = true; computerTool = 'computer_click'; computerCallId = 'tk1'; computerArgs = { x: 10, y: 10 };
  await agentService.run(fakeEvent, { sessionId: 'test-session-tokens', message: 'click' });
  let tk = cuResultAt('tk1');
  assert(tk && /SCREENSHOT_REQUIRED|invalid or stale/.test(tk[2].output), `no/stale-token refusal: ${tk?.[2]?.output?.slice(0, 80)}`);

  // 2. screenshot issues a coordinate_token
  expectComputerTurn = true; computerTool = 'computer_screenshot'; computerCallId = 'tk2'; computerArgs = {};
  await agentService.run(fakeEvent, { sessionId: 'test-session-tokens', message: 'shot' });
  const shotNote = sent.filter(([r]) => r === 'agent:onToolResult').find(([, , x]) => x.id === 'tk2')[2].output;
  const tokenMatch = /coordinate_token=(ct-[0-9a-f]+)/.exec(shotNote);
  assert(tokenMatch, `token in screenshot note: ${shotNote.slice(0, 100)}`);

  // 3. wrong token -> stale refusal
  expectComputerTurn = true; computerTool = 'computer_click'; computerCallId = 'tk3';
  computerArgs = { x: 10, y: 10, coordinate_token: 'ct-wrong' };
  await agentService.run(fakeEvent, { sessionId: 'test-session-tokens', message: 'click bad' });
  tk = cuResultAt('tk3');
  assert(tk && /invalid or stale/.test(tk[2].output), `stale refusal: ${tk?.[2]?.output?.slice(0, 80)}`);

  // 4. fresh token passes validation (then hits real osascript; under this
  //    sandbox that surfaces as a permission error — but NOT a refusal)
  expectComputerTurn = true; computerTool = 'computer_click'; computerCallId = 'tk4';
  computerArgs = { x: 10, y: 10, coordinate_token: tokenMatch[1] };
  await agentService.run(fakeEvent, { sessionId: 'test-session-tokens', message: 'click good' });
  tk = cuResultAt('tk4');
  assert(tk && !/SCREENSHOT_REQUIRED|invalid or stale/.test(tk[2].output), `valid token proceeds: ${tk?.[2]?.output?.slice(0, 80)}`);
  assert(/clicked|error|ACCESSIBILITY|not allowed/i.test(tk[2].output), 'executed or permission-blocked, not refused');
  settingsService.save({ allowComputerUse: false });

  // Sandbox startup failure must never turn a run/retry into raw host execution.
  const { sandboxService: failedSandbox } = require('../src/main/services/sandboxService');
  const realEnsure = failedSandbox.ensure;
  try {
    failedSandbox.ensure = async () => { throw new Error('fixture VM unavailable'); };
    await assert.rejects(agentService.run(fakeEvent, { sessionId: 'failed-sandbox-run', message: 'write something' }), /Session sandbox could not start: fixture VM unavailable/);
    await assert.rejects(agentService.retry(fakeEvent, { sessionId: 'failed-sandbox-retry' }), /Session sandbox could not start: fixture VM unavailable/);
    assert.equal(agentService.isRunning('failed-sandbox-run'), false);
    assert.equal(agentService.isRunning('failed-sandbox-retry'), false);
    failedSandbox.ensure = async () => ({ status: 'failed: startup timeout' });
    await assert.rejects(agentService.run(fakeEvent, { sessionId: 'failed-sandbox-state', message: 'write something' }), /sandbox is failed: startup timeout/);
  } finally {
    failedSandbox.ensure = realEnsure;
  }

  console.log('SMOKE OK — streaming, tools, sessions, files, MCP, settings.test, attachments, rename/retry, sidebar flags/duplicate, git, export, usage+window, sysprompt, retry+lock, prompts, cost, compaction, updates, file-edit, profiles, stats, computer-use, sandbox, auto-review, tokens all pass');
  server.close();
  process.exit(0);
});
