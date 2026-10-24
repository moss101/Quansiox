#!/usr/bin/env node
'use strict';
/* Minimal stdio MCP server used by test/mcp-apps.js — real JSON-RPC over
 * stdin/stdout implementing initialize, tools/list, tools/call,
 * resources/list and resources/read. */
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue; // notification
    const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
    const fail = (code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } })}\n`);
    switch (msg.method) {
      case 'initialize':
        reply({ protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'mini-mcp', version: '1.0.0' } });
        break;
      case 'tools/list':
        reply({ tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
        break;
      case 'tools/call': {
        const text = msg.params?.arguments?.text ?? '';
        reply({ content: [{ type: 'text', text: `echo:${text}` }] });
        break;
      }
      case 'resources/list':
        reply({ resources: [{ uri: 'mem://greeting', name: 'greeting', mimeType: 'text/plain' }] });
        break;
      case 'resources/read':
        if (msg.params?.uri !== 'mem://greeting') { fail(-32002, `unknown resource ${msg.params?.uri}`); break; }
        reply({ contents: [{ uri: msg.params.uri, mimeType: 'text/plain', text: 'hello resource' }] });
        break;
      default:
        fail(-32601, `method not found: ${msg.method}`);
    }
  }
});
