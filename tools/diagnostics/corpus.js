// Reusable immutable fixed-state corpus (release 0.4.0).
//
// Every action state below is production-shaped (`contextVersion`,
// `informationPolicy`, masked opponents, canonical legal actions). The same
// exact object is used for flat and hierarchical decisions, for every model,
// for Strategy and Raw modes, and for every representation. That is what makes
// the paired benchmark a controlled comparison rather than a comparison of
// unrelated tournament trajectories.
//
// `expected` is only set where the assumptions make the answer deterministic
// (strict dominance, perfect information, or an explicitly declared synthetic
// opponent policy). Strategically ambiguous spots carry `expected: null` and
// are behavioral probes, never gold answers.
import { ACTION, ACTION_FAMILY, heroHandSummary } from '../../src/lib/decision-core.js';
import { diagnosticState, action, HAND_SCENARIOS } from './scenarios.js';

function state(overrides) { return diagnosticState(overrides); }

// ---------------------------------------------------------------------------
// Strict legality / dominance
// ---------------------------------------------------------------------------
const STRICT_LEGALITY = [
  {
    id: 'river-free-check-dominance-001',
    category: 'strict_legality',
    street: 'FLOP',
    kind: 'action',
    tags: ['dominance', 'check', 'hierarchy', 'fragmentation'],
    note: 'A free CHECK preserves every future outcome; folding it is strictly dominated. The arena does not even offer FOLD here.',
    expected: { family: ACTION_FAMILY.CHECK },
    state: state({
      street: 'FLOP', pot: 400,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 4000, stackBB: 40, cards: ['7c', '2d'], currentBet: 0 },
      board: ['As', 'Kd', 'Qh'],
      betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 4000, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 4000, stackBB: 40, currentBet: 0, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 1,200 chips (300% pot)', 1200)],
    }),
  },
  {
    id: 'river-nuts-facing-allin-001',
    category: 'strict_legality',
    street: 'RIVER',
    kind: 'action',
    tags: ['nuts', 'call', 'all-in', 'hierarchy'],
    note: 'Royal flush is deterministically unbeatable and cannot tie on Qs Js Ts 2d 3c. Folding to the all-in is a strict error.',
    expected: { family: ACTION_FAMILY.CALL },
    state: state({
      street: 'RIVER', pot: 6000,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 4000, stackBB: 40, cards: ['As', 'Ks'], currentBet: 0 },
      board: ['Qs', 'Js', 'Ts', '2d', '3c'],
      betting: { highestBet: 4000, heroCurrentBet: 0, toCall: 4000, effectiveCall: 4000, stackBehind: 4000, facingAllInCall: true },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 0, stackBB: 0, currentBet: 4000, status: 'ALL_IN', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 4000 (all-in)')],
    }),
  },
  {
    id: 'river-zero-equity-fold-001',
    category: 'strict_legality',
    street: 'RIVER',
    kind: 'action',
    tags: ['fold', 'perfect-information', 'diagnostic-only'],
    note: 'Perfect-information diagnostic: villain holds Ah Ad, hero cannot win or tie. Never exposed in tournament mode.',
    diagnosticOnly: true,
    leaksOpponentCards: true,
    expected: { family: ACTION_FAMILY.FOLD },
    state: (() => {
      const s = state({
        street: 'RIVER', pot: 5000,
        hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 3000, stackBB: 30, cards: ['7d', '2d'], currentBet: 0 },
        board: ['Ac', 'Kh', 'Qh', '9s', '3c'],
        betting: { highestBet: 3000, heroCurrentBet: 0, toCall: 3000, effectiveCall: 3000, stackBehind: 3000, facingAllInCall: true },
        opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 0, stackBB: 0, currentBet: 3000, status: 'ALL_IN', cards: [] }],
        legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 3000 (all-in)')],
      });
      s.diagnosticPerfectInformation = { opponentCards: ['Ah', 'Ad'], note: 'Diagnostic-only perfect information. Never expose villain hole cards in tournament mode.' };
      return s;
    })(),
  },
  {
    id: 'river-nuts-forced-call-allin-001',
    category: 'strict_legality',
    street: 'RIVER',
    kind: 'action',
    tags: ['value', 'sizing', 'all-in', 'synthetic'],
    note: 'Synthetic: the opponent calls any legal bet with probability 1 and hero holds the nuts on the river. BET is dominant; ALL-IN is the unique chip-maximising size.',
    synthetic: true,
    expected: { family: ACTION_FAMILY.BET, size: 'all_in' },
    state: (() => {
      const s = state({
        street: 'RIVER', pot: 2000,
        hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 3000, stackBB: 30, cards: ['As', 'Ks'], currentBet: 0 },
        board: ['Qs', 'Js', 'Ts', '2d', '3c'],
        betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 3000, facingAllInCall: false },
        opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 3000, stackBB: 30, currentBet: 0, status: 'ACTIVE', cards: [] }],
        legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 1,000 chips (50% pot)', 1000), action('A2', ACTION.BET, 'Bet 3,000 chips all-in', 3000)],
      });
      s.diagnosticSynthetic = { opponentPolicy: 'Villain calls any legal bet with probability 1.', note: 'Diagnostic-only synthetic behaviour; not tournament poker.' };
      return s;
    })(),
  },
  {
    id: 'river-nuts-forced-call-family-001',
    category: 'strict_legality',
    street: 'RIVER',
    kind: 'action',
    tags: ['value', 'family', 'synthetic'],
    note: 'Synthetic: opponent calls with probability 1. A value BET is dominant; the size is strategically open, so only the family is gold.',
    synthetic: true,
    expected: { family: ACTION_FAMILY.BET },
    state: (() => {
      const s = state({
        street: 'RIVER', pot: 2000,
        hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 3000, stackBB: 30, cards: ['As', 'Ks'], currentBet: 0 },
        board: ['Qs', 'Js', 'Ts', '2d', '3c'],
        betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 3000, facingAllInCall: false },
        opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 3000, stackBB: 30, currentBet: 0, status: 'ACTIVE', cards: [] }],
        legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 1,000 chips (50% pot)', 1000)],
      });
      s.diagnosticSynthetic = { opponentPolicy: 'Villain calls any legal bet with probability 1.', note: 'Diagnostic-only synthetic behaviour; not tournament poker.' };
      return s;
    })(),
  },
  {
    id: 'facing-shove-no-legal-raise-001',
    category: 'strict_legality',
    street: 'PREFLOP',
    kind: 'legality',
    tags: ['legality', 'short-stack', 'no-raise'],
    note: 'A short stack that cannot reach the current price must never see a pseudo-raise; only FOLD/CALL are legal.',
    expectedFamilies: [ACTION_FAMILY.FOLD, ACTION_FAMILY.CALL],
    state: state({
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 900, stackBB: 9, cards: ['Ah', 'Jd'], currentBet: 100 },
      pot: 1500,
      betting: { highestBet: 1200, heroCurrentBet: 100, toCall: 1100, effectiveCall: 900, stackBehind: 900, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 0, stackBB: 0, currentBet: 1200, status: 'ALL_IN', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 900 (all-in)')],
    }),
  },
  {
    id: 'preflop-short-stack-call-semantics-001',
    category: 'strict_legality',
    street: 'PREFLOP',
    kind: 'action',
    tags: ['legality', 'short-stack', 'call'],
    note: 'Calling more than the stack is a real all-in call; the call amount is clamped to the stack.',
    expected: { family: ACTION_FAMILY.CALL },
    state: state({
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 400, stackBB: 4, cards: ['As', 'Ah'], currentBet: 100 },
      pot: 700,
      betting: { highestBet: 1000, heroCurrentBet: 100, toCall: 900, effectiveCall: 400, stackBehind: 400, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 0, stackBB: 0, currentBet: 1000, status: 'ALL_IN', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 400 (all-in)')],
    }),
  },
];

