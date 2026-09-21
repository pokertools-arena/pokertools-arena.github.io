// Minimal .env loader for the diagnostic CLI. Mirrors bin/pokertools-arena.mjs:
// the repository launcher reads .env from the working directory or package root.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJevModel, isOpenRouterConnection, modelsUrl, makeHeaders, registerModelCapabilities } from '../../src/lib/decision-core.js';
export { parseDotEnv } from '../shared/dotenv.mjs';
import { parseDotEnv } from '../shared/dotenv.mjs';

export async function loadDotEnv({ cwd = process.cwd() } = {}) {
  const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const candidates = [...new Set([resolve(cwd, '.env'), join(packageRoot, '.env')])];
  for (const candidate of candidates) {
    try { return { source: candidate, values: parseDotEnv(await readFile(candidate, 'utf8')) }; } catch {}
  }
  return { source: null, values: {} };
}

export async function resolveConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const loaded = await loadDotEnv({ cwd });
  const source = loaded.values;
  const baseUrl = String(source.OPENAI_BASE_URL || env.OPENAI_BASE_URL || '').trim();
  const apiKey = String(source.OPENAI_API_KEY || env.OPENAI_API_KEY || '').trim();
  const models = [];
  for (let i = 1; i <= 10; i++) {
    const model = String(source[`OPENAI_PLAYER${i}`] || env[`OPENAI_PLAYER${i}`] || '').trim();
    if (model) models.push({ index: i, model });
  }
  const resolvedBase = baseUrl || 'https://api.openai.com/v1';
  let openRouter = false;
  try { openRouter = new URL(resolvedBase).hostname.includes('openrouter.ai'); } catch {}
  const connection = {
    id: 'diagnostics-connection',
    name: openRouter ? 'OpenRouter' : 'OpenAI-compatible',
    kind: openRouter ? 'openrouter' : 'openai',
    baseUrl: resolvedBase,
    apiKey,
    headers: '',
  };
  // Guard against accidentally treating a secret as a model id in reports.
  return { envSource: loaded.source, baseUrl: resolvedBase, hasApiKey: Boolean(apiKey), connection, models, isOpenRouter: openRouter || isOpenRouterConnection(connection) };
}

export function adapterProtocol(model) { return isJevModel(model) ? 'jev_decisions' : 'chat'; }

// Best-effort capability priming for the shared decision core: OpenRouter
// advertises per-model `supported_parameters`, which lets requests omit
// optional parameters (currently `temperature`) that a model's endpoints do not
// support while `require_parameters: true` keeps structural parameters honest.
// Any failure is silent; requests then keep the historical default.
export async function primeModelCapabilities(connection, { fetchImpl = globalThis.fetch } = {}) {
  if (!connection?.baseUrl || typeof fetchImpl !== 'function') return false;
  try {
    const response = await fetchImpl(modelsUrl(connection.baseUrl), { method: 'GET', headers: makeHeaders(connection) });
    if (!response?.ok) return false;
    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload?.data) ? payload.data : [];
    registerModelCapabilities(models);
    return models.length > 0;
  } catch { return false; }
}

export function redact(text, apiKey) {
  if (!apiKey) return String(text ?? '');
  return String(text ?? '').split(apiKey).join('***REDACTED***');
}
