'use strict';
/* A minimal stdio MCP tool server for tests: exposes tool `add(a, b)`.
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. */
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { protocolVersion: req.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'add-server', version: '1.0.0' } },
    });
  } else if (req.method === 'notifications/initialized') {
    /* notification — no response */
  } else if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        ],
      },
    });
  } else if (req.method === 'tools/call') {
    const { a, b } = req.params.arguments ?? {};
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: String(Number(a) + Number(b)) }] },
    });
  }
});
