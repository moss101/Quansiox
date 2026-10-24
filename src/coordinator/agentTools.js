'use strict';
/**
 * Agent tools — the lifecycle surface the model can drive.
 *
 * The reference implementation gives the model a large agent-management
 * surface: `CreateAgent`, `UpdateAgent`, `SetPrimaryBot`, `PublishToTeam`,
 * `ConvertToTeam`, `OfferTeamAccess`, `SendToAgent`, `SendToUser`,
 * `StopSubagent`, `CreateTask`, `ReadTask`, `UpdateTask`, `UpdateState`, plus
 * the room and cloud-agent families.
 *
 * This module implements the local-first equivalents:
 *
 *   - agents are LOCAL objects with a name, an avatar, a voice and a
 *     permission mode, listed in one roster;
 *   - "publishing" means sharing inside this workspace, because a local-first
 *     app has no cloud registry to publish to;
 *   - "sending to an agent" delivers a message into that agent's conversation;
 *   - "stopping a subagent" actually kills the child's process, not just its
 *     bookkeeping.
 *
 * The tools live in their own module rather than in the coordinator's main
 * switch, so the coordinator stays readable and the surface can grow.
 */
const { agentIdentityService } = require('../main/services/agentIdentityService');
const { taskStateService } = require('../main/services/taskStateService');
const { asyncTaskService } = require('../main/services/asyncTaskService');
const { sessionService } = require('../main/services/sessionService');
const rooms = require('./rooms');

