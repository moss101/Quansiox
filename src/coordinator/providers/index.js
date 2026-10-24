'use strict';
/**
 * Provider engine — turns one logical chat turn into the right wire protocol
 * for OpenAI (chat + responses), Anthropic Messages, Google Gemini and local
 * OpenAI-compatible servers (Ollama / LM Studio). Everything funnels back into
 * the single OpenAI-shaped `{ message, usage }` the coordinator already speaks,
 * so swapping providers never touches the run loop.
 *
 * Pure functions only (no I/O) — the streaming loop lives in coordinator/index.
 */
const { detectLocalServers, localBaseUrl } = require('./local');

const PROVIDERS = {
  'openai-chat': { label: 'OpenAI (chat completions)', sse: true },
  'openai-responses': { label: 'OpenAI (responses)', sse: true },
  anthropic: { label: 'Anthropic Messages', sse: true },
  gemini: { label: 'Google Gemini', sse: true },
  ollama: { label: 'Ollama (local)', sse: true },
  lmstudio: { label: 'LM Studio (local)', sse: true },
};

/** Best-effort host extraction for a base URL (never throws). */
function hostOf(baseUrl) {
  try { return new URL(String(baseUrl)).host.toLowerCase(); } catch { return ''; }
}

/**
 * Decide which wire protocol a base URL/model pair speaks.
 * @param {string} baseUrl
 * @param {string} [model]
 * @param {object} [opts] { apiStyle } — force 'responses' to opt into it
 * @returns {{ id: string, baseUrl: string, model: string, label: string, sse: boolean }}
 */
function detectProvider(baseUrl, model, opts = {}) {
  const raw = String(baseUrl || '').trim() || 'https://api.openai.com/v1';
  const host = hostOf(raw);
  const trimmed = raw.replace(/\/$/, '');
  const pick = (id, overrideBase) => ({
    id, baseUrl: overrideBase ?? trimmed, model, label: PROVIDERS[id].label, sse: PROVIDERS[id].sse,
  });

  // Explicit provider wins (settings.provider / per-subagent job.provider).
  if (opts.provider && PROVIDERS[opts.provider]) return pick(opts.provider);
  if (/anthropic\.com$/.test(host)) return pick('anthropic');
  if (/generativelanguage\.googleapis\.com$/.test(host) || /googleapis\.com$/.test(host)) return pick('gemini');
  if (/(^|\.)ollama\b|127\.0\.0\.1:11434|localhost:11434/.test(host)) return pick('ollama', /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`);
  if (/127\.0\.0\.1:1234|localhost:1234/.test(host)) return pick('lmstudio', /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`);
  if (opts.apiStyle === 'responses') return pick('openai-responses');
  return pick('openai-chat');
}

function endpointFor(provider) {
  switch (provider.id) {
    case 'anthropic': return `${provider.baseUrl}/messages`;
    case 'gemini': return `${provider.baseUrl}/models/${encodeURIComponent(provider.model)}:streamGenerateContent?alt=sse`;
    case 'openai-responses': return `${provider.baseUrl}/responses`;
    default: return `${provider.baseUrl}/chat/completions`; // openai-chat, ollama, lmstudio
  }
}

function headersFor(provider, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.id === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
  } else if (provider.id === 'gemini') {
    if (apiKey) headers['x-goog-api-key'] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** Anthropic wants a top-level `system` and no `role: system` messages. */
function splitSystem(messages) {
  const system = messages.filter((m) => m.role === 'system' && typeof m.content === 'string').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => !(m.role === 'system' && typeof m.content === 'string'));
  return { system, rest };
}

/** Convert OpenAI tool schemas → Anthropic tool schemas. */
function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    name: t.function?.name ?? t.name,
    description: t.function?.description ?? t.description ?? '',
    input_schema: t.function?.parameters ?? t.input_schema ?? { type: 'object', properties: {} },
  }));
}

/**
 * Build the HTTP request for a chat turn.
 * @returns {{ url: string, headers: object, payload: object }}
 */
function buildRequest(provider, body, { apiKey, cachePrompt = true } = {}) {
  const { model, messages = [], tools, temperature, top_p, max_tokens } = body ?? {};
  const headers = headersFor(provider, apiKey);
  let payload;

  if (provider.id === 'anthropic') {
    const { system, rest } = splitSystem(messages);
    const anthMessages = rest.map((m) => {
      if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }] };
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const blocks = [];
        if (m.content) blocks.push({ type: 'text', text: String(m.content) });
        for (const call of m.tool_calls) {
          let input = {};
          try { input = JSON.parse(call.function?.arguments || '{}'); } catch { /* keep {} */ }
          blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
        }
        return { role: 'assistant', content: blocks };
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : m.content };
    });
    const systemBlocks = system
      ? [{ type: 'text', text: system, ...(cachePrompt ? { cache_control: { type: 'ephemeral' } } : {}) }]
      : undefined;
    payload = {
      model, messages: anthMessages, stream: true,
      ...(systemBlocks ? { system: systemBlocks } : {}),
      ...(toAnthropicTools(tools) ? { tools: toAnthropicTools(tools) } : {}),
      ...(Number.isFinite(max_tokens) ? { max_tokens } : { max_tokens: 8192 }),
      ...(Number.isFinite(temperature) ? { temperature } : {}),
      ...(Number.isFinite(top_p) ? { top_p } : {}),
    };
    return { url: endpointFor(provider), headers, payload };
  }

  if (provider.id === 'gemini') {
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }],
      }));
    const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    payload = {
      contents,
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters })) }] } : {}),
      generationConfig: { ...(Number.isFinite(temperature) ? { temperature } : {}), ...(Number.isFinite(max_tokens) ? { maxOutputTokens: max_tokens } : {}) },
    };
    return { url: endpointFor(provider), headers, payload };
  }

  if (provider.id === 'openai-responses') {
    payload = {
      model,
      input: messages.map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') })),
      stream: true,
      ...(tools?.length ? { tools: tools.map((t) => ({ type: 'function', name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters })) } : {}),
      ...(Number.isFinite(temperature) ? { temperature } : {}),
      ...(Number.isFinite(max_tokens) ? { max_output_tokens: max_tokens } : {}),
    };
    return { url: endpointFor(provider), headers, payload };
  }

  // OpenAI-compatible chat completions (OpenAI, Ollama, LM Studio, gateways).
  // Forward every caller-supplied sampling knob (temperature, top_p, seed,
  // stop, response_format, …) exactly like the pre-provider code did.
  const { model: _m, messages: _msg, tools: _t, stream: _s, ...extra } = body ?? {};
  payload = {
    model, messages, stream: true,
    ...(tools?.length ? { tools } : {}),
    ...extra,
  };
  return { url: endpointFor(provider), headers, payload };
}

