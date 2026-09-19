// Semantically equivalent representations of the same decision. Only the
// presentation changes; the legal actions and their identifiers stay exact.
import { heroHandSummary } from '../../src/lib/decision-core.js';

function actionsOf(state, fallbackActions = []) {
  const raw = Array.isArray(state?.legalActions) ? state.legalActions : [];
  if (raw.length) return raw.map(a => ({ id: a.id, type: a.type, amount: a.amount ?? null, description: a.description ?? a.type ?? a.id }));
  return fallbackActions.map(a => ({ id: a.id, type: a.type ?? null, amount: a.amount ?? null, description: a.description ?? a.label ?? a.id }));
}
function heroCardsOf(state) {
  if (Array.isArray(state?.heroCards)) return state.heroCards;
  if (Array.isArray(state?.hero?.cards)) return state.hero.cards;
  return [];
}
function boardOf(state) { return Array.isArray(state?.board) ? state.board : []; }
function streetOf(state) { return state?.street ?? 'RIVER'; }
function potOf(state) { return state?.pot ?? 0; }
function stackOf(state) { return state?.hero?.stack ?? state?.stack ?? 0; }
function toCallOf(state) { return state?.betting?.toCall ?? state?.toCall ?? 0; }
function labelList(actions) { return actions.map(a => `${a.id} = ${a.description}`).join('\n'); }

export function minimalState(state, fallbackActions) {
  const actions = actionsOf(state, fallbackActions);
  return {
    game: state?.game ?? 'No-Limit Texas Holdem',
    street: streetOf(state),
    heroCards: heroCardsOf(state),
    board: boardOf(state),
    pot: potOf(state),
    heroStack: stackOf(state),
    toCall: toCallOf(state),
    legalActions: actions.map(a => ({ id: a.id, type: a.type, amount: a.amount, description: a.description })),
  };
}
export function flatState(state, fallbackActions) {
  const actions = actionsOf(state, fallbackActions);
  const hero = heroCardsOf(state);
  return {
    game: state?.game ?? 'No-Limit Texas Holdem',
    street: streetOf(state),
    hero_card_1: hero[0] ?? null,
    hero_card_2: hero[1] ?? null,
    board: boardOf(state).join(' '),
    pot: potOf(state),
    stack: stackOf(state),
    to_call: toCallOf(state),
    legal_actions: actions.map(a => `${a.id}: ${a.description}`).join(' | '),
  };
}
export function rawText(state, fallbackActions) {
  const actions = actionsOf(state, fallbackActions);
  const lines = [
    "No-Limit Hold'em tournament.",
    `${String(streetOf(state)).replaceAll('_', ' ')}.`,
    '',
    `Hero: ${heroCardsOf(state).join(' ') || '—'}.`,
  ];
  if (boardOf(state).length) lines.push(`Board: ${boardOf(state).join(' ')}.`);
  lines.push(`Pot: ${potOf(state)}.`);
  lines.push(`Hero stack: ${stackOf(state)}.`);
  lines.push(`Amount to call: ${toCallOf(state)}.`);
  lines.push('', 'Legal actions:', labelList(actions));
  return lines.filter(l => l !== undefined).join('\n');
}
export function markdown(state, fallbackActions) {
  const actions = actionsOf(state, fallbackActions);
  const hero = heroCardsOf(state);
  const out = [
    '# Poker decision',
    '',
    '## Hero',
    `- Cards: ${hero.join(' ') || '—'}`,
    `- Position: ${state?.hero?.position ?? state?.position ?? '—'}`,
    `- Stack: ${Number(stackOf(state)).toLocaleString('en-US')}`,
  ];
  const board = boardOf(state);
  if (board.length) out.push('', '## Board', board.join(' '));
  out.push('', '## Pot', Number(potOf(state)).toLocaleString('en-US'));
  out.push('', '## To call', String(toCallOf(state)));
  out.push('', '## Legal actions', ...actions.map(a => `- ${a.id} — ${a.description}`));
  return out.join('\n');
}
export function withHeroHand(state) {
  const hand = heroHandSummary(heroCardsOf(state), boardOf(state));
  return hand ? { ...state, heroHand: hand } : { ...state };
}
export function semanticActionState(state, fallbackActions) {
  // Kept as canonical state; semantic keys are applied to the criteria map.
  return { ...state, legalActions: actionsOf(state, fallbackActions) };
}

