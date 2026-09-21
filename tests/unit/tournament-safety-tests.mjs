// Tournament-safety regression tests.
//
// These tests exist because of a real production outage: a mid-hand all-in made
// `playersRemaining` (which counted seats with chips) disagree with the masked
// opponent list (which counts non-eliminated players), so `assertDecisionState`
// threw and the whole tournament aborted mid-hand with
// "playersRemaining mismatch: expected 3, got 2".
//
// The suite pins two things:
//   1. the two distinct "remaining" concepts stay separate and correct, and
//   2. a full multi-hand tournament keeps every decision context valid through
//      all-ins, eliminations, heads-up and forced safe fallbacks.
import assert from 'node:assert/strict';
import { createBrowserEngine } from '@pokertools/engine/browser';
import {
  ACTION, legalActionCandidates, serializeForAgent, assertDecisionState, fallbackAction,
  applyBenchmarkMode, playerStack, currentBet, playersStillInTournament, playersWithChips,
  BENCHMARK_MODES,
} from '../../src/lib/decision-core.js';

// ---------------------------------------------------------------------------
// Shared helpers. `handSettled` mirrors Arena.handComplete() exactly, and the
// elimination accounting mirrors Arena.completeHand().
// ---------------------------------------------------------------------------
function handSettled(engine) {
  const s = engine.state;
  if (Array.isArray(s.winners) && s.winners.length > 0 && s.actionTo == null) return true;
  const aliveInHand = (s.activePlayers ?? []).filter(seat => s.players?.[seat] && playerStack(s.players[seat]) >= 0);
  return s.actionTo == null && (s.street === 'SHOWDOWN' || aliveInHand.length <= 1) && Array.isArray(s.winners);
}
function settleShowdown(engine, player) {
  const show = { type: ACTION.SHOW, playerId: player.id, cardIndices: [0, 1] };
  if (engine.validate(show)?.valid) { engine.act(show); return true; }
  const muck = { type: ACTION.MUCK, playerId: player.id };
  if (engine.validate(muck)?.valid) { engine.act(muck); return true; }
  return false;
}
function stackSum(engine) {
  const s = engine.state;
  return (s.players ?? []).filter(Boolean).reduce((sum, p) => sum + playerStack(p), 0)
    + [...(s.currentBets?.values?.() ?? [])].reduce((a, b) => a + b, 0)
    + (s.pots ?? []).reduce((sum, p) => sum + (p.amount || 0), 0);
}
// Mirrors Arena.tournamentMeta(): the decision context must use the
// non-eliminated count, never the chip count.
function productionMeta(engine, { handNumber, startingPlayers, eliminatedPlayerIds }) {
  return {
    handNumber,
    playersRemaining: playersStillInTournament(engine.state.players, eliminatedPlayerIds).length,
    startingPlayers,
    levelIndex: engine.state.blindLevel ?? 0,
    eliminatedPlayerIds: [...eliminatedPlayerIds],
  };
}
function assertContext(engine, seat, meta) {
  const legalActions = legalActionCandidates(engine, seat);
  const state = assertDecisionState(applyBenchmarkMode(
    serializeForAgent(engine, seat, meta, legalActions, [], [], []),
    BENCHMARK_MODES.STRATEGY,
  ));
  assert.equal(state.tournament.playersRemaining, 1 + state.opponents.length,
    'decision context tournament count must equal hero + non-eliminated opponents');
  assert.ok(state.opponents.every(o => Array.isArray(o.cards) && o.cards.length === 0), 'opponent cards must stay hidden');
  return { state, legalActions };
}

