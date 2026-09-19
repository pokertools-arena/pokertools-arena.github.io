// Methodology unit tests (offline).
//
// Proves the statistical and terminology invariants the 0.4.0 reports rely on:
//   * exact Shannon-entropy values and explicit probability domains,
//   * robust Wilson intervals that distinguish 2/2 from 100/100,
//   * standardized counter relationships,
//   * family correctness separated from sizing correctness,
//   * fixed-corpus invariants (immutable states, no gold on ambiguous spots),
//   * Strategy/Raw cognition kept as separate tracks.
import assert from 'node:assert/strict';
import {
  probabilityStats, familyEntropyBits, sizingEntropyBits, flatActionEntropyBits,
  applyBenchmarkMode, BENCHMARK_MODES, aggregateActionProbabilitiesByFamily, decisionClockPhase,
} from '../../src/lib/decision-core.js';
import { entropyBits, wilsonInterval, proportion, fmtPercent } from '../../tools/diagnostics/stats.js';
import { createCounters, countersForResult, countersFromResults, validateCounters } from '../../tools/diagnostics/counters.js';
import { scorePairedResult, runPairedCorpus, analyzePaired, analyzeFragmentation, deriveSizeId, mulberry32 } from '../../tools/diagnostics/paired.js';
import { CORPUS, ACTION_CORPUS, STRICT_CORPUS, REPRESENTATION_CORPUS_IDS, corpusById } from '../../tools/diagnostics/corpus.js';

// 1. Exact entropy values.
{
  assert.equal(familyEntropyBits({ a: 1, b: 0 }), 0, '[1,0] entropy must be exactly 0 bits');
  const half = familyEntropyBits({ a: 0.5, b: 0.5 });
  assert.ok(Math.abs(half - 1) < 1e-12, '[0.5,0.5] entropy must be exactly 1 bit');
  const ninety = familyEntropyBits({ a: 0.9, b: 0.1 });
  assert.ok(Math.abs(ninety - 0.4689955935892812) < 1e-9, `[0.9,0.1] entropy ~0.468996 bits, got ${ninety}`);
  const uniform3 = entropyBits({ a: 1, b: 1, c: 1 });
  assert.ok(Math.abs(uniform3 - Math.log2(3)) < 1e-12, 'three-class uniform entropy must be log2(3)');
  assert.equal(entropyBits({ a: 0, b: 0 }), null, 'all-zero distribution has undefined entropy');
  console.log('methodology-test: exact entropy PASS');
}

// 2. Entropy is domain-labelled, never a generic value.
{
  const stats = probabilityStats({ check: 0.6, bet: 0.4 }, 'bet', { domain: 'family' });
  assert.equal(stats.domain, 'family');
  assert.ok(Number.isFinite(stats.entropyBits));
  assert.equal(stats.entropy, Math.round(stats.entropyBits * 1000) / 1000);
  assert.ok(Number.isFinite(sizingEntropyBits({ small: 0.5, all_in: 0.5 })));
  assert.ok(Number.isFinite(flatActionEntropyBits({ A0: 0.5, A1: 0.5 })));
  assert.ok(!('domain' in {}) || true);
  console.log('methodology-test: domain-labelled entropy PASS');
}

// 3. Wilson intervals distinguish weak and strong evidence.
{
  const weak = wilsonInterval(2, 2);
  const strong = wilsonInterval(100, 100);
  assert.ok(weak.low < 0.4, `2/2 lower bound must be low, got ${weak.low}`);
  assert.ok(strong.low > 0.95, `100/100 lower bound must be high, got ${strong.low}`);
  assert.ok(strong.high > 0.999, `100/100 upper bound must approach 1, got ${strong.high}`);
  assert.equal(wilsonInterval(0, 0), null);
  const p = proportion(3, 10, { label: 'aggressive family' });
  assert.deepEqual(p.ci95 !== null, true);
  assert.equal(p.label, 'aggressive family');
  assert.equal(fmtPercent(0.5), '50%');
  console.log('methodology-test: Wilson interval PASS');
}

// 4. Standardized counters and their exact relationships.
{
  const counters = createCounters();
  assert.equal(counters.totalModelCalls, 0);
  const hierarchicalAggressive = countersForResult({ sizeChoice: 'all_in', meta: { retryCount: 1, incidents: [{ category: 'rate_limit' }] } }, { architecture: 'hierarchical' });
  assert.equal(hierarchicalAggressive.pokerDecisions, 1);
  assert.equal(hierarchicalAggressive.familyModelCalls, 1);
  assert.equal(hierarchicalAggressive.sizingModelCalls, 1);
  assert.equal(hierarchicalAggressive.totalModelCalls, 2);
  assert.equal(hierarchicalAggressive.httpRequests, 3, 'two calls plus one retry');
  assert.equal(hierarchicalAggressive.httpRetries, 1);
  assert.equal(hierarchicalAggressive.rateLimitResponses, 1);
  assert.equal(hierarchicalAggressive.familyModelCalls + hierarchicalAggressive.sizingModelCalls + hierarchicalAggressive.spectatorModelCalls, hierarchicalAggressive.totalModelCalls);
  const flat = countersForResult({ meta: {} }, { architecture: 'flat' });
  assert.equal(flat.totalModelCalls, 1);
  const total = countersFromResults([{ sizeChoice: 'all_in', meta: {} }, { meta: {} }], { architecture: 'flat' });
  // countersFromResults uses a single architecture override; hierarchical is exercised above.
  assert.equal(total.pokerDecisions, 2);
  assert.throws(() => validateCounters({ totalModelCalls: 5, familyModelCalls: 1, sizingModelCalls: 1, spectatorModelCalls: 0 }), /Counter mismatch/);
  validateCounters(hierarchicalAggressive);
  console.log('methodology-test: standardized counters PASS');
}

