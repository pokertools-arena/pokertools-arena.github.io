#!/usr/bin/env node
// Real flat-vs-hierarchical tournament A/B comparison.
//
//   node tests/real/real-tournament-ab.mjs [options]
//
// Options:
//   --hands N        hands per architecture (default 12)
//   --cap N          hard cap on model decisions per architecture (default and maximum 50)
//   --delay MS       delay between decisions (default 150)
//   --timeout MS     per-decision timeout (default 45000)
//   --starting N     starting stack (default 10000)
//   --sb N --bb N    blinds for level 1 (default 50/100)
//   --hands-per-level N   (default 5)
//   --multiplier X   blind multiplier (default 1.5)
//   --models a,b     substring filter on configured models
//   --architecture a,b   flat,hierarchical (default both)
//   --dry-run        print the plan and exit
//   --out DIR        output directory (default logs)
//
// Uses the same decision primitives as production. API keys are never printed
// or written to reports.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserEngine } from '@pokertools/engine/browser';
import {
  ACTION, legalActionCandidates, serializeForAgent, assertDecisionState, fallbackAction, playersStillInTournament,
  applyBenchmarkMode, decide, decideHierarchical, legalAggressiveSizes,
  aggregateActionProbabilitiesByFamily, probabilityStats, isAggressiveType,
  BENCHMARK_MODES, DECISION_ARCHITECTURES, DEFAULT_REPRESENTATION_MODE,
} from '../../src/lib/decision-core.js';
import { resolveConfig, redact, adapterProtocol, primeModelCapabilities } from '../../tools/diagnostics/env.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Hard safety ceiling: a real tournament A/B run must never exceed 50 decisions
// per architecture.
const HARD_MAX_DECISIONS = 50;