/* ------------------------------------------------------------------ tools */

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'List the agents in this workspace: their names, descriptions, avatars, voices and which one is primary.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_agent',
      description: 'Create a new named agent. Use this when the user wants a persistent helper with its own identity, not just a subagent for one turn.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'the agent\'s name, 80 characters or fewer' },
          description: { type: 'string', description: 'what this agent is for' },
          title: { type: 'string', description: 'a short role title shown in the roster' },
          avatarColor: { type: 'string', description: 'a hex colour for the avatar' },
          permissionMode: { type: 'string', enum: ['read-only', 'workspace', 'computer'], description: 'how much this agent may do' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_agent',
      description: 'Update an existing agent\'s identity, voice or permission mode.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'the agent to update' },
          name: { type: 'string' },
          description: { type: 'string' },
          title: { type: 'string' },
          avatarColor: { type: 'string' },
          voiceId: { type: 'string' },
          voiceSpeed: { type: 'number' },
          permissionMode: { type: 'string', enum: ['read-only', 'workspace', 'computer'] },
        },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_primary_agent',
      description: 'Make one agent the primary one — the agent new conversations start with.',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string' } },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'publish_agent',
      description: 'Share an agent with the whole workspace so anyone (and any other agent) can use it.',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string' } },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'convert_agent_to_team',
      description: 'Turn a personal agent into a shared one, so it can be published and used by other agents.',
      parameters: {
        type: 'object',
        properties: { agentId: { type: 'string' } },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'offer_agent_access',
      description: 'Offer a shared agent to the workspace with a note explaining who it is for.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string' },
          note: { type: 'string', description: 'who the agent is for and what it may do' },
        },
        required: ['agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_agent',
      description: 'Send a message to another agent, so it can pick the work up. Use this instead of a subagent when the agent already exists and has its own conversation.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'the agent to message' },
          message: { type: 'string', description: 'what it should do' },
        },
        required: ['agentId', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_user',
      description: 'Send a message to the user directly, outside the current conversation — for a result the user asked to be told about.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          sessionId: { type: 'string', description: 'the conversation to deliver into; defaults to the current one' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_subagent',
      description: 'Stop a running subagent. The child process is really killed, not just marked as stopped.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'the subagent id' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Add a task to the durable checklist the user sees. Use this for work that spans turns; use update_plan for a checklist inside one turn.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'what has to happen' },
          note: { type: 'string', description: 'any detail worth keeping' },
          state: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_task',
      description: 'Read one task from the durable checklist.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Update a task on the durable checklist — its state, title, note, or whether it is pinned.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          state: { type: 'string', enum: ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] },
          title: { type: 'string' },
          note: { type: 'string' },
          pinned: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List the durable checklist — the tasks that span turns.',
      parameters: { type: 'object', properties: { includeDone: { type: 'boolean' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_state',
      description: 'Rewrite the structured state summary for this conversation (what is done, what is next, what is blocked).',
      parameters: {
        type: 'object',
        properties: { state: { type: 'object', description: 'the state object' } },
        required: ['state'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_async_tasks',
      description: 'List the long-running background work: builds, crawls and batch jobs that are still going.',
      parameters: { type: 'object', properties: { includeFinished: { type: 'boolean' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_room',
      description: 'Create a room: a bounded conversation several agents take turns in. Use it when two or more agents must talk to each other, not just report to you.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          members: { type: 'array', items: { type: 'string' }, description: 'the agent ids taking part' },
        },
        required: ['members'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'room_status',
      description: 'What a room knows: its members, the turns taken, the messages said and whether it is winding down.',
      parameters: {
        type: 'object',
        properties: { roomId: { type: 'string' } },
        required: ['roomId'],
      },
    },
  },
];

/* ------------------------------------------------- the flat tool family */

/**
 * The flat family, exposed as tools.
 *
 * These are the deterministic file tools: no policy machinery, no
 * background promotion, precise reporting. They are confined to the
 * workspace exactly like the rich tools are.
 */
const FLAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'pi_read',
      description: 'Read a file as text, with a line range. Unlike read_file, this reports exactly how much of the file it returned, so you know if you saw all of it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'the file to read' },
          offset: { type: 'number', description: 'the first line to return (0-based)' },
          limit: { type: 'number', description: 'how many lines to return' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pi_ls',
      description: 'List a directory. Reports whether the listing was cut short.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'the directory to list' },
          limit: { type: 'number' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pi_find',
      description: 'Find files by name. Reports whether the result was cut short.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'the name fragment to look for' },
          path: { type: 'string', description: 'where to look' },
          limit: { type: 'number' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pi_grep',
      description: 'Search inside files. Reports whether matches or lines were cut short.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'the pattern to search for (a regular expression unless literal is set)' },
          path: { type: 'string', description: 'where to search' },
          glob: { type: 'string', description: 'only files whose name matches this glob' },
          ignoreCase: { type: 'boolean' },
          literal: { type: 'boolean', description: 'treat the pattern as plain text' },
          context: { type: 'number', description: 'lines of context around a match' },
          limit: { type: 'number' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pi_write',
      description: 'Write a file. The write is atomic — a crash cannot leave a half-written file. Can be rejected.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pi_edit',
      description: 'Apply exact edits to a file and get the unified diff back. Can be rejected when the text is ambiguous.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pi_bash',
      description: 'Run a shell command and get the output. Same sandbox and permissions as shell, but the output says exactly how much was returned.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number', description: 'milliseconds' },
        },
        required: ['command'],
      },
    },
  },
];

/** Format a flat result for the model. */
function formatFlat(result) {
  if (!result) return 'no result';
  if (result.ok === false) return `refused: ${result.reason}`;
  const lines = [];
  if (result.output) lines.push(result.output);
  if (result.diff) lines.push(result.diff);
  if (result.truncation) {
    const t = result.truncation;
    if (t.truncated) {
      lines.push(`[truncated by ${t.truncated_by}: showed ${t.output_lines}/${t.total_lines} lines, ${t.output_bytes} bytes`
        + `${t.last_line_partial ? ', the last line is cut' : ''}]`);
    }
  }
  if (result.matchLimitReached) lines.push('[the match limit was reached — there are more matches]');
  if (result.linesTruncated) lines.push('[the file was not searched to the end]');
  if (result.resultLimitReached) lines.push('[the result limit was reached — there are more matches]');
  if (result.entryLimitReached) lines.push('[the directory listing was cut short]');
  if (result.totalLines != null) lines.push(`[${result.offset ?? 0}–${(result.offset ?? 0) + (result.output ? result.output.split('\n').length : 0)} of ${result.totalLines} lines]`);
  return lines.join('\n');
}

/* ---------------------------------------------------------------- handlers */

function json(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * Handle an agent-lifecycle tool call.
 *
 * @param {string} name
 * @param {object} args
 * @param {object} ctx  { sessionId, agentId, taskControl, signal, boardRoot }
 * @returns {Promise<string|null>} the tool result, or null when the tool is
 *   not one of ours (so the caller can fall through to its own dispatch).
 */
async function executeAgentTool(name, args = {}, ctx = {}) {
  const sessionId = ctx.sessionId ?? '';
  switch (name) {
    case 'list_agents': {
      const agents = agentIdentityService.list();
      if (!agents.length) return 'no agents yet — create one with create_agent';
      return agents.map((a) => [
        `- ${a.name}${a.primary ? ' (primary)' : ''}${a.published ? ' (shared)' : ''} [${a.id}]`,
        a.description ? `  ${a.description}` : '',
        `  mode: ${a.permissionMode} · conversations: ${a.sessionIds.length}`,
      ].filter(Boolean).join('\n')).join('\n');
    }

    case 'create_agent': {
      const agent = agentIdentityService.create({
        name: args.name,
        description: args.description,
        title: args.title,
        avatarColor: args.avatarColor,
        permissionMode: args.permissionMode,
      });
      // The new agent starts in the current conversation, so it has somewhere
      // to work.
      agentIdentityService.attachSession(agent.id, sessionId);
      return `created agent "${agent.name}" [${agent.id}]`;
    }

    case 'update_agent': {
      const agent = agentIdentityService.update(args.agentId, args);
      return `updated agent "${agent.name}" [${agent.id}]`;
    }

    case 'set_primary_agent': {
      const agent = agentIdentityService.setPrimary(args.agentId);
      return `"${agent.name}" is now the primary agent`;
    }

    case 'publish_agent': {
      const agent = agentIdentityService.publish(args.agentId);
      return `agent "${agent.name}" is now shared with this workspace`;
    }

    case 'convert_agent_to_team': {
      const agent = agentIdentityService.convertToTeam(args.agentId);
      return `agent "${agent.name}" is now a shared agent`;
    }

    case 'offer_agent_access': {
      const agent = agentIdentityService.offerAccess(args.agentId, { note: args.note });
      return `offered "${agent.name}" to the workspace${agent.accessNote ? `: ${agent.accessNote}` : ''}`;
    }

    case 'send_to_agent': {
      const agent = agentIdentityService.get(args.agentId);
      if (!agent) return `unknown agent: ${args.agentId}`;
      const target = agent.sessionIds[0] ?? sessionId;
      if (!target) return `agent "${agent.name}" has no conversation to deliver into`;
      sessionService.appendTurn(target, {
        role: 'user',
        content: String(args.message ?? ''),
        fromAgent: ctx.agentId ?? null,
      });
      return `sent a message to "${agent.name}" (conversation ${target})`;
    }

    case 'send_to_user': {
      const target = String(args.sessionId ?? sessionId);
      if (!target) return 'there is no conversation to deliver into';
      sessionService.appendTurn(target, {
        role: 'user',
        content: String(args.message ?? ''),
        fromAgent: ctx.agentId ?? null,
      });
      return `sent a message to the user (conversation ${target})`;
    }

    case 'stop_subagent': {
      const result = await stopSubagent(args.id, ctx);
      return result;
    }

    case 'create_task': {
      const task = taskStateService.createTask({
        title: args.title,
        note: args.note,
        state: args.state,
        scope: ctx.agentId ?? sessionId,
      });
      return `created task "${task.title}" [${task.id}]`;
    }

    case 'read_task': {
      const task = taskStateService.getTask(args.id);
      if (!task) return `unknown task: ${args.id}`;
      return json(task);
    }

    case 'update_task': {
      const task = taskStateService.updateTask(args.id, args);
      return `task "${task.title}" is now ${task.state}`;
    }

    case 'list_tasks': {
      const tasks = taskStateService.listTasks({
        scope: ctx.agentId ?? sessionId,
        includeDone: args.includeDone !== false,
      });
      if (!tasks.length) return 'the checklist is empty';
      return tasks.map((t) => `- [${t.state}] ${t.title}${t.pinnedAtMs ? ' 📌' : ''} [${t.id}]`).join('\n');
    }

    case 'update_state': {
      const result = taskStateService.updateState({
        scope: ctx.agentId ?? sessionId,
        state: args.state ?? {},
      });
      return `state updated (${result.scope})`;
    }

    case 'list_async_tasks': {
      const tasks = asyncTaskService.list({ includeFinished: args.includeFinished !== false });
      if (!tasks.length) return 'no background work is running';
      return tasks.map((t) => `- ${t.status.padEnd(9)} ${t.title || t.kind} [${t.id}]`).join('\n');
    }

    case 'create_room': {
      const members = Array.isArray(args.members) ? args.members.map(String) : [];
      const room = rooms.createRoom({ members, title: args.title });
      return `created room "${room.title || room.id}" with members: ${room.members.join(', ')} [${room.id}]`;
    }

    case 'room_status': {
      const room = rooms.getRoom(args.roomId);
      if (!room) return `unknown room: ${args.roomId}`;
      const said = rooms.messages(args.roomId);
      return [
        `room ${room.id}${room.title ? ` "${room.title}"` : ''}`,
        `members: ${room.members.join(', ')}`,
        `rounds: ${room.rounds} · winding down: ${room.windingDown ? 'yes' : 'no'}`,
        'messages:',
        ...said.map((m) => `  ${m.speakerName}: ${String(m.text ?? '').slice(0, 300)}`),
      ].join('\n');
    }

    default:
      return null;
  }
}

/**
 * Handle a flat-family tool call.
 *
 * The flat tools are confined to the workspace exactly like the rich ones:
 * the path is resolved through the same `execService.resolveInWorkspace`.
 */
async function executeFlatTool(name, args = {}, ctx = {}) {
  const flat = require('./flatTools');
  const cwd = ctx.cwd ?? process.cwd();
  const execService = require('../main/services/execService');
  const resolve = (p) => execService.resolveInWorkspace(p, cwd);

  switch (name) {
    case 'pi_read': {
      const result = flat.piRead({ path: resolve(args.path), offset: args.offset, limit: args.limit });
      return formatFlat(result);
    }
    case 'pi_ls': {
      const result = flat.piLs({ path: resolve(args.path || '.'), limit: args.limit });
      return formatFlat(result);
    }
    case 'pi_find': {
      const result = flat.piFind({ pattern: args.pattern, path: resolve(args.path || '.'), limit: args.limit });
      return formatFlat(result);
    }
    case 'pi_grep': {
      const result = flat.piGrep({
        pattern: args.pattern,
        path: resolve(args.path || '.'),
        glob: args.glob,
        ignoreCase: args.ignoreCase,
        literal: args.literal,
        context: args.context,
        limit: args.limit,
      });
      return formatFlat(result);
    }
    case 'pi_write': {
      const result = flat.piWrite({ path: resolve(args.path), content: args.content });
      return formatFlat(result);
    }
    case 'pi_edit': {
      const result = flat.piEdit({ path: resolve(args.path), edits: args.edits });
      return formatFlat(result);
    }
    case 'pi_bash': {
      const result = await flat.piBash({
        command: args.command,
        timeout: args.timeout,
        run: (command, opts) => execService.run(command, cwd, opts.timeout ?? 120_000, { sandbox: true, workspace: cwd }),
      });
      return formatFlat(result);
    }
    default:
      return null;
  }
}

/**
 * Stop a running subagent — really stopping it.
 *
 * The reference's `StopSubagent` is a message to the coordinator; the local
 * equivalent has to reach the child's own abort tree, or the child keeps
 * running and burning tokens.
 */
async function stopSubagent(id, ctx = {}) {
  const target = String(id ?? '');
  if (!target) return 'stop_subagent needs an id';
  try {
    const { taskStore } = require('./task-store');
    const job = taskStore.get(target, ctx.sessionId);
    if (!job) return `unknown subagent: ${target}`;
    // The abort tree kills the child's process, not just its bookkeeping.
    const { abortTree } = require('./abortTree');
    abortTree(job.runSessionId ?? job.id ?? target);
    taskStore.update(target, { status: 'aborted', aborted: true, finishedAt: Date.now() }, ctx.sessionId);
    return `stopped subagent ${target}`;
  } catch (error) {
    return `could not stop subagent ${target}: ${String(error?.message ?? error).slice(0, 200)}`;
  }
}

module.exports = { AGENT_TOOLS, FLAT_TOOLS, executeAgentTool, executeFlatTool, formatFlat, stopSubagent };
