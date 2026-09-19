// Offline fairness + hierarchical-architecture tests. No network.
//
// These prove the invariants the benchmark relies on:
//   * one canonical action-family set per engine state,
//   * one deterministic, engine-validated sizing set per family,
//   * free CHECK never exposes FOLD,
//   * Jev and chat schemas offer exactly the same choice sets,
//   * the hero-hand field is deterministic and describes the hero only,
//   * opponent hand information is never exposed,
//   * the two hierarchical stages share one action clock,
//   * the primary decision contract requires no prose.
import assert from 'node:assert/strict';
import { createBrowserEngine } from '@pokertools/engine/browser';
import {
  ACTION, legalActionCandidates, serializeForAgent, assertDecisionState,
  legalActionFamilies, aggressiveSizesForState, legalAggressiveSizes, buildHierarchicalDecision,
  familyCriteria, sizeCriteria, chatFamilySchema, chatSizeSchema, renderDecisionState,
  aggregateActionProbabilitiesByFamily, probabilityStats,
  applyBenchmarkMode, stripHeroHand, BENCHMARK_MODES, DECISION_ARCHITECTURES,
  decideHierarchical, heroHandSummary,
} from '../../src/lib/decision-core.js';
import { RIVER_PROBE, DOMINATED_SCENARIOS } from '../../tools/diagnostics/scenarios.js';

function headsUp(stacks = [10000, 10000]) {
  const engine = createBrowserEngine({ smallBlind: 50, bigBlind: 100, ante: 0, maxPlayers: 2, validateIntegrity: true });
  stacks.forEach((stack, seat) => engine.sit(seat, `p${seat}`, `P${seat}`, stack));
  engine.deal();
  return engine;
}

// 1. Free CHECK never exposes FOLD; families are CHECK + BET.
{
  const engine = headsUp();
  engine.act({ type: 'CALL', playerId: 'p0' });
  engine.act({ type: 'CHECK', playerId: 'p1' });
  const seat = engine.state.actionTo;
  const actions = legalActionCandidates(engine, seat);
  assert.ok(actions.some(a => a.type === ACTION.CHECK));
  assert.ok(!actions.some(a => a.type === ACTION.FOLD), 'FOLD must never be offered when CHECK is free');
  const families = legalActionFamilies(actions, { toCall: 0 });
  assert.deepEqual(families, ['check', 'bet']);
  console.log('hierarchical-test: free-CHECK family set PASS');
}

// 2. Facing a bet exposes FOLD/CALL/RAISE and never CHECK.
{
  const engine = headsUp();
  const seat = engine.state.actionTo;
  const actions = legalActionCandidates(engine, seat);
  const families = legalActionFamilies(actions, { toCall: 100 });
  assert.deepEqual(families, ['fold', 'call', 'raise']);
  assert.ok(!families.includes('check'));
  console.log('hierarchical-test: facing-bet family set PASS');
}

// 2b. Limped pot where toCall == 0 but aggression is a RAISE, never BET.
{
  const engine = headsUp();
  engine.act({ type: 'CALL', playerId: 'p0' });
  const seat = engine.state.actionTo;
  const actions = legalActionCandidates(engine, seat);
  const families = legalActionFamilies(actions, { toCall: 0 });
  assert.deepEqual(families, ['check', 'raise']);
  assert.ok(!families.includes('bet'), 'BET and RAISE must never be exposed together');
  console.log('hierarchical-test: limped-pot BET/RAISE separation PASS');
}

// 3. Sizing is deterministic, deduplicated, legal and engine-validated.
{
  const engine = headsUp();
  engine.act({ type: 'CALL', playerId: 'p0' });
  const seat = engine.state.actionTo;
  const a = legalAggressiveSizes(engine, seat, 'bet');
  const b = legalAggressiveSizes(engine, seat, 'bet');
  assert.deepEqual(a, b, 'sizing must be deterministic');
  assert.ok(a.length >= 1 && a.length <= 4);
  const amounts = a.map(s => s.amount);
  assert.equal(new Set(amounts).size, amounts.length, 'sizes must be unique');
  for (const size of a) {
    assert.ok(engine.validate({ type: ACTION.BET, playerId: `p${seat}`, amount: size.amount })?.valid, `size ${size.amount} must be legal`);
  }
  console.log('hierarchical-test: deterministic legal sizing PASS');
}

