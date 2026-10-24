'use strict';
/**
 * Rooms — a bounded, multi-agent conversation.
 *
 * The reference implementation's group conversation is a protocol, not a
 * chat. Its messages carry:
 *
 *   nonce                   — who owns this turn
 *   peers                   — the other members, injected into the prompt
 *   deadline_ms             — how long the member may take
 *   is_winding_down         — the room is finishing
 *   parent_request_id       — the turn this one answers
 *   root_parent_request_id  — the turn at the root of the tree
 *   reply_to                — a quoted message
 *
 * That is a *deadline-bounded conversation tree*, and it is the piece the
 * reference has that a plain "spawn three agents and collect their answers"
 * does not: the members see each other, they take turns, and the whole thing
 * is bounded in time.
 *
 * This module implements that protocol. It is pure state plus prompt
 * assembly; the coordinator runs the turns.
 *
 * Pure-ish module — no Electron, no network.
 */
const crypto = require('node:crypto');

/** The default turn budget. */
const DEFAULT_DEADLINE_MS = 120_000;
const MAX_MEMBERS = 8;
const MAX_MESSAGES = 500;

/** A room. */
const rooms = new Map();

function newRoomId() {
  return `room-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Create a room.
 * @param {object} opts
 * @param {string[]} opts.members   the agent ids that take part
 * @param {string} [opts.title]
 */
function createRoom({ members = [], title = '', id } = {}) {
  const roomId = String(id ?? newRoomId());
  if (rooms.has(roomId)) throw new Error(`room already exists: ${roomId}`);
  const memberIds = [...new Set(members.map(String))].filter(Boolean);
  if (memberIds.length < 2) throw new Error('a room needs at least two members');
  if (memberIds.length > MAX_MEMBERS) throw new Error(`a room holds at most ${MAX_MEMBERS} members`);
  const room = {
    id: roomId,
    title: String(title).slice(0, 200),
    members: memberIds,
    createdAtMs: Date.now(),
    windingDown: false,
    rounds: 0,
    /** The turn records, newest last. */
    turns: [],
    /** nonce -> the in-flight request. */
    pending: new Map(),
    /** The message log. */
    messages: [],
  };
  rooms.set(roomId, room);
  return publicRoom(room);
}

function getRoom(roomId) {
  return rooms.get(String(roomId)) ?? null;
}

function publicRoom(room) {
  if (!room) return null;
  return {
    id: room.id,
    title: room.title,
    members: room.members,
    createdAtMs: room.createdAtMs,
    windingDown: room.windingDown,
    rounds: room.rounds,
    turns: room.turns.length,
    messages: room.messages.length,
  };
}

function listRooms() {
  return [...rooms.values()].map(publicRoom);
}

/**
 * Ask a member to take a turn.
 *
 * The returned payload is what the coordinator feeds the member's model: the
 * prompt, the peers it must consider, the deadline, and the tree links.
 *
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {string} opts.memberAgentId
 * @param {Array<object>} [opts.newMessages]   messages since the last turn
 * @param {number} [opts.deadlineMs]
 * @param {string} [opts.parentRequestId]
 * @param {string} [opts.rootParentRequestId]
 * @param {boolean} [opts.windingDown]
 * @returns {object} the turn payload
 */
function requestMemberTurn(opts = {}) {
  const room = rooms.get(String(opts.roomId));
  if (!room) throw new Error(`unknown room: ${opts.roomId}`);
  const member = String(opts.memberAgentId ?? '');
  if (!room.members.includes(member)) throw new Error(`${member} is not a member of ${room.id}`);

  const nonce = opts.nonce ? String(opts.nonce) : crypto.randomUUID();
  if (room.pending.has(nonce)) throw new Error(`turn already in flight: ${nonce}`);

  const deadlineMs = Math.max(1000, Number(opts.deadlineMs) || DEFAULT_DEADLINE_MS);
  const peers = room.members.filter((m) => m !== member);
  const request = {
    requestId: `rt-${crypto.randomUUID().slice(0, 8)}`,
    nonce,
    roomId: room.id,
    memberAgentId: member,
    peers,
    deadlineMs,
    deadlineAtMs: Date.now() + deadlineMs,
    parentRequestId: opts.parentRequestId ?? null,
    rootParentRequestId: opts.rootParentRequestId ?? opts.parentRequestId ?? null,
    windingDown: Boolean(opts.windingDown ?? room.windingDown),
    newMessages: Array.isArray(opts.newMessages) ? opts.newMessages : [],
    requestedAtMs: Date.now(),
  };
  room.pending.set(nonce, request);
  return request;
}

/**
 * Deliver a member's turn.
 *
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {string} opts.nonce
 * @param {string} opts.memberAgentId
 * @param {Array<object>} [opts.messages]  what the member said
 * @param {string} [opts.error]
 */
function deliverMemberTurn(opts = {}) {
  const room = rooms.get(String(opts.roomId));
  if (!room) throw new Error(`unknown room: ${opts.roomId}`);
  const nonce = String(opts.nonce ?? '');
  const request = room.pending.get(nonce);
  if (!request) throw new Error(`no turn in flight for nonce ${nonce}`);
  if (opts.memberAgentId && request.memberAgentId !== String(opts.memberAgentId)) {
    throw new Error('the turn belongs to a different member');
  }
  room.pending.delete(nonce);

  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const record = {
    requestId: request.requestId,
    nonce,
    memberAgentId: request.memberAgentId,
    messages,
    error: opts.error ? String(opts.error).slice(0, 1000) : null,
    parentRequestId: request.parentRequestId,
    rootParentRequestId: request.rootParentRequestId,
    deliveredAtMs: Date.now(),
  };
  room.turns.push(record);
  if (room.turns.length > MAX_MESSAGES) room.turns.shift();

  for (const message of messages) {
    room.messages.push({
      ...message,
      speakerKind: message.speakerKind ?? 'agent',
      speakerName: message.speakerName ?? request.memberAgentId,
      isSelf: request.memberAgentId === (message.speakerName ?? request.memberAgentId),
      atMs: Date.now(),
    });
  }
  if (room.messages.length > MAX_MESSAGES) room.messages.shift();

  // The room winds down when every member has delivered for this round.
  const delivered = new Set(
    room.turns.filter((t) => t.round === request.round).map((t) => t.memberAgentId),
  );
  if (delivered.size >= room.members.length) {
    room.windingDown = true;
    room.rounds += 1;
  }
  return { ...record, windingDown: room.windingDown, rounds: room.rounds };
}

/**
 * Cancel a turn in flight.
 */
function cancelMemberTurn({ roomId, nonce, reason = '' } = {}) {
  const room = rooms.get(String(roomId));
  if (!room) throw new Error(`unknown room: ${roomId}`);
  const request = room.pending.get(String(nonce ?? ''));
  if (!request) return { cancelled: false };
  room.pending.delete(String(nonce));
  return { cancelled: true, requestId: request.requestId, reason: String(reason).slice(0, 500) };
}

/** The turns still in flight in a room. */
function pendingTurns(roomId) {
  const room = rooms.get(String(roomId));
  if (!room) return [];
  return [...room.pending.values()];
}

/**
 * Assemble the prompt for a member's turn: what the room is, who else is
 * in it, what has been said, and what the member is being asked for.
 */
function turnPrompt(request) {
  const room = rooms.get(request.roomId);
  const peers = request.peers.map((p) => `- ${p}`).join('\n') || '- (nobody else)';
  const said = request.newMessages.length
    ? request.newMessages.map((m) => `${m.speakerName ?? m.speakerKind ?? 'someone'}: ${m.text ?? ''}`).join('\n')
    : '(nothing new)';
  const tree = request.rootParentRequestId
    ? `\nThis turn answers ${request.parentRequestId ?? request.rootParentRequestId} in a conversation rooted at ${request.rootParentRequestId}.`
    : '';
  return [
    `You are ${request.memberAgentId} in the room "${room?.title || request.roomId}".`,
    '',
    'Other members (you can address them, and you should not repeat their work):',
    peers,
    '',
    'What has been said since your last turn:',
    said,
    '',
    request.windingDown
      ? 'This is the last round: say what you concluded, briefly, and stop.'
      : 'Take your turn: contribute what only you can contribute.',
    tree,
    '',
    `You have ${Math.round(request.deadlineMs / 1000)} seconds.`,
  ].join('\n');
}

/** The message log of a room. */
function messages(roomId) {
  return rooms.get(String(roomId))?.messages ?? [];
}

/** Forget a room. */
function closeRoom(roomId) {
  return rooms.delete(String(roomId));
}

module.exports = {
  DEFAULT_DEADLINE_MS,
  MAX_MEMBERS,
  cancelMemberTurn,
  closeRoom,
  createRoom,
  deliverMemberTurn,
  getRoom,
  listRooms,
  messages,
  pendingTurns,
  requestMemberTurn,
  turnPrompt,
};
