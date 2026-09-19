// Single source of truth for release reporting.
//
// `buildSummary` produces one machine-readable object; every human-readable
// report is derived from it by `renderSummaryMarkdown`. Totals are never
// retyped by hand, which is what previously allowed "909 decisions" and
// "1038 HTTP requests" to drift into inconsistent prose.
import { validateCounters, COUNTER_NAMES } from './counters.js';
import { fmtPercent, fmtInterval, round } from './stats.js';

export function buildSummary({ version, generatedAt = new Date().toISOString(), experiments = [], counters = {}, sections = {}, caveats = [] } = {}) {
  validateCounters(counters);
  return {
    schemaVersion: 1,
    version,
    generatedAt,
    experiments: [...experiments],
    counters: Object.fromEntries(COUNTER_NAMES.map(name => [name, Number(counters[name]) || 0])),
    sections,
    caveats: [...caveats],
  };
}

export function summaryTotals(summary) {
  const c = summary?.counters ?? {};
  return {
    pokerDecisions: Number(c.pokerDecisions) || 0,
    totalModelCalls: Number(c.totalModelCalls) || 0,
    httpRequests: Number(c.httpRequests) || 0,
    httpRetries: Number(c.httpRetries) || 0,
    decisionErrors: Number(c.decisionErrors) || 0,
    fallbackActions: Number(c.fallbackActions) || 0,
  };
}

// The canonical "totals" line. Every report embeds exactly this string so a
// totals drift is easy to detect and test.
export function totalsLine(summary) {
  const t = summaryTotals(summary);
  return `poker decisions: ${t.pokerDecisions} · model calls: ${t.totalModelCalls} · HTTP requests: ${t.httpRequests} · retries: ${t.httpRetries} · decision errors: ${t.decisionErrors} · fallbacks: ${t.fallbackActions}`;
}

export function assertSummaryConsistent(summary) {
  validateCounters(summary?.counters ?? {});
  const t = summaryTotals(summary);
  if (t.httpRequests < t.totalModelCalls) throw new Error('Summary: HTTP requests fewer than model calls');
  for (const section of Object.values(summary?.sections ?? {})) {
    const cells = Array.isArray(section) ? section : (section?.rows ?? []);
    for (const row of cells) {
      for (const cell of [row, row?.family, row?.sizingGivenCorrectFamily, row?.final]) {
        const { successes, trials, rate } = cell ?? {};
        if (Number.isFinite(successes) && Number.isFinite(trials) && trials > 0 && Number.isFinite(rate)) {
          const expected = successes / trials;
          if (Math.abs(expected - rate) > 1e-9) throw new Error(`Summary: stated rate ${rate} does not match ${successes}/${trials}`);
        }
      }
    }
  }
  return true;
}