// ---------------------------------------------------------------------------
// Value betting — strong made hands with no gold answer
// ---------------------------------------------------------------------------
const VALUE = [
  {
    id: 'river-nut-flush-value-001', category: 'value', street: 'RIVER', kind: 'action',
    tags: ['value', 'river', 'hierarchy', 'fragmentation'], expected: null,
    note: 'Nut flush on the river with no gold answer: betting or checking are both defensible against an unknown range.',
    state: state({
      street: 'RIVER', pot: 2000,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 6000, stackBB: 60, cards: ['As', '8s'], currentBet: 0 },
      board: ['Ks', 'Qs', '4s', '2h', '3d'],
      betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 6000, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 6000, stackBB: 60, currentBet: 0, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 660 chips (33% pot)', 660), action('A2', ACTION.BET, 'Bet 1,340 chips (67% pot)', 1340), action('A3', ACTION.BET, 'Bet 2,000 chips (100% pot)', 2000), action('A4', ACTION.BET, 'Bet 6,000 chips all-in', 6000)],
    }),
  },
  {
    id: 'river-set-value-001', category: 'value', street: 'RIVER', kind: 'action',
    tags: ['value', 'river', 'hierarchy'], expected: null,
    note: 'Middle set on a dry-ish river. Value betting is common but no gold answer.',
    state: state({
      street: 'RIVER', pot: 1800,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 7000, stackBB: 70, cards: ['9h', '9c'], currentBet: 0 },
      board: ['9s', 'Kd', '4c', '2h', '7s'],
      betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 7000, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 7000, stackBB: 70, currentBet: 0, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 600 chips (33% pot)', 600), action('A2', ACTION.BET, 'Bet 7,000 chips all-in', 7000)],
    }),
  },
  {
    id: 'turn-two-pair-value-001', category: 'value', street: 'TURN', kind: 'action',
    tags: ['value', 'turn', 'hierarchy'], expected: null,
    note: 'Top two pair on the turn; the river is still to come, so checking and betting both have merit.',
    state: state({
      street: 'TURN', pot: 1200,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 6000, stackBB: 60, cards: ['Ah', 'Kd'], currentBet: 0 },
      board: ['As', 'Kc', '7h', '2d'],
      betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 6000, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 6000, stackBB: 60, currentBet: 0, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 400 chips (33% pot)', 400), action('A2', ACTION.BET, 'Bet 6,000 chips all-in', 6000)],
    }),
  },
  {
    id: 'river-overpair-value-001', category: 'value', street: 'RIVER', kind: 'action',
    tags: ['value', 'river'], expected: null,
    note: 'Overpair to the board on the river; range-dependent.',
    state: state({
      street: 'RIVER', pot: 1600,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 5000, stackBB: 50, cards: ['Qh', 'Qc'], currentBet: 0 },
      board: ['9s', '5d', '2c', 'Js', '3h'],
      betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 5000, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 5000, stackBB: 50, currentBet: 0, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 528 chips (33% pot)', 528), action('A2', ACTION.BET, 'Bet 5,000 chips all-in', 5000)],
    }),
  },
];

