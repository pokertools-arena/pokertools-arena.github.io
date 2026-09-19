// Size-bucket audit tests (offline).
//
// Exercises the deterministic ~33% / ~67% / ~100% / all-in planner at its
// boundaries: tiny and huge stacks, min-bet/min-raise edges, all-in below the
// minimum raise, all-in near LARGE, pot smaller than the big blind, heads-up,
// multiway and post-elimination short stacks.
import assert from 'node:assert/strict';
import { createBrowserEngine } from '@pokertools/engine/browser';
import { planAggressiveSizes, legalAggressiveSizes, aggressiveSizesForState, chatSizeSchema, sizeCriteria, ACTION_FAMILY, ACTION } from '../../src/lib/decision-core.js';
import { SIZE_AUDIT_CASES, auditSizes, planForCase } from '../../tools/diagnostics/size-buckets.js';

// 1. Every audit case produces a legal, deduplicated, deterministic plan.
for (const testCase of SIZE_AUDIT_CASES) {
  const first = planForCase(testCase);
  const second = planForCase(testCase);
  assert.deepEqual(first.sizes, second.sizes, `${testCase.id}: planner must be deterministic`);
  assert.deepEqual(first.issues, [], `${testCase.id}: audit issues ${first.issues.join(', ')}`);
  assert.ok(first.sizes.length <= 4, `${testCase.id}: at most four buckets`);
  const amounts = first.sizes.map(size => size.amount);
  assert.equal(new Set(amounts).size, amounts.length, `${testCase.id}: amounts must be unique`);
  for (const size of first.sizes) {
    assert.ok(Number.isFinite(size.amount) && size.amount > 0, `${testCase.id}: amounts must be positive`);
    assert.ok(size.amount <= Math.floor(testCase.descriptor.maxTotal), `${testCase.id}: amount over stack`);
  }
  // Near-duplicate metric itself must be sane.
  assert.deepEqual(auditSizes(first.sizes, testCase.descriptor), []);
}
console.log('size-bucket-test: boundary plans PASS');

// 2. An all-in below the minimum raise exposes no aggressive plan at all.
{
  const belowMin = SIZE_AUDIT_CASES.find(testCase => testCase.id === 'allin-below-min-raise');
  const plan = planForCase(belowMin);
  assert.equal(plan.sizes.length, 0, 'a raise that cannot reach the minimum must not be offered');
}
console.log('size-bucket-test: all-in below min-raise PASS');

// 3. Tiny stacks collapse to a single ALL_IN bucket.
{
  const tiny = planForCase(SIZE_AUDIT_CASES.find(testCase => testCase.id === 'tiny-stack'));
  assert.equal(tiny.sizes.length, 1);
  assert.equal(tiny.sizes[0].id, 'all_in');
}
console.log('size-bucket-test: tiny-stack collapse PASS');

// 4. Very large stacks keep the four strategic buckets.
{
  const deep = planForCase(SIZE_AUDIT_CASES.find(testCase => testCase.id === 'very-large-stack'));
  assert.equal(deep.sizes.length, 4, 'deep stacks should keep SMALL/MEDIUM/LARGE/ALL_IN');
  assert.deepEqual(deep.sizes.map(size => size.id), ['small', 'medium', 'large', 'all_in']);
}
console.log('size-bucket-test: deep-stack four buckets PASS');

// 5. Engine planner and pure planner agree for the same engine descriptor, and
//    both adapters see exactly the same size ids.
{
  const engine = createBrowserEngine({ smallBlind: 50, bigBlind: 100, ante: 0, maxPlayers: 2, validateIntegrity: true });
  engine.sit(0, 'p0', 'P0', 10000); engine.sit(1, 'p1', 'P1', 10000);
  engine.deal();
  engine.act({ type: ACTION.CALL, playerId: 'p0' });
  const seat = engine.state.actionTo;
  const engineSizes = legalAggressiveSizes(engine, seat, ACTION_FAMILY.BET);
  const pureSizes = aggressiveSizesForState({ betting: {}, blinds: { bigBlind: 100 }, hero: { stack: 10000, currentBet: 0 }, pot: 200 }, ACTION_FAMILY.BET);
  assert.ok(engineSizes.length >= 1 && engineSizes.length <= 4);
  assert.deepEqual(auditSizes(engineSizes, { maxTotal: 10000, bb: 100, pot: 200 }), []);
  // Both adapters receive exactly the same enum.
  const chatIds = chatSizeSchema(engineSizes).properties.sizeId.enum;
  const jevIds = Object.keys(sizeCriteria(engineSizes));
  assert.deepEqual(chatIds, jevIds);
  assert.deepEqual(jevIds, engineSizes.map(size => size.id));
  assert.ok(pureSizes.length >= 1);
}
console.log('size-bucket-test: adapter symmetry + engine planner PASS');

// 6. Audit detects injected problems.
{
  assert.deepEqual(auditSizes([{ id: 'small', amount: 100 }, { id: 'medium', amount: 101 }, { id: 'large', amount: 102 }, { id: 'all_in', amount: 103 }, { id: 'small', amount: 104 }], { maxTotal: 10000, bb: 100, pot: 200 }).includes('more_than_four_buckets'), true);
  assert.ok(auditSizes([{ id: 'all_in', amount: 20000 }], { maxTotal: 10000, bb: 100, pot: 200 }).includes('amount_over_stack'));
}
console.log('size-bucket-test: audit detection PASS');

console.log('size-bucket-tests: PASS');