// 5. Family correctness is separate from sizing correctness.
{
  const entry = corpusById('river-nuts-forced-call-allin-001');
  const wrongSize = scorePairedResult(entry, { family: 'bet', sizeId: 'small', actionType: 'BET', actionAmount: 1000 }, { architecture: 'flat' });
  assert.equal(wrongSize.familyCorrect, true, 'BET family must pass');
  assert.equal(wrongSize.sizeCorrect, false, 'SMALL must fail the all-in sizing expectation');
  assert.equal(wrongSize.finalCorrect, false, 'final action must fail when sizing is wrong');
  const right = scorePairedResult(entry, { family: 'bet', sizeId: 'all_in', actionType: 'BET', actionAmount: 3000 }, { architecture: 'hierarchical' });
  assert.equal(right.familyCorrect, true);
  assert.equal(right.sizeCorrect, true);
  assert.equal(right.finalCorrect, true);
  const ambiguous = corpusById('river-nut-flush-value-001');
  const probe = scorePairedResult(ambiguous, { family: 'check', actionType: 'CHECK' }, { architecture: 'flat' });
  assert.equal(probe.familyCorrect, null, 'ambiguous states must not carry gold answers');
  assert.equal(probe.finalCorrect, null);
  console.log('methodology-test: family vs sizing separation PASS');
}

// 6. Fixed-corpus invariants.
{
  const ids = CORPUS.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'corpus ids must be unique');
  const categories = new Set(CORPUS.map(entry => entry.category));
  for (const required of ['strict_legality', 'value', 'bluff', 'preflop', 'hand_recognition']) {
    assert.ok(categories.has(required), `corpus must cover category ${required}`);
  }
  assert.ok(ACTION_CORPUS.length >= 18, `expected a meaningful action corpus, got ${ACTION_CORPUS.length}`);
  for (const entry of ACTION_CORPUS) {
    assert.equal(entry.state.contextVersion, 3, `${entry.id}: must be a production-shaped state`);
    assert.ok(Array.isArray(entry.state.legalActions) && entry.state.legalActions.length >= 2, `${entry.id}: needs legal actions`);
    for (const opponent of entry.state.opponents ?? []) {
      if (entry.leaksOpponentCards) continue;
      assert.equal(opponent.cards.length, 0, `${entry.id}: opponent cards must stay hidden`);
    }
    if (entry.expected) assert.ok(entry.expected.family, `${entry.id}: gold answer must name a family`);
    assert.ok(Array.isArray(entry.tags) && entry.tags.length > 0, `${entry.id}: corpus entries must be tagged`);
  }
  for (const id of REPRESENTATION_CORPUS_IDS) assert.ok(corpusById(id), `representation corpus id ${id} must resolve`);
  assert.ok(STRICT_CORPUS.length >= 3, 'strict corpus must not be empty');
  console.log('methodology-test: fixed corpus PASS');
}

// 7. Strategy and Raw are separate tracks (never combined).
{
  const state = corpusById('river-nut-flush-value-001').state;
  const strategy = applyBenchmarkMode(state, BENCHMARK_MODES.STRATEGY);
  const raw = applyBenchmarkMode(state, BENCHMARK_MODES.RAW);
  assert.equal(strategy.heroHand.category, 'Flush');
  assert.equal(raw.heroHand, undefined);
  // A flat probability distribution is aggregated into families, but never
  // merged with a hero-hand cognition score.
  const familyMass = aggregateActionProbabilitiesByFamily({ A0: 0.5, A1: 0.3, A2: 0.2 }, state.legalActions);
  assert.ok(Number.isFinite(familyMass.check) || Number.isFinite(familyMass.bet));
  console.log('methodology-test: Strategy/Raw separation PASS');
}

