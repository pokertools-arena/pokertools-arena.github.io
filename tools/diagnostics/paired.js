// Paired fixed-state benchmark: the primary architecture comparison.
//
// For each fixed state the same model, state, context, benchmark mode and
// representation are evaluated under BOTH architectures. Execution is
// deterministically interleaved with a recorded seed so provider conditions
// cannot systematically bias one variant. Real tournament A/B remains useful as
// end-to-end evidence but is not a causal architecture comparison, because
// trajectories diverge after the first different action.
import { aggressiveSizesForState, familyForActionType, probabilityStats } from '../../src/lib/decision-core.js';
import { wilsonInterval } from './stats.js';
import { createCounters, addCounters, countersForResult } from './counters.js';

// Deterministic PRNG (mulberry32) so the interleaving order is reproducible.
export function mulberry32(seed) {
  let a = Number(seed) >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function deriveSizeId(state, actionType, actionAmount) {
  if (!actionType || actionAmount == null) return null;
  const family = familyForActionType(actionType);
  if (!family) return null;
  const sizes = aggressiveSizesForState(state, family);
  const match = sizes.find(size => Number(size.amount) === Number(actionAmount));
  return match?.id ?? null;
}

function expectedForEntry(entry) {
  if (entry.kind === 'legality') return { families: entry.expectedFamilies ?? [], size: undefined, final: false };
  return {
    families: entry.expected?.family ? [entry.expected.family] : [],
    size: entry.expected?.size,
    final: Boolean(entry.expected),
  };
}

export function scorePairedResult(entry, raw, { architecture }) {
  const expected = expectedForEntry(entry);
  const family = raw?.family ?? (raw?.actionType ? familyForActionType(raw.actionType) : null);
  const sizeId = raw?.sizeId ?? deriveSizeId(entry.state, raw?.actionType, raw?.actionAmount);
  const familyCorrect = expected.families.length ? expected.families.includes(family) : null;
  const sizeCorrect = expected.size ? sizeId === expected.size : null;
  const finalCorrect = expected.final ? Boolean(familyCorrect && (expected.size == null || sizeCorrect)) : null;
  return {
    entryId: entry.id, category: entry.category, tags: [...(entry.tags ?? [])],
    architecture,
    family, sizeId,
    actionType: raw?.actionType ?? null, actionAmount: raw?.actionAmount ?? null,
    actionDescription: raw?.actionDescription ?? null,
    expectedFamily: expected.families[0] ?? null, expectedSize: expected.size ?? null,
    familyCorrect, sizeCorrect, finalCorrect,
    probabilities: raw?.probabilities ?? null,
    familyStats: raw?.familyStats ?? null,
    sizeStats: raw?.sizeStats ?? null,
    latencyMs: Number.isFinite(Number(raw?.latencyMs)) ? Number(raw.latencyMs) : null,
    usage: raw?.usage ?? null,
    meta: raw?.meta ?? null,
    error: raw?.error ?? null,
  };
}

export async function runPairedCorpus({ entries, adapters, repetitions = 1, seed = 1, cap = Infinity, delayMs = 0, onProgress = () => {}, signal = null, completedKeys = null, onRow = null } = {}) {
  const rng = mulberry32(seed);
  const rows = [];
  const counters = createCounters();
  const done = completedKeys instanceof Set ? completedKeys : new Set(completedKeys ?? []);
  let calls = 0, stopped = false, skipped = 0;
  const totalPlanned = adapters.length * Math.max(1, repetitions) * entries.length * 2;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  outer:
  for (const adapter of adapters) {
    for (let repetition = 1; repetition <= Math.max(1, repetitions); repetition++) {
      for (const entry of entries) {
        const order = rng() < 0.5 ? ['flat', 'hierarchical'] : ['hierarchical', 'flat'];
        for (const architecture of order) {
          if (signal?.aborted) { stopped = true; break outer; }
          const resumeKey = `${adapter.id}|${entry.id}|${repetition}|${architecture}`;
          if (done.has(resumeKey)) { skipped++; onProgress({ calls, totalPlanned, adapter: adapter.id, entry: entry.id, architecture, repetition, skipped: true }); continue; }
          if (calls >= cap) { stopped = true; break outer; }
          calls++;
          let raw = null, error = null;
          const startedAt = Date.now();
          try {
            raw = await adapter.run({ entry, architecture, repetition, seed, signal });
          } catch (err) {
            error = String(err?.message || err).slice(0, 400);
          }
          const scored = scorePairedResult(entry, { ...raw, error }, { architecture });
          const row = {
            adapterId: adapter.id, adapterName: adapter.name ?? adapter.id, model: adapter.model,
            repetition, seed, experimentSeed: seed,
            latencyMs: scored.latencyMs ?? (Date.now() - startedAt),
            ...scored,
          };
          rows.push(row);
          if (onRow) onRow(row);
          addCounters(counters, countersForResult(row, { architecture }));
          onProgress({ calls, totalPlanned, adapter: adapter.id, entry: entry.id, architecture, repetition, error });
          if (delayMs && calls < cap && !signal?.aborted) await wait(delayMs);
        }
      }
    }
  }
  return { rows, calls, totalPlanned, stopped, seed, counters, skipped };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
function pairKey(row) { return `${row.adapterId}|${row.entryId}|${row.repetition}`; }

export function pairedRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = pairKey(row);
    if (!map.has(key)) map.set(key, {});
    map.get(key)[row.architecture] = row;
  }
  return [...map.values()];
}

