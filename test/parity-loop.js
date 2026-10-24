'use strict';
/* Parity loop: subagents, skill replay, freshness, and Jev composition.
 * Mocks only the chat-completions SSE peer, the TypeSafe HTTP stand-in,
 * and the OS/helper edges (Electron desktopCapturer, browser CDP, replay host).
 * Decision, scheduler, permission, freshness, and Jev composition run for real. */
const Module = require('node:module');
const http = require('node:http');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

delete process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_BASE;

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quansiox-parity-'));
process.env.QUANSIOX_USER_DATA_DIR = testRoot;
process.env.QUANSIOX_TEST_USERDATA = testRoot;

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return require.resolve('./stub-electron-parity.js');
  return origResolve.call(this, request, ...rest);
};

const SECRET = 'SECRET_PARENT_TRANSCRIPT_9f3a';

const {
  prepareChildJob,
  planTeam,
  SubagentScheduler,
  DEFAULT_CAP,
  SUBAGENT_TYPES,
} = require('../src/coordinator/subagents');
const { guardTool } = require('../src/coordinator/permissions');
const { SkillRecorder, writeArtifact, replayArtifact } = require('../src/coordinator/skill-recording');
const {
  FreshnessGate,
  frameHashFromBgra,
  STALE_COORDINATE,
  STALE_PAGE_MISMATCH,
} = require('../src/coordinator/freshness');
const { sessionService } = require('../src/main/services/sessionService');
const { settingsService } = require('../src/main/services/settingsService');
const { skillRecordingService } = require('../src/main/services/skillRecordingService');
const {
  judgeTurn,
  composeJudgments,
  JEV_MODEL,
  turnQuestions,
} = require('../src/coordinator/jev');
const { dispatchTask, executeTool, run } = require('../src/coordinator/index');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bgraFrame(seed) {
  const data = Buffer.alloc(9 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (seed + i) % 255;
    data[i + 1] = 30;
    data[i + 2] = 70;
    data[i + 3] = 255;
  }
  return data;
}

