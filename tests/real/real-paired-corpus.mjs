#!/usr/bin/env node
// Real-API paired fixed-state benchmark (0.4.0 primary architecture comparison).
//
//   node tests/real/real-paired-corpus.mjs [options]
//
// Options:
//   --reps N          repetitions per model × state × architecture (default 10)
//   --cap N           hard cap on poker decisions (default 1200)
//   --delay MS        delay between decisions (default 120)
//   --timeout MS      per-decision timeout (default 45000)
//   --seed N          deterministic interleaving seed (default 20260919)
//   --models a,b      substring filter on configured models
//   --categories a,b  corpus categories to include
//   --fragmentation   also run the A/B/C/D fragmentation experiment
//   --dry-run         print the plan and exit
//   --out DIR         output directory (default logs/release-<version>)
//
// Writes paired-architecture.json. The API key is never printed or written.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import {
  decide, decideHierarchical, applyBenchmarkMode, BENCHMARK_MODES,
  familyForActionType, aggressiveSizesForState, probabilityStats,
} from '../../src/lib/decision-core.js';
import { resolveConfig, redact, adapterProtocol } from '../../tools/diagnostics/env.js';
import { ACTION_CORPUS, corpusForCategories } from '../../tools/diagnostics/corpus.js';
import { FRAGMENTATION_SCENARIOS, FRAGMENTATION_HIERARCHICAL_SCENARIOS } from '../../tools/diagnostics/scenarios.js';
import { runPairedCorpus, analyzePaired, analyzeFragmentation, deriveSizeId } from '../../tools/diagnostics/paired.js';
import { createCounters, addCounters, countersForResult } from '../../tools/diagnostics/counters.js';
import { mean, percentile, wilsonInterval } from '../../tools/diagnostics/stats.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Hard safety ceiling. The release runner must never spend more than 50
// real-API decisions per invocation. `--cap` can lower this but never raise it.
const HARD_MAX_DECISIONS = 50;

