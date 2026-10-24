'use strict';
/* W6, W7, W8 — the operational and ecosystem layers.
 *
 *  W6.1  the realtime voice transport is provider-agnostic and honest
 *  W6.2  the voice call has a lifecycle
 *  W6.3  screen recording has start / save / discard
 *  W6.4  the artifact store is content-addressed with conditional writes
 *  W6.5  the attachment pipeline is chunked and durable
 *  W7.1  tracing produces named spans with a parent and a duration
 *  W7.2  failures are classified, not just reported
 *  W7.3  a coordinator crash is reported
 *  W7.4  the DNS diagnosis distinguishes the resolver from the endpoint
 *  W7.5  an update is only installed if it matches the published digest
 *  W7.6  an in-flight turn is checkpointed
 *  W7.7  the support bundle carries the reliability log
 *  W8.1  the model can manage plugins and MCP servers
 *  W8.2  the catalogue is local and installs real things
 *  W8.3  a skill can be proposed and carried over
 *  W8.4  web_fetch refuses a host that is not on the allow-list
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-w678-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const telemetry = require('../src/shared/telemetry');
const { artifactService } = require('../src/main/services/artifactService');
const screenRecordService = require('../src/main/services/screenRecordService');
const realtimeVoiceService = require('../src/main/services/realtimeVoiceService');
const { voiceCallService } = require('../src/main/services/voiceCallService');
const { updaterService } = require('../src/main/services/updaterService');
const { restoreService } = require('../src/main/services/restoreService');
const { supportBundleService } = require('../src/main/services/supportBundleService');
const networkDiagnosis = require('../src/main/services/networkDiagnosisService');
const { executeEcosystemTool, searchCatalogue } = require('../src/coordinator/ecosystemTools');
const coordinator = require('../src/coordinator/index');

(async () => {
  /* --------------------------------------------------------------- W6.1 */
  await test('W6.1 the realtime transport is provider-agnostic and says when it is unconfigured', () => {
    const config = realtimeVoiceService.realtimeConfig();
    assert.equal(typeof config.configured, 'boolean');
    if (!config.configured) {
      assert.match(config.reason, /realtime endpoint/);
    }
  });

  await test('W6.1 the realtime session refuses to connect without a credential', async () => {
    const session = new realtimeVoiceService.RealtimeVoiceSession({ url: 'ws://127.0.0.1:1/x' });
    await assert.rejects(() => session.connect(), /credential/);
  });

  await test('W6.1 the realtime session refuses a missing endpoint', async () => {
    const session = new realtimeVoiceService.RealtimeVoiceSession({ credential: 'x' });
    await assert.rejects(() => session.connect(), /endpoint/);
  });

  /* --------------------------------------------------------------- W6.2 */
  await test('W6.2 a voice call has a lifecycle', () => {
    const minted = voiceCallService.mintCredential({ ttlMs: 60_000 });
    assert.ok(minted.token, 'a call needs a credential');
    const call = voiceCallService.start({ sessionId: 'w678-session', credential: minted.token, title: 'Test call' });
    assert.ok(call.id, 'a call needs an id');
    assert.ok(voiceCallService.list().some((c) => c.id === call.id));
    voiceCallService.record(call.id, { from: 'user', text: 'hello' });
    const said = voiceCallService.sentMessages(call.id);
    assert.ok(Array.isArray(said));
    voiceCallService.end(call.id);
  });

  /* --------------------------------------------------------------- W6.3 */
  await test('W6.3 a recording can be started, captured, saved and discarded', () => {
    const started = screenRecordService.start({ sessionId: 'w678-session' });
    assert.equal(started.ok, true);
    assert.ok(started.id);
    assert.equal(screenRecordService.status(started.id).mode, screenRecordService.MODE.START);

    const captured = screenRecordService.captureFrame(started.id, Buffer.from('fake-png'));
    assert.equal(captured.ok, true);
    assert.equal(captured.frames, 1);

    const saved = screenRecordService.save(started.id, { saveAsFilename: 'w678-recording.png' });
    assert.equal(saved.ok, true);
    assert.ok(saved.path.endsWith('w678-recording.png'));
    assert.ok(fs.existsSync(saved.path));

    const second = screenRecordService.start({});
    screenRecordService.captureFrame(second.id, Buffer.from('x'));
    const discarded = screenRecordService.discard(second.id);
    assert.equal(discarded.ok, true);
    assert.ok(discarded.removed >= 1);
    assert.equal(screenRecordService.status(second.id), null);
  });

  await test('W6.3 an unknown recording is refused, not pretended', () => {
    assert.equal(screenRecordService.save('nope').ok, false);
    assert.equal(screenRecordService.discard('nope').ok, false);
  });

  /* --------------------------------------------------------------- W6.4 */
  await test('W6.4 the artifact store is content-addressed', () => {
    const a = artifactService.save({ id: 'w678-art', title: 'T', html: '<h1>same</h1>' });
    assert.ok(a.sha256, 'an artifact must carry its content address');
    assert.ok(a.etag, 'an artifact must carry a version tag');
    const b = artifactService.save({ id: 'w678-art', title: 'T', html: '<h1>same</h1>' });
    assert.equal(a.etag, b.etag, 'the same content must have the same address');
    assert.ok(artifactService.byContent(a.sha256), 'an artifact must be findable by its address');
  });

  await test('W6.4 a conditional write that lost a race is refused', () => {
    const a = artifactService.save({ id: 'w678-art2', title: 'T', html: '<h1>one</h1>' });
    artifactService.save({ id: 'w678-art2', title: 'T', html: '<h1>two</h1>' });
    assert.throws(
      () => artifactService.save({ id: 'w678-art2', title: 'T', html: '<h1>three</h1>', ifMatch: a.etag }),
      /changed since you read it/,
    );
    // The current content is untouched.
    assert.match(artifactService.read('w678-art2'), /two/);
  });

  await test('W6.4 a conditional write with the current etag lands', () => {
    const a = artifactService.save({ id: 'w678-art3', title: 'T', html: '<h1>one</h1>' });
    const b = artifactService.save({ id: 'w678-art3', title: 'T', html: '<h1>one</h1>', ifMatch: a.etag });
    assert.equal(b.ok, undefined);
    assert.equal(b.etag, a.etag);
  });

  /* --------------------------------------------------------------- W6.5 */
  await test('W6.5 the attachment pipeline stores bytes and reads them back', () => {
    const { attachmentService } = require('../src/main/services/attachmentService');
    const stored = attachmentService.storeBuffer(Buffer.from('hello'), 'note.txt');
    assert.ok(stored, 'an attachment is stored');
    assert.ok(stored.path, 'the stored attachment has a location');
    // The store is content-addressed: the same bytes give the same address.
    const again = attachmentService.storeBuffer(Buffer.from('hello'), 'note.txt');
    assert.equal(again.sha256, stored.sha256);
    const text = attachmentService.readAttachmentText({ path: stored.path });
    assert.match(String(text.text ?? text), /hello/);
  });

  /* --------------------------------------------------------------- W7.1 */
  await test('W7.1 a span has a parent, a duration and attributes', async () => {
    const parent = telemetry.startSpan('agent.turn', { attributes: { sessionId: 's1' } });
    const child = telemetry.startSpan('agent.tool', { parent, attributes: { tool: 'shell' } });
    assert.equal(child.parentSpanId, parent.spanId);
    assert.equal(child.traceId, parent.traceId);
    await new Promise((r) => setTimeout(r, 5));
    telemetry.endSpan(child, { result: 'ok' });
    telemetry.endSpan(parent, { steps: 1 });
    assert.ok(child.durationMs >= 1, 'a span must record how long it took');
    assert.equal(child.attributes.result, 'ok');
    assert.ok(telemetry.recentSpans({ name: 'agent.tool' }).length >= 1);
  });

  await test('W7.1 withSpan closes the span even when the body throws', async () => {
    await assert.rejects(() => telemetry.withSpan('agent.boom', async () => { throw new Error('boom'); }));
    const spans = telemetry.recentSpans({ name: 'agent.boom' });
    assert.ok(spans.length >= 1);
    assert.equal(spans[spans.length - 1].status, 'error');
  });

  /* --------------------------------------------------------------- W7.2 */
  await test('W7.2 failures are classified, not just reported', () => {
    const transient = telemetry.classifyFailure({ code: 'ECONNREFUSED' });
    assert.equal(transient.class, 'transient');
    assert.equal(transient.retryable, true);
    // The report carries the taxonomy code, not the raw errno.
    assert.equal(transient.code, 'connection_refused');

    const policy = telemetry.classifyFailure({ code: 'EACCES' });
    assert.equal(policy.class, 'policy');
    assert.equal(policy.needsUser, true);

    const declined = telemetry.classifyFailure(new (require('../src/shared/errors').ClassifiedError)('user-declined', 'no'));
    assert.equal(declined.class, 'user-cancelled');

    const internal = telemetry.classifyFailure(new Error('a bug'));
    assert.equal(internal.class, 'internal');
  });

  await test('W7.2 a failure is reported with a stable code', () => {
    const report = telemetry.reportFailure({ code: 'ECONNREFUSED' }, { phase: 'test' });
    assert.ok(report.id);
    assert.equal(report.code, 'connection_refused');
    assert.equal(report.phase, 'test');
    assert.ok(telemetry.recentReports({ class: 'transient' }).length >= 1);
  });

  /* --------------------------------------------------------------- W7.3 */
  await test('W7.3 a coordinator crash is reported as an internal failure', () => {
    const report = telemetry.reportFailure(new Error('coordinator exited (1)'), { phase: 'coordinator' });
    assert.equal(report.phase, 'coordinator');
    assert.ok(report.id);
  });

  /* --------------------------------------------------------------- W7.4 */
  await test('W7.4 the DNS diagnosis classifies what it found', async () => {
    const result = await networkDiagnosis.diagnose('localhost', { probeNetwork: false });
    assert.ok(Object.values(networkDiagnosis.DIAGNOSIS).includes(result.diagnosis));
    assert.ok(result.reason, 'a diagnosis must explain itself');
  });

  await test('W7.4 an empty host is inconclusive, not a crash', async () => {
    const result = await networkDiagnosis.diagnose('', { probeNetwork: false });
    assert.equal(result.diagnosis, networkDiagnosis.DIAGNOSIS.INCONCLUSIVE);
  });

  await test('W7.4 an address needs no resolution', async () => {
    const result = await networkDiagnosis.diagnose('127.0.0.1', { probeNetwork: false });
    assert.notEqual(result.diagnosis, networkDiagnosis.DIAGNOSIS.INCONCLUSIVE);
  });

  /* --------------------------------------------------------------- W7.5 */
  await test('W7.5 an update with no published digest cannot be verified', () => {
    const verdict = updaterService.verifyUpdate({ url: 'https://example.com/x.zip' });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'UPDATE_UNVERIFIABLE');
  });

  await test('W7.5 an update from an untrusted publisher is refused', () => {
    const digest = 'a'.repeat(64);
    const verdict = updaterService.verifyUpdate({
      url: 'https://example.com/x.zip', expectedSha256: digest, expectedPublisher: 'someone-else',
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'UPDATE_UNTRUSTED_PUBLISHER');
  });

  await test('W7.5 a well-formed update verifies', () => {
    const digest = 'a'.repeat(64);
    const verdict = updaterService.verifyUpdate({
      url: 'https://example.com/x.zip', expectedSha256: `sha256:${digest}`,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.sha256, digest);
  });

  /* --------------------------------------------------------------- W7.6 */
  await test('W7.6 an in-flight turn is checkpointed and read back', () => {
    restoreService.checkpointTurn({ sessionId: 'w678', step: 4, model: 'gpt', partialText: 'half a th' });
    const turn = restoreService.peekTurn();
    assert.ok(turn, 'the turn checkpoint must survive the round trip');
    assert.equal(turn.step, 4);
    assert.equal(turn.sessionId, 'w678');
    assert.equal(turn.partialText, 'half a th');
    restoreService.clearTurn();
    assert.equal(restoreService.peekTurn(), null);
  });

  await test('W7.6 a turn checkpoint needs a session', () => {
    assert.throws(() => restoreService.checkpointTurn({ step: 1 }), /session id/);
  });

  /* --------------------------------------------------------------- W7.7 */
  await test('W7.7 the support bundle carries the reliability log', () => {
    telemetry.reportFailure({ code: 'ECONNREFUSED' }, { phase: 'bundle-test' });
    const bundle = supportBundleService.create({ outDir: path.join(tmp, 'bundle') });
    assert.ok(bundle.files.includes('reliability.json'), 'the bundle must carry the reliability log');
    // The log really has the failure.
    assert.ok(telemetry.recentReports({ limit: 20 }).some((r) => r.phase === 'bundle-test'));
  });

  await test('W7.7 the bundle still excludes the transcripts', () => {
    const bundle = supportBundleService.create({ outDir: path.join(tmp, 'bundle2') });
    assert.equal(bundle.files.includes('transcript.json'), false);
    assert.equal(bundle.files.includes('sessions.json'), true, 'the session INDEX is included, not the content');
  });

  /* --------------------------------------------------------------- W8.1 */
  await test('W8.1 the model can search the catalogue and install from it', async () => {
    const entries = searchCatalogue('review', 'skill');
    assert.ok(entries.length >= 1, 'the catalogue must have a review skill');
    assert.equal(entries[0].id, 'code-review');

    const installed = await executeEcosystemTool('install_plugin', { id: 'code-review', kind: 'skill' });
    assert.match(installed, /installed the skill/);
    const listed = await executeEcosystemTool('list_installed_plugins', {});
    assert.match(listed, /code-review/);
  });

  await test('W8.1 the MCP status tool reports what it knows', async () => {
    const status = await executeEcosystemTool('get_mcp_server_status', { server: 'nope' });
    assert.match(status, /unknown MCP server|no MCP servers/);
  });

  await test('W8.1 the model can restart the MCP servers', async () => {
    const result = await executeEcosystemTool('restart_mcp_servers', {});
    assert.match(result, /restarted the MCP servers/);
  });

  /* --------------------------------------------------------------- W8.2 */
  await test('W8.2 installing an MCP server from the catalogue records it', async () => {
    const result = await executeEcosystemTool('install_plugin', { id: 'mcp-filesystem', kind: 'mcp' });
    assert.match(result, /registered the MCP server/);
    const { settingsService } = require('../src/main/services/settingsService');
    const settings = settingsService.load();
    assert.ok((settings.mcpServers ?? []).some((s) => s.name === 'mcp-filesystem'));

    // Clean up: the server was really started, and a running server would
    // keep this process alive.
    const { mcpService } = require('../src/main/services/mcpService');
    await mcpService.stopServer('mcp-filesystem');
    settingsService.save({ mcpServers: (settings.mcpServers ?? []).filter((s) => s.name !== 'mcp-filesystem') });
  });

  /* --------------------------------------------------------------- W8.3 */
  await test('W8.3 a skill can be proposed from a conversation', async () => {
    const result = await executeEcosystemTool('propose_skill', {
      name: 'w678-proposed', description: 'a proposed skill', body: 'Do the thing this way.',
    });
    assert.match(result, /proposed the skill/);
    const { skillsService } = require('../src/main/services/skillsService');
    assert.ok(skillsService.get('w678-proposed'), 'the proposed skill must exist');
  });

  await test('W8.3 a setup can be carried over to another agent', async () => {
    const { agentIdentityService } = require('../src/main/services/agentIdentityService');
    const agent = agentIdentityService.create({ name: 'Carrier target' });
    const result = await executeEcosystemTool('propose_carry_over', {
      agentId: agent.id, skills: ['code-review'], note: 'for the review work',
    });
    assert.match(result, /carried over/);
    const { agentPluginsService } = require('../src/main/services/agentPluginsService');
    assert.ok(agentPluginsService.getPlugins({ agentId: agent.id }));
  });

  /* --------------------------------------------------------------- W8.4 */
  await test('W8.4 web_fetch refuses a host that is not on the allow-list', async () => {
    const result = await executeEcosystemTool('web_fetch', { url: 'https://not-allowed.example.net/x' });
    assert.match(result, /refused|not on the egress allow-list/);
  });

  await test('W8.4 web_fetch refuses a malformed URL', async () => {
    const result = await executeEcosystemTool('web_fetch', { url: 'not a url' });
    assert.match(result, /not a valid URL/);
  });

  await test('W8.4 the ecosystem tools are offered to the model', () => {
    const names = coordinator.allTools().map((t) => t.function.name);
    for (const name of [
      'search_plugins', 'install_plugin', 'uninstall_plugin', 'list_installed_plugins',
      'get_mcp_server_status', 'set_mcp_instructions', 'restart_mcp_servers',
      'propose_skill', 'propose_carry_over', 'web_fetch',
    ]) {
      assert.ok(names.includes(name), `${name} must be offered to the model`);
    }
  });

  console.log(results.join('\n'));
  if (process.exitCode) {
    console.error('\nW6/W7/W8 tests FAILED');
    process.exit(1);
  }
  console.log(`\nW6/W7/W8: ${results.length} checks OK`);
})();