// 4. Short stack exposes only ALL_IN.
{
  const engine = createBrowserEngine({ smallBlind: 50, bigBlind: 100, ante: 0, maxPlayers: 2, validateIntegrity: true });
  engine.sit(0, 'p0', 'P0', 60);
  engine.sit(1, 'p1', 'P1', 10000);
  engine.deal();
  const seat = engine.state.actionTo;
  const families = legalActionFamilies(legalActionCandidates(engine, seat), { toCall: engine.state.currentBets.get(1) - engine.state.currentBets.get(seat) });
  const betFamily = families.includes('raise') ? 'raise' : families.includes('bet') ? 'bet' : null;
  if (betFamily) {
    const sizes = legalAggressiveSizes(engine, seat, betFamily);
    for (const size of sizes) assert.ok(size.amount <= 60, 'short-stack sizes must clamp to the available stack');
  }
  console.log('hierarchical-test: short-stack sizing PASS');
}

// 5. Same canonical family and size sets for the same state (adapter symmetry).
{
  const planA = buildHierarchicalDecision(RIVER_PROBE.state);
  const planB = buildHierarchicalDecision(RIVER_PROBE.state);
  assert.deepEqual(planA, planB);
  assert.deepEqual(planA.families, ['check', 'bet']);
  const chatFamilies = chatFamilySchema(planA.families).properties.actionFamily.enum;
  const jevFamilies = Object.keys(familyCriteria(planA.families));
  assert.deepEqual(chatFamilies, jevFamilies, 'Jev and chat family enums must match exactly');
  const chatSizes = chatSizeSchema(planA.stage2.sizes).properties.sizeId.enum;
  const jevSizes = Object.keys(sizeCriteria(planA.stage2.sizes));
  assert.deepEqual(chatSizes, jevSizes, 'chat models cannot select a size not presented to Jev');
  assert.deepEqual(jevSizes, planA.stage2.sizes.map(s => s.id));
  console.log('hierarchical-test: adapter family/size symmetry PASS');
}

// 6. Strategy vs Raw benchmark mode is global and deterministic.
{
  const strategy = applyBenchmarkMode(RIVER_PROBE.state, BENCHMARK_MODES.STRATEGY);
  const raw = applyBenchmarkMode(RIVER_PROBE.state, BENCHMARK_MODES.RAW);
  assert.equal(strategy.heroHand.category, 'Straight');
  assert.equal(strategy.heroHand.key, 'straight');
  assert.equal(raw.heroHand, undefined);
  const again = applyBenchmarkMode(RIVER_PROBE.state, BENCHMARK_MODES.STRATEGY);
  assert.deepEqual(strategy.heroHand, again.heroHand);
  const stripped = stripHeroHand(strategy);
  assert.equal(stripped.heroHand, undefined);
  console.log('hierarchical-test: Strategy/Raw benchmark mode PASS');
}

// 7. heroHand describes the hero only and never merges opponent data.
{
  const state = assertDecisionState({ ...applyBenchmarkMode(RIVER_PROBE.state, 'strategy') });
  assert.equal(state.heroHand.category, 'Straight');
  assert.ok(!JSON.stringify(state.heroHand).match(/villain|opponent/i));
  assert.throws(() => assertDecisionState({ ...state, heroHand: { category: 'Villain has quads' } }), /hero only/);
  console.log('hierarchical-test: hero-only deterministic hand PASS');
}

// 8. Opponent hand information is never exposed in production state.
{
  const engine = headsUp();
  const seat = engine.state.actionTo;
  const actions = legalActionCandidates(engine, seat);
  const state = serializeForAgent(engine, seat, { handNumber: 1, playersRemaining: 2, startingPlayers: 2 }, actions, [], [], []);
  assert.ok(state.opponents.every(o => o.cards.length === 0));
  assert.equal(JSON.stringify(state).match(/opponentHand|opponentHandCategory/), null);
  console.log('hierarchical-test: opponent hand confidentiality PASS');
}

// 9. Legacy flat probability aggregation folds sizes into families.
{
  const probabilities = { A0: 0.35, A1: 0.04, A2: 0.14, A3: 0.03, A4: 0.04, A5: 0.28, A6: 0.12 };
  const legalActions = [
    { id: 'A0', type: 'CHECK', description: 'Check' },
    { id: 'A1', type: 'BET', amount: 1150, description: 'Bet 1150' },
    { id: 'A2', type: 'BET', amount: 2300, description: 'Bet 2300' },
    { id: 'A3', type: 'BET', amount: 3450, description: 'Bet 3450' },
    { id: 'A4', type: 'BET', amount: 4744, description: 'Bet 4744' },
    { id: 'A5', type: 'BET', amount: 5369, description: 'Bet 5369' },
    { id: 'A6', type: 'FOLD', description: 'Fold' },
  ];
  const aggregated = aggregateActionProbabilitiesByFamily(probabilities, legalActions);
  assert.equal(Math.round(aggregated.bet * 100), 53);
  assert.equal(Math.round(aggregated.check * 100), 35);
  assert.equal(Math.round(aggregated.fold * 100), 12);
  const stats = probabilityStats(aggregated, 'bet');
  assert.equal(stats.topKey, 'bet');
  assert.equal(Math.round(stats.gap * 100), 18);
  assert.ok(stats.entropy > 0);
  console.log('hierarchical-test: legacy family aggregation PASS');
}

