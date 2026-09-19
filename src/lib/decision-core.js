// Pure decision core shared by the browser arena and the Node diagnostic
// harness. This module intentionally has no DOM dependency so regression tests
// and the real-API diagnostic script can exercise the exact production
// action-space construction, state serialization and request formats.
import { getCardCodes, rank, rankDescription, HAND_RANK_DESCRIPTIONS } from '@pokertools/evaluator';

export const ACTION = Object.freeze({
  FOLD: 'FOLD', CHECK: 'CHECK', CALL: 'CALL', BET: 'BET', RAISE: 'RAISE',
  SHOW: 'SHOW', MUCK: 'MUCK', TIME_BANK: 'TIME_BANK',
});

export const DECISION_CONTEXT_VERSION = 3;
export const RECENT_PUBLIC_HANDS = 8;
export const DECISION_OBJECTIVE = 'Choose exactly one legal action that best maximizes tournament chip EV from the supplied state. Use only the information in this state and only an actionId present in legalActions.';
export const INFORMATION_POLICY = Object.freeze({
  private: 'hero hole cards only',
  public: 'board, pot, blinds, stacks, positions, current-hand actions, recent public hand history, public player statistics, and legal actions',
  excluded: 'opponent hole cards, other agents reasoning, model outputs, API/provider metadata, hidden deck state, and future cards',
});

