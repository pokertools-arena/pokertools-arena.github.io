// Rigorous, layer-separated poker decision diagnostics.
//
// Layers:
//   A — action-id / protocol mapping (no poker knowledge required)
//   B — hand recognition (deterministic evaluator supplies the expected label)
//   D — strictly dominated decisions (diagnostic-only synthetic states)
//   E — strategy sanity checks (range-dependent, NOT "objectively correct")
//
// Layer C (arena legality) is exercised offline in tests/unit/decision-diagnostics.mjs
// against the real production action-space builder, not against a model.
import { ACTION, ACTION_FAMILY, DECISION_CONTEXT_VERSION, DECISION_OBJECTIVE, INFORMATION_POLICY, heroHandSummary, handCategoryCriteria, aggressiveSizesForState } from '../../src/lib/decision-core.js';
import { DECISION_SANITY_SCENARIOS } from '../../src/benchmark/scenarios.js';

export function action(id, type, description, amount = null) { return { id, type, amount, description }; }

const PUBLIC_STATS = Object.freeze([
  { playerId: 'diag-hero', playerName: 'Hero', sampleHands: 40, vpipPct: 0.30, pfrPct: 0.22, aggressionPct: 0.41, foldPct: 0.28, callPct: 0.24, checkPct: 0.18, wins: 10 },
  { playerId: 'diag-villain', playerName: 'Villain', sampleHands: 40, vpipPct: 0.31, pfrPct: 0.21, aggressionPct: 0.40, foldPct: 0.29, callPct: 0.24, checkPct: 0.17, wins: 9 },
]);

export function diagnosticState(overrides = {}) {
  return {
    contextVersion: DECISION_CONTEXT_VERSION,
    informationPolicy: INFORMATION_POLICY,
    objective: DECISION_OBJECTIVE,
    game: 'No-Limit Texas Holdem tournament',
    memoryPolicy: {
      currentHand: 'all public model actions in the current hand before this decision',
      recentHands: 'last 8 completed public hands',
      publicPlayerStats: 'deterministic aggregates from completed hands before the current hand; identical public dataset for every seat',
    },
    tournament: { handNumber: 100, blindLevel: 5, playersRemaining: 2, startingPlayers: 2 },
    blinds: { smallBlind: 50, bigBlind: 100, ante: 0 },
    hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 5000, stackBB: 50, cards: ['As', 'Kd'], currentBet: 0 },
    betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 5000, facingAllInCall: false },
    board: [], street: 'PREFLOP', pot: 150, buttonSeat: 1,
    actionHistory: [], recentHands: [], publicPlayerStats: [...PUBLIC_STATS],
    opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 5000, stackBB: 50, currentBet: 0, status: 'ACTIVE', cards: [] }],
    legalActions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Layer A — action-id / protocol mapping. Poker knowledge is irrelevant here;
// the only task is to map a description to the correct opaque identifier.
// ---------------------------------------------------------------------------
const PROTOCOL_PERMUTATIONS = [
  { id: 'protocol-target-a2', order: [['A0', 'Fold'], ['A1', 'Check'], ['A2', 'Bet 500']], target: 'A2' },
  { id: 'protocol-target-a0', order: [['A0', 'Raise to 900'], ['A1', 'Fold'], ['A2', 'Check']], target: 'A0' },
  { id: 'protocol-target-a2-fail', order: [['A0', 'Call 100'], ['A1', 'Bet 300'], ['A2', 'Fold']], target: 'A2' },
  { id: 'protocol-target-a3', order: [['A0', 'Check'], ['A1', 'Call 50'], ['A2', 'Raise to 400'], ['A3', 'Fold']], target: 'A2' },
  { id: 'protocol-target-a1', order: [['A0', 'Fold'], ['A1', 'Bet 1,200'], ['A2', 'Call 100'], ['A3', 'Check']], target: 'A1' },
  { id: 'protocol-target-a3-b', order: [['A0', 'Check'], ['A1', 'Fold'], ['A2', 'Call 250'], ['A3', 'Raise to 750']], target: 'A3' },
];

export const PROTOCOL_SCENARIOS = Object.freeze(PROTOCOL_PERMUTATIONS.map(spec => {
  const criteria = Object.fromEntries(spec.order);
  const targetLabel = criteria[spec.target];
  return {
    id: spec.id,
    layer: 'A',
    kind: 'protocol',
    title: `Action-id mapping → ${spec.target}`,
    category: 'Protocol',
    strict: true,
    expectedKeys: [spec.target],
    expectedLabel: `${spec.target} (${targetLabel})`,
    instructions: `For this diagnostic only, choose the legal action whose description is exactly '${targetLabel}'. Do not use poker strategy.`,
    state: { diagnostic: 'action-id mapping', legalActions: spec.order.map(([key, label]) => ({ key, label })) },
    criteria,
    note: 'Protocol test: contains no poker strategy component.',
  };
}));