// ---------------------------------------------------------------------------
// Bluffing — controlled synthetic spots, no gold answer
// ---------------------------------------------------------------------------
const BLUFF = [
  {
    id: 'river-missed-draw-bluff-001', category: 'bluff', street: 'RIVER', kind: 'action',
    tags: ['bluff', 'river', 'fragmentation'], expected: null,
    note: 'Ace-high air with no showdown value. Bluffing depends entirely on the opponent range, so there is no gold answer.',
    state: state({
      street: 'RIVER', pot: 3000,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 5000, stackBB: 50, cards: ['As', 'Kd'], currentBet: 0 },
      board: ['Qs', '7h', '2c', '9d', '3s'],
      betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 5000, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 5000, stackBB: 50, currentBet: 0, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 990 chips (33% pot)', 990), action('A2', ACTION.BET, 'Bet 5,000 chips all-in', 5000)],
    }),
  },
  {
    id: 'turn-semi-bluff-001', category: 'bluff', street: 'TURN', kind: 'action',
    tags: ['bluff', 'semi-bluff', 'turn'], expected: null,
    note: 'Nut flush draw on the turn: semi-bluffing is defensible but not forced.',
    state: state({
      street: 'TURN', pot: 2200,
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 8000, stackBB: 80, cards: ['As', '5s'], currentBet: 0 },
      board: ['Ks', '8s', '2d', 'Jc'],
      betting: { highestBet: 0, heroCurrentBet: 0, toCall: 0, effectiveCall: 0, stackBehind: 8000, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 8000, stackBB: 80, currentBet: 0, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.CHECK, 'Check'), action('A1', ACTION.BET, 'Bet 726 chips (33% pot)', 726), action('A2', ACTION.BET, 'Bet 1,474 chips (67% pot)', 1474)],
    }),
  },
];