export function asNumber(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
export function round(n, digits = 2) { const f = 10 ** digits; return Math.round(asNumber(n) * f) / f; }
export function clamp(n, min, max) { return Math.min(max, Math.max(min, asNumber(n, min))); }

export function summarizeError(err) {
  if (!err) return 'Unknown error';
  if (err.name === 'AbortError') return 'Request aborted or timed out';
  return String(err.message || err).slice(0, 500);
}

export class ArenaRequestError extends Error {
  constructor(message, { status = null, category = 'provider', payload = null, incidents = [] } = {}) {
    super(message);
    this.name = 'ArenaRequestError';
    this.status = status;
    this.category = category;
    this.payload = payload;
    this.incidents = incidents;
  }
}
export function requestErrorCategory(status) {
  if (Number(status) === 429) return 'rate_limit';
  return 'provider';
}
export function decisionErrorCategory(err) {
  if (err?.name === 'AbortError') return 'timeout';
  if (err?.category) return err.category;
  return 'model';
}
export function retryDelayMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(1000, Math.max(100, seconds * 1000));
  return 250;
}
export function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(done, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    function cleanup() { signal?.removeEventListener?.('abort', abort); }
    function done() { cleanup(); resolve(); }
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}
export async function fetchJsonWithRetry(url, options, { maxRetries = 1 } = {}) {
  const incidents = [];
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) diagnosticsCounters.retries++;
    diagnosticsCounters.requests++;
    let response;
    try { response = await fetch(url, options); }
    catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ArenaRequestError(summarizeError(err), { category: 'provider', incidents });
    }
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return { response, payload, incidents, retryCount: attempt };
    const message = payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`;
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxRetries) {
      if (response.status === 429) diagnosticsCounters.rateLimits++; else diagnosticsCounters.providerErrors++;
      incidents.push({ category: requestErrorCategory(response.status), status: response.status, message: String(message).slice(0, 180) });
      await sleepWithSignal(retryDelayMs(response), options?.signal);
      continue;
    }
    if (response.status === 429) diagnosticsCounters.rateLimits++; else if (response.status >= 500) diagnosticsCounters.providerErrors++;
    throw new ArenaRequestError(message, { status: response.status, category: requestErrorCategory(response.status), payload, incidents });
  }
}
export function isUnsupportedToolChoiceError(err) {
  const message = summarizeError(err);
  return [400, 404, 422].includes(Number(err?.status)) && /tool[_ -]?choice|tool call|tools?.*(?:unsupported|support)|no endpoints?.*support/i.test(message);
}
export function mapGet(mapish, key, fallback = 0) {
  if (mapish instanceof Map) return mapish.get(key) ?? fallback;
  if (Array.isArray(mapish)) {
    const pair = mapish.find(x => Array.isArray(x) && Number(x[0]) === Number(key));
    return pair ? pair[1] : fallback;
  }
  if (mapish && typeof mapish === 'object') return mapish[key] ?? mapish[String(key)] ?? fallback;
  return fallback;
}
export function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, v) => v instanceof Map ? Object.fromEntries(v) : v));
  } catch {
    return { unserializable: true };
  }
}

// Remembers that an OpenRouter endpoint rejected tool_choice so later hands go
// straight to JSON Schema. Shared so browser and diagnostics behave identically.
export const protocolCapabilityCache = new Map();

// Process-local counters for the diagnostics harness. They make the real
// request/retry counts explicit without changing any request behaviour.
export const diagnosticsCounters = { requests: 0, retries: 0, rateLimits: 0, providerErrors: 0 };

export function normalizeBaseUrl(baseUrl) { return String(baseUrl || '').trim().replace(/\/+$/, ''); }
export function completionsUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}
export function openRouterDecisionsUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (/\/api\/alpha\/decisions$/i.test(base)) return base;
  try {
    const url = new URL(base);
    if (url.hostname.includes('openrouter.ai')) return `${url.origin}/api/alpha/decisions`;
  } catch {}
  return `${base.replace(/\/api\/v1$/i, '')}/api/alpha/decisions`;
}
export function isOpenRouterConnection(connection) {
  if (connection?.kind === 'openrouter') return true;
  try { return new URL(connection?.baseUrl || '').hostname.includes('openrouter.ai'); } catch { return false; }
}
export function isJevModel(model) {
  return /^~?typesafe\/jev(?:-|$)/i.test(String(model || '').trim()) || /^jev(?:-|$)/i.test(String(model || '').trim());
}
export function isReasoningModel(model) {
  const id = String(model || '').toLowerCase();
  return /(?:^|[\/._:-])(qwen3|qwq|deepseek-(?:r1|v3)|magistral|glm-4|gpt-oss|nemotron|reason(?:ing)?|thinking|o1|o3|o4)(?:$|[\/._:-])/.test(id);
}
export function effectiveProtocol(agent, connection) {
  if (isOpenRouterConnection(connection) && isJevModel(agent?.model)) return 'jev_decisions';
  if (connection?.kind === 'typesafe') return 'jev_native';
  return agent?.protocol || 'tool';
}
export function modelsUrl(baseUrl) {
  let base = normalizeBaseUrl(baseUrl);
  base = base.replace(/\/chat\/completions$/i, '');
  try {
    const url = new URL(base);
    if (url.hostname.includes('openrouter.ai')) return `${url.origin}/api/v1/models?limit=1000&offset=0`;
  } catch {}
  return `${base}/models`;
}
export function parseHeaders(text) {
  if (!String(text || '').trim()) return {};
  const obj = JSON.parse(text);
  if (!obj || Array.isArray(obj) || typeof obj !== 'object') throw new Error('Extra headers must be a JSON object');
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [String(k), String(v)]));
}
export function makeHeaders(connection) {
  const headers = { 'Content-Type': 'application/json', ...parseHeaders(connection.headers) };
  if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
  try {
    if (new URL(connection.baseUrl).hostname.includes('openrouter.ai')) {
      headers['X-OpenRouter-Title'] = 'pokertools-arena';
      const loc = typeof location !== 'undefined' ? location : null;
      if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) headers['HTTP-Referer'] = loc.href;
    }
  } catch {}
  return headers;
}
export function combineAbort(timeoutMs, outerSignal, pauseClock) {  const controller = new AbortController();
  let timer = null;
  const abort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', abort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    if (!pauseClock) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    } else {
      // Count only active (unpaused) time toward the action deadline, so a
      // paused tournament genuinely returns the paused time to the model
      // instead of letting the request time out while the table is frozen.
      let activeMs = 0;
      let last = Date.now();
      const tick = () => {
        const now = Date.now();
        if (!pauseClock.pausedAt) activeMs += now - last;
        last = now;
        if (activeMs >= timeoutMs) { controller.abort(); return; }
        timer = setTimeout(tick, Math.min(200, Math.max(20, timeoutMs - activeMs)));
      };
      timer = setTimeout(tick, Math.min(200, timeoutMs));
    }
  }
  return {
    signal: controller.signal,
    cancel() {
      if (timer) clearTimeout(timer);
      outerSignal?.removeEventListener?.('abort', abort);
    },
  };
}

// Single canonical clock/ring phase used by the spectator seat ring and the
// decision clock. Both are derived from this one function so the ring can never
// disagree with the displayed number. All thresholds come from configuration.
export function decisionClockPhase({ baseMs = 0, timeBankMs = 0, elapsedMs = 0, lowTimeMs = 5000, lowTimeFraction = 0.25 } = {}) {
  const base = Math.max(0, asNumber(baseMs));
  const bank = Math.max(0, asNumber(timeBankMs));
  const elapsed = Math.max(0, asNumber(elapsedMs));
  const baseLeft = Math.max(0, base - elapsed);
  const bankUsed = Math.max(0, elapsed - base);
  const bankLeft = Math.max(0, bank - bankUsed);
  // The visible clock and the ring share one phase: base action time, then the
  // time bank. They must never be computed against different totals.
  const inBank = base <= 0 || elapsed >= base;
  const phaseTotal = inBank ? bank : base;
  const phaseRemaining = inBank ? bankLeft : baseLeft;
  const shownMs = inBank ? bankLeft : baseLeft;
  const lowSecondsMs = Math.max(0, asNumber(lowTimeMs));
  const lowFraction = clamp(lowTimeFraction, 0, 1);
  const lowThreshold = phaseTotal > 0 ? Math.min(lowSecondsMs, phaseTotal * lowFraction) : 0;
  const ringFraction = phaseTotal > 0 ? clamp(phaseRemaining / phaseTotal, 0, 1) : 0;
  return {
    baseLeft, bankLeft, inBank, phaseTotal, phaseRemaining, shownMs, lowThreshold, ringFraction,
    isLow: phaseTotal > 0 && phaseRemaining > 0 && phaseRemaining <= lowThreshold,
  };
}

export function playerCards(player) {
  if (!player) return [];
  const raw = player.cards ?? player.holeCards ?? player.hand ?? [];
  return Array.isArray(raw) ? raw.filter(Boolean).map(String) : [];
}
export function playerStack(player) { return asNumber(player?.stack ?? player?.chips ?? 0); }
export function currentBet(state, seat) { return asNumber(mapGet(state?.currentBets, seat, state?.players?.[seat]?.bet ?? 0)); }
export function totalPot(state) {
  const pots = Array.isArray(state?.pots) ? state.pots : [];
  const settled = pots.reduce((sum, p) => sum + asNumber(p?.amount ?? p?.size ?? 0), 0);
  let live = 0;
  const bets = state?.currentBets;
  if (bets instanceof Map) for (const amount of bets.values()) live += asNumber(amount);
  else if (Array.isArray(bets)) for (const entry of bets) live += asNumber(Array.isArray(entry) ? entry[1] : entry?.amount);
  else if (bets && typeof bets === 'object') for (const amount of Object.values(bets)) live += asNumber(amount);
  return settled + live;
}
export function clockwiseSeats(state) {
  const seated = (state?.players ?? []).map((p, seat) => ({ p, seat }))
    .filter(({ p }) => p && p.status !== 'BUSTED' && p.status !== 'SITTING_OUT')
    .map(({ seat }) => seat).sort((a, b) => a - b);
  if (!seated.length || state?.buttonSeat == null) return seated;
  const idx = seated.indexOf(state.buttonSeat);
  if (idx < 0) return seated;
  return [...seated.slice(idx), ...seated.slice(0, idx)];
}
export const POSITION_TABLE = {
  2: ['BTN/SB', 'BB'], 3: ['BTN', 'SB', 'BB'], 4: ['BTN', 'SB', 'BB', 'UTG'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'], 6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'HJ', 'CO'], 8: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'MP+1', 'HJ', 'CO'],
  10: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO'],
};
export function positionForSeat(state, seat) {
  const order = clockwiseSeats(state);
  const labels = POSITION_TABLE[order.length] ?? order.map((_, i) => i === 0 ? 'BTN' : `P${i}`);
  const idx = order.indexOf(seat);
  return idx >= 0 ? labels[idx] : `Seat ${seat + 1}`;
}
export function describeAction(type, amount, state, seat = null) {
  const bb = Math.max(1, asNumber(state.bigBlind, 1));
  const heroBet = seat == null ? 0 : Math.max(0, currentBet(state, seat));
  const highestBet = Math.max(0, ...(state.players ?? []).map((_, s) => currentBet(state, s)));
  const toCall = Math.max(0, highestBet - heroBet);
  const stack = seat == null ? 0 : Math.max(0, playerStack(state.players?.[seat]));
  switch (type) {
    case ACTION.FOLD: return 'Fold';
    case ACTION.CHECK: return 'Check';
    case ACTION.CALL: {
      if (!toCall) return 'Call';
      const effective = Math.min(stack, toCall);
      const suffix = effective < toCall ? ' (all-in)' : '';
      return `Call ${effective}${suffix} (${round(effective / bb, 1)} BB)`;
    }
    case ACTION.BET: return `Bet ${amount} (${round(amount / bb, 1)} BB)`;
    case ACTION.RAISE: {
      const maxTotal = heroBet + stack;
      if (seat != null && amount >= maxTotal) return `Raise to ${maxTotal} (all-in)`;
      return `Raise to ${amount} (${round(amount / bb, 1)} BB)`;
    }
    default: return type;
  }
}
export function tryCandidate(engine, seat, playerId, type, amount, out, seen) {
  const action = { type, playerId };
  if (amount != null) action.amount = Math.max(1, Math.round(amount));
  let validation;
  try { validation = engine.validate(action); } catch { return; }
  if (!validation?.valid) return;
  const key = `${type}:${action.amount ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ id: `A${out.length}`, type, amount: action.amount ?? null, description: describeAction(type, action.amount, engine.state, seat), engineAction: action });
}
export function legalActionCandidates(engine, seat) {
  const state = engine.state;
  const player = state.players?.[seat];
  if (!player) return [];
  const out = [], seen = new Set();
  const stack = Math.max(0, playerStack(player));
  const bet = Math.max(0, currentBet(state, seat));
  const bb = Math.max(1, asNumber(state.bigBlind, 1));
  const sb = Math.max(1, asNumber(state.smallBlind, Math.ceil(bb / 2)));
  const pot = Math.max(bb, totalPot(state));
  const minRaise = Math.max(1, asNumber(state.minRaise, bb));
  const highestBet = Math.max(0, ...(state.players ?? []).map((_, s) => currentBet(state, s)));
  const lastRaise = Math.max(bb, asNumber(state.lastRaiseAmount, bb));
  const toCall = Math.max(0, highestBet - bet);
  // FOLD is strictly dominated by CHECK when checking costs nothing: checking
  // preserves every showdown and future-betting outcome, while folding forfeits
  // the hand for free. Never expose the dominated option to a decision model.
  const passiveTypes = [ACTION.FOLD, ACTION.CHECK, ACTION.CALL].filter(type => !(type === ACTION.FOLD && toCall === 0));
  for (const type of passiveTypes) tryCandidate(engine, seat, player.id, type, null, out, seen);
  // PokerTools player.stack is the uncommitted stack; an aggressive amount is a total
  // contribution on the street, so it must never exceed currentBet + remaining stack.
  const maxTotal = bet + stack;
  const effectiveCall = Math.min(stack, toCall);
  const call = out.find(a => a.type === ACTION.CALL);
  if (call && toCall > 0) {
    const suffix = effectiveCall < toCall ? ' (all-in)' : '';
    call.description = `Call ${effectiveCall}${suffix} (${round(effectiveCall / bb, 1)} BB)`;
  }

  // BET and RAISE are mutually exclusive semantic choices. Once any wager exists on
  // the street (including blinds preflop), further aggression is a RAISE, not a BET.
  // Arena-side semantic guards intentionally sit on top of engine.validate(): a short
  // stack that cannot reach the current price must only see CALL/FOLD, never a pseudo-raise.
  const aggressiveType = highestBet > 0 ? ACTION.RAISE : ACTION.BET;
  const minRaiseTo = highestBet + minRaise;
  const canAggress = aggressiveType === ACTION.BET ? stack > 0 : maxTotal > highestBet && maxTotal >= minRaiseTo;
  const rawAmounts = [
    sb, bb, 2 * bb, 2.5 * bb, 3 * bb, 4 * bb, minRaiseTo, highestBet + lastRaise,
    highestBet * 2, highestBet + Math.round(pot * 0.33), highestBet + Math.round(pot * 0.5), highestBet + Math.round(pot * 0.75),
    highestBet + pot, Math.round(pot * 0.33), Math.round(pot * 0.5), Math.round(pot * 0.75), pot, maxTotal,
  ].filter(n => Number.isFinite(n) && n > 0 && n <= maxTotal && (aggressiveType !== ACTION.RAISE || n > highestBet));
  const amounts = [...new Set(rawAmounts.map(n => Math.max(1, Math.round(n))))].sort((a, b) => a - b);
  if (canAggress) for (const amount of amounts) tryCandidate(engine, seat, player.id, aggressiveType, amount, out, seen);

  const passive = out.filter(a => ![ACTION.BET, ACTION.RAISE].includes(a.type));
  const aggressive = out.filter(a => [ACTION.BET, ACTION.RAISE].includes(a.type));
  const selected = [];
  if (aggressive.length <= 6) selected.push(...aggressive);
  else {
    const picks = [0, 1, Math.floor((aggressive.length - 1) * 0.33), Math.floor((aggressive.length - 1) * 0.66), aggressive.length - 2, aggressive.length - 1];
    for (const idx of [...new Set(picks)]) if (aggressive[idx]) selected.push(aggressive[idx]);
  }
  return [...passive, ...selected].map((a, index) => ({ ...a, id: `A${index}` }));
}
export function fallbackAction(legalActions) {
  for (const type of [ACTION.CHECK, ACTION.FOLD, ACTION.CALL]) {
    const found = legalActions.find(a => a.type === type);
    if (found) return found;
  }
  return legalActions[0] ?? null;
}