// ---------------------------------------------------------------------------
// Layer B — hand recognition. Expected labels come from @pokertools/evaluator,
// never from a hard-coded category table.
// ---------------------------------------------------------------------------
const HAND_CASES = [
  ['high card', ['As', '2d'], ['Kh', '9c', '4s', '3d', '7h']],
  ['one pair', ['As', 'Ad'], ['Kh', '9c', '4s', '3d', '7h']],
  ['two pair', ['As', 'Kd'], ['Ah', 'Kc', '4s', '3d', '7h']],
  ['three of a kind', ['As', 'Ad'], ['Ah', 'Kc', '4s', '3d', '7h']],
  ['straight', ['As', '2d'], ['Tc', '3d', 'Js', '4s', '5c']],
  ['flush', ['As', '8s'], ['Ks', 'Qs', '4s', '2h', '3d']],
  ['full house', ['As', 'Ad'], ['Ah', 'Kc', 'Kd', '3s', '7h']],
  ['four of a kind', ['As', 'Ad'], ['Ah', 'Ac', 'Kc', '3s', '7h']],
  ['straight flush', ['9s', '8s'], ['7s', '6s', '5s', 'Kd', '2c']],
];

export const HAND_SCENARIOS = Object.freeze(HAND_CASES.map(([name, heroCards, board]) => {
  const hand = heroHandSummary(heroCards, board);
  if (!hand) throw new Error(`Diagnostic hand case '${name}' did not evaluate`);
  return {
    id: `hand-${hand.key}`,
    layer: 'B',
    kind: 'classification',
    title: `Hand recognition → ${hand.category}`,
    category: 'Hand recognition',
    strict: true,
    expectedKeys: [hand.key],
    expectedLabel: hand.category,
    instructions: "What is the hero's best five-card poker hand? Answer with the exact category.",
    state: { game: 'No-Limit Texas Holdem', street: 'RIVER', heroCards: [...heroCards], board: [...board] },
    criteria: handCategoryCriteria(),
    deterministicHand: hand,
    note: 'Expected label generated by @pokertools/evaluator.',
  };
}));