// ---------------------------------------------------------------------------
// 1. The exact regression: a mid-hand all-in must not shrink the tournament
//    count, and the old chip-based count would still have thrown.
// ---------------------------------------------------------------------------
{
  const engine = createBrowserEngine({ smallBlind: 25, bigBlind: 50, ante: 5, maxPlayers: 3, validateIntegrity: true });
  [3000, 3000, 3000].forEach((stack, seat) => engine.sit(seat, `p${seat}`, `P${seat}`, stack));
  engine.deal();

  const shoverSeat = engine.state.actionTo;
  const shover = engine.state.players[shoverSeat];
  const shoveTo = currentBet(engine.state, shoverSeat) + playerStack(shover);
  engine.act({ type: 'RAISE', playerId: shover.id, amount: shoveTo });

  assert.equal(playerStack(engine.state.players[shoverSeat]), 0, 'an all-in player has 0 chips behind');
  assert.equal(engine.state.players[shoverSeat].status, 'ALL_IN');
  assert.equal(playersStillInTournament(engine.state.players, []).length, 3, 'an all-in player is still in the tournament');
  assert.equal(playersWithChips(engine.state.players).length, 2, 'chip count drops on the shove');

  const nextSeat = engine.state.actionTo;
  const eliminatedPlayerIds = [];
  assertContext(engine, nextSeat, productionMeta(engine, { handNumber: 1, startingPlayers: 3, eliminatedPlayerIds }));

  // Regression proof: feeding the chip-based count reproduces the outage.
  assert.throws(
    () => assertDecisionState(serializeForAgent(
      engine, nextSeat,
      { handNumber: 1, playersRemaining: playersWithChips(engine.state.players).length, startingPlayers: 3, eliminatedPlayerIds: [] },
      legalActionCandidates(engine, nextSeat), [], [], [],
    )),
    /playersRemaining mismatch/,
    'chip-based tournament count must be rejected by the invariant',
  );
  console.log('tournament-safety: mid-hand all-in keeps context valid PASS');
}

// ---------------------------------------------------------------------------
// 2. Folded players count; only eliminated players leave the count.
// ---------------------------------------------------------------------------
{
  const engine = createBrowserEngine({ smallBlind: 25, bigBlind: 50, ante: 0, maxPlayers: 4, validateIntegrity: true });
  [3000, 3000, 3000, 3000].forEach((stack, seat) => engine.sit(seat, `p${seat}`, `P${seat}`, stack));
  engine.deal();
  const folders = [];
  while (engine.state.actionTo != null && folders.length < 2) {
    const seat = engine.state.actionTo;
    const player = engine.state.players[seat];
    engine.act({ type: 'FOLD', playerId: player.id });
    folders.push(player.id);
  }
  assert.equal(engine.state.players.filter(p => p?.status === 'FOLDED').length, 2);
  assert.equal(playersStillInTournament(engine.state.players, []).length, 4, 'folded players are still in the tournament');
  console.log('tournament-safety: folded players stay counted PASS');
}

// ---------------------------------------------------------------------------
// 3. Full multi-hand simulation. Every decision context must be valid, and the
//    tournament must play through all-ins, eliminations and heads-up without a
//    context error. Several table sizes and policies are swept.
// ---------------------------------------------------------------------------
const POLICIES = {
  // Shove whenever possible: forces three-plus-way all-ins and eliminations.
  shove(state, legal) {
    const aggressive = legal.filter(a => a.type === ACTION.RAISE || a.type === ACTION.BET);
    if (aggressive.length) return aggressive.reduce((best, a) => (a.amount ?? 0) > (best.amount ?? 0) ? a : best);
    return legal.find(a => a.type === ACTION.CALL) ?? legal.find(a => a.type === ACTION.CHECK) ?? legal[0];
  },
  // Passive: fold facing a bet, otherwise check.
  passive(state, legal) {
    return legal.find(a => a.type === ACTION.CHECK) ?? legal.find(a => a.type === ACTION.FOLD) ?? legal[0];
  },
  // Alternating: even seats shove, odd seats call small bets and fold the rest.
  mixed(state, legal) {
    if (state.hero.seat % 2 === 0) return POLICIES.shove(state, legal);
    if ((state.betting?.toCall ?? 0) <= 100) return legal.find(a => a.type === ACTION.CHECK) ?? legal.find(a => a.type === ACTION.CALL) ?? legal[0];
    return legal.find(a => a.type === ACTION.CHECK) ?? legal.find(a => a.type === ACTION.FOLD) ?? legal[0];
  },
};

