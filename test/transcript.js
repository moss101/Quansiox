'use strict';
const assert = require('node:assert/strict');
(async () => {
  const { transcriptItems } = await import('../src/renderer-src/transcript.mjs');
  const call = (id, name) => ({ id, function: { name, arguments: '{}' } });
  const image = 'data:image/png;base64,proof';
  const turns = [
    { role: 'user', content: 'Check it' },
    { role: 'assistant', content: 'Checking', tool_calls: [call('capture', 'computer_screenshot'), call('empty', 'shell')] },
    { role: 'tool', name: 'computer_screenshot', tool_call_id: 'capture', content: 'Captured' },
    { role: 'tool', name: 'shell', tool_call_id: 'empty', content: '' },
    { role: 'user', kind: 'screenshot', tool_call_id: 'capture', content: [{ type: 'image_url', image_url: { url: image } }] },
    { role: 'assistant', tool_calls: [call('plan', 'update_plan')] },
    { role: 'tool', tool_call_id: 'plan', name: 'update_plan', content: '[{"step":"Check","status":"completed"}]' },
  ];
  const restored = transcriptItems(turns);
  assert.equal(restored.items.filter((i) => i.kind === 'tool').length, 2, 'one card per call, no pending plan duplicate');
  assert.equal(restored.items.find((i) => i.key === 'capture').image, image, 'image belongs to its call even after another tool result');
  assert.equal(restored.items.find((i) => i.key === 'empty').output, '', 'empty output is completed');
  assert.equal(restored.items.filter((i) => i.kind === 'user').length, 1, 'screenshots are not user text');
  assert.equal(restored.items.find((i) => i.kind === 'assistant').text, 'Checking');
  assert.equal(restored.plan[0].status, 'completed');
  const legacy = transcriptItems([{ role: 'tool', name: 'computer_screenshot', tool_call_id: 'old', content: 'Captured' }, { kind: 'screenshot', content: turns[4].content }]);
  assert.equal(legacy.items[0].image, image);
  console.log('TRANSCRIPT OK — tool results, screenshots, empty output and plans survive reload');
})().catch((error) => { console.error(error); process.exitCode = 1; });