(async () => {
  assert.deepStrictEqual(SUBAGENT_TYPES, ['general', 'explore', 'shell', 'browser', 'computer-use']);
  assert.strictEqual(DEFAULT_CAP, 32);
  assert.strictEqual(new SubagentScheduler({ runChild: async () => ({}) }).cap, 32);

  const parentId = 'parent-parity';
  sessionService.ensure(parentId);
  sessionService.appendTurn(parentId, { role: 'user', content: SECRET });
  sessionService.appendTurn(parentId, { role: 'assistant', content: `${SECRET} reply` });

  const child = prepareChildJob({
    type: 'explore',
    prompt: 'list the workspace files',
    description: 'list files',
    parentToolCallId: 'tc-parent-1',
  });
  const childBlob = JSON.stringify(child.messages);
  assert.strictEqual(child.messages.length, 2);
  assert.ok(child.messages.every((turn) => turn.role === 'system' || turn.role === 'user'));
  assert.ok(!childBlob.includes(SECRET), 'child prompt must exclude the parent transcript');
  assert.strictEqual(child.policy.permissionMode, 'read-only');
  assert.strictEqual(child.policy.fanOut, false);
  assert.strictEqual(child.parentToolCallId, 'tc-parent-1');

  let maxSeen = 0;
  let inFlight = 0;
  const capSched = new SubagentScheduler({
    cap: 2,
    runChild: async () => {
      inFlight += 1;
      maxSeen = Math.max(maxSeen, inFlight);
      await sleep(40);
      inFlight -= 1;
      return { summary: 'done', fileResults: [], aborted: false, errored: false };
    },
  });
  const handles = [1, 2, 3, 4].map((n) => capSched.start({
    ...prepareChildJob({ type: 'general', prompt: `task ${n}`, description: `task ${n}` }),
    background: true,
  }));
  const capResults = await Promise.all(handles.map((handle) => handle.done));
  assert.strictEqual(maxSeen, 2, 'parallel runs respect the cap');
  assert.ok(capResults.every((result) => result.aborted === false && result.errored === false));

  const abortSched = new SubagentScheduler({
    cap: 1,
    runChild: (_job, signal) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ summary: 'should-not-finish', fileResults: [], aborted: false, errored: false });
      }, 400);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve({ summary: '', fileResults: [], aborted: true, errored: false });
      }, { once: true });
    }),
  });
  const abortHandle = abortSched.start({
    ...prepareChildJob({ type: 'shell', prompt: 'sleep', description: 'sleep' }),
    background: true,
  });
  await sleep(15);
  abortSched.abort(abortHandle.id);
  const aborted = await abortHandle.done;
  assert.strictEqual(aborted.aborted, true);
  assert.strictEqual(aborted.userAborted, true);
  assert.strictEqual(aborted.errored, false);
  assert.strictEqual(aborted.subagentErrored, false);

  const custom = prepareChildJob({
    name: 'auditor',
    prompt: 'audit the tree',
    description: 'audit',
    customAgents: [{
      name: 'auditor',
      description: 'read only auditor',
      prompt: 'Read only.',
      tools: ['write_file', 'shell', 'computer_click', 'browser_click', 'read_file'],
      permissionMode: 'read-only',
    }],
  });
  assert.strictEqual(custom.type, 'custom');
  assert.strictEqual(custom.policy.permissionMode, 'read-only');
  const forbidden = path.join(testRoot, 'should-not-exist.txt');
  const writeRefusal = await executeTool(
    'write_file',
    { path: forbidden, content: 'nope' },
    testRoot,
    'child-ro',
    custom.policy,
  );
  assert.match(writeRefusal, /refused/);
  assert.strictEqual(fs.existsSync(forbidden), false, 'read-only custom subagent must not create a file');
  const shellRefusal = await executeTool(
    'shell',
    { command: 'echo hi > a.txt' },
    testRoot,
    'child-ro',
    custom.policy,
  );
  assert.match(shellRefusal, /mutating shell/);
  assert.strictEqual(fs.existsSync(path.join(testRoot, 'a.txt')), false);
  const listed = await executeTool('shell', { command: 'ls' }, testRoot, 'child-ro', custom.policy);
  assert.match(listed, /\[exit /);
  assert.match(guardTool('computer_click', { x: 1, y: 1 }, custom.policy), /cannot drive/);
  assert.match(guardTool('browser_click', { ref: 'e1' }, custom.policy), /cannot drive/);

  const closed = prepareChildJob({
    name: 'yolo',
    prompt: 'do it',
    customAgents: [{
      name: 'yolo',
      description: 'bad mode',
      prompt: 'no',
      tools: ['write_file'],
      permissionMode: 'yolo',
    }],
  });
  assert.strictEqual(closed.policy.permissionMode, 'read-only');
  assert.match(
    await executeTool('write_file', { path: forbidden, content: 'x' }, testRoot, 'child-yolo', closed.policy),
    /refused/,
  );

  const general = prepareChildJob({ type: 'general', prompt: 'edit readme', description: 'edit' });
  assert.match(guardTool('computer_screenshot', {}, general.policy), /refused/);
  assert.match(guardTool('browser_open', { url: 'https://example.com' }, general.policy), /refused/);
  assert.match(guardTool('computer_screenshot', {}, {
    permissive: false,
    permissionMode: 'workspace',
    allowlist: ['computer_screenshot', 'browser_open', 'write_file', 'shell'],
    enableComputer: false,
    enableBrowser: false,
    enableFileMutation: true,
    fanOut: false,
  }), /cannot drive/);
  const okFile = path.join(testRoot, 'ok.txt');
  const wrote = await executeTool(
    'write_file',
    { path: okFile, content: 'hi' },
    testRoot,
    'child-ws',
    general.policy,
  );
  assert.match(wrote, /^wrote /);
  assert.strictEqual(fs.readFileSync(okFile, 'utf8'), 'hi');

  const computerChild = prepareChildJob({ type: 'computer-use', prompt: 'click', description: 'click' });
  assert.strictEqual(guardTool('computer_screenshot', {}, computerChild.policy), null);
  assert.match(guardTool('browser_open', {}, computerChild.policy), /refused/);
  assert.match(guardTool('browser_open', {}, {
    permissive: false,
    permissionMode: 'computer',
    allowlist: ['browser_open', 'computer_screenshot'],
    enableComputer: true,
    enableBrowser: false,
    enableFileMutation: false,
    fanOut: false,
  }), /browser tools are gated off/);
  const browserChild = prepareChildJob({ type: 'browser', prompt: 'open', description: 'open' });
  assert.strictEqual(guardTool('browser_snapshot', {}, browserChild.policy), null);
  assert.match(guardTool('computer_click', {}, browserChild.policy), /refused/);
  assert.match(guardTool('computer_click', {}, {
    permissive: false,
    permissionMode: 'computer',
    allowlist: ['computer_click', 'browser_snapshot'],
    enableComputer: false,
    enableBrowser: true,
    enableFileMutation: false,
    fanOut: false,
  }), /computer tools are gated off/);
  assert.match(
    await executeTool('task', { prompt: 'nested' }, testRoot, parentId, {
      ...browserChild.policy,
      allowlist: [...browserChild.policy.allowlist, 'task'],
      depth: 2, // nested delegation caps at depth 2
    }),
    /depth limit/,
  );

  const progress = [];
  let seenMessages = null;
  const proofSched = new SubagentScheduler({
    cap: 2,
    onProgress: (row) => progress.push({ ...row }),
    runChild: async (job) => {
      seenMessages = job.messages;
      return { summary: 'listed three files', fileResults: ['notes.txt'], aborted: false, errored: false };
    },
  });
  const dispatched = JSON.parse(await dispatchTask(
    {
      subagent_type: 'explore',
      prompt: 'list the workspace files',
      description: 'list files',
      name: 'explore',
    },
    {
      sessionId: parentId,
      scheduler: proofSched,
      customAgents: [],
    },
  ));
  assert.ok(seenMessages, 'child run received messages');
  assert.ok(!JSON.stringify(seenMessages).includes(SECRET), 'dispatchTask child excludes parent transcript');
  assert.strictEqual(dispatched.summary, 'listed three files');
  assert.strictEqual(dispatched.aborted, false);
  assert.strictEqual(dispatched.errored, false);
  assert.strictEqual(dispatched.success, true);
  assert.ok(dispatched.id, 'scheduler assigns the child id');
  assert.ok(progress.some((row) => row.id === dispatched.id && row.type === 'explore' && row.title === 'list files'));
  assert.ok(progress.some((row) => row.status === 'running' || row.status === 'completed'));

  assert.strictEqual(planTeam('say hello'), null);
  assert.strictEqual(planTeam('please list files with a subagent'), null);
  const planned = planTeam('research NVIDIA, AMD, and Intel');
  assert.ok(planned);
  assert.strictEqual(planned.agents.length, 3);
  assert.strictEqual(planned.agents[0].subagent_type, 'browser');
  assert.match(planned.agents[1].prompt, /AMD/);
  const bulletTeam = planTeam('1. Read the auth module\n2. Run the tests');
  assert.strictEqual(bulletTeam.agents[0].subagent_type, 'explore');
  assert.strictEqual(bulletTeam.agents[1].subagent_type, 'shell');

  const teamRows = [];
  const teamSched = new SubagentScheduler({
    cap: 4,
    onProgress: (row) => teamRows.push({ ...row }),
    runChild: async (job) => {
      assert.ok(!JSON.stringify(job.messages).includes(SECRET));
      return { summary: `done ${job.title}`, fileResults: [], aborted: false, errored: false };
    },
  });
  const { dispatchTeam } = require('../src/coordinator/index');
  const teamRaw = await dispatchTeam({
    brief: 'Research chips',
    agents: [
      { description: 'Research NVIDIA', prompt: 'Research NVIDIA only', subagent_type: 'browser' },
      { description: 'Research AMD', prompt: 'Research AMD only', subagent_type: 'browser' },
    ],
  }, { sessionId: parentId, scheduler: teamSched, policy: { permissive: true } });
  const teamResult = JSON.parse(teamRaw);
  assert.strictEqual(teamResult.brief, 'Research chips');
  assert.strictEqual(teamResult.agents.length, 2);
  assert.ok(teamResult.agents.every((agent) => agent.success === true));
  assert.ok(teamRows.some((row) => row.team === 'Research chips' && row.title === 'Research NVIDIA'));
  assert.ok(teamRows.some((row) => row.team === 'Research chips' && row.title === 'Research AMD' && row.status === 'completed'));

  const recorder = new SkillRecorder();
  assert.strictEqual(recorder.state, 'idle');
  assert.strictEqual(recorder.prepare(), 'preparing');
  assert.strictEqual(recorder.begin(), 'recording');
  recorder.note({ kind: 'click', x: 12, y: 34 });
  recorder.note({ kind: 'type', text: 'hello' });
  assert.strictEqual(recorder.stop(), 'processing');
  const artifact = recorder.complete();
  assert.strictEqual(artifact.state, 'completed');
  const stored = writeArtifact(artifact, testRoot);
  const hostCalls = [];
  const replayPixels = bgraFrame(3);
  const replayGate = new FreshnessGate();
  const replayed = await replayArtifact(stored, replayGate, async (method, params) => {
    hostCalls.push({ method, params });
    if (method === 'screenshot') return { data: replayPixels, width: 9, height: 8 };
    return { ok: true };
  });
  const replayShot = replayed.actions.find((action) => action.tool === 'computer_screenshot');
  assert.strictEqual(replayShot.frameHash, frameHashFromBgra(replayPixels, 9, 8));
  assert.ok(replayed.actions.some((action) => action.tool === 'computer_click' && !action.refused));
  assert.ok(replayed.actions.some((action) => action.tool === 'computer_type'));
  assert.ok(hostCalls.some((call) => call.method === 'click'));
  assert.ok(hostCalls.some((call) => call.method === 'typeText'));
  const firstToken = replayShot.coordinate_token;
  replayGate.issueCoordinate(frameHashFromBgra(bgraFrame(4), 9, 8));
  assert.strictEqual(replayGate.requireCoordinate(firstToken), STALE_COORDINATE);

  const serviceHost = [];
  const servicePixels = bgraFrame(5);
  assert.strictEqual(skillRecordingService.status().state, 'idle');
  skillRecordingService.prepare();
  skillRecordingService.begin();
  skillRecordingService.note({ kind: 'click', x: 8, y: 9 });
  skillRecordingService.note({ kind: 'type', text: 'replay-me' });
  assert.strictEqual(skillRecordingService.stop().state, 'processing');
  const completed = skillRecordingService.complete();
  assert.strictEqual(completed.state, 'completed');
  const serviceReplay = await skillRecordingService.replay(completed.artifact.id, async (method) => {
    serviceHost.push(method);
    if (method === 'screenshot') return { data: servicePixels, width: 9, height: 8 };
    return { ok: true };
  });
  assert.strictEqual(
    serviceReplay.actions.find((action) => action.tool === 'computer_screenshot').frameHash,
    frameHashFromBgra(servicePixels, 9, 8),
  );
  assert.ok(serviceReplay.actions.some((action) => action.tool === 'computer_click' && !action.refused));
  assert.deepStrictEqual(serviceHost.filter((method) => method === 'click').length, 1);

  const { computerUseService: liveComputer } = require('../src/main/services/computerUseService');
  const stalePixels = bgraFrame(11);
  const newerPixels = bgraFrame(13);
  const liveGate = liveComputer.freshness;
  const staleIssued = liveGate.issueCoordinate(frameHashFromBgra(stalePixels, 9, 8));
  liveGate.issueCoordinate(frameHashFromBgra(newerPixels, 9, 8));
  const staleHost = [];
  const staleReplay = await replayArtifact({
    state: 'completed',
    steps: [{
      kind: 'click',
      x: 15,
      y: 25,
      coordinate_token: staleIssued.token,
      observe: { data: stalePixels, width: 9, height: 8 },
    }],
  }, liveGate, async (method) => {
    staleHost.push(method);
    return { ok: true };
  });
  const refusedClick = staleReplay.actions.find((action) => action.tool === 'computer_click');
  assert.strictEqual(refusedClick.refused, STALE_COORDINATE);
  assert.ok(!staleHost.includes('click'), 'stale coordinate token must not reach the host click');
  assert.strictEqual(
    staleReplay.actions.find((action) => action.tool === 'computer_screenshot').frameHash,
    frameHashFromBgra(stalePixels, 9, 8),
  );

  const cancelled = new SkillRecorder();
  cancelled.prepare();
  cancelled.begin();
  cancelled.note({ kind: 'scroll', x: 1, y: 1, deltaY: -3 });
  assert.strictEqual(cancelled.cancel(), 'cancelled');
  const cancelHost = [];
  const cancelledReplay = await replayArtifact(
    { state: 'cancelled', steps: [{ kind: 'click', x: 1, y: 1 }] },
    new FreshnessGate(),
    async () => { cancelHost.push('called'); },
  );
  assert.deepStrictEqual(cancelledReplay.actions, []);
  assert.strictEqual(cancelHost.length, 0);
  assert.match(cancelledReplay.error, /not replayable/);

  skillRecordingService.prepare();
  skillRecordingService.begin();
  const cancelStatus = skillRecordingService.cancel();
  assert.strictEqual(cancelStatus.state, 'cancelled');

  const failed = new SkillRecorder();
  failed.prepare();
  failed.begin();
  assert.strictEqual(failed.fail('disk'), 'error');
  assert.strictEqual(failed.state, 'error');

  const questions = turnQuestions();
  assert.strictEqual(questions.route.type, 'choice');
  assert.strictEqual(questions.allow_mutation.type, 'noul');
  assert.strictEqual(questions.subagent_fit.type, 'score');

  const systemoneBodies = [];
  let chatScript = 'plain';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/systemone') {
        systemoneBodies.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: JEV_MODEL,
          answers: {
            route: { type: 'choice', choice: 'computer', probabilities: { computer: 0.4, direct: 0.6 }, confidence: 0.2 },
            allow_mutation: { type: 'noul', noul: 0.1 },
            subagent_fit: { type: 'score', score: 0.4, legend: ['miss'], probabilities: { 0: 0.8 }, confidence: 0.5 },
          },
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const payload = raw ? JSON.parse(raw) : {};
        const blob = JSON.stringify(payload.messages || []);
        const childTurn = blob.includes('Quansiox subagent');
        const afterTool = blob.includes('"role":"tool"');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let delta;
        if (chatScript === 'delegate' && !childTurn && !afterTool) {
          delta = {
            tool_calls: [{
              index: 0,
              id: 'call_parent_9',
              type: 'function',
              function: {
                name: 'task',
                arguments: '{"subagent_type":"explore","prompt":"list the workspace files","description":"list files"}',
              },
            }],
          };
        } else if (childTurn) {
          delta = { content: 'listed the workspace' };
        } else {
          delta = { content: 'hello from parity' };
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.TYPESAFE_API_KEY = 'parity-stand-in';
  process.env.TYPESAFE_API_BASE = `http://127.0.0.1:${port}`;

  const judged = await judgeTurn({
    userMessage: 'click the save button',
    parentTask: 'save the document',
    subagentSummary: 'I opened a different app',
  });
  assert.strictEqual(systemoneBodies.length, 1, 'questions that share state go in one request');
  const body = systemoneBodies[0];
  assert.strictEqual(body.model, 'jev-1.13.0');
  assert.strictEqual(body.questions.route.type, 'choice');
  assert.strictEqual(body.questions.allow_mutation.type, 'noul');
  assert.strictEqual(body.questions.subagent_fit.type, 'score');
  assert.strictEqual(judged.skipped, false);
  assert.strictEqual(judged.model, 'jev-1.13.0');
  assert.strictEqual(judged.rawChoice, 'computer');
  assert.strictEqual(judged.route, 'direct');
  assert.strictEqual(judged.blockedDestructive, true);
  assert.strictEqual(judged.enableComputer, false);
  assert.strictEqual(judged.enableFileMutation, false);
  assert.strictEqual(judged.lowScore, true);
  assert.strictEqual(judged.success, false);

  const browserRoute = composeJudgments({
    route: { choice: 'browser', confidence: 0.91 },
    allow_mutation: { noul: 0.2 },
    subagent_fit: { score: 3.4, confidence: 0.8 },
  }, { summaryPresent: true });
  assert.strictEqual(browserRoute.blockedDestructive, false);
  assert.strictEqual(browserRoute.route, 'browser');
  assert.strictEqual(browserRoute.enableBrowser, true);
  assert.strictEqual(browserRoute.lowScore, false);
  assert.strictEqual(browserRoute.success, true);

  const filesBlocked = composeJudgments({
    route: { choice: 'files_shell', confidence: 0.95 },
    allow_mutation: { noul: 0.2 },
    subagent_fit: { score: 4, confidence: 1 },
  }, { summaryPresent: false });
  assert.strictEqual(filesBlocked.blockedDestructive, true);
  assert.strictEqual(filesBlocked.route, 'direct');
  assert.strictEqual(filesBlocked.enableFileMutation, false);
  assert.strictEqual(filesBlocked.lowScore, false);

  const skipped = await judgeTurn({ userMessage: 'hi' }, { apiKey: '' });
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(skipped.permissive, true);
  assert.strictEqual(systemoneBodies.length, 1, 'missing key does not call systemone');

  const lowRows = [];
  const lowSched = new SubagentScheduler({
    cap: 2,
    onProgress: (row) => lowRows.push({ ...row }),
    runChild: async () => ({
      summary: 'I opened a different app',
      fileResults: [],
      aborted: false,
      errored: false,
    }),
  });
  const lowResult = JSON.parse(await dispatchTask(
    { subagent_type: 'explore', prompt: 'save the document', description: 'save the document' },
    { sessionId: parentId, scheduler: lowSched, customAgents: [] },
  ));
  assert.strictEqual(lowResult.lowScore, true);
  assert.strictEqual(lowResult.success, false);
  const completedRow = lowRows.find((row) => row.status === 'completed');
  const lowRow = lowRows.find((row) => row.status === 'low_score');
  assert.ok(completedRow && completedRow.id);
  assert.ok(lowRow);
  assert.strictEqual(lowRow.id, completedRow.id);
  assert.strictEqual(lowRow.status, 'low_score');

  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_BASE;
  const hitsBeforeRun = systemoneBodies.length;
  settingsService.save({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'parity-mock',
    workspaceRoot: testRoot,
    maxSteps: 4,
    mcpServers: [],
    autoCheckpoint: false,
    compactThresholdTokens: 10_000_000,
    allowComputerUse: true,
    notifyOnDone: false,
  });
  const sent = [];
  const previousSend = process.send;
  const previousConnected = process.connected;
  process.send = (msg) => { sent.push(msg); };
  process.connected = true;
  chatScript = 'delegate';
  const linked = await run({ sessionId: 'link-parent', message: 'please list files with a subagent' });
  process.send = previousSend;
  process.connected = previousConnected;
  chatScript = 'plain';
  assert.strictEqual(linked.ok, true);
  const linkedRows = sent
    .filter((msg) => msg && msg.type === 'event' && msg.event === 'onSubagent')
    .map((msg) => msg.args[0]);
  assert.ok(
    linkedRows.some((row) => row.parentToolCallId === 'call_parent_9' && row.type === 'explore'),
    'run loop threads the parent tool-call id onto the child row',
  );

  // Auto-team: one user turn with several independent items becomes a named
  // team of children before the parent loop starts, then the parent synthesizes.
  const autoSent = [];
  process.send = (msg) => { autoSent.push(msg); };
  process.connected = true;
  const teamed = await run({ sessionId: 'team-auto-parent', message: 'research NVIDIA, AMD, and Intel' });
  process.send = previousSend;
  process.connected = previousConnected;
  assert.strictEqual(teamed.ok, true);
  const autoCalls = autoSent
    .filter((msg) => msg && msg.type === 'event' && msg.event === 'onToolCall')
    .map((msg) => msg.args[0]);
  assert.ok(
    autoCalls.some((call) => call?.id === 'team-auto' && call?.name === 'team' && call?.args?.agents?.length === 3),
    'a multi-item turn emits one team call with one agent per item',
  );
  const autoRows = autoSent
    .filter((msg) => msg && msg.type === 'event' && msg.event === 'onSubagent')
    .map((msg) => msg.args[0]);
  const teamBrief = 'research NVIDIA, AMD, and Intel';
  assert.strictEqual(
    autoRows.filter((row) => row?.team === teamBrief && row?.type === 'browser').length >= 3,
    true,
    'three browser children run under the named team',
  );
  assert.ok(autoRows.some((row) => row?.team === teamBrief && row?.status === 'completed'));
  const autoResults = autoSent
    .filter((msg) => msg && msg.type === 'event' && msg.event === 'onToolResult')
    .map((msg) => msg.args[0]);
  const teamToolResult = autoResults.find((res) => res?.id === 'team-auto');
  assert.ok(teamToolResult, 'team tool result is emitted back to the parent');
  const teamPayload = JSON.parse(teamToolResult.output);
  assert.strictEqual(teamPayload.brief, teamBrief);
  assert.strictEqual(teamPayload.agents.length, 3);
  assert.ok(teamPayload.agents.every((agent) => agent.success === true));
  const turn = await run({ sessionId: 'turn-nokey', message: 'say hello' });
  assert.strictEqual(turn.ok, true);
  assert.strictEqual(systemoneBodies.length, hitsBeforeRun, 'missing key skips Jev');
  const saved = sessionService.get('turn-nokey');
  assert.ok(saved.turns.some((item) => item.role === 'assistant' && String(item.content).includes('hello from parity')));

  settingsService.save({ allowComputerUse: true });
  const { computerUseService } = require('../src/main/services/computerUseService');
  const shot1 = await computerUseService.screenshot();
  assert.match(shot1.coordinateToken, /^ct-[0-9a-f]+$/);
  assert.match(shot1.frameHash, /^[0-9a-f]{16}$/);
  assert.ok(shot1.frameHash.length > 0);
  const shot2 = await computerUseService.screenshot();
  assert.notStrictEqual(shot2.coordinateToken, shot1.coordinateToken);
  const staleClick = await computerUseService.click({ x: 10, y: 20, coordinate_token: shot1.coordinateToken });
  assert.strictEqual(staleClick, STALE_COORDINATE);

  const { EventEmitter: EE } = { EventEmitter };
  void EE;
  const commands = [];
  let axTree = {
    nodes: [
      { nodeId: 1, backendDOMNodeId: 10, role: { value: 'button' }, name: { value: 'Save' }, childIds: [] },
    ],
  };
  function fakeWebContents() {
    const wc = new EventEmitter();
    wc.debugger = {
      attached: false,
      isAttached() { return this.attached; },
      attach() { this.attached = true; },
      detach() { this.attached = false; },
      async sendCommand(method, params) {
        commands.push({ method, params });
        if (method === 'Accessibility.getFullAXTree') return axTree;
        if (method === 'DOMSnapshot.captureSnapshot') {
          return {
            documents: [{
              nodes: { backendNodeId: [10] },
              layout: { nodeIndex: [0], bounds: [[0, 0, 80, 24]] },
            }],
          };
        }
        if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 40, 0, 40, 20, 0, 20] } };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
        return {};
      },
      on() {},
    };
    wc.getURL = () => 'https://example.com/page';
    wc.getTitle = () => 'Example';
    wc.isLoadingMainFrame = () => false;
    wc.loadURL = async () => { wc.emit('did-navigate'); };
    wc.capturePage = async () => ({ toDataURL: () => 'data:image/png;base64,AAAA', getSize: () => ({ width: 800, height: 600 }) });
    wc.setWindowOpenHandler = () => {};
    wc.close = () => {};
    return wc;
  }
  class FakeWebContentsView {
    constructor() {
      this.webContents = fakeWebContents();
    }
    setBounds() {}
    getBounds() { return null; }
  }
  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.contentView = { children: [], addChildView() {}, removeChildView() {} };
    }
    loadFile() {}
    getContentSize() { return [800, 600]; }
    setTitle() {}
    show() {}
    focus() {}
    isDestroyed() { return false; }
    close() {}
  }
  const stub = require('./stub-electron-parity.js');
  stub.__setWebContentsView(FakeWebContentsView);
  stub.__setBrowserWindow(FakeBrowserWindow);
  const { browserService } = require('../src/main/services/browserService');
  await browserService.open('parity-browser', { url: 'https://example.com' });
  browserService.attachWindow('parity-browser', new FakeBrowserWindow());
  const snap = await browserService.snapshot('parity-browser');
  const stalePage = await browserService.act('parity-browser', 'click', { ref: 'e1', snapshot_id: 'snap_old' });
  assert.strictEqual(stalePage.__browserError, 'STALE_PAGE');
  assert.match(stalePage.message, /STALE_PAGE/);
  assert.ok(stalePage.message.includes(STALE_PAGE_MISMATCH) || /snapshot_id is not the latest/.test(stalePage.message));
  const staleRef = await browserService.act('parity-browser', 'click', { ref: 'e99', snapshot_id: snap.snapshotId });
  assert.strictEqual(staleRef.__browserError, 'STALE_REF');
  assert.match(staleRef.message, /unknown ref e99/);
  void axTree;

  const rendererMain = fs.readFileSync(path.join(__dirname, '../src/renderer-src/main.jsx'), 'utf8');
  const rendererLib = fs.readFileSync(path.join(__dirname, '../src/renderer-src/lib.js'), 'utf8');
  const bundle = fs.readFileSync(path.join(__dirname, '../src/renderer/assets/app.js'), 'utf8');
  for (const source of [rendererMain, rendererLib, bundle]) {
    assert.ok(!source.includes('TYPESAFE_API_KEY'), 'API key must stay out of the renderer');
    assert.ok(!source.includes('api.typesafe.ai'), 'TypeSafe endpoint must stay out of the renderer');
  }
  assert.ok(rendererMain.includes('data-surface="subagent-rows"'));
  assert.ok(rendererMain.includes('data-surface="computer-trust"'));
  assert.ok(rendererMain.includes('data-surface="computer-stop"'));
  assert.ok(rendererMain.includes('data-surface="computer-browser-host"'));
  assert.ok(rendererMain.includes('data-surface="recorded-playback"'));
  assert.ok(rendererMain.includes('className="subagent-title"'));
  assert.ok(rendererMain.includes('className="subagent-type"'));
  assert.ok(rendererMain.includes('className="subagent-status"'));
  assert.ok(rendererMain.includes('className="subagent-summary"'));

  server.close();
  console.log('parity-loop test: ALL OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