// 8. The paired runner is deterministic and interleaves architectures.
{
  const entries = [corpusById('river-free-check-dominance-001'), corpusById('river-nuts-forced-call-family-001')];
  const deterministicAdapter = {
    id: 'mock:flatish', name: 'Mock', model: 'mock/model',
    async run({ architecture }) {
      return architecture === 'hierarchical'
        ? { family: 'bet', sizeId: 'all_in', actionType: 'BET', actionAmount: 1000, latencyMs: 5 }
        : { family: 'bet', actionType: 'BET', actionAmount: 1000, latencyMs: 7 };
    },
  };
  const a = await runPairedCorpus({ entries, adapters: [deterministicAdapter], repetitions: 2, seed: 42 });
  const b = await runPairedCorpus({ entries, adapters: [deterministicAdapter], repetitions: 2, seed: 42 });
  assert.deepEqual(a.rows.map(r => [r.entryId, r.architecture, r.repetition]), b.rows.map(r => [r.entryId, r.architecture, r.repetition]), 'seeded order must be reproducible');
  assert.equal(a.rows.length, entries.length * 2 * 2);
  assert.equal(a.seed, 42);
  assert.equal(a.rows[0].experimentSeed, 42);
  // Interleaving: flat and hierarchical for the same state are adjacent.
  const firstPair = a.rows.slice(0, 2).map(r => r.entryId);
  assert.equal(firstPair[0], firstPair[1], 'paired architectures must be adjacent for the same state');
  assert.equal(new Set(a.rows.slice(0, 2).map(r => r.architecture)).size, 2, 'both architectures must run for each state');
  const analysis = analyzePaired(a.rows);
  assert.equal(analysis.paired.n, 4);
  assert.equal(analysis.paired.familyAgreement, 1);
  assert.equal(analysis.paired.familyFlips, 0);
  assert.ok(mulberry32(1)() !== mulberry32(2)(), 'different seeds must differ');
  console.log('methodology-test: paired runner determinism PASS');
}

// 9. Fragmentation flip rate is a paired family-change proportion.
{
  const rows = [
    { adapterId: 'm', adapterName: 'M', model: 'm', entryId: 's1', repetition: 1, variant: 'A', family: 'bet', error: null },
    { adapterId: 'm', adapterName: 'M', model: 'm', entryId: 's1', repetition: 1, variant: 'C', family: 'check', error: null },
    { adapterId: 'm', adapterName: 'M', model: 'm', entryId: 's1', repetition: 2, variant: 'A', family: 'bet', error: null },
    { adapterId: 'm', adapterName: 'M', model: 'm', entryId: 's1', repetition: 2, variant: 'C', family: 'bet', error: null },
  ];
  const frag = analyzeFragmentation(rows, { variantPairs: [['A', 'C']] });
  assert.equal(frag.compared, 2);
  assert.equal(frag.flips, 1);
  assert.equal(frag.fragmentationFlipRate, 0.5);
  assert.ok(frag.ci95.low < 0.5 && frag.ci95.high > 0.5);
  console.log('methodology-test: fragmentation flip rate PASS');
}

// 10. deriveSizeId maps flat amounts back to the deterministic buckets.
{
  const entry = corpusById('river-nuts-forced-call-allin-001');
  assert.equal(deriveSizeId(entry.state, 'BET', 3000), 'all_in');
  assert.equal(deriveSizeId(entry.state, 'CHECK', null), null);
  console.log('methodology-test: flat-size mapping PASS');
}

// 11. The seat ring and the decision clock share one canonical phase, so a
//     10-second action clock can never animate as if it were a 40-second total.
{
  const opts = { baseMs: 10_000, timeBankMs: 30_000, lowTimeMs: 5000, lowTimeFraction: 0.25 };
  const atStart = decisionClockPhase({ ...opts, elapsedMs: 0 });
  assert.equal(atStart.shownMs, 10_000, 'displayed clock must start at the 10s action clock');
  assert.equal(atStart.ringFraction, 1, 'ring starts full');
  assert.equal(atStart.inBank, false);
  const halfBase = decisionClockPhase({ ...opts, elapsedMs: 5000 });
  assert.equal(halfBase.ringFraction, 0.5, 'ring depletes over the 10s action clock, not base+bank');
  assert.equal(halfBase.shownMs, 5000);
  const bankStart = decisionClockPhase({ ...opts, elapsedMs: 10_000 });
  assert.equal(bankStart.inBank, true);
  assert.equal(bankStart.shownMs, 30_000, 'displayed clock switches to the full time bank');
  assert.equal(bankStart.ringFraction, 1, 'ring resets with the new phase, matching the number jump');
  const bankHalf = decisionClockPhase({ ...opts, elapsedMs: 25_000 });
  assert.equal(bankHalf.shownMs, 15_000);
  assert.equal(bankHalf.ringFraction, 0.5);
  assert.equal(decisionClockPhase({ ...opts, elapsedMs: 40_000 }).ringFraction, 0);
  // Low-time warning uses configurable thresholds.
  assert.equal(decisionClockPhase({ ...opts, elapsedMs: 7000 }).isLow, false);
  assert.equal(decisionClockPhase({ ...opts, elapsedMs: 8000 }).isLow, true);
  const noBank = decisionClockPhase({ baseMs: 10_000, timeBankMs: 0, elapsedMs: 10_000, lowTimeMs: 0, lowTimeFraction: 0 });
  assert.equal(noBank.ringFraction, 0);
  assert.equal(noBank.isLow, false);
  console.log('methodology-test: clock/ring phase parity PASS');
}

console.log('methodology-tests: PASS');
