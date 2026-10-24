'use strict';
/* Per-role model routing + the speculative ensemble.
 *
 *  - a role route can point at a different provider (model + baseUrl + key)
 *  - an explicit model always wins over the route
 *  - a route may omit the key/baseUrl and inherit the main ones
 *  - the resolution order is explicit → route → subagentModel → main
 *  - the tool is advertised and refuses a single candidate
 *
 * Electron-free. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-router-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { resolve, describe, roleFor, normalizeRoute } = require('../src/coordinator/modelRouter');
const coordinator = require('../src/coordinator/index');

(async () => {
  const settings = {
    model: 'gpt-5',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'main-key',
    modelRoutes: {
      coder: { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'claude-key', model: 'claude-opus' },
      explore: { model: 'gemini-2.5-pro' },
    },
  };

  // 1. roles map from the subagent type
  assert.equal(roleFor('explore'), 'explore');
  assert.equal(roleFor('shell'), 'coder');
  assert.equal(roleFor('computer-use'), 'coder');
  assert.equal(roleFor('browser'), 'explore');
  assert.equal(roleFor('general'), 'general');

  // 2. a route for the role wins over the main model
  const coder = resolve({ settings, type: 'shell' });
  assert.equal(coder.source, 'route');
  assert.equal(coder.model, 'claude-opus');
  assert.equal(coder.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(coder.apiKey, 'claude-key');
  assert.equal(coder.role, 'coder');

  // 3. a route that omits the key inherits the main one
  const explore = resolve({ settings, type: 'explore' });
  assert.equal(explore.source, 'route');
  assert.equal(explore.model, 'gemini-2.5-pro');
  assert.equal(explore.baseUrl, 'https://api.openai.com/v1', 'the base url is inherited');
  assert.equal(explore.apiKey, 'main-key', 'the key is inherited');

  // 4. an explicit model always wins
  const explicit = resolve({ settings, type: 'shell', requestedModel: 'gpt-5-mini' });
  assert.equal(explicit.source, 'explicit');
  assert.equal(explicit.model, 'gpt-5-mini');
  assert.equal(explicit.baseUrl, 'https://api.openai.com/v1', 'an explicit model uses the main provider');

  // 5. no route → the configured subagent model
  const sub = resolve({ settings: { ...settings, subagentModel: 'cheap-model' }, type: 'general' });
  assert.equal(sub.source, 'subagent-model');
  assert.equal(sub.model, 'cheap-model');

  // 6. nothing configured → the main model
  const main = resolve({ settings, type: 'general' });
  assert.equal(main.source, 'main');
  assert.equal(main.model, 'gpt-5');

  // 7. route normalization
  assert.equal(normalizeRoute(null), null);
  assert.equal(normalizeRoute({}), null);
  assert.deepEqual(normalizeRoute({ model: 'm', apiKey: 'k' }), { model: 'm', apiKey: 'k' });

  // 8. the description lists the roles
  const described = describe(settings);
  assert.ok(described.find((r) => r.role === 'coder')?.model === 'claude-opus');
  assert.ok(described.find((r) => r.role === 'explore')?.model === 'gemini-2.5-pro');
  assert.ok(described.find((r) => r.role === 'general')?.isMain === true);

  // 9. the speculate tool is advertised and validates its input
  const names = coordinator.allTools().map((t) => t.function.name);
  assert.ok(names.includes('speculate'), 'speculate is advertised');
  const one = await coordinator.executeTool(
    'speculate', { task: 'x', models: ['only-one'] }, tmp, 'spec-session', { permissive: true }, null, null, null, null,
  );
  assert.match(one, /at least two candidate models/);
  const none = await coordinator.executeTool(
    'speculate', { task: '', models: ['a', 'b'] }, tmp, 'spec-session', { permissive: true }, null, null, null, null,
  );
  assert.match(none, /needs a task/);

  // 10. the discovery tool is advertised too
  assert.ok(names.includes('discover_ai_tools'), 'discover_ai_tools is advertised');

  console.log('model-router test: ALL OK (role routes/explicit wins/inheritance/describe/speculate)');
})().catch((e) => { console.error(e); process.exit(1); });