function table(headers, rows) {
  if (!rows.length) return '_No data._';
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(value => String(value ?? '—').replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
}

function pct(value) { return fmtPercent(value); }
function ci(cell) {
  const interval = cell?.ci95?.low != null ? cell.ci95 : (cell?.low != null ? cell : null);
  return interval ? `${pct(interval.low)}–${pct(interval.high)}` : '—';
}
function proportionCell(label, cell) {
  return `${label} ${cell.successes}/${cell.trials} (${pct(cell.rate)})`;
}

export function renderSummaryMarkdown(summary) {
  assertSummaryConsistent(summary);
  const s = summary.sections ?? {};
  const lines = [];
  lines.push(`# pokertools-arena ${summary.version} — benchmark methodology & results`);
  lines.push('');
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Methodology: paired fixed-state corpus; deterministic interleaving with recorded experiment seed.`);
  lines.push('');
  lines.push('## Totals (single source of truth)');
  lines.push('');
  lines.push(totalsLine(summary));
  lines.push('');
  lines.push('> A hierarchical aggressive poker decision is **1 poker decision**, **2 model calls** and **2+ HTTP requests** if retries occur. These counters are never interchangeable.');
  lines.push('');

  lines.push('## 1. Methodology');
  lines.push('');
  lines.push(s.methodology ?? 'Paired fixed-state comparison is the primary architecture comparison; real tournaments are end-to-end validation only.');
  lines.push('');

  lines.push('## 2. Strict correctness');
  lines.push('');
  lines.push(table(['Architecture', 'Family accuracy', 'Sizing (given family)', 'Final accuracy', 'n'], (s.strict ?? []).map(row => [
    row.architecture,
    proportionCell('', row.family),
    row.sizingGivenCorrectFamily ? proportionCell('', row.sizingGivenCorrectFamily) : '—',
    row.final ? proportionCell('', row.final) : '—',
    row.family?.trials ?? 0,
  ])));
  lines.push('');

  lines.push('## 3. Family correctness');
  lines.push('');
  lines.push(table(['Model', 'Architecture', 'Family correct', 'Family accuracy', '95% CI', 'n'], (s.family ?? []).map(row => [
    row.model, row.architecture, `${row.successes}/${row.trials}`, pct(row.rate), ci(row), row.trials,
  ])));
  lines.push('');

  lines.push('## 4. Sizing correctness (conditional on correct family)');
  lines.push('');
  lines.push(table(['Model', 'Architecture', 'Sizing correct', 'Sizing accuracy', '95% CI', 'n'], (s.sizing ?? []).map(row => [
    row.model, row.architecture, `${row.successes}/${row.trials}`, pct(row.rate), ci(row), row.trials,
  ])));
  lines.push('');

  lines.push('## 5. Action fragmentation');
  lines.push('');
  const frag = s.fragmentation;
  lines.push(frag
    ? `**fragmentation_flip_rate**: ${pct(frag.fragmentationFlipRate)} (${frag.flips}/${frag.compared}, 95% CI ${ci(frag)}) — share of paired runs whose broad action family changes when only the number of same-family sizing choices changes.`
    : '_No fragmentation data._');
  lines.push('');
  if (frag?.variants?.length) {
    lines.push(table(['Model', 'Variant', 'Aggressive family rate', 'n', '95% CI'], frag.variants.map(row => [
      row.model, row.variant, pct(row.rate), row.trials, `${pct(row.ci95?.low)}–${pct(row.ci95?.high)}`,
    ])));
    lines.push('');
  }

  lines.push('## 6. Flat vs hierarchical paired comparison');
  lines.push('');
  lines.push(table(['Model', 'Flat family', 'Hier family', 'Family agreement', '95% CI', 'Flips', 'n'], (s.paired ?? []).map(row => [
    row.model, row.flatFamily, row.hierarchicalFamily, pct(row.familyAgreement), `${pct(row.ci95?.low)}–${pct(row.ci95?.high)}`, row.familyFlips, row.n,
  ])));
  lines.push('');

  lines.push('## 7. Strategy vs Raw cognition');
  lines.push('');
  lines.push(s.strategyVsRaw ?? 'Strategy and Raw cognition remain separate benchmark tracks and are never aggregated into one score.');
  lines.push('');

  lines.push('## 8. Representation sensitivity');
  lines.push('');
  lines.push(table(['Representation', 'Family accuracy', 'n'], (s.representations ?? []).map(row => [row.representation, pct(row.rate), row.trials])));
  lines.push('');

  lines.push('## 9. Performance');
  lines.push('');
  lines.push(table(['Model', 'Architecture', 'Poker decisions', 'Model calls', 'HTTP requests', 'Mean latency', 'P95', 'Tokens', 'Cost'], (s.performance ?? []).map(row => [
    row.model, row.architecture, row.pokerDecisions, row.modelCalls, row.httpRequests,
    row.latencyMean == null ? '—' : `${Math.round(row.latencyMean)}ms`, row.latencyP95 == null ? '—' : `${Math.round(row.latencyP95)}ms`,
    row.tokens ?? 0, row.cost ?? '—',
  ])));
  lines.push('');

  lines.push('## 10. Real tournament behavior (end-to-end validation)');
  lines.push('');
  lines.push(s.tournament ?? '_No tournament A/B data._');
  lines.push('');

  lines.push('## 11. Jev telemetry');
  lines.push('');
  lines.push(table(['Architecture', 'Aggressive family mass', 'Selected family probability', 'Top−second gap', 'Family entropy (bits)', 'Sizing entropy (bits)'], (s.jevTelemetry ?? []).map(row => [
    row.architecture, pct(row.aggressiveFamilyMass), pct(row.selectedFamilyProbability), pct(row.familyTopSecondGap),
    row.familyEntropyBits == null ? '—' : round(row.familyEntropyBits, 3), row.sizingEntropyBits == null ? '—' : round(row.sizingEntropyBits, 3),
  ])));
  lines.push('');

  lines.push('## 12. Fairness verification');
  lines.push('');
  for (const item of s.fairness ?? []) lines.push(`- ${item}`);
  lines.push('');

  lines.push('## 13. Limitations');
  lines.push('');
  for (const item of summary.caveats ?? []) lines.push(`- ${item}`);
  lines.push('');
  return lines.join('\n');
}

// Extract every numeric total stated in machine-readable form so the release
// documentation test can prove the Markdown was derived from the JSON.
export function expectedTotalsFragments(summary) {
  const t = summaryTotals(summary);
  return [
    `poker decisions: ${t.pokerDecisions}`,
    `model calls: ${t.totalModelCalls}`,
    `HTTP requests: ${t.httpRequests}`,
  ];
}