export function serializeForAgent(engine, seat, tournamentMeta, legalActions, recentHands = [], publicPlayerStats = [], actionHistory = []) {
  const full = engine.state;
  const player = full.players?.[seat];
  if (!player?.id) throw new Error(`Cannot build decision context: no player at seat ${seat}`);
  // Fail closed. A failed player view must never fall back to the omniscient server state.
  const view = engine.view(player.id);
  const vp = view?.players?.[seat];
  if (!vp) throw new Error(`Cannot build masked decision context for ${player.id}`);
  const stack = playerStack(vp);
  const bb = Math.max(1, asNumber(full.bigBlind, 1));
  const eliminated = new Set(tournamentMeta.eliminatedPlayerIds ?? []);
  return {
    contextVersion: DECISION_CONTEXT_VERSION,
    informationPolicy: INFORMATION_POLICY,
    objective: DECISION_OBJECTIVE,
    game: 'No-Limit Texas Holdem tournament',
    memoryPolicy: {
      currentHand: 'all public model actions in the current hand before this decision',
      recentHands: `last ${RECENT_PUBLIC_HANDS} completed public hands`,
      publicPlayerStats: 'deterministic aggregates from completed hands before the current hand; identical public dataset for every seat',
    },
    tournament: { handNumber: tournamentMeta.handNumber, blindLevel: asNumber(full.blindLevel, tournamentMeta.levelIndex), playersRemaining: tournamentMeta.playersRemaining, startingPlayers: tournamentMeta.startingPlayers },
    blinds: { smallBlind: asNumber(full.smallBlind), bigBlind: asNumber(full.bigBlind), ante: asNumber(full.ante) },
    hero: { id: player.id, name: player.name, seat: seat + 1, position: positionForSeat(full, seat), stack, stackBB: round(stack / bb, 1), cards: playerCards(vp), currentBet: currentBet(full, seat) },
    betting: (() => {
      const heroCurrentBet = currentBet(full, seat);
      const highestBet = Math.max(0, ...(full.players ?? []).map((_, s) => currentBet(full, s)));
      const toCall = Math.max(0, highestBet - heroCurrentBet);
      return { highestBet, heroCurrentBet, toCall, effectiveCall: Math.min(stack, toCall), stackBehind: stack, facingAllInCall: stack > 0 && stack <= toCall };
    })(),
    board: Array.isArray(view?.board) ? view.board : [], street: full.street, pot: totalPot(full), buttonSeat: full.buttonSeat == null ? null : full.buttonSeat + 1,
    actionHistory,
    recentHands,
    publicPlayerStats,
    opponents: (view.players ?? []).map((p, s) => p && s !== seat && !eliminated.has(p.id) ? {
      id: p.id, seat: s + 1, name: p.name, position: positionForSeat(full, s), stack: playerStack(p), stackBB: round(playerStack(p) / bb, 1), currentBet: currentBet(full, s),
      status: p.status ?? (p.folded ? 'FOLDED' : 'ACTIVE'), cards: playerCards(p),
    } : null).filter(Boolean),
    legalActions: legalActions.map(({ id: actionId, type, amount, description }) => ({ id: actionId, type, amount, description })),
  };
}
export function assertDecisionState(state) {
  if (!state || state.contextVersion !== DECISION_CONTEXT_VERSION) throw new Error('Decision context version mismatch');
  if (!Array.isArray(state.hero?.cards) || state.hero.cards.length !== 2) throw new Error('Decision context must expose exactly two hero cards');
  if (state.heroHand != null) {
    if (typeof state.heroHand !== 'object' || !state.heroHand.category) throw new Error('Deterministic heroHand must carry a category');
    if (JSON.stringify(state.heroHand).match(/opponent|villain/i)) throw new Error('Deterministic heroHand must describe the hero only');
  }
  if (!Array.isArray(state.opponents) || state.opponents.some(p => !Array.isArray(p.cards) || p.cards.length !== 0)) throw new Error('Decision context leaked opponent hole cards');
  if (!Array.isArray(state.publicPlayerStats)) throw new Error('Decision context is missing publicPlayerStats');
  const ids = new Set();
  const aggressiveByAmount = new Map();
  const maxTotal = asNumber(state.hero.stack) + asNumber(state.hero.currentBet);
  for (const action of state.legalActions ?? []) {
    if (!action?.id || ids.has(action.id)) throw new Error('Decision context has duplicate or missing action IDs');
    ids.add(action.id);
    if (['BET','RAISE'].includes(action.type)) {
      if (!Number.isFinite(Number(action.amount)) || Number(action.amount) > maxTotal) throw new Error(`Aggressive action exceeds available chips: ${action.id}`);
      if (action.type === 'RAISE' && Number(action.amount) <= Number(state.betting?.highestBet ?? 0)) throw new Error(`Raise does not exceed the current price: ${action.id}`);
      const prior = aggressiveByAmount.get(Number(action.amount));
      if (prior && prior !== action.type) throw new Error(`Decision context exposes BET and RAISE for the same amount: ${action.amount}`);
      aggressiveByAmount.set(Number(action.amount), action.type);
    }
  }
  const expectedRemaining = 1 + state.opponents.length;
  if (Number(state.tournament?.playersRemaining) !== expectedRemaining) throw new Error(`playersRemaining mismatch: expected ${expectedRemaining}, got ${state.tournament?.playersRemaining}`);
  return state;
}