// ---------------------------------------------------------------------------
// Preflop
// ---------------------------------------------------------------------------
const PREFLOP = [
  {
    id: 'preflop-aces-vs-short-shove-001', category: 'preflop', street: 'PREFLOP', kind: 'action',
    tags: ['preflop', 'premium', 'call'], expected: { family: ACTION_FAMILY.CALL },
    note: 'Pocket aces facing a short-stack shove with only FOLD/CALL legal; folding is a basic error.',
    state: state({
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 9600, stackBB: 96, cards: ['As', 'Ah'], currentBet: 100 },
      pot: 2550,
      betting: { highestBet: 2500, heroCurrentBet: 100, toCall: 2400, effectiveCall: 2400, stackBehind: 9600, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 0, stackBB: 0, currentBet: 2500, status: 'ALL_IN', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 2400 (24 BB)')],
    }),
  },
  {
    id: 'preflop-seven-deuce-vs-shove-001', category: 'preflop', street: 'PREFLOP', kind: 'action',
    tags: ['preflop', 'fold', 'marginal'], expected: { family: ACTION_FAMILY.FOLD },
    note: 'Seven-deuce offsuit facing a 100 BB shove with little dead money; folding is the strict expectation.',
    state: state({
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 9900, stackBB: 99, cards: ['7c', '2d'], currentBet: 100 },
      pot: 10150,
      betting: { highestBet: 10000, heroCurrentBet: 100, toCall: 9900, effectiveCall: 9900, stackBehind: 9900, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN/SB', stack: 0, stackBB: 0, currentBet: 10000, status: 'ALL_IN', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 9900 (99 BB)')],
    }),
  },
  {
    id: 'preflop-premium-btn-open-001', category: 'preflop', street: 'PREFLOP', kind: 'action',
    tags: ['preflop', 'premium', 'unopened'], expected: null,
    note: 'Aces on the button facing a single raise; calling and re-raising are both defensible, so no gold answer.',
    state: state({
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BTN', stack: 9900, stackBB: 99, cards: ['As', 'Ah'], currentBet: 0 },
      pot: 450,
      betting: { highestBet: 300, heroCurrentBet: 0, toCall: 300, effectiveCall: 300, stackBehind: 9900, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BB', stack: 9700, stackBB: 97, currentBet: 300, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 300 (3 BB)'), action('A2', ACTION.RAISE, 'Raise to 900 chips (9 BB)', 900)],
    }),
  },
  {
    id: 'preflop-marginal-co-001', category: 'preflop', street: 'PREFLOP', kind: 'action',
    tags: ['preflop', 'marginal'], expected: null,
    note: 'KQo in the cutoff facing a raise; all three families can be correct depending on ranges.',
    state: state({
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'CO', stack: 9800, stackBB: 98, cards: ['Kd', 'Qc'], currentBet: 0 },
      pot: 450,
      betting: { highestBet: 300, heroCurrentBet: 0, toCall: 300, effectiveCall: 300, stackBehind: 9800, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BB', stack: 9700, stackBB: 97, currentBet: 300, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 300 (3 BB)'), action('A2', ACTION.RAISE, 'Raise to 900 chips (9 BB)', 900)],
    }),
  },
  {
    id: 'preflop-blind-defense-001', category: 'preflop', street: 'PREFLOP', kind: 'action',
    tags: ['preflop', 'blind-defense'], expected: null,
    note: 'Suited connector in the big blind facing a min-raise; defense depends on the opponent.',
    state: state({
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BB', stack: 9900, stackBB: 99, cards: ['7s', '6s'], currentBet: 100 },
      pot: 350,
      betting: { highestBet: 200, heroCurrentBet: 100, toCall: 100, effectiveCall: 100, stackBehind: 9900, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BTN', stack: 9800, stackBB: 98, currentBet: 200, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 100 (1 BB)'), action('A2', ACTION.RAISE, 'Raise to 600 chips (6 BB)', 600)],
    }),
  },
  {
    id: 'preflop-blind-defense-unopened-001', category: 'preflop', street: 'PREFLOP', kind: 'action',
    tags: ['preflop', 'unopened'], expected: null,
    note: 'Unopened small-blind completion spot: fold, call and raise are all legal and all defensible.',
    state: state({
      hero: { id: 'diag-hero', name: 'Hero', seat: 1, position: 'BTN/SB', stack: 9900, stackBB: 99, cards: ['Ad', '4d'], currentBet: 50 },
      pot: 150,
      betting: { highestBet: 100, heroCurrentBet: 50, toCall: 50, effectiveCall: 50, stackBehind: 9900, facingAllInCall: false },
      opponents: [{ id: 'diag-villain', seat: 2, name: 'Villain', position: 'BB', stack: 9900, stackBB: 99, currentBet: 100, status: 'ACTIVE', cards: [] }],
      legalActions: [action('A0', ACTION.FOLD, 'Fold'), action('A1', ACTION.CALL, 'Call 50 (0.5 BB)'), action('A2', ACTION.RAISE, 'Raise to 300 chips (3 BB)', 300)],
    }),
  },
];