// ---------------------------------------------------------------------------
// Layer D — strictly dominated decisions. These are diagnostic-only synthetic
// states. Some deliberately expose normally-hidden information, or specify a
// deterministic opponent policy. They must never run in tournament mode.
// ---------------------------------------------------------------------------
export const DOMINATED_SCENARIOS = Object.freeze([
  {
    id: 'dominated-free-check-vs-fold',
    layer: 'D',
    kind: 'action',
    title: 'Free check vs fold',
    category: 'Strict dominance',
    strict: true,
    expectedTypes: [ACTION.CHECK],
    expectedLabel: 'CHECK (free, preserves all equity)',
    diagnosticOnly: true,
    hierarchicalCompatible: false,
    instructions: 'Choose the strictly dominant action. Checking costs nothing and keeps every remaining outcome; folding forfeits the hand for free.',
    state: diagnosticState({
      street: 'FLOP', pot: 400,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 4000, stackBB: 40, cards: ['7c', '2d'], currentBet: 0 },
      board: ['As', 'Kd', 'Qh'],
      betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 4000, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 4000, stackBB: 40, currentBet: 0, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CHECK, 'Check')],
    }),
    note: 'Diagnostic-only: the arena now removes FOLD here, but this probes whether the model recognizes free equity.',
  },
  {
    id: 'dominated-nuts-vs-allin',
    layer: 'D',
    kind: 'action',
    title: 'Absolute nuts vs all-in',
    category: 'Strict dominance',
    strict: true,
    expectedTypes: [ACTION.CALL],
    expectedLabel: 'CALL (unbeatable royal flush)',
    diagnosticOnly: true,
    instructions: 'Hero holds the absolute nuts on the river and faces an all-in. There is no future action, no tie, and no better opponent hand.',
    state: diagnosticState({
      street: 'RIVER', pot: 6000,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 4000, stackBB: 40, cards: ['As', 'Ks'], currentBet: 0 },
      board: ['Qs', 'Js', 'Ts', '2d', '3c'],
      betting: { highestBet: 4000, heroCurrentBet: 0, toCall: 4000, effectiveCall: 4000, stackBehind: 4000, facingAllInCall: true },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 0, stackBB: 0, currentBet: 4000, status: 'ALL_IN', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 4000 (all-in)')],
    }),
    note: 'Royal flush = As Ks on Qs Js Ts: deterministically unbeatable, no tie possible.',
  },
  {
    id: 'dominated-dead-hand-vs-allin',
    layer: 'D',
    kind: 'action',
    title: 'Dead hand vs all-in (perfect information)',
    category: 'Perfect-information diagnostic',
    strict: true,
    expectedTypes: [ACTION.FOLD],
    expectedLabel: 'FOLD (zero win/tie equity)',
    diagnosticOnly: true,
    leaksOpponentCards: true,
    instructions: 'This is a perfect-information diagnostic. The villain has Ah Ad; hero holds 7d 2d on Ac Kh Qh 9s 3c and cannot win or tie. Hero faces an all-in with no future action.',
    state: (() => {
      const s = diagnosticState({
        street: 'RIVER', pot: 5000,
        hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 3000, stackBB: 30, cards: ['7d', '2d'], currentBet: 0 },
        board: ['Ac', 'Kh', 'Qh', '9s', '3c'],
        betting: { highestBet: 3000, heroCurrentBet: 0, toCall: 3000, effectiveCall: 3000, stackBehind: 3000, facingAllInCall: true },
        opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 0, stackBB: 0, currentBet: 3000, status: 'ALL_IN', cards: [] }],
        legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 3000 (all-in)')],
      });
      s.diagnosticPerfectInformation = {
        opponentCards: ['Ah', 'Ad'],
        note: 'Diagnostic-only perfect information. Never expose villain hole cards in tournament mode.',
      };
      return s;
    })(),
    note: 'Deterministically labelled as a diagnostic-only perfect-information spot; hero cannot win or tie.',
  },
  {
    id: 'dominated-nuts-forced-call',
    layer: 'D',
    kind: 'action',
    title: 'Nuts vs opponent who always calls',
    category: 'Synthetic value betting',
    strict: true,
    expectedTypes: [ACTION.BET],
    expectedAmountType: 'all-in',
    expectedLabel: 'BET ALL-IN (opponent calls with probability 1)',
    diagnosticOnly: true,
    synthetic: true,
    instructions: 'Synthetic diagnostic. The opponent calls any legal bet with probability 1. Hero holds the absolute nuts on the river with no future action.',
    state: (() => {
      const s = diagnosticState({
        street: 'RIVER', pot: 2000,
        hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 3000, stackBB: 30, cards: ['As', 'Ks'], currentBet: 0 },
        board: ['Qs', 'Js', 'Ts', '2d', '3c'],
        betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 3000, facingAllInCall: false },
        opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 3000, stackBB: 30, currentBet: 0, status: 'ACTIVE', cards: [] }],
        legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 3000 (all-in)', 3000)],
      });
      s.diagnosticSynthetic = { opponentPolicy: 'Villain calls any legal bet with probability 1.', note: 'Diagnostic-only synthetic behaviour; not tournament poker.' };
      return s;
    })(),
    note: 'Synthetic: isolates value-betting when fold equity is removed by definition.',
  },
  {
    id: 'dominated-nuts-forced-call-normal-size',
    layer: 'D',
    kind: 'action',
    title: 'Nuts vs always-caller: smaller value bet available',
    category: 'Synthetic value betting',
    strict: true,
    expectedTypes: [ACTION.BET],
    expectedLabel: 'BET (any value bet is acceptable; folding/checking is not)',
    diagnosticOnly: true,
    synthetic: true,
    instructions: 'Synthetic diagnostic. The opponent calls any legal bet with probability 1. Hero holds the absolute nuts. A value bet is strictly dominant; checking wins nothing extra and folding is absurd.',
    state: (() => {
      const s = diagnosticState({
        street: 'RIVER', pot: 2000,
        hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 3000, stackBB: 30, cards: ['As', 'Ks'], currentBet: 0 },
        board: ['Qs', 'Js', 'Ts', '2d', '3c'],
        betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 3000, facingAllInCall: false },
        opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 3000, stackBB: 30, currentBet: 0, status: 'ACTIVE', cards: [] }],
        legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 1000 (10 BB)', 1000), action('A2', ACTION.BET, 'Bet 3000 (all-in)', 3000)],
      });
      s.diagnosticSynthetic = { opponentPolicy: 'Villain calls any legal bet with probability 1.', note: 'Diagnostic-only synthetic behaviour; not tournament poker.' };
      return s;
    })(),
    note: 'Synthetic: both bet sizes are acceptable, passivity is not.',
  },
]);