/**
 * Normalize one decoded SSE payload into stream events.
 * @returns {{ deltaText?, reasoning?, toolCalls?: Array<{index,id?,name?,args?}>, usage? }}
 */
function parseEvent(provider, json) {
  if (provider.id === 'anthropic') {
    const out = {};
    if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
      out.toolCalls = [{ index: json.index ?? 0, id: json.content_block.id, name: json.content_block.name, args: '' }];
    } else if (json.type === 'content_block_delta') {
      if (json.delta?.type === 'text_delta') out.deltaText = json.delta.text;
      else if (json.delta?.type === 'thinking_delta') out.reasoning = json.delta.thinking;
      else if (json.delta?.type === 'input_json_delta') out.toolCalls = [{ index: json.index ?? 0, args: json.delta.partial_json }];
    } else if (json.type === 'message_delta' && json.usage) {
      out.usage = { prompt_tokens: json.usage.input_tokens, completion_tokens: json.usage.output_tokens, total_tokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0), ...json.usage };
    } else if (json.type === 'message_start' && json.message?.usage) {
      out.usage = { prompt_tokens: json.message.usage.input_tokens, completion_tokens: json.message.usage.output_tokens, total_tokens: (json.message.usage.input_tokens ?? 0) + (json.message.usage.output_tokens ?? 0) };
    }
    return out;
  }

  if (provider.id === 'gemini') {
    const out = {};
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.text) out.deltaText = (out.deltaText ?? '') + part.text;
      if (part.functionCall) {
        out.toolCalls = out.toolCalls ?? [];
        out.toolCalls.push({ index: out.toolCalls.length, name: part.functionCall.name, args: JSON.stringify(part.functionCall.args ?? {}) });
      }
    }
    if (json.usageMetadata) {
      out.usage = {
        prompt_tokens: json.usageMetadata.promptTokenCount,
        completion_tokens: json.usageMetadata.candidatesTokenCount,
        total_tokens: json.usageMetadata.totalTokenCount,
      };
    }
    return out;
  }

  if (provider.id === 'openai-responses') {
    const out = {};
    if (json.type === 'response.output_text.delta' && json.delta) out.deltaText = json.delta;
    if (json.type === 'response.reasoning_summary_text.delta' && json.delta) out.reasoning = json.delta;
    if (json.type === 'response.completed' && json.response?.usage) {
      out.usage = {
        prompt_tokens: json.response.usage.input_tokens,
        completion_tokens: json.response.usage.output_tokens,
        total_tokens: json.response.usage.total_tokens,
      };
    }
    return out;
  }

  // OpenAI chat completions shape (also used by Ollama/LM Studio).
  const out = {};
  if (json.usage) out.usage = json.usage;
  const delta = json.choices?.[0]?.delta;
  if (!delta) return out;
  if (delta.content) out.deltaText = delta.content;
  if (delta.reasoning_content) out.reasoning = delta.reasoning_content;
  else if (delta.reasoning) out.reasoning = delta.reasoning;
  if (delta.tool_calls) {
    out.toolCalls = delta.tool_calls.map((part) => ({ index: part.index ?? 0, id: part.id, name: part.function?.name, args: part.function?.arguments }));
  }
  return out;
}

/** Non-streaming JSON body → { message, usage } (for responses/providers). */
function parseFull(provider, json) {
  const message = { role: 'assistant', content: '' };
  if (provider.id === 'anthropic') {
    for (const block of json.content ?? []) {
      if (block.type === 'text') message.content += block.text;
      if (block.type === 'tool_use') {
        message.tool_calls = message.tool_calls ?? [];
        message.tool_calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
      }
    }
    return { message, usage: json.usage ? { prompt_tokens: json.usage.input_tokens, completion_tokens: json.usage.output_tokens, total_tokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0) } : null };
  }
  if (provider.id === 'gemini') {
    for (const part of json.candidates?.[0]?.content?.parts ?? []) {
      if (part.text) message.content += part.text;
      if (part.functionCall) {
        message.tool_calls = message.tool_calls ?? [];
        message.tool_calls.push({ id: `call_${message.tool_calls.length}`, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) } });
      }
    }
    return { message, usage: json.usageMetadata ? { prompt_tokens: json.usageMetadata.promptTokenCount, completion_tokens: json.usageMetadata.candidatesTokenCount, total_tokens: json.usageMetadata.totalTokenCount } : null };
  }
  const choice = json.choices?.[0]?.message;
  if (choice) return { message: choice, usage: json.usage ?? null };
  if (json.output_text) message.content = json.output_text;
  return { message, usage: json.usage ?? null };
}

module.exports = {
  detectProvider, buildRequest, parseEvent, parseFull, endpointFor, headersFor,
  PROVIDERS, detectLocalServers, localBaseUrl,
};
