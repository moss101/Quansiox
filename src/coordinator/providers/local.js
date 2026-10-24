'use strict';
/**
 * Local inference discovery — Ollama and LM Studio run OpenAI-compatible
 * servers on well-known loopback ports. We probe them (short timeout, never
 * throwing) so settings can offer "use my local model" with no manual URL.
 */

const CANDIDATES = [
  { id: 'ollama', port: 11434, label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelsPath: '/models', rootPath: '' },
  { id: 'lmstudio', port: 1234, label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', modelsPath: '/models' },
];

const DEFAULT_TIMEOUT = 800;

function localBaseUrl(id) {
  const found = CANDIDATES.find((c) => c.id === id);
  return found ? found.baseUrl : null;
}

async function probe(candidate, { timeoutMs = DEFAULT_TIMEOUT, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`http://127.0.0.1:${candidate.port}/v1/models`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const models = Array.isArray(body?.data) ? body.data.map((m) => m.id).filter(Boolean) : [];
    return { id: candidate.id, label: candidate.label, baseUrl: candidate.baseUrl, port: candidate.port, models };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe every known local server in parallel.
 * @returns {Promise<Array<{id,label,baseUrl,port,models}>>} available servers
 */
async function detectLocalServers(opts = {}) {
  const results = await Promise.all(CANDIDATES.map((c) => probe(c, opts)));
  return results.filter(Boolean);
}

module.exports = { detectLocalServers, localBaseUrl, CANDIDATES, probe };
