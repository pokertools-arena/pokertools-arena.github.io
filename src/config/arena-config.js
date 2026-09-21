const BASE_CONFIG = {
  table: {
    minPlayers: 2,
    maxPlayers: 10,
    startingStack: 3_000,
    smallBlind: 25,
    bigBlind: 50,
    ante: 5,
    handsPerLevel: 8,
    blindMultiplier: 2,
  },
  timing: {
    actionSeconds: 30,
    timeBankSeconds: 30,
    lowTimeSeconds: 5,
    lowTimeFraction: 0.25,
    betweenActionsMs: 250,
    betweenHandsMs: 2_000,
  },
  limits: {
    startingStack: { min: 100 },
    smallBlind: { min: 1 },
    bigBlind: { min: 2 },
    ante: { min: 0 },
    handsPerLevel: { min: 1 },
    blindMultiplier: { min: 1.1, max: 3, step: 0.1 },
    actionSeconds: { min: 1, max: 120 },
    timeBankSeconds: { min: 0, max: 600 },
    lowTimeSeconds: { min: 0, max: 600 },
    lowTimeFraction: { min: 0, max: 1, step: 0.05 },
    betweenActionsMs: { min: 0, max: 5_000 },
    betweenHandsMs: { min: 0, max: 10_000 },
  },
  connections: {
    defaultKind: 'openai',
    siteUrl: 'https://pokertools-arena.github.io/',
    siteName: 'pokertools-arena',
    presets: {
      openai: 'https://api.openai.com/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      typesafe: 'https://api.typesafe.ai/v1/systemone',
    },
  },
  history: {
    recentDecisions: 12,
    snapshotEvents: 300,
    persistedEvents: 100,
  },
};

function mergeConfig(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return { ...base };
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      merged[key] = mergeConfig(base[key], value);
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export const ARENA_CONFIG = Object.freeze(mergeConfig(BASE_CONFIG, globalThis.__POKERTOOLS_ARENA_CONFIG__));
export const TABLE_DEFAULTS = Object.freeze(ARENA_CONFIG.table);
export const TIMING_DEFAULTS = Object.freeze(ARENA_CONFIG.timing);
export const CONFIG_LIMITS = Object.freeze(ARENA_CONFIG.limits);
export const CONNECTION_PRESETS = Object.freeze(ARENA_CONFIG.connections.presets);
export const HISTORY_CONFIG = Object.freeze(ARENA_CONFIG.history);

const FORM_DEFAULTS = Object.freeze({ ...TABLE_DEFAULTS, ...TIMING_DEFAULTS });

export function applyConfiguredFormDefaults(form) {
  for (const [name, value] of Object.entries(FORM_DEFAULTS)) {
    const input = form?.elements?.namedItem(name);
    if (!input) continue;
    input.value = String(value);
    const limits = CONFIG_LIMITS[name] || {};
    for (const attribute of ['min', 'max', 'step']) {
      if (limits[attribute] != null) input.setAttribute(attribute, String(limits[attribute]));
    }
  }
}

export function defaultConnections() {
  const kind = ARENA_CONFIG.connections.defaultKind;
  return [{ name: 'API', kind, baseUrl: CONNECTION_PRESETS[kind], apiKey: '', headers: defaultExtraHeaders(kind) }];
}

export function defaultExtraHeaders(kind) {
  if (kind !== 'openrouter') return '';
  return JSON.stringify({
    'HTTP-Referer': ARENA_CONFIG.connections.siteUrl,
    'X-OpenRouter-Title': ARENA_CONFIG.connections.siteName,
  }, null, 2);
}
