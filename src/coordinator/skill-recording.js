'use strict';
/**
 * Local skill recording. States follow the Manus recorder:
 * idle → preparing → recording → processing → completed | cancelled | error.
 * A completed artifact replays as computer actions. Each click is preceded
 * by a fresh screenshot token; stale tokens are refused by the same gate
 * the live computer tools use.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { frameHashFromBgra, frameHashFromBytes } = require('./freshness');

const STATES = ['idle', 'preparing', 'recording', 'processing', 'completed', 'cancelled', 'error'];

const NEXT = {
  idle: ['preparing'],
  preparing: ['recording', 'cancelled', 'error'],
  recording: ['processing', 'cancelled', 'error'],
  processing: ['completed', 'cancelled', 'error'],
  completed: [],
  cancelled: [],
  error: [],
};

class SkillRecorder {
  constructor() {
    this.state = 'idle';
    this.steps = [];
    this.error = null;
    this.artifact = null;
  }

  _go(from, to) {
    if (this.state !== from || !NEXT[from].includes(to)) {
      throw new Error(`invalid skill transition ${this.state} → ${to}`);
    }
    this.state = to;
    return this.state;
  }

  prepare() {
    return this._go('idle', 'preparing');
  }

  begin() {
    return this._go('preparing', 'recording');
  }

  note(step) {
    if (this.state !== 'recording') throw new Error(`cannot note from ${this.state}`);
    const kind = String(step?.kind || '');
    if (!['click', 'type', 'key', 'scroll', 'set_value', 'open_app', 'list_apps'].includes(kind)) {
      throw new Error(`unknown recorded action: ${kind}`);
    }
    this.steps.push({ ...step, kind, at: Date.now() });
    return this.steps.length;
  }

  stop() {
    return this._go('recording', 'processing');
  }

  complete() {
    this._go('processing', 'completed');
    this.artifact = {
      id: `skill-${crypto.randomBytes(4).toString('hex')}`,
      version: 1,
      state: 'completed',
      steps: this.steps.map((step) => ({ ...step })),
    };
    return this.artifact;
  }

  cancel() {
    if (!NEXT[this.state].includes('cancelled')) {
      throw new Error(`cannot cancel from ${this.state}`);
    }
    this.state = 'cancelled';
    this.artifact = null;
    return this.state;
  }

  fail(message) {
    if (!NEXT[this.state].includes('error')) {
      throw new Error(`cannot fail from ${this.state}`);
    }
    this.state = 'error';
    this.error = String(message || 'error');
    return this.state;
  }
}

function recordingsDir(root) {
  const base = root || process.env.QUANSIOX_USER_DATA_DIR;
  if (!base) throw new Error('QUANSIOX_USER_DATA_DIR is not set');
  return path.join(base, 'skill-recordings');
}

function writeArtifact(artifact, root) {
  if (!artifact || artifact.state !== 'completed') throw new Error('only a completed artifact can be stored');
  const dir = recordingsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const id = artifact.id && /^[a-zA-Z0-9_-]{1,80}$/.test(artifact.id)
    ? artifact.id
    : `skill-${crypto.randomBytes(4).toString('hex')}`;
  const stored = { ...artifact, id };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(stored, null, 2));
  return stored;
}

function readArtifact(id, root) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || '')) throw new Error('invalid artifact id');
  const file = path.join(recordingsDir(root), `${id}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listArtifacts(root) {
  const dir = recordingsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      return { id: data.id, state: data.state, steps: Array.isArray(data.steps) ? data.steps.length : 0 };
    });
}

/**
 * Hash real screenshot pixels. A live screenshot that already issued a
 * coordinate token on this gate is reused so the click checks that same token.
 */