function simulateTournament({ seats, startingStack, smallBlind, bigBlind, ante, policy, hands = 40 }) {
  const engine = createBrowserEngine({ smallBlind, bigBlind, ante, maxPlayers: seats, blindStructure: [{ smallBlind, bigBlind, ante }], validateIntegrity: true });
  for (let seat = 0; seat < seats; seat++) engine.sit(seat, `p${seat}`, `P${seat}`, startingStack);
  const eliminatedPlayerIds = new Set();
  const totalChips = seats * startingStack;
  let decisions = 0, handsPlayed = 0, handed = 0;

  while (handsPlayed < hands) {
    for (const player of engine.state.players ?? []) {
      if (player && playerStack(player) <= 0 && !eliminatedPlayerIds.has(player.id)) engine.stand(player.id);
    }
    const contenders = playersWithChips(engine.state.players);
    if (contenders.length <= 1) return { winner: contenders[0] ?? null, decisions, handsPlayed, eliminated: eliminatedPlayerIds.size, totalChips, engine };
    engine.deal();
    handsPlayed++;
    let guard = 0;
    while (!handSettled(engine)) {
      if (++guard > 2000) throw new Error(`simulation guard exceeded for ${seats}-handed`);
      if (engine.state.street === 'SHOWDOWN') {
        settleShowdown(engine, engine.state.players[engine.state.actionTo]);
        continue;
      }
      const seat = engine.state.actionTo;
      const player = engine.state.players?.[seat];
      if (!player) break;
      const { state, legalActions } = assertContext(engine, seat, productionMeta(engine, { handNumber: engine.state.handNumber, startingPlayers: seats, eliminatedPlayerIds: [...eliminatedPlayerIds] }));
      decisions++;
      const chosen = policy ? policy(state, legalActions) : POLICIES.shove(state, legalActions);
      engine.act(chosen.engineAction);
    }
    assert.equal(stackSum(engine), totalChips, `${seats}-handed table must conserve chips`);
    handed++;
    for (const player of engine.state.players ?? []) {
      if (player && playerStack(player) <= 0 && !eliminatedPlayerIds.has(player.id)) eliminatedPlayerIds.add(player.id);
    }
  }
  const contenders = playersWithChips(engine.state.players);
  return { winner: contenders[0] ?? null, decisions, handsPlayed: handed, eliminated: eliminatedPlayerIds.size, totalChips, engine };
}

const tableSizes = [2, 3, 4, 5, 6];
for (const seats of tableSizes) {
  for (const [name, policy] of Object.entries(POLICIES)) {
    for (const startingStack of [600, 3000]) {
      const result = simulateTournament({ seats, startingStack, smallBlind: 25, bigBlind: 50, ante: 5, policy });
      assert.ok(result.decisions > 0, `${seats}-handed/${name} simulation should reach decisions`);
      assert.equal(stackSum(result.engine), result.totalChips);
      if (result.eliminated > 0) assert.ok(result.eliminated <= seats - 1, 'at most all but one player can be eliminated');
    }
  }
}
console.log(`tournament-safety: ${tableSizes.length * 6} simulations across 2-6 handed PASS`);

// ---------------------------------------------------------------------------
// 4. Recovery contract. If a decision context cannot be built, production takes
//    a deterministic safe action and finishes the hand instead of aborting the
//    tournament. This mirrors Arena.recoverHand()/forceSafeAction() and proves
//    the recovery is bounded, legal and chip-conserving.
// ---------------------------------------------------------------------------
{
  const seats = 4, startingStack = 2000, totalChips = seats * startingStack;
  const engine = createBrowserEngine({ smallBlind: 25, bigBlind: 50, ante: 5, maxPlayers: seats, validateIntegrity: true });
  for (let seat = 0; seat < seats; seat++) engine.sit(seat, `p${seat}`, `P${seat}`, startingStack);
  engine.deal();
  let recovered = 0, guard = 0;
  const elimination = new Set();
  while (!handSettled(engine)) {
    if (++guard > 500) throw new Error('recovery guard exceeded');
    const seat = engine.state.actionTo;
    const player = engine.state.players?.[seat];
    if (!player) break;
    if (engine.state.street === 'SHOWDOWN') { settleShowdown(engine, player); continue; }
    // Force the context builder to throw, then recover with a safe action.
    assert.throws(() => assertContext(engine, seat, { handNumber: 1, playersRemaining: 999, startingPlayers: seats, eliminatedPlayerIds: [...elimination] }), /playersRemaining mismatch/);
    const safe = fallbackAction(legalActionCandidates(engine, seat));
    assert.ok(safe?.engineAction, 'safe fallback must always be a legal engine action');
    engine.act(safe.engineAction);
    recovered++;
  }
  assert.ok(recovered > 0, 'recovery path must actually run');
  assert.equal(stackSum(engine), totalChips, 'safe fallbacks must conserve chips');
  console.log(`tournament-safety: forced-context recovery completed ${recovered} safe actions PASS`);
}

console.log('tournament-safety: PASS');