function parseArgs(argv) {
  const opts = { reps: 10, fragReps: null, cap: HARD_MAX_DECISIONS, delay: 120, timeout: 45000, seed: 20260919, models: null, categories: null, fragmentation: false, dryRun: false, out: join(root, 'logs', `release-${pkg.version}`) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = () => argv[++i];
    if (arg === '--reps') opts.reps = Math.max(1, Number(next()) || 1);
    else if (arg === '--frag-reps') opts.fragReps = Math.max(1, Number(next()) || 1);
    else if (arg === '--cap') opts.cap = Math.min(HARD_MAX_DECISIONS, Math.max(0, Number(next()) || 0));
    else if (arg === '--delay') opts.delay = Math.max(0, Number(next()) || 0);
    else if (arg === '--timeout') opts.timeout = Math.max(1000, Number(next()) || 45000);
    else if (arg === '--seed') opts.seed = Number(next()) || 1;
    else if (arg === '--models') opts.models = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--categories') opts.categories = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--fragmentation') opts.fragmentation = true;
    else if (arg === '--out') opts.out = String(next() || opts.out);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function shortName(model) {
  const raw = String(model || '').replace(/^~/, '').split('/').pop() || model;
  const lower = raw.toLowerCase();
  if (lower.startsWith('jev')) return 'Jev';
  if (lower.startsWith('gemma')) return 'Gemma';
  if (lower.startsWith('qwen')) return 'Qwen';
  return raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function makeAdapter({ connection, model, opts }) {
  const isJev = adapterProtocol(model) === 'jev_decisions';
  const agent = { model, protocol: isJev ? 'jev_decisions' : 'tool', temperature: 0.3, provider: '' };
  return {
    id: `${isJev ? 'jev' : 'chat'}:${model}`, name: shortName(model), model, protocol: isJev ? 'jev_decisions' : 'chat',
    async run({ entry, architecture, repetition }) {
      const state = applyBenchmarkMode(entry.state, BENCHMARK_MODES.STRATEGY);
      const legalActions = entry.state.legalActions;
      const decisionId = `paired-${entry.id}-${architecture}-${repetition}`;
      if (architecture === 'hierarchical') {
        const result = await decideHierarchical({
          agent, connection, state, legalActions, decisionId, timeoutMs: opts.timeout,
          representationMode: 'canonical_json', sizesForFamily: family => aggressiveSizesForState(state, family),
        });
        const probabilities = result.family?.probabilities ?? null;
        const sizeProbabilities = result.sizing?.probabilities ?? null;
        return {
          family: result.family?.choice ?? familyForActionType(result.action?.type),
          sizeId: result.sizing?.choice ?? null,
          actionType: result.action?.type ?? null, actionAmount: result.action?.amount ?? null,
          actionDescription: result.action?.description ?? null,
          probabilities, familyStats: probabilities ? { ...probabilityStats(probabilities, result.family?.choice, { domain: 'family' }), aggressiveMass: (Number(probabilities.bet) || 0) + (Number(probabilities.raise) || 0) } : null,
          sizeStats: sizeProbabilities ? probabilityStats(sizeProbabilities, result.sizing?.choice, { domain: 'sizing' }) : null,
          latencyMs: result.primaryDecisionLatencyMs, usage: result.usage ?? null,
          meta: { retryCount: result.meta?.retryCount || 0, protocolFallbackTriggered: result.meta?.protocolFallbackTriggered, incidents: result.meta?.incidents ?? [] },
        };
      }
      const result = await decide(agent, connection, { state, legalActions, decisionId, timeoutMs: opts.timeout, representationMode: 'canonical_json' });
      const type = result.action?.type ?? null;
      const probabilities = result.meta?.probabilities ?? null;
      return {
        family: type ? familyForActionType(type) : null,
        sizeId: deriveSizeId(state, type, result.action?.amount),
        actionType: type, actionAmount: result.action?.amount ?? null, actionDescription: result.action?.description ?? null,
        probabilities,
        familyStats: probabilities ? { ...probabilityStats(probabilities, type, { domain: 'flat_action' }) } : null,
        latencyMs: result.primaryLatencyMs ?? result.latencyMs, usage: result.usage ?? null,
        meta: { retryCount: result.meta?.retryCount || 0, protocolFallbackTriggered: result.meta?.protocolFallbackTriggered, incidents: result.meta?.incidents ?? [] },
      };
    },
  };
}

async function runFragmentation({ adapters, opts, completedKeys = new Set(), onRow = null, cap = HARD_MAX_DECISIONS }) {
  const rows = [];
  const counters = createCounters();
  let skipped = 0;
  let stopped = false;
  const scenarios = [
    ...FRAGMENTATION_SCENARIOS.map(scenario => ({ scenario, architecture: 'flat' })),
    ...FRAGMENTATION_HIERARCHICAL_SCENARIOS.map(scenario => ({ scenario, architecture: 'hierarchical' })),
  ];
  outer:
  for (const adapter of adapters) {
    for (let repetition = 1; repetition <= (opts.fragReps ?? opts.reps); repetition++) {
      for (const { scenario, architecture } of scenarios) {
        if (rows.length >= cap) { stopped = true; break outer; }
        const entry = {
          id: scenario.id.replace(new RegExp(`-${scenario.fragmentationVariant}$`), ''),
          state: scenario.state, category: 'fragmentation', kind: 'action', tags: ['fragmentation'], expected: null,
        };
        const resumeKey = `${adapter.id}|${entry.id}|${repetition}|${architecture}`;
        if (completedKeys.has(resumeKey)) { skipped++; continue; }
        let raw = null;
        try {
          raw = await adapter.run({ entry, architecture, repetition });
        } catch (err) {
          raw = { error: String(err?.message || err).slice(0, 300) };
        }
        const row = {
          adapterId: adapter.id, adapterName: adapter.name, model: adapter.model,
          entryId: entry.id, repetition, variant: scenario.fragmentationVariant, architecture,
          family: raw.family ?? null, sizeId: raw.sizeId ?? null, error: raw.error ?? null,
          latencyMs: raw.latencyMs ?? null,
        };
        rows.push(row);
        if (onRow) onRow(row);
        addCounters(counters, countersForResult(row, { architecture }));
        if (opts.delay) await new Promise(resolve => setTimeout(resolve, opts.delay));
      }
    }
  }
  return { rows, counters, skipped, stopped };
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('Usage: node tests/real/real-paired-corpus.mjs [--reps 10] [--cap 1200] [--fragmentation] [--frag-reps N] [--models a,b] [--out DIR] [--dry-run]');
  console.log('Re-runnable: each decision is checkpointed to <out>/paired-rows.jsonl and <out>/frag-rows.jsonl; an interrupted run resumes from the checkpoint.');
  process.exit(0);
}

const entries = corpusForCategories(opts.categories).filter(entry => entry.kind === 'action');
const config = await resolveConfig({ cwd: process.cwd() });
if (!config.models.length) { console.error('No models configured. Set OPENAI_PLAYER1.. in .env.'); process.exit(1); }
const selected = config.models.filter(m => !opts.models || opts.models.some(f => m.model.includes(f)));
if (!selected.length) { console.error('No configured model matched --models.'); process.exit(1); }
const adapters = selected.map(({ model }) => makeAdapter({ connection: config.connection, model, opts }));
const planned = adapters.length * entries.length * opts.reps * 2;

await mkdir(opts.out, { recursive: true });
const pairedCheckpoint = join(opts.out, 'paired-rows.jsonl');
const fragCheckpoint = join(opts.out, 'frag-rows.jsonl');
const loadRows = path => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};
const resumeKeyOf = row => `${row.adapterId}|${row.entryId}|${row.repetition}|${row.architecture}`;
const existingPaired = loadRows(pairedCheckpoint);
const existingFrag = loadRows(fragCheckpoint);

console.log(`Paired fixed-state benchmark: ${adapters.length} model(s) × ${entries.length} state(s) × ${opts.reps} rep × 2 architectures = ${planned} decisions`);
console.log(`Models: ${selected.map(m => m.model).join(', ')} · seed ${opts.seed} · cap ${opts.cap}`);
if (existingPaired.length) console.log(`Resuming: ${existingPaired.length} paired decision(s) already checkpointed.`);
if (opts.fragmentation && existingFrag.length) console.log(`Resuming: ${existingFrag.length} fragmentation decision(s) already checkpointed.`);
if (opts.dryRun) process.exit(0);

const startedAt = new Date();
const controller = new AbortController();
const paired = await runPairedCorpus({
  entries, adapters, repetitions: opts.reps, seed: opts.seed, cap: opts.cap, delayMs: opts.delay,
  signal: controller.signal, completedKeys: new Set(existingPaired.map(resumeKeyOf)),
  onRow: row => appendFileSync(pairedCheckpoint, `${JSON.stringify(row)}\n`),
  onProgress: ({ calls, totalPlanned, adapter, entry, architecture, error, skipped }) => {
    if (skipped) return;
    process.stdout.write(`[${String(calls).padStart(4)}/${totalPlanned}] ${adapter} · ${entry} · ${architecture} ${error ? 'ERR' : 'ok'}\n`);
  },
});
const allPairedRows = [...existingPaired, ...paired.rows];

let fragmentation = null;
if (opts.fragmentation) {
  const frag = await runFragmentation({
    adapters, opts, completedKeys: new Set(existingFrag.map(resumeKeyOf)),
    onRow: row => appendFileSync(fragCheckpoint, `${JSON.stringify(row)}\n`),
    cap: Math.max(0, HARD_MAX_DECISIONS - paired.calls),
  });
  const allFragRows = [...existingFrag, ...frag.rows];
  fragmentation = { analysis: analyzeFragmentation(allFragRows), rows: allFragRows, counters: frag.counters, resumed: existingFrag.length };
}

const analyses = adapters.map(adapter => ({ model: adapter.model, name: adapter.name, ...analyzePaired(allPairedRows, { model: adapter.model }) }));

const counters = createCounters();
for (const row of allPairedRows) addCounters(counters, countersForResult(row, { architecture: row.architecture }));
if (fragmentation) for (const row of fragmentation.rows) addCounters(counters, countersForResult(row, { architecture: row.architecture }));
counters.spectatorModelCalls = 0;

const performance = adapters.map(adapter => {
  const rows = allPairedRows.filter(row => row.model === adapter.model && !row.error);
  const decisions = allPairedRows.filter(row => row.model === adapter.model).length;
  const tokens = rows.reduce((sum, row) => sum + Number(row.usage?.prompt_tokens ?? row.usage?.input_tokens ?? 0) + Number(row.usage?.completion_tokens ?? row.usage?.output_tokens ?? 0), 0);
  return {
    model: adapter.name, modelId: adapter.model, architecture: 'paired',
    pokerDecisions: decisions, modelCalls: countersForResultRows(allPairedRows, adapter.model),
    httpRequests: null, latencyMean: mean(rows.map(row => row.latencyMs)), latencyP95: percentile(rows.map(row => row.latencyMs), 0.95), tokens, cost: null,
  };
});

function countersForResultRows(rows, model) {
  return rows.filter(row => row.model === model).reduce((sum, row) => sum + countersForResult(row, { architecture: row.architecture }).totalModelCalls, 0);
}

const output = {
  meta: {
    version: pkg.version, generatedAt: startedAt.toISOString(), experimentSeed: opts.seed, repetitions: opts.reps, cap: opts.cap,
    baseUrl: config.baseUrl, isOpenRouter: config.isOpenRouter, envSource: config.envSource,
    models: selected.map(m => m.model), categories: opts.categories ?? ['all'], fragmentation: opts.fragmentation,
    plannedDecisions: planned, actualDecisions: allPairedRows.length, newlyRunDecisions: paired.calls,
    resumedPairedDecisions: existingPaired.length, resumedFragmentationDecisions: existingFrag.length, stopped: paired.stopped,
  },
  counters,
  analyses,
  fragmentation,
  performance,
  rows: allPairedRows,
};

const jsonPath = join(opts.out, 'paired-architecture.json');
await writeFile(jsonPath, redact(JSON.stringify(output, null, 2), config.connection.apiKey));
console.log(`\nWrote ${jsonPath}`);
console.log(`Poker decisions: ${counters.pokerDecisions} (${paired.calls} new this run, ${existingPaired.length} resumed) · model calls: ${counters.totalModelCalls} · HTTP requests: ${counters.httpRequests}`);
for (const analysis of analyses) {
  console.log(`${analysis.name}: flat family ${fmt(analysis.byArchitecture.flat.family)} · hier family ${fmt(analysis.byArchitecture.hierarchical.family)} · agreement ${fmtPct(analysis.paired.familyAgreement)} (n=${analysis.paired.n})`);
}
if (fragmentation) {
  const f = fragmentation.analysis;
  console.log(`Fragmentation flip rate: ${fmtPct(f.fragmentationFlipRate)} (${f.flips}/${f.compared}, 95% CI ${fmtPct(f.ci95?.low)}–${fmtPct(f.ci95?.high)})`);
}

function fmt(cell) { return cell && cell.trials ? `${cell.successes}/${cell.trials}` : '—'; }
function fmtPct(value) { return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'; }