// Hand recognition is a distinct benchmark track; expected labels come from the
// deterministic evaluator.
const HAND_RECOGNITION = HAND_SCENARIOS.map(scenario => ({
  id: `recognition-${scenario.id.replace(/^hand-/, '')}`,
  category: 'hand_recognition',
  street: 'RIVER',
  kind: 'classification',
  tags: ['hand-recognition'],
  expected: null,
  expectedKeys: [...scenario.expectedKeys],
  deterministicHand: scenario.deterministicHand,
  note: scenario.note,
  state: scenario.state,
  criteria: scenario.criteria,
  instructions: scenario.instructions,
}));

// ---------------------------------------------------------------------------
// Representation sensitivity reuses exact corpus states, never new semantics.
// ---------------------------------------------------------------------------
export const REPRESENTATION_CORPUS_IDS = Object.freeze([
  'river-nut-flush-value-001',
  'river-missed-draw-bluff-001',
  'river-free-check-dominance-001',
  'river-nuts-forced-call-family-001',
]);

export const CORPUS = Object.freeze([
  ...STRICT_LEGALITY,
  ...VALUE,
  ...BLUFF,
  ...PREFLOP,
  ...HAND_RECOGNITION,
]);

export const CORPUS_CATEGORIES = Object.freeze([...new Set(CORPUS.map(entry => entry.category))]);

export const ACTION_CORPUS = Object.freeze(CORPUS.filter(entry => entry.kind === 'action'));
export const STRICT_CORPUS = Object.freeze(CORPUS.filter(entry => entry.kind === 'action' && entry.diagnosticOnly !== true && !entry.synthetic));
export const SYNTHETIC_CORPUS = Object.freeze(CORPUS.filter(entry => entry.synthetic));
export const DIAGNOSTIC_ONLY_CORPUS = Object.freeze(CORPUS.filter(entry => entry.diagnosticOnly));

export function corpusById(corpusId) { return CORPUS.find(entry => entry.id === corpusId) ?? null; }

export function corpusForCategories(categories) {
  const wanted = new Set(categories ?? []);
  return wanted.size ? CORPUS.filter(entry => wanted.has(entry.category)) : [...CORPUS];
}

// The expected action family of an entry, or null when the state is a probe.
export function expectedFamily(entry) {
  if (!entry?.expected) return null;
  return entry.expected.family ?? null;
}

export function expectedSize(entry) {
  if (!entry?.expected) return null;
  return entry.expected.size ?? null;
}

// Reconstruct a deterministic hand for a corpus action state when possible.
export function corpusHeroHand(entry) {
  const cards = entry?.state?.hero?.cards ?? entry?.state?.heroCards;
  return cards ? heroHandSummary(cards, entry.state.board ?? []) : null;
}

export { ACTION, ACTION_FAMILY };
