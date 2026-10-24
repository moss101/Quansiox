'use strict';
/**
 * Local group chat (GPA G9 / docs "group chats: 2–6 bots").
 *
 * A group is a real session (`kind: 'group'`) with 2–6 member sessions. The
 * user's message is fanned out to the members (all, or only those @mentioned);
 * each member answers in a transient session seeded with the group transcript
 * and its own persona, so member DMs are not polluted. Replies are appended to
 * the group transcript with author metadata and emitted for the live UI.
 *
 * No backend: members are local sessions; their own memory scope is used.
 */
const crypto = require('node:crypto');
const { sessionService } = require('./sessionService');

const MAX_MEMBERS = 6;
const MAX_TURNS = 12;
const MAX_CONTEXT = 6000;

const isId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(String(id ?? ''));
function flatten(content) {
  if (Array.isArray(content)) {
    return content.map((p) => (p?.type === 'text' ? p.text : `[${p?.type ?? 'attachment'}]`)).join('\n');
  }
  return String(content ?? '');
}
function emit(event, payload) {
  try {
    const { emitEvent } = require('../ipc/emitEvent');
    emitEvent('groups', event, payload);
  } catch { /* events are best-effort (tests) */ }
}

function create({ name, memberIds } = {}) {
  const ids = [...new Set((Array.isArray(memberIds) ? memberIds : []).map(String))];
  if (ids.length < 2 || ids.length > MAX_MEMBERS) throw new Error('a group needs 2–6 bots');
  for (const id of ids) {
    if (!isId(id)) throw new Error(`invalid member id: ${id}`);
    let s = null;
    try { s = sessionService.get(id); } catch { /* unknown */ }
    if (!s) throw new Error(`unknown member: ${id}`);
    if (s.kind === 'group') throw new Error('a group cannot contain another group');
  }
  const id = `grp_${crypto.randomBytes(8).toString('hex')}`;
  sessionService.ensure(id);
  const members = ids.map((memberId) => {
    const s = sessionService.get(memberId);
    return { id: memberId, title: s.title || memberId, label: s.label || '' };
  });
  const group = sessionService.setGroup(id, { name: String(name || 'Group chat'), members });
  return group;
}

function get(id) {
  const s = sessionService.get(id);
  if (!s || s.kind !== 'group') throw new Error('unknown group');
  return s;
}

function setMembers({ id, memberIds } = {}) {
  const group = get(id);
  const ids = [...new Set((Array.isArray(memberIds) ? memberIds : []).map(String))];
  if (ids.length < 2 || ids.length > MAX_MEMBERS) throw new Error('a group needs 2–6 bots');
  const members = ids.map((memberId) => {
    const s = sessionService.get(memberId);
    if (!s) throw new Error(`unknown member: ${memberId}`);
    if (s.kind === 'group') throw new Error('a group cannot contain another group');
    return { id: memberId, title: s.title || memberId, label: s.label || '' };
  });
  return sessionService.setGroup(id, { name: group.title, members });
}

/** Members mentioned with @name/@label; empty means everyone. */
function mentionedTargets(members, message, mentionIds) {
  if (Array.isArray(mentionIds) && mentionIds.length) {
    const wanted = new Set(mentionIds.map(String));
    const picked = members.filter((m) => wanted.has(m.id));
    return picked.length ? picked : members;
  }
  const text = String(message).toLowerCase();
  const picked = members.filter((m) => {
    const needles = [m.title, m.label, m.id].filter(Boolean).map((n) => `@${String(n).toLowerCase()}`);
    return needles.some((n) => text.includes(n));
  });
  return picked.length ? picked : members;
}

function groupContext(group, { limit = MAX_TURNS } = {}) {
  const turns = (group.turns ?? []).slice(-limit);
  let out = '';
  for (const turn of turns) {
    const who = turn.role === 'user' ? 'You' : (turn.author || 'Bot');
    const body = flatten(turn.content).replace(/\s+/g, ' ').slice(0, 500);
    if (!body) continue;
    out += `${who}: ${body}\n`;
  }
  return out.slice(-MAX_CONTEXT);
}

const active = new Map(); // groupId -> Set(tempSessionIds)

async function send({ id, message, mentionIds } = {}) {
  const group = get(id);
  const text = String(message ?? '').trim();
  if (!text) throw new Error('empty message');
  const members = Array.isArray(group.members) ? group.members : [];
  if (members.length < 2) throw new Error('group has no members');
  const targets = mentionedTargets(members, text, mentionIds);

  const messageId = `msg_${crypto.randomUUID()}`;
  sessionService.appendTurn(id, { role: 'user', content: text, id: messageId });
  const context = groupContext(sessionService.get(id));

  const replies = [];
  const errors = [];
  for (const member of targets) {
    const tempId = `grptmp_${crypto.randomBytes(8).toString('hex')}`;
    if (!active.has(id)) active.set(id, new Set());
    active.get(id).add(tempId);
    sessionService.ensure(tempId);
    try {
      const persona = `You are "${member.title}"${member.label ? ` (${member.label})` : ''}, one of ${members.length} bots in the group chat "${group.title}". Reply to the latest message as this bot. Be concise, stay in character, and address the group rather than one person unless asked.`;
      const prompt = `Group chat "${group.title}" transcript:\n${context}\nLatest message from the user: ${text}\n\nReply as ${member.title}.`;
      await require('./agentService').agentService.run(
        { sender: null },
        { sessionId: tempId, message: prompt, persona, memoryScope: member.id }
      );
      const temp = sessionService.get(tempId);
      const last = [...(temp.turns ?? [])].reverse().find((t) => t.role === 'assistant');
      const reply = flatten(last?.content ?? '').trim();
      if (reply) {
        const appended = sessionService.appendTurn(id, {
          role: 'assistant', content: reply, author: member.title, memberId: member.id,
        });
        const at = appended.turns?.[appended.turns.length - 1]?.at ?? Date.now();
        replies.push({ memberId: member.id, author: member.title, text: reply, at });
        emit('onReply', { groupId: id, memberId: member.id, author: member.title, text: reply, at });
      } else {
        errors.push({ memberId: member.id, error: 'empty reply' });
      }
    } catch (error) {
      errors.push({ memberId: member.id, error: String(error?.message ?? error) });
      emit('onError', { groupId: id, memberId: member.id, error: String(error?.message ?? error) });
    } finally {
      try { sessionService.remove(tempId); } catch { /* best-effort cleanup */ }
      active.get(id)?.delete(tempId);
      if (active.get(id)?.size === 0) active.delete(id);
    }
  }
  emit('onDone', { groupId: id, replied: replies.length, errors: errors.length });
  return { ok: errors.length === 0, messageId, replies, errors };
}

/** Abort the group's in-flight member turns. */
async function abort(id) {
  const temps = active.get(id);
  if (!temps?.size) return { aborted: 0 };
  let aborted = 0;
  for (const tempId of [...temps]) {
    try { await require('./agentService').agentService.abort({ sender: null }, { sessionId: tempId }); aborted += 1; }
    catch { /* already finished */ }
  }
  return { aborted };
}

module.exports = { groupService: { create, get, setMembers, send, abort, mentionedTargets, groupContext } };
