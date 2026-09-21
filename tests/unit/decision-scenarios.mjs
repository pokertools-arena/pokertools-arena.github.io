import assert from 'node:assert/strict';
import { DECISION_SANITY_SCENARIOS } from '../../src/benchmark/scenarios.js';
import { DECISION_CONTEXT_VERSION } from '../../src/lib/decision-core.js';

assert.equal(DECISION_SANITY_SCENARIOS.length, 10, 'suite must contain exactly 10 scenarios');
assert.equal(new Set(DECISION_SANITY_SCENARIOS.map(s => s.id)).size, 10, 'scenario ids must be unique');
for (const scenario of DECISION_SANITY_SCENARIOS) {
  assert.ok(scenario.title && scenario.note && scenario.category);
  assert.ok(Array.isArray(scenario.expectedTypes) && scenario.expectedTypes.length > 0);
  const state = scenario.state;
  assert.equal(state.contextVersion, DECISION_CONTEXT_VERSION);
  assert.equal(state.game, 'No-Limit Texas Holdem tournament');
  assert.equal(state.hero.cards.length, 2);
  assert.ok(Array.isArray(state.publicPlayerStats));
  assert.ok(Array.isArray(state.recentHands));
  assert.ok(Array.isArray(state.actionHistory));
  assert.ok(state.opponents.every(o => Array.isArray(o.cards) && o.cards.length === 0), `${scenario.id}: opponent cards must be hidden`);
  assert.ok(Array.isArray(state.legalActions) && state.legalActions.length >= 2);
  const legalTypes = new Set(state.legalActions.map(a => a.type));
  for (const type of scenario.expectedTypes) assert.ok(legalTypes.has(type), `${scenario.id}: expected ${type} must be legal`);
  assert.ok(!JSON.stringify(state).includes('publicReason'));
}
console.log('decision-scenarios: PASS');