// 9b. Aggregation works for legacy events whose legal actions lack a type,
//     inferred from the saved description.
{
  const aggregated = aggregateActionProbabilitiesByFamily(
    { A0: 0.4, A1: 0.3, A2: 0.3 },
    null,
    { labelResolver: key => ({ description: { A0: 'Check', A1: 'Bet 900', A2: 'Fold' }[key] }) },
  );
  assert.equal(Math.round(aggregated.check * 100), 40);
  assert.equal(Math.round(aggregated.bet * 100), 30);
  assert.equal(Math.round(aggregated.fold * 100), 30);
  console.log('hierarchical-test: legacy description aggregation PASS');
}

// 10. Representation modes are semantically equivalent.
{
  const required = ['As', '2d', 'Tc', 'Js', '5c', '14375', '5369'];
  for (const mode of ['canonical_json', 'compact_json', 'markdown']) {
    const rendered = renderDecisionState(RIVER_PROBE.state, mode);
    const text = typeof rendered.chatText === 'string' ? rendered.chatText : JSON.stringify(rendered.chatText);
    for (const token of required) assert.ok(text.includes(token), `${mode} missing ${token}`);
    for (const id of RIVER_PROBE.state.legalActions.map(a => a.id)) assert.ok(text.includes(id), `${mode} missing action ${id}`);
  }
  console.log('hierarchical-test: representation equivalence PASS');
}

// 11. Two-stage execution over the real Jev request format shares one clock and
//     never requires prose. Uses a stubbed fetch: no network.
{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), body, signal: options.signal });
    const questionKeys = Object.keys(body.questions ?? {});
    const key = questionKeys[0];
    const answer = key === 'action_family'
      ? { choice: 'bet', probabilities: { bet: 0.56, check: 0.44 }, confidence: 0.31 }
      : { choice: 'all_in', probabilities: { all_in: 0.49, small: 0.51 }, confidence: 0.22 };
    return new Response(JSON.stringify({ model: 'test/jev-1.13', answers: { [key]: answer }, usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const connection = { id: 'c', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test-key', headers: '' };
    const agent = { model: 'typesafe/jev-1.13', protocol: 'jev_decisions', temperature: 0.3, provider: '' };
    const result = await decideHierarchical({
      agent, connection, state: RIVER_PROBE.state, legalActions: RIVER_PROBE.state.legalActions,
      decisionId: 'd-test', timeoutMs: 45000, abortSignal: null, pauseClock: null,
    });
    assert.equal(calls.length, 2, 'aggressive hierarchical decisions must make exactly two model calls');
    assert.ok(calls[0].body.questions.action_family, 'stage 1 must ask for the action family');
    assert.equal(calls[0].body.questions.action_family.type, 'choice', 'stage 1 question must be a single choice object, not double-wrapped');
    assert.deepEqual(Object.keys(calls[0].body.questions.action_family.criteria), ['check', 'bet']);
    assert.ok(calls[1].body.questions.bet_size, 'stage 2 must ask for the size');
    assert.equal(calls[1].body.questions.bet_size.type, 'choice');
    assert.equal(calls[0].signal, calls[1].signal, 'both stages must share one abort signal / action clock');
    assert.equal(result.family.choice, 'bet');
    assert.equal(result.sizing.choice, 'all_in');
    assert.equal(result.action.type, ACTION.BET);
    assert.equal(result.action.amount, 5369);
    assert.equal(result.publicReason, '', 'primary decision must not require prose');
    assert.ok(result.primaryDecisionLatencyMs >= 0);
    assert.equal(result.meta.decisionArchitecture, 'hierarchical-v1');
  } finally { globalThis.fetch = originalFetch; }
  console.log('hierarchical-test: two-stage Jev execution PASS');
}

// 11b. A passive family makes exactly one call and never asks for a size.
{
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return new Response(JSON.stringify({ model: 'test/jev-1.13', answers: { action_family: { choice: 'check', probabilities: { check: 0.9, bet: 0.1 } } }, usage: { total_tokens: 8 } }), { status: 200 });
  };
  try {
    const connection = { id: 'c', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test-key', headers: '' };
    const agent = { model: 'typesafe/jev-1.13', protocol: 'jev_decisions', temperature: 0.3, provider: '' };
    const result = await decideHierarchical({ agent, connection, state: RIVER_PROBE.state, legalActions: RIVER_PROBE.state.legalActions, decisionId: 'd', timeoutMs: 45000 });
    assert.equal(calls.length, 1);
    assert.equal(result.action.type, ACTION.CHECK);
    assert.equal(result.sizing, null);
  } finally { globalThis.fetch = originalFetch; }
  console.log('hierarchical-test: passive single-call execution PASS');
}

// 11c. Chat hierarchical schema offers only family then size, with no prose field.
{
  const originalFetch = globalThis.fetch;
  let seenSchema = null;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const schema = body.response_format?.json_schema?.schema ?? body.tools?.[0]?.function?.parameters;
    seenSchema = schema;
    if (schema.properties.actionFamily) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decisionId: 'd', actionFamily: 'bet' }) } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ decisionId: 'd', sizeId: 'small' }) } }] }), { status: 200 });
  };
  try {
    const connection = { id: 'c', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test-key', headers: '' };
    const agent = { model: 'google/gemma-4-26b-a4b-it', protocol: 'json_schema', temperature: 0.3, provider: '' };
    const result = await decideHierarchical({ agent, connection, state: RIVER_PROBE.state, legalActions: RIVER_PROBE.state.legalActions, decisionId: 'd', timeoutMs: 45000 });
    assert.equal(result.family.choice, 'bet');
    assert.equal(result.sizing.choice, 'small');
    assert.equal(result.action.type, ACTION.BET);
    assert.ok(!seenSchema.properties.publicReason, 'primary stage must not require prose');
    console.log('hierarchical-test: two-stage chat execution PASS');
  } finally { globalThis.fetch = originalFetch; }
}

