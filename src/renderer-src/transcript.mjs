/** Rebuild the same tool cards shown during a live run from persisted turns. */
export function transcriptItems(turns = [], baseIndex = 0) {
  const items = [];
  const tools = new Map();
  let plan = null;
  let lastTool = null;
  for (const [offset, turn] of turns.entries()) {
    const index = offset + baseIndex;
    if (turn.kind === 'screenshot' && Array.isArray(turn.content)) {
      const image = turn.content.find((part) => part.type === 'image_url')?.image_url?.url;
      const tool = turn.tool_call_id ? tools.get(turn.tool_call_id) : lastTool;
      if (image && tool) tool.image = image;
      else if (image) items.push({ kind: 'tool', key: `screenshot-${index}`, name: 'computer_screenshot', args: '', output: 'Captured screenshot', image, at: turn.at });
      continue;
    }
    // A card: an approval, a draft, an event, a notice — anything the agent
    // emitted as a typed surface rather than as prose.
    if (turn.cardKind && turn.cardType) {
      items.push({
        kind: 'card',
        key: `card-${turn.id ?? index}`,
        cardKind: turn.cardKind,
        cardType: turn.cardType,
        payload: turn.cardPayload ?? {},
        resolutionId: turn.resolutionId ?? null,
        interactionId: turn.interactionId ?? null,
        resolution: turn.resolution ?? null,
        at: turn.at,
      });
      continue;
    }
    if (turn.role === 'user' && turn.content) {
      const text = Array.isArray(turn.content)
        ? turn.content.map((part) => part.text ?? `[${part.type} attachment]`).join('\n')
        : turn.content;
      items.push({ kind: 'user', key: `user-${index}`, text, at: turn.at, id: turn.id ?? null, replyTo: turn.replyTo ?? null, reactions: turn.reactions ?? [] });
    }
    if (turn.role === 'assistant') {
      if (turn.content) items.push({ kind: 'assistant', key: `assistant-${index}`, text: turn.content, at: turn.at, id: turn.id ?? null, author: turn.author ?? null, memberId: turn.memberId ?? null, reactions: turn.reactions ?? [] });
      for (const call of turn.tool_calls ?? []) {
        const tool = { kind: 'tool', key: call.id, name: call.function.name, args: call.function.arguments, output: null, at: turn.at };
        tools.set(call.id, tool);
        items.push(tool);
      }
    }
    if (turn.role === 'tool') {
      const existing = tools.get(turn.tool_call_id);
      if (turn.name === 'update_plan') {
        try {
          plan = JSON.parse(turn.content);
          if (existing) items.splice(items.indexOf(existing), 1);
          items.push({ kind: 'plan', key: `plan-${index}`, steps: plan });
        } catch { /* Keep malformed historical results visible as tool output. */
          if (existing) existing.output = turn.content ?? '';
        }
        continue;
      }
      lastTool = existing ?? { kind: 'tool', key: turn.tool_call_id ?? `tool-${index}`, name: turn.name, args: '', at: turn.at };
      lastTool.output = turn.content ?? '';
      if (!existing) items.push(lastTool);
      if (turn.tool_call_id) tools.set(turn.tool_call_id, lastTool);
    }
  }
  return { items, plan };
}