// ---------------------------------------------------------------------------
// Regression probe — the exact observed river state from a real tournament.
// It is intentionally NOT a gold test: river strategy depends on ranges and
// tournament incentives. It is kept to reproduce the passive-action phenomenon.
// ---------------------------------------------------------------------------
export const RIVER_PROBE_STATE = diagnosticState({
  street: 'RIVER', pot: 14375,
  hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 5369, stackBB: 53.7, cards: ['As', '2d'], currentBet: 0 },
  board: ['Tc', '3d', 'Js', '4s', '5c'],
  betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 5369, facingAllInCall: false },
  opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 4494, stackBB: 44.9, currentBet: 0, status: 'ACTIVE', cards: [] }],
  legalActions: [
    action('A0', ACTION.CHECK, 'Check'),
    action('A1', ACTION.BET, 'Bet 1150 (11.5 BB)', 1150),
    action('A2', ACTION.BET, 'Bet 2300 (23 BB)', 2300),
    action('A3', ACTION.BET, 'Bet 5369 (all-in)', 5369),
  ],
});

export const RIVER_PROBE = Object.freeze({
  id: 'probe-river-straight-passivity',
  layer: 'P',
  kind: 'action',
  title: 'Observed river passivity probe (5-high straight)',
  category: 'Regression probe',
  strict: false,
  expectedTypes: [ACTION.CHECK, ACTION.BET],
  expectedLabel: 'No gold answer — river strategy is range dependent',
  instructions: DECISION_OBJECTIVE,
  state: RIVER_PROBE_STATE,
  deterministicHand: heroHandSummary(['As', '2d'], ['Tc', '3d', 'Js', '4s', '5c']),
  note: 'Exact observed state. Not proof of understanding; used for representation and probability-mass analysis.',
});

// ---------------------------------------------------------------------------
// Layer E — strategy sanity checks. Range/model dependent; never "objectively
// correct". Reuses the existing ten-scenario suite.
// ---------------------------------------------------------------------------
export const STRATEGY_SCENARIOS = Object.freeze(DECISION_SANITY_SCENARIOS.map(s => ({
  id: `strategy-${s.id}`,
  layer: 'E',
  kind: 'action',
  title: s.title,
  category: s.category,
  strict: false,
  expectedTypes: [...s.expectedTypes],
  expectedLabel: `one of: ${s.expectedTypes.join(' / ')}`,
  state: s.state,
  note: s.note,
})));

export const STRICT_SCENARIOS = Object.freeze([
  ...PROTOCOL_SCENARIOS,
  ...HAND_SCENARIOS,
  ...DOMINATED_SCENARIOS,
]);

export function scenariosForLayers(layers) {
  const wanted = new Set((layers ?? []).map(l => String(l).toUpperCase()));
  const all = [...STRICT_SCENARIOS, RIVER_PROBE, ...STRATEGY_SCENARIOS];
  if (!wanted.size) return all;
  return all.filter(s => wanted.has(String(s.layer).toUpperCase()));
}

// ---------------------------------------------------------------------------
// Section 17 — action-fragmentation experiment.
//
// The exact same poker state is offered with increasingly granular aggressive
// menus. This isolates whether the number of bet-size classes, rather than the
// underlying strategy, drives CHECK frequency.
// ---------------------------------------------------------------------------
export const FRAGMENTATION_STATES = Object.freeze({
  'value-wheel': Object.freeze({
    label: 'Value: wheel straight (river, stack < pot)',
    state: RIVER_PROBE_STATE,
  }),
  'value-deep': Object.freeze({
    label: 'Value: wheel straight (deep stack)',
    state: diagnosticState({
      street: 'RIVER', pot: 3000,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 8000, stackBB: 80, cards: ['As', '2d'], currentBet: 0 },
      board: ['Tc', '3d', 'Js', '4s', '5c'],
      betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 8000, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 8000, stackBB: 80, currentBet: 0, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 1000 (10 BB)', 1000)],
    }),
  }),
  'bluff-air': Object.freeze({
    label: 'Bluff: ace-high air (river)',
    state: diagnosticState({
      street: 'RIVER', pot: 3000,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 4000, stackBB: 40, cards: ['As', 'Kd'], currentBet: 0 },
      board: ['Qs', '7h', '2c', '9d', '3s'],
      betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 4000, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 4000, stackBB: 40, currentBet: 0, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 1000 (10 BB)', 1000), action('A2', ACTION.BET, 'Bet 4000 (all-in)', 4000)],
    }),
  }),
});

