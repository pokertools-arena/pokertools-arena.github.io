// Statistical helpers for the benchmark diagnostics.
//
// Everything here is deterministic, dependency-free and unit-tested. The names
// are deliberately explicit so reports can never confuse probability domains:
//
//   * family distributions  → familyEntropyBits / selectedFamilyProbability
//   * sizing distributions  → sizingEntropyBits / selectedSizeProbability
//   * flat action menus     → flatActionEntropyBits
//
// A generic unlabeled "entropy" is never emitted by the reporting layer.

export function sum(values) {
  let total = 0;
  for (const value of values ?? []) total += Number(value) || 0;
  return total;
}

export function mean(values) {
  const rows = (values ?? []).map(Number).filter(Number.isFinite);
  return rows.length ? sum(rows) / rows.length : null;
}

export function median(values) {
  const rows = (values ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

export function percentile(values, p) {
  const rows = (values ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const idx = Math.min(rows.length - 1, Math.max(0, Math.ceil(p * rows.length) - 1));
  return rows[idx];
}

export function normalizeProbabilities(probabilities) {
  const entries = Object.entries(probabilities ?? {})
    .map(([key, value]) => [key, Number(value)])
    .filter(([, value]) => Number.isFinite(value) && value >= 0);
  const total = entries.reduce((acc, [, value]) => acc + value, 0);
  if (total <= 0) return [];
  return entries.map(([key, value]) => [key, value / total]);
}

// Shannon entropy of a categorical distribution, in bits.
// Returns the exact (unrounded) value, or null when no positive mass exists.
export function entropyBits(probabilities) {
  const entries = Object.entries(probabilities ?? {})
    .map(([, value]) => Number(value))
    .filter(value => Number.isFinite(value) && value > 0);
  const total = entries.reduce((acc, value) => acc + value, 0);
  if (total <= 0) return null;
  let entropy = 0;
  for (const value of entries) {
    const p = value / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Wilson score interval for a binomial proportion. Robust for small n, which
// is the common case in behavioral probes. Returns null when there are no
// trials. This is deliberately preferred over the normal approximation so that
// 2/2 and 100/100 are not presented with the same evidentiary strength.
export function wilsonInterval(successes, trials, z = 1.96) {
  const n = Number(trials);
  const s = Number(successes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = Math.min(1, Math.max(0, s / n));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    successes: s,
    trials: n,
    rate: p,
    center,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
    z,
  };
}

// A named proportion with sample size and interval. The label is required so a
// report always states the probability domain it is describing.
export function proportion(successes, trials, { label, z = 1.96 } = {}) {
  const interval = wilsonInterval(successes, trials, z);
  if (!interval) return { label: label ?? null, successes: Number(successes) || 0, trials: Number(trials) || 0, rate: null, ci95: null };
  return {
    label: label ?? null,
    successes: interval.successes,
    trials: interval.trials,
    rate: interval.rate,
    ci95: { low: interval.low, high: interval.high },
  };
}

export function round(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function fmtPercent(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtInterval(interval, digits = 0) {
  if (!interval) return '—';
  return `${fmtPercent(interval.low ?? interval.ci95?.low, digits)}–${fmtPercent(interval.high ?? interval.ci95?.high, digits)}`;
}
