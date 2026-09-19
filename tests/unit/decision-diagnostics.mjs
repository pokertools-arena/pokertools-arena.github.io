// Offline regression tests for the rigorous diagnostics.
// No network: these must pass in CI and prove the invariants the real-API
// diagnostics rely on.
import assert from 'node:assert/strict';
import { createBrowserEngine } from '@pokertools/engine/browser';
import {
  ACTION, legalActionCandidates, actionCriteria, resolveCriteriaKey, heroHandSummary,
  serializeForAgent, assertDecisionState, DECISION_CONTEXT_VERSION,
} from '../../src/lib/decision-core.js';
import {
  STRICT_SCENARIOS, STRATEGY_SCENARIOS, RIVER_PROBE, DOMINATED_SCENARIOS, HAND_SCENARIOS,
  FRAGMENTATION_SCENARIOS, FRAGMENTATION_HIERARCHICAL_SCENARIOS, riverProbeScenarios,
} from '../../tools/diagnostics/scenarios.js';
import {
  REPRESENTATIONS, CONTEXT_VARIANTS, applyContextVariant, descriptionVariants,
} from '../../tools/diagnostics/representations.js';

function headsUp(stacks = [10000, 10000]) {
  const engine = createBrowserEngine({ smallBlind: 50, bigBlind: 100, ante: 0, maxPlayers: 2, validateIntegrity: true });
  stacks.forEach((stack, seat) => engine.sit(seat, `p${seat}`, `P${seat}`, stack));
  engine.deal();
  return engine;
}
function types(actions) { return new Set(actions.map(a => a.type)); }

// 1. FOLD must never be exposed when CHECK is available.
{
  const engine = headsUp();
  engine.act({ type: 'CALL', playerId: 'p0' });
  engine.act({ type: 'CHECK', playerId: 'p1' });
  assert.equal(engine.state.street, 'FLOP');
  const actions = legalActionCandidates(engine, engine.state.actionTo);
  const offered = types(actions);
  assert.ok(offered.has(ACTION.CHECK), 'CHECK must be available on a free flop');
  assert.ok(!offered.has(ACTION.FOLD), 'FOLD must not be exposed when CHECK is available');
  assert.ok(offered.has(ACTION.BET), 'BET must remain available');
  assert.equal(actions.find(a => a.type === ACTION.CHECK).id, 'A0', 'CHECK should be the first offered action');
  console.log('diagnostics-test: FOLD-when-CHECK guard PASS');
}

// Facing a wager the passive options are FOLD and CALL (no CHECK).
{
  const engine = headsUp();
  const actions = legalActionCandidates(engine, engine.state.actionTo);
  const offered = types(actions);
  assert.ok(offered.has(ACTION.FOLD));
  assert.ok(offered.has(ACTION.CALL));
  assert.ok(!offered.has(ACTION.CHECK));
  console.log('diagnostics-test: facing-bet passive options PASS');
}

// 2. Opaque criteria ids map exactly to the descriptions sent to Jev.
{
  const engine = headsUp();
  const actions = legalActionCandidates(engine, engine.state.actionTo);
  const criteria = actionCriteria(actions, { keyMode: 'opaque' });
  assert.deepEqual(Object.keys(criteria), actions.map(a => a.id));
  for (const a of actions) assert.equal(criteria[a.id], a.description, `criteria for ${a.id} must equal its description`);
  console.log('diagnostics-test: opaque action-id mapping PASS');
}

// 3. Semantic criteria keys resolve back to the exact same engine action.
{
  const engine = headsUp();
  const actions = legalActionCandidates(engine, engine.state.actionTo);
  const semantic = actionCriteria(actions, { keyMode: 'semantic' });
  const keys = Object.keys(semantic);
  assert.equal(keys.length, actions.length, 'semantic keys must be one-to-one with legal actions');
  assert.equal(new Set(keys).size, keys.length, 'semantic keys must be unique');
  for (const key of keys) {
    const resolved = resolveCriteriaKey(actions, key);
    assert.ok(resolved, `semantic key ${key} must resolve`);
    assert.equal(resolved.description, semantic[key]);
    assert.ok(actions.some(a => a.id === resolved.id && a.type === resolved.type && a.amount === resolved.amount));
  }
  console.log('diagnostics-test: semantic key round-trip PASS');
}

