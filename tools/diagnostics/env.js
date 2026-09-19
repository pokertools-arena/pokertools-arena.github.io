// Minimal .env loader for the diagnostic CLI. Mirrors bin/pokertools-arena.mjs:
// the repository launcher reads .env from the working directory or package root.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJevModel, isOpenRouterConnection } from '../../src/lib/decision-core.js';

export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

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

export function redact(text, apiKey) {
  if (!apiKey) return String(text ?? '');
  return String(text ?? '').split(apiKey).join('***REDACTED***');
}
