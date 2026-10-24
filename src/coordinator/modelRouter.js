'use strict';
/**
 * Per-role model routing.
 *
 * Grok Bot is locked to one backend (Cursor/xAI) for every agent. Quansiox
 * already speaks OpenAI, Anthropic, Gemini, Ollama and LM Studio, so it can
 * do something Grok Bot cannot: route *roles* to *models*.
 *
 * A route is a full provider description:
 *
 *   {
 *     "coder":    { "baseUrl": "...", "apiKey": "...", "model": "..." },
 *     "explore":  { "model": "gemini-2.5-pro" },
 *     "reviewer": { "baseUrl": "http://localhost:11434/v1", "model": "qwen3" }
 *   }
 *
 * A route may omit `baseUrl` / `apiKey` — those then fall back to the main
 * settings, so "use Gemini for explore, same OpenAI key" is one line.
 *
 * Resolution order for a child agent:
 *   1. the model the caller asked for explicitly
 *   2. the route for the child's role
 *   3. the configured `subagentModel`
 *   4. the main model
 *
 * Pure module — no Electron, no I/O.
 */

/** Subagent type → role. */
const ROLE_BY_TYPE = {
  general: 'general',
  explore: 'explore',
  shell: 'coder',
  browser: 'explore',
  'computer-use': 'coder',
  custom: 'general',
};

/** The role a child of this type uses. */
function roleFor(type) {
  return ROLE_BY_TYPE[String(type ?? 'general')] ?? 'general';
}

/**
 * Normalize a stored route.
 * @param {object} route
 * @returns {{ baseUrl?: string, apiKey?: string, model?: string, apiStyle?: string, provider?: string }|null}
 */
function normalizeRoute(route) {
  if (!route || typeof route !== 'object') return null;
  const out = {};
  if (typeof route.baseUrl === 'string' && route.baseUrl.trim()) out.baseUrl = route.baseUrl.trim();
  if (typeof route.apiKey === 'string' && route.apiKey.trim()) out.apiKey = route.apiKey.trim();
  if (typeof route.model === 'string' && route.model.trim()) out.model = route.model.trim();
  if (typeof route.apiStyle === 'string' && route.apiStyle.trim()) out.apiStyle = route.apiStyle.trim();
  if (typeof route.provider === 'string' && route.provider.trim()) out.provider = route.provider.trim();
  return Object.keys(out).length ? out : null;
}

/**
 * Resolve the provider a child agent should use.
 *
 * @param {object} opts
 * @param {object} opts.settings      the app settings
 * @param {string} [opts.requestedModel] an explicit model from the caller
 * @param {string} [opts.type]         the subagent type
 * @param {string} [opts.name]         a custom subagent name
 * @returns {{ model: string, baseUrl: string, apiKey: string, apiStyle?: string, provider?: string, role: string, source: string }}
 *   `source` says which layer decided: explicit | route | subagent-model | main.
 */
function resolve({ settings = {}, requestedModel, type, name } = {}) {
  const role = ROLE_BY_TYPE[String(type ?? 'general')] ?? 'general';
  const routes = settings.modelRoutes && typeof settings.modelRoutes === 'object' ? settings.modelRoutes : {};
  const route = normalizeRoute(routes[role]) ?? normalizeRoute(routes[String(name ?? '')]);

  const main = {
    model: String(settings.model ?? ''),
    baseUrl: String(settings.baseUrl ?? ''),
    apiKey: String(settings.apiKey ?? ''),
    apiStyle: settings.apiStyle,
    provider: settings.provider,
  };

  if (requestedModel && String(requestedModel).trim()) {
    return { ...main, model: String(requestedModel).trim(), role, source: 'explicit' };
  }
  if (route) {
    return {
      model: route.model ?? main.model,
      baseUrl: route.baseUrl ?? main.baseUrl,
      apiKey: route.apiKey ?? main.apiKey,
      apiStyle: route.apiStyle ?? main.apiStyle,
      provider: route.provider ?? main.provider,
      role,
      source: 'route',
    };
  }
  const subagentModel = String(settings.subagentModel ?? '').trim();
  if (subagentModel) {
    return { ...main, model: subagentModel, role, source: 'subagent-model' };
  }
  return { ...main, role, source: 'main' };
}

/**
 * The route table for the settings UI.
 * @returns {Array<{ role: string, model: string, baseUrl: string, hasKey: boolean, isMain: boolean }>}
 */
function describe(settings = {}) {
  const routes = settings.modelRoutes && typeof settings.modelRoutes === 'object' ? settings.modelRoutes : {};
  const roles = new Set([...Object.keys(ROLE_BY_TYPE), ...Object.keys(routes)]);
  return [...roles].sort().map((role) => {
    const route = normalizeRoute(routes[role]);
    return {
      role,
      model: route?.model ?? '',
      baseUrl: route?.baseUrl ?? '',
      hasKey: Boolean(route?.apiKey),
      isMain: !route,
    };
  });
}

module.exports = { resolve, describe, normalizeRoute, roleFor, ROLE_BY_TYPE };
