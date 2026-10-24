'use strict';
/**
 * Main-process skill recorder. The state machine and replay planner live in
 * src/coordinator/skill-recording.js. Replay calls the out-of-process helper
 * only after the freshness gate accepts each action.
 */
const { SkillRecorder, writeArtifact, readArtifact, listArtifacts, replayArtifact } = require('../../coordinator/skill-recording');

let recorder = new SkillRecorder();

function status() {
  return {
    state: recorder.state,
    steps: recorder.steps.length,
    error: recorder.error,
    artifactId: recorder.artifact?.id || null,
  };
}

function prepare() {
  if (recorder.state !== 'idle') recorder = new SkillRecorder();
  recorder.prepare();
  return status();
}

function begin() {
  recorder.begin();
  return status();
}

function note(step) {
  recorder.note(step || {});
  return status();
}

function stop() {
  recorder.stop();
  return status();
}

function complete() {
  const artifact = writeArtifact(recorder.complete());
  return { ...status(), artifact };
}

function cancel() {
  recorder.cancel();
  const out = status();
  recorder = new SkillRecorder();
  return out;
}

function list() {
  try {
    return listArtifacts();
  } catch {
    return [];
  }
}

async function defaultHost(method, params) {
  const { settingsService } = require('./settingsService');
  if (!settingsService.load().allowComputerUse) {
    throw new Error('computer use is disabled — enable it in Settings');
  }
  const { computerUseService } = require('./computerUseService');
  if (method === 'screenshot') return computerUseService.screenshot();
  if (method === 'click') {
    return computerUseService.click({
      x: params?.x,
      y: params?.y,
      coordinate_token: params?.coordinate_token,
    });
  }
  const { computerHostService } = require('./computerHostService');
  const rpc = {
    typeText: 'computer/type_text',
    pressKey: 'computer/press_key',
    scroll: 'computer/scroll',
    setValue: 'computer/set_value',
    openApp: 'computer/open_app',
    listApps: 'computer/list_apps',
  }[method];
  if (!rpc) throw new Error(`unknown replay method: ${method}`);
  return computerHostService.request(rpc, params);
}

async function replay(id, host) {
  const artifact = readArtifact(id);
  const { computerUseService } = require('./computerUseService');
  return replayArtifact(artifact, computerUseService.freshness, host === undefined ? defaultHost : host);
}

module.exports = {
  skillRecordingService: {
    status, prepare, begin, note, stop, complete, cancel, list, replay,
  },
};