// Representation 6 uses meaningful criteria keys while keeping the canonical
// state object; representations 1-5/7 keep opaque A0/A1 keys.
export const REPRESENTATIONS = Object.freeze([
  { id: 'full-json', name: 'Full canonical nested JSON', keyMode: 'opaque', build: (s, a) => ({ jevState: s, chatText: JSON.stringify(s) }) },
  { id: 'minimal-json', name: 'Minimal JSON', keyMode: 'opaque', build: (s, a) => { const m = minimalState(s, a); return { jevState: m, chatText: JSON.stringify(m) }; } },
  { id: 'flat-json', name: 'Flat JSON', keyMode: 'opaque', build: (s, a) => { const f = flatState(s, a); return { jevState: f, chatText: JSON.stringify(f) }; } },
  { id: 'raw-text', name: 'Raw compact text', keyMode: 'opaque', build: (s, a) => { const t = rawText(s, a); return { jevState: t, chatText: t }; } },
  { id: 'markdown', name: 'Markdown', keyMode: 'opaque', build: (s, a) => { const t = markdown(s, a); return { jevState: t, chatText: t }; } },
  { id: 'semantic-keys', name: 'Canonical JSON + semantic action keys', keyMode: 'semantic', build: (s, a) => ({ jevState: semanticActionState(s, a), chatText: JSON.stringify(s) }) },
  { id: 'canonical-herohand', name: 'Canonical JSON + deterministic heroHand', keyMode: 'opaque', build: (s, a) => { const withHand = withHeroHand(s); return { jevState: withHand, chatText: JSON.stringify(withHand) }; } },
]);

export function representationById(id) { return REPRESENTATIONS.find(r => r.id === id) ?? null; }

// Representation 8 — context ablation. The immediate decision is identical;
// only the memory/context fields included change.
function stripMemory(state, { actionHistory, recentHands, publicPlayerStats, memoryPolicy }) {
  const out = { ...state };
  if (actionHistory) out.actionHistory = state.actionHistory ?? []; else delete out.actionHistory;
  if (recentHands) out.recentHands = state.recentHands ?? []; else delete out.recentHands;
  if (publicPlayerStats) out.publicPlayerStats = state.publicPlayerStats ?? []; else delete out.publicPlayerStats;
  if (memoryPolicy) out.memoryPolicy = state.memoryPolicy; else delete out.memoryPolicy;
  return out;
}
export const CONTEXT_VARIANTS = Object.freeze([
  { id: 'context-immediate', name: 'Immediate state only', include: { actionHistory: false, recentHands: false, publicPlayerStats: false, memoryPolicy: false } },
  { id: 'context-action-history', name: '+ current hand history', include: { actionHistory: true, recentHands: false, publicPlayerStats: false, memoryPolicy: false } },
  { id: 'context-recent-hands', name: '+ current + recent hands', include: { actionHistory: true, recentHands: true, publicPlayerStats: false, memoryPolicy: false } },
  { id: 'context-public-stats', name: '+ public player stats', include: { actionHistory: true, recentHands: true, publicPlayerStats: true, memoryPolicy: false } },
  { id: 'context-full', name: 'Full production state', include: { actionHistory: true, recentHands: true, publicPlayerStats: true, memoryPolicy: true } },
]);
export function applyContextVariant(state, variant) { return stripMemory(state, variant.include); }
export function contextVariantById(id) { return CONTEXT_VARIANTS.find(v => v.id === id) ?? null; }

// Representation test Part 6 — description quality variants for aggressive
// actions. Variant D additionally embeds semantic metadata in state.
export function descriptionVariants(state) {
  const pot = potOf(state);
  const heroStack = stackOf(state);
  const heroBet = state?.hero?.currentBet ?? state?.betting?.heroCurrentBet ?? 0;
  const variants = {};
  variants.current = { ...state };
  const b = { ...state, legalActions: (state.legalActions ?? []).map(a => {
    if (!['BET', 'RAISE'].includes(a.type)) return { ...a };
    const pct = pot > 0 ? Math.round((Number(a.amount) / pot) * 100) : 0;
    const bb = Math.max(1, Number(state.blinds?.bigBlind ?? 100));
    return { ...a, description: `${a.type === 'RAISE' ? 'Raise to' : 'Bet'} ${a.amount} chips (${Math.round(Number(a.amount) / bb)} BB), approximately ${pct}% of the pot` };
  }) };
  variants['pot-fraction'] = b;
  const c = { ...state, legalActions: (state.legalActions ?? []).map(a => {
    if (!['BET', 'RAISE'].includes(a.type)) return { ...a };
    const potAfter = pot + Number(a.amount);
    const retains = Math.max(0, heroStack - Number(a.amount));
    return { ...a, description: `${a.type} — commit ${a.amount} chips; pot becomes ${potAfter}; hero retains ${retains} chips` };
  }) };
  variants.commitment = c;
  const d = { ...state, legalActions: (state.legalActions ?? []).map(a => {
    if (!['BET', 'RAISE'].includes(a.type)) return { ...a };
    const bb = Math.max(1, Number(state.blinds?.bigBlind ?? 100));
    const isAllIn = Number(a.amount) >= heroStack;
    return {
      ...a,
      amountBB: Math.round(Number(a.amount) / bb),
      potFraction: pot > 0 ? Math.round((Number(a.amount) / pot) * 100) / 100 : 0,
      stackFraction: heroStack > 0 ? Math.round((Number(a.amount) / heroStack) * 100) / 100 : 0,
      isAllIn,
    };
  }) };
  variants.metadata = d;
  return variants;
}
