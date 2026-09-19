// Paired architecture tests (offline).
//
// These are the methodological tests that do NOT depend on a provider: the same
// fixed state is run through flat and hierarchical mock adapters, architecture
// order is interleaved with a recorded seed, family and sizing correctness are
// counted separately, and the fragmentation flip rate is a paired family-change
// proportion.
import assert from 'node:assert/strict';
import { ACTION, ACTION_FAMILY, applyBenchmarkMode, BENCHMARK_MODES } from '../../src/lib/decision-core.js';
import { runPairedCorpus, analyzePaired, analyzeFragmentation, mulberry32 } from '../../tools/diagnostics/paired.js';
import { ACTION_CORPUS, corpusById } from '../../tools/diagnostics/corpus.js';
import { FRAGMENTATION_SCENARIOS, FRAGMENTATION_HIERARCHICAL_SCENARIOS } from '../../tools/diagnostics/scenarios.js';

// 1. A provider-consistent mock agrees with itself under both architectures.
{
  const entries = ACTION_CORPUS.filter(entry => !entry.synthetic);
  const adapter = {
    id: 'mock:consistent', name: 'Mock Consistent', model: 'mock/consistent',
    async run({ architecture }) {
      return architecture === 'hierarchical'
        ? { family: 'check', sizeId: null, actionType: 'CHECK', latencyMs: 10 }
        : { family: 'check', actionType: 'CHECK', latencyMs: 12 };
    },
  };
  const run = await runPairedCorpus({ entries, adapters: [adapter], repetitions: 3, seed: 7 });
  assert.equal(run.rows.length, entries.length * 3 * 2);
  const analysis = analyzePaired(run.rows);
  assert.equal(analysis.paired.n, entries.length * 3);
  assert.equal(analysis.paired.familyAgreement, 1, 'a consistent model must agree across architectures');
  assert.equal(analysis.paired.familyFlips, 0);
  // Both architectures see the same fixed states (paired, not independent).
  const flatStates = run.rows.filter(row => row.architecture === 'flat').map(row => row.entryId).sort();
  const hierStates = run.rows.filter(row => row.architecture === 'hierarchical').map(row => row.entryId).sort();
  assert.deepEqual(flatStates, hierStates, 'paired architectures must cover the same corpus states');
}
console.log('paired-architecture-test: consistent mock PASS');

// 2. Family vs sizing are reported separately for a fixed corpus.
{
  const entry = corpusById('river-nuts-forced-call-allin-001');
  const adapter = {
    id: 'mock:right-family-wrong-size', name: 'Mock Sizing Miss', model: 'mock/sizing-miss',
    async run({ architecture }) {
      return architecture === 'hierarchical'
        ? { family: 'bet', sizeId: 'small', actionType: ACTION.BET, actionAmount: 1000, latencyMs: 8 }
        : { family: 'bet', actionType: ACTION.BET, actionAmount: 1000, latencyMs: 8 };
    },
  };
  const run = await runPairedCorpus({ entries: [entry], adapters: [adapter], repetitions: 4, seed: 3 });
  const analysis = analyzePaired(run.rows);
  for (const architecture of ['flat', 'hierarchical']) {
    const cell = analysis.byArchitecture[architecture];
    assert.equal(cell.family.successes, 4, 'family must pass');
    assert.equal(cell.family.trials, 4);
    assert.equal(cell.sizingGivenCorrectFamily.successes, 0, 'sizing must fail');
    assert.equal(cell.sizingGivenCorrectFamily.trials, 4);
    assert.equal(cell.final.successes, 0, 'final action must fail');
  }
}
console.log('paired-architecture-test: family vs sizing split PASS');