function fragmentationMenu(entry, variant) {
  const state = entry.state;
  const check = (state.legalActions ?? []).find(a => a.type === ACTION.CHECK) ?? action('A0', ACTION.CHECK, 'Check');
  const sizes = aggressiveSizesForState(state, ACTION_FAMILY.BET);
  const allIn = sizes.find(s => s.id === 'all_in');
  const small = sizes.find(s => s.id === 'small') ?? sizes[0];
  const medium = sizes.find(s => s.id === 'medium');
  const large = sizes.find(s => s.id === 'large');
  const toAction = (size, index) => action(`A${index + 1}`, ACTION.BET, size.label, size.amount);
  let bets;
  let menuLabel;
  if (variant === 'A') { bets = [allIn].filter(Boolean); menuLabel = 'A · CHECK / BET ALL-IN'; }
  else if (variant === 'B') { bets = [small, allIn].filter(Boolean); menuLabel = 'B · CHECK / BET SMALL / ALL-IN'; }
  else { bets = sizes; menuLabel = 'C · CHECK / BET SMALL / MEDIUM / LARGE / ALL-IN'; }
  const legalActions = [check, ...bets.map((s, i) => toAction(s, i))];
  return { menuLabel, state: { ...state, legalActions } };
}

export const FRAGMENTATION_SCENARIOS = Object.freeze(
  Object.entries(FRAGMENTATION_STATES).flatMap(([key, entry]) =>
    ['A', 'B', 'C'].map(variant => {
      const menu = fragmentationMenu(entry, variant);
      return {
        id: `frag-${key}-${variant}`,
        layer: 'F',
        kind: 'action',
        title: `Fragmentation ${variant} · ${entry.label}`,
        category: 'Action fragmentation',
        strict: false,
        expectedTypes: [ACTION.CHECK, ACTION.BET],
        expectedLabel: 'Behavioral probe — no gold answer',
        menu: menu.menuLabel,
        fragmentationVariant: variant,
        state: menu.state,
        note: 'Measures how menu granularity changes CHECK frequency for the same poker state.',
      };
    }),
  ),
);

// Hierarchical counterpart for variant D: the canonical full state; the
// adapter performs the two-stage family/size decision itself.
export const FRAGMENTATION_HIERARCHICAL_SCENARIOS = Object.freeze(
  Object.entries(FRAGMENTATION_STATES).map(([key, entry]) => ({
    id: `frag-${key}-D`,
    layer: 'F',
    kind: 'action',
    title: `Fragmentation D · hierarchical · ${entry.label}`,
    category: 'Action fragmentation',
    strict: false,
    expectedTypes: [ACTION.CHECK, ACTION.BET],
    expectedLabel: 'Behavioral probe — no gold answer',
    menu: 'D · hierarchical CHECK/BET → size',
    fragmentationVariant: 'D',
    state: entry.state,
    note: 'Hierarchical action-family then size.',
  })),
);

// Section 20 — the regression probe in the four required combinations.
export function riverProbeScenarios() {
  const base = { ...RIVER_PROBE };
  const hand = heroHandSummary(RIVER_PROBE_STATE.hero.cards, RIVER_PROBE_STATE.board);
  const heroHandState = hand ? { ...RIVER_PROBE_STATE, heroHand: hand } : { ...RIVER_PROBE_STATE };
  return [
    { ...base, id: 'probe-flat-raw', title: 'Probe · flat · raw cards', menu: 'probe · flat / raw', architecture: 'flat', state: RIVER_PROBE_STATE },
    { ...base, id: 'probe-flat-herohand', title: 'Probe · flat · heroHand', menu: 'probe · flat / heroHand', architecture: 'flat', state: heroHandState },
    { ...base, id: 'probe-hierarchical-raw', title: 'Probe · hierarchical · raw cards', menu: 'probe · hierarchical / raw', architecture: 'hierarchical', state: RIVER_PROBE_STATE },
    { ...base, id: 'probe-hierarchical-herohand', title: 'Probe · hierarchical · heroHand', menu: 'probe · hierarchical / heroHand', architecture: 'hierarchical', state: heroHandState },
  ];
}

export { ACTION, DECISION_CONTEXT_VERSION, DECISION_OBJECTIVE, INFORMATION_POLICY };