async function observeStep(step, host) {
  const recorded = step.observe;
  if (recorded?.data && recorded.width && recorded.height) {
    const frameHash = frameHashFromBgra(recorded.data, recorded.width, recorded.height);
    if (!frameHash) throw new Error('frame hash missing');
    return { frameHash, token: null, screenChanged: false };
  }
  if (!host) throw new Error('frame hash missing');
  const shot = await host('screenshot', {});
  const data = shot?.data ?? shot?.bitmap;
  const width = shot?.width;
  const height = shot?.height;
  const fromPixels = frameHashFromBgra(data, width, height);
  if (fromPixels) {
    return {
      frameHash: fromPixels,
      token: shot.coordinateToken || shot.coordinate_token || null,
      screenChanged: shot.screenChanged === true,
    };
  }
  if (shot?.frameHash) {
    return {
      frameHash: shot.frameHash,
      token: shot.coordinateToken || shot.coordinate_token || null,
      screenChanged: shot.screenChanged === true,
    };
  }
  const fallback = frameHashFromBytes(typeof data === 'string' ? data : '');
  if (!fallback) throw new Error('frame hash missing');
  return { frameHash: fallback, token: shot?.coordinateToken || shot?.coordinate_token || null, screenChanged: false };
}

/**
 * Replay a completed recording as computer actions.
 * `host(method, params)` is the helper edge (click, typeText, …).
 * A click whose coordinate token is not the latest on `gate` is refused
 * and the host click is not called.
 */
async function replayArtifact(artifact, gate, host) {
  if (!artifact || artifact.state !== 'completed' || !Array.isArray(artifact.steps)) {
    return { actions: [], error: `artifact state ${artifact?.state || 'missing'} is not replayable` };
  }
  const actions = [];
  for (const step of artifact.steps) {
    const observed = await observeStep(step, host);
    let token = observed.token;
    let screenChanged = observed.screenChanged;
    if (!token) {
      const shot = gate.issueCoordinate(observed.frameHash);
      token = shot.token;
      screenChanged = shot.screenChanged;
    }
    if (!observed.frameHash) throw new Error('frame hash missing');
    actions.push({
      tool: 'computer_screenshot',
      coordinate_token: token,
      frameHash: observed.frameHash,
      screenChanged,
    });
    const actToken = step.coordinate_token || token;
    if (step.kind === 'click') {
      const refusal = gate.requireCoordinate(actToken);
      if (refusal) {
        actions.push({
          tool: 'computer_click', refused: refusal, x: step.x, y: step.y, coordinate_token: actToken,
        });
        continue;
      }
      const action = { tool: 'computer_click', x: step.x, y: step.y, coordinate_token: actToken };
      actions.push(action);
      if (host) await host('click', { x: step.x, y: step.y, coordinate_token: actToken });
    } else if (step.kind === 'type') {
      actions.push({ tool: 'computer_type', text: step.text });
      if (host) await host('typeText', { text: step.text });
    } else if (step.kind === 'key') {
      actions.push({ tool: 'computer_key', key: step.key, modifiers: step.modifiers || [] });
      if (host) await host('pressKey', { key: step.key, modifiers: step.modifiers || [] });
    } else if (step.kind === 'scroll') {
      actions.push({ tool: 'computer_scroll', x: step.x, y: step.y, deltaY: step.deltaY });
      if (host) await host('scroll', { x: step.x, y: step.y, deltaY: step.deltaY });
    } else if (step.kind === 'set_value') {
      const snap = gate.issueSnapshot();
      const refusal = gate.requireSnapshot(snap.token);
      if (refusal) {
        actions.push({ tool: 'computer_set_value', refused: refusal });
        continue;
      }
      actions.push({
        tool: 'computer_set_value', role: step.role, name: step.name, value: step.value, snapshot_id: snap.token,
      });
      if (host) await host('setValue', { role: step.role, name: step.name, value: step.value, snapshot_id: snap.token });
    } else if (step.kind === 'open_app') {
      actions.push({ tool: 'computer_open_app', name: step.name });
      if (host) await host('openApp', { name: step.name });
    } else if (step.kind === 'list_apps') {
      actions.push({ tool: 'computer_list_apps' });
      if (host) await host('listApps', {});
    }
  }
  return { actions };
}

module.exports = {
  STATES,
  SkillRecorder,
  writeArtifact,
  readArtifact,
  listArtifacts,
  replayArtifact,
};