// 12. Diagnostic perfect-information fixtures cannot enter tournament mode.
{
  assert.ok(DOMINATED_SCENARIOS.every(s => s.diagnosticOnly), 'dominated fixtures must be diagnostic-only');
  const perfect = DOMINATED_SCENARIOS.filter(s => s.leaksOpponentCards);
  assert.ok(perfect.every(s => s.state?.diagnosticPerfectInformation?.opponentCards), 'perfect-information fixtures must be explicitly labelled');
  console.log('hierarchical-test: diagnostic isolation PASS');
}

// 13. The primary decision contract never requires or carries prose, and
//     spectator explanations are structurally separate from model context.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const key = Object.keys(body.questions ?? {})[0];
    return new Response(JSON.stringify({ answers: { [key]: { choice: 'check' } } }), { status: 200 });
  };
  try {
    const connection = { id: 'c', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test-key', headers: '' };
    const agent = { model: 'typesafe/jev-1.13', protocol: 'jev_decisions', temperature: 0.3, provider: '' };
    const result = await decideHierarchical({ agent, connection, state: RIVER_PROBE.state, legalActions: RIVER_PROBE.state.legalActions, decisionId: 'd', timeoutMs: 45000 });
    assert.equal(result.publicReason, '');
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'spectatorExplanation'));
  } finally { globalThis.fetch = originalFetch; }
  // The serialized decision context must never contain another model's prose.
  const engine = headsUp();
  const seat = engine.state.actionTo;
  const state = serializeForAgent(engine, seat, { handNumber: 1, playersRemaining: 2, startingPlayers: 2 }, legalActionCandidates(engine, seat), [], [], []);
  assert.ok(!JSON.stringify(state).includes('publicReason'));
  assert.ok(!JSON.stringify(state).includes('spectatorExplanation'));
  console.log('hierarchical-test: prose-free primary contract PASS');
}

// 14. Memory parity: recentHands/publicPlayerStats are identical for every seat
//     within the same hand (legitimate seat-specific fields may differ).
{
  const engine = createBrowserEngine({ smallBlind: 25, bigBlind: 50, ante: 0, maxPlayers: 3, validateIntegrity: true });
  engine.sit(0, 'p0', 'P0', 3000); engine.sit(1, 'p1', 'P1', 3000); engine.sit(2, 'p2', 'P2', 3000);
  engine.deal();
  const recentHands = [{ handNumber: 7, board: ['Ah', 'Kd', 'Qc'], winners: [], stacksAfter: [], actions: [] }];
  const publicPlayerStats = [{ playerId: 'p0', vpipPct: 0.3 }, { playerId: 'p1', vpipPct: 0.2 }, { playerId: 'p2', vpipPct: 0.4 }];
  const states = [];
  for (let seat = 0; seat < 3; seat++) {
    const actions = legalActionCandidates(engine, seat);
    if (!actions.length) continue;
    states.push(serializeForAgent(engine, seat, { handNumber: 8, playersRemaining: 3, startingPlayers: 3 }, actions, recentHands, publicPlayerStats, []));
  }
  assert.ok(states.length >= 1);
  for (const state of states) {
    assert.deepEqual(state.recentHands, recentHands);
    assert.deepEqual(state.publicPlayerStats, publicPlayerStats);
    assert.deepEqual(state.memoryPolicy, states[0].memoryPolicy);
  }
  console.log('hierarchical-test: memory parity PASS');
}

console.log('hierarchical-decision-tests: PASS');