// 4. Every representation carries the same semantic decision information.
{
  const actions = RIVER_PROBE.state.legalActions;
  const requiredDescriptions = actions.map(a => a.description);
  for (const rep of REPRESENTATIONS) {
    const built = rep.build(RIVER_PROBE.state, actions);
    const text = typeof built.chatText === 'string' ? built.chatText : JSON.stringify(built.chatText);
    const normalized = text.replace(/,/g, '');
    for (const card of ['As', '2d']) assert.ok(text.includes(card), `${rep.id} missing hero card ${card}`);
    for (const card of ['Tc', '3d', 'Js', '4s', '5c']) assert.ok(text.includes(card), `${rep.id} missing board card ${card}`);
    assert.ok(normalized.includes('14375'), `${rep.id} missing pot`);
    assert.ok(normalized.includes('5369'), `${rep.id} missing hero stack`);
    for (const id of actions.map(a => a.id)) assert.ok(text.includes(id), `${rep.id} missing action id ${id}`);
    assert.ok(built.keyMode === undefined || built.keyMode === rep.keyMode, `${rep.id} key mode mismatch`);
  }
  // Text representations must include a to-call value of 0.
  const rawTextOut = REPRESENTATIONS.find(r => r.id === 'raw-text').build(RIVER_PROBE.state, actions).chatText;
  assert.match(rawTextOut, /Amount to call:\s*0/);
  console.log('diagnostics-test: representation semantic equivalence PASS');
}

// 4b. Context ablation only removes context fields; the immediate decision is stable.
{
  const full = RIVER_PROBE.state;
  const actions = full.legalActions;
  for (const variant of CONTEXT_VARIANTS) {
    const state = applyContextVariant(full, variant);
    assert.deepEqual(state.hero, full.hero);
    assert.deepEqual(state.board, full.board);
    assert.deepEqual(state.legalActions, full.legalActions);
    assert.equal(state.betting.toCall, 0);
  }
  // Context variants are strictly nested in production context.
  const immediate = applyContextVariant(full, CONTEXT_VARIANTS[0]);
  assert.equal(immediate.actionHistory, undefined);
  assert.equal(immediate.recentHands, undefined);
  assert.equal(immediate.publicPlayerStats, undefined);
  const withHistory = applyContextVariant(full, CONTEXT_VARIANTS[1]);
  assert.ok(Array.isArray(withHistory.actionHistory));
  assert.equal(withHistory.recentHands, undefined);
  console.log('diagnostics-test: context ablation equivalence PASS');
}

// 5. Opponent hole cards stay hidden in production decision states.
{
  const engine = headsUp();
  const actions = legalActionCandidates(engine, engine.state.actionTo);
  const state = serializeForAgent(engine, engine.state.actionTo, { handNumber: 1, playersRemaining: 2, startingPlayers: 2 }, actions, [], [], []);
  assert.ok(state.opponents.length >= 1);
  assert.ok(state.opponents.every(o => Array.isArray(o.cards) && o.cards.length === 0));
  assert.equal(state.hero.cards.length, 2);
  assert.throws(() => assertDecisionState({ ...state, opponents: state.opponents.map(o => ({ ...o, cards: ['Ah', 'Ad'] })) }), /leaked opponent hole cards/);
  console.log('diagnostics-test: opponent-card confidentiality PASS');
}

// 6. Diagnostic perfect-information / synthetic scenarios cannot leak into tournament mode.
{
  for (const scenario of STRATEGY_SCENARIOS) {
    for (const opponent of scenario.state.opponents ?? []) {
      assert.ok(Array.isArray(opponent.cards) && opponent.cards.length === 0, `${scenario.id}: strategy scenarios must hide opponent cards`);
    }
  }
  for (const scenario of DOMINATED_SCENARIOS) {
    assert.ok(scenario.diagnosticOnly, `${scenario.id} must be marked diagnosticOnly`);
    for (const opponent of scenario.state.opponents ?? []) assert.equal(opponent.cards.length, 0, `${scenario.id}: raw opponent cards must stay empty`);
  }
  const perfect = DOMINATED_SCENARIOS.find(s => s.leaksOpponentCards);
  assert.ok(perfect?.state?.diagnosticPerfectInformation?.opponentCards?.length === 2, 'perfect-information diagnostic must be explicit');
  assert.ok(perfect?.note?.includes('perfect-information') || perfect?.category?.includes('Perfect'), 'perfect-information diagnostic must be labelled');
  const synthetic = DOMINATED_SCENARIOS.filter(s => s.synthetic);
  assert.ok(synthetic.length >= 1 && synthetic.every(s => s.state?.diagnosticSynthetic?.opponentPolicy), 'synthetic scenarios must declare the opponent policy');
  console.log('diagnostics-test: diagnostic isolation PASS');
}

// 7. Deterministic heroHand is identical for every adapter and never model-generated.
{
  for (const scenario of HAND_SCENARIOS) {
    const a = heroHandSummary(scenario.state.heroCards, scenario.state.board);
    const b = heroHandSummary(scenario.state.heroCards, scenario.state.board);
    assert.deepEqual(a, b);
    assert.equal(a.key, scenario.expectedKeys[0]);
    assert.equal(a.category, scenario.expectedLabel);
  }
  const probeHand = heroHandSummary(['As', '2d'], ['Tc', '3d', 'Js', '4s', '5c']);
  assert.equal(probeHand.category, 'Straight');
  console.log('diagnostics-test: deterministic heroHand PASS');
}