function parseArgs(argv) {
  const opts = { hands: 12, cap: HARD_MAX_DECISIONS, delay: 150, timeout: 45000, starting: 10000, sb: 50, bb: 100, handsPerLevel: 5, multiplier: 1.5, models: null, architectures: ['flat', 'hierarchical'], dryRun: false, out: join(root, 'logs') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = () => argv[++i];
    if (arg === '--hands') opts.hands = Math.max(1, Number(next()) || 1);
    else if (arg === '--cap') opts.cap = Math.min(HARD_MAX_DECISIONS, Math.max(0, Number(next()) || 0));
    else if (arg === '--delay') opts.delay = Math.max(0, Number(next()) || 0);
    else if (arg === '--timeout') opts.timeout = Math.max(1000, Number(next()) || 45000);
    else if (arg === '--starting') opts.starting = Math.max(100, Number(next()) || 10000);
    else if (arg === '--sb') opts.sb = Math.max(1, Number(next()) || 1);
    else if (arg === '--bb') opts.bb = Math.max(2, Number(next()) || 2);
    else if (arg === '--hands-per-level') opts.handsPerLevel = Math.max(1, Number(next()) || 5);
    else if (arg === '--multiplier') opts.multiplier = Math.max(1.1, Number(next()) || 1.5);
    else if (arg === '--models') opts.models = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--architecture') opts.architectures = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--out') opts.out = String(next() || opts.out);
    else if (arg === '--from-json') opts.fromJson = String(next() || '');
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
function blindStructure(opts) {
  const levels = [];
  let sb = opts.sb, bb = Math.max(sb * 2, opts.bb);
  for (let i = 0; i < 60 && levels.length < 8; i++) {
    levels.push({ smallBlind: sb, bigBlind: bb, ante: 0 });
    sb = Math.max(sb + 1, Math.round(sb * opts.multiplier));
    bb = Math.max(sb * 2, Math.round(bb * opts.multiplier));
  }
  return levels;
}
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

function blankStats() {
  return { decisions: 0, errors: 0, fallbacks: 0, aggressionOpportunities: 0, aggressive: 0, counts: {}, latencyTotal: 0, latencyCount: 0, familyAggMass: 0, familyAggMassCount: 0, familyTopGap: 0, familyTopGapCount: 0, familySelected: 0, familySelectedCount: 0, sizingAggMass: 0 };
}

async function runTournament({ architect, models, config, opts, onDecision }) {
  const engine = createBrowserEngine({
    smallBlind: opts.sb, bigBlind: opts.bb, ante: 0, maxPlayers: models.length,
    blindStructure: blindStructure(opts), validateIntegrity: true,
  });
  models.forEach((m, seat) => engine.sit(seat, m.id, m.name, opts.starting));
  const connection = config.connection;
  const stats = Object.fromEntries(models.map(m => [m.id, blankStats()]));
  let handNumber = 0, decisionCount = 0, stop = false;

  function alive() { return (engine.state.players ?? []).map((p, seat) => ({ p, seat })).filter(({ p }) => p && p.stack > 0); }
  function handComplete() {
    const s = engine.state;
    if (Array.isArray(s.winners) && s.winners.length > 0 && s.actionTo == null) return true;
    const inHand = (s.activePlayers ?? []).filter(seat => s.players?.[seat] && s.players[seat].stack >= 0);
    return s.actionTo == null && (s.street === 'SHOWDOWN' || inHand.length <= 1) && Array.isArray(s.winners);
  }

  while (!stop && handNumber < opts.hands) {
    const remaining = alive();
    if (remaining.length <= 1) break;
    for (const { p } of (engine.state.players ?? []).map((p, seat) => ({ p, seat }))) if (p && p.stack <= 0) { try { engine.stand(p.id); } catch {} }
    handNumber++;
    try { engine.deal(); } catch { break; }
    let guard = 0;
    while (!handComplete()) {
      if (++guard > 500) break;
      const s = engine.state, seat = s.actionTo;
      if (seat == null) { if (Array.isArray(s.winners) && s.winners.length) break; await sleep(5); continue; }
      const player = s.players?.[seat];
      if (!player) break;
      if (s.street === 'SHOWDOWN') {
        const show = { type: ACTION.SHOW, playerId: player.id, cardIndices: [0, 1] };
        if (engine.validate(show)?.valid) { engine.act(show); continue; }
        const muck = { type: ACTION.MUCK, playerId: player.id };
        if (engine.validate(muck)?.valid) { engine.act(muck); continue; }
      }
      if (decisionCount >= opts.cap) { stop = true; break; }
      const legalActions = legalActionCandidates(engine, seat);
      if (!legalActions.length) break;
      const model = models.find(m => m.id === player.id);
      // Match production: playersRemaining counts non-eliminated players, which
      // is exactly 1 + the number of non-eliminated opponents in the masked view.
      // Busted players are stood at the next hand boundary, so a mid-hand all-in
      // (stack 0, not eliminated) must still be counted.
      const playersRemaining = playersStillInTournament(engine.state.players, []).length;
      const base = serializeForAgent(engine, seat, { handNumber, playersRemaining, startingPlayers: models.length }, legalActions, [], [], []);
      const stateForAgent = assertDecisionState(applyBenchmarkMode(base, BENCHMARK_MODES.STRATEGY));
      const started = Date.now();
      let result = null, error = null;
      try {
        if (architect === 'hierarchical') {
          result = await decideHierarchical({
            agent: model, connection, state: stateForAgent, legalActions, decisionId: `ab-h${handNumber}-s${seat}`,
            timeoutMs: opts.timeout, representationMode: DEFAULT_REPRESENTATION_MODE,
            sizesForFamily: family => legalAggressiveSizes(engine, seat, family),
          });
        } else {
          result = await decide(model, connection, { state: stateForAgent, legalActions, decisionId: `ab-h${handNumber}-s${seat}`, timeoutMs: opts.timeout });
        }
      } catch (err) { error = err; }
      decisionCount++;
      const latency = Math.max(0, Date.now() - started);
      const row = stats[player.id];
      row.decisions++;
      if (error) { row.errors++; }
      else {
        row.latencyTotal += result?.primaryDecisionLatencyMs ?? result?.latencyMs ?? latency; row.latencyCount++;
        const probabilities = architect === 'hierarchical' ? result?.family?.probabilities : result?.meta?.probabilities;
        if (probabilities && typeof probabilities === 'object') {
          const familyMass = architect === 'hierarchical'
            ? probabilities
            : aggregateActionProbabilitiesByFamily(probabilities, stateForAgent.legalActions, { labelResolver: id => ({ description: (stateForAgent.legalActions || []).find(a => a.id === id)?.description || id }) });
          const aggMass = (Number(familyMass.bet) || 0) + (Number(familyMass.raise) || 0);
          row.familyAggMass += aggMass; row.familyAggMassCount++;
          const stats2 = probabilityStats(familyMass, result?.family?.choice ?? null);
          if (Number.isFinite(stats2.gap)) { row.familyTopGap += stats2.gap; row.familyTopGapCount++; }
          if (Number.isFinite(stats2.selectedProbability)) { row.familySelected += stats2.selectedProbability; row.familySelectedCount++; }
        }
      }
      // Validate + act.
      let chosen = result?.action ?? null;
      if (chosen) {
        const engineAction = isAggressiveType(chosen.type)
          ? { type: chosen.type, playerId: player.id, amount: Math.max(1, Math.round(Number(chosen.amount))) }
          : { type: chosen.type, playerId: player.id };
        if ((isAggressiveType(chosen.type) && !Number.isFinite(Number(chosen.amount))) || !engine.validate(engineAction)?.valid) chosen = null;
        else chosen = { ...chosen, engineAction };
      }
      if (!chosen) { chosen = fallbackAction(legalActionCandidates(engine, seat)); row.fallbacks++; }
      if (!chosen) { stop = true; break; }
      const type = chosen.type;
      row.counts[type] = (row.counts[type] ?? 0) + 1;
      if (legalActions.some(a => isAggressiveType(a.type))) row.aggressionOpportunities++;
      if (isAggressiveType(type)) row.aggressive++;
      engine.act(chosen.engineAction);
      if (onDecision) onDecision({ handNumber, model: player.id, type, latency });
      await sleep(opts.delay);
    }
    if (handNumber % opts.handsPerLevel === 0) { try { engine.nextBlindLevel(); } catch {} }
  }
  return { stats, hands: handNumber, decisions: decisionCount };
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { console.log('Usage: node tests/real/real-tournament-ab.mjs [--hands 12] [--cap 50] [--models a,b] [--architecture flat,hierarchical] [--dry-run]'); process.exit(0); }
const config = await resolveConfig({ cwd: process.cwd() });
if (!config.models.length) { console.error('No models configured. Set OPENAI_PLAYER1.. in .env.'); process.exit(1); }
const selected = config.models.filter(m => !opts.models || opts.models.some(f => m.model.includes(f)));
if (!selected.length) { console.error('No configured model matched --models.'); process.exit(1); }

const models = selected.map((m, i) => {
  const isJev = adapterProtocol(m.model) === 'jev_decisions';
  return { id: `ab-model-${i + 1}`, seat: i, name: shortName(m.model), model: m.model, protocol: isJev ? 'jev_decisions' : 'tool', provider: '', temperature: 0.3 };
});
console.log(`Tournament A/B: ${models.map(m => m.model).join(', ')}`);
console.log(`Structure: stack ${opts.starting}, blinds ${opts.sb}/${opts.bb}, hands/level ${opts.handsPerLevel}, multiplier ${opts.multiplier}`);
console.log(`Architectures: ${opts.architectures.join(', ')} · hands ${opts.hands} · cap ${opts.cap} decisions/architecture`);
if (opts.dryRun) process.exit(0);

await primeModelCapabilities(config.connection);

const runs = {};
let totalDecisions = 0;
if (opts.fromJson) {
  const saved = JSON.parse(await readFile(opts.fromJson, 'utf8'));
  Object.assign(runs, saved.runs ?? {});
  totalDecisions = Object.values(runs).reduce((sum, run) => sum + (run.decisions ?? 0), 0);
  console.log(`Re-rendering ${opts.fromJson} (0 API calls)`);
} else {
  for (const architect of opts.architectures) {
    console.log(`\n=== ${architect} ===`);
    runs[architect] = await runTournament({
      architect, models, config, opts,
      onDecision: ({ handNumber, model, type, latency }) => process.stdout.write(`  h${handNumber} ${shortName(model)} ${type} (${latency}ms)\n`),
    });
    totalDecisions += runs[architect].decisions;
  }
}

function pct(n, d) { return d > 0 ? `${Math.round((n / d) * 100)}%` : '—'; }
function pctValue(v) { return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—'; }
function mean(total, count) { return count > 0 ? total / count : null; }
function rows() {
  const out = [];
  for (const architect of opts.architectures) {
    for (const m of models) {
      const r = runs[architect]?.stats?.[m.id];
      if (!r) continue;
      out.push([
        m.name, architect, String(r.decisions), String(r.aggressionOpportunities), String(r.aggressive), pct(r.aggressive, r.aggressionOpportunities),
        pct(r.counts.CHECK ?? 0, r.decisions), pct(r.counts.CALL ?? 0, r.decisions), pct(r.counts.FOLD ?? 0, r.decisions),
        pct(r.counts.BET ?? 0, r.decisions), pct(r.counts.RAISE ?? 0, r.decisions),
        `${Math.round(mean(r.latencyTotal, r.latencyCount) ?? 0)}ms`, String(r.errors), String(r.fallbacks),
      ]);
    }
  }
  return out;
}
const table = ['| Model | Architecture | Decisions | Agg opps | Aggressive | Agg rate | Check | Call | Fold | Bet | Raise | Mean latency | Errors | Fallbacks |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...rows().map(r => `| ${r.join(' | ')} |`)].join('\n');

const jevRows = [];
for (const architect of opts.architectures) {
  for (const m of models) {
    if (!/jev/i.test(m.name)) continue;
    const r = runs[architect]?.stats?.[m.id];
    if (!r) continue;
    const countFor = count => (Number.isFinite(Number(count)) && Number(count) > 0) ? Number(count) : r.decisions;
    jevRows.push([m.name, architect, pctValue(mean(r.familyAggMass, countFor(r.familyAggMassCount))), pctValue(mean(r.familySelected, countFor(r.familySelectedCount))), pctValue(mean(r.familyTopGap, countFor(r.familyTopGapCount)))]);
  }
}
const jevTable = jevRows.length
  ? ['| Model | Architecture | Mean aggressive family mass | Selected family prob | Mean top−second gap |', '| --- | --- | --- | --- | --- |', ...jevRows.map(r => `| ${r.join(' | ')} |`)].join('\n')
  : '_No Jev model configured._';

const summary = [
  '# Real tournament A/B — flat vs hierarchical',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Models: ${models.map(m => m.model).join(', ')}`,
  `Structure: startingStack ${opts.starting}, blinds ${opts.sb}/${opts.bb}, handsPerLevel ${opts.handsPerLevel}, multiplier ${opts.multiplier}`,
  `Benchmark mode: strategy · hands/arch ${opts.hands} · decision cap/arch ${opts.cap}`,
  '',
  '> Win rate is not a conclusion at this sample size. The table reports decision behaviour only.',
  '',
  '## Decision behavior',
  '',
  table,
  '',
  '## Jev probability telemetry',
  '',
  jevTable,
  '',
  '## Errors / fallbacks',
  '',
  ...opts.architectures.map(a => `- ${a}: ${models.map(m => `${m.name} ${runs[a]?.stats?.[m.id]?.errors ?? 0} err / ${runs[a]?.stats?.[m.id]?.fallbacks ?? 0} fallback`).join(' · ')}`),
  '',
].join('\n');

await mkdir(opts.out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = join(opts.out, `tournament-ab-${stamp}.json`);
const mdPath = join(opts.out, `tournament-ab-${stamp}.md`);
await writeFile(jsonPath, redact(JSON.stringify({ meta: { models: models.map(m => m.model), options: { ...opts, out: undefined }, generatedAt: new Date().toISOString() }, runs }, null, 2), config.connection.apiKey));
await writeFile(mdPath, redact(summary, config.connection.apiKey));
console.log(`\n${table}`);
console.log(`\n${jevTable}`);
console.log(`\nWrote ${jsonPath}`);
console.log(`Wrote ${mdPath}`);
console.log(`Total decisions: ${totalDecisions}`);