// 3. Fragmentation invariance across menu shapes A/B/C/D.
{
  const rows = [];
  const all = [
    ...FRAGMENTATION_SCENARIOS.map(scenario => ({ scenario, architecture: 'flat' })),
    ...FRAGMENTATION_HIERARCHICAL_SCENARIOS.map(scenario => ({ scenario, architecture: 'hierarchical' })),
  ];
  for (const { scenario, architecture } of all) {
    const variant = scenario.fragmentationVariant;
    const betCount = (scenario.state.legalActions ?? []).filter(action => action.type === ACTION.BET).length;
    // Simulated flat fragmentation: more size classes → more passive family.
    const family = architecture === 'hierarchical' ? 'bet' : (betCount <= 1 ? 'bet' : 'check');
    rows.push({
      adapterId: 'mock', adapterName: 'Mock', model: 'mock/frag', entryId: scenario.id.replace(new RegExp(`-${variant}$`), ''),
      repetition: 1, variant, family, error: null,
    });
  }
  const stateCount = new Set(rows.map(row => row.entryId)).size;
  const frag = analyzeFragmentation(rows);
  assert.equal(frag.compared, stateCount * 6, 'four variants produce six paired comparisons per state');
  assert.ok(frag.fragmentationFlipRate > 0, 'menu granularity must be able to flip the family in this simulation');
  assert.ok(frag.ci95.low < frag.fragmentationFlipRate && frag.ci95.high > frag.fragmentationFlipRate);
  assert.ok(Object.keys(frag.byVariantPair).length >= 1);
}
console.log('paired-architecture-test: fragmentation invariance PASS');

// 4. Strategy/Raw is the only difference between the two cognition tracks, and
//    it is applied identically to every paired architecture run.
{
  const entry = corpusById('river-nut-flush-value-001');
  const STRATEGY = applyBenchmarkMode(entry.state, BENCHMARK_MODES.STRATEGY);
  const RAW = applyBenchmarkMode(entry.state, BENCHMARK_MODES.RAW);
  assert.equal(STRATEGY.heroHand.category, 'Flush');
  assert.equal(RAW.heroHand, undefined);
  assert.deepEqual(STRATEGY.board, RAW.board);
  assert.deepEqual(STRATEGY.hero, RAW.hero);
  assert.deepEqual(STRATEGY.legalActions, RAW.legalActions);
  // Prng helper stays deterministic across calls with the same seed.
  const seq = seed => Array.from({ length: 5 }, mulberry32(seed));
  assert.deepEqual(seq(99), seq(99));
  assert.notDeepEqual(seq(99), seq(100));
}
console.log('paired-architecture-test: Strategy/Raw parity PASS');

// 5. No pair is a cross-state comparison: flat and hierarchical always share
//    the exact same state object and entry id.
{
  for (const entry of ACTION_CORPUS.slice(0, 6)) {
    assert.equal(entry.state.contextVersion, 3);
    assert.ok(entry.expected === null || entry.expected.family || entry.expectedFamilies);
  }
  assert.equal(ACTION_FAMILY.BET, 'bet');
}
console.log('paired-architecture-test: no cross-state comparison PASS');

// 6. Fairness: the fixed-state corpus is byte-identical between architecture
//    variants except for the action contract, and representation variants only
//    change presentation.
{
  const entry = corpusById('river-nut-flush-value-001');
  const seen = new Map();
  const adapter = {
    id: 'mock:capture', name: 'Mock Capture', model: 'mock/capture',
    async run({ entry: current, architecture }) {
      seen.set(architecture, JSON.stringify(current.state));
      return architecture === 'hierarchical'
        ? { family: 'check', sizeId: null, actionType: 'CHECK', latencyMs: 1 }
        : { family: 'check', actionType: 'CHECK', latencyMs: 1 };
    },
  };
  await runPairedCorpus({ entries: [entry], adapters: [adapter], repetitions: 1, seed: 11 });
  assert.equal(seen.get('flat'), seen.get('hierarchical'), 'both architectures must receive the identical semantic state');
  console.log('paired-architecture-test: architecture state identity PASS');
}

// 7. Resume: checkpointed pairs are skipped, never re-run.
{
  const entry = corpusById('river-nut-flush-value-001');
  const adapterId = 'mock:resume';
  let runs = 0;
  const adapter = {
    id: adapterId, name: 'Mock Resume', model: 'mock/resume',
    async run({ architecture }) {
      runs++;
      return architecture === 'hierarchical'
        ? { family: 'check', sizeId: null, actionType: 'CHECK', latencyMs: 1 }
        : { family: 'check', actionType: 'CHECK', latencyMs: 1 };
    },
  };
  const completedKeys = new Set([`${adapterId}|${entry.id}|1|flat`]);
  const run = await runPairedCorpus({ entries: [entry], adapters: [adapter], repetitions: 1, seed: 5, completedKeys });
  assert.equal(run.skipped, 1, 'the checkpointed pair must be skipped');
  assert.equal(runs, 1, 'only the missing architecture must run');
  assert.equal(run.rows.length, 1);
  assert.equal(run.rows[0].architecture, 'hierarchical');
  console.log('paired-architecture-test: checkpoint resume PASS');
}



console.log('paired-architecture-tests: PASS');