// 8. Memory parity: every seat receives the same public memory dataset.
{
  const engine = createBrowserEngine({ smallBlind: 25, bigBlind: 50, ante: 0, maxPlayers: 3, validateIntegrity: true });
  engine.sit(0, 'p0', 'P0', 3000); engine.sit(1, 'p1', 'P1', 3000); engine.sit(2, 'p2', 'P2', 3000);
  engine.deal();
  const recentHands = [{ handNumber: 7, board: ['Ah', 'Kd', 'Qc'], winners: [], stacksAfter: [], actions: [] }];
  const publicPlayerStats = [{ playerId: 'p0', vpipPct: 0.3 }, { playerId: 'p1', vpipPct: 0.2 }, { playerId: 'p2', vpipPct: 0.4 }];
  const actionHistory = [{ street: 'PREFLOP', playerName: 'P0', action: { type: 'CALL', amount: 50 } }];
  const states = [];
  for (let seat = 0; seat < 3; seat++) {
    const actions = legalActionCandidates(engine, seat);
    if (!actions.length) continue;
    states.push(serializeForAgent(engine, seat, { handNumber: 8, playersRemaining: 3, startingPlayers: 3 }, actions, recentHands, publicPlayerStats, actionHistory));
  }
  assert.ok(states.length >= 1);
  for (const state of states) {
    assert.deepEqual(state.recentHands, recentHands);
    assert.deepEqual(state.publicPlayerStats, publicPlayerStats);
    assert.deepEqual(state.actionHistory, actionHistory);
    assert.equal(state.tournament.playersRemaining, 3);
  }
  console.log('diagnostics-test: public memory parity PASS');
}

// 9. Description variants keep the exact same legal action references.
{
  const variants = descriptionVariants(RIVER_PROBE.state);
  assert.ok(variants.current && variants['pot-fraction'] && variants.commitment && variants.metadata);
  const baseIds = RIVER_PROBE.state.legalActions.map(a => `${a.id}:${a.type}:${a.amount}`).join('|');
  for (const [name, state] of Object.entries(variants)) {
    const ids = state.legalActions.map(a => `${a.id}:${a.type}:${a.amount}`).join('|');
    assert.equal(ids, baseIds, `${name} must not change action identity`);
    for (const a of state.legalActions) assert.ok(a.description && typeof a.description === 'string');
  }
  const metaBet = variants.metadata.legalActions.find(a => a.type === ACTION.BET);
  assert.equal(typeof metaBet.isAllIn, 'boolean');
  assert.equal(typeof metaBet.potFraction, 'number');
  console.log('diagnostics-test: description variants PASS');
}

// 10. Strict scenarios are shaped like production DecisionStates.
{
  const finite = STRICT_SCENARIOS.filter(s => s.kind === 'action' && !s.synthetic && !s.leaksOpponentCards);
  assert.ok(finite.length >= 2);
  for (const scenario of finite) {
    assert.equal(scenario.state.contextVersion, DECISION_CONTEXT_VERSION);
    assert.ok(Array.isArray(scenario.state.opponents));
    for (const opponent of scenario.state.opponents) assert.equal(opponent.cards.length, 0);
  }
  console.log('diagnostics-test: strict scenario shape PASS');
}

// 11. Fragmentation states keep a legal flat menu and a legal hierarchical menu.
{
  for (const scenario of FRAGMENTATION_SCENARIOS) {
    const actions = scenario.state.legalActions;
    assert.ok(actions.some(a => a.type === ACTION.CHECK), `${scenario.id}: must offer CHECK`);
    assert.ok(actions.some(a => a.type === ACTION.BET), `${scenario.id}: must offer BET`);
    assert.ok(!actions.some(a => a.type === ACTION.FOLD), `${scenario.id}: must not offer FOLD when CHECK is free`);
    for (const action of actions.filter(a => a.type === ACTION.BET)) assert.ok(Number(action.amount) > 0);
  }
  for (const scenario of FRAGMENTATION_HIERARCHICAL_SCENARIOS) {
    const actions = scenario.state.legalActions;
    assert.ok(actions.some(a => a.type === ACTION.CHECK));
    assert.ok(actions.some(a => a.type === ACTION.BET));
  }
  const probeScenarios = riverProbeScenarios();
  assert.equal(probeScenarios.length, 4);
  assert.equal(probeScenarios.filter(s => s.architecture === 'flat').length, 2);
  assert.equal(probeScenarios.filter(s => s.architecture === 'hierarchical').length, 2);
  const withHand = probeScenarios.find(s => s.id === 'probe-flat-herohand');
  assert.equal(withHand.state.heroHand.category, 'Straight');
  console.log('diagnostics-test: fragmentation/probe fixtures PASS');
}

console.log('decision-diagnostics: PASS');
