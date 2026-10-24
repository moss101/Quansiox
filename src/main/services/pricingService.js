'use strict';
/**
 * Pricing service — estimates session cost from token usage.
 * Rates are USD per 1M tokens, matched by longest model-name prefix
 * (case-insensitive, ignores vendor path prefixes like "openrouter/").
 * Users can override or add rates via settings.customPricing
 * ({ "model-pattern": { input, output } }).
 */
const { settingsService } = require('./settingsService');

// [pattern, input $/1M, output $/1M] — extend as providers evolve.
const BUILTIN = [
  ['gpt-4o-mini', 0.15, 0.6],
  ['gpt-4o', 2.5, 10],
  ['gpt-4.1-mini', 0.4, 1.6],
  ['gpt-4.1', 2.0, 8],
  ['gpt-4.1-nano', 0.1, 0.4],
  ['o3-mini', 1.1, 4.4],
  ['o4-mini', 1.1, 4.4],
  ['grok-3-mini', 0.3, 0.5],
  ['grok-3', 3.0, 15],
  ['grok-4', 3.0, 15],
  ['claude-opus-4', 15, 75],
  ['claude-sonnet-4', 3, 15],
  ['claude-haiku-4', 1, 5],
  ['claude-3-7-sonnet', 3, 15],
  ['claude-3-5-haiku', 0.8, 4],
  ['gemini-2.5-pro', 1.25, 10],
  ['gemini-2.5-flash', 0.3, 2.5],
  ['deepseek-chat', 0.27, 1.1],
  ['deepseek-reasoner', 0.55, 2.19],
  ['llama', 0, 0], // local models via Ollama/LM Studio
  ['qwen', 0, 0],
  ['mistral', 0, 0],
];

function normalize(model) {
  return String(model ?? '')
    .toLowerCase()
    .split('/')
    .pop() // use the bare model name (strip openrouter/openai/… prefixes)
    .trim();
}

/** Find { input, output, matched } rates for a model; null when unknown. */
function ratesFor(model) {
  const name = normalize(model);
  let best = null;
  const consider = (pattern, rates) => {
    const p = normalize(pattern);
    if (name.startsWith(p) && (!best || p.length > best.pattern.length)) {
      best = { pattern: p, rates };
    }
  };
  // Custom rates from settings; values may be numbers (both directions)
  // or { input, output } objects. Longest pattern wins over builtins.
  for (const [pattern, value] of Object.entries(settingsService.load().customPricing ?? {})) {
    const input = Number(typeof value === 'object' ? value.input : value) || 0;
    const output = Number(typeof value === 'object' ? value.output : value) || 0;
    consider(pattern, { input, output, custom: true });
  }
  for (const [pattern, input, output] of BUILTIN) {
    consider(pattern, { input, output });
  }
  if (!best) return null;
  return { ...best.rates, matched: best.pattern };
}

/** Estimated USD cost for a usage record {promptTokens, completionTokens}. */
function estimate(model, usage) {
  const rates = ratesFor(model);
  if (!rates) return null;
  const prompt = (usage.promptTokens ?? 0) / 1_000_000;
  const completion = (usage.completionTokens ?? 0) / 1_000_000;
  return {
    cost: prompt * rates.input + completion * rates.output,
    rates,
  };
}

module.exports = { pricingService: { ratesFor, estimate } };
