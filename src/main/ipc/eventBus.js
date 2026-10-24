'use strict';
/**
 * Event bus — typed, named, resumable channels.
 *
 * The existing emitter broadcasts `namespace:method` strings to every
 * window. That is enough for "something happened", but it cannot answer the
 * two questions a real product has to answer:
 *
 *   1. *What shape is this event?* — a renderer that receives `agent:onDelta`
 *      cannot know what fields to read.
 *   2. *What did I miss while I was reloading?* — a reload loses every
 *      in-flight event, and the renderer has to re-fetch everything.
 *
 * So the bus declares its channels (name → payload shape, retention) and
 * sequences every event. A subscriber can say "give me everything after
 * sequence 41" and the bus replays what it kept.
 *
 * Channels are declared, not inferred: an undeclared channel is a programming
 * error and fails loudly at emit time.
 */
const { EventEmitter } = require('node:events');

/**
 * The declared channels.
 *
 * `retain` is how many events of this channel are kept for replay. A
 * channel that carries a stream (deltas) retains little; a channel that
 * carries state changes retains more.
 */
const CHANNELS = {
  // The agent's life.
  'agent:state': { retain: 64, description: 'session state changes' },
  'agent:delta': { retain: 8, description: 'streamed assistant text' },
  'agent:tool': { retain: 256, description: 'tool call start/result' },
  'agent:plan': { retain: 32, description: 'the plan checklist changed' },
  'agent:confirm': { retain: 16, description: 'an approval is pending' },
  'agent:governance': { retain: 256, description: 'a permission decision was made' },
  'agent:error': { retain: 32, description: 'the run failed' },
  // The conversation.
  'transcript:entry': { retain: 512, description: 'a transcript row was added or changed' },
  'transcript:outline': { retain: 32, description: 'the conversation outline changed' },
  'transcript:tray': { retain: 64, description: 'a tray (unread marker) changed' },
  // Work.
  'task:changed': { retain: 256, description: 'a task or todo changed' },
  'subagent:changed': { retain: 256, description: 'a subagent changed state' },
  'automation:changed': { retain: 128, description: 'an automation changed or ran' },
  'async-task:changed': { retain: 128, description: 'a background task changed' },
  // The machine.
  'computer:action': { retain: 128, description: 'a synthetic computer action' },
  'computer:state': { retain: 64, description: 'the guest desktop changed state' },
  'sandbox:state': { retain: 64, description: 'a sandbox changed state' },
  'mcp:state': { retain: 64, description: 'an MCP server changed state' },
  'browser:state': { retain: 64, description: 'a browser tab changed state' },
  // The interface.
  'notice': { retain: 64, description: 'a user-visible notice' },
  'tray': { retain: 32, description: 'the menu-bar tray changed' },
  'settings:changed': { retain: 32, description: 'a setting changed' },
  'update:state': { retain: 32, description: 'the updater changed state' },
  'connection:state': { retain: 32, description: 'the connection to the backend changed' },
  'artifact:changed': { retain: 64, description: 'an artifact was created or changed' },
  'room:message': { retain: 256, description: 'a room message was posted' },
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

/** channel -> [{ seq, payload, at }] */
const retained = new Map();
let sequence = 0;

function isDeclared(channel) {
  return Object.prototype.hasOwnProperty.call(CHANNELS, channel);
}

/**
 * Publish an event.
 *
 * @param {string} channel  a declared channel name
 * @param {object} payload
 * @returns {{ seq: number, channel: string }|null} null when the channel is not declared
 */
function publish(channel, payload) {
  if (!isDeclared(channel)) {
    throw new Error(`unknown event channel: ${channel} (declare it in eventBus.CHANNELS)`);
  }
  sequence += 1;
  const entry = { seq: sequence, channel, payload, at: Date.now() };
  const keep = CHANNELS[channel].retain ?? 32;
  const list = retained.get(channel) ?? [];
  list.push(entry);
  while (list.length > keep) list.shift();
  retained.set(channel, list);
  bus.emit(channel, entry);
  bus.emit('*', entry);
  return { seq: entry.seq, channel };
}

/**
 * Publish without throwing on an unknown channel — for the cases where a
 * caller may be ahead of the declaration (a plugin, a test).
 */
function tryPublish(channel, payload) {
  try {
    return publish(channel, payload);
  } catch {
    return null;
  }
}

/**
 * The events of a channel after `afterSeq`.
 * @returns {Array<{ seq, payload, at }>}
 */
function replay(channel, afterSeq = 0) {
  const list = retained.get(channel) ?? [];
  const after = Number(afterSeq) || 0;
  return list.filter((e) => e.seq > after);
}

/**
 * The current sequence number — what a client stores as its cursor.
 */
function cursor() {
  return sequence;
}

/** Subscribe to a channel. Returns an unsubscribe function. */
function subscribe(channel, handler) {
  if (!isDeclared(channel)) throw new Error(`unknown event channel: ${channel}`);
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
}

/** Subscribe to every channel. */
function subscribeAll(handler) {
  bus.on('*', handler);
  return () => bus.off('*', handler);
}

/** Forget everything (used by tests and by a "reset" action). */
function reset() {
  retained.clear();
  sequence = 0;
  bus.removeAllListeners();
}

module.exports = {
  CHANNELS,
  bus,
  cursor,
  isDeclared,
  publish,
  replay,
  reset,
  subscribe,
  subscribeAll,
  tryPublish,
};