export function extractTextContent(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => typeof x === 'string' ? x : (x?.text ?? '')).join('');
  return '';
}
export function stripCodeFence(text) {
  const s = String(text || '').trim();
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : s;
}
export function normalizeDecisionObject(obj, legalActions, decisionId) {
  if (!obj || typeof obj !== 'object') throw new Error('Model returned no decision object');
  if (obj.decisionId && obj.decisionId !== decisionId) throw new Error('Stale/wrong decisionId');
  const action = legalActions.find(a => a.id === obj.actionId);
  if (!action) throw new Error(`Unknown actionId: ${obj.actionId}`);
  return { action, publicReason: String(obj.publicReason || '').slice(0, 220) };
}
export function pokerPrompt(state) {
  return [
    'You are one autonomous player in a No-Limit Texas Holdem tournament.',
    DECISION_OBJECTIVE,
    'The JSON state below is the complete information available to you for this decision. Do not assume hidden cards or private information.',
    'publicReason must be a short spectator-facing explanation (max 220 characters), not hidden chain-of-thought or private scratch work.',
    '', JSON.stringify(state),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Deterministic hand evaluation (code-generated, never model-generated).
// ---------------------------------------------------------------------------
export const HAND_CATEGORY_KEYS = Object.freeze([
  'high_card', 'pair', 'two_pair', 'trips', 'straight', 'flush', 'full_house', 'quads', 'straight_flush',
]);
export const HAND_CATEGORY_LABELS = Object.freeze({
  high_card: 'High card', pair: 'One pair', two_pair: 'Two pair', trips: 'Three of a kind',
  straight: 'Straight', flush: 'Flush', full_house: 'Full house', quads: 'Four of a kind', straight_flush: 'Straight flush',
});
const CATEGORY_KEY_BY_DESCRIPTION = Object.freeze({
  'High Card': 'high_card',
  'One Pair': 'pair',
  'Two Pair': 'two_pair',
  'Three of a Kind': 'trips',
  'Straight': 'straight',
  'Flush': 'flush',
  'Full House': 'full_house',
  'Four of a Kind': 'quads',
  'Straight Flush': 'straight_flush',
});
export function heroHandCategory(heroCards, board) {
  const cards = [...(heroCards ?? []), ...(board ?? [])].filter(Boolean);
  if (cards.length < 5) return null;
  const rankValue = rank(getCardCodes(cards));
  const description = rankDescription(rankValue);
  return { description, key: CATEGORY_KEY_BY_DESCRIPTION[description] ?? null, rank: rankValue };
}
export function heroHandSummary(heroCards, board) {
  const category = heroHandCategory(heroCards, board);
  if (!category) return null;
  return { category: category.description, description: `${category.description} (deterministic)`, key: category.key };
}
export function handCategoryCriteria() {
  return Object.fromEntries(HAND_CATEGORY_KEYS.map(key => [key, HAND_CATEGORY_LABELS[key]]));
}
export { HAND_RANK_DESCRIPTIONS };

// ---------------------------------------------------------------------------
// Benchmark modes and decision architecture.
//
// The benchmark mode is a tournament-wide setting: either every model receives
// a deterministic hero-hand classification (Strategy) or every model receives
// raw cards and must infer strength itself (Raw cognition). It can never vary
// by seat.
//
// The decision architecture is also tournament-wide. The hierarchical
// architecture asks every model for an action family first, then (only for
// BET/RAISE) for a size from the same deterministic, engine-validated size
// set. The flat legacy architecture is retained only as a diagnostic baseline.
// ---------------------------------------------------------------------------
export const BENCHMARK_MODES = Object.freeze({ STRATEGY: 'strategy', RAW: 'raw' });
export const DECISION_ARCHITECTURES = Object.freeze({ HIERARCHICAL: 'hierarchical', FLAT: 'flat' });
export const DEFAULT_BENCHMARK_MODE = BENCHMARK_MODES.STRATEGY;
export const DEFAULT_DECISION_ARCHITECTURE = DECISION_ARCHITECTURES.HIERARCHICAL;
export const DECISION_ARCHITECTURE_VERSION = 'hierarchical-v1';
export const REPRESENTATION_MODES = Object.freeze(['canonical_json', 'compact_json', 'markdown']);
export const DEFAULT_REPRESENTATION_MODE = 'canonical_json';

export const ACTION_FAMILY = Object.freeze({
  FOLD: 'fold', CHECK: 'check', CALL: 'call', BET: 'bet', RAISE: 'raise',
});
export const FAMILY_LABELS = Object.freeze({ fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise' });
export const SIZE_IDS = Object.freeze(['small', 'medium', 'large', 'all_in']);
export const SIZE_LABELS = Object.freeze({ small: 'SMALL', medium: 'MEDIUM', large: 'LARGE', all_in: 'ALL-IN' });

export function isAggressiveType(type) { return type === ACTION.BET || type === ACTION.RAISE; }
export function familyForActionType(type) {
  if (type === ACTION.BET) return ACTION_FAMILY.BET;
  if (type === ACTION.RAISE) return ACTION_FAMILY.RAISE;
  if (type === ACTION.CHECK) return ACTION_FAMILY.CHECK;
  if (type === ACTION.CALL) return ACTION_FAMILY.CALL;
  if (type === ACTION.FOLD) return ACTION_FAMILY.FOLD;
  return String(type || '').toLowerCase();
}
export function actionTypeForFamily(family) {
  switch (String(family).toLowerCase()) {
    case ACTION_FAMILY.FOLD: return ACTION.FOLD;
    case ACTION_FAMILY.CHECK: return ACTION.CHECK;
    case ACTION_FAMILY.CALL: return ACTION.CALL;
    case ACTION_FAMILY.BET: return ACTION.BET;
    case ACTION_FAMILY.RAISE: return ACTION.RAISE;
    default: return null;
  }
}

// Deterministic hand field is added (or deliberately withheld) per benchmark
// mode. It always describes the hero's best five-card hand only.
export function applyBenchmarkMode(state, mode = DEFAULT_BENCHMARK_MODE) {
  if (!state || mode !== BENCHMARK_MODES.STRATEGY) return state;
  const hand = heroHandSummary(state.hero?.cards ?? state.heroCards, state.board);
  return hand ? { ...state, heroHand: hand } : { ...state };
}
export function stripHeroHand(state) {
  if (!state || state.heroHand == null) return state;
  const { heroHand, ...rest } = state;
  return rest;
}

// ---------------------------------------------------------------------------
// ACTION FAMILY GENERATION
//
// Derived from the actual legal actions, never from prose. The result is the
// single canonical family set for a decision state. Assertions are deliberately
// strict: an arena bug that exposes BET and RAISE together, or FOLD while CHECK
// is free, must fail loudly rather than silently bias the benchmark.
// ---------------------------------------------------------------------------
export function legalActionFamilies(legalActions, { toCall = 0 } = {}) {
  const actions = Array.isArray(legalActions) ? legalActions : [];
  const has = type => actions.some(a => a?.type === type);
  const aggressiveTypes = [...new Set(actions.filter(a => isAggressiveType(a?.type)).map(a => a.type))];
  if (aggressiveTypes.length > 1) throw new Error('Decision state exposes both BET and RAISE simultaneously');
  const families = [];
  if (asNumber(toCall) > 0) {
    if (has(ACTION.FOLD)) families.push(ACTION_FAMILY.FOLD);
    if (has(ACTION.CALL)) families.push(ACTION_FAMILY.CALL);
    if (aggressiveTypes[0]) families.push(familyForActionType(aggressiveTypes[0]));
    if (has(ACTION.CHECK)) throw new Error('Decision state exposes CHECK while facing a bet');
  } else {
    if (has(ACTION.FOLD)) throw new Error('Decision state exposes FOLD while CHECK is free (strictly dominated)');
    if (has(ACTION.CHECK)) families.push(ACTION_FAMILY.CHECK);
    if (aggressiveTypes[0]) families.push(familyForActionType(aggressiveTypes[0]));
  }
  return families;
}
export function familyCriteria(families) {
  return Object.fromEntries((families ?? []).map(family => [family, FAMILY_LABELS[family] ?? family]));
}

// ---------------------------------------------------------------------------
// DETERMINISTIC SIZING CANDIDATES
//
// At most four strategically distinct buckets: SMALL, MEDIUM, LARGE, ALL_IN.
// Amounts are clamped to the available stack, respect the minimum raise/bet,
// deduplicated, and near-duplicates are removed. The all-in bucket is kept only
// when it is materially larger than the remaining candidates.
// ---------------------------------------------------------------------------
const SIZE_NEAR_FRACTION = 0.15;

export function stateDecisionDescriptor(state) {
  const full = state ?? {};
  const betting = full.betting ?? {};
  const bb = Math.max(1, asNumber(full.blinds?.bigBlind ?? full.bigBlind, 1));
  const sb = Math.max(1, asNumber(full.blinds?.smallBlind ?? full.smallBlind, Math.ceil(bb / 2)));
  const heroStack = Math.max(0, asNumber(full.hero?.stack ?? full.heroStack, 0));
  const heroCurrentBet = Math.max(0, asNumber(full.hero?.currentBet ?? betting.heroCurrentBet, 0));
  const highestBet = Math.max(0, asNumber(betting.highestBet, 0));
  const toCall = Math.max(0, asNumber(betting.toCall, highestBet - heroCurrentBet));
  const pot = Math.max(bb, asNumber(full.pot, bb));
  const minRaise = Math.max(bb, asNumber(betting.minRaise ?? full.minRaise, bb));
  const lastRaise = Math.max(0, asNumber(betting.lastRaiseAmount ?? full.lastRaiseAmount, 0));
  return { bb, sb, heroStack, heroCurrentBet, highestBet, toCall, pot, minRaise: Math.max(minRaise, lastRaise), maxTotal: heroCurrentBet + heroStack };
}
export function engineDecisionDescriptor(engine, seat) {
  const state = engine.state;
  const player = state?.players?.[seat];
  if (!player) throw new Error(`No player at seat ${seat}`);
  const bb = Math.max(1, asNumber(state.bigBlind, 1));
  const sb = Math.max(1, asNumber(state.smallBlind, Math.ceil(bb / 2)));
  const heroStack = Math.max(0, playerStack(player));
  const heroCurrentBet = Math.max(0, currentBet(state, seat));
  const highestBet = Math.max(0, ...(state.players ?? []).map((_, s) => currentBet(state, s)));
  const toCall = Math.max(0, highestBet - heroCurrentBet);
  const pot = Math.max(bb, totalPot(state));
  const minRaise = Math.max(bb, asNumber(state.minRaise, bb));
  const lastRaise = Math.max(0, asNumber(state.lastRaiseAmount, 0));
  return { bb, sb, heroStack, heroCurrentBet, highestBet, toCall, pot, minRaise: Math.max(minRaise, lastRaise), maxTotal: heroCurrentBet + heroStack };
}

export function formatChips(n) { return Number(Math.max(0, Math.round(asNumber(n)))).toLocaleString('en-US'); }
function sizeLabel(type, amount, descriptor, sizeId) {
  const isAllIn = sizeId === SIZE_IDS[3] || Math.round(amount) >= Math.round(descriptor.maxTotal);
  const verb = type === ACTION.RAISE ? 'Raise to' : 'Bet';
  if (isAllIn) return `${verb} ${formatChips(amount)} chips all-in`;
  const pct = descriptor.pot > 0 ? Math.round((amount / descriptor.pot) * 100) : 0;
  return `${verb} ${formatChips(amount)} chips (${pct}% pot)`;
}

// Pure planner. `validate(amount)` lets the engine reject illegal amounts; when
// omitted the planner still clamps to the descriptor's own limits.
export function planAggressiveSizes({ family, descriptor, validate = null }) {
  if (![ACTION_FAMILY.BET, ACTION_FAMILY.RAISE].includes(family)) return [];
  const type = family === ACTION_FAMILY.RAISE ? ACTION.RAISE : ACTION.BET;
  const d = descriptor;
  const maxTotal = Math.max(0, Math.floor(asNumber(d.maxTotal)));
  if (maxTotal <= 0) return [];
  const minLegal = type === ACTION.RAISE
    ? Math.max(Math.floor(asNumber(d.highestBet)) + Math.max(1, Math.floor(asNumber(d.minRaise))), Math.floor(asNumber(d.highestBet)) + 1)
    : Math.max(1, Math.min(Math.floor(asNumber(d.bb)), maxTotal));
  if (minLegal > maxTotal) return [];
  const base = type === ACTION.RAISE ? Math.max(0, Math.floor(asNumber(d.highestBet))) : 0;
  const pot = Math.max(1, asNumber(d.pot));
  const rawTargets = [
    { id: SIZE_IDS[0], amount: base + Math.round(pot * 0.33) },
    { id: SIZE_IDS[1], amount: base + Math.round(pot * 0.67) },
    { id: SIZE_IDS[2], amount: base + Math.round(pot * 1.0) },
    { id: SIZE_IDS[3], amount: maxTotal },
  ];
  const near = Math.max(2, Math.round(Math.min(Math.max(1, asNumber(d.bb)), pot) * SIZE_NEAR_FRACTION));
  const kept = [];
  for (const target of rawTargets) {
    let amount = clamp(Math.round(target.amount), minLegal, maxTotal);
    if (amount < minLegal || amount > maxTotal) continue;
    if (validate && !validate(amount)) continue;
    if (kept.some(entry => Math.abs(entry.amount - amount) <= near)) continue;
    kept.push({ id: target.id, amount });
  }
  if (!kept.length && maxTotal >= minLegal && (!validate || validate(maxTotal))) kept.push({ id: SIZE_IDS[3], amount: maxTotal });
  // If a non-all-in bucket already sits at the stack cap, it *is* the all-in.
  for (const entry of kept) if (entry.amount >= maxTotal) entry.id = SIZE_IDS[3];
  const seenIds = new Set();
  const deduped = [];
  for (const entry of kept) {
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    deduped.push({ id: entry.id, amount: entry.amount, label: sizeLabel(type, entry.amount, d, entry.id) });
  }
  return deduped;
}

export function aggressiveSizesForState(state, family, { validate = null } = {}) {
  return planAggressiveSizes({ family, descriptor: stateDecisionDescriptor(state), validate });
}
export function legalAggressiveSizes(engine, seat, family) {
  const player = engine.state?.players?.[seat];
  if (!player) throw new Error(`No player at seat ${seat}`);
  const type = family === ACTION_FAMILY.RAISE ? ACTION.RAISE : ACTION.BET;
  return planAggressiveSizes({
    family,
    descriptor: engineDecisionDescriptor(engine, seat),
    validate: amount => Boolean(engine.validate({ type, playerId: player.id, amount })?.valid),
  });
}
export function sizeCriteria(sizes) { return Object.fromEntries((sizes ?? []).map(s => [s.id, s.label])); }

// The full canonical hierarchy for a state. This is the single representation
// used by production, diagnostics and tests.
export function buildHierarchicalDecision(state, { legalActions = null } = {}) {
  const actions = legalActions ?? state?.legalActions ?? [];
  const families = legalActionFamilies(actions, { toCall: state?.betting?.toCall ?? 0 });
  const stage1 = { stage: 'family', index: 1, of: 2, families, criteria: familyCriteria(families), label: 'Action family' };
  const aggressiveFamily = families.find(f => f === ACTION_FAMILY.BET || f === ACTION_FAMILY.RAISE) ?? null;
  const sizes = aggressiveFamily ? aggressiveSizesForState(state, aggressiveFamily) : [];
  const stage2 = aggressiveFamily
    ? { stage: 'size', index: 2, of: 2, family: aggressiveFamily, sizes, criteria: sizeCriteria(sizes), label: aggressiveFamily === ACTION_FAMILY.RAISE ? 'Raise size' : 'Bet size' }
    : null;
  return { architecture: DECISION_ARCHITECTURE_VERSION, families, stage1, aggressiveFamily, stage2 };
}

// ---------------------------------------------------------------------------
// LEGACY FLAT PROBABILITY AGGREGATION
// ---------------------------------------------------------------------------
// `labelResolver(key)` may return `{ type }` or `{ description }` for legacy
// events whose saved legal actions did not carry an action type.
function inferActionTypeFromDescription(description) {
  const text = String(description || '').trim();
  if (/^fold\b/i.test(text)) return ACTION.FOLD;
  if (/^check\b/i.test(text)) return ACTION.CHECK;
  if (/^call\b/i.test(text)) return ACTION.CALL;
  if (/^bet\b/i.test(text)) return ACTION.BET;
  if (/^raise\b/i.test(text)) return ACTION.RAISE;
  return null;
}
export function aggregateActionProbabilitiesByFamily(probabilities, legalActions, { labelResolver = null } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(probabilities ?? {})) {
    const mass = Number(value);
    if (!Number.isFinite(mass)) continue;
    const action = (legalActions ?? []).find(a => a?.id === key) ?? null;
    let type = action?.type ?? null;
    if (!type && labelResolver) {
      const resolved = labelResolver(key);
      type = resolved?.type ?? inferActionTypeFromDescription(resolved?.description);
    }
    if (!type) type = inferActionTypeFromDescription(action?.description);
    const family = type ? familyForActionType(type) : 'other';
    out[family] = (out[family] ?? 0) + mass;
  }
  return out;
}
export function probabilityStats(probabilities, selectedKey = null, { domain = 'flat_action' } = {}) {
  const entries = Object.entries(probabilities ?? {}).filter(([, v]) => Number.isFinite(Number(v)));
  if (!entries.length) return { domain, selectedProbability: null, topProbability: null, secondProbability: null, topKey: null, secondKey: null, gap: null, entropy: null, entropyBits: null, totalMass: 0 };
  const total = entries.reduce((s, [, v]) => s + Number(v), 0);
  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  const [topKey, topValue] = entries[0];
  const [secondKey, secondValue] = entries[1] ?? [null, 0];
  const selected = selectedKey != null ? entries.find(([k]) => k === selectedKey) : null;
  let entropy = null;
  if (total > 0) { entropy = 0; for (const [, v] of entries) { const p = Number(v) / total; if (p > 0) entropy -= p * Math.log2(p); } }
  return {
    domain,
    selectedProbability: selected ? Number(selected[1]) : null,
    topProbability: Number(topValue), secondProbability: entries[1] ? Number(secondValue) : null,
    topKey, secondKey, gap: Number(topValue) - Number(secondValue),
    // Named domains are mandatory in reports. `entropyBits` is exact; `entropy`
    // is the rounded legacy alias kept for older saved diagnostics.
    entropyBits: entropy,
    entropy: entropy == null ? null : Math.round(entropy * 1000) / 1000,
    totalMass: total,
  };
}

// Explicit, domain-labelled entropy helpers. Reports must call these rather
// than compare a generic "entropy" across different probability domains.
export function familyEntropyBits(probabilities, selectedKey = null) { return probabilityStats(probabilities, selectedKey, { domain: 'family' }).entropyBits; }
export function sizingEntropyBits(probabilities, selectedKey = null) { return probabilityStats(probabilities, selectedKey, { domain: 'sizing' }).entropyBits; }
export function flatActionEntropyBits(probabilities, selectedKey = null) { return probabilityStats(probabilities, selectedKey, { domain: 'flat_action' }).entropyBits; }

// ---------------------------------------------------------------------------
// Shared request builders. The diagnostic harness uses these so the exact
// production format is exercised by tests instead of a fork.
// ---------------------------------------------------------------------------
export function actionCriteria(legalActions, { keyMode = 'opaque' } = {}) {
  if (keyMode === 'opaque') return Object.fromEntries(legalActions.map(a => [a.id, a.description]));
  // Semantic keys are readable identifiers derived from the engine action, never
  // from free text, and always resolve back to exactly one legal action.
  const used = new Set();
  const entries = legalActions.map(a => {
    const base = [];
    base.push(String(a.type || 'action').toLowerCase());
    if (a.amount !== null && a.amount !== undefined && Number.isFinite(Number(a.amount))) base.push(String(Math.round(Number(a.amount))));
    let key = base.join('_');
    if (used.has(key)) { let i = 2; while (used.has(`${key}_${i}`)) i++; key = `${key}_${i}`; }
    used.add(key);
    return [key, a.description, a];
  });
  const criteria = {};
  const mapping = {};
  for (const [key, description, action] of entries) { criteria[key] = description; mapping[key] = action; }
  Object.defineProperty(criteria, '__mapping', { value: mapping, enumerable: false });
  return criteria;
}
export function resolveCriteriaKey(legalActions, key) {
  const byId = legalActions.find(a => a.id === key);
  if (byId) return byId;
  const semantic = actionCriteria(legalActions, { keyMode: 'semantic' });
  return semantic.__mapping?.[key] ?? null;
}
export function buildJevQuestions({ instructions = DECISION_OBJECTIVE, criteria, includeAction = true, includeAggression = false, includeBluff = false } = {}) {
  const questions = {};
  if (includeAction) questions.action = { type: 'choice', instructions, criteria };
  if (includeAggression) questions.aggression = { type: 'score', instructions: 'How aggressive should the hero strategy be in this spot?', criteria: ['Very passive', 'Cautious', 'Balanced', 'Aggressive', 'Maximum pressure'] };
  if (includeBluff) questions.bluff_spot = { type: 'noul', instructions: 'Is this a strategically plausible spot to apply aggression primarily as a bluff or semi-bluff?' };
  return questions;
}
export function buildJevDecisionsBody({ model, state, questions }) {
  return { model, state, questions };
}
export function buildJevNativeBody({ model, state, questions }) {
  return { model, state: typeof state === 'string' ? state : JSON.stringify(state), questions };
}

async function executeJevRequest({ url, connection, body, signal, started, agent, legalActions, resolveKey }) {
  const { payload, incidents, retryCount } = await fetchJsonWithRetry(url, { method: 'POST', headers: makeHeaders(connection), body: JSON.stringify(body), signal }, { maxRetries: 1 });
  const answer = payload?.answers?.action;
  const key = answer?.choice;
  const action = resolveKey(key, legalActions);
  if (!action) throw new Error(`Jev selected unknown action: ${key}`);
  const probs = answer?.probabilities ?? {};
  const ordered = Object.entries(probs).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 4);
  const probText = ordered.map(([aid, p]) => {
    const label = legalActions.find(a => a.id === aid)?.description || aid;
    return `${label} ${Math.round(Number(p) * 100)}%`;
  }).join(', ');
  const aggression = payload?.answers?.aggression?.score;
  const bluff = payload?.answers?.bluff_spot?.noul;
  const extras = [Number.isFinite(aggression) ? `aggression ${round(aggression, 2)}/4` : null, Number.isFinite(bluff) ? `bluff spot ${Math.round(bluff * 100)}%` : null].filter(Boolean).join(', ');
  return {
    action, publicReason: `${probText}${extras ? ` · ${extras}` : ''}`.slice(0, 220), latencyMs: Math.round(performance.now() - started),
    model: payload?.model || agent.model, usage: payload?.usage ?? null,
    meta: { method: 'openrouter-decisions', endpoint: url, probabilities: probs, confidence: answer?.confidence ?? null, aggression: aggression ?? null, bluffSpot: bluff ?? null, retryCount, incidents },
  };
}

export async function decideJevDecisions({ agent, connection, state, legalActions, timeoutMs, abortSignal, pauseClock, criteriaKeys = 'opaque', includeAggression = false, includeBluff = false }) {
  const { signal, cancel } = combineAbort(timeoutMs, abortSignal, pauseClock);
  const started = performance.now();
  const criteria = actionCriteria(legalActions, { keyMode: criteriaKeys });
  const questions = buildJevQuestions({ criteria, includeAction: true, includeAggression, includeBluff });
  const body = buildJevDecisionsBody({ model: agent.model || '~typesafe/jev-latest', state, questions });
  try {
    return await executeJevRequest({
      url: openRouterDecisionsUrl(connection.baseUrl), connection, body, signal, started, agent, legalActions,
      resolveKey: (key, actions) => actions.find(a => a.id === key) || resolveCriteriaKey(actions, key),
    });
  } finally { cancel(); }
}
export async function decideJevNative({ agent, connection, state, legalActions, timeoutMs, abortSignal, pauseClock, criteriaKeys = 'opaque', includeAggression = false, includeBluff = false }) {
  const { signal, cancel } = combineAbort(timeoutMs, abortSignal, pauseClock);
  const started = performance.now();
  const criteria = actionCriteria(legalActions, { keyMode: criteriaKeys });
  const questions = buildJevQuestions({ criteria, includeAction: true, includeAggression, includeBluff });
  const body = buildJevNativeBody({ model: agent.model || 'jev-latest', state, questions });
  try {
    return await executeJevRequest({
      url: normalizeBaseUrl(connection.baseUrl), connection, body, signal, started, agent, legalActions,
      resolveKey: (key, actions) => actions.find(a => a.id === key) || resolveCriteriaKey(actions, key),
    });
  } finally { cancel(); }
}

export function buildOpenAICompatibleBody({ agent, connection, state, legalActions, decisionId, protocol = 'tool', instructions = null, criteria = null, representationText = null }) {
  const isOpenRouter = isOpenRouterConnection(connection);
  const criteriaKeys = criteria ? Object.keys(criteria) : null;
  const useChoice = Boolean(criteriaKeys?.length);
  const schema = useChoice
    ? { type: 'object', properties: { actionId: { type: 'string', enum: criteriaKeys }, publicReason: { type: 'string', maxLength: 220 } }, required: ['actionId'], additionalProperties: false }
    : {
      type: 'object', properties: {
        decisionId: { type: 'string', enum: [decisionId] },
        actionId: { type: 'string', enum: legalActions.map(a => a.id) },
        publicReason: { type: 'string', maxLength: 220 },
      }, required: ['decisionId', 'actionId', 'publicReason'], additionalProperties: false,
    };
  const userContent = representationText
    ? `${instructions || 'Choose exactly one action.'}\n\n${representationText}\n\nRespond with one of: ${criteriaKeys.map(k => `${k} = ${criteria[k]}`).join('; ')}.`
    : pokerPrompt(state);
  const body = {
    model: agent.model,
    messages: [
      { role: 'system', content: 'You are one seat in an autonomous poker benchmark. Commit exactly one legal move.' },
      { role: 'user', content: userContent },
    ],
    temperature: Number.isFinite(Number(agent.temperature)) ? Number(agent.temperature) : 0.3,
    max_tokens: isReasoningModel(agent.model) ? 1024 : 320,
  };
  if (protocol === 'tool') {
    body.tools = [{ type: 'function', function: { name: 'play_poker_action', description: 'Commit exactly one legal poker action for the current decision.', parameters: schema } }];
    body.tool_choice = { type: 'function', function: { name: 'play_poker_action' } };
  } else if (protocol === 'json_schema') {
    body.response_format = { type: 'json_schema', json_schema: { name: 'poker_decision', strict: true, schema } };
    body.messages[0].content += ' Return the decision in the required JSON schema.';
  } else {
    body.messages[0].content += ` Return only JSON matching: ${JSON.stringify(schema)}`;
  }
  if (isOpenRouter) {
    body.provider = agent.provider ? { only: [agent.provider], allow_fallbacks: false, require_parameters: true } : { allow_fallbacks: true, require_parameters: true };
    if (isReasoningModel(agent.model)) body.reasoning = { max_tokens: 256, exclude: true };
  }
  return body;
}

export async function decideOpenAICompatible({ agent, connection, state, legalActions, decisionId, timeoutMs, abortSignal, pauseClock, protocol: protocolOverride = null, instructions = null, criteria = null, representationText = null }) {
  const { signal, cancel } = combineAbort(timeoutMs, abortSignal, pauseClock);
  const started = performance.now();
  const requestedProtocol = protocolOverride || agent.protocol;
  const capabilityKey = `${normalizeBaseUrl(connection.baseUrl)}|${agent.model}|${agent.provider || 'auto'}|tool`;
  const isOpenRouter = isOpenRouterConnection(connection);
  const cachedProtocol = requestedProtocol === 'tool' && isOpenRouter && !criteria ? protocolCapabilityCache.get(capabilityKey) : null;
  const buildBody = protocol => buildOpenAICompatibleBody({ agent, connection, state, legalActions, decisionId, protocol, instructions, criteria, representationText });

  async function execute(protocol) {
    const body = buildBody(protocol);
    const { payload, incidents, retryCount } = await fetchJsonWithRetry(completionsUrl(connection.baseUrl), {
      method: 'POST', headers: makeHeaders(connection), body: JSON.stringify(body), signal,
    }, { maxRetries: 1 });
    const message = payload?.choices?.[0]?.message;
    let obj;
    if (protocol === 'tool') {
      const call = message?.tool_calls?.find(item => item?.function?.name === 'play_poker_action');
      if (!call) throw new Error('Model did not call play_poker_action');
      try { obj = JSON.parse(call.function.arguments); } catch { throw new Error('Tool arguments were not valid JSON'); }
    } else {
      const content = stripCodeFence(extractTextContent(message));
      try { obj = JSON.parse(content); } catch { throw new Error(`Model response was not valid JSON: ${content.slice(0, 180)}`); }
    }
    return { obj, payload, incidents, retryCount, protocol };
  }

  try {
    let actualProtocol = cachedProtocol || requestedProtocol;
    let protocolFallback = cachedProtocol === 'json_schema' ? 'tool→json_schema (cached)' : null;
    let protocolFallbackTriggered = false;
    let result;
    try {
      result = await execute(actualProtocol);
    } catch (err) {
      if (actualProtocol === 'tool' && requestedProtocol === 'tool' && isOpenRouter && isUnsupportedToolChoiceError(err)) {
        protocolCapabilityCache.set(capabilityKey, 'json_schema');
        actualProtocol = 'json_schema';
        protocolFallback = 'tool→json_schema';
        protocolFallbackTriggered = true;
        result = await execute(actualProtocol);
      } else throw err;
    }
    const normalized = normalizeDecisionObject(result.obj, legalActions, decisionId);
    return {
      ...normalized,
      latencyMs: Math.round(performance.now() - started),
      model: result.payload?.model || agent.model,
      usage: result.payload?.usage ?? null,
      meta: {
        method: result.protocol,
        requestedMethod: requestedProtocol,
        endpoint: connection.name,
        protocolFallback,
        protocolFallbackTriggered,
        retryCount: result.retryCount,
        incidents: result.incidents,
      },
    };
  } finally { cancel(); }
}

export function decide(agent, connection, args) {
  if (!connection) return Promise.reject(new Error(`Connection not found: ${agent.connectionId}`));
  const protocol = effectiveProtocol(agent, connection);
  if (protocol === 'jev_decisions') {
    if (!isOpenRouterConnection(connection)) return Promise.reject(new Error('Jev Decisions requires an OpenRouter connection'));
    // Production keeps the production auxiliary questions unless the caller
    // explicitly overrides them (the diagnostics harness does).
    return decideJevDecisions({ includeAggression: true, includeBluff: true, agent: { ...agent, protocol }, connection, ...args });
  }
  if (protocol === 'jev_native') {
    if (connection.kind !== 'typesafe') return Promise.reject(new Error('Jev native requires a TypeSafe connection'));
    return decideJevNative({ includeAggression: true, includeBluff: true, agent: { ...agent, protocol }, connection, ...args });
  }
  if (!['openai', 'openrouter'].includes(connection.kind)) return Promise.reject(new Error(`${protocol} requires an OpenAI-compatible connection`));
  return decideOpenAICompatible({ agent: { ...agent, protocol }, connection, ...args, protocol });
}

// ===========================================================================
// HIERARCHICAL DECISION ARCHITECTURE (hierarchical-v1)
//
// Stage 1 asks for an action family; stage 2 asks for a size from exactly the
// same deterministic set that every other model receives. The primary decision
// contract contains only typed decision fields — never prose. Both stages share
// one action clock.
// ===========================================================================
export const FAMILY_OBJECTIVE = 'Choose exactly one legal action family that best maximizes tournament chip EV from the supplied state. Do not choose an amount; a size is chosen in a separate step.';
export const SIZE_OBJECTIVE = family => `The action family ${String(family).toUpperCase()} has already been selected. Choose exactly one legal ${family === ACTION_FAMILY.RAISE ? 'raise size' : 'bet size'} that best maximizes tournament chip EV. Do not change the action family.`;
export const SPECTATOR_NOTE = 'This model returns typed decisions rather than a text rationale.';

export function buildJevFamilyQuestions(families, { instructions = FAMILY_OBJECTIVE, criteria = null } = {}) {
  return { type: 'choice', instructions, criteria: criteria ?? familyCriteria(families) };
}
export function buildJevSizeQuestions(family, sizes, { instructions = null, criteria = null } = {}) {
  return { type: 'choice', instructions: instructions ?? SIZE_OBJECTIVE(family), criteria: criteria ?? sizeCriteria(sizes) };
}
export function chatFamilySchema(families) {
  return { type: 'object', properties: { decisionId: { type: 'string' }, actionFamily: { type: 'string', enum: [...families] } }, required: ['decisionId', 'actionFamily'], additionalProperties: false };
}
export function chatSizeSchema(sizes) {
  return { type: 'object', properties: { decisionId: { type: 'string' }, sizeId: { type: 'string', enum: sizes.map(s => s.id) } }, required: ['decisionId', 'sizeId'], additionalProperties: false };
}

// Canonical representation. Both transports receive a semantically identical
// state; only the serialization differs. This is the single place where the
// representation mode is interpreted.
export function renderDecisionState(state, mode = DEFAULT_REPRESENTATION_MODE) {
  if (mode === 'markdown') {
    const lines = [
      '# Poker decision',
      `- Hero: ${(state?.hero?.cards ?? state?.heroCards ?? []).join(' ') || '—'}`,
      `- Board: ${(state?.board ?? []).join(' ') || '—'}`,
      `- Street: ${state?.street ?? '—'}`,
      `- Pot: ${state?.pot ?? 0}`,
      `- To call: ${state?.betting?.toCall ?? 0}`,
      `- Hero stack: ${state?.hero?.stack ?? 0}`,
    ];
    if (state?.heroHand?.category) lines.push(`- Deterministic hero hand: ${state.heroHand.category}`);
    if (Array.isArray(state?.legalActions) && state.legalActions.length) lines.push('', '## Legal actions', ...state.legalActions.map(a => `- ${a.id}: ${a.description ?? a.type}`));
    const text = lines.join('\n');
    return { jevState: text, chatText: text, mode };
  }
  if (mode === 'compact_json') {
    const compact = {
      game: state?.game ?? 'No-Limit Texas Holdem tournament',
      street: state?.street, hero: state?.hero, heroHand: state?.heroHand ?? undefined,
      board: state?.board, pot: state?.pot, blinds: state?.blinds, betting: state?.betting,
      opponents: state?.opponents, legalActions: state?.legalActions,
    };
    const json = JSON.stringify(compact);
    return { jevState: compact, chatText: json, mode };
  }
  return { jevState: state, chatText: JSON.stringify(state), mode: 'canonical_json' };
}

// A model may only return a family that was actually offered by the arena.
export function normalizeFamilyChoice(obj, families, decisionId = null) {
  if (!obj || typeof obj !== 'object') throw new Error('Model returned no action-family object');
  if (obj.decisionId && decisionId && obj.decisionId !== decisionId) throw new Error('Stale/wrong decisionId');
  const choice = normalizeChoiceKey(obj.actionFamily ?? obj.answer);
  if (!families.includes(choice)) throw new Error(`Unknown action family: ${choice}`);
  return choice;
}
export function normalizeSizeChoice(obj, sizes, decisionId = null) {
  if (!obj || typeof obj !== 'object') throw new Error('Model returned no size object');
  if (obj.decisionId && decisionId && obj.decisionId !== decisionId) throw new Error('Stale/wrong decisionId');
  const choice = normalizeChoiceKey(obj.sizeId ?? obj.answer);
  if (!sizes.some(s => s.id === choice)) throw new Error(`Unknown size id: ${choice}`);
  return choice;
}
function normalizeChoiceKey(value) { return String(value ?? '').trim().toLowerCase().replace(/-/g, '_'); }

// In hierarchical mode the model must not receive a flat action/size menu; the
// family question and (only when needed) the size question are the choice sets.
function withoutFlatMenu(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { legalActions, ...rest } = value;
  return rest;
}
function withoutFlatMenuText(text) {
  if (typeof text !== 'string') return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return JSON.stringify(withoutFlatMenu(parsed));
  } catch {}
  return text;
}
// Resolve a (family, optional size) pair to exactly one legal action.
export function resolveHierarchicalAction({ legalActions, family, size }) {
  const type = actionTypeForFamily(family);
  if (!type) return null;
  if (family === ACTION_FAMILY.BET || family === ACTION_FAMILY.RAISE) {
    if (!size) return null;
    const exact = (legalActions ?? []).find(a => a.type === type && Number(a.amount) === Number(size.amount));
    // The deterministic size is authoritative. When the flat candidate list does
    // not contain that exact amount (it usually will not in production), keep the
    // validated size amount and use the candidate only as a display reference.
    const reference = exact ?? [...(legalActions ?? [])].filter(a => a.type === type)
      .sort((a, b) => Math.abs(Number(a.amount) - Number(size.amount)) - Math.abs(Number(b.amount) - Number(size.amount)))[0] ?? null;
    return { id: reference?.id ?? null, type, amount: size.amount, description: size.label, family, sizeId: size.id };
  }
  const action = (legalActions ?? []).find(a => a.type === type);
  return action ? { ...action, family, sizeId: null } : { id: null, type, amount: null, description: FAMILY_LABELS[family] ?? family, family, sizeId: null };
}

async function requestJevStage({ connection, model, state, questionKey, question, signal }) {
  const native = connection.kind === 'typesafe';
  const url = native ? normalizeBaseUrl(connection.baseUrl) : openRouterDecisionsUrl(connection.baseUrl);
  const body = native
    ? { model, state: typeof state === 'string' ? state : JSON.stringify(state), questions: { [questionKey]: question } }
    : { model, state, questions: { [questionKey]: question } };
  const started = performance.now();
  const { payload, incidents, retryCount } = await fetchJsonWithRetry(url, { method: 'POST', headers: makeHeaders(connection), body: JSON.stringify(body), signal }, { maxRetries: 1 });
  const answer = payload?.answers?.[questionKey];
  if (!answer?.choice) throw new Error(`Jev response had no answers.${questionKey}.choice`);
  const ranked = Object.entries(answer.probabilities ?? {}).filter(([, v]) => Number.isFinite(Number(v))).sort((a, b) => Number(b[1]) - Number(a[1]));
  return {
    choice: answer.choice, probabilities: answer.probabilities ?? null, confidence: answer.confidence ?? null,
    latencyMs: Math.round(performance.now() - started), model: payload?.model || model, usage: payload?.usage ?? null,
    incidents, retryCount, top: ranked[0]?.[0] ?? null, topProbability: ranked[0]?.[1] ?? null,
    second: ranked[1]?.[0] ?? null, secondProbability: ranked[1]?.[1] ?? null,
    gap: ranked.length >= 2 ? Number(ranked[0][1]) - Number(ranked[1][1]) : null,
  };
}

async function requestChatStage({ agent, connection, schema, toolName, systemPrompt, userPrompt, signal, requestedProtocol, temperature }) {
  const isOpenRouter = isOpenRouterConnection(connection);
  const buildBody = protocol => {
    const body = {
      model: agent.model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.3,
      max_tokens: isReasoningModel(agent.model) ? 1024 : 320,
    };
    if (protocol === 'tool') {
      body.tools = [{ type: 'function', function: { name: toolName, description: `Submit the ${toolName.replaceAll('_', ' ')}.`, parameters: schema } }];
      body.tool_choice = { type: 'function', function: { name: toolName } };
    } else if (protocol === 'json_schema') {
      body.response_format = { type: 'json_schema', json_schema: { name: toolName, strict: true, schema } };
      body.messages[0].content += ' Return the decision in the required JSON schema.';
    } else {
      body.messages[0].content += ` Return only JSON matching: ${JSON.stringify(schema)}`;
    }
    if (isOpenRouter) {
      body.provider = agent.provider ? { only: [agent.provider], allow_fallbacks: false, require_parameters: true } : { allow_fallbacks: true, require_parameters: true };
      if (isReasoningModel(agent.model)) body.reasoning = { max_tokens: 256, exclude: true };
    }
    return body;
  };
  const capabilityKey = `${normalizeBaseUrl(connection.baseUrl)}|${agent.model}|${agent.provider || 'auto'}|${toolName}`;
  const cachedProtocol = requestedProtocol === 'tool' && isOpenRouter ? protocolCapabilityCache.get(capabilityKey) : null;
  const execute = async protocol => {
    const started = performance.now();
    const { payload, incidents, retryCount } = await fetchJsonWithRetry(completionsUrl(connection.baseUrl), {
      method: 'POST', headers: makeHeaders(connection), body: JSON.stringify(buildBody(protocol)), signal,
    }, { maxRetries: 1 });
    const message = payload?.choices?.[0]?.message;
    let obj;
    if (protocol === 'tool') {
      const call = message?.tool_calls?.find(item => item?.function?.name === toolName);
      if (!call) throw new Error(`Model did not call ${toolName}`);
      try { obj = JSON.parse(call.function.arguments); } catch { throw new Error('Tool arguments were not valid JSON'); }
    } else {
      obj = JSON.parse(stripCodeFence(extractTextContent(message)));
    }
    return { obj, protocol, latencyMs: Math.round(performance.now() - started), model: payload?.model || agent.model, usage: payload?.usage ?? null, incidents, retryCount };
  };
  let actual = cachedProtocol || requestedProtocol;
  let protocolFallback = cachedProtocol ? 'cached json_schema' : null;
  try {
    return await execute(actual);
  } catch (err) {
    if (actual === 'tool' && requestedProtocol === 'tool' && isOpenRouter && isUnsupportedToolChoiceError(err)) {
      protocolCapabilityCache.set(capabilityKey, 'json_schema');
      const result = await execute('json_schema');
      return { ...result, protocolFallback: 'tool→json_schema' };
    }
    throw err;
  }
}

// The one hierarchical entry point used by production and diagnostics.
export async function decideHierarchical({
  agent, connection, state, legalActions, decisionId, timeoutMs, abortSignal, pauseClock,
  representationText = null, jevState = null, representationMode = DEFAULT_REPRESENTATION_MODE, protocol: protocolOverride = null,
  sizesForFamily = null, onStage = null,
}) {
  if (!connection) throw new Error(`Connection not found: ${agent.connectionId}`);
  const protocol = protocolOverride || effectiveProtocol(agent, connection);
  const isJev = protocol === 'jev_decisions' || protocol === 'jev_native';
  const families = legalActionFamilies(legalActions, { toCall: state?.betting?.toCall ?? 0 });
  if (!families.length) throw new Error('No legal action families for this decision');
  const sizesOf = family => (sizesForFamily ? sizesForFamily(family) : aggressiveSizesForState(state, family));
  const renderState = withoutFlatMenu(state);
  const rendered = (representationText != null || jevState != null)
    ? { jevState: jevState != null ? withoutFlatMenu(jevState) : renderState, chatText: representationText != null ? withoutFlatMenuText(representationText) : JSON.stringify(renderState) }
    : renderDecisionState(renderState, representationMode);
  const { signal, cancel } = combineAbort(timeoutMs, abortSignal, pauseClock);
  const startedTotal = performance.now();
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const addUsage = u => { for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) if (Number.isFinite(Number(u?.[key]))) usage[key] += Number(u[key]); };
  try {
    const familyStage = { families, criteria: familyCriteria(families) };
    if (onStage) onStage({ stage: 'family', index: 1, of: 2, families, criteria: familyStage.criteria });
    let familyResult;
    if (isJev) {
      familyResult = await requestJevStage({
        connection, model: agent.model, state: rendered.jevState,
        questionKey: 'action_family', question: buildJevFamilyQuestions(families), signal,
      });
      familyResult.choice = normalizeChoiceKey(familyResult.choice);
    } else {
      const schema = chatFamilySchema(families);
      const userPrompt = [
        FAMILY_OBJECTIVE, '', rendered.chatText, '',
        `Allowed action families: ${families.map(f => `${f} = ${FAMILY_LABELS[f]}`).join('; ')}.`,
        `Respond with { "decisionId": ${JSON.stringify(decisionId)}, "actionFamily": "<family>" }.`,
      ].join('\n');
      const result = await requestChatStage({
        agent, connection, schema, toolName: 'choose_action_family',
        systemPrompt: 'You are one seat in an autonomous poker benchmark. Choose exactly one legal action family.',
        userPrompt, signal, requestedProtocol: protocol, temperature: agent.temperature,
      });
      familyResult = { ...result, choice: normalizeFamilyChoice(result.obj, families, decisionId) };
    }
    addUsage(familyResult.usage);
    if (!families.includes(familyResult.choice)) throw new Error(`Model selected an illegal action family: ${familyResult.choice}`);
    const familyProbabilities = isJev ? familyResult.probabilities : null;

    let sizingResult = null;
    let sizeStage = null;
    if (familyResult.choice === ACTION_FAMILY.BET || familyResult.choice === ACTION_FAMILY.RAISE) {
      const sizes = sizesOf(familyResult.choice);
      if (!sizes.length) throw new Error(`No legal ${familyResult.choice} sizes for this decision`);
      sizeStage = { family: familyResult.choice, sizes, criteria: sizeCriteria(sizes) };
      if (onStage) onStage({ stage: 'size', index: 2, of: 2, family: familyResult.choice, families: [familyResult.choice], sizes, criteria: sizeStage.criteria });
      if (isJev) {
        sizingResult = await requestJevStage({
          connection, model: agent.model, state: rendered.jevState,
          questionKey: 'bet_size', question: buildJevSizeQuestions(familyResult.choice, sizes), signal,
        });
        sizingResult.choice = normalizeChoiceKey(sizingResult.choice);
        if (!sizes.some(s => s.id === sizingResult.choice)) throw new Error(`Model selected an illegal size: ${sizingResult.choice}`);
      } else {
        const schema = chatSizeSchema(sizes);
        const userPrompt = [
          SIZE_OBJECTIVE(familyResult.choice), '', rendered.chatText, '',
          `Selected action family: ${familyResult.choice}.`,
          `Allowed sizes: ${sizes.map(s => `${s.id} = ${s.label}`).join('; ')}.`,
          `Respond with { "decisionId": ${JSON.stringify(decisionId)}, "sizeId": "<size>" }.`,
        ].join('\n');
        const result = await requestChatStage({
          agent, connection, schema, toolName: 'choose_bet_size',
          systemPrompt: `You are one seat in an autonomous poker benchmark. The action family ${familyResult.choice.toUpperCase()} is fixed. Choose exactly one legal size.`,
          userPrompt, signal, requestedProtocol: protocol, temperature: agent.temperature,
        });
        sizingResult = { ...result, choice: normalizeSizeChoice(result.obj, sizes, decisionId) };
      }
      addUsage(sizingResult.usage);
    }
    const chosenSize = sizingResult ? (sizeStage.sizes.find(s => s.id === sizingResult.choice) ?? null) : null;
    const finalAction = resolveHierarchicalAction({ legalActions, family: familyResult.choice, size: chosenSize });
    if (!finalAction?.type) throw new Error('Hierarchical decision did not resolve to a legal action');
    const primaryDecisionLatencyMs = Math.round(performance.now() - startedTotal);
    return {
      action: finalAction,
      family: {
        choice: familyResult.choice, probabilities: familyProbabilities, confidence: familyResult.confidence ?? null,
        latencyMs: familyResult.latencyMs, criteria: familyStage.criteria,
        top: familyResult.top ?? null, second: familyResult.second ?? null, gap: familyResult.gap ?? null,
      },
      sizing: sizingResult ? {
        choice: sizingResult.choice, probabilities: isJev ? sizingResult.probabilities ?? null : null,
        confidence: sizingResult.confidence ?? null, latencyMs: sizingResult.latencyMs,
        criteria: sizeStage.criteria, amount: chosenSize?.amount ?? null,
        top: sizingResult.top ?? null, second: sizingResult.second ?? null,
      } : null,
      primaryDecisionLatencyMs,
      publicReason: '',
      model: familyResult.model || agent.model,
      usage: usage.total_tokens ? usage : (familyResult.usage ?? null),
      meta: {
        decisionArchitecture: DECISION_ARCHITECTURE_VERSION,
        method: isJev ? (protocol === 'jev_native' ? 'jev-native-hierarchical' : 'openrouter-decisions-hierarchical') : `${familyResult.protocol ?? protocol}-hierarchical`,
        requestedMethod: protocol, endpoint: connection.name,
        protocolFallback: familyResult.protocolFallback ?? null,
        protocolFallbackTriggered: Boolean(familyResult.protocolFallback),
        retryCount: Number(familyResult.retryCount || 0), incidents: familyResult.incidents ?? [],
        family: { choice: familyResult.choice },
        sizing: sizingResult ? { choice: sizingResult.choice } : null,
      },
    };
  } finally { cancel(); }
}
