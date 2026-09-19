#!/usr/bin/env node
// Release report builder (0.4.0).
//
//   node tests/analysis/release-report.mjs --dir logs/release-0.4.0 [--docs]
//
// Reads the machine-readable outputs of the real-API release suite
// (`paired-architecture.json`, `diagnostics-*.json`, `tournament-ab-*.json`)
// and writes one `summary.json` plus `summary.md` derived from it. With
// `--docs` the pair is also copied to `docs/diagnostics/`, which is the
// committed source of truth policed by `tests/unit/report-consistency.mjs`.
//
// No API calls. No secrets: API keys are never read into the report.
import { readdir, readFile, stat, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCounters, addCounters, countersForResult, validateCounters } from '../../tools/diagnostics/counters.js';
import { buildSummary, renderSummaryMarkdown, assertSummaryConsistent } from '../../tools/diagnostics/report.js';
import { mean, percentile, wilsonInterval, round } from '../../tools/diagnostics/stats.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dir = flag('--dir') || join(root, 'logs', `release-${pkg.version}`);
const docs = args.includes('--docs');

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function newest(prefix, explicit) {
  if (explicit) return explicit;
  let files = [];
  try { files = await readdir(dir); } catch { return null; }
  const candidates = [];
  for (const name of files) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const path = join(dir, name);
    candidates.push({ path, mtime: (await stat(path)).mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path ?? null;
}

const pairedPath = flag('--paired') || join(dir, 'paired-architecture.json');
let paired = null;
try { paired = await readJson(pairedPath); } catch { paired = null; }
if (!paired) {
  console.error(`No paired-architecture.json found at ${pairedPath}. Run tests/real/real-paired-corpus.mjs first.`);
  process.exit(1);
}
const diagnosticsPath = await newest('diagnostics-', flag('--diagnostics'));
const tournamentPath = await newest('tournament-ab-', flag('--tournament'));
const diagnostics = diagnosticsPath ? await readJson(diagnosticsPath) : null;
const tournament = tournamentPath ? await readJson(tournamentPath) : null;

// ---------------------------------------------------------------------------
// Counters — one source of truth for the whole release suite.
// ---------------------------------------------------------------------------
const counters = createCounters();
{
  const recomputed = createCounters();
  for (const row of paired.rows ?? []) addCounters(recomputed, countersForResult(row, { architecture: row.architecture }));
  addCounters(counters, recomputed);
}
const diagResults = diagnostics?.results ?? [];
const diagDecisions = Number(diagnostics?.meta?.totalCalls ?? diagResults.length) || 0;
counters.pokerDecisions += diagDecisions;
counters.familyModelCalls += diagDecisions;
counters.httpRequests += Math.max(Number(diagnostics?.meta?.httpRequests ?? 0) || 0, diagDecisions);
counters.httpRetries += Number(diagnostics?.meta?.retries ?? 0) || 0;
counters.rateLimitResponses += Number(diagnostics?.meta?.rateLimitEvents ?? 0) || 0;
counters.decisionErrors += diagResults.filter(row => row.error).length;
counters.protocolFallbacks += diagResults.filter(row => row.meta?.protocolFallbackTriggered).length;
counters.totalModelCalls = counters.familyModelCalls + counters.sizingModelCalls + counters.spectatorModelCalls;
validateCounters(counters);

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
function proportionCell(successes, trials) {
  const interval = wilsonInterval(successes, trials);
  return interval ? { successes, trials, rate: interval.rate, ci95: { low: interval.low, high: interval.high } } : { successes, trials, rate: null, ci95: null };
}
function rowsFor(predicate) { return diagResults.filter(predicate); }
function aggregateRows(rows) {
  const correct = rows.filter(row => row.correct).length;
  const errors = rows.filter(row => row.error).length;
  const aggressive = rows.filter(row => ['BET', 'RAISE'].includes(row.actionType)).length;
  const opportunities = rows.filter(row => row.actionType && !row.error).length;
  return { total: rows.length, correct, errors, accuracy: rows.length ? correct / rows.length : null, aggressive, opportunities, aggressiveRate: opportunities ? aggressive / opportunities : null };
}

const strict = [];
for (const architecture of ['flat', 'hierarchical']) {
  const rows = rowsFor(row => (row.experiment === 'strict' || row.experiment === 'hierarchical') && row.architecture === architecture && row.layer !== 'P' && row.layer !== 'F');
  if (!rows.length) continue;
  const agg = aggregateRows(rows);
  strict.push({
    architecture,
    family: proportionCell(agg.correct, agg.total),
    sizingGivenCorrectFamily: null,
    final: proportionCell(agg.correct, agg.total),
  });
}
// When no layered diagnostics were run, derive strict correctness from the
// paired corpus strict_legality states (family vs sizing kept separate).
if (!strict.length) {
  for (const architecture of ['flat', 'hierarchical']) {
    const strictRows = (paired.rows ?? []).filter(row => row.architecture === architecture && row.category === 'strict_legality' && row.familyCorrect != null && !row.error);
    if (!strictRows.length) continue;
    const sizingRows = strictRows.filter(row => row.familyCorrect === true && row.expectedSize);
    const finalRows = strictRows.filter(row => row.finalCorrect != null);
    strict.push({
      architecture,
      family: proportionCell(strictRows.filter(row => row.familyCorrect).length, strictRows.length),
      sizingGivenCorrectFamily: sizingRows.length ? proportionCell(sizingRows.filter(row => row.sizeCorrect).length, sizingRows.length) : null,
      final: finalRows.length ? proportionCell(finalRows.filter(row => row.finalCorrect).length, finalRows.length) : null,
    });
  }
}

const family = [];
const sizing = [];
const pairedSection = [];
for (const analysis of paired.analyses ?? []) {
  for (const architecture of ['flat', 'hierarchical']) {
    const cell = analysis.byArchitecture?.[architecture];
    if (!cell) continue;
    family.push({ model: analysis.name ?? analysis.model, architecture, ...cell.family });
    sizing.push({ model: analysis.name ?? analysis.model, architecture, ...cell.sizingGivenCorrectFamily });
  }
  pairedSection.push({
    model: analysis.name ?? analysis.model,
    flatFamily: cellLabel(analysis.byArchitecture?.flat?.family),
    hierarchicalFamily: cellLabel(analysis.byArchitecture?.hierarchical?.family),
    familyAgreement: analysis.paired?.familyAgreement ?? null,
    ci95: analysis.paired?.familyAgreementCi?.ci95 ?? null,
    familyFlips: analysis.paired?.familyFlips ?? 0,
    n: analysis.paired?.n ?? 0,
  });
}
function cellLabel(cell) { return cell && cell.trials ? `${cell.successes}/${cell.trials} (${Math.round((cell.rate ?? 0) * 100)}%)` : '—'; }

const frag = paired.fragmentation?.analysis ?? null;
const fragmentationSection = frag ? {
  fragmentationFlipRate: frag.fragmentationFlipRate,
  flips: frag.flips,
  compared: frag.compared,
  ci95: frag.ci95,
  variants: [...aggVariants(paired.fragmentation.rows ?? [])],
} : null;
function* aggVariants(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.model}|${row.variant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const [key, group] of groups) {
    const [model, variant] = key.split('|');
    const opportunities = group.filter(row => !row.error && row.family).length;
    const aggressive = group.filter(row => row.family === 'bet' || row.family === 'raise').length;
    const interval = wilsonInterval(aggressive, opportunities);
    yield { model, variant, rate: opportunities ? aggressive / opportunities : null, trials: opportunities, ci95: interval ? { low: interval.low, high: interval.high } : null };
  }
}

const representations = [];
if (diagnostics) {
  const reps = new Map();
  for (const row of rowsFor(row => row.experiment === 'representations')) {
    const key = row.representationId;
    if (!key) continue;
    if (!reps.has(key)) reps.set(key, []);
    reps.get(key).push(row);
  }
  for (const [representation, rows] of reps) representations.push({ representation, ...proportionCell(rows.filter(r => r.correct).length, rows.length) });
}

const jevTelemetry = [];
for (const analysis of paired.analyses ?? []) {
  const rows = (paired.rows ?? []).filter(row => row.model === analysis.model && !row.error && row.familyStats);
  if (!rows.length) continue;
  for (const architecture of ['flat', 'hierarchical']) {
    const group = rows.filter(row => row.architecture === architecture && row.familyStats);
    if (!group.length) continue;
    const avg = key => mean(group.map(row => Number(row.familyStats?.[key])).filter(Number.isFinite));
    const avgSize = key => mean(group.map(row => Number(row.sizeStats?.[key])).filter(Number.isFinite));
    jevTelemetry.push({
      architecture,
      aggressiveFamilyMass: avg('aggressiveMass'),
      selectedFamilyProbability: avg('selectedProbability'),
      familyTopSecondGap: avg('gap'),
      familyEntropyBits: avg('entropyBits'),
      sizingEntropyBits: avgSize('entropyBits'),
    });
  }
}

const performance = (paired.performance ?? []).map(row => ({ ...row, modelCalls: row.modelCalls ?? null, httpRequests: null }));

// ---------------------------------------------------------------------------
// Build summary
// ---------------------------------------------------------------------------
const summary = buildSummary({
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  experiments: diagnostics?.meta?.experiments ?? ['paired'],
  counters,
  sections: {
    methodology: 'Fixed-state paired corpus is the primary architecture comparison; every state is identical across flat and hierarchical, execution is deterministically interleaved with a recorded seed, family and sizing correctness are reported separately, and behavioral proportions carry Wilson 95% intervals. Real tournaments are end-to-end validation only.',
    strict,
    family,
    sizing,
    fragmentation: fragmentationSection,
    paired: pairedSection,
    strategyVsRaw: 'Strategy (deterministic heroHand for every model) and Raw cognition (models infer hand strength) are separate benchmark tracks and are never aggregated into one model score.',
    representations,
    performance,
    tournament: tournament
      ? `Real tournament A/B is end-to-end behavioral validation, not a controlled architecture comparison. Hands per architecture: ${Object.values(tournament.runs ?? {}).map(run => run.hands ?? 0).join(' / ') || '—'}. Hosting this section does not change the paired-corpus conclusion.`
      : 'No real tournament A/B run was attached to this release.',
    jevTelemetry,
    fairness: [
      'Fixed corpus states are byte-identical across architecture variants except for the action contract.',
      'Paired flat/hierarchical runs use the same hero cards, board, stacks, history, memory and public stats.',
      'Representation variants carry identical semantic state (offline assertion).',
      'Strategy mode supplies a deterministic heroHand to every model; Raw mode supplies it to none.',
      'Jev and chat adapters receive exactly the same family and size enums (offline assertion).',
      'The total action clock is shared across both hierarchical stages.',
      'Spectator explanations are disabled in rigorous runs; when enabled they are isolated and counter-separated.',
      'No per-model production prompt tuning exists and no provider-specific poker facts are injected.',
      'Diagnostic-only hidden information is structurally impossible in tournament mode.',
    ],
  },
  caveats: [
    'Behavioral proportion estimates are only as strong as the cell sample size; small cells carry wide Wilson intervals.',
    'Paired architecture agreement measures decision-policy stability on fixed states, not win-rate superiority.',
    'Tournament win rate is not a conclusion at these sample sizes, and tournament trajectories diverge after the first different action.',
    'Provider rate limits and model version drift can affect reproducibility even for identical fixed states.',
  ],
});
assertSummaryConsistent(summary);

const markdown = renderSummaryMarkdown(summary);
await mkdir(dir, { recursive: true });
const jsonPath = join(dir, 'summary.json');
const mdPath = join(dir, 'summary.md');
await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(mdPath, `${markdown}\n`);
console.log(`Wrote ${jsonPath}`);
console.log(`Wrote ${mdPath}`);

if (docs) {
  const docsDir = join(root, 'docs', 'diagnostics');
  await mkdir(docsDir, { recursive: true });
  await copyFile(jsonPath, join(docsDir, 'summary.json'));
  await copyFile(mdPath, join(docsDir, 'SUMMARY.md'));
  console.log('Copied summary.json and SUMMARY.md to docs/diagnostics/');
}