function proportionRows(rows, predicate) {
  const eligible = rows.filter(row => predicate(row) != null);
  const successes = eligible.filter(row => predicate(row) === true).length;
  return { successes, trials: eligible.length };
}

export function analyzePaired(rows, { model = null } = {}) {
  const scoped = model ? rows.filter(row => row.model === model) : rows;
  const byArchitecture = {};
  for (const architecture of ['flat', 'hierarchical']) {
    const archRows = scoped.filter(row => row.architecture === architecture);
    const family = proportionRows(archRows, row => row.familyCorrect);
    const sizing = proportionRows(archRows.filter(row => row.familyCorrect === true), row => row.sizeCorrect);
    const final = proportionRows(archRows, row => row.finalCorrect);
    byArchitecture[architecture] = {
      decisions: archRows.length,
      errors: archRows.filter(row => row.error).length,
      family: { ...family, ...wilsonRow(family) },
      sizingGivenCorrectFamily: { ...sizing, ...wilsonRow(sizing) },
      final: { ...final, ...wilsonRow(final) },
      latencyMean: meanOf(archRows.map(row => row.latencyMs)),
    };
  }
  const pairs = pairedRows(scoped);
  const comparable = pairs.filter(pair => pair.flat && pair.hierarchical && !pair.flat.error && !pair.hierarchical.error);
  const agreements = comparable.filter(pair => pair.flat.family === pair.hierarchical.family).length;
  const flips = comparable.filter(pair => pair.flat.family !== pair.hierarchical.family);
  return {
    model,
    byArchitecture,
    paired: {
      n: comparable.length,
      familyAgreement: comparable.length ? agreements / comparable.length : null,
      familyAgreementCi: wilsonRow({ successes: agreements, trials: comparable.length }),
      familyFlips: flips.length,
      flipExamples: flips.slice(0, 8).map(pair => ({ entryId: pair.flat.entryId, repetition: pair.flat.repetition, flat: pair.flat.family, hierarchical: pair.hierarchical.family })),
    },
  };
}

function wilsonRow({ successes, trials }) {
  const interval = wilsonInterval(successes, trials);
  return interval ? { rate: interval.rate, ci95: { low: interval.low, high: interval.high } } : { rate: null, ci95: null };
}
function meanOf(values) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : null;
}

// Fragmentation invariance. Input rows must carry `variant` (the menu shape)
// and the same `entryId`/`adapterId`/`repetition`. For each state+model pair we
// compare the aggressive-family decision across variants that differ ONLY in
// how many size classes are offered. fragmentationFlipRate is the share of
// such pairs whose broad family changes.
export function analyzeFragmentation(rows, { variantPairs = null } = {}) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.adapterId}|${row.entryId}|${row.repetition}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  const pairs = variantPairs ?? defaultVariantPairs(rows);
  let compared = 0, flips = 0;
  const byVariantPair = {};
  for (const group of byKey.values()) {
    for (const [a, b] of pairs) {
      const rowA = group.find(row => row.variant === a);
      const rowB = group.find(row => row.variant === b);
      if (!rowA || !rowB || rowA.error || rowB.error) continue;
      const key = `${a}->${b}`;
      if (!byVariantPair[key]) byVariantPair[key] = { n: 0, flips: 0 };
      compared++; byVariantPair[key].n++;
      if (rowA.family !== rowB.family) { flips++; byVariantPair[key].flips++; }
    }
  }
  return {
    compared,
    flips,
    fragmentationFlipRate: compared ? flips / compared : null,
    ci95: wilsonRow({ successes: flips, trials: compared }).ci95,
    byVariantPair: Object.fromEntries(Object.entries(byVariantPair).map(([key, value]) => [key, { ...value, rate: value.n ? value.flips / value.n : null, ...wilsonRow({ successes: value.flips, trials: value.n }) }])),
  };
}

function defaultVariantPairs(rows) {
  const variants = [...new Set(rows.map(row => row.variant).filter(Boolean))].sort();
  const pairs = [];
  for (let i = 0; i < variants.length; i++) for (let j = i + 1; j < variants.length; j++) pairs.push([variants[i], variants[j]]);
  return pairs;
}

// Aggregated aggressive-family probability for flat Jev choices, if present.
export function aggressiveFamilyProbability(probabilities, legalActions = []) {
  const stats = probabilityStats(probabilities, null, { domain: 'flat_action' });
  if (stats.totalMass <= 0) return null;
  let aggressive = 0;
  for (const [key, value] of Object.entries(probabilities ?? {})) {
    const action = (legalActions ?? []).find(a => a.id === key);
    const type = action?.type;
    if (type === 'BET' || type === 'RAISE') aggressive += Number(value) || 0;
  }
  return aggressive / stats.totalMass;
}
